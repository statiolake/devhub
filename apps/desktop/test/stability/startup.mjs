// How long DevHub takes from an action to its first correct frame, stage by
// stage: the `startup` scenario of the stability suite (run.mjs runs it with
// `--only startup`, at each rate), or on its own:
//
//   test/stability/run.sh --only startup
//   xvfb-run -a -s "-screen 0 1600x1000x24" node test/stability/startup.mjs \
//       [--rates 1,6] [--slow cdp|machine] [--runs 3] [--config <nvim config dir> --lazy <lazy dir>]
//       [--launch-only --launches 8]      the launch alone, again and again
//
// The cases, each timed from the action to the frame that shows its answer:
//
//   launch            DevHub started with a Workspace open → its terminal drawn
//   workspace-open    `devhub <folder>` → that Workspace's terminal drawn
//   workspace-select  a Workspace's row clicked → its terminal on screen
//   nvim-pane         `nvim README.md` typed in a terminal → the file drawn in
//                     DevHub's Neovim over the pane (first, then again)
//   devhub-file       `devhub <file>` → the file drawn in the devhub-nvim window
//                     (cold: its Neovim started for it; warm: running)
//   conversation      `devhub --agent fake` → the GUI Agent's conversation drawn
//   picker / tree     the snacks picker and nvim-tree opened in the devhub-nvim
//                     Neovim, the first time (lazy) and again
//
// The stages are main's (`startupTrace`, DEVHUB_STARTUP_TRACE=1: lines in the
// app's log) and the pages' (`startupMark`: `performance` marks), on one
// clock, as ms from the action. `--slow cdp` (the suite's way) throttles the
// pages' renderers by the rate; `--slow machine` (Linux, root) runs the whole
// app — main, the renderers, tmux, Neovim — in a cgroup with 1/rate of the
// machine's CPU, a slow computer rather than a slow page. Under `cdp` the
// launch is at 1x whatever the rate: there is no page to throttle yet.
//
// Thresholds (`LIMITS`) only where the figure is stable from run to run.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./app.mjs";
import { connect, targets } from "./cdp.mjs";
import { press, type } from "./keys.mjs";
import { appDir, makeProfile } from "./profile.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => performance.timeOrigin + performance.now();

/**
 * Upper bounds, in ms at 1x, for the figures that hold still from run to run
 * on a 4-core Linux machine (scaled by the rate under throttling): what DevHub
 * alone takes, not what the config's plugins do.
 */
const LIMITS = {
  "workspace-select": 250,
  "nvim-pane#2": 1500,
  "devhub-file:warm": 800,
};

// What each step waits to see: text in a Neovim's painted grid, or an element.
const README = "The stability harness's sample workspace.";

/** Armed before the action: the first paint of an editor whose grid shows `text`. */
const ARM_EDITOR = (text, includeExisting) => `(() => {
  const editors = () => Object.values(window.neovimEditors ?? {});
  const seen = new WeakSet(${includeExisting ? "[]" : "editors()"});
  const out = { first: undefined, content: undefined, done: false };
  const shows = (ed) => {
    for (const g of ed.state.grids.values())
      for (let r = 0; r < g.height; r++)
        if (g.chars.slice(r * g.width, (r + 1) * g.width).join('').includes(${JSON.stringify(text)})) return true;
    return false;
  };
  const tick = () => {
    for (const ed of editors()) {
      if (seen.has(ed)) continue;
      seen.add(ed);
      const redraw = ed.redraw.bind(ed);
      ed.redraw = (batches) => {
        redraw(batches);
        if (out.redrawn === undefined && shows(ed)) out.redrawn = performance.timeOrigin + performance.now();
      };
      ed.subscribe(() => {
        const t = performance.timeOrigin + performance.now();
        out.first ??= t;
        if (out.content === undefined && shows(ed)) { out.content = t; out.done = true; }
      });
    }
    if (!out.done) setTimeout(tick, 4);
  };
  tick();
  window.__startupProbe = out;
})()`;

/**
 * Armed before the action: the first frame (after its rAF callbacks, before
 * it is painted) in which `pred` holds.
 */
const ARM_FRAME = (pred) => `(() => {
  const out = { content: undefined, done: false };
  const dummy = document.createElement('div');
  dummy.style.cssText = 'position:fixed;left:-50px;top:-50px;width:1px;height:1px;pointer-events:none';
  document.body.appendChild(dummy);
  let tick = 0;
  const ro = new ResizeObserver(() => {
    if (out.done) return;
    let ok = false;
    try { ok = (${pred}); } catch {}
    if (ok) { out.content = performance.timeOrigin + performance.now(); out.done = true; ro.disconnect(); dummy.remove(); }
  });
  ro.observe(dummy);
  const loop = () => { if (out.done) return; tick ^= 1; dummy.style.width = tick ? '2px' : '1px'; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  // A hidden page draws no frames: checked by timer too, to see it turn visible.
  const poll = () => { if (out.done) return; if (document.visibilityState !== 'visible') setTimeout(poll, 4); };
  poll();
  window.__startupProbe = out;
})()`;

const MARKS = `(() => ({
  origin: performance.timeOrigin,
  marks: performance.getEntriesByType('mark').filter((m) => m.name.startsWith('devhub:')).map((m) => [m.name.slice(7), m.startTime]),
  paint: performance.getEntriesByType('paint').map((e) => [e.name, e.startTime]),
  nav: (() => { const n = performance.getEntriesByType('navigation')[0]; return n ? [['nav:response', n.responseEnd], ['nav:dom-interactive', n.domInteractive], ['nav:dcl', n.domContentLoadedEventEnd], ['nav:load', n.loadEventEnd]] : []; })(),
}))()`;

function parseArgs(argv) {
  const args = { rates: [1, 6], slow: "cdp", runs: 1 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--rates") args.rates = argv[++i].split(",").map(Number);
    else if (arg === "--slow") args.slow = argv[++i];
    else if (arg === "--runs") args.runs = Number(argv[++i]);
    else if (arg === "--config") args.config = argv[++i];
    else if (arg === "--lazy") args.lazy = argv[++i];
    else if (arg === "--keep") args.keep = true;
    else if (arg === "--launches") args.launches = Number(argv[++i]);
    else if (arg === "--launch-only") args.launchOnly = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return args;
}

/** A cgroup (v1 `cpu`) with 1/rate of the machine's CPU, or none. */
function slowMachine(rate) {
  if (rate <= 1) return undefined;
  const dir = `/sys/fs/cgroup/cpu/devhub-startup-${String(process.pid)}-${String(rate)}`;
  try {
    mkdirSync(dir, { recursive: true });
    const period = 10_000;
    writeFileSync(join(dir, "cpu.cfs_period_us"), String(period));
    writeFileSync(
      join(dir, "cpu.cfs_quota_us"),
      String(Math.round((period * cpus().length) / rate)),
    );
  } catch (error) {
    throw new Error(
      `--slow machine needs a writable cgroup v1 cpu controller: ${error.message}`,
    );
  }
  return {
    wrap: ([file, args]) => [
      "/bin/sh",
      ["-c", `echo $$ > ${dir}/cgroup.procs && exec "$0" "$@"`, file, ...args],
    ],
    remove() {
      try {
        // Whatever is left in it (a tmux server) goes back to the root first.
        for (const pid of readFileSync(join(dir, "cgroup.procs"), "utf8")
          .split("\n")
          .filter(Boolean))
          writeFileSync("/sys/fs/cgroup/cpu/cgroup.procs", pid);
        rmSync(dir, { recursive: false, force: true });
      } catch {
        // gone already
      }
    },
  };
}

/** The user's Neovim config in place of the harness's: a copy, and the plugins lazy.nvim installed. */
function useConfig(paths, config, lazy) {
  const target = join(paths.config, "nvim");
  rmSync(target, { recursive: true, force: true });
  execFileSync("cp", ["-r", config, target]);
  const data = join(paths.home, ".local", "share", "nvim");
  mkdirSync(data, { recursive: true });
  symlinkSync(lazy, join(data, "lazy"));
}

class Run {
  constructor(paths, rate, slow, artifacts) {
    this.paths = paths;
    this.rate = rate;
    this.slow = slow;
    this.artifacts = artifacts;
    this.port = 9900 + (process.pid % 50) * 2 + (rate % 2);
    this.pages = new Map();
    this.launches = 0;
  }

  async start() {
    this.machine = this.slow === "machine" ? slowMachine(this.rate) : undefined;
    this.logPath = join(
      this.artifacts,
      `startup-app-${String(this.rate)}x-${String(++this.launches)}.log`,
    );
    const t0 = now();
    this.app = await startApp(this.paths, {
      port: this.port,
      logPath: this.logPath,
      env: { DEVHUB_STARTUP_TRACE: "1" },
      ...(this.machine ? { wrap: this.machine.wrap } : {}),
    });
    return t0;
  }

  stop() {
    for (const client of this.pages.values()) client.close();
    this.pages.clear();
    this.app?.stop();
    this.app = undefined;
    this.machine?.remove();
  }

  traces() {
    const out = [];
    for (const line of readFileSync(this.logPath, "utf8").split("\n")) {
      const m = /\[startup-trace\] ([\d.]+) (.*)$/.exec(line);
      if (m) out.push([m[2], Number(m[1])]);
    }
    return out;
  }

  async page(match) {
    let client = this.pages.get(match);
    if (!client) {
      client = await connect(this.port, match, { timeoutMs: 60_000 });
      this.pages.set(match, client);
      if (this.slow === "cdp")
        await client.send("Emulation.setCPUThrottlingRate", {
          rate: this.rate,
        });
    }
    return client;
  }

  /** Every Workspace page's target URL, now. */
  async paneTargets() {
    return (await targets(this.port)).filter(
      (t) => t.type === "page" && t.url.includes("pane.html#ws"),
    );
  }

  async marksOf(client) {
    const m = await client.eval(MARKS);
    return [...m.nav, ...m.paint, ...m.marks].map(([name, t]) => [
      name,
      m.origin + t,
    ]);
  }

  async arm(client, source) {
    await client.eval(source);
  }

  async awaitProbe(client, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const probe = await client.eval("window.__startupProbe");
      if (probe?.done) return probe;
      if (Date.now() > deadline) return probe ?? {};
      await sleep(20);
    }
  }

  tmuxClients() {
    try {
      return this.app
        .tmux("list-clients", "-F", "#{session_name}")
        .split("\n")
        .filter((n) => n.startsWith("ws-"));
    } catch {
      return [];
    }
  }

  async attachedCount(count) {
    const deadline = Date.now() + 60_000;
    while (new Set(this.tmuxClients()).size < count) {
      if (Date.now() > deadline)
        throw new Error("a Workspace's terminal never attached");
      await sleep(50);
    }
  }

  nvimExpr(expr) {
    const out = this.app.tmux("list-panes", "-a", "-F", "#{@devhub-nvim}");
    const sock = out.split("\n").find((line) => line.trim());
    if (!sock) throw new Error("no devhub-nvim window");
    return execFileSync(
      join(appDir, "out", "nvim", "bin", "nvim"),
      ["--server", sock.trim(), "--remote-expr", expr],
      {
        env: this.app.env,
      },
    ).toString();
  }
}

function probeStages(probe) {
  return [
    ...(probe.first ? [["probe:first-paint", probe.first]] : []),
    ...(probe.redrawn ? [["probe:text-in-redraw", probe.redrawn]] : []),
  ];
}

/** One case's figure, with its stages: [label, ms from the action]. */
function result(name, rate, t0, end, events) {
  const stages = events
    .filter(([, t]) => t >= t0 - 1 && (end === undefined || t <= end + 1))
    .sort((a, b) => a[1] - b[1])
    .map(([label, t]) => [label, Math.round(t - t0)]);
  return {
    case: name,
    rate,
    ms: end === undefined ? null : Math.round(end - t0),
    stages,
  };
}

/** The pane page showing a Workspace (the one that turns visible after `act`). */
async function newPanePage(run, before) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const fresh = (await run.paneTargets()).find(
      (t) => !before.includes(t.url),
    );
    if (fresh) return run.page(fresh.url);
    if (Date.now() > deadline) throw new Error("no new Workspace page");
    await sleep(10);
  }
}

async function visiblePane(run) {
  for (const t of await run.paneTargets()) {
    const client = await run.page(t.url);
    if ((await client.eval("document.visibilityState")) === "visible")
      return client;
  }
  throw new Error("no Workspace terminal on screen");
}

async function settleNvim(run, client) {
  await client.eval(`new Promise((resolve) => {
    let last = performance.now(), seen = '';
    const read = () => [...document.querySelectorAll('canvas, .nvim-view, .nvim-view-frame, .nvim-popup, .nvim-cmdline')].map((e) => { const b = e.getBoundingClientRect(); return b.x + ',' + b.y + ',' + b.width + ',' + b.height; }).join(';');
    const tick = () => { const n = read(); if (n !== seen) { seen = n; last = performance.now(); } if (performance.now() - last > 500) resolve(); else requestAnimationFrame(tick); };
    tick();
    setTimeout(resolve, 8000);
  })`);
}

/** Every case, at one rate, on one fresh profile. */
async function runCases(run, { user, launches = 1 }) {
  const out = [];
  const { paths } = run;
  const keys = user
    ? { picker: "C-e", tree: (c) => typeTree(c) }
    : { picker: "C-p", tree: (c) => press(c, "F2") };

  // First launch, nothing open yet.
  await run.start();
  await sleep(1500);

  // workspace-open: `devhub <folder>`, its page made for it.
  for (const [label, folder, count] of [
    ["workspace-open", paths.workspaceB, 1],
    ["workspace-open#2", paths.workspaceA, 2],
  ]) {
    const before = (await run.paneTargets()).map((t) => t.url);
    const t0 = now();
    run.app.cli([folder], folder);
    const client = await newPanePage(run, before);
    await run.attachedCount(count);
    let marks = [];
    for (let i = 0; i < 400; i++) {
      marks = await run.marksOf(client);
      if (marks.some(([n]) => n === "terminal:first-paint")) break;
      await sleep(25);
    }
    const end = marks.find(([n]) => n === "terminal:first-paint")?.[1];
    out.push(result(label, run.rate, t0, end, [...run.traces(), ...marks]));
    await sleep(800);
  }

  // workspace-select: back to beta by its row, then alpha (each page made already).
  const sidebar = await run.page("sidebar.html");
  for (const [label, name] of [
    ["workspace-select", "beta"],
    ["workspace-select#2", "alpha"],
  ]) {
    const pages = await run.paneTargets();
    const clients = await Promise.all(pages.map((t) => run.page(t.url)));
    const hidden = [];
    for (const c of clients)
      if ((await c.eval("document.visibilityState")) !== "visible")
        hidden.push(c);
    for (const c of hidden)
      await run.arm(
        c,
        ARM_FRAME(
          "document.visibilityState === 'visible' && !!document.querySelector('canvas')",
        ),
      );
    const at = await sidebar.eval(
      `(() => { const el = [...document.querySelectorAll('.sidebar-row')].find((e) => e.textContent.includes(${JSON.stringify(name)})); if (!el) return null; const b = el.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`,
    );
    if (!at) throw new Error(`no sidebar row ${name}`);
    await sidebar.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: at[0],
      y: at[1],
    });
    await sleep(300);
    const t0 = now();
    for (const type of ["mousePressed", "mouseReleased"])
      await sidebar.send("Input.dispatchMouseEvent", {
        type,
        x: at[0],
        y: at[1],
        button: "left",
        clickCount: 1,
      });
    let end;
    const deadline = Date.now() + 20_000;
    while (end === undefined && Date.now() < deadline) {
      for (const c of hidden) {
        const p = await c.eval("window.__startupProbe");
        if (p?.done) end = p.content;
      }
      await sleep(20);
    }
    out.push(result(label, run.rate, t0, end, run.traces()));
    await sleep(800);
  }

  // nvim-pane: `nvim README.md` in alpha's terminal, twice.
  const alpha = await visiblePane(run);
  for (const label of ["nvim-pane", "nvim-pane#2"]) {
    await alpha.eval("document.querySelector('textarea, input')?.focus()");
    await type(alpha, "nvim README.md");
    await sleep(300);
    await run.arm(alpha, ARM_EDITOR(README, false));
    const t0 = now();
    await press(alpha, "Enter");
    const probe = await run.awaitProbe(alpha);
    const marks = await run.marksOf(alpha);
    out.push(
      result(label, run.rate, t0, probe.content, [
        ...run.traces(),
        ...marks,
        ...probeStages(probe),
      ]),
    );
    await settleNvim(run, alpha);
    await sleep(500);
    await alpha.eval("document.querySelector('textarea.nvim-input')?.focus()");
    for (const k of [":", "q", "a", "!", "Enter"]) await press(alpha, k);
    await sleep(1500);
  }

  // devhub-file: cold (its Neovim started for it), then warm.
  for (const [label, file, text] of [
    ["devhub-file:cold", "src/core/core0.ts", "module 0: a fixed file"],
    ["devhub-file:warm", "src/util/util3.ts", "module 3: a fixed file"],
  ]) {
    await run.arm(alpha, ARM_EDITOR(text, label.endsWith("warm")));
    const t0 = now();
    run.app.cli([file], paths.workspaceA);
    const probe = await run.awaitProbe(alpha);
    const marks = await run.marksOf(alpha);
    out.push(
      result(label, run.rate, t0, probe.content, [
        ...run.traces(),
        ...marks,
        ...probeStages(probe),
      ]),
    );
    // Its plugins loaded, as the person waits for before reaching for them.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        if (run.nvimExpr("exists(':NvimTreeToggle')").trim() === "2") break;
      } catch {
        // not up yet
      }
      await sleep(100);
    }
    await settleNvim(run, alpha);
    await sleep(1000);
  }

  // picker and tree in the devhub-nvim Neovim: first (lazily loaded) and again.
  const focus = () =>
    alpha.eval("document.querySelector('textarea.nvim-input')?.focus()");
  for (const [label, open, close, shown] of [
    [
      "picker",
      (c) => press(c, keys.picker),
      (c) => press(c, "Escape"),
      "document.querySelectorAll('.nvim-view-frame-row').length > 0",
    ],
    [
      "picker#2",
      (c) => press(c, keys.picker),
      (c) => press(c, "Escape"),
      "document.querySelectorAll('.nvim-view-frame-row').length > 0",
    ],
    [
      "tree",
      keys.tree,
      keys.tree,
      "document.querySelectorAll('.nvim-view-item').length > 3",
    ],
    [
      "tree#2",
      keys.tree,
      keys.tree,
      "document.querySelectorAll('.nvim-view-item').length > 3",
    ],
  ]) {
    await focus();
    await run.arm(alpha, ARM_FRAME(shown));
    const t0 = now();
    await open(alpha);
    const probe = await run.awaitProbe(alpha, 20_000);
    out.push(result(label, run.rate, t0, probe.content, run.traces()));
    await settleNvim(run, alpha);
    await sleep(300);
    await focus();
    await close(alpha);
    if (label.startsWith("picker")) {
      await sleep(200);
      await press(alpha, "Escape");
    }
    await settleNvim(run, alpha);
    await sleep(800);
  }

  // conversation: a GUI Agent's pane, first drawn.
  {
    const existing = (await targets(run.port)).find(
      (t) => t.type === "page" && t.url.includes("conversations.html"),
    );
    let client = existing ? await run.page(existing.url) : undefined;
    if (client)
      await run.arm(
        client,
        ARM_FRAME("!!document.querySelector('.conversation-composer-input')"),
      );
    const t0 = now();
    run.app.cli(["--agent", "fake"], paths.workspaceA);
    client ??= await run.page("conversations.html");
    let end;
    const deadline = Date.now() + 30_000;
    while (end === undefined && Date.now() < deadline) {
      const p = await client.eval("window.__startupProbe");
      if (p?.done) end = p.content;
      else if (
        !existing &&
        (await client.eval(
          "!!document.querySelector('.conversation-composer-input')",
        ))
      )
        end = now();
      await sleep(10);
    }
    const marks = await run.marksOf(client);
    out.push(
      result("conversation", run.rate, t0, end, [...run.traces(), ...marks]),
    );
  }

  for (let i = 0; i < launches; i++) out.push(await measureLaunch(run));
  return out;
}

/**
 * launch: DevHub started again with both Workspaces open; its tmux server
 * gone with it (a cold start, as after a restart of the computer).
 */
async function measureLaunch(run) {
  run.stop();
  await sleep(1000);
  const t0 = await run.start();
  let client;
  let end;
  let marks = [];
  const deadline = Date.now() + 60_000;
  while (end === undefined && Date.now() < deadline) {
    try {
      client ??= await visiblePane(run);
      marks = await run.marksOf(client);
      end = marks.find(([n]) => n === "terminal:first-paint")?.[1];
    } catch {
      // the page not there yet
    }
    if (end === undefined) await sleep(50);
  }
  const launched = result(
    "launch",
    run.slow === "cdp" ? 1 : run.rate,
    t0,
    end,
    [...run.traces(), ...marks],
  );
  run.stop();
  return launched;
}

/** Only the launch, `launches` times, after a first run that opens both Workspaces. */
async function runLaunches(run, launches) {
  await run.start();
  await sleep(1500);
  run.app.cli([run.paths.workspaceB], run.paths.workspaceB);
  await run.attachedCount(1);
  run.app.cli([run.paths.workspaceA], run.paths.workspaceA);
  await run.attachedCount(2);
  await sleep(1500);
  const out = [];
  for (let i = 0; i < launches; i++) out.push(await measureLaunch(run));
  return out;
}

async function typeTree(client) {
  // The person's config maps nvim-tree to Alt keys only; the command is the same load.
  for (const k of [":", ..."NvimTreeToggle"]) await press(client, k);
  await press(client, "Enter");
}

/** The figures over several runs: each case's median, and its stages' medians. */
function summarise(all) {
  const byCase = new Map();
  for (const r of all) {
    const key = `${r.case}@${String(r.rate)}`;
    byCase.set(key, [...(byCase.get(key) ?? []), r]);
  }
  const median = (xs) => {
    const s = xs
      .filter((x) => x !== null && x !== undefined)
      .sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : null;
  };
  return [...byCase.values()].map((runs) => {
    const stageNames = [
      ...new Set(runs.flatMap((r) => r.stages.map(([n]) => n))),
    ];
    const stages = stageNames
      .map((n) => [
        n,
        median(runs.map((r) => r.stages.find(([m]) => m === n)?.[1])),
      ])
      .sort((a, b) => a[1] - b[1]);
    return {
      case: runs[0].case,
      rate: runs[0].rate,
      ms: median(runs.map((r) => r.ms)),
      all: runs.map((r) => r.ms),
      stages,
    };
  });
}

/** For run.mjs: every case at each rate, as the suite's results. */
export async function runStartup({
  rates,
  artifacts,
  plugins,
  slow = "cdp",
  runs = 1,
  config,
  lazy,
  keep = false,
  launches = 1,
  launchOnly = false,
}) {
  const all = [];
  for (const rate of rates) {
    for (let i = 0; i < runs; i++) {
      const root = mkdtempSync(join(tmpdir(), "devhub-startup-"));
      const paths = makeProfile(root, plugins);
      if (config) useConfig(paths, config, lazy);
      const run = new Run(paths, rate, slow, artifacts);
      try {
        all.push(
          ...(launchOnly
            ? await runLaunches(run, launches)
            : await runCases(run, { user: config !== undefined, launches })),
        );
      } catch (error) {
        all.push({
          case: "error",
          rate,
          ms: null,
          stages: [],
          error: String(error.stack ?? error),
        });
      } finally {
        run.stop();
        if (!keep) rmSync(root, { recursive: true, force: true });
      }
    }
  }
  const summary = summarise(all);
  writeFileSync(
    join(artifacts, "startup.json"),
    JSON.stringify({ all, summary }, null, 1),
  );
  return summary.map((s) => {
    const limit = LIMITS[s.case];
    const scaled =
      limit === undefined ? undefined : limit * Math.max(1, s.rate / 2);
    const problems = [];
    if (s.case === "error")
      problems.push(all.find((r) => r.case === "error")?.error ?? "error");
    else if (s.ms === null) problems.push("never drawn");
    else if (scaled !== undefined && s.ms > scaled)
      problems.push(`${String(s.ms)} ms, over ${String(scaled)} ms`);
    return {
      scenario: "startup",
      step: s.case,
      rate: s.rate,
      ok: problems.length === 0,
      ms: s.ms,
      stages: s.stages,
      problems,
      known: [],
    };
  });
}

/** One case's line: its figure, and its stages as `label +ms`. */
export function describe(result) {
  const stages = result.stages
    .map(([n, ms]) => `${n} ${String(ms)}`)
    .join(" · ");
  return `${result.ok ? "ok  " : "FAIL"} startup/${result.step} at ${String(result.rate)}x  ${result.ms === null ? "never" : `${String(result.ms)} ms`}\n       ${stages}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const { fetchPlugins } = await import("./fetchPlugins.mjs");
  const artifacts =
    process.env.DEVHUB_STABILITY_ARTIFACTS ??
    join(appDir, "..", "..", ".spike", "startup");
  mkdirSync(artifacts, { recursive: true });
  const results = await runStartup({
    ...args,
    artifacts,
    plugins: fetchPlugins(),
  });
  for (const r of results) console.log(describe(r));
}

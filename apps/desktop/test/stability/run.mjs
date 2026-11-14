// The visual-stability suite: DevHub started from this checkout on a fixed
// profile, each scenario's actions recorded frame by frame under CPU
// throttling, and the stability invariants (invariants.mjs, pixels.mjs)
// checked on what was recorded. See docs/visual-stability.md.
//
//   node test/stability/run.mjs [--rates 6,1] [--only picker,tree] [--keep]
//   node test/stability/run.mjs --hold --port 9913     the prepared app, until killed
//
// Needs an X display (run.sh starts one with xvfb-run), a built apps/desktop
// (`pnpm --filter @devhub/desktop build`), git and network for the pinned
// plugins on the first run, and xdotool for the window-resize steps.
//
// Exit status 0 when every step of every scenario held at every rate. On a
// failure the step's frames (frames.json), its screencast (shot-NNN.png) and
// what was violated (violations.txt) are written to
// $DEVHUB_STABILITY_ARTIFACTS (default .spike/stability) under
// <scenario>/<step>-<rate>x/.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./app.mjs";
import { capture, motionAt } from "./capture.mjs";
import { connect, targets } from "./cdp.mjs";
import { fetchPlugins } from "./fetchPlugins.mjs";
import { check } from "./invariants.mjs";
import { checkMotion } from "./motionInvariants.mjs";
import { decodePng, regionDigest, rowDigests } from "./pixels.mjs";
import { press as pressKey, type as typeText } from "./keys.mjs";
import { checkRegions } from "./pixels.mjs";
import { readFileSync } from "node:fs";

const motionSource = readFileSync(
  new URL("./motionRecorder.js", import.meta.url),
  "utf8",
)
  .trim()
  .replace(/;$/, "");

// Carets and the cursor do not take part in the picture compared: they blink.
const NO_CARETS = `(() => { let s = document.getElementById("__stability_nocaret"); if (!s) { s = document.createElement("style"); s.id = "__stability_nocaret"; s.textContent = ".nvim-cursor, .nvim-cursor-ink, .nvim-view-frame-caret, .nvim-cmdline-caret { visibility: hidden !important }"; document.head.append(s); } })()`;
const CARETS = `document.getElementById("__stability_nocaret")?.remove()`;

/**
 * Every picture of a scroll is made of rows the window draws at rest: the
 * text moves by whole device pixels, the canvas and the ghost meet without
 * a seam, so each pixel row of the text area, in every screencast frame,
 * is a row of some picture of the file at rest. A row that is not is torn
 * (half one line, half another) or garbage. The pictures at rest are taken
 * after the step, the window brought to each page of `lines` in turn;
 * carets are hidden throughout (they blink). coherent: { expr, around }:
 * the text area (an expression giving [x, y, w, h] in CSS px), and how many
 * lines beyond where the step started and ended the scroll may have shown.
 */
async function coherence(ctx, client, coherent, from, shots) {
  const dpr = await client.eval("devicePixelRatio");
  const css = await client.eval(coherent.expr);
  if (!css) return undefined;
  const rect = css.map((v) => Math.round(v * dpr));
  const now = Number(ctx.nvimExpr("line('w0')").trim());
  const height = Number(ctx.nvimExpr("winheight(0)").trim());
  const last = Number(ctx.nvimExpr("line('$')").trim());
  const view = ctx.nvimExpr("json_encode(winsaveview())").trim();
  const lo = Math.max(1, Math.min(from, now) - (coherent.around ?? height));
  const hi = Math.min(last, Math.max(from, now) + (coherent.around ?? height));
  const known = new Set();
  const rest = [];
  // A page at a time, each a jump (no easing): every line is in one.
  for (let top = lo; top <= hi; top += Math.max(1, height)) {
    // The cursor with it, or Neovim moves the view back to the cursor.
    // An expression's changes are not drawn until something redraws.
    ctx.nvimExpr(
      `execute('call winrestview({"topline": ${String(top)}, "lnum": ${String(top)}, "col": 0}) | redraw')`,
    );
    const shown = Number(ctx.nvimExpr("line('w0')").trim());
    // Drawn there, at rest: no scroll of the display left.
    await ctx.waitIn(
      "pane",
      `Object.values(window.neovimEditors ?? {}).some((ed) => { const g = ed.state.cursor.grid; const v = ed.painter.scrollView(g); return ed.state.windows.get(g)?.viewport?.topline === ${String(shown - 1)} && (!v || (v.off === 0 && v.ghost === undefined)); })`,
      5000,
    );
    await ctx.settle("pane", 250);
    const r = await client.send("Page.captureScreenshot", { format: "png" });
    const png = Buffer.from(r.data, "base64");
    rest.push(png);
    for (const row of rowDigests(decodePng(png), rect)) known.add(row);
  }
  ctx.nvimExpr(
    `execute('call winrestview(json_decode(''${view.replace(/'/g, "''")}'')) | redraw')`,
  );
  await ctx.settle("pane", 250);
  const torn = [];
  shots.forEach((shot, i) => {
    const rows = rowDigests(decodePng(shot.png), rect);
    const strange = rows.flatMap((row, y) => (known.has(row) ? [] : [y]));
    if (strange.length > 0)
      torn.push({ i, n: strange.length, first: strange[0] });
  });
  if (torn.length === 0) return undefined;
  return {
    pictures: rest,
    message: `${String(torn.length)} of ${String(shots.length)} pictures have pixel rows the window draws at rest nowhere (rect ${JSON.stringify(rect)}): ${torn
      .slice(0, 6)
      .map(
        (t) =>
          `screencast frame ${String(t.i)}, ${String(t.n)} rows from row ${String(t.first)}`,
      )
      .join("; ")}`,
  };
}

/**
 * Settled after motion, the picture is what a fresh full redraw draws:
 * Neovim's whole screen sent again (:redraw!) and painted anew. A
 * difference is something the motion left behind (a stale row, a ghost, a
 * band painted at an old offset). selector: the region compared.
 */
async function freshRedraw(ctx, client, selector) {
  await client.eval(NO_CARETS);
  try {
    await ctx.settle("pane", 300);
    const shot = async () => {
      const r = await client.send("Page.captureScreenshot", { format: "png" });
      const png = Buffer.from(r.data, "base64");
      return { png, image: decodePng(png) };
    };
    // Not the message rows under the last status line: :redraw! clears
    // them in Neovim itself (Insert's "-- INSERT --" is not said again
    // until the mode changes), whatever draws its screen.
    const rect = await client.eval(
      `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const b = e.getBoundingClientRect(); const f = [...e.querySelectorAll(".nvim-footer")].pop(); const bottom = f ? Math.min(b.bottom, f.getBoundingClientRect().bottom) : b.bottom; return [b.x, b.y, b.width, bottom - b.y].map(Math.round); })()`,
    );
    if (!rect) return undefined;
    const settled = await shot();
    const before = regionDigest(settled.image, rect);
    ctx.nvimExpr("execute('redraw!')");
    await ctx.settle("pane", 400);
    const fresh = await shot();
    const after = regionDigest(fresh.image, rect);
    return before === after
      ? undefined
      : {
          message: `the settled picture of ${selector} differs from a fresh full redraw (${before} vs ${after})`,
          pictures: { settled: settled.png, fresh: fresh.png },
        };
  } finally {
    await client.eval(CARETS);
  }
}
import { appDir, makeProfile, writeSettings } from "./profile.mjs";
import { runPointer } from "./pointer.mjs";
import { describe as describeStartup, runStartup } from "./startup.mjs";
import { SCENARIOS, editorAtRest } from "./scenarios.mjs";
import { MOTION_SCENARIOS } from "./scenariosMotion.mjs";

// Pages by name. `pane` is the terminal page of the Workspace on screen (each
// Workspace has its own; the others are hidden).
const PAGES = {
  sidebar: "sidebar.html",
  index: "index.html",
  agents: "agents.html",
  conversations: "conversations.html",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = {
    rates: [6, 1],
    only: undefined,
    keep: false,
    port: 9400 + (process.pid % 500),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--rates") args.rates = argv[++i].split(",").map(Number);
    else if (arg === "--only") args.only = argv[++i].split(",");
    else if (arg === "--keep") args.keep = true;
    else if (arg === "--hold") args.hold = true;
    else if (arg === "--neovim-delay") args.neovimDelay = Number(argv[++i]);
    else if (arg === "--scale") args.scale = Number(argv[++i]);
    else if (arg === "--port") args.port = Number(argv[++i]);
    else throw new Error(`unknown argument ${arg}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.DISPLAY && process.platform === "linux") {
    throw new Error("no DISPLAY: run test/stability/run.sh, which starts Xvfb");
  }
  const artifacts =
    process.env.DEVHUB_STABILITY_ARTIFACTS ??
    join(appDir, "..", "..", ".spike", "stability");
  rmSync(artifacts, { recursive: true, force: true });
  mkdirSync(artifacts, { recursive: true });
  const started = Date.now();
  const plugins = fetchPlugins();
  const root = mkdtempSync(join(tmpdir(), "devhub-stability-"));
  const paths = makeProfile(root, plugins);
  const app = await startApp(paths, {
    neovimDelayMs: args.neovimDelay,
    scale: args.scale,
    port: args.port,
    logPath: join(artifacts, "app.log"),
  });
  const pages = new Map();
  const results = [];
  try {
    const ctx = makeContext(app, paths, pages);
    await ctx.prepare();
    if (args.hold) {
      // For working on a scenario by hand: the app, prepared, until killed.
      console.log(
        `holding: CDP on ${args.port}, profile in ${root}; Ctrl-C ends it`,
      );
      await new Promise((resolve) =>
        process.once("SIGINT", resolve).once("SIGTERM", resolve),
      );
    }
    const scenarios = [...SCENARIOS, ...MOTION_SCENARIOS].filter(
      (s) => !args.only || args.only.includes(s.name),
    );
    for (const scenario of scenarios) {
      for (const rate of args.rates) {
        const scenarioStarted = Date.now();
        try {
          await scenario.setup?.(ctx);
        } catch (error) {
          results.push({
            scenario: scenario.name,
            step: "setup",
            rate,
            ok: false,
            problems: [`setup failed: ${error.message}`],
          });
          continue;
        }
        for (const step of scenario.steps) {
          const result = await runStep(ctx, scenario, step, rate, artifacts);
          results.push(result);
          const mark = !result.ok
            ? "FAIL"
            : result.known?.length
              ? "KNOWN"
              : "ok  ";
          console.log(
            `${mark} ${scenario.name}/${step.name} at ${rate}x  (${result.ms} ms, ${result.frames} frames, ${result.shots} pictures)`,
          );
          for (const problem of [...result.problems, ...(result.known ?? [])])
            console.log(`     ${problem.replace(/\n/g, "\n     ")}`);
        }
        await scenario.teardown?.(ctx);
        console.log(
          `     ${scenario.name} at ${rate}x: ${((Date.now() - scenarioStarted) / 1000).toFixed(1)} s`,
        );
      }
    }
    // The pointer's answers, timed (`pointer.mjs`): a scenario of its own.
    if (!args.only || args.only.includes("pointer")) {
      for (const rate of args.rates) {
        await editorAtRest(ctx);
        for (const result of await runPointer(ctx, rate)) {
          results.push(result);
          const mark = !result.ok
            ? "FAIL"
            : result.known?.length
              ? "KNOWN"
              : "ok  ";
          console.log(
            `${mark} pointer/${result.step} at ${String(rate)}x  (answer ${result.answer === null ? "none" : `${String(result.answer)} ms`})`,
          );
          for (const problem of [...result.problems, ...(result.known ?? [])])
            console.log(`     ${problem}`);
        }
      }
    }
  } finally {
    for (const client of pages.values()) client.close();
    app.stop();
    if (!args.keep) rmSync(root, { recursive: true, force: true });
  }
  // How long each first frame takes (`startup.mjs`): a scenario of its own,
  // on DevHubs of its own, after this one has gone.
  if (!args.only || args.only.includes("startup")) {
    for (const result of await runStartup({
      rates: args.rates,
      artifacts,
      plugins,
    })) {
      results.push(result);
      console.log(describeStartup(result));
    }
  }
  const failed = results.filter((r) => !r.ok);
  const knownCount = results.filter((r) => r.ok && r.known?.length).length;
  console.log(
    `\nstability: ${results.length - failed.length} of ${results.length} steps held` +
      (knownCount
        ? ` (${knownCount} of them with a known fault, listed as KNOWN)`
        : "") +
      `, ${((Date.now() - started) / 1000).toFixed(0)} s` +
      (failed.length ? `; artifacts in ${artifacts}` : ""),
  );
  writeFileSync(
    join(artifacts, "results.json"),
    JSON.stringify(results, null, 1),
  );
  process.exitCode = failed.length ? 1 : 0;
}

/** The pages a step records: its own list, or the scenario's one page. */
function stepPages(scenario, step) {
  if (step.pages) return step.pages;
  return [
    {
      page: scenario.page,
      roles: scenario.roles,
      motionMarkers: scenario.motionMarkers,
    },
  ];
}

/** A step's picture regions for `page`: a list, or a list per page name. */
function regionsFor(step, page, first) {
  if (!step.regions) return [];
  if (Array.isArray(step.regions)) return first ? step.regions : [];
  return step.regions[page] ?? [];
}

async function runStep(ctx, scenario, step, rate, artifacts) {
  const t0 = Date.now();
  const fail = (message) => ({
    scenario: scenario.name,
    step: step.name,
    rate,
    ok: false,
    ms: Date.now() - t0,
    frames: 0,
    shots: 0,
    problems: [message],
  });
  const pages = stepPages(scenario, step);
  try {
    if (step.prep) {
      await step.prep(ctx);
      // What the preparation set going (a message, a redraw) lands before
      // the recording starts, not in it.
      for (const entry of pages) await ctx.settle(entry.page);
    }
  } catch (error) {
    return fail(`the step's preparation failed: ${error.message}`);
  }
  const sessions = [];
  const regions = [];
  for (const [index, entry] of pages.entries()) {
    const client = await ctx.page(entry.page);
    sessions.push({
      client,
      watch: { roles: entry.roles, motionMarkers: entry.motionMarkers ?? [] },
    });
    const wanted = regionsFor(step, entry.page, index === 0);
    regions.push({ wanted, before: await resolveRegions(client, wanted) });
  }
  // A step in motion: every frame's text, anchors and scroll ports too
  // (motionRecorder.js), on its first page.
  const motionClient = step.motion ? sessions[0].client : undefined;
  if (motionClient) {
    await motionClient.eval(
      `(${motionSource})(${JSON.stringify(step.motion)})`,
    );
  }
  let recorded;
  let coherentFrom;
  let restPictures;
  if (step.coherent) {
    await sessions[0].client.eval(NO_CARETS);
    coherentFrom = Number(ctx.nvimExpr("line('w0')").trim());
  }
  try {
    recorded = await capture(sessions, () => step.act(ctx), {
      rate,
      quietMs: step.quietMs ?? 600,
      waitFor: step.waitFor,
    });
  } catch (error) {
    return fail(`the step failed to run: ${error.message}`);
  }
  const problems = [];
  if (step.coherent) {
    try {
      const problem = await coherence(
        ctx,
        sessions[0].client,
        step.coherent,
        coherentFrom,
        recorded[0].shots,
      );
      if (problem) {
        problems.push(`${pages[0].page}: [torn] ${problem.message}`);
        restPictures = problem.pictures;
      }
    } finally {
      await sessions[0].client.eval(CARETS);
    }
  }
  let frameCount = 0;
  let shotCount = 0;
  const failedPages = [];
  let motionSamples;
  let stalePictures;
  if (motionClient) {
    motionSamples = await motionClient.eval("window.__motion.take()");
    for (const v of checkMotion(motionSamples, step.motion.spec ?? {}))
      problems.push(`${pages[0].page}: [${v.rule}] ${v.message}`);
    if (step.motion.fresh) {
      const problem = await freshRedraw(ctx, motionClient, step.motion.fresh);
      if (problem) {
        problems.push(`${pages[0].page}: [stale] ${problem.message}`);
        stalePictures = problem.pictures;
      }
    }
  }
  for (const [index, entry] of pages.entries()) {
    const page = recorded[index];
    frameCount += page.frames.length;
    shotCount += page.shots.length;
    const own = [];
    if (!page.settled)
      own.push(
        "never settled: something kept changing, or what the step waits for never came (see frames.json)",
      );
    const spec = step.live ? { ...step.spec, only: [] } : (step.spec ?? {});
    for (const v of check(page.frames, spec))
      own.push(`[${v.rule}] ${v.message}`);
    const { wanted, before } = regions[index];
    const after = await resolveRegions(sessions[index].client, wanted);
    const rects = wanted
      .map((region, i) => ({
        name: region.name,
        still: region.still === true,
        rect: (region.from === "before"
          ? before[i]
          : (after[i] ?? before[i])) ?? [0, 0, 0, 0],
      }))
      .filter((region) => region.rect[2] > 0 && region.rect[3] > 0);
    if (!step.live) {
      // The screencast is in device pixels; regions and the recorder's
      // boxes in CSS pixels.
      const dpr = await sessions[index].client.eval("devicePixelRatio");
      const device = (r) => r.map((v) => v * dpr);
      const scaled = rects.map((r) => ({ ...r, rect: device(r.rect) }));
      for (const v of checkRegions(page.shots, scaled, (rect) =>
        motionAt(
          page.frames,
          rect.map((v) => v / dpr),
        ),
      ))
        own.push(`[${v.rule}] ${v.message}`);
    }
    if (own.length === 0) continue;
    for (const problem of own) problems.push(`${entry.page}: ${problem}`);
    failedPages.push({ entry, page, own, rects });
  }
  for (const { entry, page, own, rects } of failedPages) {
    const dir = join(
      artifacts,
      scenario.name,
      `${step.name}-${rate}x`,
      entry.page,
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "frames.json"),
      JSON.stringify(page.frames, null, 1),
    );
    writeFileSync(
      join(dir, "violations.txt"),
      `${own.join("\n")}\n\nregions: ${JSON.stringify(rects)}\n`,
    );
    page.shots.forEach((shot, i) => {
      writeFileSync(
        join(
          dir,
          `shot-${String(i).padStart(3, "0")}-${Math.round(shot.t - page.actionAt)}ms.png`,
        ),
        shot.png,
      );
    });
  }
  if ((motionSamples || step.coherent) && problems.length > 0) {
    const dir = join(artifacts, scenario.name, `${step.name}-${rate}x`);
    mkdirSync(dir, { recursive: true });
    if (motionSamples)
      writeFileSync(
        join(dir, "motion.json"),
        JSON.stringify(motionSamples, null, 1),
      );
    if (failedPages.length === 0) {
      // The pictures too, when only the motion or coherence rules failed.
      const page = recorded[0];
      writeFileSync(
        join(dir, "frames.json"),
        JSON.stringify(page.frames, null, 1),
      );
      page.shots.forEach((shot, i) => {
        writeFileSync(
          join(
            dir,
            `shot-${String(i).padStart(3, "0")}-${Math.round(shot.t - page.actionAt)}ms.png`,
          ),
          shot.png,
        );
      });
    }
    // A stale picture: what was settled, and what a fresh redraw drew.
    for (const [name, png] of Object.entries(stalePictures ?? {}))
      writeFileSync(join(dir, `stale-${name}.png`), png);
    // A torn picture: the pictures at rest its rows were looked for in.
    (restPictures ?? []).forEach((png, i) =>
      writeFileSync(join(dir, `rest-${String(i).padStart(2, "0")}.png`), png),
    );
    writeFileSync(join(dir, "violations.txt"), `${problems.join("\n")}\n`);
  }
  // What the step checks of the settled page itself (`check(ctx)`: a list
  // of problems), after the recording's rules.
  if (step.check) {
    try {
      for (const problem of await step.check(ctx)) problems.push(problem);
    } catch (error) {
      problems.push(`the step's check failed: ${error.message}`);
    }
  }
  // A known fault (step.known: [{ match, why, owner }]) is reported, every
  // time it shows, but does not fail the run; only the problems it matches
  // are excused, never the rest of the step. owner "outside": its cause is
  // not DevHub's (a plugin, Neovim); "devhub": an open fault of DevHub's,
  // diagnosed and not fixed yet (docs/visual-stability.md, "Open faults").
  const known = [];
  const unexcused = problems.filter((problem) => {
    const excuse = (step.known ?? []).find((k) => k.match.test(problem));
    if (excuse === undefined) return true;
    known.push(
      `${problem}\n  known (${excuse.owner === "devhub" ? "open DevHub fault" : "outside DevHub"}): ${excuse.why}`,
    );
    return false;
  });
  return {
    scenario: scenario.name,
    step: step.name,
    rate,
    ok: unexcused.length === 0,
    ms: Date.now() - t0,
    frames: frameCount,
    shots: shotCount,
    problems: unexcused,
    known,
  };
}

async function resolveRegions(client, regions) {
  if (!regions?.length) return [];
  // A region is an element (`selector`), the viewport, or a page
  // expression answering [x, y, w, h] (`expr`: rows no element covers).
  const exprs = regions.map((r) => r.expr ?? null);
  return client.eval(`(${JSON.stringify(regions.map((r) => r.selector ?? null))}).map((s, i) => {
    const expr = ${JSON.stringify(exprs)}[i];
    if (expr) { const r = (0, eval)(expr); return r ? r.map(Math.round) : null; }
    if (s === "viewport") return [0, 0, innerWidth, innerHeight];
    const el = document.querySelector(s);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) return null;
    return [b.x, b.y, b.width, b.height].map(Math.round);
  })`);
}

function makeContext(app, paths, pages) {
  const socket = () => {
    const out = app.tmux("list-panes", "-a", "-F", "#{@devhub-nvim}");
    const sock = out.split("\n").find((line) => line.trim());
    if (!sock) throw new Error("no devhub-nvim window");
    return sock.trim();
  };
  const nvim = join(appDir, "out", "nvim", "bin", "nvim");
  const windowId = () =>
    execFileSync("xdotool", ["search", "--name", "DevHub$"])
      .toString()
      .trim()
      .split("\n")[0];
  let baseSize;
  let luaChunks = 0;
  const visiblePane = async () => {
    for (const target of await targets(app.port)) {
      if (target.type !== "page" || !target.url.includes("pane.html#ws"))
        continue;
      const client = await ctx.page(target.url);
      if ((await client.eval("document.visibilityState")) === "visible")
        return target.url;
    }
    throw new Error("no Workspace terminal on screen");
  };
  const ctx = {
    app,
    paths,
    async page(name) {
      const match =
        name === "pane" ? await visiblePane() : (PAGES[name] ?? name);
      let client = pages.get(match);
      if (!client) {
        client = await connect(app.port, match);
        await client.send("Page.enable");
        pages.set(match, client);
      }
      return client;
    },
    /** State a scenario keeps between its runs at each rate. */
    state: {},
    async evalIn(page, expression) {
      return (await ctx.page(page)).eval(expression);
    },
    async waitIn(page, expression, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      while (!(await ctx.evalIn(page, expression))) {
        if (Date.now() > deadline)
          throw new Error(`${page}: ${expression} never held`);
        await sleep(150);
      }
    },
    /** Keys go to the page's own key target, as after a click into it. */
    async focus(page) {
      await ctx.evalIn(
        page,
        "document.querySelector('textarea.nvim-input')?.focus()",
      );
    },
    async focusSelector(page, selector) {
      await ctx.evalIn(
        page,
        `document.querySelector(${JSON.stringify(selector)})?.focus()`,
      );
    },
    /** Where the element is: its centre, or nothing. */
    async centre(page, selector, text) {
      return ctx.evalIn(
        page,
        `(() => {
        const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${JSON.stringify(text ?? null)} === null || e.textContent.includes(${JSON.stringify(text ?? "")}));
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return [b.x + b.width / 2, b.y + b.height / 2];
      })()`,
      );
    },
    /** The pointer onto an element, as it gets there before a click (its hover drawn, settled). */
    async hoverText(page, selector, text) {
      const at = await ctx.centre(page, selector, text);
      if (!at) throw new Error(`${page}: no ${selector} with "${text}"`);
      const client = await ctx.page(page);
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: at[0],
        y: at[1],
      });
      await sleep(400);
    },
    async hoverSelector(page, selector) {
      return ctx.hoverText(page, selector, undefined);
    },
    /** The tmux session of the Workspace `alpha` (the one the scenarios work in). */
    alphaSession() {
      const sock = socket();
      const out = app.tmux(
        "list-panes",
        "-a",
        "-F",
        "#{session_name} #{@devhub-nvim}",
      );
      const line = out.split("\n").find((l) => l.includes(sock));
      if (!line) throw new Error("no session with the devhub-nvim window");
      return line.split(" ")[0];
    },
    /** `notches` wheel ticks of `delta` px over `selector`, `gapMs` apart (a burst, slow or fast). */
    async wheel(page, selector, notches, delta, gapMs) {
      const at = await ctx.centre(page, selector, undefined);
      if (!at) throw new Error(`${page}: no ${selector} to wheel over`);
      const client = await ctx.page(page);
      for (let i = 0; i < notches; i++) {
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: at[0],
          y: at[1],
          deltaX: 0,
          deltaY: delta,
        });
        if (gapMs > 0) await sleep(gapMs);
      }
    },
    async clickAt(page, x, y) {
      const client = await ctx.page(page);
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
      });
      for (const type of ["mousePressed", "mouseReleased"]) {
        await client.send("Input.dispatchMouseEvent", {
          type,
          x,
          y,
          button: "left",
          clickCount: 1,
        });
      }
    },
    /** Click the first `selector` element whose text includes `text`. */
    async clickText(page, selector, text) {
      const at = await ctx.centre(page, selector, text);
      if (!at) throw new Error(`${page}: no ${selector} with "${text}"`);
      await ctx.clickAt(page, at[0], at[1]);
    },
    async clickSelector(page, selector) {
      const at = await ctx.centre(page, selector, undefined);
      if (!at) throw new Error(`${page}: no ${selector}`);
      await ctx.clickAt(page, at[0], at[1]);
    },
    /** Run Lua in the devhub-nvim Neovim, as one call (one flush). */
    lua(code) {
      const file = join(paths.root, `chunk-${++luaChunks}.lua`);
      writeFileSync(file, code);
      return ctx.nvimExpr(`luaeval('dofile(_A)', ${JSON.stringify(file)})`);
    },
    async press(page, ...keys) {
      const client = await ctx.page(page);
      for (const key of keys) await pressKey(client, key);
    },
    async type(page, text) {
      await typeText(await ctx.page(page), text);
    },
    nvimSend(keys) {
      execFileSync(nvim, ["--server", socket(), "--remote-send", keys], {
        env: app.env,
      });
    },
    nvimExpr(expr) {
      return execFileSync(nvim, ["--server", socket(), "--remote-expr", expr], {
        env: app.env,
      }).toString();
    },
    /** Wait until `page` has drawn nothing new for `ms`. */
    async settle(page, ms = 400) {
      const client = await ctx.page(page);
      await client.eval(`new Promise((resolve) => {
        let last = performance.now(), seen = "";
        const read = () => [...document.querySelectorAll("canvas, .nvim-view, .nvim-view-frame, .nvim-popup, .nvim-cmdline")].map((e) => { const b = e.getBoundingClientRect(); return b.x + "," + b.y + "," + b.width + "," + b.height; }).join(";");
        const tick = () => { const now = read(); if (now !== seen) { seen = now; last = performance.now(); } if (performance.now() - last > ${ms}) resolve(); else requestAnimationFrame(tick); };
        tick();
        // A hidden page draws no frames: nothing to wait for there.
        setTimeout(resolve, 5000);
      })`);
    },
    /** Resize the window by each [dw, dh] from its first size, a frame or two apart. */
    async resizeWindow(steps) {
      const id = windowId();
      if (!baseSize) {
        const geometry = execFileSync("xdotool", [
          "getwindowgeometry",
          id,
        ]).toString();
        const m = /Geometry: (\d+)x(\d+)/.exec(geometry);
        baseSize = [Number(m[1]), Number(m[2])];
      }
      for (const [dw, dh] of steps) {
        execFileSync("xdotool", [
          "windowsize",
          id,
          String(baseSize[0] + dw),
          String(baseSize[1] + dh),
        ]);
        await sleep(120);
      }
    },
    setAppearance(mode) {
      writeSettings(paths, mode);
    },
    cli(args, cwd = paths.workspaceA) {
      return app.cli(args, cwd);
    },
    /** Wait until `count` Workspace terminals are attached to their tmux sessions. */
    async terminalAttached(count) {
      const deadline = Date.now() + 20_000;
      for (;;) {
        try {
          const clients = app
            .tmux("list-clients", "-F", "#{session_name}")
            .split("\n");
          if (
            new Set(clients.filter((name) => name.startsWith("ws-"))).size >=
            count
          )
            return;
        } catch {
          // no server yet
        }
        if (Date.now() > deadline)
          throw new Error("the Workspace's terminal never attached");
        await sleep(200);
      }
    },
    async prepare() {
      // Two Workspaces, alpha selected, its devhub-nvim window on a file.
      // Each Workspace's terminal is attached before anything else makes its
      // tmux session: a `devhub <file>` racing the terminal's first attach
      // makes the session first, and the attach refuses it as a conflict.
      app.cli([paths.workspaceB], paths.workspaceB);
      await ctx.terminalAttached(1);
      app.cli([paths.workspaceA], paths.workspaceA);
      await ctx.terminalAttached(2);
      app.cli(["src/core/core0.ts"], paths.workspaceA);
      const deadline = Date.now() + 30_000;
      for (;;) {
        try {
          if (ctx.nvimExpr("exists(':NvimTreeToggle')").trim() === "2") break;
        } catch {
          // Neovim not up yet
        }
        if (Date.now() > deadline)
          throw new Error(
            "the devhub-nvim Neovim never came up with its plugins",
          );
        await sleep(250);
      }
      await ctx.settle("pane", 800);
    },
  };
  return ctx;
}

await main();

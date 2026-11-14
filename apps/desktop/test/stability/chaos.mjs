// The chaos layer of the visual-stability suite (docs/visual-stability.md,
// "Chaos"): DevHub hammered the way a heavy user could, from a seed, and
// held to the suite's per-frame rules while it happens and to Neovim's and
// tmux's truth whenever it is quiet.
//
//   node test/stability/chaos.mjs --seeds 1,2,3 [--actions 60] [--rates 1,6]
//     [--neovim-delay 150] [--minutes 25] [--only wheel,type]
//     [--replay <plan.json>] [--minimise] [--port N]
//
// A seed draws a plan (chaosActions.mjs): bursts of 1-6 actions, a quarter
// of them run alongside the one before. Each burst is recorded as the suite
// records a step (recorder.js, motionRecorder.js, the screencast), at the
// rate's CPU throttling, then held to:
//
//   per frame   no role on screen twice that is one (doubled); a scroll's
//               text area covered by its canvas and ghost in every frame
//               (uncovered); what is anchored to text with its text
//               (misaligned); at the burst's end, at rest (unsettled)
//   quiet       after the burst, two Escapes and quiet: Neovim's screen
//               (screenstring of every window) is DevHub's grids, cell for
//               cell; its windows are DevHub's windows, place and size; its
//               cursor is DevHub's cursor, and the cursor drawn is inside its
//               window; Neovim is in Normal mode and DevHub says so; the
//               editor's picture is a fresh full redraw's (stale); no window
//               is still scrolling
//   liveness    every line typed is in a buffer exactly as typed; every
//               message sent is in the transcript; Neovim answers an RPC,
//               every page an evaluation, within 5 s; both Workspaces' tmux
//               clients are attached; no exception on any page (CDP
//               Runtime.exceptionThrown, console errors) or in main's log
//   growth      each page's JS heap (after a GC) and DOM node count at every
//               quiet point, to metrics.csv; at the end of a run of at least
//               10 minutes (a soak), the last fifth against the first
//
// A failing seed writes, under $DEVHUB_STABILITY_ARTIFACTS (default
// .spike/chaos) /seed-<seed>-<rate>x/: plan.json (seed, rate, the actions
// with their params, which burst failed), log.txt (each action, when),
// violations.txt, the failing burst's frames.json, motion.json and
// screencast, the quiet point's pictures, and app.log. Passing seeds keep
// nothing. --replay plan.json runs a plan again on a fresh DevHub;
// --minimise shrinks a failing plan (ddmin over its actions, each try on a
// fresh DevHub) and writes minimal.json.

import { execFile, execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./app.mjs";
import { capture } from "./capture.mjs";
import { BY_NAME, plan } from "./chaosActions.mjs";
import { fetchPlugins } from "./fetchPlugins.mjs";
import { check } from "./invariants.mjs";
import { checkMotion } from "./motionInvariants.mjs";
import { appDir, makeProfile } from "./profile.mjs";
import { CARETS, NO_CARETS, PAGES, makeContext } from "./run.mjs";
import { decodePng, regionDigest } from "./pixels.mjs";
import { NEOVIM_MOTION, NEOVIM_ROLES, editorAtRest } from "./scenarios.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const motionSource = readFileSync(
  new URL("./motionRecorder.js", import.meta.url),
  "utf8",
)
  .trim()
  .replace(/;$/, "");

/** The per-frame rules a burst is held to: not one change (a burst is many). */
const FRAME_SPEC = {
  only: [],
  single: ["cmdline", "frame", "frame-list", "tabline"],
};
const MOTION_SPEC = {
  aligned: true,
  covered: true,
  monotonic: false,
  rest: true,
};
const TIMEOUT_MS = 5000;

function parseArgs(argv) {
  const args = {
    seeds: [1],
    actions: 60,
    rates: [1],
    port: 9400 + (process.pid % 500),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--seeds") args.seeds = argv[++i].split(",").map(Number);
    else if (arg === "--actions") args.actions = Number(argv[++i]);
    else if (arg === "--rates") args.rates = argv[++i].split(",").map(Number);
    else if (arg === "--neovim-delay") args.neovimDelay = Number(argv[++i]);
    else if (arg === "--minutes") args.minutes = Number(argv[++i]);
    else if (arg === "--only") args.only = argv[++i].split(",");
    else if (arg === "--replay") args.replay = argv[++i];
    else if (arg === "--minimise") args.minimise = true;
    else if (arg === "--port") args.port = Number(argv[++i]);
    else throw new Error(`unknown argument ${arg}`);
  }
  return args;
}

/** A DevHub of its own, prepared as the suite prepares one, with what chaos adds to the context. */
async function launch(args, artifacts) {
  mkdirSync(artifacts, { recursive: true });
  const plugins = fetchPlugins();
  const root = mkdtempSync(join(tmpdir(), "devhub-chaos-"));
  const paths = makeProfile(root, plugins);
  const logPath = join(artifacts, "app.log");
  const app = await startApp(paths, {
    neovimDelayMs: args.neovimDelay,
    port: args.port,
    logPath,
  });
  const pages = new Map();
  const ctx = makeContext(app, paths, pages);
  const errors = [];
  const watched = new Set();
  const page = ctx.page.bind(ctx);
  // Every page's exceptions and console errors, from its first use on.
  ctx.page = async (name) => {
    const client = await page(name);
    if (!watched.has(client)) {
      watched.add(client);
      await client.send("Runtime.enable").catch(() => {});
      client.on("Runtime.exceptionThrown", (e) =>
        errors.push(
          `${name}: exception: ${e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text}`.slice(
            0,
            400,
          ),
        ),
      );
      client.on("Runtime.consoleAPICalled", (e) => {
        if (e.type !== "error") return;
        const text = (e.args ?? [])
          .map((a) => a.value ?? a.description ?? "")
          .join(" ");
        errors.push(`${name}: console.error: ${text}`.slice(0, 400));
      });
    }
    return client;
  };
  const nvim = join(appDir, "out", "nvim", "bin", "nvim");
  let chunks = 0;
  Object.assign(ctx, {
    errors,
    logPath,
    root,
    /** A key through X, to whatever has the keyboard (a native menu). */
    xKey(name) {
      try {
        execFileSync("xdotool", ["key", name]);
      } catch {
        // no window has it
      }
    },
    /** An RPC that does not hold the driver while Neovim answers (20 s at most). */
    rpc(expr) {
      const sock = app
        .tmux("list-panes", "-a", "-F", "#{@devhub-nvim}")
        .split("\n")
        .find((l) => l.trim());
      if (!sock) return Promise.reject(new Error("no devhub-nvim window"));
      return new Promise((resolve, reject) =>
        execFile(
          nvim,
          ["--server", sock.trim(), "--remote-expr", expr],
          { env: app.env, timeout: 20_000 },
          (error, stdout) =>
            error
              ? reject(
                  new Error(
                    error.killed
                      ? `liveness: Neovim left a request unanswered for 20 s: ${expr.slice(0, 80)}`
                      : error.message,
                  ),
                )
              : resolve(stdout.toString()),
        ),
      );
    },
    luaAsync(code) {
      const file = join(root, `chaos-${String(++chunks)}.lua`);
      writeFileSync(file, code);
      return ctx.rpc(`luaeval('dofile(_A)', ${JSON.stringify(file)})`);
    },
    /** An RPC that must be answered within TIMEOUT_MS. */
    nvimTimed(expr) {
      const sock = app
        .tmux("list-panes", "-a", "-F", "#{@devhub-nvim}")
        .split("\n")
        .find((l) => l.trim());
      if (!sock) throw new Error("no devhub-nvim window");
      return execFileSync(
        nvim,
        ["--server", sock.trim(), "--remote-expr", expr],
        { env: app.env, timeout: TIMEOUT_MS },
      ).toString();
    },
    async waitNeovim() {
      const deadline = Date.now() + 30_000;
      for (;;) {
        try {
          if (ctx.nvimExpr("exists(':NvimTreeToggle')").trim() === "2") return;
        } catch {
          // not up yet
        }
        if (Date.now() > deadline)
          throw new Error("liveness: the devhub-nvim Neovim never came back");
        await sleep(250);
      }
    },
    /** `lines` lines written to the pane's terminal, as a program in it would. */
    async writeTty(target, lines) {
      const tty = app.tmux("display", "-p", "-t", target, "#{pane_tty}").trim();
      const fd = openSync(tty, "w");
      try {
        for (let i = 1; i <= lines; i++) {
          writeSync(fd, `chaos ${String(i)} ${"=".repeat(i % 70)}\r\n`);
          if (i % 10 === 0) await sleep(5);
        }
      } finally {
        closeSync(fd);
      }
    },
    /**
     * The editor on screen has the keyboard: its page is the window's
     * focused one and Neovim's input is its focused element, within 3 s of
     * asking (after a Workspace switch, a click elsewhere): the stuck-focus
     * check.
     */
    async ready() {
      const deadline = Date.now() + 3000;
      let last = "";
      for (;;) {
        last = await ctx.evalIn(
          "pane",
          "JSON.stringify([document.visibilityState, document.hasFocus(), document.activeElement?.tagName + '.' + document.activeElement?.className])",
        );
        const [vis, focused, el] = JSON.parse(last);
        if (vis === "visible" && focused && /nvim-input/.test(el)) return;
        if (Date.now() > deadline) {
          // Who moved the focus last: what the page's focus trail kept.
          const trail = await ctx
            .evalIn(
              "pane",
              "JSON.stringify((window.__chaosFocus ?? []).slice(-6))",
            )
            .catch(() => "[]");
          throw new Error(
            `liveness: focus: the editor did not get the keyboard in 3 s (page ${vis}, focused ${String(focused)}, active ${el}); focus trail ${trail}`,
          );
        }
        await sleep(50);
      }
    },
    agent: false,
    appearance: "dark",
    async openFakeAgent() {
      if (!ctx.agent) {
        ctx.cli(["--agent", "fake"]);
        ctx.agent = true;
      } else {
        await ctx.realClick("sidebar", ".sidebar-row", "Fake");
      }
      await ctx.waitIn(
        "conversations",
        "!!document.querySelector('.conversation-composer-input')",
        10_000,
      );
    },
  });
  await ctx.prepare();
  // Neovim's CurSearch "may get outdated if changes are made or the screen
  // is redrawn" (:h hl-CurSearch): the match under the cursor is not
  // redrawn when the cursor leaves it by another motion, in any UI, and
  // :redraw! shows it moved. Not DevHub's; drawn as Search here, so the
  // fresh-redraw check sees DevHub's faults, not that one.
  ctx.nvimExpr(
    "execute('highlight! link CurSearch Search | autocmd ColorScheme * highlight! link CurSearch Search')",
  );
  return { app, ctx };
}

/** Each window of the current tab as Neovim has it: place, size, rows on screen. */
const TRUTH_LUA = `
local out = { mode = vim.api.nvim_get_mode().mode, wins = {}, floats = 0 }
local cur = vim.api.nvim_get_current_win()
for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
  local cfg = vim.api.nvim_win_get_config(w)
  if cfg.relative ~= '' then
    out.floats = out.floats + 1
  else
    local pos = vim.fn.win_screenpos(w)
    local h, wd = vim.api.nvim_win_get_height(w), vim.api.nvim_win_get_width(w)
    local rows = {}
    for r = 0, h - 1 do
      local cells = {}
      for c = 0, wd - 1 do cells[#cells + 1] = vim.fn.screenstring(pos[1] + r, pos[2] + c) end
      rows[#rows + 1] = (table.concat(cells):gsub('%s+$', ''))
    end
    out.wins[#out.wins + 1] = { win = w, row = pos[1] - 1, col = pos[2] - 1, width = wd, height = h, rows = rows }
  end
end
vim.api.nvim_win_call(cur, function()
  out.cursor = { win = cur, row = vim.fn.winline() - 1, col = vim.fn.wincol() - 1 }
end)
return vim.json.encode(out)
`;

/** What DevHub has of the same: its model's windows and grids, its cursor, what it draws. */
const DRAWN = `(() => {
  // The Neovim on screen (a pane can hold more, one going as another comes).
  const ed = Object.values(window.neovimEditors ?? {}).find((e) => e.host?.isConnected && e.host.getClientRects().length > 0 && getComputedStyle(e.host).visibility !== 'hidden') ?? Object.values(window.neovimEditors ?? {})[0];
  if (!ed) return null;
  const s = ed.state;
  const wins = [];
  for (const [grid, w] of s.windows) {
    const p = w.placement;
    if (!p || p.kind !== 'window' || w.hidden) continue;
    const g = s.grids.get(grid);
    const rows = [];
    if (g) for (let r = 0; r < g.height; r++) rows.push(g.chars.slice(r * g.width, (r + 1) * g.width).join('').replace(/\\s+$/, ''));
    const v = ed.painter.scrollView?.(grid);
    wins.push({ grid, win: p.win, row: p.row, col: p.col, width: p.width, height: p.height, rows, off: v ? v.off : 0, ghost: v ? v.ghost !== undefined : false });
  }
  const c = s.cursor;
  const cw = s.windows.get(c.grid);
  const caret = document.querySelector('.nvim-cursor');
  const canvas = ed.painter.canvases.get(c.grid)?.canvas;
  const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return b.width || b.height ? [b.x, b.y, b.width, b.height] : null; };
  return { mode: s.mode?.name ?? '', wins, cursor: { win: cw?.placement?.win, row: c.row, col: c.col }, caret: box(caret), canvas: box(canvas), caretShown: !!caret && getComputedStyle(caret).visibility !== 'hidden' && getComputedStyle(caret).display !== 'none' };
})()`;

async function timed(promise, what, ms = TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`liveness: ${what} did not answer in ${String(ms)} ms`),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The quiet point after a burst: DevHub against Neovim's and tmux's truth. */
async function quiet(ctx, expects, logOffset) {
  const problems = [];
  // Liveness first: everything answers.
  for (const name of [...Object.keys(PAGES), "pane"]) {
    try {
      const client = await timed(ctx.page(name), `the ${name} page's target`);
      await timed(client.eval("1"), `the ${name} page`);
    } catch (error) {
      problems.push(`[liveness] ${error.message}`);
    }
  }
  // First back on alpha, in Normal mode, nothing open (a key sequence left
  // pending holds every request): what a person does to look.
  await ctx.realClick("sidebar", ".sidebar-row", "alpha").catch(() => {});
  try {
    await ctx.ready();
  } catch (error) {
    problems.push(`[focus] after alpha was chosen: ${error.message}`);
    // A click into the editor, as a person would, to look at the rest.
    await ctx.realClick("pane", ".nvim-editor").catch(() => {});
  }
  await ctx.focus("pane");
  await ctx.press("pane", "Escape");
  await ctx.press("pane", "Escape");
  await ctx.settle("pane", 500);
  try {
    ctx.nvimTimed("1");
  } catch (error) {
    problems.push(
      `[liveness] Neovim did not answer an RPC: ${error.message.split("\n")[0]}`,
    );
    return { problems, pictures: {} };
  }
  try {
    const clients = new Set(
      ctx.app
        .tmux("list-clients", "-F", "#{session_name}")
        .split("\n")
        .filter((n) => n.startsWith("ws-")),
    );
    if (clients.size < 2)
      problems.push(
        `[liveness] ${String(clients.size)} Workspace tmux clients attached, not 2`,
      );
  } catch (error) {
    problems.push(
      `[liveness] tmux did not answer: ${error.message.split("\n")[0]}`,
    );
  }
  for (const e of expects) {
    if (e.typed !== undefined) {
      // Neovim may still be taking the keys in (a burst of them, blink
      // asked at each): looked for until it has, 5 s at most.
      let found = "0";
      for (let i = 0; i < 25 && found !== "1"; i++) {
        found = ctx
          .nvimTimed(
            `luaeval('(function(t) for _, b in ipairs(vim.api.nvim_list_bufs()) do if vim.api.nvim_buf_is_loaded(b) then for _, l in ipairs(vim.api.nvim_buf_get_lines(b, 0, -1, false)) do if vim.endswith(l, t) then return 1 end end end end return 0 end)(_A)', ${JSON.stringify(e.typed)})`,
          )
          .trim();
        if (found !== "1") await sleep(200);
      }
      if (found !== "1") {
        // Where it went instead: a tmux pane of alpha's that has it.
        let where = "";
        try {
          const tag = e.typed.split(" ")[0];
          for (const pane of ctx.app
            .tmux(
              "list-panes",
              "-s",
              "-t",
              ctx.alphaSession(),
              "-F",
              "#{pane_id} #{window_index} #{pane_current_command}",
            )
            .split("\n")
            .filter(Boolean)) {
            const [id, index, command] = pane.split(" ");
            const text = ctx.app.tmux(
              "capture-pane",
              "-p",
              "-S",
              "-200",
              "-t",
              id,
            );
            const line = text.split("\n").find((l) => l.includes(tag));
            if (line)
              where += ` In tmux window ${index} (${command}): "${line.trim().slice(0, 120)}".`;
          }
          const near = ctx
            .nvimTimed(
              `luaeval('(function(t) for _, l in ipairs(vim.api.nvim_buf_get_lines(0, 0, -1, false)) do if l:find(t, 1, true) then return l end end return "" end)(_A)', ${JSON.stringify(tag)})`,
            )
            .trim();
          if (near) where += ` In the buffer: "${near.slice(0, 120)}".`;
        } catch {
          // nothing more to say
        }
        problems.push(
          `[lost-input] the line typed "${e.typed}" ends no line of any buffer (the line may begin with what Neovim adds: indent, a comment leader).${where}`,
        );
      }
    }
  }
  const truth = JSON.parse(
    ctx.nvimTimed(`luaeval('loadstring(_A)()', ${JSON.stringify(TRUTH_LUA)})`),
  );
  const client = await ctx.page("pane");
  const drawn = await client.eval(DRAWN);
  if (!drawn) {
    problems.push("[truth] no Neovim editor on alpha's page");
    return { problems, pictures: {} };
  }
  if (truth.mode !== "n")
    problems.push(`[mode] Neovim is in mode "${truth.mode}" after two Escapes`);
  else if (!/^normal/.test(drawn.mode))
    problems.push(
      `[mode] Neovim is in Normal mode, DevHub draws "${drawn.mode}"`,
    );
  for (const t of truth.wins) {
    const d = drawn.wins.find((w) => w.win === t.win);
    if (!d) {
      problems.push(
        `[layout] Neovim's window ${String(t.win)} is not among DevHub's windows`,
      );
      continue;
    }
    for (const k of ["row", "col", "width", "height"])
      if (d[k] !== t[k])
        problems.push(
          `[layout] window ${String(t.win)}: ${k} ${String(d[k])} in DevHub, ${String(t[k])} in Neovim`,
        );
    if (d.off !== 0 || d.ghost)
      problems.push(
        `[unsettled] window ${String(t.win)} still scrolled ${String(d.off)} px${d.ghost ? ", its ghost shown" : ""} at quiet`,
      );
    if (truth.floats === 0) {
      const bad = t.rows.findIndex((row, i) => row !== (d.rows[i] ?? ""));
      if (bad >= 0)
        problems.push(
          `[grid] window ${String(t.win)} row ${String(bad)}: DevHub has "${(d.rows[bad] ?? "").slice(0, 80)}", Neovim's screen "${t.rows[bad].slice(0, 80)}"`,
        );
    }
  }
  for (const d of drawn.wins)
    if (!truth.wins.some((t) => t.win === d.win))
      problems.push(
        `[layout] DevHub draws window ${String(d.win)}, which Neovim does not have`,
      );
  const c = truth.cursor;
  if (
    drawn.cursor.win !== c.win ||
    drawn.cursor.row !== c.row ||
    drawn.cursor.col !== c.col
  )
    problems.push(
      `[cursor] DevHub's cursor at window ${String(drawn.cursor.win)} ${String(drawn.cursor.row)},${String(drawn.cursor.col)}; Neovim's at ${String(c.win)} ${String(c.row)},${String(c.col)}`,
    );
  if (drawn.caretShown && drawn.caret && drawn.canvas) {
    const [x, y, w, h] = drawn.caret;
    const [cx, cy, cw, ch] = drawn.canvas;
    if (x < cx - 1 || y < cy - 1 || x + w > cx + cw + 1 || y + h > cy + ch + 1)
      problems.push(
        `[cursor] the cursor drawn @${drawn.caret.join(",")} is outside its window's grid @${drawn.canvas.join(",")}`,
      );
  }
  let pictures = {};
  if (truth.floats === 0) {
    const stale = await fresh(ctx, client);
    if (stale) {
      problems.push(stale.message);
      pictures = stale.pictures;
    }
  }
  // Exceptions on the pages, and in main's log since the last quiet point.
  for (const e of ctx.errors.splice(0)) problems.push(`[exception] ${e}`);
  let offset = logOffset.value;
  try {
    const size = statSync(ctx.logPath).size;
    if (size > offset) {
      const buf = Buffer.alloc(size - offset);
      const fd = openSync(ctx.logPath, "r");
      const { readSync } = await import("node:fs");
      readSync(fd, buf, 0, buf.length, offset);
      closeSync(fd);
      offset = size;
      for (const line of buf.toString().split("\n"))
        if (
          /Uncaught|Unhandled|TypeError|ReferenceError|RangeError|\bFATAL\b/.test(
            line,
          )
        )
          problems.push(`[exception] main: ${line.slice(0, 300)}`);
    }
  } catch {
    // no log yet
  }
  logOffset.value = offset;
  return { problems, pictures };
}

/** DevHub's model of every window grid, row by row: its text and each cell's colours. */
const MODEL = `(() => {
  // The Neovim on screen (a pane can hold more, one going as another comes).
  const ed = Object.values(window.neovimEditors ?? {}).find((e) => e.host?.isConnected && e.host.getClientRects().length > 0 && getComputedStyle(e.host).visibility !== 'hidden') ?? Object.values(window.neovimEditors ?? {})[0];
  if (!ed) return {};
  const s = ed.state, out = {};
  const look = (id) => { const h = s.hl.get(id) ?? {}; return [h.foreground, h.background, h.reverse ? 1 : 0, h.bold ? 1 : 0].join('/'); };
  for (const [grid, w] of s.windows) {
    if (w.placement?.kind !== 'window' || w.hidden) continue;
    const g = s.grids.get(grid);
    if (!g) continue;
    const rows = [];
    for (let r = 0; r < g.height; r++) {
      let row = '';
      for (let c = 0; c < g.width; c++) row += g.chars[r * g.width + c] + look(g.hls[r * g.width + c]) + ';';
      rows.push(row);
    }
    out[w.placement.win] = rows;
  }
  return out;
})()`;

/**
 * The editor's picture at rest against a fresh full redraw's (:redraw!),
 * each taken once two pictures 400 ms apart agree (a notification fading,
 * a theme landing: still changing is not stale). Told apart: DevHub's model
 * changed with the redraw (what Neovim sent before left those cells as they
 * were: Neovim's redraw stream, or DevHub taking it in wrong), or only the
 * picture did (DevHub drew its model wrong).
 */
async function fresh(ctx, client) {
  const rect = await client.eval(
    `(() => { const e = document.querySelector(".nvim-editor"); if (!e) return null; const b = e.getBoundingClientRect(); const fs = [...e.querySelectorAll(".nvim-footer")].map((f) => f.getBoundingClientRect().bottom); const bottom = fs.length ? Math.min(b.bottom, Math.max(...fs)) : b.bottom; return [b.x, b.y, b.width, bottom - b.y].map(Math.round); })()`,
  );
  if (!rect) return undefined;
  const dpr = await client.eval("devicePixelRatio");
  const device = rect.map((v) => Math.round(v * dpr));
  const steady = async () => {
    let last;
    for (let i = 0; i < 12; i++) {
      const r = await client.send("Page.captureScreenshot", { format: "png" });
      const png = Buffer.from(r.data, "base64");
      const digest = regionDigest(decodePng(png), device);
      if (last && last.digest === digest) return last;
      last = { png, digest };
      await sleep(400);
    }
    return last;
  };
  // Nor the notifications' corner: :redraw! clears Neovim's messages in
  // Neovim itself, and their toasts go with them.
  const NO_TOASTS = `(() => { const s = document.createElement("style"); s.id = "__chaos_notoasts"; s.textContent = ".nvim-toasts { display: none !important }"; document.head.append(s); })()`;
  await client.eval(NO_CARETS);
  await client.eval(NO_TOASTS);
  try {
    await ctx.settle("pane", 300);
    const before = await steady();
    const modelBefore = await client.eval(MODEL);
    ctx.nvimTimed("execute('redraw!')");
    await ctx.settle("pane", 400);
    const after = await steady();
    const modelAfter = await client.eval(MODEL);
    if (before.digest === after.digest) return undefined;
    const changed = [];
    for (const [win, rows] of Object.entries(modelAfter))
      rows.forEach((row, i) => {
        if ((modelBefore[win] ?? [])[i] !== row)
          changed.push(`${win}:${String(i)}`);
      });
    return {
      message:
        changed.length > 0
          ? `[stale-model] after :redraw! DevHub's model of ${String(changed.length)} rows changed (window:row ${changed.slice(0, 6).join(", ")}): the redraws before left them as they were`
          : `[stale] the editor's picture differs from a fresh full redraw's with the same model: DevHub drew its model wrong`,
      pictures: { settled: before.png, fresh: after.png },
    };
  } finally {
    await client.eval(CARETS);
    await client.eval('document.getElementById("__chaos_notoasts")?.remove()');
  }
}

/** Heap (after a GC) and DOM nodes of every page. */
async function measure(ctx) {
  const out = {};
  for (const name of [...Object.keys(PAGES), "pane"]) {
    try {
      const client = await ctx.page(name);
      await client.send("HeapProfiler.collectGarbage").catch(() => {});
      const heap = await client.send("Runtime.getHeapUsage");
      const nodes = await client.eval(
        "document.getElementsByTagName('*').length",
      );
      out[name] = { heap: Math.round(heap.usedSize / 1024), nodes };
    } catch {
      // the page is gone for now
    }
  }
  return out;
}

async function runAction(ctx, step) {
  const action = BY_NAME.get(step.name);
  return (await action.run(ctx, step.params)) ?? {};
}

/**
 * One plan at one rate on `ctx`: burst by burst, recorded, then the quiet
 * point. Returns { failed, burst, problems } and writes artefacts on a
 * failure.
 */
async function runPlan(ctx, steps, rate, dir, meta) {
  const log = [];
  const logOffset = { value: 0 };
  const metrics = [];
  const bursts = [...new Set(steps.map((s) => s.burst))];
  const t0 = Date.now();
  await editorAtRest(ctx);
  // Each focus move on the editor's page, with the code that made it.
  await ctx.evalIn(
    "pane",
    `(() => { if (window.__chaosFocusOn) return; window.__chaosFocusOn = true; window.__chaosFocus = []; document.addEventListener("focusin", (e) => { window.__chaosFocus.push({ t: Math.round(performance.now()), to: e.target.tagName + "." + e.target.className, stack: (new Error().stack ?? "").split("\\n").slice(2, 9).map((l) => l.trim()).join(" | ") }); if (window.__chaosFocus.length > 20) window.__chaosFocus.shift(); }, true); document.addEventListener("pointerdown", (e) => { window.__chaosFocus.push({ t: Math.round(performance.now()), press: e.target.tagName + "." + e.target.className, at: [e.clientX, e.clientY], alt: e.altKey, neovim: !!e.target.closest?.("[data-devhub-neovim-pane], .pane-neovim") }); }, true); })()`,
  );
  // The keyboard to the editor, by a person's click.
  await ctx.realClick("sidebar", ".sidebar-row", "alpha");
  await ctx.realClick("pane", ".nvim-editor");
  await ctx.settle("pane");
  for (const burst of bursts) {
    const mine = steps.filter((s) => s.burst === burst);
    const client = await ctx.page("pane");
    await client.eval(`(${motionSource})(${JSON.stringify({})})`);
    const expects = [];
    const driver = [];
    let recorded;
    try {
      recorded = await capture(
        [
          {
            client,
            watch: { roles: NEOVIM_ROLES, motionMarkers: NEOVIM_MOTION },
          },
        ],
        async () => {
          let previous = Promise.resolve();
          const running = [];
          for (const step of mine) {
            const go = async () => {
              log.push(
                `${String(Date.now() - t0)} ms burst ${String(burst)} ${step.name} ${JSON.stringify(step.params)}`,
              );
              if (process.env.CHAOS_VERBOSE)
                console.log(`  ${log[log.length - 1]}`);
              try {
                expects.push(
                  await timed(
                    runAction(ctx, step),
                    `the action ${step.name}`,
                    60_000,
                  ),
                );
              } catch (error) {
                if (/liveness/.test(error.message)) throw error;
                driver.push(`${step.name}: ${error.message.split("\n")[0]}`);
              }
            };
            // An overlapping action starts with the one before it.
            const p = step.overlap ? go() : previous.then(go);
            running.push(p);
            previous = step.overlap ? Promise.all([previous, p]) : p;
          }
          await Promise.all(running);
        },
        { rate, quietMs: 600, timeoutMs: 30_000 },
      );
    } catch (error) {
      return fail(
        `[liveness] the burst did not finish: ${error.message.split("\n")[0]}`,
        burst,
      );
    }
    const samples = await client
      .eval("window.__motion?.take?.() ?? []")
      .catch(() => []);
    const problems = [];
    const page = recorded[0];
    if (!page.settled)
      problems.push(
        "[liveness] never quiet: something kept changing for 30 s after the burst",
      );
    for (const v of check(page.frames, FRAME_SPEC))
      problems.push(`[${v.rule}] ${v.message.split("\n")[0]}`);
    for (const v of checkMotion(samples, MOTION_SPEC))
      problems.push(`[${v.rule}] ${v.message}`);
    for (const d of driver) log.push(`  driver: ${d}`);
    const q = await quiet(ctx, expects, logOffset);
    problems.push(...q.problems);
    metrics.push({ t: Date.now() - t0, burst, ...(await measure(ctx)) });
    if (problems.length > 0) {
      save(
        dir,
        { ...meta, rate, steps, failedBurst: burst },
        log,
        problems,
        page,
        samples,
        q.pictures,
        ctx,
      );
      return { failed: true, burst, problems, metrics };
    }
  }
  return { failed: false, metrics, log };

  function fail(problem, burst) {
    save(
      dir,
      { ...meta, rate, steps, failedBurst: burst },
      log,
      [problem],
      undefined,
      [],
      {},
      ctx,
    );
    return { failed: true, burst, problems: [problem], metrics };
  }
}

function save(dir, plan, log, problems, page, samples, pictures, ctx) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan, null, 1));
  writeFileSync(join(dir, "log.txt"), `${log.join("\n")}\n`);
  writeFileSync(join(dir, "violations.txt"), `${problems.join("\n")}\n`);
  if (page) {
    writeFileSync(join(dir, "frames.json"), JSON.stringify(page.frames));
    writeFileSync(join(dir, "motion.json"), JSON.stringify(samples));
    // The screencast's last 80 pictures: enough to see, small on disk.
    page.shots
      .slice(-80)
      .forEach((shot, i) =>
        writeFileSync(
          join(
            dir,
            `shot-${String(i).padStart(3, "0")}-${String(Math.round(shot.t - page.actionAt))}ms.png`,
          ),
          shot.png,
        ),
      );
  }
  for (const [name, png] of Object.entries(pictures ?? {}))
    writeFileSync(join(dir, `quiet-${name}.png`), png);
  if (existsSync(ctx.logPath)) copyFileSync(ctx.logPath, join(dir, "app.log"));
}

/** Whether `steps` still fails with a problem of one of `rules`, on a fresh DevHub. */
async function reproduces(args, steps, rate, rules, artifacts, tries) {
  const dir = join(artifacts, `minimise-${String(tries)}`);
  mkdirSync(dir, { recursive: true });
  const { app, ctx } = await launch(args, dir);
  try {
    const result = await runPlan(ctx, steps, rate, dir, { minimising: true });
    const hit =
      result.failed && result.problems.some((p) => rules.has(ruleOf(p)));
    if (!hit) rmSync(dir, { recursive: true, force: true });
    return hit;
  } finally {
    app.stop();
  }
}

const ruleOf = (problem) => /^\[([a-z-]+)\]/.exec(problem)?.[1] ?? "?";

/** ddmin over a failing plan's actions; each burst becomes one action of its own. */
async function minimise(args, plan, artifacts) {
  const rules = new Set(plan.problems.map(ruleOf));
  let steps = plan.steps.slice(
    0,
    plan.steps.findLastIndex((s) => s.burst === plan.failedBurst) + 1,
  );
  let n = 2;
  let tries = 0;
  const budget = Number(process.env.CHAOS_MINIMISE_TRIES ?? 16);
  while (steps.length >= 2 && tries < budget) {
    const size = Math.ceil(steps.length / n);
    let reduced = false;
    for (let i = 0; i < n && tries < budget; i++) {
      const rest = [
        ...steps.slice(0, i * size),
        ...steps.slice((i + 1) * size),
      ];
      if (rest.length === 0) continue;
      tries += 1;
      console.log(
        `minimise: try ${String(tries)}, ${String(rest.length)} actions`,
      );
      if (await reproduces(args, rest, plan.rate, rules, artifacts, tries)) {
        steps = rest;
        n = Math.max(n - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (n >= steps.length) break;
      n = Math.min(steps.length, n * 2);
    }
  }
  // Each its own burst: a burst is what is recorded and checked.
  const minimal = { ...plan, steps: steps.map((s, i) => ({ ...s, burst: i })) };
  writeFileSync(
    join(artifacts, "minimal.json"),
    JSON.stringify(minimal, null, 1),
  );
  console.log(
    `minimise: ${String(steps.length)} actions after ${String(tries)} tries (minimal.json)`,
  );
}

/** The heap and DOM trend of a soak: the last fifth's median against the first fifth's. */
function trend(metrics) {
  const out = [];
  if (metrics.length < 10) return out;
  const fifth = Math.max(2, Math.floor(metrics.length / 5));
  const median = (list) => {
    const s = [...list].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  for (const name of [...Object.keys(PAGES), "pane"]) {
    for (const key of ["heap", "nodes"]) {
      const values = metrics
        .map((m) => m[name]?.[key])
        .filter((v) => v !== undefined);
      if (values.length < 10) continue;
      const first = median(values.slice(0, fifth));
      const last = median(values.slice(-fifth));
      const grew = last - first;
      const limit = key === "heap" ? 20_480 : 3000;
      const line = `${name} ${key}: ${String(first)} → ${String(last)}${key === "heap" ? " KiB" : " nodes"}`;
      out.push({ line, bad: grew > limit && last > first * 1.5 });
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.DISPLAY && process.platform === "linux")
    throw new Error(
      "no DISPLAY: run test/stability/chaos.sh, which starts Xvfb",
    );
  const artifacts =
    process.env.DEVHUB_STABILITY_ARTIFACTS ??
    join(appDir, "..", "..", ".spike", "chaos");
  mkdirSync(artifacts, { recursive: true });
  if (args.replay) {
    const saved = JSON.parse(readFileSync(args.replay, "utf8"));
    const dir = join(artifacts, "replay");
    const { app, ctx } = await launch(args, dir);
    let result;
    try {
      result = await runPlan(ctx, saved.steps, saved.rate, dir, saved);
      console.log(
        result.failed
          ? `replay FAIL\n  ${result.problems.join("\n  ")}`
          : "replay ok",
      );
      process.exitCode = result.failed ? 1 : 0;
    } finally {
      app.stop();
    }
    if (result?.failed && args.minimise) {
      const failed = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
      await minimise(args, { ...failed, problems: result.problems }, dir);
    }
    return;
  }
  const started = Date.now();
  const deadline = args.minutes ? started + args.minutes * 60_000 : undefined;
  const failures = [];
  const metrics = [];
  let runs = 0;
  let { app, ctx } = await launch(args, artifacts);
  try {
    const seeds = [...args.seeds];
    for (
      let k = 0;
      k < seeds.length || (deadline && Date.now() < deadline);
      k++
    ) {
      if (deadline && Date.now() > deadline) break;
      // Past the seeds given, a soak goes on with the next ones.
      const seed =
        k < seeds.length
          ? seeds[k]
          : seeds[seeds.length - 1] + (k - seeds.length + 1);
      for (const rate of args.rates) {
        const steps = plan(seed, args.actions, args.only);
        const dir = join(artifacts, `seed-${String(seed)}-${String(rate)}x`);
        const t = Date.now();
        const result = await runPlan(ctx, steps, rate, dir, {
          seed,
          actions: args.actions,
          only: args.only,
          neovimDelay: args.neovimDelay,
        });
        runs += 1;
        metrics.push(...result.metrics.map((m) => ({ ...m, seed, rate })));
        console.log(
          `${result.failed ? "FAIL" : "ok  "} seed ${String(seed)} at ${String(rate)}x  (${String(steps.length)} actions, ${String(Math.round((Date.now() - t) / 1000))} s)`,
        );
        if (result.failed) {
          for (const p of result.problems.slice(0, 8)) console.log(`     ${p}`);
          console.log(`     artefacts in ${dir}`);
          failures.push({ seed, rate, dir, problems: result.problems });
          if (args.minimise) {
            app.stop();
            const saved = JSON.parse(
              readFileSync(join(dir, "plan.json"), "utf8"),
            );
            await minimise(args, { ...saved, problems: result.problems }, dir);
          } else {
            app.stop();
          }
          // A fresh DevHub for the next: nothing carried over from a fault.
          ({ app, ctx } = await launch(args, artifacts));
        }
      }
    }
  } finally {
    app.stop();
  }
  writeFileSync(
    join(artifacts, "metrics.csv"),
    ["seed,rate,t,burst,page,heapKiB,nodes"]
      .concat(
        metrics.flatMap((m) =>
          [...Object.keys(PAGES), "pane"]
            .filter((p) => m[p])
            .map((p) =>
              [m.seed, m.rate, m.t, m.burst, p, m[p].heap, m[p].nodes].join(
                ",",
              ),
            ),
        ),
      )
      .join("\n"),
  );
  const minutes = (Date.now() - started) / 60_000;
  if (minutes >= 10) {
    console.log("growth over the soak (median of the first fifth → the last):");
    for (const t of trend(metrics)) {
      console.log(`  ${t.bad ? "GREW" : "ok  "} ${t.line}`);
      if (t.bad)
        failures.push({ seed: "soak", problems: [`[growth] ${t.line}`] });
    }
  }
  console.log(
    `chaos: ${String(runs - failures.filter((f) => f.seed !== "soak").length)} of ${String(runs)} runs held, ${minutes.toFixed(1)} min${failures.length ? `; artefacts in ${artifacts}` : ""}`,
  );
  appendFileSync(
    join(artifacts, "results.txt"),
    `${JSON.stringify({ runs, failures }, null, 1)}\n`,
  );
  if (failures.length === 0) {
    // Passing runs keep nothing but their numbers.
    rmSync(join(artifacts, "app.log"), { force: true });
  }
  process.exitCode = failures.length ? 1 : 0;
}

await main();

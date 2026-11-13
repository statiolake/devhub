#!/usr/bin/env node
// How promptly the editor and the terminal answer the mouse, in the real app
// (`docs/neovim-editor.md`, "The pointer"): DevHub from this checkout under
// Xvfb, driven over the Chrome DevTools Protocol with real input events
// (`Input.dispatchMouseEvent`), each case timed from the event to the first
// frame whose state shows its answer, measured after every rAF callback of a
// frame and before it is painted.
//
//   node apps/desktop/test/pointer/latency.mjs [--delay MS] [--throttle N] [--trials N] [--json FILE]
//
// --delay MS    every round trip to Neovim made MS longer (the Neovim host's
//               DEVHUB_NEOVIM_DELAY_MS, `delayProxy.ts`): an SSH link's latency
// --throttle N  the page's CPU N times slower (Emulation.setCPUThrottlingRate)
//
// What the page shows at once, before Neovim or tmux answer (the caret at a
// click, a row's focus and hover, a border's band, DevHub's own terminal
// selection, the pointer's shape), has a threshold whatever the delay; what
// waits for them (Neovim's wheel from rest) is reported only.
// Exits 1 when a threshold is missed. Needs `pnpm --filter @devhub/desktop
// build` (out/ and dist/), Xvfb, and nothing else: the app runs on a profile
// of its own in a scratch directory, with a Neovim config of its own.
/* global console, fetch, setTimeout, WebSocket -- Node's, as `process` is */
import { spawn, execFileSync } from "node:child_process";
import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const NVIM = path.join(APP_DIR, "out/nvim/bin/nvim");
const TMUX = path.join(APP_DIR, "out/tmux/bin/tmux");

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const DELAY = Number(opt("--delay", "0"));
const THROTTLE = Number(opt("--throttle", "1"));
const TRIALS = Number(opt("--trials", "5"));
const JSON_OUT = opt("--json", undefined);
/** At once: within two frames of the event (a 60 Hz frame is 16.7 ms). */
const AT_ONCE_MS = 34 * THROTTLE;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  const s = xs.filter((x) => x !== undefined && x >= -50).sort((a, b) => a - b);
  return s.length === 0 ? undefined : s[Math.floor(s.length / 2)];
};

// --- the app ---------------------------------------------------------------
// Short: tmux's socket path has to fit in a socket address.
const STATE = fs.mkdtempSync(path.join("/tmp", "dh-ptr-"));
const PORT = 9400 + Math.floor(Math.random() * 400);
const DISPLAY_NUM = 150 + Math.floor(Math.random() * 400);
const children = [];
const env = {
  ...process.env,
  DEVHUB_PROFILE: "pointer",
  XDG_CONFIG_HOME: path.join(STATE, "config"),
  XDG_STATE_HOME: path.join(STATE, "state"),
  HOME: path.join(STATE, "home"),
  TMUX_TMPDIR: path.join(STATE, "tmux"),
  DISPLAY: `:${DISPLAY_NUM}`,
  DEVHUB_NEOVIM_DELAY_MS: String(DELAY),
};
for (const dir of ["config/nvim", "state", "home", "tmux"])
  fs.mkdirSync(path.join(STATE, dir), { recursive: true });
fs.writeFileSync(
  path.join(STATE, "config/nvim/init.lua"),
  "vim.o.number = true\nvim.o.wrap = false\nvim.o.mouse = 'a'\nvim.o.swapfile = false\n",
);
const SAMPLE = path.join(STATE, "sample.txt");
fs.writeFileSync(
  SAMPLE,
  Array.from(
    { length: 2000 },
    (_, i) =>
      `${String(i).padStart(4, "0")} ${"alpha beta gamma delta epsilon zeta eta theta"
        .split(" ")
        .slice(0, 3 + (i % 6))
        .join(" ")}`,
  ).join("\n") + "\n",
);

function cleanup() {
  for (const child of children.reverse()) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
  try {
    execFileSync(TMUX, ["-L", "devhub-pointer", "kill-server"], {
      env,
      stdio: "ignore",
    });
  } catch {
    /* none */
  }
  if (!args.includes("--keep"))
    fs.rmSync(STATE, { recursive: true, force: true });
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

const tmux = (...a) =>
  execFileSync(TMUX, ["-L", "devhub-pointer", ...a], { env, encoding: "utf8" });

async function launch() {
  const xvfb = spawn(
    "Xvfb",
    [`:${DISPLAY_NUM}`, "-screen", "0", "1600x1000x24"],
    {
      stdio: "ignore",
      detached: true,
    },
  );
  children.push(xvfb);
  await sleep(800);
  const app = spawn(
    path.join(APP_DIR, "scripts/dev.sh"),
    ["--no-sandbox", `--remote-debugging-port=${String(PORT)}`],
    {
      env,
      stdio: [
        "ignore",
        fs.openSync(path.join(STATE, "app.log"), "w"),
        fs.openSync(path.join(STATE, "app.log"), "a"),
      ],
      detached: true,
    },
  );
  children.push(app);
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (
        await fetch(`http://127.0.0.1:${String(PORT)}/json`)
      ).json();
      if (list.some((t) => t.url.includes("pane.html"))) return;
    } catch {
      /* not yet */
    }
    await sleep(250);
  }
  throw new Error(`the app did not start (${path.join(STATE, "app.log")})`);
}

// --- CDP and the probe -----------------------------------------------------
const PROBE = `(() => {
  window.__probe?.stop?.();
  const dummy = document.createElement('div');
  dummy.style.cssText = 'position:fixed;left:-50px;top:-50px;width:1px;height:1px;pointer-events:none';
  document.body.appendChild(dummy);
  let armed, tick = 0, frameTime = 0, looping = false, stopped = false;
  // After every rAF callback of the frame, before it is painted.
  const ro = new ResizeObserver(() => {
    if (!armed) return;
    const a = armed;
    a.frames += 1;
    let ok = false;
    try { ok = a.pred(); } catch (e) { ok = true; a.error = String(e); }
    if (ok) { armed = undefined; a.resolve({ ms: frameTime - a.t0, frames: a.frames, error: a.error }); }
    else if (frameTime - a.t0 > a.timeout) { armed = undefined; a.resolve({ ms: undefined, frames: a.frames }); }
  });
  ro.observe(dummy);
  const loop = (t) => {
    frameTime = t;
    if (!armed || stopped) { looping = false; return; }
    tick ^= 1; dummy.style.width = tick ? '2px' : '1px';
    requestAnimationFrame(loop);
  };
  const pixel = (x, y) => {
    for (const el of document.querySelectorAll('.control-sash, .nvim-sash')) {
      const r = el.getBoundingClientRect();
      if (x >= r.left && x < r.right && y >= r.top && y < r.bottom && getComputedStyle(el).opacity !== '0') return 'sash';
    }
    for (const el of document.elementsFromPoint(x, y)) {
      if (el instanceof HTMLCanvasElement) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const d = el.getContext('2d')?.getImageData(Math.floor((x - r.left) * el.width / r.width), Math.floor((y - r.top) * el.height / r.height), 1, 1).data;
        if (!d || d[3] === 0) continue;
        return d[0] + ',' + d[1] + ',' + d[2];
      }
    }
    return 'none';
  };
  window.__probe = {
    stop() { stopped = true; ro.disconnect(); dummy.remove(); },
    pixel,
    strip: (x, y0, y1) => { let s = ''; for (let y = y0; y < y1; y += 2) s += pixel(x, y) + ';'; return s; },
    caretAt: (x, y) => { const c = document.querySelector('.nvim-cursor'); if (!c || c.style.display === 'none') return false; const r = c.getBoundingClientRect(); return x >= r.left - 0.5 && x < r.right + 0.5 && y >= r.top - 0.5 && y < r.bottom + 0.5; },
    cursorAt: (x, y) => { const el = document.elementFromPoint(x, y); return el ? getComputedStyle(el).cursor : 'none'; },
    bgAt: (x, y) => { const el = document.elementFromPoint(x, y)?.closest('.nvim-view-item'); return el ? getComputedStyle(el).backgroundColor : 'none'; },
    arm(type, src, timeout) {
      const fn = new Function('P', 'return (' + src + ')');
      return new Promise((resolve) => {
        const on = (e) => {
          window.removeEventListener(type, on, true);
          armed = { pred: () => fn(window.__probe), resolve, t0: e.timeStamp, frames: 0, timeout };
          if (!looping) { looping = true; requestAnimationFrame(loop); }
        };
        window.addEventListener(type, on, true);
      });
    },
  };
})()`;

async function connect() {
  const list = await (
    await fetch(`http://127.0.0.1:${String(PORT)}/json`)
  ).json();
  const t = list.find((x) => x.type === "page" && x.url.includes("pane.html"));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.result?.exceptionDetails)
      throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result?.result?.value;
  };
  await ev(PROBE);
  const mouse = (type, x, y, o = {}) =>
    send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button:
        o.button ?? (type === "mouseMoved" && !o.buttons ? "none" : "left"),
      buttons: o.buttons ?? (type === "mousePressed" ? 1 : 0),
      clickCount: o.clickCount ?? (type === "mouseMoved" ? 0 : 1),
    });
  const wheel = (x, y, deltaY) =>
    send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX: 0,
      deltaY,
    });
  const measure = async (type, pred, act, timeout = 3000) => {
    const key = `__m${String(Math.random()).slice(2)}`;
    await ev(
      `window.${key} = window.__probe.arm(${JSON.stringify(type)}, ${JSON.stringify(pred)}, ${String(timeout)}); 1`,
    );
    await act();
    return ev(`window.${key}`);
  };
  return { send, ev, mouse, wheel, measure, close: () => ws.close() };
}

// --- Neovim, through its own socket -----------------------------------------
let SOCKET;
const nlua = (code) => {
  const file = path.join(STATE, "cmd.lua");
  fs.writeFileSync(file, code);
  return execFileSync(
    NVIM,
    ["--server", SOCKET, "--remote-expr", `luaeval('dofile("${file}")')`],
    {
      encoding: "utf8",
    },
  ).trim();
};
const wins = () =>
  JSON.parse(
    nlua(`local out = {}
for _, w in ipairs(vim.fn.getwininfo()) do
  if vim.api.nvim_win_get_config(w.winid).relative == '' then
    table.insert(out, { id = w.winid, row = w.winrow - 1, col = w.wincol - 1, width = w.width, height = w.height, textoff = w.textoff, view = vim.b[w.bufnr].latency_view == true })
  end
end
return vim.json.encode(out)`),
  );

// --- the cases -------------------------------------------------------------
async function main() {
  await launch();
  await sleep(2500);
  const pane = tmux("list-panes", "-a", "-F", "#{session_name} #{pane_id}")
    .split("\n")
    .find((l) => l.startsWith("ws-"))
    ?.split(" ")[1];
  if (!pane) throw new Error("no Workspace terminal");
  tmux(
    "split-window",
    "-h",
    "-l",
    "40",
    "-t",
    pane,
    `bash --norc --noprofile -c 'for i in $(seq 1 300); do echo "line $i lorem ipsum dolor sit amet"; done; exec cat'`,
  );
  await sleep(500);
  tmux("send-keys", "-t", pane, `nvim ${SAMPLE}`, "Enter");
  for (let i = 0; i < 60 && !SOCKET; i++) {
    await sleep(250);
    SOCKET = tmux("show-options", "-p", "-t", pane).match(
      /@devhub-nvim (\S+)/,
    )?.[1];
  }
  if (!SOCKET) throw new Error("no Neovim in the pane");
  await sleep(1500);
  // A view (a native list, as nvim-tree-ui's) on the left, two windows of
  // the sample on the right.
  nlua(`vim.cmd('vsplit')
local buf = vim.api.nvim_create_buf(false, true)
local lines = {}
for i = 1, 300 do lines[i] = 'row ' .. i end
vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
vim.b[buf].latency_view = true
_G.latency_view = require('devhub_gui').view{ buf = buf, win = 'vsplit', row_height = 22,
  items = function(_, line) return { type = 'text', text = line } end }
vim.cmd('wincmd l')
return 1`);
  await sleep(1500);
  const c = await connect();
  if (THROTTLE !== 1)
    await c.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
  const geo = await c.ev(
    `(() => { const r = document.querySelector('.nvim-host').getBoundingClientRect(); const cur = document.querySelector('.nvim-cursor').getBoundingClientRect(); return { x: r.left, y: r.top, h: cur.height }; })()`,
  );
  const cols = Number(nlua("return vim.o.columns"));
  const hostW = await c.ev(
    `document.querySelector('.nvim-host').getBoundingClientRect().width`,
  );
  const CW = hostW / cols;
  const CH = geo.h;
  const px = (row, col) => ({
    x: geo.x + col * CW + CW / 2,
    y: geo.y + row * CH + CH / 2,
  });
  const results = [];
  const run = async (name, kind, fn) => {
    const ms = [];
    const notes = new Set();
    for (let i = 0; i < TRIALS; i++) {
      let r;
      try {
        r = await fn(i);
      } catch (e) {
        r = { ms: undefined, note: String(e).slice(0, 100) };
      }
      ms.push(r.ms);
      if (r.note) notes.add(r.note);
      await sleep(300);
    }
    const m = median(ms);
    const ok =
      kind === "report" ||
      (m !== undefined && m <= AT_ONCE_MS && notes.size === 0);
    results.push({
      name,
      kind,
      ms: m === undefined ? null : Math.max(0, Math.round(m * 10) / 10),
      all: ms,
      notes: [...notes],
      ok,
    });
    console.log(
      `${ok ? "ok  " : "FAIL"} ${name.padEnd(20)} ${m === undefined ? "  none" : `${Math.max(0, m).toFixed(1).padStart(6)} ms`}  ${kind === "report" ? "(waits for Neovim/tmux: reported)" : `(at once: <= ${String(AT_ONCE_MS)} ms)`} ${[...notes].join("; ")}`,
    );
  };
  const editWins = () => wins().filter((w) => !w.view);
  const viewRows = () =>
    c.ev(
      `[...document.querySelectorAll('.nvim-view-item')].map((e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: r.height, line: +e.dataset.line, focused: e.classList.contains('nvim-view-focused') }; }).filter((r) => r.y > 40 && r.y < innerHeight - 60)`,
    );
  const shell = () => {
    const l = tmux(
      "list-panes",
      "-a",
      "-F",
      "#{session_name} #{pane_id} #{pane_left} #{pane_top} #{pane_current_command}",
    )
      .split("\n")
      .find((x) => x.startsWith("ws-") && !x.endsWith("nvim"));
    const [, id, x, y] = l.split(" ");
    return { id, x: Number(x), y: Number(y) };
  };
  const click = async (p) => {
    await c.mouse("mousePressed", p.x, p.y);
    await c.mouse("mouseReleased", p.x, p.y);
  };
  const esc = () => nlua(`vim.api.nvim_input('<Esc>') return 1`);

  await run("click caret", "at-once", async (i) => {
    esc();
    const w = editWins()[1];
    const p = px(w.row + 4 + i * 5, w.col + w.textoff + 6 + i);
    return c.measure("mousedown", `P.caretAt(${p.x},${p.y})`, () => click(p));
  });
  await run("click other window", "at-once", async (i) => {
    esc();
    const [a, b] = editWins();
    nlua(
      `vim.api.nvim_set_current_win(${String((i % 2 ? b : a).id)}) return 1`,
    );
    await sleep(200);
    const w = i % 2 ? a : b;
    const p = px(w.row + 8 + i, w.col + w.textoff + 3);
    return c.measure("mousedown", `P.caretAt(${p.x},${p.y})`, () => click(p));
  });
  await run("click list row", "at-once", async (i) => {
    const rows = (await viewRows()).filter((r) => !r.focused);
    const r = rows[3 + i * 2];
    return c.measure(
      "mousedown",
      `[...document.querySelectorAll('.nvim-view-item')].find((e) => +e.dataset.line === ${String(r.line)})?.classList.contains('nvim-view-focused')`,
      () => click(r),
    );
  });
  await run("hover list row", "at-once", async (i) => {
    const rows = (await viewRows()).filter((r) => !r.focused);
    const r = rows[6 + i];
    await c.mouse("mouseMoved", r.x, r.y - r.h * 3);
    await sleep(100);
    const base = await c.ev(`__probe.bgAt(${String(r.x)},${String(r.y)})`);
    return c.measure(
      "mousemove",
      `P.bgAt(${String(r.x)},${String(r.y)}) !== ${JSON.stringify(base)}`,
      () => c.mouse("mouseMoved", r.x, r.y),
      500,
    );
  });
  await run("drag window border", "at-once", async (i) => {
    esc();
    const w = editWins()[0];
    const col = w.col + w.width;
    const a = px(w.row + 20, col);
    const to = col + (i % 2 ? 4 : -4);
    const b = px(w.row + 20, to);
    await c.mouse("mouseMoved", a.x, a.y);
    await sleep(80);
    await c.mouse("mousePressed", a.x, a.y);
    await sleep(100);
    const q = px(w.row + 30, to);
    const base = await c.ev(
      `__probe.strip(${String(q.x)},${String(q.y - 30)},${String(q.y + 30)})`,
    );
    const r = await c.measure(
      "mousemove",
      `P.strip(${String(q.x)},${String(q.y - 30)},${String(q.y + 30)}) !== ${JSON.stringify(base)}`,
      () => c.mouse("mouseMoved", b.x, b.y, { buttons: 1 }),
    );
    await c.mouse("mouseReleased", b.x, b.y);
    await sleep(400 + DELAY * 2);
    const after = editWins()[0];
    return {
      ...r,
      note:
        after.col + after.width === to
          ? undefined
          : `the border is at ${String(after.col + after.width)}, not ${String(to)}`,
    };
  });
  await run("drag pane boundary", "at-once", async (i) => {
    const s = shell();
    const col = s.x - 1;
    const a = px(s.y + 20, col);
    const to = col + (i % 2 ? 3 : -3);
    const b = px(s.y + 20, to);
    await c.mouse("mousePressed", a.x, a.y);
    await sleep(100);
    const q = px(s.y + 30, to);
    const base = await c.ev(
      `__probe.strip(${String(q.x)},${String(q.y - 30)},${String(q.y + 30)})`,
    );
    const r = await c.measure(
      "mousemove",
      `P.strip(${String(q.x)},${String(q.y - 30)},${String(q.y + 30)}) !== ${JSON.stringify(base)}`,
      () => c.mouse("mouseMoved", b.x, b.y, { buttons: 1 }),
    );
    await c.mouse("mouseReleased", b.x, b.y);
    await sleep(500);
    return r;
  });
  await run("drag terminal select", "at-once", async (i) => {
    const s = shell();
    const a = px(s.y + 5 + i * 3, s.x + 2);
    const b = px(s.y + 7 + i * 3, s.x + 10);
    const mid = px(s.y + 6 + i * 3, s.x + 4);
    await c.mouse("mousePressed", a.x, a.y);
    await sleep(100);
    const base = await c.ev(
      `__probe.pixel(${String(mid.x - 3)},${String(mid.y - 6)})`,
    );
    const r = await c.measure(
      "mousemove",
      `P.pixel(${String(mid.x - 3)},${String(mid.y - 6)}) !== ${JSON.stringify(base)}`,
      () => c.mouse("mouseMoved", b.x, b.y, { buttons: 1 }),
    );
    await c.mouse("mouseReleased", b.x, b.y);
    return r;
  });
  await run("pointer shapes", "at-once", async () => {
    const w = editWins()[0];
    const s = shell();
    const rows = await viewRows();
    const text = px(w.row + 3, w.col + w.textoff + 2);
    const term = px(s.y + 3, s.x + 3);
    await c.mouse("mouseMoved", text.x, text.y);
    await sleep(50);
    const want = {
      text: "text",
      row: "default",
      terminal: "text",
      border: "col-resize",
    };
    const got = {
      text: await c.ev(`__probe.cursorAt(${String(text.x)},${String(text.y)})`),
      row: await c.ev(
        `__probe.cursorAt(${String(rows[2].x)},${String(rows[2].y)})`,
      ),
      terminal: await c.ev(
        `__probe.cursorAt(${String(term.x)},${String(term.y)})`,
      ),
    };
    const border = px(w.row + 3, w.col + w.width);
    await c.mouse("mouseMoved", border.x, border.y);
    await sleep(80);
    got.border = await c.ev(
      `__probe.cursorAt(${String(border.x)},${String(border.y)})`,
    );
    const wrong = Object.keys(want).filter((k) => want[k] !== got[k]);
    return {
      ms: 0,
      note: wrong.length
        ? `wrong: ${wrong.map((k) => `${k} ${String(got[k])}`).join(", ")}`
        : undefined,
    };
  });
  await run("wheel in Neovim", "report", async () => {
    const w = editWins()[0];
    nlua(
      `vim.api.nvim_win_call(${String(w.id)}, function() vim.cmd('normal! 300Gzt') end) return 1`,
    );
    await sleep(300);
    const p = px(w.row + 10, w.col + w.textoff + 3);
    const base = await c.ev(
      `__probe.strip(${String(p.x)},${String(p.y)},${String(p.y + 60)})`,
    );
    return c.measure(
      "wheel",
      `P.strip(${String(p.x)},${String(p.y)},${String(p.y + 60)}) !== ${JSON.stringify(base)}`,
      () => c.wheel(p.x, p.y, 40),
    );
  });
  await run("drag Visual band", "at-once", async (i) => {
    esc();
    const w = editWins()[1];
    const a = px(w.row + 10 + i * 6, w.col + w.textoff + 2);
    const b = px(w.row + 12 + i * 6, w.col + w.textoff + 4);
    const mid = px(w.row + 11 + i * 6, w.col + w.textoff + 1);
    await c.mouse("mousePressed", a.x, a.y);
    await sleep(150 + DELAY);
    const base = await c.ev(
      `__probe.pixel(${String(mid.x - 3)},${String(mid.y - 6)})`,
    );
    const r = await c.measure(
      "mousemove",
      `P.pixel(${String(mid.x - 3)},${String(mid.y - 6)}) !== ${JSON.stringify(base)}`,
      () => c.mouse("mouseMoved", b.x, b.y, { buttons: 1 }),
    );
    await c.mouse("mouseReleased", b.x, b.y);
    return r;
  });
  c.close();
  if (JSON_OUT)
    fs.writeFileSync(
      JSON_OUT,
      JSON.stringify({ delay: DELAY, throttle: THROTTLE, results }, null, 1),
    );
  const failed = results.filter((r) => !r.ok);
  console.log(
    failed.length === 0
      ? "every pointer answer is at once"
      : `${String(failed.length)} missed`,
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 2;
  })
  .finally(() => process.exit());

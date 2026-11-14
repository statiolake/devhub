// The pointer's answers, timed (docs/neovim-editor.md, "The pointer"): in
// the stability harness's app, each case's input given through CDP's Input
// domain and timed from the event to the first frame whose state shows its
// answer (read after the frame's rAF callbacks, before it is painted). What
// the page shows at once, before Neovim or tmux answer — a click's caret, a
// drag's Visual band, a list row's focus and hover, a completion row's band,
// a border's sash, DevHub's terminal selection, the pointer's shapes — must
// answer within two frames of the CPU rate (34 ms at 1x); what waits for
// Neovim (its wheel from rest) is reported.
//
// run.mjs runs it as the scenario `pointer` (`--only pointer`), at each rate;
// POINTER_ONLY (names, by a comma) and POINTER_TRIALS narrow it. The wheel
// goes first: what a completion leaves behind (blink's, the buffer's undo)
// slows Neovim's next scroll by a frame, whatever the page.
// With DEVHUB_NEOVIM_DELAY_MS set, the app reaches Neovim over a slow link
// (`delayProxy.ts`): every answer that is at once must still be.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TRIALS = Number(process.env.POINTER_TRIALS ?? 3);

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

const median = (xs) => {
  const s = xs
    .filter((x) => x !== undefined && x !== null)
    .sort((a, b) => a - b);
  return s.length === 0 ? undefined : s[Math.floor(s.length / 2)];
};

/** Lines of words for the buffer source to complete, the same every run. */
function sampleText() {
  const words =
    "alpha alphabet alpine beta gamma delta epsilon zeta eta theta".split(" ");
  return Array.from(
    { length: 400 },
    (_, i) =>
      `${String(i).padStart(4, "0")} ${words.slice(0, 3 + (i % 7)).join(" ")}`,
  ).join("\n");
}

/** Run the pointer's cases at `rate`: results as run.mjs keeps them. */
export async function runPointer(ctx, rate) {
  const client = await ctx.page("pane");
  await client.eval(PROBE);
  const mouse = (type, x, y, o = {}) =>
    client.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button:
        o.button ?? (type === "mouseMoved" && !o.buttons ? "none" : "left"),
      buttons: o.buttons ?? (type === "mousePressed" ? 1 : 0),
      clickCount: o.clickCount ?? (type === "mouseMoved" ? 0 : 1),
    });
  const wheel = (x, y, deltaY) =>
    client.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX: 0,
      deltaY,
    });
  const measure = async (type, pred, act, timeout = 3000 * rate) => {
    const key = `__m${String(Math.random()).slice(2)}`;
    await client.eval(
      `window.${key} = window.__probe.arm(${JSON.stringify(type)}, ${JSON.stringify(pred)}, ${String(timeout)}); 1`,
    );
    await act();
    return client.eval(`window.${key}`);
  };
  const ev = (e) => client.eval(e);
  const lua = (code) => ctx.lua(code).trim();
  const json = (code) => JSON.parse(lua(code));
  const esc = () => lua(`vim.api.nvim_input('<Esc>') return 1`);
  const atOnce = 34 * rate;

  // The world: the sample in two windows, nvim-tree expanded beside them
  // (a native list of hundreds of rows), and a shell pane beside Neovim.
  const sample = `${ctx.paths.root}/pointer-sample.txt`;
  (await import("node:fs")).writeFileSync(sample, `${sampleText()}\n`);
  ctx.nvimSend("<C-\\><C-n><Esc>");
  lua(`vim.cmd('silent! only | silent! NvimTreeClose')
vim.cmd('edit! ' .. vim.fn.fnameescape(${JSON.stringify(sample)}))
vim.wo.wrap = false
vim.cmd('vsplit')
vim.cmd('NvimTreeOpen')
local w = vim.fn.bufwinid('NvimTree_1')
vim.api.nvim_win_set_cursor(w, { 1, 0 })
vim.api.nvim_win_call(w, function() require('nvim-tree.api').tree.expand_all() end)
vim.cmd('wincmd l')
return 1`);
  const nvimPane = ctx.app
    .tmux("list-panes", "-a", "-F", "#{pane_id} #{@devhub-nvim}")
    .split("\n")
    .find((l) => l.trim().split(" ")[1])
    ?.split(" ")[0];
  const shellPane = ctx.app
    .tmux(
      "split-window",
      "-P",
      "-F",
      "#{pane_id}",
      "-h",
      "-d",
      "-l",
      "36",
      "-t",
      nvimPane,
      `sh -c 'i=0; while [ $i -lt 200 ]; do i=$((i+1)); echo "line $i lorem ipsum dolor sit"; done; exec cat'`,
    )
    .trim();
  await sleep(1500);
  await ctx.settle("pane");
  await client.send("Emulation.setCPUThrottlingRate", { rate });

  const geo = await ev(`(() => {
    const host = document.querySelector('.nvim-host').getBoundingClientRect();
    const cur = document.querySelector('.nvim-cursor').getBoundingClientRect();
    return { x: host.left, y: host.top, w: host.width, h: cur.height };
  })()`);
  const cols = Number(lua("return vim.o.columns"));
  const CW = geo.w / cols;
  const CH = geo.h;
  const px = (row, col) => ({
    x: geo.x + col * CW + CW / 2,
    y: geo.y + row * CH + CH / 2,
  });
  const editWins = () =>
    json(`local out = {}
for _, w in ipairs(vim.fn.getwininfo()) do
  local b = vim.api.nvim_win_get_buf(w.winid)
  if vim.api.nvim_win_get_config(w.winid).relative == '' and vim.bo[b].filetype ~= 'NvimTree' then
    table.insert(out, { id = w.winid, row = w.winrow - 1, col = w.wincol - 1, width = w.width, textoff = w.textoff })
  end
end
return vim.json.encode(out)`);
  const shell = () => {
    const line = ctx.app
      .tmux(
        "list-panes",
        "-t",
        nvimPane,
        "-F",
        "#{pane_id} #{pane_left} #{pane_top} #{pane_current_command}",
      )
      .split("\n")
      .find((l) => l.endsWith(" cat"));
    const [, x, y] = line.split(" ");
    return { x: Number(x), y: Number(y) };
  };
  const viewRows = () =>
    ev(
      `[...document.querySelectorAll('.nvim-view-item')].map((e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: r.height, line: +e.dataset.line, focused: e.classList.contains('nvim-view-focused'), sticky: e.classList.contains('nvim-view-sticky') }; }).filter((r) => !r.sticky && r.y > 60 && r.y < innerHeight - 80)`,
    );
  const click = async (p) => {
    await mouse("mousePressed", p.x, p.y);
    await mouse("mouseReleased", p.x, p.y);
  };

  const results = [];
  // `at-once`: within two frames; `report`: timed only; `checked`: timed,
  // and what it notes is a failure.
  const run = async (name, kind, fn) => {
    if (
      process.env.POINTER_ONLY &&
      !process.env.POINTER_ONLY.split(",").some((n) => name.includes(n))
    )
      return;
    const ms = [];
    const notes = new Set();
    const started = Date.now();
    for (let i = 0; i < TRIALS; i++) {
      let r;
      try {
        r = await fn(i);
      } catch (error) {
        r = {
          ms: undefined,
          note: String(error.message ?? error).slice(0, 120),
        };
      }
      ms.push(r.ms === undefined ? undefined : Math.max(0, r.ms));
      if (r.note) notes.add(r.note);
      await sleep(300);
    }
    const m = median(ms);
    const late =
      (kind === "at-once" && (m === undefined || m > atOnce)) ||
      (kind === "checked" && m === undefined);
    const problems = [
      ...notes,
      ...(late
        ? [
            `${m === undefined ? "no answer" : `${m.toFixed(1)} ms`} after the event, more than two frames (${String(atOnce)} ms): ${JSON.stringify(ms)}`,
          ]
        : []),
    ];
    results.push({
      scenario: "pointer",
      step: name,
      rate,
      ok: kind === "report" || problems.length === 0,
      ms: Date.now() - started,
      frames: 0,
      shots: 0,
      answer: m === undefined ? null : Math.round(m * 10) / 10,
      problems: kind === "report" ? [] : problems,
      known:
        kind !== "at-once"
          ? [
              `reported, waits for Neovim: ${m === undefined ? "no answer" : `${m.toFixed(1)} ms`}`,
            ]
          : [],
    });
  };

  try {
    await run("wheel in Neovim", "report", async () => {
      esc();
      const w = editWins()[0];
      lua(
        `vim.api.nvim_win_call(${String(w.id)}, function() vim.cmd('normal! 200Gzt') end) return 1`,
      );
      await sleep(300 * rate);
      const p = px(w.row + 10, w.col + w.textoff + 3);
      // The pointer there first, settled: the wheel alone is timed, not the
      // pointer leaving a border's resize arrows for the text.
      await mouse("mouseMoved", p.x, p.y);
      await sleep(300 * rate);
      const base = await ev(
        `__probe.strip(${String(p.x)},${String(p.y)},${String(p.y + 60)})`,
      );
      return measure(
        "wheel",
        `P.strip(${String(p.x)},${String(p.y)},${String(p.y + 60)}) !== ${JSON.stringify(base)}`,
        () => wheel(p.x, p.y, 40),
      );
    });
    await run("click caret", "at-once", async (i) => {
      esc();
      const w = editWins()[1];
      const p = px(w.row + 4 + i * 5, w.col + w.textoff + 6 + i);
      return measure("mousedown", `P.caretAt(${p.x},${p.y})`, () => click(p));
    });
    await run("click other window", "at-once", async (i) => {
      esc();
      const [a, b] = editWins();
      lua(
        `vim.api.nvim_set_current_win(${String((i % 2 ? b : a).id)}) return 1`,
      );
      await sleep(200 * rate);
      const w = i % 2 ? a : b;
      const p = px(w.row + 8 + i, w.col + w.textoff + 3);
      return measure("mousedown", `P.caretAt(${p.x},${p.y})`, () => click(p));
    });
    await run("click tree row", "at-once", async (i) => {
      const rows = (await viewRows()).filter((r) => !r.focused);
      const r = rows[3 + i * 2];
      return measure(
        "mousedown",
        `[...document.querySelectorAll('.nvim-view-item')].find((e) => +e.dataset.line === ${String(r.line)})?.classList.contains('nvim-view-focused')`,
        () => click(r),
      );
    });
    await run("hover tree row", "at-once", async (i) => {
      const rows = (await viewRows()).filter((r) => !r.focused);
      const r = rows[6 + i];
      await mouse("mouseMoved", r.x, r.y - r.h * 3);
      await sleep(100 * rate);
      const q = `getComputedStyle([...document.querySelectorAll('.nvim-view-item')].find((e) => +e.dataset.line === ${String(r.line)})).backgroundColor`;
      const base = await ev(q);
      return measure(
        "mousemove",
        `${q} !== ${JSON.stringify(base)}`,
        () => mouse("mouseMoved", r.x, r.y),
        600 * rate,
      );
    });
    await run("drag window border", "at-once", async (i) => {
      esc();
      const w = editWins()[0];
      const col = w.col + w.width;
      const a = px(w.row + 20, col);
      const to = col + (i % 2 ? 4 : -4);
      const b = px(w.row + 20, to);
      await mouse("mouseMoved", a.x, a.y);
      await sleep(80);
      await mouse("mousePressed", a.x, a.y);
      await sleep(100);
      const q = px(w.row + 30, to);
      const base = await ev(
        `__probe.strip(${String(q.x)},${String(q.y - 30)},${String(q.y + 30)})`,
      );
      const r = await measure(
        "mousemove",
        `P.strip(${String(q.x)},${String(q.y - 30)},${String(q.y + 30)}) !== ${JSON.stringify(base)}`,
        () => mouse("mouseMoved", b.x, b.y, { buttons: 1 }),
      );
      await mouse("mouseReleased", b.x, b.y);
      await sleep(500 * rate);
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
      await mouse("mousePressed", a.x, a.y);
      await sleep(100);
      const q = px(s.y + 30, to);
      const base = await ev(
        `__probe.strip(${String(q.x)},${String(q.y - 30)},${String(q.y + 30)})`,
      );
      const r = await measure(
        "mousemove",
        `P.strip(${String(q.x)},${String(q.y - 30)},${String(q.y + 30)}) !== ${JSON.stringify(base)}`,
        () => mouse("mouseMoved", b.x, b.y, { buttons: 1 }),
      );
      await mouse("mouseReleased", b.x, b.y);
      await sleep(600 * rate);
      return r;
    });
    await run("drag terminal select", "at-once", async (i) => {
      const s = shell();
      const a = px(s.y + 5 + i * 3, s.x + 2);
      const b = px(s.y + 7 + i * 3, s.x + 10);
      const mid = px(s.y + 6 + i * 3, s.x + 4);
      await mouse("mousePressed", a.x, a.y);
      await sleep(100);
      const base = await ev(
        `__probe.pixel(${String(mid.x - 3)},${String(mid.y - 6)})`,
      );
      const r = await measure(
        "mousemove",
        `P.pixel(${String(mid.x - 3)},${String(mid.y - 6)}) !== ${JSON.stringify(base)}`,
        () => mouse("mouseMoved", b.x, b.y, { buttons: 1 }),
      );
      await mouse("mouseReleased", b.x, b.y);
      return r;
    });
    await run("drag Visual band", "at-once", async (i) => {
      esc();
      const w = editWins()[1];
      const a = px(w.row + 10 + i * 6, w.col + w.textoff + 2);
      const b = px(w.row + 12 + i * 6, w.col + w.textoff + 4);
      const mid = px(w.row + 11 + i * 6, w.col + w.textoff + 1);
      await mouse("mouseMoved", a.x, a.y);
      await mouse("mousePressed", a.x, a.y);
      await sleep(300 * rate);
      const base = await ev(
        `__probe.pixel(${String(mid.x - 3)},${String(mid.y - 6)})`,
      );
      const r = await measure(
        "mousemove",
        `P.pixel(${String(mid.x - 3)},${String(mid.y - 6)}) !== ${JSON.stringify(base)}`,
        () => mouse("mouseMoved", b.x, b.y, { buttons: 1 }),
      );
      await mouse("mouseReleased", b.x, b.y);
      return r;
    });
    await run("click completion row", "at-once", async (i) => {
      esc();
      const w = editWins()[1];
      lua(
        `vim.api.nvim_set_current_win(${String(w.id)}) vim.api.nvim_win_set_cursor(0, { ${String(30 + i)}, 0 }) return 1`,
      );
      ctx.nvimSend("oalp");
      await ctx.waitIn(
        "pane",
        "document.querySelectorAll('.nvim-popup .nvc-banded > [data-action]').length >= 3",
        10_000 * rate,
      );
      await sleep(300 * rate);
      const rows = await ev(
        `[...document.querySelectorAll('.nvim-popup .nvc-banded > [data-action]')].map((e, i) => { const r = e.getBoundingClientRect(); return { i: i + 1, x: r.left + r.width / 2, y: r.top + r.height / 2, sel: e.classList.contains('nvc-selected') }; })`,
      );
      const r = rows.find((row) => !row.sel && row.i >= 2);
      const band = `document.querySelector('.nvim-popup .nvc-band').getBoundingClientRect().top`;
      const before = await ev(band);
      const out = await measure(
        "mousedown",
        `${band} !== ${String(before)} && document.querySelector('.nvim-popup .nvc-banded').children[${String(r.i)}].classList.contains('nvc-selected')`,
        () => click(r),
      );
      await sleep(400 * rate);
      const selected = Number(
        lua(`return require('blink.cmp').get_selected_item_idx() or 0`),
      );
      ctx.nvimSend("<C-e><Esc>u");
      await sleep(200 * rate);
      return {
        ...out,
        note:
          selected === r.i
            ? undefined
            : `blink selected ${String(selected)}, not ${String(r.i)}`,
      };
    });
    await run("pointer shapes", "at-once", async () => {
      esc();
      const w = editWins()[0];
      const s = shell();
      const rows = await viewRows();
      const text = px(w.row + 3, w.col + w.textoff + 2);
      const term = px(s.y + 3, s.x + 3);
      const border = px(w.row + 3, w.col + w.width);
      const want = {
        text: "text",
        row: "default",
        terminal: "text",
        border: "col-resize",
      };
      const at = { text, row: rows[2], terminal: term, border };
      const got = {};
      for (const key of Object.keys(want)) {
        const p = at[key];
        for (let k = 0; k < 6; k++) {
          await mouse("mouseMoved", p.x, p.y);
          await sleep(150 * rate);
          got[key] = await ev(
            `__probe.cursorAt(${String(p.x)},${String(p.y)})`,
          );
          if (got[key] === want[key]) break;
        }
      }
      const wrong = Object.keys(want).filter((k) => want[k] !== got[k]);
      return {
        ms: 0,
        note: wrong.length
          ? `wrong shapes: ${(
              await Promise.all(
                wrong.map(
                  async (k) =>
                    `${k} ${String(got[k])} over ${String(await ev(`document.elementsFromPoint(${String(at[k].x)},${String(at[k].y)}).slice(0,5).map((e) => e.className + "/" + e.style.zIndex + "/" + getComputedStyle(e).pointerEvents).join(" < ")`))}`,
                ),
              )
            ).join(", ")}`
          : undefined,
      };
    });
    await definitionCases({
      ctx,
      client,
      run,
      measure,
      mouse,
      ev,
      lua,
      json,
      esc,
      editWins,
      px,
      rate,
    });
  } finally {
    await client.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    ctx.nvimSend("<C-\\><C-n><Esc>");
    try {
      ctx.app.tmux("kill-pane", "-t", shellPane);
    } catch {
      // gone already
    }
    lua(`vim.cmd('silent! NvimTreeClose | silent! only') return 1`);
    await sleep(500);
  }
  return results;
}

/** A small Lua file whose words the fake server defines (`fake-lsp.mjs`). */
const DEF_SAMPLE = `local function greet(name)
  return 'hello ' .. name
end

local message = greet('world')
print(message)
`;

/**
 * Go to definition with the pointer (docs/neovim-editor.md, "Go to
 * definition with the pointer"): Alt held over `greet` draws it as a link
 * once Neovim has answered (reported: a round trip and an LSP request), the
 * link goes in the frame Alt goes up (at once, one frame), and Alt-click
 * jumps — Neovim's cursor on the definition, no Visual, `<C-o>` back.
 */
async function definitionCases(t) {
  const {
    ctx,
    client,
    run,
    measure,
    mouse,
    ev,
    lua,
    json,
    esc,
    editWins,
    px,
    rate,
  } = t;
  const { writeFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const file = `${ctx.paths.root}/pointer-def.lua`;
  writeFileSync(file, DEF_SAMPLE);
  const server = fileURLToPath(
    new URL("./fixture/fake-lsp.mjs", import.meta.url),
  );
  esc();
  lua(`vim.cmd('silent! NvimTreeClose | silent! only') return 1`);
  await new Promise((r) => setTimeout(r, 300 * rate));
  const w = editWins()[0];
  lua(`vim.api.nvim_set_current_win(${String(w.id)})
vim.cmd('edit! ' .. vim.fn.fnameescape(${JSON.stringify(file)}))
vim.api.nvim_win_set_cursor(0, { 1, 0 })
vim.lsp.start { name = 'fake-def', cmd = { ${JSON.stringify(process.execPath)}, ${JSON.stringify(server)} }, root_dir = ${JSON.stringify(ctx.paths.root)} }
return 1`);
  for (let k = 0; k < 50; k += 1) {
    if (
      lua(
        `return #vim.lsp.get_clients { bufnr = 0, method = 'textDocument/definition' }`,
      ) === "1" &&
      lua(`return package.loaded['devhub.definition'] and 1 or 0`) === "1"
    )
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 300 * rate));
  const key = (type) =>
    client.send("Input.dispatchKeyEvent", {
      type,
      key: "Alt",
      code: "AltLeft",
      windowsVirtualKeyCode: 18,
      modifiers: type === "keyUp" ? 0 : 1,
    });
  const alt = (type, x, y, o = {}) =>
    client.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      modifiers: 1,
      button: type === "mouseMoved" ? "none" : "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: type === "mouseMoved" ? 0 : 1,
      ...o,
    });
  // `greet` on line 5, bytes 17-21.
  const cell = (col) => px(w.row + 4, w.col + w.textoff + col);
  const p = cell(18);
  const strip = `P.strip(${String(p.x)},${String(p.y - 8)},${String(p.y + 9)})`;
  const plain = async () => {
    await key("keyUp");
    await mouse("mouseMoved", p.x, p.y);
    await new Promise((r) => setTimeout(r, 300 * rate));
    return ev(`__probe.${strip.slice(2)}`);
  };
  let base = await plain();
  await run("definition link on Alt", "checked", async () => {
    base = await plain();
    lua(`require('devhub.definition').clear() return 1`);
    const r = await measure(
      "keydown",
      `${strip} !== ${JSON.stringify(base)}`,
      () => key("rawKeyDown"),
    );
    return r;
  });
  await run("definition link, pointer moved", "report", async (i) => {
    base = await plain();
    lua(`require('devhub.definition').clear() return 1`);
    const from = cell(2);
    await key("rawKeyDown");
    await alt("mouseMoved", from.x, from.y);
    await new Promise((r) => setTimeout(r, 200 * rate));
    return measure("mousemove", `${strip} !== ${JSON.stringify(base)}`, () =>
      alt("mouseMoved", p.x + i, p.y),
    );
  });
  await run("definition link, hand", "at-once", async () => {
    await key("rawKeyDown");
    await alt("mouseMoved", p.x, p.y);
    await new Promise((r) => setTimeout(r, 300 * rate));
    const shape = await ev(`__probe.cursorAt(${String(p.x)},${String(p.y)})`);
    return {
      ms: 0,
      note:
        shape === "pointer"
          ? undefined
          : `the pointer is ${String(shape)} over the link`,
    };
  });
  await run("definition link gone on release", "at-once", async () => {
    base = await plain();
    await key("rawKeyDown");
    await alt("mouseMoved", p.x, p.y);
    await new Promise((r) => setTimeout(r, 300 * rate));
    const drawn = await ev(`__probe.${strip.slice(2)}`);
    if (drawn === base)
      return { ms: undefined, note: "no link drawn to take away" };
    const r = await measure(
      "keyup",
      `${strip} === ${JSON.stringify(base)}`,
      () => key("keyUp"),
    );
    return {
      ...r,
      note:
        r.frames > 1
          ? `gone ${String(r.frames)} frames after the release, not in its own`
          : undefined,
    };
  });
  await run("definition Alt-click", "checked", async () => {
    await mouse("mouseMoved", p.x, p.y);
    lua(`vim.api.nvim_win_set_cursor(0, { 6, 0 }) return 1`);
    await key("rawKeyDown");
    await alt("mouseMoved", p.x, p.y);
    await new Promise((r) => setTimeout(r, 300 * rate));
    const t0 = Date.now();
    await alt("mousePressed", p.x, p.y);
    await alt("mouseReleased", p.x, p.y);
    await key("keyUp");
    let state;
    for (let k = 0; k < 60; k += 1) {
      state = json(
        `return vim.json.encode { pos = vim.api.nvim_win_get_cursor(0), mode = vim.api.nvim_get_mode().mode }`,
      );
      if (state.pos[0] === 1) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const ms = Date.now() - t0;
    const at = state.pos;
    lua(`vim.cmd('normal! \\15') return 1`);
    const back = json(`return vim.json.encode(vim.api.nvim_win_get_cursor(0))`);
    const notes = [];
    if (at[0] !== 1 || at[1] !== 15)
      notes.push(
        `the cursor is at ${JSON.stringify(at)}, not greet's definition [1,15]`,
      );
    if (state.mode !== "n") notes.push(`mode ${state.mode} after the click`);
    if (back[0] !== 5)
      notes.push(
        `<C-o> went to ${JSON.stringify(back)}, not the clicked line 5`,
      );
    return { ms, note: notes.length ? notes.join("; ") : undefined };
  });
  await key("keyUp");
  esc();
}

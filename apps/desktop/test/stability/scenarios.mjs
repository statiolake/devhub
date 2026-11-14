// The scenarios: each a setup (not recorded) and steps. A step is one action,
// recorded on one or more pages and checked on its own:
//
//   name, act(ctx)            the action
//   prep(ctx)                 what comes before it, not recorded
//   pages                     [{ page, roles, motionMarkers }] (default: the
//                             scenario's page and roles)
//   spec                      invariants.mjs's rules, per page name
//   regions                   picture regions per page: { name, selector |
//                             "viewport", from: "before" }
//   live                      every frame is a new state (a resize): only
//                             the per-frame rules (single, contain) hold
//   waitFor                   a page expression to hold before settling
//   check(ctx)                the settled page's own problems (a list), after
//                             the recording's rules
//
// `ctx` (run.mjs) has the app, the pages, keys, clicks, the managed
// Neovim's RPC and the Workspaces' paths.

import { PROPS } from "./invariants.mjs";
import { decodePng, regionDigest } from "./pixels.mjs";

// What a Neovim surface draws, by role (pane.html). Rows and items are capped:
// the first rows say where a list is, and every row is read every frame.
export const NEOVIM_ROLES = [
  { name: "grid", selector: "canvas.nvim-grid", pixels: true, max: 12 },
  { name: "clip", selector: ".nvim-clip", max: 12 },
  { name: "pane", selector: ".nvim-pane", max: 12 },
  { name: "float-frame", selector: ".nvim-float-frames > *", max: 12 },
  { name: "float-shadow", selector: ".nvim-float-shadow > *", max: 12 },
  { name: "frame", selector: ".nvim-view-frame" },
  { name: "frame-edge", selector: ".nvim-view-frame-edge" },
  { name: "frame-header", selector: ".nvim-view-frame-header" },
  { name: "frame-field", selector: ".nvim-view-frame-field" },
  { name: "frame-list", selector: ".nvim-view-frame-list" },
  { name: "frame-row", selector: ".nvim-view-frame-row", max: 60 },
  { name: "frame-status", selector: ".nvim-view-frame-status" },
  { name: "frame-preview-title", selector: ".nvim-view-frame-preview-title" },
  { name: "frame-keys", selector: ".nvim-view-frame-keys" },
  { name: "frame-actions", selector: ".nvim-view-frame-actions" },
  { name: "view", selector: ".nvim-view", max: 6 },
  { name: "view-sticky", selector: ".nvim-view-sticky", max: 4 },
  { name: "view-item", selector: ".nvim-view-item", max: 60 },
  { name: "popup", selector: ".nvim-popup", max: 4 },
  { name: "popup-body", selector: ".nvim-popup-body", max: 4 },
  // Its text is kept (not compared): a failing frame says what it held.
  { name: "cmdline", selector: ".nvim-cmdline", text: true },
  { name: "cmdline-content", selector: ".nvim-cmdline-content" },
  { name: "cmdline-row", selector: ".nvim-cmdline-row", max: 4 },
  // Neovim's prompts drawn natively (PromptViews.tsx): the sheet and the bar.
  { name: "prompt", selector: ".nvim-prompt, .nvim-prompt-bar", text: true },
  {
    name: "prompt-row",
    selector: ".nvim-prompt-choice, .nvim-prompt-bar-button",
    max: 8,
  },
  { name: "footer", selector: ".nvim-footer", max: 6 },
  { name: "tabline", selector: ".nvim-tabline" },
];

/**
 * The Neovim surface's motions that are not Web Animations, each by what is
 * on screen only while it runs: pane motion's pictures (windowMotion.ts), a
 * scroll's ghost of the last view easing out (smoothScroll.ts), lines sliding
 * after a `dd` or an `o` (slideLines).
 */
export const NEOVIM_MOTION = [
  // A window's pane motion (windowMotion.ts): its group exists from the
  // transition's first frame, before any picture or edge is made for it.
  ".nvim-motion",
  ".nvim-motion-picture",
  ".nvim-motion-edge",
  ".nvim-scroll-ghost",
  ".nvim-slide",
];

const SIDEBAR_ROLES = [
  { name: "sidebar", selector: "aside.sidebar" },
  { name: "row", selector: ".sidebar-row", max: 20, colors: true },
  { name: "glyph", selector: ".row-glyph", max: 20 },
  { name: "label", selector: ".row-label", max: 20 },
  { name: "heading", selector: ".sidebar-section-heading" },
  { name: "usage", selector: ".sidebar-usage" },
];

const INDEX_ROLES = [
  { name: "title-bar", selector: ".title-bar, header" },
  { name: "button", selector: ".title-bar-button", max: 6 },
  { name: "title", selector: ".title-bar-title, .window-title", max: 2 },
];

const CONVERSATION_ROLES = [
  { name: "scroll", selector: ".conversation-scroll" },
  { name: "transcript", selector: ".conversation-transcript" },
  { name: "entry", selector: ".conversation-entry", max: 10 },
  { name: "user", selector: ".conversation-user", max: 10 },
  { name: "assistant", selector: ".conversation-assistant", max: 10 },
  { name: "block", selector: ".conversation-markdown > *", max: 20 },
  { name: "actions", selector: ".conversation-message-actions", max: 10 },
  { name: "composer", selector: ".conversation-composer-box" },
  { name: "footer", selector: ".conversation-footer" },
  { name: "smart", selector: ".smart-buttons" },
];

const neovim = {
  page: "pane",
  roles: NEOVIM_ROLES,
  motionMarkers: NEOVIM_MOTION,
};

/** The editor at rest: one window on core0.ts, Normal mode, nothing open over it. */
export async function editorAtRest(ctx) {
  await ctx.focus("pane");
  ctx.nvimSend("<C-\\><C-n><Esc>");
  ctx.nvimExpr(
    "execute('silent! only | silent! tabonly | silent! NvimTreeClose | silent! edit! src/core/core0.ts | call cursor(1, 1)')",
  );
  ctx.nvimExpr(
    "execute('lua for _, w in ipairs(vim.api.nvim_list_wins()) do if vim.api.nvim_win_get_config(w).relative ~= \"\" then pcall(vim.api.nvim_win_close, w, true) end end')",
  );
  await ctx.settle("pane");
}

/** A confirm() of two answers, its question two lines. */
const CONFIRM =
  ':call confirm("Delete core0.ts?\\nThe file is removed from disk.", "&Delete\\n&Cancel", 2)<CR>';
const PROMPT_UP = "!!document.querySelector('.nvim-prompt, .nvim-prompt-bar')";
const PROMPT_GONE = "!document.querySelector('.nvim-prompt, .nvim-prompt-bar')";

/**
 * Notes, in the page, whether the command line's box ever held a prompt's
 * raw answers (`(D)elete, [C]ancel: `), in any frame: they are drawn
 * natively, never as the box's text.
 */
const WATCH_RAW_PROMPT = `(() => {
  window.__rawPrompt = "";
  const look = () => {
    for (const e of document.querySelectorAll(".nvim-cmdline")) {
      const t = e.textContent ?? "";
      if (/\\(D\\)elete|\\(y\\)es\\/|Type number/.test(t)) window.__rawPrompt = t;
    }
  };
  window.__rawPromptObserver?.disconnect();
  window.__rawPromptObserver = new MutationObserver(look);
  window.__rawPromptObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
})()`;

async function rawPromptCheck(ctx) {
  const raw = await ctx.evalIn("pane", "window.__rawPrompt ?? ''");
  return raw ? [`the command line's box drew a prompt's raw text: ${raw}`] : [];
}

/** A Neovim float with a rounded border and a title (B′), or two whose borders meet. */
const FLOAT_LUA = (fused) => `
local function open(row, col, title)
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, { 'alpha', 'beta', 'gamma', 'delta' })
  return vim.api.nvim_open_win(buf, false, {
    relative = 'editor', row = row, col = col, width = 24, height = 4,
    border = 'rounded', title = title, title_pos = 'center', style = 'minimal',
  })
end
open(8, 20, ' First ')
${fused ? "open(8, 45, ' Second ')" : ""}
`;

/**
 * A composer framed by `gui.frame` (devhub.nvim), as a plugin's DevHub
 * extension frames one: a buffer to write in, in a float under the cursor's
 * line, over a blank float a row taller each way that the frame covers, and
 * closed with it in the same tick. <F5> opens it; <C-s> and q close it.
 */
const COMPOSER_LUA = `
_G.stability_composer = function()
  local gui = require('devhub.gui')
  local code = vim.api.nvim_get_current_win()
  local lnum = vim.api.nvim_win_get_cursor(code)[1]
  local place = { relative = 'win', win = code, bufpos = { lnum - 1, 0 } }
  local frame = vim.api.nvim_open_win(vim.api.nvim_create_buf(false, true), false, vim.tbl_extend('force', place,
    { row = 1, col = -1, width = 52, height = 10, style = 'minimal', focusable = false, zindex = 60 }))
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].bufhidden = 'wipe'
  local body = vim.api.nvim_open_win(buf, true, vim.tbl_extend('force', place,
    { row = 3, col = 0, width = 50, height = 6, style = 'minimal', zindex = 61 }))
  vim.api.nvim_create_autocmd('WinClosed', { pattern = tostring(body), once = true, callback = function()
    if vim.api.nvim_win_is_valid(frame) then vim.api.nvim_win_close(frame, true) end
  end })
  local function close()
    vim.cmd('stopinsert')
    if vim.api.nvim_win_is_valid(body) then vim.api.nvim_win_close(body, true) end
  end
  vim.keymap.set({ 'n', 'i' }, '<C-s>', close, { buffer = buf })
  vim.keymap.set('n', 'q', close, { buffer = buf })
  gui.frame {
    win = frame, body = body,
    title = { type = 'text', size = 'sm', runs = { { text = 'Comment', bold = true }, { text = '  core0.ts L3', hl = 'Comment' } } },
    keys = { { '<C-s>', 'send' }, { 'q', 'cancel' } },
    actions = { type = 'hstack', gap = 6, children = {
      { type = 'button', text = 'Cancel', on_click = close },
      { type = 'button', text = 'Send', tone = 'accent', on_click = close },
    } },
  }
  vim.cmd('startinsert')
end
vim.keymap.set('n', '<F5>', _G.stability_composer)
vim.api.nvim_win_set_cursor(0, { 3, 0 })
`;

/** A borderless float, entered, the cursor a block in its last cell. */
const CORNER_FLOAT_LUA = `
vim.o.guicursor = 'n-v-c:block'
local buf = vim.api.nvim_create_buf(false, true)
vim.api.nvim_buf_set_lines(buf, 0, -1, false, { 'alpha  gamma', 'beta   delta', 'gamma  alpha', 'delta  beta!' })
local win = vim.api.nvim_open_win(buf, true, {
  relative = 'editor', row = 8, col = 20, width = 12, height = 4,
  border = 'none', style = 'minimal',
})
vim.api.nvim_win_set_cursor(win, { 4, 11 })
`;

/**
 * The cursor parked in each corner cell of the float `CORNER_FLOAT_LUA`
 * opened: the cell's outer pixel strips along the float's edges (the frame's
 * line, and the open half pixel outside its arc) are the same as with the
 * cursor in the float's middle. A cursor laid square over the cells covered
 * them, the line and its arc gone under the block.
 */
async function cursorCornerCheck(ctx) {
  const client = await ctx.page("pane");
  const picture = async () => {
    await ctx.settle("pane");
    const shot = await client.send("Page.captureScreenshot", {
      format: "png",
    });
    return decodePng(Buffer.from(shot.data, "base64"));
  };
  const cursorRect = () =>
    client.eval(`(() => {
      const b = document.querySelector('.nvim-cursor').getBoundingClientRect();
      return [b.x, b.y, b.width, b.height];
    })()`);
  const corners = [
    { name: "bottom-right", at: "{ 4, 11 }", v: "bottom", h: "right" },
    { name: "top-left", at: "{ 1, 0 }", v: "top", h: "left" },
    { name: "top-right", at: "{ 1, 11 }", v: "top", h: "right" },
    { name: "bottom-left", at: "{ 4, 0 }", v: "bottom", h: "left" },
  ];
  const problems = [];
  const park = (at) => ctx.lua(`vim.api.nvim_win_set_cursor(0, ${at})`);
  for (const corner of corners) {
    park(corner.at);
    const with_ = await picture();
    const [x, y, w, h] = (await cursorRect()).map(Math.round);
    const strips = [
      corner.v === "top" ? [x, y, w, 1] : [x, y + h - 1, w, 1],
      corner.h === "left" ? [x, y, 1, h] : [x + w - 1, y, 1, h],
    ];
    park("{ 2, 5 }");
    const without = await picture();
    for (const strip of strips) {
      if (regionDigest(with_, strip) !== regionDigest(without, strip))
        problems.push(
          `[cursor-clip] the cursor in the float's ${corner.name} cell covers its frame at ${JSON.stringify(strip)}`,
        );
    }
  }
  return problems;
}

// A theme landed: the page's palette variables are not what they were.
const THEME_MARK =
  "window.__stabilityPalette = document.documentElement.style.cssText";
const IDLE_SIDEBAR = `!document.querySelector('[data-status="working"], [data-status="background"]')`;
const THEME_CHANGED =
  "document.documentElement.style.cssText !== window.__stabilityPalette";

const floatSpec = { single: ["frame", "frame-edge"] };

// The rows under a window that scrolls (its footer's foot to the editor's):
// the command line's, nothing in a scroll may draw there.
const CMDLINE_ROWS = `(() => {
  const f = [...document.querySelectorAll(".nvim-footer")].pop();
  const e = document.querySelector(".nvim-editor");
  if (!f || !e) return null;
  const a = f.getBoundingClientRect(), b = e.getBoundingClientRect();
  return [b.x, a.bottom, b.width, b.bottom - a.bottom];
})()`;

// The current window's text area, at rest: its grid's canvas (the status
// line is grid 1's; the fixture has no winbar).
const TEXT_AREA = `(() => {
  const ed = Object.values(window.neovimEditors ?? {})[0];
  const c = ed?.painter.canvases.get(ed.state.cursor.grid)?.canvas;
  if (!c) return null;
  const b = c.getBoundingClientRect();
  return [b.x, b.y, b.width, b.height];
})()`;

/** A burst of `<C-d>`/`<C-u>` as a held key gives them, 33 ms apart. */
async function burst(ctx, keys) {
  for (const key of keys) {
    await ctx.press("pane", key);
    await new Promise((r) => setTimeout(r, 33));
  }
}

// The Orchestrator's board, as the `orchestrator` scenario records it.
const ORCHESTRATOR_ROLES = [
  {
    name: "board",
    selector: "[class*='orchestrator'], [class*='board']",
    max: 40,
  },
];

let typedLines = 0;

/**
 * A line typed through X with the Terminal tab on screen: it must reach the
 * orchestrator's Workspace's shell (its `ws-` session, in the orchestrator's
 * folder) — through main's keyboard to that terminal page, `send-keys` and
 * tmux. With a `$`, which tmux's command parser once refused.
 */
async function typedInOrchestratorTerminal(ctx) {
  const mark = `typed-${String(++typedLines)}$`;
  await ctx.realTypeLine(`echo '${mark}'`);
  const deadline = Date.now() + 5_000;
  for (;;) {
    const sessions = ctx.app
      .tmux("list-panes", "-a", "-F", "#{session_name} #{pane_current_path}")
      .split("\n")
      .filter(
        (line) => line.startsWith("ws-") && line.endsWith("/orchestrator"),
      )
      .map((line) => line.split(" ")[0]);
    for (const session of new Set(sessions)) {
      const screen = ctx.app.tmux("capture-pane", "-p", "-t", session);
      if (screen.split("\n").some((row) => row === mark)) return [];
    }
    if (Date.now() > deadline) {
      const focused = await ctx.evalIn("agents", "document.hasFocus()");
      return [
        `"echo '${mark}'" typed with the Terminal tab on screen never reached the orchestrator's shell (${sessions.length === 0 ? "no ws- session in the orchestrator's folder" : `sessions ${sessions.join(", ")}`}; the board's page ${focused ? "has" : "has not"} the keyboard)`,
      ];
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/**
 * The quickfix window drawn as devhub.nvim draws it: a view with its title
 * row (list `nr` of the two, item `idx`) and a heading per file, the list's
 * state Neovim's.
 */
async function quickfixDrawn(ctx, nr, idx) {
  const problems = [];
  const state = ctx
    .nvimExpr(
      "getqflist({'nr': 0, 'idx': 0}).nr . ' ' . getqflist({'idx': 0}).idx",
    )
    .trim();
  if (state !== `${String(nr)} ${String(idx)}`)
    problems.push(
      `quickfix: list and item ${state}, not ${String(nr)} ${String(idx)}`,
    );
  const header = await ctx.evalIn(
    "pane",
    "document.querySelector('.nvim-view-header')?.textContent ?? ''",
  );
  if (!/Quickfix/i.test(header) || !header.includes(`list ${String(nr)} of 2`))
    problems.push(`quickfix: the title row says ${JSON.stringify(header)}`);
  const headings = await ctx.evalIn(
    "pane",
    "document.querySelectorAll('.nvim-view-entry > .nvim-view-heading').length",
  );
  if (!(headings > 0)) problems.push("quickfix: no file headings drawn");
  return problems;
}

export const SCENARIOS = [
  {
    name: "scroll-burst",
    description:
      "repeated <C-d> and <C-u> at key-repeat speed in a long file, cmdheight=2 and scrolloff=0 as the person has them: nothing drawn outside the window's text area",
    ...neovim,
    setup: async (ctx) => {
      await editorAtRest(ctx);
      ctx.nvimExpr(
        "execute('edit! src/long.ts | set cmdheight=2 scrolloff=0 | normal! 600Gzt')",
      );
      await ctx.settle("pane");
    },
    steps: ["down", "up", "alternating"].map((way) => ({
      name: way,
      act: (ctx) =>
        burst(
          ctx,
          Array.from({ length: 20 }, (_, i) =>
            way === "down"
              ? "C-d"
              : way === "up"
                ? "C-u"
                : i % 2
                  ? "C-u"
                  : "C-d",
          ),
        ),
      // Found by hand (the person's report): the scroll's ghost, the old
      // view sliding, was left outside its port at the first scroll after
      // rest and drew over the command line's rows (<C-u>) and over what is
      // above the window (<C-d>).
      regions: [{ name: "cmdline-rows", expr: CMDLINE_ROWS, still: true }],
      // And every picture of the window's text is made of rows it draws at
      // rest: no row torn between two lines, none half painted.
      coherent: { expr: TEXT_AREA },
      spec: { only: [] },
      quietMs: 900,
    })),
    teardown: (ctx) => {
      ctx.nvimExpr("execute('set cmdheight=1')");
    },
  },
  {
    name: "picker",
    description:
      "the snacks picker opening, its preview toggled, the window resized with it open, the query left and the picker closed",
    ...neovim,
    setup: editorAtRest,
    steps: [
      {
        name: "open",
        known: [
          {
            match:
              /^pane: \[(picture\] region picker|intermediate\] grid#\d+ took)/,
            owner: "outside",
            why: "snacks.nvim shows the preview's float and fills its buffer in a later tick: Neovim flushes the empty preview, then the file (now and then, either rate)",
          },
        ],
        act: (ctx) => ctx.press("pane", "C-p"),
        regions: [{ name: "picker", selector: ".nvim-view-frame-edge" }],
        spec: floatSpec,
      },
      {
        name: "preview-off",
        known: [
          {
            match: /^pane: \[picture\] region picker/,
            owner: "outside",
            why: "snacks.nvim renders the list's rows again for the list's new width (paths cut differently) in a tick after the one that resized it: one row's text changes a frame later",
          },
        ],
        act: (ctx) => ctx.press("pane", "F4"),
        regions: [{ name: "picker", selector: ".nvim-view-frame-edge" }],
        spec: floatSpec,
      },
      {
        name: "preview-on",
        known: [
          {
            match:
              /^pane: \[(picture\] region picker|intermediate\] grid#\d+ took)/,
            owner: "outside",
            why: "snacks.nvim shows the preview's float and fills its buffer in a later tick: Neovim flushes the empty preview, then the file (now and then, either rate)",
          },
        ],
        act: (ctx) => ctx.press("pane", "F4"),
        regions: [{ name: "picker", selector: ".nvim-view-frame-edge" }],
        spec: floatSpec,
      },
      {
        name: "window-resize",
        // Every frame is a new size, so the rule is that the picker's parts
        // hold together in each frame, not one form.
        act: (ctx) =>
          ctx.resizeWindow([
            [-120, -80],
            [-240, -160],
            [0, 0],
          ]),
        live: true,
        spec: {
          ...floatSpec,
          contain: [
            ["frame-list#0", "frame-edge#0"],
            ["frame-header#0", "frame-edge#0"],
            ["frame-status#0", "frame-edge#0"],
          ],
        },
      },
      {
        name: "query-normal",
        act: (ctx) => ctx.press("pane", "Escape"),
        regions: [{ name: "picker", selector: ".nvim-view-frame-edge" }],
        spec: floatSpec,
      },
      {
        name: "close",
        act: (ctx) => ctx.press("pane", "Escape"),
        regions: [
          { name: "picker", selector: ".nvim-view-frame-edge", from: "before" },
        ],
        spec: floatSpec,
      },
    ],
  },
  {
    name: "composer",
    description:
      "a composer framed round its editable window (gui.frame) opening, typed in, sent, opened again and cancelled from Normal mode",
    ...neovim,
    setup: async (ctx) => {
      await editorAtRest(ctx);
      ctx.lua(COMPOSER_LUA);
      await ctx.settle("pane");
    },
    steps: [
      {
        name: "open",
        act: (ctx) => ctx.press("pane", "F5"),
        regions: [{ name: "composer", selector: ".nvim-view-frame-edge" }],
        spec: floatSpec,
      },
      {
        name: "type",
        act: (ctx) => ctx.type("pane", "looks off"),
        spec: floatSpec,
      },
      {
        name: "send",
        act: (ctx) => ctx.press("pane", "C-s"),
        regions: [
          {
            name: "composer",
            selector: ".nvim-view-frame-edge",
            from: "before",
          },
        ],
        spec: floatSpec,
      },
      {
        name: "reopen",
        act: (ctx) => ctx.press("pane", "F5"),
        regions: [{ name: "composer", selector: ".nvim-view-frame-edge" }],
        spec: floatSpec,
      },
      {
        name: "normal",
        act: (ctx) => ctx.press("pane", "Escape"),
        spec: floatSpec,
      },
      {
        name: "cancel",
        act: (ctx) => ctx.press("pane", "q"),
        regions: [
          {
            name: "composer",
            selector: ".nvim-view-frame-edge",
            from: "before",
          },
        ],
        spec: floatSpec,
      },
    ],
  },
  {
    name: "tree",
    description:
      "nvim-tree opening, a folder expanded and collapsed, scrolling under its sticky header, and closing",
    ...neovim,
    setup: editorAtRest,
    steps: [
      {
        // A split: its pane motion (167 ms) is declared; the tree's view is
        // checked from the first frame it is drawn in after the motion.
        name: "open",
        act: (ctx) => ctx.press("pane", "F2"),
        spec: {},
      },
      {
        name: "expand",
        prep: (ctx) => ctx.nvimExpr("search('many', 'w')"),
        act: (ctx) => ctx.press("pane", "Enter"),
        regions: [{ name: "tree", selector: ".nvim-view" }],
        spec: {},
      },
      {
        name: "scroll-sticky",
        prep: (ctx) => ctx.nvimExpr("execute('normal! 3j')"),
        act: (ctx) => ctx.press("pane", "C-d"),
        spec: {},
      },
      {
        name: "collapse",
        prep: (ctx) =>
          ctx.nvimExpr("execute('normal! gg') . search('many', 'w')"),
        act: (ctx) => ctx.press("pane", "Enter"),
        regions: [{ name: "tree", selector: ".nvim-view" }],
        spec: {},
      },
      {
        name: "close",
        act: (ctx) => ctx.press("pane", "F2"),
        spec: {},
      },
    ],
  },
  {
    name: "quickfix",
    description:
      "the quickfix window drawn natively (devhub.nvim): opened on a grep's result, scrolled under its held file headings, :cnext, :colder and closed",
    ...neovim,
    setup: async (ctx) => {
      await editorAtRest(ctx);
      // Two lists: the newer of 36 items in 18 files.
      ctx.nvimExpr(
        "execute('silent! call setqflist([], ''f'') | silent vimgrep /shifted/j src/**/*.ts | silent vimgrep /doubled/j src/**/*.ts')",
      );
      await ctx.settle("pane");
    },
    steps: [
      {
        // A split: its pane motion is declared; the view is checked from
        // the first frame the window is drawn in — never its cells first.
        name: "open",
        act: (ctx) => ctx.press("pane", "F6"),
        spec: {},
        check: (ctx) => quickfixDrawn(ctx, 2, 1),
      },
      {
        name: "scroll",
        act: (ctx) => ctx.press("pane", "C-d"),
        regions: [{ name: "list", selector: ".nvim-view" }],
        spec: {},
      },
      {
        // The next item, from the list's window: the file's window jumps,
        // and the list marks its new current item.
        name: "cnext",
        act: (ctx) => ctx.press("pane", "F8"),
        spec: {},
        check: (ctx) => quickfixDrawn(ctx, 2, 2),
      },
      {
        // The list before: the buffer is written anew, its rows the other
        // list's in one frame.
        name: "colder",
        act: (ctx) => ctx.press("pane", "F9"),
        regions: [{ name: "list", selector: ".nvim-view" }],
        spec: {},
        check: (ctx) => quickfixDrawn(ctx, 1, 1),
      },
      {
        name: "close",
        act: (ctx) => ctx.press("pane", "F7"),
        spec: {},
      },
    ],
    teardown: (ctx) => {
      ctx.nvimExpr(
        "execute('silent! cclose | silent! call setqflist([], ''f'')')",
      );
    },
  },
  {
    name: "blink-insert",
    description: "blink.cmp's insert-mode menu (blink-ui) opening and closing",
    ...neovim,
    setup: async (ctx) => {
      await editorAtRest(ctx);
      ctx.nvimExpr("execute('normal! G')");
      await ctx.press("pane", "o");
      await ctx.settle("pane");
    },
    steps: [
      {
        name: "menu-open",
        act: (ctx) => ctx.press("pane", "v"),
        regions: [{ name: "menu", selector: ".nvim-popup" }],
        spec: { single: ["popup"], ignore: { grid: ["hash"] } },
      },
      {
        name: "menu-next",
        act: (ctx) => ctx.press("pane", "C-n"),
        spec: { single: ["popup"], ignore: { grid: ["hash"] } },
      },
      {
        name: "menu-close",
        act: (ctx) => ctx.press("pane", "C-e"),
        regions: [{ name: "menu", selector: ".nvim-popup", from: "before" }],
        spec: { single: ["popup"], ignore: { grid: ["hash"] } },
      },
    ],
    teardown: (ctx) => ctx.press("pane", "Escape"),
  },
  {
    name: "cmdline",
    description:
      "a `:` command line opening, completing (blink-ui's command-line menu) and closing",
    ...neovim,
    setup: editorAtRest,
    steps: [
      {
        name: "open",
        act: (ctx) => ctx.press("pane", ":"),
        regions: [{ name: "cmdline", selector: ".nvim-cmdline" }],
        spec: { single: ["cmdline"] },
      },
      {
        name: "type",
        act: (ctx) => ctx.press("pane", "e"),
        regions: [{ name: "cmdline", selector: ".nvim-cmdline" }],
        spec: { single: ["cmdline", "popup"] },
      },
      {
        name: "complete",
        act: (ctx) => ctx.press("pane", "Tab"),
        spec: { single: ["cmdline", "popup"] },
      },
      {
        name: "close",
        act: (ctx) => ctx.press("pane", "Escape"),
        regions: [
          { name: "cmdline", selector: ".nvim-cmdline", from: "before" },
        ],
        spec: { single: ["cmdline", "popup"] },
      },
    ],
  },
  {
    name: "prompt",
    description:
      "Neovim's prompts drawn natively: confirm() opening, closing by Esc and by a click, and :s///c's bar moving to the next match",
    ...neovim,
    setup: async (ctx) => {
      await editorAtRest(ctx);
      await ctx.evalIn("pane", WATCH_RAW_PROMPT);
    },
    steps: [
      {
        name: "confirm-open",
        act: (ctx) => ctx.nvimSend(CONFIRM),
        waitFor: PROMPT_UP,
        spec: { single: ["prompt", "cmdline"] },
        check: rawPromptCheck,
      },
      {
        name: "confirm-esc",
        act: (ctx) => ctx.press("pane", "Escape"),
        waitFor: PROMPT_GONE,
        spec: { single: ["prompt", "cmdline"] },
        check: rawPromptCheck,
      },
      {
        name: "confirm-click",
        prep: async (ctx) => {
          ctx.nvimSend(CONFIRM);
          await ctx.waitIn("pane", PROMPT_UP, 5000);
          await ctx.settle("pane");
        },
        act: (ctx) => ctx.clickText("pane", ".nvim-prompt-choice", "Cancel"),
        waitFor: PROMPT_GONE,
        spec: { single: ["prompt", "cmdline"] },
        check: rawPromptCheck,
      },
      {
        name: "substitute-next",
        prep: async (ctx) => {
          ctx.nvimSend(":%s/const/const/gc<CR>");
          await ctx.waitIn("pane", PROMPT_UP, 5000);
          await ctx.settle("pane");
        },
        act: (ctx) => ctx.press("pane", "n"),
        spec: { single: ["prompt", "cmdline"] },
        check: rawPromptCheck,
      },
    ],
    teardown: async (ctx) => {
      await ctx.press("pane", "Escape");
      await editorAtRest(ctx);
    },
  },
  {
    name: "float",
    description:
      "a Neovim float with a rounded border and a title (B′), then two whose borders are fused",
    ...neovim,
    setup: editorAtRest,
    steps: [
      {
        name: "open-titled",
        act: (ctx) => ctx.lua(FLOAT_LUA(false)),
        spec: {},
      },
      {
        name: "close",
        act: (ctx) => editorAtRestQuick(ctx),
        spec: {},
      },
      {
        name: "open-fused",
        act: (ctx) => ctx.lua(FLOAT_LUA(true)),
        spec: {},
      },
      {
        name: "close-fused",
        act: (ctx) => editorAtRestQuick(ctx),
        spec: {},
      },
      {
        name: "cursor-corner",
        // A borderless float's frame hugs its cells: its line is in the
        // corner cells' outer pixels. The cursor there is cut as the text
        // is, so the line looks as it does without the cursor.
        act: (ctx) => ctx.lua(CORNER_FLOAT_LUA),
        check: cursorCornerCheck,
        spec: {},
      },
      {
        name: "close-corner",
        act: (ctx) => editorAtRestQuick(ctx),
        spec: {},
      },
    ],
  },
  {
    name: "open-file",
    description:
      "`devhub <file>` opening a file into the Workspace's devhub-nvim window",
    ...neovim,
    setup: editorAtRest,
    steps: [
      {
        name: "devhub-file",
        act: (ctx) => ctx.cli(["src/ui/ui1.ts"]),
        spec: {},
        regions: [{ name: "editor", selector: "viewport" }],
      },
      {
        name: "devhub-file-again",
        known: [
          {
            match: /^pane: \[(intermediate\] grid#1|picture\] region editor)/,
            owner: "outside",
            why: "Neovim highlights markdown with treesitter in a later redraw than the one that shows the file: plain text for a frame, then coloured (a terminal Neovim shows the same)",
          },
        ],
        act: (ctx) => ctx.cli(["docs/guide.md"]),
        spec: {},
        regions: [{ name: "editor", selector: "viewport" }],
      },
    ],
  },
  {
    name: "workspace-switch",
    description: "selecting the other Workspace in the Sidebar, and back",
    page: "sidebar",
    roles: SIDEBAR_ROLES,
    setup: async (ctx) => {
      await ctx.clickText("sidebar", ".sidebar-row", "alpha");
      await ctx.settle("sidebar");
    },
    steps: [
      {
        name: "to-beta",
        prep: (ctx) => ctx.hoverText("sidebar", ".sidebar-row", "beta"),
        act: (ctx) => ctx.clickText("sidebar", ".sidebar-row", "beta"),
        pages: [
          { page: "sidebar", roles: SIDEBAR_ROLES },
          { page: "index", roles: INDEX_ROLES },
        ],
        regions: { sidebar: [{ name: "sidebar", selector: "viewport" }] },
        spec: {},
      },
      {
        name: "to-alpha",
        prep: (ctx) => ctx.hoverText("sidebar", ".sidebar-row", "alpha"),
        act: (ctx) => ctx.clickText("sidebar", ".sidebar-row", "alpha"),
        pages: [
          { page: "sidebar", roles: SIDEBAR_ROLES },
          { page: "index", roles: INDEX_ROLES },
        ],
        regions: { sidebar: [{ name: "sidebar", selector: "viewport" }] },
        spec: {},
      },
    ],
  },
  {
    name: "sidebar-collapse",
    description: "the Sidebar collapsing to its rail and expanding again",
    page: "sidebar",
    roles: SIDEBAR_ROLES,
    steps: [
      {
        name: "collapse",
        known: [
          {
            match:
              /^sidebar: \[intermediate\] (row|heading|glyph|label|usage)#/,
            owner: "devhub",
            why: "the Sidebar's view is narrowed before its page has the projection that says collapsed: at 6x one frame lays the full rows out in the rail's 40px, then the rail",
          },
          {
            match: /^pane: \[intermediate\] (grid|pane|footer|clip)#/,
            owner: "devhub",
            why: "at 6x the pane's view is put in place by main's 200 ms cap (LAYOUT_SETTLE_TIMEOUT_MS) before the throttled page has redrawn at its new size: the old grid is seen at the new place for a frame (at 1x the view waits for Neovim's redraw and holds)",
          },
        ],
        prep: (ctx) =>
          ctx.hoverSelector(
            "index",
            '[aria-label="Toggle Sidebar"], [title="Toggle Sidebar"]',
          ),
        act: (ctx) =>
          ctx.clickSelector(
            "index",
            '[aria-label="Toggle Sidebar"], [title="Toggle Sidebar"]',
          ),
        pages: [
          { page: "sidebar", roles: SIDEBAR_ROLES },
          { page: "index", roles: INDEX_ROLES },
          { page: "pane", roles: NEOVIM_ROLES, motionMarkers: NEOVIM_MOTION },
        ],
        spec: {},
      },
      {
        name: "expand",
        known: [
          {
            match:
              /^sidebar: \[intermediate\] (row|heading|glyph|label|usage)#/,
            owner: "devhub",
            why: "the Sidebar's view is widened before its page has the projection that says expanded: at 6x one frame lays the rail out in the full width, then the rows",
          },
          {
            match: /^pane: \[intermediate\] (grid|pane|footer|clip)#/,
            owner: "devhub",
            why: "at 6x the pane's view is put in place by main's 200 ms cap (LAYOUT_SETTLE_TIMEOUT_MS) before the throttled page has redrawn at its new size: the old grid is seen at the new place for a frame (at 1x the view waits for Neovim's redraw and holds)",
          },
        ],
        prep: (ctx) =>
          ctx.hoverSelector(
            "index",
            '[aria-label="Toggle Sidebar"], [title="Toggle Sidebar"]',
          ),
        act: (ctx) =>
          ctx.clickSelector(
            "index",
            '[aria-label="Toggle Sidebar"], [title="Toggle Sidebar"]',
          ),
        pages: [
          { page: "sidebar", roles: SIDEBAR_ROLES },
          { page: "index", roles: INDEX_ROLES },
          { page: "pane", roles: NEOVIM_ROLES, motionMarkers: NEOVIM_MOTION },
        ],
        spec: {},
      },
    ],
  },
  {
    name: "orchestrator",
    description:
      "the Orchestrator's board coming up from a Workspace, and back (the board only: its tabs are being replaced)",
    page: "sidebar",
    roles: SIDEBAR_ROLES,
    setup: async (ctx) => {
      await ctx.clickText("sidebar", ".sidebar-row", "alpha");
      await ctx.settle("sidebar");
    },
    steps: [
      {
        name: "to-board",
        prep: (ctx) => ctx.hoverText("sidebar", ".sidebar-row", "Orchestrator"),
        act: (ctx) => ctx.clickText("sidebar", ".sidebar-row", "Orchestrator"),
        pages: [
          { page: "sidebar", roles: SIDEBAR_ROLES },
          {
            page: "agents",
            roles: [
              {
                name: "board",
                selector: "[class*='orchestrator'], [class*='board']",
                max: 40,
              },
            ],
          },
        ],
        regions: { agents: [{ name: "board", selector: "viewport" }] },
        spec: {},
      },
      {
        name: "back",
        prep: (ctx) => ctx.hoverText("sidebar", ".sidebar-row", "alpha"),
        act: (ctx) => ctx.clickText("sidebar", ".sidebar-row", "alpha"),
        pages: [{ page: "sidebar", roles: SIDEBAR_ROLES }],
        spec: {},
      },
    ],
  },
  {
    name: "orchestrator-terminal",
    description:
      "typing in the Orchestrator's Terminal tab, the keys put there by choosing the tab (real X clicks and keys, through main's keyboard)",
    page: "agents",
    roles: ORCHESTRATOR_ROLES,
    // Real clicks only, here and in the steps. A CDP press leaves the view
    // it went to holding the pointer: every real press after it goes there
    // until one has, so the first real click (the row, again: selecting it
    // twice is selecting it) is for whichever view an earlier scenario
    // pressed in.
    setup: async (ctx) => {
      for (let i = 0; i < 2; i++) {
        await ctx.realClick("sidebar", ".sidebar-row", "Orchestrator");
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      await ctx.waitIn("agents", "!!document.querySelector('[role=tab]')");
      await ctx.settle("agents");
    },
    teardown: async (ctx) => {
      await ctx.realClick("agents", "[role=tab]", "ボード");
      await new Promise((resolve) => setTimeout(resolve, 600));
      await ctx.realClick("sidebar", ".sidebar-row", "alpha");
      await ctx.settle("sidebar");
    },
    steps: [
      {
        name: "choose-tab",
        known: [
          {
            match: /^agents: \[intermediate\] board#\d+ took \d+ forms/,
            owner: "devhub",
            why: "at 6x, the tab's line under the terminal's view (what it says until the view is over it) says the folder is being opened, then that it connects: a Workspace opened for the tab, then attached",
          },
        ],
        act: (ctx) => ctx.realClick("agents", "[role=tab]", "ターミナル"),
        // The Workspace's terminal page, laid over the board's body.
        waitFor: "!!document.querySelector('#orchestrator-panel-terminal')",
        spec: {},
        check: (ctx) => typedInOrchestratorTerminal(ctx),
      },
      {
        // The press lands in the board's header, which takes the keys out
        // of the terminal; choosing the tab shown must put them back.
        name: "choose-tab-again",
        act: (ctx) => ctx.realClick("agents", "[role=tab]", "ターミナル"),
        spec: {},
        check: (ctx) => typedInOrchestratorTerminal(ctx),
      },
      {
        name: "header-then-tab",
        act: async (ctx) => {
          await ctx.realClick(
            "agents",
            ".orchestrator-board-header",
            undefined,
            "corner",
          );
          await new Promise((resolve) => setTimeout(resolve, 300));
          await ctx.realClick("agents", "[role=tab]", "ターミナル");
        },
        spec: {},
        check: (ctx) => typedInOrchestratorTerminal(ctx),
      },
    ],
  },
  {
    name: "conversation",
    description:
      "a GUI Agent's conversation sending a message and receiving a streamed answer (fixture/fake-claude.mjs)",
    page: "conversations",
    roles: CONVERSATION_ROLES,
    setup: async (ctx) => {
      if (!ctx.state.agent) {
        ctx.cli(["--agent", "fake"]);
        ctx.state.agent = true;
      } else {
        await ctx.clickText("sidebar", ".sidebar-row", "Fake");
      }
      await ctx.waitIn(
        "conversations",
        "!!document.querySelector('.conversation-composer-input')",
      );
      await ctx.settle("conversations");
    },
    steps: [
      {
        name: "send-and-stream",
        prep: async (ctx) => {
          await ctx.focusSelector(
            "conversations",
            ".conversation-composer-input",
          );
          await ctx.type("conversations", "what is in src");
          await ctx.evalIn(
            "conversations",
            "window.__stabilityAnswers = document.querySelectorAll('.conversation-assistant').length + 1",
          );
          await ctx.settle("conversations");
        },
        act: (ctx) => ctx.press("conversations", "D-Enter"),
        // The answer grows for ~2 s; settled once its copy button is there.
        waitFor:
          "document.querySelectorAll('.conversation-assistant .conversation-message-actions').length >= window.__stabilityAnswers",
        spec: {
          // Text grows: a block's height and its own text may change, its
          // place and width may not (nothing pushed, rule 1).
          // The Smart Buttons follow the turn (idle, running, idle): two
          // causes in this one step, so they are not held to one change.
          // Their triggers are the agent's status and the repository's
          // state: whether any holds while the answer runs (a change left
          // uncommitted by an earlier step) decides whether the row goes
          // away and comes back, so it is not compared at all.
          // The person's message is quieter while it is on its way to the
          // CLI (`data-sending`), until the CLI's echo: a designed state,
          // its second form the echo's, not the send's.
          ignore: {
            user: ["op"],
            block: ["r"],
            assistant: ["r"],
            entry: ["r"],
            transcript: ["r"],
            scroll: ["r"],
            smart: PROPS,
          },
          anchored: ["block", "assistant", "user"],
        },
      },
    ],
    teardown: (ctx) => ctx.clickText("sidebar", ".sidebar-row", "alpha"),
  },
  {
    name: "theme",
    description:
      "a theme switch, dark to light and back, landing in one frame on the editor and the Sidebar",
    page: "pane",
    roles: [
      ...NEOVIM_ROLES,
      { name: "ground", selector: "body, .app-shell", max: 2, colors: true },
    ],
    motionMarkers: NEOVIM_MOTION,
    setup: editorAtRest,
    steps: [
      {
        name: "to-light",
        prep: async (ctx) => {
          // The Sidebar at rest: no Workspace still marked working, whose
          // ring stopping would be a change of its own in the step.
          await ctx.waitIn("sidebar", IDLE_SIDEBAR, 30_000);
          await ctx.evalIn("pane", THEME_MARK);
        },
        act: (ctx) => ctx.setAppearance("light"),
        waitFor: THEME_CHANGED,
        pages: [
          {
            page: "pane",
            roles: [
              ...NEOVIM_ROLES,
              {
                name: "ground",
                selector: "body, .app-shell",
                max: 2,
                colors: true,
              },
            ],
            motionMarkers: NEOVIM_MOTION,
          },
          {
            page: "sidebar",
            roles: SIDEBAR_ROLES.map((r) => ({ ...r, colors: true })),
          },
        ],
        regions: {
          pane: [{ name: "editor", selector: "viewport" }],
          sidebar: [{ name: "sidebar", selector: "viewport" }],
        },
        spec: {},
      },
      {
        name: "to-dark",
        prep: async (ctx) => {
          // The Sidebar at rest: no Workspace still marked working, whose
          // ring stopping would be a change of its own in the step.
          await ctx.waitIn("sidebar", IDLE_SIDEBAR, 30_000);
          await ctx.evalIn("pane", THEME_MARK);
        },
        act: (ctx) => ctx.setAppearance("dark"),
        waitFor: THEME_CHANGED,
        pages: [
          {
            page: "pane",
            roles: [
              ...NEOVIM_ROLES,
              {
                name: "ground",
                selector: "body, .app-shell",
                max: 2,
                colors: true,
              },
            ],
            motionMarkers: NEOVIM_MOTION,
          },
          {
            page: "sidebar",
            roles: SIDEBAR_ROLES.map((r) => ({ ...r, colors: true })),
          },
        ],
        regions: {
          pane: [{ name: "editor", selector: "viewport" }],
          sidebar: [{ name: "sidebar", selector: "viewport" }],
        },
        spec: {},
      },
    ],
  },
];

/** Close every float, as one Lua call (one flush). */
function editorAtRestQuick(ctx) {
  return ctx.lua(
    "for _, w in ipairs(vim.api.nvim_list_wins()) do if vim.api.nvim_win_get_config(w).relative ~= '' then vim.api.nvim_win_close(w, true) end end",
  );
}

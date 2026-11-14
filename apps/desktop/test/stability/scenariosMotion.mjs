// The scenarios in motion: scrolls, streams and resizes, each checked on
// every frame while it moves (motionInvariants.mjs) as well as on its first
// and settled forms (invariants.mjs), and settled against a fresh redraw.
//
// A long file with what is anchored to its text: signs, diagnostics (their
// underlines are the cells', their signs too), inline virtual text (as an
// LSP's inlay hints are), folds; and a float at a buffer position (as a hover
// is), which DevHub carries with its line.
import { closeSync, openSync, writeSync } from "node:fs";
import { NEOVIM_MOTION, NEOVIM_ROLES } from "./scenarios.mjs";

const pane = {
  page: "pane",
  roles: NEOVIM_ROLES,
  motionMarkers: NEOVIM_MOTION,
};

// Things anchored to the text that the page draws (DOM): inline cards and
// popups. Floats at a buffer position come from the editor itself
// (motionRecorder.js).
const ANCHORS = [
  { name: "inline-card", selector: ".nvim-inline-card" },
  { name: "popup", selector: ".nvim-popup:not(.nvim-cmdline-floating)" },
];

/** Every frame in motion, and the settled editor against a fresh redraw. */
const motion = (spec = {}) => ({
  anchors: ANCHORS,
  fresh: ".nvim-editor",
  spec,
});

const LONG = "src/long.ts";

/** The long file, decorated, at its top, one window. */
const DECORATE = `
local buf = vim.api.nvim_get_current_buf()
vim.wo.number = true
vim.wo.signcolumn = 'yes'
vim.wo.foldmethod = 'manual'
vim.wo.wrap = false
vim.o.scrolloff = 3
local ns = vim.api.nvim_create_namespace('stability_motion')
vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
local n = vim.api.nvim_buf_line_count(buf)
local diags = {}
for l = 0, n - 1 do
  if l % 7 == 0 then
    vim.api.nvim_buf_set_extmark(buf, ns, l, 0, { sign_text = 'S', sign_hl_group = 'DiagnosticSignInfo' })
  end
  if l % 5 == 0 then
    vim.api.nvim_buf_set_extmark(buf, ns, l, 13, { virt_text = { { ': number', 'Comment' } }, virt_text_pos = 'inline' })
  end
  if l % 11 == 0 then
    table.insert(diags, { lnum = l, col = 0, end_col = 6, message = 'line ' .. l, severity = vim.diagnostic.severity.WARN })
  end
end
vim.diagnostic.set(ns, buf, diags)
vim.cmd('normal! zE')
for start = 40, n - 20, 60 do vim.cmd(start .. ',' .. (start + 8) .. 'fold') end
vim.cmd('normal! gg0')
`;

async function longFile(ctx) {
  await ctx.focus("pane");
  ctx.nvimSend("<C-\\><C-n><Esc>");
  ctx.nvimExpr(
    `execute('silent! only | silent! tabonly | silent! NvimTreeClose | silent! edit! ${LONG}')`,
  );
  ctx.lua(DECORATE);
  await ctx.settle("pane");
}

/** A float at a buffer position, as an LSP hover is: on line `lnum`. */
const HOVER = (lnum) => `
local buf = vim.api.nvim_create_buf(false, true)
vim.api.nvim_buf_set_lines(buf, 0, -1, false, { 'function value(input: number): number', '', 'Doubles and shifts.' })
vim.api.nvim_open_win(buf, false, { relative = 'win', win = vim.api.nvim_get_current_win(), bufpos = { ${lnum - 1}, 4 },
  row = 1, col = 0, width = 40, height = 3, border = 'rounded', style = 'minimal' })
`;

// A gui.document's drawing: one scroller, its blocks its items. Each
// frame it moves one way and its blocks keep their places in it (no torn
// or in-between frame); the source window follows it, a line at a time.
const DOC = ".nvim-document-scroll";
const preview = () => ({
  anchors: [],
  scrollers: [{ name: "preview", selector: DOC, items: "[data-source-line]" }],
  fresh: ".nvim-editor",
  spec: { kept: ["preview"], oneWay: ["preview"] },
});

/** At rest, the source window's top line is the line the preview has at its top. */
async function aligned(ctx) {
  const said = ctx
    .nvimExpr(
      'luaeval(\'(function() local g = require("devhub_gui"); local _, d = next(g._documents); local src = vim.fn.win_findbuf(vim.fn.bufnr("docs/preview.md"))[1]; return (d and d.view and d.view.top or -1) .. " " .. (src and vim.fn.line("w0", src) or -1) end)()\')',
    )
    .trim();
  const [preview, source] = said.split(" ").map(Number);
  return preview > 0 && preview === source
    ? []
    : [
        `the preview's top is source line ${preview}, the source window's is ${source}`,
      ];
}

const wheelOver = (ctx, notches, delta, gapMs) =>
  ctx.wheel("pane", ".nvim-editor", notches, delta, gapMs);

/**
 * A trackpad's flick: `first` px a frame, its momentum decaying by `decay`
 * a frame (as a Mac's does, fractional deltas at its tail) until under a
 * quarter pixel — about a second of events.
 */
const flick = (first, decay = 0.92) => {
  const deltas = [];
  for (let d = first; Math.abs(d) >= 0.25; d *= decay)
    deltas.push(Math.round(d * 100) / 100);
  return deltas;
};

const flickOver = (ctx, first, decay) =>
  ctx.wheelDeltas("pane", ".nvim-editor", flick(first, decay), 16);

/** A wrapped buffer: lines of one to four rows, folds among them. */
const WRAPPED = `
vim.cmd('silent! only | enew')
vim.bo.buftype = 'nofile'
vim.wo.wrap = true
vim.wo.number = true
vim.wo.foldmethod = 'manual'
local width = vim.api.nvim_win_get_width(0)
local lines = {}
for i = 1, 600 do
  local rows = (i % 5 == 0) and 3 or ((i % 3 == 0) and 2 or 1)
  local text = 'wrapped ' .. i .. ' '
  lines[i] = text .. string.rep(string.char(97 + i % 26), math.max(1, (rows - 1) * width + 10 - #text))
end
vim.api.nvim_buf_set_lines(0, 0, -1, false, lines)
vim.cmd('normal! zE')
for start = 50, 560, 70 do vim.cmd(start .. ',' .. (start + 6) .. 'fold') end
vim.cmd('normal! gg0')
`;

const MOTION = [
  {
    name: "wheel-landing",
    description:
      "the end of a wheel gesture: a flick's momentum, a mouse's notches, a slow drag, and flicks into the buffer's ends, each landing on a row as part of its own deceleration (no correction after it)",
    ...pane,
    setup: longFile,
    steps: [
      {
        name: "flick-down",
        act: (ctx) => flickOver(ctx, 37),
        motion: motion({ landing: true }),
        screencast: false,
        quietMs: 1500,
      },
      {
        name: "flick-up",
        act: (ctx) => flickOver(ctx, -30),
        motion: motion({ landing: true }),
        screencast: false,
        quietMs: 1500,
      },
      {
        name: "notches-down",
        act: (ctx) =>
          ctx.wheelDeltas("pane", ".nvim-editor", Array(6).fill(100), 35),
        motion: motion({ landing: true }),
        screencast: false,
        quietMs: 1500,
      },
      {
        name: "slow-down",
        act: (ctx) =>
          ctx.wheelDeltas("pane", ".nvim-editor", Array(40).fill(1.5), 16),
        motion: motion({ landing: true }),
        screencast: false,
        quietMs: 1500,
      },
      {
        name: "flick-into-bottom",
        prep: (ctx) =>
          ctx.nvimExpr(
            "winrestview({'topline': line('$') - winheight(0) - 12})",
          ),
        act: (ctx) => flickOver(ctx, 30),
        motion: motion({ landing: true }),
        screencast: false,
        quietMs: 1500,
      },
      {
        name: "flick-into-top",
        prep: (ctx) => ctx.nvimExpr("winrestview({'topline': 14})"),
        act: (ctx) => flickOver(ctx, -30),
        motion: motion({ landing: true }),
        screencast: false,
        quietMs: 1500,
      },
    ],
  },
  {
    name: "wheel-landing-wrap",
    description:
      "flicks over wrapped lines and folds, where a row is not a line's start: the landing is on the line Neovim can rest on",
    ...pane,
    setup: async (ctx) => {
      await ctx.focus("pane");
      ctx.nvimSend("<C-\\><C-n><Esc>");
      ctx.lua(WRAPPED);
      await ctx.settle("pane");
    },
    steps: [
      {
        name: "flick-down",
        act: (ctx) => flickOver(ctx, 37),
        motion: motion({ landing: "wrapped" }),
        screencast: false,
        quietMs: 1500,
      },
      {
        name: "flick-up",
        act: (ctx) => flickOver(ctx, -24),
        motion: motion({ landing: "wrapped" }),
        screencast: false,
        quietMs: 1500,
      },
    ],
  },
  {
    name: "scroll",
    description:
      "wheel bursts, slow and fast, and the scrolling keys, in a long file with signs, diagnostics, inline hints and folds",
    ...pane,
    setup: longFile,
    steps: [
      {
        name: "wheel-slow-down",
        act: (ctx) => wheelOver(ctx, 6, 120, 120),
        motion: motion(),
      },
      {
        name: "wheel-fast-down",
        act: (ctx) => wheelOver(ctx, 14, 120, 16),
        motion: motion(),
      },
      {
        name: "wheel-fast-up",
        act: (ctx) => wheelOver(ctx, 10, -120, 16),
        motion: motion(),
      },
      {
        name: "ctrl-d",
        act: (ctx) => ctx.press("pane", "C-d"),
        motion: motion(),
      },
      {
        name: "ctrl-u",
        act: (ctx) => ctx.press("pane", "C-u"),
        motion: motion(),
      },
      { name: "G", act: (ctx) => ctx.press("pane", "S-G"), motion: motion() },
      {
        name: "gg",
        act: (ctx) => ctx.press("pane", "g", "g"),
        motion: motion(),
      },
      {
        name: "zz",
        prep: (ctx) => ctx.nvimExpr("execute('normal! 200Gzt')"),
        act: (ctx) => ctx.press("pane", "z", "z"),
        motion: motion(),
      },
      {
        name: "search-n",
        prep: (ctx) =>
          ctx.nvimExpr("execute('normal! gg') . setreg('/', 'line9[0-9]0 ')"),
        act: (ctx) => ctx.press("pane", "n"),
        motion: motion(),
      },
      {
        name: "scrolloff-edge",
        prep: (ctx) => ctx.nvimExpr("execute('normal! ggL')"),
        act: (ctx) => ctx.press("pane", "j", "j", "j", "j"),
        motion: motion(),
      },
    ],
  },
  {
    name: "scroll-changing",
    description:
      "scrolling while the buffer changes: lines appended at the bottom, a formatter rewriting it, diagnostics arriving",
    ...pane,
    setup: longFile,
    steps: [
      {
        name: "append-while-wheeling",
        act: async (ctx) => {
          const wheel = wheelOver(ctx, 10, 120, 30);
          for (let i = 0; i < 4; i++) {
            ctx.lua(
              "vim.api.nvim_buf_set_lines(0, -1, -1, false, { 'export const appended = 1;', 'export const appended2 = 2;' })",
            );
            await new Promise((r) => setTimeout(r, 60));
          }
          await wheel;
        },
        motion: motion(),
      },
      {
        name: "rewrite-while-wheeling",
        act: async (ctx) => {
          const wheel = wheelOver(ctx, 8, -120, 30);
          await new Promise((r) => setTimeout(r, 90));
          // A formatter: the whole buffer set again, the same lines (the
          // view must not jump) with trailing spaces trimmed.
          ctx.lua(
            "local l = vim.api.nvim_buf_get_lines(0, 0, -1, false); for i, s in ipairs(l) do l[i] = s:gsub('%s+$', '') end; vim.api.nvim_buf_set_lines(0, 0, -1, false, l)",
          );
          await wheel;
        },
        motion: motion(),
      },
      {
        name: "diagnostics-mid-scroll",
        act: async (ctx) => {
          const wheel = wheelOver(ctx, 10, 120, 30);
          await new Promise((r) => setTimeout(r, 120));
          ctx.lua(
            "local ns = vim.api.nvim_create_namespace('stability_late'); local d = {}; for l = 0, vim.api.nvim_buf_line_count(0) - 1, 3 do table.insert(d, { lnum = l, col = 0, message = 'late', severity = 1 }) end; vim.diagnostic.set(ns, 0, d)",
          );
          await wheel;
        },
        motion: motion(),
      },
    ],
  },
  {
    name: "hover-scroll",
    description:
      "a float at a buffer position (a hover) while the window scrolls: it follows its line, and goes when its line is out of view",
    ...pane,
    setup: async (ctx) => {
      await longFile(ctx);
      ctx.nvimExpr("execute('normal! 30Gzt')");
      ctx.lua(HOVER(36));
      await ctx.settle("pane");
    },
    steps: [
      {
        name: "wheel-down-past",
        act: (ctx) => wheelOver(ctx, 4, 120, 60),
        motion: motion(),
      },
      {
        name: "wheel-back",
        act: (ctx) => wheelOver(ctx, 4, -120, 60),
        motion: motion(),
      },
    ],
  },
  {
    name: "split-scroll",
    description:
      "the same buffer in a vertical split, one side scrolled; a window resized while scrolled; closed",
    ...pane,
    setup: async (ctx) => {
      await longFile(ctx);
      ctx.nvimExpr("execute('normal! 120Gzt')");
      await ctx.settle("pane");
    },
    steps: [
      {
        name: "vsplit",
        act: (ctx) => ctx.press("pane", "C-w", "v"),
        motion: motion({ monotonic: false }),
      },
      {
        name: "scroll-one-side",
        act: (ctx) => wheelOver(ctx, 6, 120, 40),
        motion: motion(),
      },
      {
        name: "resize-while-scrolled",
        act: (ctx) => ctx.press("pane", "C-w", "1", "0", ">"),
        motion: motion({ monotonic: false }),
      },
      {
        name: "close",
        act: (ctx) => ctx.press("pane", "C-w", "c"),
        motion: motion({ monotonic: false }),
      },
    ],
  },
  {
    name: "folds",
    description: "folds opened and closed in a long file",
    ...pane,
    setup: async (ctx) => {
      await longFile(ctx);
      ctx.nvimExpr("execute('normal! 40Gzt')");
      await ctx.settle("pane");
    },
    steps: [
      {
        name: "open",
        act: (ctx) => ctx.press("pane", "z", "o"),
        motion: motion({ monotonic: false }),
      },
      {
        name: "close",
        act: (ctx) => ctx.press("pane", "z", "c"),
        motion: motion({ monotonic: false }),
      },
      {
        name: "open-all",
        act: (ctx) => ctx.press("pane", "z", "R"),
        motion: motion({ monotonic: false }),
      },
    ],
  },
  {
    name: "typing-reflow",
    description:
      "typing with blink's menu open in a wrapped buffer, and inserting at the top of a long one",
    ...pane,
    setup: async (ctx) => {
      await longFile(ctx);
      ctx.nvimExpr("execute('setlocal wrap | normal! 3G')");
      await ctx.press("pane", "A");
      await ctx.type("pane", " ");
      await ctx.settle("pane");
    },
    steps: [
      {
        name: "type-with-menu",
        act: (ctx) => ctx.type("pane", "value valu"),
        motion: motion({ monotonic: false }),
      },
      {
        name: "insert-at-top",
        prep: async (ctx) => {
          await ctx.press("pane", "Escape");
          ctx.nvimExpr("execute('normal! gg')");
          await ctx.press("pane", "O");
        },
        act: (ctx) =>
          ctx.type(
            "pane",
            "// a line at the top that is long enough to wrap round the window's edge once it is typed out in full here",
          ),
        motion: motion({ monotonic: false }),
      },
    ],
    teardown: (ctx) => ctx.press("pane", "Escape"),
  },
  {
    name: "tree-scrolled",
    description: "nvim-tree expanding a big folder while scrolled",
    ...pane,
    setup: async (ctx) => {
      await longFile(ctx);
      await ctx.press("pane", "F2");
      await ctx.settle("pane");
      ctx.nvimExpr("search('src', 'w')");
      await ctx.press("pane", "Enter");
      await ctx.settle("pane");
      ctx.nvimExpr("search('many', 'w')");
      await ctx.settle("pane");
    },
    steps: [
      {
        name: "expand-big",
        act: (ctx) => ctx.press("pane", "Enter"),
        motion: motion({ monotonic: false }),
      },
      {
        name: "scroll-down",
        act: (ctx) => ctx.press("pane", "C-d"),
        motion: motion(),
      },
    ],
    teardown: (ctx) => ctx.press("pane", "F2"),
  },
  {
    name: "picker-list",
    description:
      "the snacks list updating while a query is typed, and the list scrolled",
    ...pane,
    setup: async (ctx) => {
      await longFile(ctx);
      await ctx.press("pane", "C-p");
      await ctx.settle("pane");
    },
    steps: [
      {
        name: "type-query",
        act: (ctx) => ctx.type("pane", "item"),
        motion: motion({ monotonic: false }),
      },
      {
        name: "scroll-list",
        act: (ctx) => ctx.wheel("pane", ".nvim-view-frame-list", 6, 120, 40),
        motion: motion({ monotonic: false }),
      },
    ],
    teardown: (ctx) => ctx.press("pane", "Escape", "Escape"),
  },
  {
    name: "terminal-copy-mode",
    description:
      "a terminal pane streaming output while scrolled back in copy mode, then back to the bottom",
    page: "pane",
    roles: [
      { name: "pane", selector: ".control-pane, .terminal-surface", max: 6 },
    ],
    setup: async (ctx) => {
      // The Workspace's shell window, with a stream long enough to scroll.
      ctx.app.tmux("select-window", "-t", `${ctx.alphaSession()}:0`);
      await ctx.settle("pane", 600);
    },
    steps: [
      {
        name: "stream-while-scrolled-back",
        prep: async (ctx) => {
          const target = `${ctx.alphaSession()}:0`;
          // Out of any mode a run before left it in.
          ctx.app.tmux("copy-mode", "-q", "-t", target);
          ctx.app.tmux("send-keys", "-t", target, "clear; seq 1 400", "Enter");
          await new Promise((r) => setTimeout(r, 800));
          ctx.app.tmux("copy-mode", "-t", target);
          ctx.app.tmux("send-keys", "-t", target, "-X", "halfpage-up");
          await ctx.settle("pane", 600);
        },
        act: async (ctx) => {
          // Output written to the pane's terminal, as a program in it
          // would (run-shell's output is a view of its own, over the pane).
          const tty = ctx.app
            .tmux(
              "display",
              "-p",
              "-t",
              `${ctx.alphaSession()}:0`,
              "#{pane_tty}",
            )
            .trim();
          const fd = openSync(tty, "w");
          try {
            for (let i = 1; i <= 200; i += 1) {
              writeSync(fd, `stream ${String(i)}\r\n`);
              await new Promise((r) => setTimeout(r, 5));
            }
          } finally {
            closeSync(fd);
          }
          await new Promise((r) => setTimeout(r, 500));
        },
        // Scrolled back, the view does not move while output comes.
        regions: [{ name: "terminal", selector: ".terminal-surface" }],
        spec: {},
      },
      {
        name: "jump-to-bottom",
        act: (ctx) =>
          ctx.app.tmux("send-keys", "-t", `${ctx.alphaSession()}:0`, "q"),
        regions: [{ name: "terminal", selector: ".terminal-surface" }],
        spec: {},
      },
    ],
    teardown: async (ctx) => {
      ctx.app.tmux("copy-mode", "-q", "-t", `${ctx.alphaSession()}:0`);
      ctx.app.tmux(
        "send-keys",
        "-t",
        `${ctx.alphaSession()}:0`,
        "clear",
        "Enter",
      );
      ctx.app.tmux("select-window", "-t", `${ctx.alphaSession()}:1`);
      await ctx.settle("pane", 600);
    },
  },
  {
    name: "resize-mid-scroll",
    description: "a live window resize while a smooth scroll runs",
    ...pane,
    setup: longFile,
    steps: [
      {
        name: "resize-during-wheel",
        act: async (ctx) => {
          const wheel = wheelOver(ctx, 12, 120, 25);
          await ctx.resizeWindow([
            [-80, -60],
            [-160, -120],
            [0, 0],
          ]);
          await wheel;
        },
        live: true,
        motion: motion({ monotonic: false }),
      },
    ],
  },
  {
    name: "document-preview",
    description:
      "a Markdown preview (gui.document, markdown-preview.devhub) of a long file of uneven blocks: wheel bursts and keys in the preview, the source leading, each settling with the two aligned; and a selection dragged in its text",
    ...pane,
    setup: async (ctx) => {
      await ctx.focus("pane");
      ctx.nvimSend("<C-\\><C-n><Esc>");
      ctx.nvimExpr(
        "execute('silent! only | silent! tabonly | silent! NvimTreeClose | silent! edit! docs/preview.md | MarkdownPreview')",
      );
      await ctx.waitIn(
        "pane",
        "document.querySelectorAll('.nvim-document-scroll [data-source-line]').length > 40 && !!document.querySelector('.nvim-document img')",
      );
      await ctx.settle("pane", 400);
    },
    steps: [
      {
        name: "wheel-fast-down",
        act: (ctx) => ctx.wheel("pane", DOC, 14, 120, 16),
        motion: preview(),
        check: aligned,
      },
      {
        name: "wheel-slow-up",
        act: (ctx) => ctx.wheel("pane", DOC, 6, -120, 120),
        motion: preview(),
        check: aligned,
      },
      {
        name: "keys-in-preview",
        prep: (ctx) => ctx.nvimSend("<C-w>l"),
        act: async (ctx) => {
          await ctx.press("pane", "C-d");
          await new Promise((r) => setTimeout(r, 40));
          await ctx.press("pane", "C-d");
        },
        motion: preview(),
        check: aligned,
      },
      {
        name: "G-in-preview",
        act: (ctx) => ctx.press("pane", "S-G"),
        motion: preview(),
        check: aligned,
      },
      {
        name: "source-leads",
        prep: (ctx) => ctx.nvimSend("<C-w>h40Gzt"),
        act: async (ctx) => {
          await ctx.press("pane", "C-d");
          await new Promise((r) => setTimeout(r, 40));
          await ctx.press("pane", "C-d");
        },
        motion: preview(),
        check: aligned,
      },
      {
        name: "selection-drag",
        prep: (ctx) => ctx.nvimSend("1Gzt"),
        act: async (ctx) => {
          const at = await ctx.centre(
            "pane",
            ".nvim-document p",
            "Prose of section 1",
          );
          if (!at) throw new Error("no paragraph to select in");
          const client = await ctx.page("pane");
          const mouse = (type, x, y, buttons) =>
            client.send("Input.dispatchMouseEvent", {
              type,
              x,
              y,
              button: "left",
              buttons,
              clickCount: 1,
            });
          const [x, y] = at;
          await mouse("mouseMoved", x - 200, y - 20, 0);
          await mouse("mousePressed", x - 200, y - 20, 1);
          for (let k = 1; k <= 8; k++)
            await mouse("mouseMoved", x - 200 + k * 50, y - 20 + k * 5, 1);
          await mouse("mouseReleased", x + 200, y + 20, 0);
        },
        spec: { only: [] },
        check: async (ctx) => {
          const problems = [];
          const text = await ctx.evalIn("pane", "getSelection().toString()");
          if (!String(text).includes("paragraph long enough"))
            problems.push(
              `the drag selected ${JSON.stringify(text)}, not the paragraph's text`,
            );
          const mode = ctx.nvimExpr("mode()").trim();
          if (mode !== "n")
            problems.push(`the drag reached Neovim: mode ${mode}`);
          ctx.nvimSend("<Esc>");
          await ctx.evalIn("pane", "getSelection().removeAllRanges(), 1");
          return problems;
        },
      },
    ],
    teardown: (ctx) => {
      ctx.nvimExpr("execute('silent! MarkdownPreviewStop | silent! only')");
    },
  },
  {
    name: "conversation-scroll",
    description:
      "a GUI Agent streaming a long answer while the person scrolls up and down",
    page: "conversations",
    roles: [
      { name: "entry", selector: ".conversation-entry", max: 10 },
      { name: "composer", selector: ".conversation-composer-box" },
    ],
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
      // Three answers already there, so there is something to scroll.
      for (let i = 0; i < 3; i++) {
        await ctx.focusSelector(
          "conversations",
          ".conversation-composer-input",
        );
        await ctx.type("conversations", `earlier ${i}`);
        await ctx.press("conversations", "D-Enter");
        await ctx.waitIn(
          "conversations",
          `document.querySelectorAll('.conversation-assistant .conversation-message-actions').length >= ${i + 1}`,
        );
      }
      await ctx.settle("conversations");
    },
    steps: [
      {
        name: "stream-while-scrolling",
        prep: async (ctx) => {
          await ctx.focusSelector(
            "conversations",
            ".conversation-composer-input",
          );
          await ctx.type("conversations", "and the rest");
          await ctx.evalIn(
            "conversations",
            "window.__stabilityAnswers = document.querySelectorAll('.conversation-assistant').length + 1",
          );
        },
        act: async (ctx) => {
          await ctx.press("conversations", "D-Enter");
          await ctx.wheel("conversations", ".conversation-scroll", 4, -120, 80);
          await ctx.wheel("conversations", ".conversation-scroll", 4, 120, 80);
        },
        waitFor:
          "document.querySelectorAll('.conversation-assistant .conversation-message-actions').length >= window.__stabilityAnswers",
        spec: { only: [] },
        motion: {
          scrollers: [
            {
              name: "transcript",
              selector: ".conversation-scroll",
              items: ".conversation-entry",
            },
          ],
          spec: {
            kept: ["transcript"],
            aligned: false,
            monotonic: false,
            covered: false,
            rest: false,
          },
        },
      },
    ],
    teardown: (ctx) => ctx.clickText("sidebar", ".sidebar-row", "alpha"),
  },
];

/**
 * A step in motion changes what it draws every frame by design: it is held
 * to the motion invariants (`motion`) and the per-frame rules, not to the
 * discrete steps' one change, unless it says otherwise.
 */
export const MOTION_SCENARIOS = MOTION.map((scenario) => ({
  ...scenario,
  steps: scenario.steps.map((step) =>
    step.motion && step.spec === undefined
      ? { ...step, spec: { only: [] } }
      : step,
  ),
}));

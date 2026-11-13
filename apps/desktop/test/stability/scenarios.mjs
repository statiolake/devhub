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
//
// `ctx` (run.mjs) has the app, the pages, keys, clicks, the managed
// Neovim's RPC and the Workspaces' paths.

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
  { name: "view", selector: ".nvim-view", max: 6 },
  { name: "view-sticky", selector: ".nvim-view-sticky", max: 4 },
  { name: "view-item", selector: ".nvim-view-item", max: 60 },
  { name: "popup", selector: ".nvim-popup", max: 4 },
  { name: "popup-body", selector: ".nvim-popup-body", max: 4 },
  // Its text is kept (not compared): a failing frame says what it held.
  { name: "cmdline", selector: ".nvim-cmdline", text: true },
  { name: "cmdline-content", selector: ".nvim-cmdline-content" },
  { name: "cmdline-row", selector: ".nvim-cmdline-row", max: 4 },
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

// A theme landed: the page's palette variables are not what they were.
const THEME_MARK =
  "window.__stabilityPalette = document.documentElement.style.cssText";
const IDLE_SIDEBAR = `!document.querySelector('[data-status="working"], [data-status="background"]')`;
const THEME_CHANGED =
  "document.documentElement.style.cssText !== window.__stabilityPalette";

const floatSpec = { single: ["frame", "frame-edge"] };

export const SCENARIOS = [
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
            match: /^pane: \[picture\] region picker/,
            owner: "outside",
            why: "snacks.nvim flushes the picker's windows before its startinsert lands: Neovim draws one frame in Normal mode (its own -- (insert) --), so the query's caret is a block for that frame, then a bar",
          },
        ],
        act: (ctx) => ctx.press("pane", "C-p"),
        regions: [{ name: "picker", selector: ".nvim-view-frame-edge" }],
        spec: floatSpec,
      },
      {
        name: "preview-off",
        act: (ctx) => ctx.press("pane", "F4"),
        regions: [{ name: "picker", selector: ".nvim-view-frame-edge" }],
        spec: floatSpec,
      },
      {
        name: "preview-on",
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
            why: "the editor is laid out at the new width before Neovim has answered the resize: at 6x one frame shows the last grid with its edge filled to the new width, then Neovim's grid at the new size",
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
            why: "the editor is laid out at the new width before Neovim has answered the resize: at 6x one frame shows the last grid at the new width, then Neovim's grid at the new size",
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
          // The Smart Buttons' box follows the turn (idle, running, idle):
          // two causes in this one step, so it is not held to one change.
          ignore: {
            block: ["r"],
            assistant: ["r"],
            entry: ["r"],
            transcript: ["r"],
            scroll: ["r"],
            smart: ["r"],
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

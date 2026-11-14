// A window that DevHub draws a view over (`gui.view`, a framed view,
// `gui.document`) coming and going with its pane motion: every picture of
// the step shows, where the view is, the view or what is behind its window,
// never the cells of the buffer under the view (nvim-tree's own text, the
// picker's plain list, the document's Markdown source).
//
// Three pictures of the region, at rest, are the references (`viewPictures`):
// the view drawn (`view`), the view hidden, its window's cells showing
// (`cells`), and the window not there (`behind`). A pixel where the cells
// differ from both others is the cells' own; a column band of the region
// whose own pixels are mostly the cells' in some screencast frame is the
// buffer showing through. A window that goes is covered where it was, and one
// that comes is uncovered in place (`paneMotion.ts`), so the references hold
// at the same pixels while it moves.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cellBands, decodePng } from "./pixels.mjs";
import { appDir } from "./profile.mjs";
import { NEOVIM_MOTION, NEOVIM_ROLES, editorAtRest } from "./scenarios.mjs";

const neovim = {
  page: "pane",
  roles: NEOVIM_ROLES,
  motionMarkers: NEOVIM_MOTION,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** What covers a window's cells: the views, a framed view's chrome and shadow. */
const HIDE_COVERS = `(() => { const s = document.createElement("style"); s.id = "__view_close_hide"; s.textContent = ".nvim-clip-covers, .nvim-clip-shadow { visibility: hidden !important }"; document.head.append(s); })()`;
const SHOW_COVERS = `document.getElementById("__view_close_hide")?.remove()`;
const TWO_FRAMES =
  "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))))";

async function screenshot(ctx) {
  const client = await ctx.page("pane");
  await client.eval(TWO_FRAMES);
  const { data } = await client.send("Page.captureScreenshot", {
    format: "png",
  });
  return decodePng(Buffer.from(data, "base64"));
}

/** The region `selector` covers, in device pixels, or nothing. */
async function regionOf(ctx, selector) {
  const client = await ctx.page("pane");
  return client.eval(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
    if (els.length === 0) return null;
    const d = devicePixelRatio;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const el of els) {
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      x0 = Math.min(x0, b.left); y0 = Math.min(y0, b.top);
      x1 = Math.max(x1, b.right); y1 = Math.max(y1, b.bottom);
    }
    if (x0 === Infinity) return null;
    return [Math.round(x0 * d), Math.round(y0 * d), Math.round((x1 - x0) * d), Math.round((y1 - y0) * d)];
  })()`);
}

/**
 * With the view drawn: its region and the pictures `view` and `cells` of
 * it, kept for the step's check (`ctx.state.viewClose`).
 */
async function viewPictures(ctx, selector) {
  const rect = await regionOf(ctx, selector);
  if (!rect) throw new Error(`no ${selector} drawn`);
  const view = await screenshot(ctx);
  const client = await ctx.page("pane");
  await client.eval(HIDE_COVERS);
  let cells;
  try {
    cells = await screenshot(ctx);
  } finally {
    await client.eval(SHOW_COVERS);
  }
  await client.eval(TWO_FRAMES);
  ctx.state.viewClose = { ...ctx.state.viewClose, rect, view, cells };
}

/** With the window not there: the picture `behind`. */
async function behindPicture(ctx) {
  ctx.state.viewClose = {
    ...ctx.state.viewClose,
    behind: await screenshot(ctx),
  };
}

/**
 * The step's check: no screencast frame shows the buffer's cells where the
 * view is. On a failure the frames that do, and the three references, are
 * written under the stability artifacts.
 */
function noCells(stepName) {
  return async (ctx, recorded) => {
    const refs = ctx.state.viewClose;
    if (!refs?.view || !refs.cells || !refs.behind)
      return [`${stepName}: the reference pictures were not taken`];
    const { shots, actionAt } = recorded[0];
    const bad = [];
    const decoded = shots.map((s) => ({ t: s.t, png: s.png }));
    for (const [i, shot] of decoded.entries()) {
      const image = decodePng(shot.png);
      if (image.width !== refs.cells.width) {
        return [
          `${stepName}: screencast ${image.width}x${image.height} is not the screenshots' ${refs.cells.width}x${refs.cells.height}`,
        ];
      }
      const bands = cellBands(image, refs, refs.rect);
      if (bands.length > 0)
        bad.push({ i, ms: Math.round(shot.t - actionAt), bands });
    }
    if (bad.length === 0) return [];
    const dir = join(
      process.env.DEVHUB_STABILITY_ARTIFACTS ??
        join(appDir, "..", "..", ".spike", "stability"),
      "view-close",
      `${stepName}-cells`,
    );
    mkdirSync(dir, { recursive: true });
    for (const b of bad)
      writeFileSync(
        join(dir, `shot-${String(b.i).padStart(3, "0")}-${b.ms}ms.png`),
        decoded[b.i].png,
      );
    writeFileSync(join(dir, "refs.json"), JSON.stringify({ rect: refs.rect }));
    writeFileSync(
      join(dir, "frames.json"),
      JSON.stringify(recorded[0].frames, null, 1),
    );
    return [
      `pane: [cells] the buffer's cells show where its view is, in ${bad.length} of ${shots.length} pictures: ${bad
        .map(
          (b) =>
            `#${b.i} at ${b.ms} ms (${b.bands.length} bands, e.g. x=${b.bands[0].x}: ${b.bands[0].shown}/${b.bands[0].own})`,
        )
        .join(", ")}`,
    ];
  };
}

const TREE = ".nvim-view";
const PICKER = ".nvim-view-frame";
const DOCUMENT = ".nvim-document";

const DOC_LUA = `
local lines = { '# Preview', '' }
for i = 1, 40 do table.insert(lines, ('- item **%d** with \`code\` and a [link](https://example.com/%d)'):format(i, i)) end
_G.__stability_doc = package.loaded['devhub_gui'].document{ text = table.concat(lines, '\\n'), format = 'markdown', split = 'right', title = 'preview.md', enter = true }
`;

export const VIEW_CLOSE_SCENARIOS = [
  {
    name: "view-close",
    description:
      "a view's window going and coming with its pane motion: nvim-tree closed with q, opened, toggled fast; the snacks picker closed; a Markdown preview closed: never the buffer's cells where the view is",
    ...neovim,
    setup: editorAtRest,
    steps: [
      {
        name: "tree-open",
        prep: async (ctx) => {
          ctx.state.viewClose = {};
          await behindPicture(ctx);
        },
        act: (ctx) => ctx.press("pane", "F2"),
        spec: {},
        check: async (ctx, recorded) => {
          await ctx.settle("pane");
          await viewPictures(ctx, TREE);
          return noCells("tree-open")(ctx, recorded);
        },
      },
      {
        name: "tree-close-q",
        prep: async (ctx) => {
          ctx.nvimExpr("execute('NvimTreeFocus')");
          await ctx.settle("pane");
          await viewPictures(ctx, TREE);
        },
        act: (ctx) => ctx.press("pane", "q"),
        spec: {},
        check: async (ctx, recorded) => {
          await ctx.settle("pane");
          await behindPicture(ctx);
          return noCells("tree-close-q")(ctx, recorded);
        },
      },
      {
        name: "tree-toggle-fast",
        prep: async (ctx) => {
          await ctx.press("pane", "F2");
          await ctx.settle("pane");
          await viewPictures(ctx, TREE);
          await ctx.press("pane", "F2");
          await ctx.settle("pane");
          await behindPicture(ctx);
        },
        act: async (ctx) => {
          for (let i = 0; i < 4; i++) {
            await ctx.press("pane", "F2");
            await sleep(60);
          }
        },
        spec: {},
        check: noCells("tree-toggle-fast"),
      },
      {
        name: "picker-close",
        prep: async (ctx) => {
          await editorAtRest(ctx);
          await behindPicture(ctx);
          await ctx.press("pane", "C-p");
          await ctx.settle("pane", 800);
          await ctx.press("pane", "Escape");
          await ctx.settle("pane");
          await viewPictures(ctx, PICKER);
        },
        act: (ctx) => ctx.press("pane", "Escape"),
        spec: {},
        check: noCells("picker-close"),
      },
      {
        name: "document-close",
        prep: async (ctx) => {
          await editorAtRest(ctx);
          await behindPicture(ctx);
          ctx.lua(DOC_LUA);
          await ctx.settle("pane", 800);
          await viewPictures(ctx, DOCUMENT);
        },
        act: (ctx) => ctx.press("pane", "q"),
        spec: {},
        check: noCells("document-close"),
      },
    ],
  },
];

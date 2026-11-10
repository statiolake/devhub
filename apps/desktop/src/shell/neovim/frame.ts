/**
 * A float's border as a GUI frame, pure.
 *
 * Neovim draws a float's border (`'solid'`, `'rounded'`, `'single'`,
 * `'double'`, a table of characters) as whole cells around its text area.
 * DevHub draws one frame for every one of them instead (docs/neovim-editor.md,
 * "Floating surfaces"): a 1px rounded line through the middle of the
 * border's cells, half a cell from the text — the float's edge, nothing of
 * the cells outside it drawn, the windows behind showing there — with the
 * border's own ground inside it; without a border, along the cells' own
 * edge, the text reaching it. A title and footer are the cells Neovim
 * put in the border, in the columns Neovim put them, inside the frame on a
 * small tab.
 *
 * - `analyzeFrame` reads the border cells (where `win_viewport_margins`
 *   says they are) and answers the frame they make: each side's character
 *   and highlight, the corners', the labels. A border with text that is not
 *   the window's configured `title` / `footer` (or wider than a cell) is no
 *   frame, and the float is drawn cell for cell, as Neovim drew it.
 * - `frameGeometry` is where the line is, in CSS pixels on whole device
 *   pixels: centred on the middle of the border's cells, half a cell
 *   outside the text area; on a side without a border, along the cells'
 *   outer edge, inside them. DevHub adds no padding of its own: what space
 *   there is round the text is what the float's border asks for, as in the
 *   TUI.
 * - A side with a title or footer is a band (`frameBands`): its line goes
 *   along the outer edge of the label's row, not through its middle, and
 *   the label sits inside the frame, centred on its row, the line unbroken
 *   — nothing of it over what is behind the float, nothing of the line
 *   under it. The other sides' lines stay half a cell out. A pager's header
 *   across its whole side is the same band.
 * - `labelBox` is where a title or footer's text sits: centred on its row,
 *   over the cells Neovim gave it; `labelTab` the small rounded tab behind
 *   it, hugging its text, inside the line.
 */

import type { Grid, Margins } from "./redraw.js";

export type Side = "top" | "right" | "bottom" | "left";
export type Corner = "tl" | "tr" | "br" | "bl";

export const SIDES: readonly Side[] = ["top", "right", "bottom", "left"];

export interface FrameSide {
  /** The side's character (`─`, `│`, ` ` for `'solid'`, …). */
  readonly glyph: string;
  /** Its highlight (`FloatBorder`). */
  readonly hl: number;
}

/** One run of a label's text in one highlight, and the cells it takes. */
export interface LabelRun {
  readonly text: string;
  readonly hl: number;
  readonly cells: number;
}

/** A title (top) or footer (bottom) on the border's line. */
export interface FrameLabel {
  readonly side: "top" | "bottom";
  /** Its cells, in the grid's columns: the title's own blanks included. */
  readonly col: number;
  readonly cells: number;
  readonly runs: readonly LabelRun[];
}

export interface FloatFrame {
  /** The border's cells around the text area (each 0 or 1). */
  readonly margins: Margins;
  readonly sides: Readonly<Partial<Record<Side, FrameSide>>>;
  /** The corner characters, where two sides meet. */
  readonly corners: Readonly<Partial<Record<Corner, string>>>;
  readonly labels: readonly FrameLabel[];
}

/** The window's `title` and `footer` (`nvim_win_get_config`), as text. */
export interface FloatLabels {
  readonly title?: string;
  readonly footer?: string;
}

/** `nvim_win_get_config`'s `title` / `footer`: a string or `[text, hl]` chunks. */
export function labelText(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (!Array.isArray(value)) return undefined;
  let text = "";
  for (const chunk of value) {
    if (typeof chunk === "string") text += chunk;
    else if (Array.isArray(chunk) && typeof chunk[0] === "string")
      text += chunk[0];
  }
  return text.length > 0 ? text : undefined;
}

/** A config from `nvim_win_get_config` as the labels it sets. */
export function floatLabelsOf(config: unknown): FloatLabels {
  if (typeof config !== "object" || config === null) return {};
  const c = config as { title?: unknown; footer?: unknown };
  const title = labelText(c.title);
  const footer = labelText(c.footer);
  return {
    ...(title !== undefined ? { title } : {}),
    ...(footer !== undefined ? { footer } : {}),
  };
}

export type FrameAnalysis =
  | { readonly frame: FloatFrame }
  /**
   * Not a frame: drawn cell for cell. `labels` when the border holds text
   * that the window's config (not known yet, or out of date) may explain.
   */
  | { readonly frame?: undefined; readonly labels?: true };

/** The character most of `cells` are: a side's. */
function commonChar(cells: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const c of cells) counts.set(c, (counts.get(c) ?? 0) + 1);
  let best: string | undefined;
  let most = 0;
  for (const [c, n] of counts) {
    if (n > most) {
      best = c;
      most = n;
    }
  }
  return best;
}

/** Its leading and trailing blanks. */
function blanks(text: string): { lead: number; trail: number } {
  const lead = text.length - text.trimStart().length;
  const trail = text.length - text.trimEnd().length;
  return { lead, trail };
}

/**
 * The label in cells `first..last` of a border row, as Neovim sent them
 * (its blanks too), in runs of one highlight.
 */
function readLabel(
  grid: Grid,
  side: "top" | "bottom",
  row: number,
  first: number,
  last: number,
): FrameLabel | undefined {
  const at = (col: number) => grid.chars[row * grid.width + col] ?? "";
  const a = first;
  const b = last;
  if (a > b) return undefined;
  const runs: LabelRun[] = [];
  for (let col = a; col <= b; col += 1) {
    const c = at(col);
    const hl = grid.hls[row * grid.width + col] ?? 0;
    const prev = runs[runs.length - 1];
    if (prev && prev.hl === hl)
      runs[runs.length - 1] = {
        hl,
        text: prev.text + c,
        cells: prev.cells + 1,
      };
    else runs.push({ hl, text: c, cells: 1 });
  }
  return { side, col: a, cells: b - a + 1, runs };
}

/**
 * The frame a float's border draws, or why it is none. `labels` is the
 * window's title and footer, `undefined` while they are not known.
 */
export function analyzeFrame(
  grid: Grid,
  margins: Margins,
  labels: FloatLabels | undefined,
): FrameAnalysis {
  const { top, right, bottom, left } = margins;
  if (top > 1 || right > 1 || bottom > 1 || left > 1) return {};
  if (top + bottom >= grid.height || left + right >= grid.width) return {};
  const at = (row: number, col: number) => grid.chars[row * grid.width + col];
  const hlAt = (row: number, col: number) =>
    grid.hls[row * grid.width + col] ?? 0;
  const sides: Partial<Record<Side, FrameSide>> = {};
  const found: FrameLabel[] = [];
  let unexplained = false;

  // Top and bottom: one character, perhaps broken by one run of text (the
  // label: the `title` or `footer`, its own blanks included).
  const across = (side: "top" | "bottom", row: number): boolean => {
    const from = left;
    const to = grid.width - right;
    const cells: string[] = [];
    for (let col = from; col < to; col += 1) cells.push(at(row, col) ?? "");
    const glyph = commonChar(cells);
    if (glyph === undefined) return false;
    let first = -1;
    let last = -1;
    let lineHl: number | undefined;
    for (let col = from; col < to; col += 1) {
      if (at(row, col) === glyph) {
        lineHl ??= hlAt(row, col);
        continue;
      }
      if (first < 0) first = col;
      last = col;
    }
    sides[side] = { glyph, hl: lineHl ?? 0 };
    if (first < 0) return true;
    let text = "";
    for (let col = first; col <= last; col += 1) text += at(row, col) ?? "";
    const want = side === "top" ? labels?.title : labels?.footer;
    if (want === undefined || want.trim() !== text.trim()) {
      unexplained = true;
      return false;
    }
    // In a blank border the title's own blanks are the border's character:
    // they are the title's, as Neovim put them.
    const own = blanks(want);
    const seen = blanks(text);
    const start = Math.max(from, first - Math.max(0, own.lead - seen.lead));
    const end = Math.min(to - 1, last + Math.max(0, own.trail - seen.trail));
    const label = readLabel(grid, side, row, start, end);
    if (label) found.push(label);
    return true;
  };
  // Left and right: one character, nothing else.
  const down = (side: "left" | "right", col: number): boolean => {
    const cells: string[] = [];
    for (let row = top; row < grid.height - bottom; row += 1)
      cells.push(at(row, col) ?? "");
    const glyph = cells[0];
    if (glyph === undefined) return false;
    if (cells.some((c) => c !== glyph)) return false;
    sides[side] = { glyph, hl: hlAt(top, col) };
    return true;
  };

  const ok =
    (top === 0 || across("top", 0)) &&
    (bottom === 0 || across("bottom", grid.height - 1)) &&
    (left === 0 || down("left", 0)) &&
    (right === 0 || down("right", grid.width - 1));
  if (!ok) return unexplained ? { labels: true } : {};

  const corners: Partial<Record<Corner, string>> = {};
  const corner = (name: Corner, on: boolean, row: number, col: number) => {
    if (on) corners[name] = at(row, col) ?? "";
  };
  const last = grid.width - 1;
  const bottomRow = grid.height - 1;
  corner("tl", top > 0 && left > 0, 0, 0);
  corner("tr", top > 0 && right > 0, 0, last);
  corner("br", bottom > 0 && right > 0, bottomRow, last);
  corner("bl", bottom > 0 && left > 0, bottomRow, 0);
  return { frame: { margins, sides, corners, labels: found } };
}

/**
 * The sides a title or footer is on: bands, their line along the outer edge
 * of the label's row, the label inside it (`frameGeometry`, `labelBox`).
 */
export type FrameBands = Readonly<Partial<Record<"top" | "bottom", true>>>;

export function frameBands(frame: FloatFrame): FrameBands {
  const out: Partial<Record<"top" | "bottom", true>> = {};
  for (const label of frame.labels) out[label.side] = true;
  return out;
}

/**
 * Whether `label` takes every cell between its side's corners (a pager's
 * header with its count at the right end, a footer of keys across): a band
 * of its own, drawn as its cells are, with no tab behind it.
 */
export function labelFillsSide(
  label: FrameLabel,
  frame: FloatFrame,
  width: number,
): boolean {
  const inner = width - frame.margins.left - frame.margins.right;
  return label.col === frame.margins.left && label.cells === inner;
}

export interface FrameGeometry {
  /** The line's outer edges, in the editor's CSS pixels. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Each side's line, CSS pixels across. */
  readonly widths: Readonly<Record<Side, number>>;
  /**
   * The true middle of each side's line, before it is put on device
   * pixels: two members' lines fused into one are centred from these, so
   * the snapping is done once, not twice.
   */
  readonly middles: Readonly<Record<Side, number>>;
  /** Each corner's outer radius. */
  readonly radii: Readonly<Record<Corner, number>>;
}

export interface CellSize {
  readonly width: number;
  readonly height: number;
}

/** Where a box sits on the screen, in cells of grid 1. */
export interface CellPlace {
  readonly row: number;
  readonly col: number;
  readonly width: number;
  readonly height: number;
}

/** The frame's line: one CSS pixel. */
export const FRAME_LINE = 1;

/** The frame's line on whole device pixels: `FRAME_LINE`, at least one. */
export function lineWidth(dpr: number): number {
  return Math.max(1, Math.round(FRAME_LINE * dpr)) / dpr;
}

/**
 * Where a line `width` across (whole device pixels) runs when its middle is
 * at `middle`: its start and end, on device pixels, the middle within half
 * a device pixel of the true one — rounded to the nearest, never floored or
 * ceiled, so no fractional ratio or cell height moves it one way.
 */
export function lineSpan(
  middle: number,
  width: number,
  dpr: number,
): [number, number] {
  const w = Math.round(width * dpr);
  const start = Math.round(middle * dpr - w / 2);
  return [start / dpr, (start + w) / dpr];
}

/**
 * Where a float's line is: through the middle of its border's cells — the
 * top and bottom rows, the left and right columns — where Neovim draws its
 * line (`margins`, the border's cells), so the text is half a cell inside
 * it. DevHub adds no padding of its own: a side without a border has its
 * line along the cells' outer edge, inside them, the text and a row's
 * ground reaching it (the corners cut by `radius`), as a band's side does
 * (`frameBands`). The line is centred on that middle, on whole device
 * pixels (`lineSpan`), `radius` round at every corner. Nothing of the frame
 * is outside the float's cells.
 */
export function frameGeometry(
  margins: Margins,
  place: CellPlace,
  cell: CellSize,
  dpr: number,
  radius: number,
  bands: FrameBands = {},
): FrameGeometry {
  const { width: cw, height: ch } = cell;
  const m = margins;
  const line = lineWidth(dpr);
  // A side with a border: through the middle of its cells. A labelled one
  // (a band) and one without a border: along the cells' outer edge, inside
  // it — the label, or the float's own text, reaching the line.
  const left = (place.col + m.left) * cw;
  const right = (place.col + place.width - m.right) * cw;
  const top = (place.row + m.top) * ch;
  const bottom = (place.row + place.height - m.bottom) * ch;
  const middles = {
    left: m.left > 0 ? left - cw / 2 : left + line / 2,
    right: m.right > 0 ? right + cw / 2 : right - line / 2,
    top:
      m.top === 0 || bands.top === true
        ? place.row * ch + line / 2
        : top - ch / 2,
    bottom:
      m.bottom === 0 || bands.bottom === true
        ? (place.row + place.height) * ch - line / 2
        : bottom + ch / 2,
  };
  const [x0] = lineSpan(middles.left, line, dpr);
  const [, x1] = lineSpan(middles.right, line, dpr);
  const [y0] = lineSpan(middles.top, line, dpr);
  const [, y1] = lineSpan(middles.bottom, line, dpr);
  return {
    x: x0,
    y: y0,
    w: x1 - x0,
    h: y1 - y0,
    widths: { top: line, right: line, bottom: line, left: line },
    middles,
    radii: { tl: radius, tr: radius, br: radius, bl: radius },
  };
}

/** Where a label sits: centred on its row, over the cells Neovim gave it. */
export interface LabelBox {
  /** Its cells' span, CSS pixels. */
  readonly x: number;
  readonly w: number;
  /** The middle of its row. */
  readonly cy: number;
}

export function labelBox(
  label: FrameLabel,
  place: CellPlace,
  cell: CellSize,
): LabelBox {
  const cy =
    label.side === "top"
      ? (place.row + 0.5) * cell.height
      : (place.row + place.height - 0.5) * cell.height;
  return {
    x: (place.col + label.col) * cell.width,
    w: label.cells * cell.width,
    cy,
  };
}

/** A label's tab: past its text, cells across (`labelTab`). */
export const TAB_PAD = 0.5;
/** Between a tab and the line, and the tab and the row's inner edge, CSS px. */
export const TAB_GAP = 1;

/** The small rounded tab behind a label's text, in CSS pixels. */
export interface LabelTab {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly radius: number;
}

/**
 * The tab behind a title or footer's text: its ink (the label's own blanks
 * left out) and `TAB_PAD` cells each side, across; down, its row inside the
 * line, `TAB_GAP` from the line and as much from the row's inner edge, so
 * it is centred on the row and the text; on whole device pixels, rounded
 * `radius` (at most half its height), never past the frame's sides.
 * `undefined` for a label of blanks only.
 */
export function labelTab(
  label: FrameLabel,
  place: CellPlace,
  geometry: FrameGeometry,
  cell: CellSize,
  dpr: number,
  radius: number,
): LabelTab | undefined {
  const text = label.runs.map((r) => r.text).join("");
  const lead = text.length - text.trimStart().length;
  const trail = text.length - text.trimEnd().length;
  if (lead === text.length) return undefined;
  const snap = (v: number) => Math.round(v * dpr) / dpr;
  const box = labelBox(label, place, cell);
  const pad = TAB_PAD * cell.width;
  const minX = geometry.x + geometry.widths.left + TAB_GAP;
  const maxX = geometry.x + geometry.w - geometry.widths.right - TAB_GAP;
  const x0 = snap(Math.max(minX, box.x + lead * cell.width - pad));
  const x1 = snap(
    Math.min(maxX, box.x + (label.cells - trail) * cell.width + pad),
  );
  // From the line's inner edge, the same inset at both ends of the row.
  const rowTop = box.cy - cell.height / 2;
  const rowBottom = box.cy + cell.height / 2;
  const inset =
    label.side === "top"
      ? Math.max(0, geometry.y + geometry.widths.top - rowTop) + TAB_GAP
      : Math.max(
          0,
          rowBottom - (geometry.y + geometry.h - geometry.widths.bottom),
        ) + TAB_GAP;
  const y0 = snap(rowTop + inset);
  const y1 = snap(rowBottom - inset);
  const h = y1 - y0;
  return { x: x0, y: y0, w: x1 - x0, h, radius: Math.min(radius, h / 2) };
}

/**
 * Whether a title's own ground is one it chose (a pill), not the float's:
 * its luminance more than `DISTINCT_GROUND` (of 255) off the frame's
 * ground. DevHub's scheme and most others give `FloatTitle` the float's
 * ground, a cell's way of saying "inside the border".
 */
export const DISTINCT_GROUND = 12;

export function distinctGround(bg: number, ground: number): boolean {
  const lum = (c: number) =>
    0.2126 * ((c >> 16) & 255) + 0.7152 * ((c >> 8) & 255) + 0.0722 * (c & 255);
  return Math.abs(lum(bg) - lum(ground)) > DISTINCT_GROUND;
}

/** Whether `(x, y)` is inside a rounded rectangle. */
export function insideRounded(
  r: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
    readonly radii: Readonly<Record<Corner, number>>;
  },
  x: number,
  y: number,
): boolean {
  if (x < r.x || y < r.y || x >= r.x + r.w || y >= r.y + r.h) return false;
  const check = (
    rad: number,
    cx: number,
    cy: number,
    inX: boolean,
    inY: boolean,
  ) => rad <= 0 || !inX || !inY || (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad;
  const { tl, tr, br, bl } = r.radii;
  const right = r.x + r.w;
  const bottom = r.y + r.h;
  return (
    check(tl, r.x + tl, r.y + tl, x < r.x + tl, y < r.y + tl) &&
    check(tr, right - tr, r.y + tr, x > right - tr, y < r.y + tr) &&
    check(br, right - br, bottom - br, x > right - br, y > bottom - br) &&
    check(bl, r.x + bl, bottom - bl, x < r.x + bl, y > bottom - bl)
  );
}

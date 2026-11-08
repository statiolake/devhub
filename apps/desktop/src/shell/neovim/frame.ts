/**
 * A float's border of lines as a GUI frame, pure.
 *
 * Neovim draws a float's border (`rounded`, `single`, `double`, a table of
 * box-drawing characters) as whole cells around its text area, the line
 * through the middle of each: drawn cell for cell, a half-cell band of the
 * float's ground sticks out past the line on every side. DevHub draws such
 * a border as a frame instead: the float's edge is the line itself, nothing
 * of it outside — the windows behind show there — and its title and footer
 * are labels sitting on the line.
 *
 * - `analyzeFrame` reads the border cells (where `win_viewport_margins`
 *   says they are) and answers the frame they draw: each side's line
 *   glyph and highlight, the corners', the labels. Anything it does not
 *   recognise as a frame — a border of other characters, text in the
 *   border that is not the window's configured `title` / `footer` — is no
 *   frame, and the float is drawn cell for cell, as Neovim drew it.
 * - `frameGeometry` is where the lines are, in CSS pixels on whole device
 *   pixels: the same geometry `glyphShapes` draws `─ │ ╭` with, so the
 *   frame sits exactly where the cells' lines did.
 * - `labelBox` is where a title or footer sits: on its line, where Neovim
 *   put its text along it (`title_pos` included).
 */

import { boxArms, glyphKind, glyphShapes, isDashed } from "./glyphs.js";
import type { Grid, Margins } from "./redraw.js";

export type Side = "top" | "right" | "bottom" | "left";
export type Corner = "tl" | "tr" | "br" | "bl";

export const SIDES: readonly Side[] = ["top", "right", "bottom", "left"];

export interface FrameSide {
  /** The side's line character (`─`, `│`, `═`, `┄`, …). */
  readonly glyph: string;
  /** Its highlight (`FloatBorder`). */
  readonly hl: number;
}

/** One run of a label's text in one highlight. */
export interface LabelRun {
  readonly text: string;
  readonly hl: number;
}

/** A title (top) or footer (bottom) on the border's line. */
export interface FrameLabel {
  readonly side: "top" | "bottom";
  /** Its first and last non-blank cell, in the grid's columns. */
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

/** A straight line along a side: `─` for top and bottom, `│` for the sides. */
function lineGlyph(c: string, horizontal: boolean): boolean {
  const arms = boxArms(c);
  if (!arms) return false;
  return horizontal
    ? arms.e > 0 && arms.w > 0 && arms.n === 0 && arms.s === 0
    : arms.n > 0 && arms.s > 0 && arms.e === 0 && arms.w === 0;
}

/** The line character most of `cells` are, if it is one. */
function commonLine(
  cells: readonly string[],
  horizontal: boolean,
): string | undefined {
  const counts = new Map<string, number>();
  for (const c of cells) {
    if (lineGlyph(c, horizontal)) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
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

/**
 * The label in cells `first..last` of a border row: its text without the
 * blanks around it (the gap the line leaves, which DevHub draws as its own
 * padding), in runs of one highlight.
 */
function readLabel(
  grid: Grid,
  side: "top" | "bottom",
  row: number,
  first: number,
  last: number,
): FrameLabel | undefined {
  const at = (col: number) => grid.chars[row * grid.width + col] ?? "";
  let a = first;
  let b = last;
  while (a <= b && at(a) === " ") a += 1;
  while (b >= a && at(b) === " ") b -= 1;
  if (a > b) return undefined;
  const runs: LabelRun[] = [];
  for (let col = a; col <= b; col += 1) {
    const c = at(col);
    const hl = grid.hls[row * grid.width + col] ?? 0;
    const prev = runs[runs.length - 1];
    if (prev && prev.hl === hl)
      runs[runs.length - 1] = { hl, text: prev.text + c };
    else runs.push({ hl, text: c });
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

  // Top and bottom: a line, perhaps broken by one run of text (the label).
  const across = (side: "top" | "bottom", row: number): boolean => {
    const from = left;
    const to = grid.width - right;
    const cells: string[] = [];
    for (let col = from; col < to; col += 1) cells.push(at(row, col) ?? "");
    const glyph = commonLine(cells, true);
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
    if (want === undefined || want !== text) {
      unexplained = true;
      return false;
    }
    const label = readLabel(grid, side, row, first, last);
    if (label) found.push(label);
    return true;
  };
  // Left and right: a line, nothing else.
  const down = (side: "left" | "right", col: number): boolean => {
    const cells: string[] = [];
    for (let row = top; row < grid.height - bottom; row += 1)
      cells.push(at(row, col) ?? "");
    const glyph = cells[0];
    if (glyph === undefined || !lineGlyph(glyph, false)) return false;
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
    if (!on) return true;
    const c = at(row, col) ?? "";
    if (glyphKind(c) !== "box") return false;
    corners[name] = c;
    return true;
  };
  const last = grid.width - 1;
  const bottomRow = grid.height - 1;
  if (
    !corner("tl", top > 0 && left > 0, 0, 0) ||
    !corner("tr", top > 0 && right > 0, 0, last) ||
    !corner("br", bottom > 0 && right > 0, bottomRow, last) ||
    !corner("bl", bottom > 0 && left > 0, bottomRow, 0)
  ) {
    return {};
  }
  return { frame: { margins, sides, corners, labels: found } };
}

export type LineStyle = "solid" | "double" | "dashed";

export interface FrameGeometry {
  /** The lines' outer edges, in the editor's CSS pixels. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Each side's line, CSS pixels across; 0 where the side has none. */
  readonly widths: Readonly<Record<Side, number>>;
  readonly styles: Readonly<Record<Side, LineStyle>>;
  /** Each corner's outer radius: a rounded corner's arc, else 0. */
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

function styleOf(c: string): LineStyle {
  if (isDashed(c)) return "dashed";
  const arms = boxArms(c);
  return arms && Math.max(arms.n, arms.e, arms.s, arms.w) === 3
    ? "double"
    : "solid";
}

/** The device-pixel snapped extent of what `glyphShapes` draws for `c`. */
function inkOf(
  c: string,
  cell: { x: number; y: number; w: number; h: number },
  dpr: number,
  fontSize: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const shapes = glyphShapes(c, cell, dpr, fontSize) ?? [];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of shapes) {
    if (s.kind !== "rect") continue;
    x0 = Math.min(x0, s.x);
    y0 = Math.min(y0, s.y);
    x1 = Math.max(x1, s.x + s.w);
    y1 = Math.max(y1, s.y + s.h);
  }
  if (!Number.isFinite(x0)) {
    const mx = cell.x + cell.w / 2;
    const my = cell.y + cell.h / 2;
    return { x0: mx, y0: my, x1: mx, y1: my };
  }
  return { x0, y0, x1, y1 };
}

/** A rounded corner's arc radius, measured on its own outer edge. */
function arcRadius(
  c: string,
  cell: { x: number; y: number; w: number; h: number },
  dpr: number,
  fontSize: number,
): number {
  const cp = c.codePointAt(0) ?? 0;
  if (cp < 0x256d || cp > 0x2570) return 0;
  for (const s of glyphShapes(c, cell, dpr, fontSize) ?? []) {
    if (s.kind !== "stroke") continue;
    for (const op of s.path) {
      if (op[0] === "T") return op[5] + (s.lineWidth ?? 1) / 2;
    }
  }
  return 0;
}

/**
 * Where a frame's lines are: the outline that is the float's edge. A side
 * without a border ends at the text area's edge.
 */
export function frameGeometry(
  frame: FloatFrame,
  place: CellPlace,
  cell: CellSize,
  dpr: number,
  fontSize: number,
): FrameGeometry {
  const { width: cw, height: ch } = cell;
  const at = (row: number, col: number) => ({
    x: col * cw,
    y: row * ch,
    w: cw,
    h: ch,
  });
  const m = frame.margins;
  const midRow = place.row + m.top;
  const midCol = place.col + m.left;
  const lastRow = place.row + place.height - 1;
  const lastCol = place.col + place.width - 1;
  let x0 = (place.col + m.left) * cw;
  let x1 = (place.col + place.width - m.right) * cw;
  let y0 = (place.row + m.top) * ch;
  let y1 = (place.row + place.height - m.bottom) * ch;
  const widths: Record<Side, number> = { top: 0, right: 0, bottom: 0, left: 0 };
  const styles: Record<Side, LineStyle> = {
    top: "solid",
    right: "solid",
    bottom: "solid",
    left: "solid",
  };
  const { top, right, bottom, left } = frame.sides;
  if (top) {
    const ink = inkOf(top.glyph, at(place.row, midCol), dpr, fontSize);
    y0 = ink.y0;
    widths.top = ink.y1 - ink.y0;
    styles.top = styleOf(top.glyph);
  }
  if (bottom) {
    const ink = inkOf(bottom.glyph, at(lastRow, midCol), dpr, fontSize);
    y1 = ink.y1;
    widths.bottom = ink.y1 - ink.y0;
    styles.bottom = styleOf(bottom.glyph);
  }
  if (left) {
    const ink = inkOf(left.glyph, at(midRow, place.col), dpr, fontSize);
    x0 = ink.x0;
    widths.left = ink.x1 - ink.x0;
    styles.left = styleOf(left.glyph);
  }
  if (right) {
    const ink = inkOf(right.glyph, at(midRow, lastCol), dpr, fontSize);
    x1 = ink.x1;
    widths.right = ink.x1 - ink.x0;
    styles.right = styleOf(right.glyph);
  }
  const c = frame.corners;
  const radii: Record<Corner, number> = {
    tl: c.tl ? arcRadius(c.tl, at(place.row, place.col), dpr, fontSize) : 0,
    tr: c.tr ? arcRadius(c.tr, at(place.row, lastCol), dpr, fontSize) : 0,
    br: c.br ? arcRadius(c.br, at(lastRow, lastCol), dpr, fontSize) : 0,
    bl: c.bl ? arcRadius(c.bl, at(lastRow, place.col), dpr, fontSize) : 0,
  };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, widths, styles, radii };
}

/** Where a label sits: centred on its line, over the cells Neovim gave it. */
export interface LabelBox {
  /** Its text's span, CSS pixels. */
  readonly x: number;
  readonly w: number;
  /** The middle of its line. */
  readonly cy: number;
}

export function labelBox(
  label: FrameLabel,
  place: CellPlace,
  geometry: FrameGeometry,
  cell: CellSize,
): LabelBox {
  const cy =
    label.side === "top"
      ? geometry.y + geometry.widths.top / 2
      : geometry.y + geometry.h - geometry.widths.bottom / 2;
  return {
    x: (place.col + label.col) * cell.width,
    w: label.cells * cell.width,
    cy,
  };
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

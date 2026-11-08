/**
 * What of a grid is editor chrome drawn as a GUI editor draws it, rather
 * than as cells: selections and search matches as rounded shapes, status
 * lines and winbars as bars with pills, window separators as a line between
 * two windows' grounds. Pure — rows of colours in, spans out — so the
 * decisions are tested without a canvas (`chrome.test.ts`); `painter.ts`
 * draws them.
 *
 * Nothing here changes what is in a cell or where: the text, the cursor and
 * every click stay on the cells Neovim says. Only grounds are drawn
 * differently.
 */

import type { GridBox, NeovimUiState } from "./redraw";

/** Cells `[start, end)` of one row. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/** A run of cells of one shaped colour (a selection's, a match's). */
export interface ShapedSpan extends Span {
  readonly bg: number;
}

/** Which of a shape's corners are rounded: top-left, top-right, … */
export interface Corners {
  readonly tl: boolean;
  readonly tr: boolean;
  readonly br: boolean;
  readonly bl: boolean;
}

/**
 * What the painter knows of the colorscheme beyond the grid's own colours,
 * asked of Neovim by name (`THEME_LUA`) whenever highlights change.
 */
export interface PaintTheme {
  /** Backgrounds drawn as rounded shapes: `Visual`, `Search`, … */
  readonly shaped: ReadonlySet<number>;
  /**
   * `EndOfBuffer`'s foreground while `fillchars` leaves `eob:` at its
   * default `~`: those markers are not drawn, as a GUI editor shows empty
   * space past the end. `undefined` when the person chose `eob:`.
   */
  readonly eob?: number;
  /** `cmdheight`: grid 1's last rows are the command line's, no bar. */
  readonly cmdheight: number;
}

export const NO_THEME: PaintTheme = { shaped: new Set(), cmdheight: 1 };

/** The groups whose backgrounds are selections and matches. */
const SHAPED_GROUPS = [
  "Visual",
  "VisualNOS",
  "Search",
  "CurSearch",
  "IncSearch",
  "Substitute",
] as const;

/**
 * Asked with `nvim_exec_lua` (0.9+: `nvim_get_hl`): each group's colours,
 * links followed, `cmdheight` and the global `fillchars`.
 */
export const THEME_LUA = `local out = { groups = {}, cmdheight = vim.o.cmdheight, fillchars = vim.go.fillchars }
for _, name in ipairs(...) do
  local ok, hl = pcall(vim.api.nvim_get_hl, 0, { name = name, link = false })
  if ok then out.groups[name] = hl end
end
return out`;

export const THEME_GROUPS: readonly string[] = [
  ...SHAPED_GROUPS,
  "EndOfBuffer",
];

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `THEME_LUA`'s answer as a `PaintTheme`; anything odd is left out. */
export function themeOf(answer: unknown): PaintTheme {
  const out = record(answer);
  const groups = record(out?.["groups"]);
  if (!out || !groups) return NO_THEME;
  const shaped = new Set<number>();
  for (const name of SHAPED_GROUPS) {
    const hl = record(groups[name]);
    // A group drawn by `reverse` has no background of its own to match.
    if (!hl || hl["reverse"] === true) continue;
    if (typeof hl["bg"] === "number") shaped.add(hl["bg"]);
  }
  const cmdheight = typeof out["cmdheight"] === "number" ? out["cmdheight"] : 1;
  const fillchars =
    typeof out["fillchars"] === "string" ? out["fillchars"] : "";
  const eobChosen = fillchars
    .split(",")
    .some((part) => part.startsWith("eob:"));
  const eob = record(groups["EndOfBuffer"])?.["fg"];
  return {
    shaped,
    cmdheight,
    ...(!eobChosen && typeof eob === "number" ? { eob } : {}),
  };
}

export function sameTheme(a: PaintTheme, b: PaintTheme): boolean {
  return (
    a.cmdheight === b.cmdheight &&
    a.eob === b.eob &&
    a.shaped.size === b.shaped.size &&
    [...a.shaped].every((bg) => b.shaped.has(bg))
  );
}

/**
 * Where the row above (or below) runs on past `span`'s end: the inside
 * corner there is filled round, so the outline of a selection of several
 * lines is one curve, as VS Code draws it.
 */
export function spanNotches(
  span: Span,
  above: readonly Span[],
  below: readonly Span[],
): Corners {
  const covers = (spans: readonly Span[], col: number) =>
    spans.some((s) => s.start <= col && col < s.end);
  const past = (spans: readonly Span[], a: number, b: number) =>
    spans.some((s) => s.start <= Math.min(a, b) && Math.max(a, b) < s.end) &&
    covers(spans, a);
  return {
    tl: span.start > 0 && past(above, span.start - 1, span.start),
    tr: past(above, span.end, span.end - 1),
    br: past(below, span.end, span.end - 1),
    bl: span.start > 0 && past(below, span.start - 1, span.start),
  };
}

/** A row's runs of shaped colours: one span per run of one colour. */
export function shapedSpans(
  bgs: ArrayLike<number>,
  shaped: ReadonlySet<number>,
  from = 0,
  to = bgs.length,
): ShapedSpan[] {
  const out: ShapedSpan[] = [];
  let col = from;
  while (col < to) {
    const bg = bgs[col] ?? -1;
    if (!shaped.has(bg)) {
      col += 1;
      continue;
    }
    let end = col + 1;
    while (end < to && bgs[end] === bg) end += 1;
    out.push({ start: col, end, bg });
    col = end;
  }
  return out;
}

/**
 * Which corners of `span` are rounded: a corner is, unless the row above
 * (or below) has a shaped span over that corner's cell — so a selection of
 * several lines is one shape, rounded only on its outline, as VS Code draws
 * one.
 */
export function spanCorners(
  span: Span,
  above: readonly Span[],
  below: readonly Span[],
): Corners {
  const covers = (spans: readonly Span[], col: number) =>
    spans.some((s) => s.start <= col && col < s.end);
  return {
    tl: !covers(above, span.start),
    tr: !covers(above, span.end - 1),
    br: !covers(below, span.end - 1),
    bl: !covers(below, span.start),
  };
}

/** Powerline's filled separators (`  `…): joints between a bar's pills. */
export function isJoint(c: string): boolean {
  const cp = c.codePointAt(0) ?? 0;
  return c.length === 1 && cp >= 0xe0b0 && cp <= 0xe0bf && cp % 2 === 0;
}

/** A bar's pills: runs of their own colour on the bar's ground. */
export interface BarLayout {
  /** The bar's own colour: the one most of its cells have. */
  readonly ground: number;
  /** Each run of one colour that is not the ground, and how it is rounded. */
  readonly pills: readonly (ShapedSpan & {
    readonly roundLeft: boolean;
    readonly roundRight: boolean;
  })[];
  /** Powerline separator cells, drawn as the ground between pills. */
  readonly joints: readonly number[];
}

/**
 * A status line's or winbar's cells `[span)` as a bar: its ground, and the
 * segments of other colours as pills. Neighbouring segments of different
 * colours make one pill, rounded at its outer ends; a Powerline separator
 * between them (lualine's) is left out, a gap of ground, so its sections
 * read as chips instead of arrows.
 */
export function barLayout(
  chars: readonly string[],
  bgs: ArrayLike<number>,
  span: Span,
): BarLayout {
  const counts = new Map<number, number>();
  for (let col = span.start; col < span.end; col += 1) {
    const bg = bgs[col] ?? 0;
    counts.set(bg, (counts.get(bg) ?? 0) + 1);
  }
  let ground = bgs[span.start] ?? 0;
  let most = 0;
  for (const [bg, n] of counts) {
    if (n > most) {
      most = n;
      ground = bg;
    }
  }
  const joints: number[] = [];
  const pills: (ShapedSpan & { roundLeft: boolean; roundRight: boolean })[] =
    [];
  const isPill = (col: number) =>
    bgs[col] !== ground && !isJoint(chars[col] ?? "");
  let col = span.start;
  while (col < span.end) {
    if (isJoint(chars[col] ?? "")) {
      joints.push(col);
      col += 1;
      continue;
    }
    if (!isPill(col)) {
      col += 1;
      continue;
    }
    // One group of touching pills.
    const first = pills.length;
    while (col < span.end && isPill(col)) {
      const bg = bgs[col] ?? 0;
      let end = col + 1;
      while (end < span.end && bgs[end] === bg && isPill(end)) end += 1;
      pills.push({
        start: col,
        end,
        bg,
        roundLeft: false,
        roundRight: false,
      });
      col = end;
    }
    const left = pills[first];
    const right = pills[pills.length - 1];
    if (left) left.roundLeft = true;
    if (right) right.roundRight = true;
  }
  return { ground, pills, joints };
}

/** Bars, by grid and row: the cells of each that are a status line or winbar. */
export type Bars = Map<number, Map<number, Span[]>>;

/**
 * Where the status lines and winbars are. A window's status line is grid
 * 1's row under its box (`laststatus` 3's too, under the lowest windows) —
 * unless that row is another window's or the command line's (`laststatus`
 * 0 or 1) — a winbar the top margin of its own grid (0.10+
 * `win_viewport_margins`).
 */
export function barsOf(
  state: NeovimUiState,
  boxes: readonly GridBox[],
  cmdheight: number,
): Bars {
  const bars: Bars = new Map();
  const add = (grid: number, row: number, span: Span) => {
    let rows = bars.get(grid);
    if (!rows) {
      rows = new Map();
      bars.set(grid, rows);
    }
    const spans = rows.get(row) ?? [];
    spans.push(span);
    rows.set(row, spans);
  };
  const windows = boxes.filter((box) => !box.float && box.win !== undefined);
  const covered = (row: number, col: number) =>
    windows.some(
      (b) =>
        b.row <= row &&
        row < b.row + b.height &&
        b.col <= col &&
        col < b.col + b.width,
    );
  const base = state.grids.get(1);
  for (const box of windows) {
    const row = box.row + box.height;
    if (base && row < base.height - cmdheight && !covered(row, box.col)) {
      add(1, row, {
        start: box.col,
        end: Math.min(base.width, box.col + box.width),
      });
    }
    const top = state.margins.get(box.grid)?.top ?? 0;
    for (let r = 0; r < top; r += 1) {
      add(box.grid, r, { start: 0, end: box.width });
    }
  }
  return bars;
}

/** The colour most of `bgs` have. */
function commonest(bgs: readonly number[]): number | undefined {
  const counts = new Map<number, number>();
  let best: number | undefined;
  let most = 0;
  for (const bg of bgs) {
    const n = (counts.get(bg) ?? 0) + 1;
    counts.set(bg, n);
    if (n > most) {
      most = n;
      best = bg;
    }
  }
  return best;
}

/** The background a grid's cell is drawn in. */
export type BgOf = (grid: number, index: number) => number;

/** A vertical separator's cell of grid 1, between what is either side. */
export interface Separator {
  readonly row: number;
  readonly col: number;
  /** The grounds on each side of it. */
  readonly left: number;
  readonly right: number;
}

/**
 * The cells of grid 1 in a column right of a window or left of one, and
 * the grounds either side: a window's is the colour most of its cells next
 * to the column have (its `Normal`, its sign column's), so a cursor line
 * does not bleed into it; elsewhere (a status line beside) that cell's.
 * The separator's two halves continue what is beside them and only its
 * line is left between.
 */
export function separatorsOf(
  boxes: readonly GridBox[],
  width: number,
  height: number,
  bgOf: BgOf,
): Separator[] {
  const windows = boxes.filter((box) => !box.float && box.win !== undefined);
  const at = (row: number, col: number) =>
    windows.find(
      (b) =>
        b.row <= row &&
        row < b.row + b.height &&
        b.col <= col &&
        col < b.col + b.width,
    );
  // A window's ground along its first and last columns.
  const edges = new Map<number, { first: number; last: number }>();
  const edgeOf = (box: GridBox) => {
    let edge = edges.get(box.grid);
    if (!edge) {
      const first: number[] = [];
      const last: number[] = [];
      for (let row = 0; row < box.height; row += 1) {
        first.push(bgOf(box.grid, row * box.width));
        last.push(bgOf(box.grid, row * box.width + box.width - 1));
      }
      edge = { first: commonest(first) ?? 0, last: commonest(last) ?? 0 };
      edges.set(box.grid, edge);
    }
    return edge;
  };
  const columns = new Set<number>();
  for (const box of windows) {
    if (box.col + box.width < width) columns.add(box.col + box.width);
    if (box.col > 0) columns.add(box.col - 1);
  }
  const out: Separator[] = [];
  for (const col of [...columns].sort((a, b) => a - b)) {
    for (let row = 0; row < height; row += 1) {
      if (at(row, col)) continue;
      const l = at(row, col - 1);
      const r = at(row, col + 1);
      if (!l && !r) continue;
      out.push({
        row,
        col,
        left: l ? edgeOf(l).last : bgOf(1, row * width + col - 1),
        right: r ? edgeOf(r).first : bgOf(1, row * width + col + 1),
      });
    }
  }
  return out;
}

/** A separator's character: a vertical line, light or heavy, or `|`. */
export function isSeparatorLine(c: string): boolean {
  return c === "│" || c === "┃" || c === "|" || c === "║";
}

/**
 * A window row that is only an end-of-buffer `~` (the default `eob`, in
 * `EndOfBuffer`'s colour): the row past the end of the buffer.
 */
export function isEndOfBuffer(
  chars: readonly string[],
  base: number,
  width: number,
  fg: number,
  eob: number | undefined,
): boolean {
  if (eob === undefined || fg !== eob || chars[base] !== "~") return false;
  for (let col = 1; col < width; col += 1) {
    if ((chars[base + col] ?? " ") !== " ") return false;
  }
  return true;
}

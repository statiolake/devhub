/**
 * What of a grid is editor chrome drawn as a GUI editor draws it, rather
 * than as cells: selections and search matches as rounded shapes. Pure — rows of colours in, spans out — so the
 * decisions are tested without a canvas (`chrome.test.ts`); `painter.ts`
 * draws them.
 *
 * Nothing here changes what is in a cell or where: the text, the cursor and
 * every click stay on the cells Neovim says. Only grounds are drawn
 * differently.
 */

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
}

export const NO_THEME: PaintTheme = { shaped: new Set() };

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
 * links followed.
 */
export const THEME_LUA = `local out = { groups = {} }
for _, name in ipairs(...) do
  local ok, hl = pcall(vim.api.nvim_get_hl, 0, { name = name, link = false })
  if ok then out.groups[name] = hl end
end
return out`;

export const THEME_GROUPS: readonly string[] = SHAPED_GROUPS;

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
  return { shaped };
}

export function sameTheme(a: PaintTheme, b: PaintTheme): boolean {
  return (
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

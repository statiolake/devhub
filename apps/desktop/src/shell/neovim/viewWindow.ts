/**
 * A view's rows as far as they are drawn (`GuiView`, `docs/neovim-editor.md`,
 * "Components, views…"): only the rows in sight and a screen's worth either
 * side are elements; the rest are spacers of their heights. A tree of a
 * thousand rows is a hundred elements, not a thousand: the page's every hit
 * test (each mouse event) and every render walks that many.
 *
 * A row's height is its own once it has been drawn (measured), else the
 * view's `row_height`, else the drawn rows' average. Sticky rows (held at
 * the top while the rest scroll) and the focused one are always drawn: a
 * sticky row is where `position: sticky` keeps it only as an element, and
 * the focused one is revealed by its measure.
 *
 * Pure: the rows' keys and what is known of their heights in, where each
 * is and which to draw out.
 */

/** Where each row is, from the scroll's top (its padding included). */
export interface ViewLayout {
  readonly tops: readonly number[];
  readonly heights: readonly number[];
  /** Where the last row ends. */
  readonly bottom: number;
}

export function viewLayout(
  keys: readonly number[],
  measured: ReadonlyMap<number, number>,
  rowHeight: number | undefined,
  padTop: number,
): ViewLayout {
  let sum = 0;
  let count = 0;
  for (const key of keys) {
    const h = measured.get(key);
    if (h === undefined) continue;
    sum += h;
    count += 1;
  }
  const estimate = rowHeight ?? (count > 0 ? sum / count : 20);
  const tops: number[] = [];
  const heights: number[] = [];
  let at = padTop;
  for (const key of keys) {
    const h = measured.get(key) ?? estimate;
    tops.push(at);
    heights.push(h);
    at += h;
  }
  return { tops, heights, bottom: at };
}

/**
 * The rows to draw, in order: those within `overscan` pixels of the
 * viewport (`scrollTop`, `viewport` tall), the sticky ones and the focused
 * one.
 */
export function drawnRows(
  layout: ViewLayout,
  scrollTop: number,
  viewport: number,
  overscan: number,
  sticky: readonly boolean[],
  focused: number,
): number[] {
  const { tops, heights } = layout;
  const from = scrollTop - overscan;
  const to = scrollTop + viewport + overscan;
  const out = new Set<number>();
  // The first row ending past `from`, by halves.
  let lo = 0;
  let hi = tops.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((tops[mid] ?? 0) + (heights[mid] ?? 0) <= from) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < tops.length && (tops[i] ?? 0) < to; i += 1) out.add(i);
  sticky.forEach((s, i) => {
    if (s) out.add(i);
  });
  if (focused >= 0 && focused < tops.length) out.add(focused);
  return [...out].sort((a, b) => a - b);
}

/**
 * The drawn rows with the room between them: a spacer before a row that
 * does not follow the one drawn before it, and after the last.
 */
export type ViewPiece =
  | { readonly kind: "row"; readonly index: number }
  | { readonly kind: "gap"; readonly key: string; readonly height: number };

export function viewPieces(
  layout: ViewLayout,
  drawn: readonly number[],
  padTop: number,
): ViewPiece[] {
  const out: ViewPiece[] = [];
  let end = padTop;
  let prev = -1;
  for (const index of drawn) {
    const top = layout.tops[index] ?? end;
    if (top > end + 0.01)
      out.push({ kind: "gap", key: `gap:${String(prev)}`, height: top - end });
    out.push({ kind: "row", index });
    end = top + (layout.heights[index] ?? 0);
    prev = index;
  }
  if (layout.bottom > end + 0.01)
    out.push({
      kind: "gap",
      key: `gap:${String(prev)}`,
      height: layout.bottom - end,
    });
  return out;
}

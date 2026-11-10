/**
 * The text under the cursor (`docs/neovim-editor.md`, "The cursor"): the
 * cursor is a shape that moves over the text, and the characters under it
 * stay the grid's. Nothing is drawn in the cursor's own element but its
 * ground and the _ink_: the grid's cells near it painted again in the
 * cursor's colours (`GridPainter.paintCursorInk`), placed where the grid
 * shows them and cut by the cursor's shape. So when the cursor glides the
 * block slides over still text, recolouring whatever part of a glyph (half
 * of one, half of the next) it covers that frame; when the text moves under
 * a still cursor (a slide, a terminal's scroll) the ink moves with it.
 *
 * The geometry, apart from the DOM: which cells the ink holds, where it is
 * in the cursor, and the glide's keyframes with the ink's counter-glide
 * that keeps it on the text (transforms only, `docs/motion.md`).
 */

/** A rectangle in the editor's pixels (CSS px). */
export interface PxRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Cells of a grid: rows `row0` to `row1`, columns `col0` to `col1` (ends excluded). */
export interface CellSpan {
  readonly row0: number;
  readonly row1: number;
  readonly col0: number;
  readonly col1: number;
}

/** What `inkSpan` needs of a grid. */
export interface InkGrid {
  readonly width: number;
  readonly height: number;
  readonly chars: readonly string[];
}

/**
 * The cells of `grid` (its first cell at `origin`, in cells of the editor)
 * under any of `rects` — the cursor where it is and, while it glides,
 * where it was seen — and a column more each side, for an icon given two
 * cells or a glyph that overhangs its cell; a wide character is taken
 * whole. Undefined when none of the grid is under them.
 */
export function inkSpan(
  rects: readonly PxRect[],
  origin: { readonly row: number; readonly col: number },
  grid: InkGrid,
  cell: { readonly width: number; readonly height: number },
): CellSpan | undefined {
  if (rects.length === 0 || cell.width <= 0 || cell.height <= 0)
    return undefined;
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  // A hair inside the edges: a rect ending on a cell's edge is not in the
  // next cell.
  const eps = 1e-6;
  const row0 = Math.max(0, Math.floor(y0 / cell.height + eps) - origin.row);
  const row1 = Math.min(
    grid.height,
    Math.ceil(y1 / cell.height - eps) - origin.row,
  );
  let col0 = Math.max(0, Math.floor(x0 / cell.width + eps) - origin.col - 1);
  let col1 = Math.min(
    grid.width,
    Math.ceil(x1 / cell.width - eps) - origin.col + 1,
  );
  if (row0 >= row1 || col0 >= col1) return undefined;
  // A wide character's second cell is "": start at its first.
  for (;;) {
    const wideTail = (() => {
      for (let row = row0; row < row1; row += 1)
        if (col0 > 0 && grid.chars[row * grid.width + col0] === "") return true;
      return false;
    })();
    if (!wideTail) break;
    col0 -= 1;
  }
  // And end after its second.
  for (;;) {
    let tail = false;
    for (let row = row0; row < row1; row += 1)
      if (col1 < grid.width && grid.chars[row * grid.width + col1] === "")
        tail = true;
    if (!tail) break;
    col1 += 1;
  }
  return { row0, row1, col0, col1 };
}

/**
 * Lines sliding into place (`GridPainter.slideOf`): the region's rows the
 * cursor's rows show while they slide, so the ink holds them too. The
 * slide's image of the region starts `rows` rows down (`rows` up when
 * negative) and moves into place, so a row shows the region's rows from
 * `rows` above it to itself.
 */
export function slideSpan(
  span: CellSpan,
  slide: { readonly top: number; readonly bot: number; readonly rows: number },
): CellSpan {
  const lo = Math.max(slide.top, Math.min(span.row0, span.row0 - slide.rows));
  const hi = Math.min(slide.bot, Math.max(span.row1, span.row1 - slide.rows));
  if (hi <= slide.top || lo >= slide.bot) return span;
  return {
    ...span,
    row0: Math.min(span.row0, lo),
    row1: Math.max(span.row1, hi),
  };
}

/**
 * The rows a grid whose display is `off` pixels from it (`smoothScroll.ts`:
 * its canvas at `translateY(-off)`) shows at rows `row0` to `row1` of a
 * cursor that stays put, and those rows, in the grid: rows `row0 + off /
 * ch`, rounded out.
 */
export function shiftedRows(
  row0: number,
  row1: number,
  off: number,
  ch: number,
  height: number,
): { readonly row0: number; readonly row1: number } {
  const shift = ch > 0 ? off / ch : 0;
  return {
    row0: Math.max(0, Math.min(row0, Math.floor(row0 + shift))),
    row1: Math.min(height, Math.max(row1, Math.ceil(row1 + shift))),
  };
}

/**
 * Where the ink's canvas goes inside the cursor: at its cells' place in
 * the editor (`span` in a grid whose first cell is at `origin`), less the
 * cursor's own place — so it is on the text, whatever the cursor's shape.
 */
export function inkPlace(
  span: CellSpan,
  origin: { readonly row: number; readonly col: number },
  cursor: { readonly x: number; readonly y: number },
  cell: { readonly width: number; readonly height: number },
): { readonly left: number; readonly top: number } {
  return {
    left: (origin.col + span.col0) * cell.width - cursor.x,
    top: (origin.row + span.row0) * cell.height - cursor.y,
  };
}

/**
 * A glide from `d` pixels away to the cursor's cell: the cursor's
 * `translate` from `d` to nothing and the ink's from `-d` to nothing on
 * the same clock and easing, so at every frame the two add up to nothing
 * and the ink stays on the text while the shape goes over it.
 */
export function glideFrames(
  dx: number,
  dy: number,
): {
  readonly cursor: Keyframe[];
  readonly ink: Keyframe[];
} {
  return {
    cursor: [
      { translate: `${String(dx)}px ${String(dy)}px` },
      { translate: "0px 0px" },
    ],
    ink: [
      { translate: `${String(-dx)}px ${String(-dy)}px` },
      { translate: "0px 0px" },
    ],
  };
}

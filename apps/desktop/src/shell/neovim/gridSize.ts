/**
 * The grid a Neovim page's view holds: a module of its own (`mouse.ts` says
 * it again) so that main's tests check it against `overlayRect`.
 */

export interface CellSize {
  readonly width: number;
  readonly height: number;
}

/**
 * How far short of whole cells a view can be and still hold them: a view is
 * a pane's rectangle with each edge put on the nearest whole pixel
 * (`overlayRect` in `terminalNeovims.ts`), so where a cell is not a whole
 * number of pixels (16.5 on a Retina screen) it is up to a pixel short of
 * its pane's cells — and that pixel is not a row less.
 */
const EDGE_SLACK_PX = 1;

/** How many columns and rows fit in a box of this many pixels. */
export function gridSizeFor(
  width: number,
  height: number,
  cell: CellSize,
): { cols: number; rows: number } {
  return {
    cols: Math.max(10, Math.floor((width + EDGE_SLACK_PX) / cell.width)),
    rows: Math.max(3, Math.floor((height + EDGE_SLACK_PX) / cell.height)),
  };
}

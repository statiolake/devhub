/**
 * Where the widgets DevHub draws for Neovim go: pure, so tested without a page.
 */

/**
 * The completion list's cap, and its inset at each end (the band's inset,
 * `BAND_INSET`), as `neovim.css` draws them; a row is the editor's line.
 */
const PUM_MAX = 280;
const PUM_PAD = 3;

/**
 * Under the anchor cell, or over it when there is no room below — the way
 * Neovim itself flips its own menu — and never past the right edge.
 */
export function popupmenuPlace(
  area: { readonly width: number; readonly height: number },
  anchorTop: number,
  anchorLeft: number,
  cellHeight: number,
  items: number,
): { left: number; top: number; maxHeight: number } {
  const wanted = Math.min(PUM_MAX, items * cellHeight + 2 * PUM_PAD);
  const below = area.height - (anchorTop + cellHeight) - 2;
  const above = anchorTop - 2;
  const left = Math.max(0, Math.min(anchorLeft, area.width - 200));
  if (below >= wanted || below >= above) {
    return {
      left,
      top: anchorTop + cellHeight + 2,
      maxHeight: Math.max(40, below),
    };
  }
  const height = Math.min(wanted, above);
  return { left, top: anchorTop - height - 2, maxHeight: height };
}

/** The command line's text row and the columns it spans, in grid cells. */
export interface CmdlinePlace {
  /** The row the command line's text is on (0-based). */
  readonly row: number;
  /** The column its first character (`:`, `/`, …) is in. */
  readonly col: number;
  readonly cols: number;
}

/**
 * Where the command line bar is: near the top, centred, on whole cells, so
 * its text lines up with the grid under it. Cell-aligned on purpose: plugins
 * that draw next to the command line (blink.cmp's menu for `:`) are told
 * where it is through `g:ui_cmdline_pos` (`cmdlineUiPos`), and their floats
 * are cells.
 */
export function cmdlinePlace(
  gridCols: number,
  cellWidth: number,
): CmdlinePlace {
  const cols = Math.max(
    10,
    Math.min(Math.floor(680 / Math.max(1, cellWidth)), gridCols - 4),
  );
  return { row: 1, col: Math.max(0, Math.floor((gridCols - cols) / 2)), cols };
}

/**
 * `g:ui_cmdline_pos` — `[row, col]`, (1, 0)-indexed, the convention
 * noice.nvim started and blink.cmp reads — for a command line at `place`.
 * It names the row under the bar's text, so a menu a plugin opens "below
 * the command line" clears the bar's padding instead of covering it.
 */
export function cmdlineUiPos(place: CmdlinePlace): [number, number] {
  return [place.row + 2, place.col];
}

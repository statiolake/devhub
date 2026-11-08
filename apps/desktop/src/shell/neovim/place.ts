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

/** Where the command line is, in grid cells. */
export interface CmdlinePlace {
  /** The row its first line is on (0-based): a block's first, else the text's. */
  readonly row: number;
  /** The column its first character (`:`, `/`, …) is in. */
  readonly col: number;
  readonly cols: number;
  /**
   * In the rows `cmdheight` keeps at the bottom of the editor, where
   * Neovim's own command line is; else the palette near the top.
   */
  readonly bottom: boolean;
}

/** What the command line holds and where Neovim keeps room for it. */
export interface CmdlineRoom {
  /** The editor's grid (grid 1), in cells. */
  readonly gridCols: number;
  readonly gridRows: number;
  readonly cellWidth: number;
  /** `cmdheight`: the rows Neovim keeps for it at the bottom; 0 for none. */
  readonly cmdheight: number;
  /** The rows its content takes: a block's lines and the text's. */
  readonly rows?: number;
}

/**
 * Where the command line is.
 *
 * With `cmdheight` > 0 Neovim keeps rows at the bottom of the editor for
 * it, and that is where it is: on those rows, from the first column, as
 * Neovim would draw it, the editor's own line rather than a widget over the
 * text — what the person typed stays where they are used to reading it, and
 * the rows they gave it are not left empty under a palette elsewhere. Its
 * text starts on the first of them, as Neovim's does; content longer than
 * the rows (a wrapped line, `cmdline_block`) rises over the windows above,
 * as Neovim's own message area does.
 *
 * With `cmdheight=0` no row is kept: drawn at the bottom it would cover the
 * last window's last lines and status line, so it is the palette: near the
 * top, centred on whole cells, where it covers least of what is being
 * edited and the eye already goes for a command (a launcher's place).
 *
 * Both are on whole cells, so their text lines up with the grid: plugins
 * that draw next to the command line (blink.cmp's menu for `:`) are told
 * where it is through `g:ui_cmdline_pos` (`cmdlineUiPos`), and their floats
 * are cells.
 */
export function cmdlinePlace(room: CmdlineRoom): CmdlinePlace {
  const { gridCols, gridRows, cellWidth, cmdheight } = room;
  if (cmdheight > 0 && gridRows > 0) {
    const rows = Math.max(cmdheight, room.rows ?? 1);
    return {
      row: Math.max(0, gridRows - rows),
      col: 0,
      cols: Math.max(1, gridCols),
      bottom: true,
    };
  }
  const cols = Math.max(
    10,
    Math.min(Math.floor(680 / Math.max(1, cellWidth)), gridCols - 4),
  );
  return {
    row: 1,
    col: Math.max(0, Math.floor((gridCols - cols) / 2)),
    cols,
    bottom: false,
  };
}

/**
 * `g:ui_cmdline_pos` — `[row, col]`, (1, 0)-indexed, the convention
 * noice.nvim started and blink.cmp reads (its menu goes on the row after
 * it, else on the row before) — for a command line at `place`. At the
 * bottom it names the text's own row, where Neovim's command line is, so a
 * menu opens above it; for the palette, the row under the bar's text, so a
 * menu clears the bar's padding instead of covering it.
 */
export function cmdlineUiPos(place: CmdlinePlace): [number, number] {
  return place.bottom ? [place.row + 1, place.col] : [place.row + 2, place.col];
}

/**
 * Where the widgets DevHub draws for Neovim go: pure, so tested without a page.
 */

/**
 * The completion list's cap, and what it has at each end past its rows:
 * the band's inset and the 1px line (`--float-band-inset`, 2 + 1), as
 * `completionMenu.css` draws them; a row is the editor's line.
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

/**
 * The command line's completion menu (`ext_popupmenu` on grid -1) against
 * DevHub's box, not the row Neovim keeps: above the box, ending a gap over
 * its top, as Neovim's own wildmenu rises from the command line; under it
 * when there is more room there than above (a box near the top). Never
 * over the box, whose padding and line are more than the row.
 */
export function cmdlineMenuPlace(
  area: { readonly width: number; readonly height: number },
  box: { readonly top: number; readonly height: number },
  anchorLeft: number,
  cellHeight: number,
  items: number,
): { left: number; top: number; maxHeight: number } {
  const wanted = Math.min(PUM_MAX, items * cellHeight + 2 * PUM_PAD);
  const above = box.top - 2;
  const below = area.height - (box.top + box.height) - 2;
  const left = Math.max(0, Math.min(anchorLeft, area.width - 200));
  if (above >= wanted || above >= below) {
    const height = Math.max(0, Math.min(wanted, above));
    return { left, top: box.top - 2 - height, maxHeight: height };
  }
  return {
    left,
    top: box.top + box.height + 2,
    maxHeight: Math.max(0, below),
  };
}

/**
 * The command line's box, as `neovim.css` draws it: a hairline (1 px)
 * around the text, at most `BOX_PAD_Y` above and below it, `BOX_MARGIN`
 * clear of the status line or the editor's edge under it — less of both
 * when the rows kept for it are fewer: it stays inside them.
 */
export const BOX_BORDER = 1;
export const BOX_PAD_Y = 6;
const BOX_PAD_MIN = 2;
export const BOX_MARGIN = 4;

/** Where the command line is: its text on cells, its box in pixels. */
export interface CmdlinePlace {
  /**
   * The row the box starts in (0-based, whole): what `g:ui_cmdline_pos`
   * names, so a menu opened above it ends at the box's top.
   */
  readonly row: number;
  /** The column the text's first character is in. */
  readonly col: number;
  /** Cells for the text, from `col` to the box's inner right edge. */
  readonly cols: number;
  /** The box, in the editor area's pixels. */
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** Where the content's first row starts (pixels). */
  readonly textTop: number;
  /** The box's padding above and below its content (pixels). */
  readonly padY: number;
  /** The content rows that fit; what is over them is cut from the top. */
  readonly rows: number;
}

/** What the command line holds and where Neovim keeps room for it. */
export interface CmdlineRoom {
  /** The editor's grid (grid 1), in cells. */
  readonly gridCols: number;
  readonly gridRows: number;
  readonly cell: { readonly width: number; readonly height: number };
  /** `cmdheight`: the rows Neovim keeps for it at the bottom; 0 for none. */
  readonly cmdheight: number;
  /**
   * The row under the lowest window: its status line's (or the band's,
   * with no status line). With `cmdheight=0` the box sits on it.
   */
  readonly statusRow: number;
  /** The rows its content takes: a prompt's message, a block, the text. */
  readonly rows?: number;
  /** Cells the lead takes (`firstc`'s badge or a prompt), 1 if left out. */
  readonly lead?: number;
}

/**
 * Where the command line is: at the bottom, where Neovim's own is and
 * where the answers to it (the search echo, a prompt) are read, in one
 * bordered box for `:`, `/`, `?`, `=`, an `input()` and a prompt alike —
 * the same place and shape whatever is typed, only the badge differs.
 *
 * - With `cmdheight` > 0 the box is in the rows the person's config keeps
 *   for it, centred in them: those rows are where they read what they
 *   type, and are otherwise empty. It is never over the status line row
 *   above them (a footer's): where the rows are too few for its margin
 *   and padding (`cmdheight=1`), those give way and the box is the row,
 *   its text on the row's cells. Content taller than the rows (a prompt
 *   with its question, a wrapped line, `cmdline_block`) grows the box
 *   upward over the windows, as Neovim's own message area rises.
 * - With `cmdheight=0` there are no rows: the box sits on the lowest
 *   window's status line, over the window's last lines, at the bottom
 *   still, as the person's place for a command.
 *
 * The text is on whole cells (columns): plugins that draw beside it are
 * told the column (`cmdlineUiPos`), and the caret and an IME's preedit go
 * on the cell `cmdline_pos` names. Its first character is two cells in:
 * the badge (`:` or `/`) in the cell before a blank one.
 */
export function cmdlinePlace(room: CmdlineRoom): CmdlinePlace {
  const { gridCols, gridRows, cell, cmdheight } = room;
  const ch = Math.max(1, cell.height);
  const cw = Math.max(1, cell.width);
  // A long prompt (`:s///c`'s) leaves the answer room, at least 8 cells.
  const lead = Math.max(1, Math.min(room.lead ?? 1, gridCols - 11));
  const col = Math.max(1, Math.min(gridCols - 2, 1 + lead + 1));
  const left = Math.round(cw / 2);
  const width = Math.max(cw, Math.round((gridCols - 1) * cw));
  const cols = Math.max(1, gridCols - col - 1);
  const band = cmdheight > 0 && gridRows > 0;
  const bandTop = band ? (gridRows - cmdheight) * ch : 0;
  const bandHeight = cmdheight * ch;
  const bottom = band
    ? gridRows * ch - BOX_MARGIN
    : Math.max(1, Math.min(room.statusRow, gridRows)) * ch - BOX_MARGIN;
  const wanted = Math.max(1, room.rows ?? 1);
  // Content the rows kept for it hold: the box stays inside them, never
  // over the status line above (a footer's row, `statusline.ts`). Its
  // margin, then its padding, give way first: with one row the box is
  // the row and its text on the row's cells, as Neovim's.
  if (band && wanted <= cmdheight) {
    const content = wanted * ch;
    const spare = bandHeight - content - 2 * BOX_BORDER;
    const margin = Math.max(
      0,
      Math.min(BOX_MARGIN, Math.floor(spare / 2 - BOX_PAD_MIN)),
    );
    const padY = Math.min(BOX_PAD_Y, Math.floor(spare / 2 - margin));
    const height = content + 2 * (BOX_BORDER + padY);
    // Rounded only inside a margin: with none, it is the rows' own edge.
    const centred = bandTop + (bandHeight - height) / 2;
    const top = margin > 0 ? Math.round(centred) : centred;
    return {
      row: Math.max(0, Math.floor((top + BOX_BORDER + padY) / ch)),
      col,
      cols,
      left,
      top,
      width,
      height,
      textTop: top + BOX_BORDER + padY,
      rows: wanted,
      padY,
    };
  }
  // Grown over the windows: the padding it had in its rows, so it grows
  // and nothing else changes.
  const padY = band
    ? Math.max(
        BOX_PAD_MIN,
        Math.min(
          BOX_PAD_Y,
          Math.floor((bandHeight - ch - 2 * BOX_BORDER - 2 * BOX_MARGIN) / 2),
        ),
      )
    : BOX_PAD_Y;
  const chrome = 2 * (BOX_BORDER + padY);
  // Rows that fit under the editor's top (a cell and the margin clear).
  const fit = Math.max(1, Math.floor((bottom - ch - chrome) / ch));
  const rows = Math.min(fit, wanted);
  const height = rows * ch + chrome;
  const top = Math.round(bottom - height);
  return {
    row: Math.max(0, Math.floor(top / ch)),
    col,
    cols,
    left,
    top,
    width,
    height,
    textTop: top + BOX_BORDER + padY,
    rows,
    padY,
  };
}

/**
 * `g:ui_cmdline_pos` — `[row, col]`, (1, 0)-indexed, the convention
 * noice.nvim started and blink.cmp reads: the row is where the command
 * line starts (blink's menu goes on the rows before it, so it ends where
 * the box begins) and the column is `firstc`'s (blink puts a word's
 * candidates at that column plus the word's place in the text).
 */
export function cmdlineUiPos(place: CmdlinePlace): [number, number] {
  return [place.row + 1, Math.max(0, place.col - 1)];
}

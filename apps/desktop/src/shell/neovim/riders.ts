/**
 * What rides a window's text: inline images and cards, decorations and
 * popups (DOM of the page's, placed by Lua in the window's rows), drawn
 * where the text they belong to is shown, also while it scrolls in pixels
 * (`smoothScroll.ts`).
 *
 * Lua places them after the redraw that shows the state it counted in
 * (`vim.schedule` after `WinScrolled`), so a placement is counted from the
 * rows its window had scrolled as the page heard it then (`base`); it is
 * drawn moved by the rows the page has painted since (a redraw heard but
 * not yet painted counts back) and by the display's offset from Neovim's
 * grid, a transform, and cut to the window's text area: a card half out
 * of the window shows its half, as the text beside it does. Lua places
 * them beyond the window too (up to a window's height), as the display
 * shows that much past Neovim's view while it scrolls.
 *
 * An element rides with `data-ride-win` (the window), `data-ride-base`
 * and `data-ride-cut`: `"area"` (cut to the text area, the default) or a
 * row in pixels from the element's own top (`"anchor:<y>"`, a popup's
 * anchor): hidden while that row is out of the text area.
 */

/** A window's text area, in the editor's pixels. */
export interface TextArea {
  readonly top: number;
  readonly bottom: number;
}

/** How a riding element is drawn: moved by `dy`, its edges cut. */
export interface Ride {
  readonly dy: number;
  /** Pixels cut off its top and bottom (`clip-path: inset`). */
  readonly cutTop: number;
  readonly cutBottom: number;
  readonly hidden: boolean;
}

/**
 * Where an element `top`..`top + height` (its laid-out place) goes when
 * Neovim's window scrolled `rows` rows since Lua placed it and the display
 * is `off` pixels from Neovim's grid; cut to `area`.
 */
export function rideArea(
  top: number,
  height: number,
  rows: number,
  off: number,
  rowHeight: number,
  area: TextArea,
): Ride {
  const dy = -rows * rowHeight - off;
  const y = top + dy;
  const cutTop = Math.max(0, area.top - y);
  const cutBottom = Math.max(0, y + height - area.bottom);
  return {
    dy,
    cutTop,
    cutBottom,
    hidden: cutTop + cutBottom >= height,
  };
}

/** As `rideArea`, for a popup: shown while its anchor row is in `area`. */
export function rideAnchor(
  anchor: number,
  rows: number,
  off: number,
  rowHeight: number,
  area: TextArea,
): Ride {
  const dy = -rows * rowHeight - off;
  const y = anchor + dy;
  return {
    dy,
    cutTop: 0,
    cutBottom: 0,
    hidden: y < area.top - 0.5 || y + rowHeight > area.bottom + 0.5,
  };
}

/**
 * A ride as styles: a transform and a cut (all of it when hidden: the
 * element's own `visibility` stays the page's).
 */
export function rideStyle(ride: Ride): {
  transform: string;
  clipPath: string;
} {
  const cut = ride.cutTop > 0 || ride.cutBottom > 0;
  return {
    transform: ride.dy === 0 ? "" : `translateY(${String(ride.dy)}px)`,
    clipPath: ride.hidden
      ? "inset(50%)"
      : cut
        ? `inset(${String(ride.cutTop)}px 0 ${String(ride.cutBottom)}px 0)`
        : "",
  };
}

/** Where a float at a buffer position is as asked (`nvim_win_get_config`). */
export interface BufposAnchor {
  /** Its line, 0-based (`bufpos[0]`). */
  readonly line: number;
  /** Its rows from that line (`row`). */
  readonly row: number;
}

/** Where such a float was when its line was last in Neovim's view. */
export interface FloatRef {
  /** Its `anchor_row` (`win_float_pos`) then. */
  readonly row: number;
  /** The rows its anchor window had scrolled then, as painted. */
  readonly painted: number;
}

/**
 * The rows to move a float at a buffer position from where Neovim put it.
 * Neovim pins one whose line has left its view to the window's top edge;
 * led past the display (`smoothScroll.ts`), Neovim has often left a line
 * the display still shows. Then the float is where it was when its line
 * was last in view, moved by the rows scrolled since, as long as that line
 * is on the display (`lineAt`: its row there, in rows from the grid's top,
 * `off` taken in); off it, where Neovim pins it, as at rest.
 *
 * Answers the rows, and the reference to keep (`undefined`: none yet).
 */
export function pinnedRows(input: {
  readonly anchor: BufposAnchor;
  readonly anchorRow: number;
  readonly painted: number;
  /** Neovim's view: `topline` and `botline` (`win_viewport`, 0-based). */
  readonly topline: number;
  readonly botline: number;
  readonly ref: FloatRef | undefined;
  /** The display's offset from Neovim's grid, in rows (down positive). */
  readonly off: number;
  /** The rows of the window's text area. */
  readonly textRows: number;
}): { rows: number; ref: FloatRef | undefined } {
  const { anchor, anchorRow, painted, ref } = input;
  const inView = anchor.line >= input.topline && anchor.line < input.botline;
  if (inView) return { rows: 0, ref: { row: anchorRow, painted } };
  if (!ref) return { rows: 0, ref };
  const row = ref.row - (painted - ref.painted);
  const lineAt = row - anchor.row - input.off;
  if (lineAt <= -1 || lineAt >= input.textRows) return { rows: 0, ref };
  return { rows: row - anchorRow, ref };
}

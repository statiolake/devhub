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

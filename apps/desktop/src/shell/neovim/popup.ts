/**
 * Where a popup (`gui.popup`, a hover) goes, pure: under its anchor's cell or
 * above it, whichever has room — the side asked for first, the other when
 * the popup does not fit and the other side has more room — as tall as its
 * content up to its maximum and the room it has (more scrolls inside), and
 * kept on the editor horizontally. All in the editor's pixels.
 */

import type { PopupPlacement } from "./layers";

export interface PopupLayout {
  readonly left: number;
  readonly top: number;
  /** The popup's height: what it shows of its content. */
  readonly height: number;
  readonly side: "below" | "above";
  /** The content is taller than the popup: it scrolls. */
  readonly scrolls: boolean;
}

/** Pixels between the anchor's cell and the popup; kept from the edges. */
export const POPUP_GAP = 2;
export const POPUP_MARGIN = 4;

export function placePopup(input: {
  /**
   * The anchor cell's top-left, and the cell's height — or the command
   * line's box (`anchor = 'cmdline'`): its top, and its whole height, so
   * the popup is above or under it and never over it.
   */
  readonly anchor: { readonly x: number; readonly y: number };
  readonly cellHeight: number;
  /** The content's size at the popup's width. */
  readonly size: { readonly width: number; readonly height: number };
  /** The editor's area. */
  readonly area: { readonly width: number; readonly height: number };
  readonly placement: PopupPlacement;
  /** The most it may be, in pixels (its owner's max_height). */
  readonly maxHeight?: number | undefined;
}): PopupLayout {
  const { anchor, cellHeight, size, area } = input;
  const max = Math.min(input.maxHeight ?? Infinity, area.height);
  const want = Math.min(size.height, max);
  const below = Math.max(
    0,
    area.height - (anchor.y + cellHeight) - POPUP_GAP - POPUP_MARGIN,
  );
  const above = Math.max(0, anchor.y - POPUP_GAP - POPUP_MARGIN);
  const first = input.placement === "above" ? "above" : "below";
  const room = (side: "below" | "above") => (side === "below" ? below : above);
  const other = first === "below" ? "above" : "below";
  const side =
    room(first) >= want || room(first) >= room(other) ? first : other;
  const height = Math.max(0, Math.min(want, room(side)));
  const top =
    side === "below"
      ? anchor.y + cellHeight + POPUP_GAP
      : anchor.y - POPUP_GAP - height;
  const left = Math.max(
    POPUP_MARGIN,
    Math.min(anchor.x, area.width - POPUP_MARGIN - size.width),
  );
  return {
    left,
    top,
    height,
    side,
    scrolls: size.height > height + 0.5,
  };
}

/** The popup's widest, in pixels: its owner's max_width, or 80 cells, on the editor. */
export function popupMaxWidth(
  maxWidth: number | undefined,
  cellWidth: number,
  areaWidth: number,
): number {
  return Math.max(
    40,
    Math.min((maxWidth ?? 80) * cellWidth, areaWidth - 2 * POPUP_MARGIN),
  );
}

/**
 * Where a scroll Neovim asked for (the popup's keys) takes the content's
 * scrollTop: a line is a line of its text, half and page are of its height.
 */
export function popupScrollTop(
  current: number,
  scroll: { readonly by: string; readonly n: number },
  view: {
    readonly height: number;
    readonly content: number;
    readonly line: number;
  },
): number {
  const max = Math.max(0, view.content - view.height);
  let next = current;
  if (scroll.by === "line") next = current + scroll.n * view.line;
  else if (scroll.by === "half") next = current + (scroll.n * view.height) / 2;
  else if (scroll.by === "page")
    next = current + scroll.n * (view.height - view.line);
  else if (scroll.by === "top") next = 0;
  else if (scroll.by === "bottom") next = max;
  return Math.min(max, Math.max(0, next));
}

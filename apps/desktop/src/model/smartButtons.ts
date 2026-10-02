/**
 * Where an Agent pane's Smart Buttons stand.
 *
 * The box has a default spot per presentation — attached to the top right of
 * a GUI Agent's composer, in the bottom right corner of a terminal above what
 * became of a queued message — and a person may drag it anywhere in the pane.
 * Where they put it is remembered per presentation, not per Agent: it is a
 * preference about how a kind of pane is laid out ("not over my prompt"),
 * which every terminal Agent shares, and one that had to be made again for
 * each new Agent would be one nobody makes. Absent is the default spot, and
 * going back to it (a double-click on the handle) is forgetting the spot,
 * so there is no copy of the default anywhere to go stale.
 *
 * **Anchored or free.** What is remembered is a *spot*. An anchored spot is
 * attached to what the default spot stands on — the *anchor*: a GUI Agent's
 * composer, a terminal's queued-message status or, with none, its bottom
 * right corner — on one of the anchor's edges (`top`: standing on it;
 * `side`: beside its right edge), `along` pixels in from the anchor's right
 * (top) or bottom (side) edge. It is measured from the anchor every time it
 * is drawn, so a composer that grows as a prompt is typed carries the box up
 * with it. A drag that comes within `SMART_BUTTONS_SNAP` pixels of one of
 * those edges snaps to it and is dropped anchored (`snapSpot`); one that ends
 * anywhere else is free. The default spot is anchored: on the top edge,
 * `inset` in.
 *
 * A free spot is an offset: the box's distance from the pane's right and
 * bottom edges, in whole CSS pixels — the corner a pane grows away from, so
 * a box put near the prompt stays near the prompt as the window is resized.
 * It has the shape every stored spot had before anchoring existed, so a state
 * file written then reads as the free places it always meant.
 *
 * What is stored is what the person chose; what is drawn is that, clamped to
 * the pane as it is now (`clampOffset`), so a window made smaller never hides
 * the box and made larger again puts it back where it was.
 *
 * Kept by main beside the split's ratio (`AppModel`, `state.json`), because a
 * layout the person arranged is main's to remember, and a page that kept its
 * own would lose it with every reload of the page.
 */

import type { AgentPresentation } from "./domain.js";

export interface SmartButtonsOffset {
  readonly right: number;
  readonly bottom: number;
}

export type SmartButtonsEdge = "top" | "side";

/** Attached to the anchor's edge, `along` pixels in from its far corner. */
export interface SmartButtonsAnchored {
  readonly anchored: SmartButtonsEdge;
  readonly along: number;
}

/** Where a box is: anchored to the composer (or corner), or a free offset. */
export type SmartButtonsSpot = SmartButtonsOffset | SmartButtonsAnchored;

export function isAnchoredSpot(
  spot: SmartButtonsSpot,
): spot is SmartButtonsAnchored {
  return "anchored" in spot;
}

/** The spot a person dragged each presentation's box to, if they did. */
export type SmartButtonsPlacement = Readonly<
  Partial<Record<AgentPresentation, SmartButtonsSpot>>
>;

/**
 * Larger than any display, and small enough that a number past it is a bug
 * rather than a screen: the state file refuses it rather than drawing a box
 * nobody can reach until the clamp brings it back.
 */
export const SMART_BUTTONS_MAX_OFFSET = 100_000;

function isPixels(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= SMART_BUTTONS_MAX_OFFSET
  );
}

/** Whether this is an offset a box can be at: whole pixels, in range. */
export function isSmartButtonsOffset(value: SmartButtonsOffset): boolean {
  return isPixels(value.right) && isPixels(value.bottom);
}

/** Whether this is a spot a box can be at. */
export function isSmartButtonsSpot(value: SmartButtonsSpot): boolean {
  if (isAnchoredSpot(value)) {
    return (
      (value.anchored === "top" || value.anchored === "side") &&
      isPixels(value.along) &&
      Object.keys(value).length === 2
    );
  }
  return isSmartButtonsOffset(value);
}

/** The spot, with nothing but its own fields (for the wire and the file). */
export function copySpot(spot: SmartButtonsSpot): SmartButtonsSpot {
  return isAnchoredSpot(spot)
    ? { anchored: spot.anchored, along: spot.along }
    : { right: spot.right, bottom: spot.bottom };
}

/** Whether two spots are the same place. */
export function sameSpot(
  a: SmartButtonsSpot | undefined,
  b: SmartButtonsSpot | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (isAnchoredSpot(a) || isAnchoredSpot(b)) {
    return (
      isAnchoredSpot(a) &&
      isAnchoredSpot(b) &&
      a.anchored === b.anchored &&
      a.along === b.along
    );
  }
  return a.right === b.right && a.bottom === b.bottom;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** A rectangle as `getBoundingClientRect` gives it. */
export interface Box {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/**
 * The offset, moved so the whole box is inside the pane.
 *
 * A pane smaller than the box keeps its right and bottom edges, which is where
 * the default spot is: the buttons that fit are the ones nearest the prompt.
 */
export function clampOffset(
  offset: SmartButtonsOffset,
  pane: Size,
  box: Size,
): SmartButtonsOffset {
  const within = (value: number, room: number) =>
    Math.round(Math.min(Math.max(value, 0), Math.max(room, 0)));
  return {
    right: within(offset.right, pane.width - box.width),
    bottom: within(offset.bottom, pane.height - box.height),
  };
}

/**
 * Where a drag has taken the box: the offset it started from, moved by how
 * far the pointer went, clamped. The offset counts from the right and bottom,
 * so a pointer moving right or down makes it smaller.
 */
export function draggedOffset(
  start: SmartButtonsOffset,
  moved: { readonly x: number; readonly y: number },
  pane: Size,
  box: Size,
): SmartButtonsOffset {
  return clampOffset(
    { right: start.right - moved.x, bottom: start.bottom - moved.y },
    pane,
    box,
  );
}

/**
 * How far from where it went down a pointer has to move before the press is a
 * drag. Under it the handle was pressed, not moved — a double-click to reset
 * is two of those — and nothing is remembered.
 */
export const SMART_BUTTONS_DRAG_THRESHOLD = 3;

/** The gap between a terminal pane's corner and the box, as `--space-3`. */
export const SMART_BUTTONS_MARGIN = 12;

/**
 * How near an anchor's edge, in pixels, a dragged box has to come to snap to
 * it: a trackpad's slack, and less than one button's height, so a box can
 * still be put just clear of the composer.
 */
export const SMART_BUTTONS_SNAP = 16;

/** How the box meets what it stands on. */
export interface SmartButtonsSpacing {
  /** The default `along` on the top edge: past a composer's rounded corner. */
  readonly inset: number;
  /** The gap between the anchor's edge and the box. */
  readonly gap: number;
}

/**
 * What a box is anchored to: the element, or with none (a terminal with no
 * queued-message status) a line `SMART_BUTTONS_MARGIN` above the pane's
 * bottom edge, ending as far in from its right — less the gap, so standing
 * on it at its right end is that corner.
 */
export function anchorBox(
  pane: Box,
  anchor: Box | undefined,
  spacing: SmartButtonsSpacing,
): Box {
  if (anchor !== undefined) return anchor;
  const right = pane.right - SMART_BUTTONS_MARGIN;
  const top = pane.bottom - SMART_BUTTONS_MARGIN + spacing.gap;
  return { top, right, bottom: top, left: pane.left + SMART_BUTTONS_MARGIN };
}

/** The offset an anchored spot is at, given where the anchor is now. */
export function anchoredOffset(
  spot: SmartButtonsAnchored,
  pane: Box,
  anchor: Box,
  box: Size,
  spacing: SmartButtonsSpacing,
): SmartButtonsOffset {
  if (spot.anchored === "top") {
    return {
      right: Math.round(pane.right - anchor.right + spot.along),
      bottom: Math.round(pane.bottom - anchor.top + spacing.gap),
    };
  }
  return {
    right: Math.round(pane.right - anchor.right - spacing.gap - box.width),
    bottom: Math.round(pane.bottom - anchor.bottom + spot.along),
  };
}

/** The offset a spot — anchored or free — is at, before the clamp. */
export function spotOffset(
  spot: SmartButtonsSpot,
  pane: Box,
  anchor: Box,
  box: Size,
  spacing: SmartButtonsSpacing,
): SmartButtonsOffset {
  return isAnchoredSpot(spot)
    ? anchoredOffset(spot, pane, anchor, box, spacing)
    : spot;
}

/** The default spot: standing on the anchor, `inset` in from its right. */
export function defaultSpot(
  spacing: SmartButtonsSpacing,
): SmartButtonsAnchored {
  return { anchored: "top", along: spacing.inset };
}

/**
 * Where a box dragged to `offset` belongs: anchored to an edge of the anchor
 * it is within `SMART_BUTTONS_SNAP` of, or free at that offset.
 *
 * The top edge catches a box whose bottom is near the anchor's top and that
 * overlaps the anchor across; `along` keeps where across it was, never past
 * the anchor's right edge. The side edge catches a box whose left is near the
 * anchor's right and that overlaps it up and down — seldom room for it beside
 * a full-width composer, but a narrow one has it. The nearer edge wins, the
 * top on a tie.
 */
export function snapSpot(
  offset: SmartButtonsOffset,
  pane: Box,
  anchor: Box,
  box: Size,
  spacing: SmartButtonsSpacing,
): SmartButtonsSpot {
  const boxRight = pane.right - offset.right;
  const boxBottom = pane.bottom - offset.bottom;
  const boxLeft = boxRight - box.width;
  const boxTop = boxBottom - box.height;
  // Overlapping counts touching, so a zero-size anchor (a corner) has a box
  // that reaches it.
  const across = boxLeft <= anchor.right && boxRight >= anchor.left;
  const upDown = boxTop <= anchor.bottom && boxBottom >= anchor.top;
  const toTop = Math.abs(boxBottom - (anchor.top - spacing.gap));
  const toSide = Math.abs(boxLeft - (anchor.right + spacing.gap));
  const top = across && toTop <= SMART_BUTTONS_SNAP ? toTop : Infinity;
  const side = upDown && toSide <= SMART_BUTTONS_SNAP ? toSide : Infinity;
  if (top === Infinity && side === Infinity) return offset;
  const along = (value: number) =>
    Math.min(Math.max(Math.round(value), 0), SMART_BUTTONS_MAX_OFFSET);
  if (top <= side) {
    return { anchored: "top", along: along(anchor.right - boxRight) };
  }
  return { anchored: "side", along: along(anchor.bottom - boxBottom) };
}

/**
 * The default spot's offset, out of what it is attached to.
 *
 * A GUI Agent's box sits on its composer's top edge, touching it, its right
 * edge inset past the composer's rounded corner (`inset`). A terminal's sits
 * in the pane's bottom right corner — above the queued-message status when
 * there is one, which is `anchor` then — `SMART_BUTTONS_MARGIN` from the
 * edges. With no anchor at all it is that corner.
 */
export function defaultOffset(
  pane: Box,
  anchor: Box | undefined,
  spacing: SmartButtonsSpacing,
): SmartButtonsOffset {
  if (anchor === undefined) {
    return { right: SMART_BUTTONS_MARGIN, bottom: SMART_BUTTONS_MARGIN };
  }
  return anchoredOffset(
    defaultSpot(spacing),
    pane,
    anchor,
    { width: 0, height: 0 },
    spacing,
  );
}

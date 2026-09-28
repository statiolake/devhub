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
 * going back to it (a double-click on the handle) is forgetting the offset,
 * so there is no copy of the default anywhere to go stale.
 *
 * An offset is the box's distance from the pane's right and bottom edges, in
 * whole CSS pixels: the corner a pane grows away from, so a box put near the
 * prompt stays near the prompt as the window is resized. What is stored is
 * what the person chose; what is drawn is that, clamped to the pane as it is
 * now (`clampOffset`), so a window made smaller never hides the box and made
 * larger again puts it back where it was.
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

/** The offset a person dragged each presentation's box to, if they did. */
export type SmartButtonsPlacement = Readonly<
  Partial<Record<AgentPresentation, SmartButtonsOffset>>
>;

/**
 * Larger than any display, and small enough that a number past it is a bug
 * rather than a screen: the state file refuses it rather than drawing a box
 * nobody can reach until the clamp brings it back.
 */
export const SMART_BUTTONS_MAX_OFFSET = 100_000;

/** Whether this is an offset a box can be at: whole pixels, in range. */
export function isSmartButtonsOffset(value: SmartButtonsOffset): boolean {
  return [value.right, value.bottom].every(
    (edge) =>
      Number.isInteger(edge) && edge >= 0 && edge <= SMART_BUTTONS_MAX_OFFSET,
  );
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
 * The default spot, out of what it is attached to.
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
  spacing: { readonly inset: number; readonly gap: number },
): SmartButtonsOffset {
  if (anchor === undefined) {
    return { right: SMART_BUTTONS_MARGIN, bottom: SMART_BUTTONS_MARGIN };
  }
  return {
    right: Math.round(pane.right - anchor.right + spacing.inset),
    bottom: Math.round(pane.bottom - anchor.top + spacing.gap),
  };
}

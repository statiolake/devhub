/**
 * A wheel gesture over an Agent surface, in the terms the provider takes.
 *
 * The emulator's own wheel handling is dead on this surface and cannot be
 * revived: Herdr renders the agent's grid itself and sends the result as a
 * cursor-addressed repaint, so no line ever leaves the top of the local buffer
 * and there is no local scrollback to move. The scrollback is Herdr's. What a
 * notch means is Herdr's too — a TUI that asked for mouse reporting is handed
 * an encoded wheel event at the cell the pointer was over, one on the
 * alternate screen without it is handed arrow keys, and a plain shell moves
 * Herdr's viewport — so this translates the gesture and decides nothing else.
 *
 * A trackpad delivers a stream of sub-line deltas, so the remainder is carried
 * across events rather than rounded away; without that, a slow gesture reports
 * zero lines every time and reads as a dead surface all over again.
 */

import { MAX_SCROLL_LINES, type ScrollDirection } from "../../ipc/agent.js";

/** What one gesture asks of the provider. Cells, never pixels. */
export interface WheelScroll {
  readonly direction: ScrollDirection;
  readonly lines: number;
  readonly column: number;
  readonly row: number;
  readonly modifiers: number;
}

/** The box the gesture happened over, and the grid drawn in it. */
export interface WheelGeometry {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly cols: number;
  readonly rows: number;
}

/** What `WheelEvent.deltaMode` says the delta is counted in. */
const DELTA_LINE = 1;
const DELTA_PAGE = 2;

/**
 * Carries the part of a gesture too small to be a whole line yet.
 *
 * One per surface: the residual belongs to the pointer's travel over that
 * surface, and pooling it across surfaces would make one pane's slow scroll
 * finish inside another.
 */
export class WheelAccumulator {
  #residual = 0;

  /**
   * The scroll this event asks for, or `undefined` when the gesture has not
   * yet accumulated a whole line.
   */
  take(event: WheelEvent, geometry: WheelGeometry): WheelScroll | undefined {
    const rowHeight =
      geometry.rows > 0 && geometry.height > 0
        ? geometry.height / geometry.rows
        : 0;
    // Whatever the browser counted the delta in, the residual is kept in rows:
    // one accumulator serves a mouse's line notches, a trackpad's pixels and a
    // page gesture without three separate carries to keep straight.
    const rowsPerUnit =
      event.deltaMode === DELTA_PAGE
        ? Math.max(1, geometry.rows)
        : event.deltaMode === DELTA_LINE
          ? 1
          : rowHeight > 0
            ? 1 / rowHeight
            : 0;
    if (rowsPerUnit === 0 || !Number.isFinite(event.deltaY)) {
      return undefined;
    }
    // A reversal is a new gesture, not a continuation of the old one.
    if (
      this.#residual !== 0 &&
      Math.sign(event.deltaY) !== Math.sign(this.#residual)
    ) {
      this.#residual = 0;
    }
    this.#residual += event.deltaY * rowsPerUnit;
    const lines = Math.trunc(this.#residual);
    if (lines === 0) {
      return undefined;
    }
    this.#residual -= lines;
    return {
      // A positive deltaY is content moving up past the pointer, which is a
      // scroll towards newer output — down, in the provider's words.
      direction: lines > 0 ? "down" : "up",
      lines: Math.min(MAX_SCROLL_LINES, Math.abs(lines)),
      ...cell(event, geometry),
      modifiers: modifierBits(event),
    };
  }

  /** The pointer left, or the surface was replaced: the gesture is over. */
  reset(): void {
    this.#residual = 0;
  }
}

/** The grid cell the pointer was over, clamped into the grid. */
function cell(
  event: WheelEvent,
  geometry: WheelGeometry,
): { readonly column: number; readonly row: number } {
  const columnWidth = geometry.cols > 0 ? geometry.width / geometry.cols : 0;
  const rowHeight = geometry.rows > 0 ? geometry.height / geometry.rows : 0;
  return {
    column: clamp(
      columnWidth > 0
        ? Math.floor((event.clientX - geometry.left) / columnWidth)
        : 0,
      geometry.cols,
    ),
    row: clamp(
      rowHeight > 0
        ? Math.floor((event.clientY - geometry.top) / rowHeight)
        : 0,
      geometry.rows,
    ),
  };
}

function clamp(value: number, extent: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(Math.max(0, extent - 1), value));
}

/** Crossterm's modifier bitset, which is what the provider's frame carries. */
function modifierBits(event: WheelEvent): number {
  return (
    (event.shiftKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    ((event.altKey ? 1 : 0) << 2)
  );
}

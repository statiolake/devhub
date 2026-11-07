/**
 * The pointer, as `nvim_input_mouse` calls.
 *
 * Pure: a point in the editor's own pixels, the cell size and the grids'
 * boxes (`layoutGrids`) in, the grid and cell under it out — the topmost
 * box, so a float takes a click over the window beneath it. Wheel and
 * trackpad scrolling arrive as pixels and leave as whole line steps, the
 * remainder carried to the next event (`WheelAccumulator`), so a slow
 * trackpad scroll moves by lines and a fast one does not lose any.
 */

import type { GridBox } from "./redraw";

export interface CellMetrics {
  readonly width: number;
  readonly height: number;
}

export interface MouseTarget {
  readonly grid: number;
  readonly row: number;
  readonly col: number;
}

/** The grid and cell at `(x, y)`, or grid 1's cell when no box is there. */
export function hitTest(
  boxes: readonly GridBox[],
  cell: CellMetrics,
  x: number,
  y: number,
): MouseTarget {
  const row = Math.max(0, Math.floor(y / cell.height));
  const col = Math.max(0, Math.floor(x / cell.width));
  for (let i = boxes.length - 1; i >= 0; i -= 1) {
    const box = boxes[i];
    if (box === undefined || box.grid === 1) continue;
    if (
      row >= box.row &&
      row < box.row + box.height &&
      col >= box.col &&
      col < box.col + box.width
    ) {
      return { grid: box.grid, row: row - box.row, col: col - box.col };
    }
  }
  return { grid: 1, row, col };
}

/** `nvim_input_mouse`'s modifier string: `"C"`, `"S"`, `"A"`, `"D"`, joined. */
export function mouseModifiers(event: {
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}): string {
  return (
    (event.ctrlKey ? "C" : "") +
    (event.shiftKey ? "S" : "") +
    (event.altKey ? "A" : "") +
    (event.metaKey ? "D" : "")
  );
}

/** `MouseEvent.button` as Neovim's button name. */
export function mouseButton(
  button: number,
): "left" | "middle" | "right" | undefined {
  if (button === 0) return "left";
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return undefined;
}

export type WheelStep = "up" | "down" | "left" | "right";

/** Pixels in, line steps out, the remainder kept. */
export class WheelAccumulator {
  private x = 0;
  private y = 0;
  private mode = 0;

  /** `deltaMode` 1 is lines already (a mouse wheel on some systems). */
  steps(
    deltaX: number,
    deltaY: number,
    deltaMode: number,
    cell: CellMetrics,
  ): WheelStep[] {
    // A remainder in pixels means nothing in lines, and the other way round.
    if (deltaMode !== this.mode) this.reset();
    this.mode = deltaMode;
    const lineX = deltaMode === 1 ? 1 : cell.width;
    const lineY = deltaMode === 1 ? 1 : cell.height;
    this.x += deltaX;
    this.y += deltaY;
    const out: WheelStep[] = [];
    while (Math.abs(this.y) >= lineY) {
      out.push(this.y > 0 ? "down" : "up");
      this.y -= Math.sign(this.y) * lineY;
    }
    while (Math.abs(this.x) >= lineX) {
      out.push(this.x > 0 ? "right" : "left");
      this.x -= Math.sign(this.x) * lineX;
    }
    return out;
  }

  reset(): void {
    this.x = 0;
    this.y = 0;
  }
}

/** How many columns and rows fit in a box of this many pixels. */
export function gridSizeFor(
  width: number,
  height: number,
  cell: CellMetrics,
): { cols: number; rows: number } {
  return {
    cols: Math.max(10, Math.floor(width / cell.width)),
    rows: Math.max(3, Math.floor(height / cell.height)),
  };
}

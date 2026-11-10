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

import { WheelLines } from "./wheelLines";
import { frameBands, frameGeometry, insideRounded } from "./frame";
import { frameCuts, inFrameCells } from "./floats";
import type { GridBox } from "./redraw";

/**
 * What on the page takes its own presses and wheel, not Neovim: a GUI
 * window, a view (framed or not), a card, a popup, the notifications, and
 * a node of a footer that runs Lua (`on_click`). Every other press on a
 * footer is Neovim's, on grid 1's cell under it (a status line drag
 * resizes, a click moves to the window, a `%@` region runs).
 */
export const GUI_OWNED =
  ".nvim-gui-window, .nvim-popup, .nvim-view, .nvim-inline-card, .nvim-view-frame, .nvim-toasts, .nvim-footer [data-action]";

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
  const cuts = frameCuts(boxes);
  for (let i = boxes.length - 1; i >= 0; i -= 1) {
    const box = boxes[i];
    if (box === undefined || box.grid === 1) continue;
    // Cut by framed floats above it: in their cells it is drawn only
    // inside their lines, where they take the click themselves.
    const cut = cuts.get(box.grid);
    if (cut !== undefined && inFrameCells(cut, row, col)) continue;
    // Rows and columns by the pointer's place in the box.
    const at = Math.floor(y / cell.height - box.row);
    const across = Math.floor(x / cell.width - box.col);
    if (box.frame) {
      if (insideFrame(box, boxes, cell, x, y)) {
        return {
          grid: box.grid,
          row: Math.min(box.height - 1, Math.max(0, at)),
          col: Math.min(box.width - 1, Math.max(0, across)),
        };
      }
      continue;
    }
    if (at >= 0 && at < box.height && across >= 0 && across < box.width) {
      return { grid: box.grid, row: at, col: across };
    }
  }
  return { grid: 1, row, col };
}

/**
 * Whether `(x, y)` is on a framed float: inside its lines (`frame.ts`), the
 * float's edge — outside them the click is for what is behind. Toward
 * another float edge to edge with it (a picker's list beside its preview)
 * the panel goes on, so the box's own cells count there.
 */
function insideFrame(
  box: GridBox,
  boxes: readonly GridBox[],
  cell: CellMetrics,
  x: number,
  y: number,
): boolean {
  const frame = box.frame;
  if (!frame) return false;
  const g = frameGeometry(frame.margins, box, cell, 1, 0, frameBands(frame));
  const near = (d: number) => d >= -1 && d <= 1;
  const overlap = (a0: number, a1: number, b0: number, b1: number) =>
    Math.max(a0, b0) < Math.min(a1, b1);
  const others = boxes.filter((o) => o.float && o !== box);
  const rows = (o: GridBox) =>
    overlap(box.row, box.row + box.height, o.row, o.row + o.height);
  const cols = (o: GridBox) =>
    overlap(box.col, box.col + box.width, o.col, o.col + o.width);
  const left = others.some((o) => rows(o) && near(box.col - (o.col + o.width)));
  const right = others.some(
    (o) => rows(o) && near(o.col - (box.col + box.width)),
  );
  const top = others.some((o) => cols(o) && near(box.row - (o.row + o.height)));
  const bottom = others.some(
    (o) => cols(o) && near(o.row - (box.row + box.height)),
  );
  const x0 = left ? box.col * cell.width : g.x;
  const x1 = right ? (box.col + box.width) * cell.width : g.x + g.w;
  const y0 = top ? box.row * cell.height : g.y;
  const y1 = bottom ? (box.row + box.height) * cell.height : g.y + g.h;
  return insideRounded(
    {
      x: x0,
      y: y0,
      w: x1 - x0,
      h: y1 - y0,
      radii: {
        tl: left || top ? 0 : g.radii.tl,
        tr: right || top ? 0 : g.radii.tr,
        br: right || bottom ? 0 : g.radii.br,
        bl: left || bottom ? 0 : g.radii.bl,
      },
    },
    x,
    y,
  );
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

/**
 * Pixels in, line steps out, the remainder kept: each axis by
 * `WheelLines`' rule (a tick is at least a step, no pixel lost).
 */
export class WheelAccumulator {
  private readonly x = new WheelLines();
  private readonly y = new WheelLines();

  /** `deltaMode` 1 is lines already (a mouse wheel on some systems). */
  steps(
    deltaX: number,
    deltaY: number,
    deltaMode: number,
    cell: CellMetrics,
    now = performance.now(),
  ): WheelStep[] {
    const out: WheelStep[] = [];
    const ny = this.y.lines(deltaY, deltaMode, cell.height, 1, now);
    for (let i = 0; i < Math.abs(ny); i += 1) out.push(ny > 0 ? "down" : "up");
    const nx = this.x.lines(deltaX, deltaMode, cell.width, 1, now);
    for (let i = 0; i < Math.abs(nx); i += 1)
      out.push(nx > 0 ? "right" : "left");
    return out;
  }

  reset(): void {
    this.x.reset();
    this.y.reset();
  }
}

export { gridSizeFor } from "./gridSize";

/** A window border a drag resizes: its line, in grid 1's cells. */
export interface Sash {
  /** `col`: a vertical separator (drags sideways); `row`: a status line or
   * horizontal separator with a window under it (drags up and down). */
  readonly dir: "col" | "row";
  readonly row: number;
  readonly col: number;
  /** Its length in cells, down a column or along a row. */
  readonly length: number;
}

/**
 * The window border at grid 1's cell `(row, col)`, when it is one Neovim
 * resizes by a drag (with `mouse` on, a press there and a drag are its):
 * the column between two windows side by side, or the row between one
 * window and the one under it (the upper one's status line, or `─`).
 */
export function sashAt(
  boxes: readonly GridBox[],
  row: number,
  col: number,
): Sash | undefined {
  const windows = boxes.filter(
    (b) => b.grid !== 1 && !b.float && b.win !== undefined,
  );
  const within = (b: GridBox, r: number, c: number) =>
    r >= b.row && r < b.row + b.height && c >= b.col && c < b.col + b.width;
  if (windows.some((b) => within(b, row, col))) return undefined;
  const left = windows.find(
    (b) => b.col + b.width === col && row >= b.row && row <= b.row + b.height,
  );
  const right = windows.find(
    (b) => b.col === col + 1 && row >= b.row && row <= b.row + b.height,
  );
  if (left && right) {
    return { dir: "col", row: left.row, col, length: left.height + 1 };
  }
  const above = windows.find(
    (b) => b.row + b.height === row && col >= b.col && col < b.col + b.width,
  );
  const below = windows.find(
    (b) => b.row === row + 1 && col >= b.col && col < b.col + b.width,
  );
  if (above && below) {
    return { dir: "row", row, col: above.col, length: above.width };
  }
  return undefined;
}

import { describe, expect, it } from "vitest";
import {
  clearCursorRow,
  clearEdges,
  floatClusters,
  scrollbarLine,
  touching,
  withRightLine,
} from "./floats";
import { frameGeometry } from "./frame";
import type { GridBox } from "./redraw";

const float = (
  grid: number,
  row: number,
  col: number,
  width: number,
  height: number,
  extra: Partial<GridBox> = {},
): GridBox => ({
  grid,
  row,
  col,
  width,
  height,
  z: 150,
  float: true,
  win: 1000 + grid,
  ...extra,
});

describe("floats that make one panel", () => {
  it("touch along an edge or a cell apart, not at a corner", () => {
    const a = { row: 0, col: 0, width: 10, height: 5 };
    expect(touching(a, { row: 0, col: 10, width: 5, height: 5 })).toBe(true);
    expect(touching(a, { row: 0, col: 11, width: 5, height: 5 })).toBe(true);
    expect(touching(a, { row: 0, col: 12, width: 5, height: 5 })).toBe(false);
    expect(touching(a, { row: 5, col: 2, width: 3, height: 2 })).toBe(true);
    expect(touching(a, { row: 5, col: 10, width: 3, height: 2 })).toBe(false);
    expect(touching(a, { row: 2, col: 2, width: 3, height: 2 })).toBe(true);
  });

  it("are one cluster: a picker's input and list, and its preview beside them", () => {
    const boxes = [
      float(1, 0, 0, 80, 24, { float: false, z: 0 }),
      // input over list, preview to the right, a cell apart
      float(4, 2, 5, 30, 3),
      float(5, 5, 5, 30, 15),
      float(6, 2, 36, 40, 18),
      // a float elsewhere, and one far above in zindex
      float(7, 22, 60, 10, 2),
      float(8, 6, 6, 5, 2, { z: 250 }),
    ];
    const clusters = floatClusters(boxes);
    expect(clusters.map((c) => c.key).sort()).toEqual(["4,5,6", "7", "8"]);
    const panel = clusters.find((c) => c.key === "4,5,6");
    // One seam: between the column and the preview, over the span they share.
    expect(panel?.seams).toEqual([
      { row: 2, col: 35, width: 1, height: 3, between: [4, 6] },
      { row: 5, col: 35, width: 1, height: 15, between: [5, 6] },
    ]);
    const corners = (grid: number) =>
      panel?.members.find((m) => m.grid === grid)?.corners;
    // The input: its top-left only (the list is under it, the preview beside it).
    expect(corners(4)).toEqual({ tl: true, tr: false, br: false, bl: false });
    // The list: its bottom-left only.
    expect(corners(5)).toEqual({ tl: false, tr: false, br: false, bl: true });
    // The preview: its right side; its left meets the column at both ends.
    expect(corners(6)).toEqual({ tl: false, tr: true, br: true, bl: false });
    expect(panel?.z).toBe(150);
    // Alone: every corner round.
    expect(clusters.find((c) => c.key === "7")?.members[0]?.corners).toEqual({
      tl: true,
      tr: true,
      br: true,
      bl: true,
    });
  });

  it("know when every member has a border of its own", () => {
    const lined = { lined: true };
    expect(
      floatClusters([
        float(4, 0, 0, 5, 5, lined),
        float(5, 0, 5, 5, 5, lined),
      ])[0]?.lined,
    ).toBe(true);
    expect(
      floatClusters([float(4, 0, 0, 5, 5, lined), float(5, 0, 5, 5, 5)])[0]
        ?.lined,
    ).toBe(false);
  });
});

describe("a panel next to the cursor's row", () => {
  it("moves half a row off it when a float without a border touches it", () => {
    // blink's menu under the line being typed, its scrollbar beside it.
    const menu = float(4, 6, 10, 20, 5);
    const bar = float(5, 6, 30, 1, 5);
    const boxes = clearCursorRow([menu, bar], 5);
    expect(boxes.map((b) => b.row)).toEqual([6.5, 6.5]);
    // Above the cursor: up.
    expect(clearCursorRow([float(4, 1, 10, 20, 4)], 5)[0]?.row).toBe(0.5);
  });

  it("stays where Neovim put it otherwise", () => {
    expect(clearCursorRow([float(4, 8, 10, 20, 5)], 5)[0]?.row).toBe(8);
    const margins = { top: 1, right: 1, bottom: 1, left: 1 };
    const framed = float(4, 6, 10, 20, 5, {
      lined: true,
      frame: { margins, sides: {}, corners: {}, labels: [] },
    });
    // A border's line is in its cells: nothing to clear.
    expect(clearCursorRow([framed], 5)[0]?.row).toBe(6);
    expect(clearCursorRow([float(4, 6, 10, 20, 5)], undefined)[0]?.row).toBe(6);
  });
});

describe("a panel at the editor's edge", () => {
  const size = { width: 80, height: 24 };
  const none = { left: 0, right: 0, top: 0, bottom: 0 };

  it("moves a cell in, so its padding and line are not cut", () => {
    // Left (a cmdline menu at column 0) and right.
    expect(clearEdges([float(4, 5, 0, 20, 4)], size, none)[0]?.col).toBe(1);
    expect(clearEdges([float(4, 5, 60, 20, 4)], size, none)[0]?.col).toBe(59);
    // Top and bottom.
    expect(clearEdges([float(4, 0, 10, 20, 4)], size, none)[0]?.row).toBe(1);
    expect(clearEdges([float(4, 20, 10, 20, 4)], size, none)[0]?.row).toBe(19);
    // A corner: both ways.
    const corner = clearEdges([float(4, 0, 0, 20, 4)], size, none)[0];
    expect([corner?.row, corner?.col]).toEqual([1, 1]);
  });

  it("moves with its scrollbar, which its frame takes in", () => {
    // blink.cmp's menu at the right edge, its scrollbar in the last column.
    const menu = float(4, 5, 59, 20, 4, { z: 150 });
    const gutter = float(5, 5, 79, 1, 4, { z: 151 });
    const thumb = float(6, 5, 79, 1, 1, { z: 152 });
    const out = clearEdges([menu, gutter, thumb], size, none);
    expect(out.map((b) => b.col)).toEqual([58, 78, 78]);
  });

  it("stays where Neovim put it inside the editor, or where there is room", () => {
    expect(clearEdges([float(4, 5, 1, 20, 4)], size, none)[0]?.col).toBe(1);
    // A tmux pane's border beside it, more than the padding's half cell.
    const room = { left: 0.6, right: 0, top: 0, bottom: 0 };
    expect(clearEdges([float(4, 5, 0, 20, 4)], size, room)[0]?.col).toBe(0);
    // A float with a border of its own: its line is inside its cells.
    const margins = { top: 1, right: 1, bottom: 1, left: 1 };
    const framed = float(4, 0, 0, 20, 4, {
      lined: true,
      frame: { margins, sides: {}, corners: {}, labels: [] },
    });
    expect(clearEdges([framed], size, none)[0]).toBe(framed);
  });

  it("stays on an axis it cannot clear both edges of", () => {
    const wide = clearEdges([float(4, 5, 0, 80, 4)], size, none)[0];
    expect(wide?.col).toBe(0);
  });

  it("keeps the rows it was moved to off the cursor's row", () => {
    // A menu above the cursor at the top: off the cursor's row first.
    const off = clearCursorRow([float(4, 0, 10, 20, 4)], 4);
    expect(off[0]?.row).toBe(-0.5);
    expect(clearEdges(off, size, none)[0]?.row).toBe(-0.5);
  });
});

describe("a menu's scrollbar in its frame", () => {
  const cell = { width: 8, height: 16 };

  it("puts the line along the scrollbar's outer edge", () => {
    const menu = { row: 5, col: 10, width: 20, height: 8 };
    // Beside a menu without a border; on a bordered menu's last column.
    expect(
      scrollbarLine(menu, [{ row: 5, col: 30, width: 1, height: 8 }]),
    ).toBe(31);
    expect(
      scrollbarLine(menu, [{ row: 6, col: 29, width: 1, height: 2 }]),
    ).toBe(30);
    // Not beside it.
    expect(
      scrollbarLine(menu, [{ row: 5, col: 32, width: 1, height: 8 }]),
    ).toBeUndefined();
    expect(
      scrollbarLine(menu, [{ row: 2, col: 30, width: 1, height: 8 }]),
    ).toBeUndefined();
  });

  it("widens the frame to it, the thumb inside the right padding", () => {
    const none = { top: 0, right: 0, bottom: 0, left: 0 };
    const place = { row: 5, col: 10, width: 20, height: 8 };
    const g = frameGeometry(none, place, cell, 2, 4);
    // Half a cell outside the text: through the scrollbar's column.
    expect(g.middles.right).toBe(30 * 8 + 4);
    const wide = withRightLine(g, 31 * 8, 2);
    expect(wide.middles.right).toBe(31 * 8);
    expect(wide.x).toBe(g.x);
    expect(wide.x + wide.w).toBe(31 * 8 + 0.5);
    // Never pulled in.
    expect(withRightLine(g, 29 * 8, 2)).toBe(g);
  });
});

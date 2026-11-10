import { describe, expect, it } from "vitest";
import {
  WheelAccumulator,
  gridSizeFor,
  hitTest,
  mouseButton,
  mouseModifiers,
  sashAt,
} from "./mouse";
import type { GridBox } from "./redraw";

const cell = { width: 8, height: 16 };
const box = (
  grid: number,
  row: number,
  col: number,
  width: number,
  height: number,
  z: number,
): GridBox => ({
  grid,
  row,
  col,
  width,
  height,
  z,
  float: z > 1,
  win: grid,
});

describe("the pointer", () => {
  const boxes = [
    box(1, 0, 0, 80, 24, 0),
    box(2, 0, 0, 40, 23, 1),
    box(3, 0, 41, 39, 23, 1),
    box(5, 5, 10, 20, 4, 150),
  ];

  it("finds the window grid and its own cell", () => {
    expect(hitTest(boxes, cell, 8 * 45 + 3, 16 * 2 + 5)).toEqual({
      grid: 3,
      row: 2,
      col: 4,
    });
  });

  it("gives a click over a float to the float", () => {
    expect(hitTest(boxes, cell, 8 * 12, 16 * 6)).toEqual({
      grid: 5,
      row: 1,
      col: 2,
    });
  });

  it("reads a panel moved in from the editor's edge by the pixel", () => {
    // A menu at column 0, drawn a cell in (`clearEdges`): its first cell
    // is where the pointer sees it, not Neovim's column 0.
    const moved = [...boxes, box(7, 10, 1, 20, 4, 170)];
    expect(hitTest(moved, cell, 8 * 1 + 2, 16 * 11)).toEqual({
      grid: 7,
      row: 1,
      col: 0,
    });
    expect(hitTest(moved, cell, 8 * 0 + 2, 16 * 11).grid).toBe(2);
  });

  it("lets a click through a blank border outside its line", () => {
    const margins = { top: 1, right: 1, bottom: 1, left: 1 };
    const blank = { glyph: " ", hl: 0 };
    const solid = [
      ...boxes,
      {
        ...box(6, 13, 10, 20, 4, 160),
        lined: true,
        frame: {
          margins,
          sides: { top: blank, right: blank, bottom: blank, left: blank },
          corners: { tl: " ", tr: " ", br: " ", bl: " " },
          labels: [],
        },
      },
    ];
    // The border row's outer half: the window under it.
    expect(hitTest(solid, cell, 8 * 12, 16 * 13 + 2).grid).toBe(2);
    // Its inner half, inside the line: the float's.
    expect(hitTest(solid, cell, 8 * 12, 16 * 13 + 12).grid).toBe(6);
    // The text area: the float's own cell, counted from its grid's corner.
    expect(hitTest(solid, cell, 8 * 12, 16 * 14)).toEqual({
      grid: 6,
      row: 1,
      col: 2,
    });
  });

  it("falls back to grid 1 between windows (a separator, the command line)", () => {
    expect(hitTest(boxes, cell, 8 * 40 + 1, 16 * 3)).toEqual({
      grid: 1,
      row: 3,
      col: 40,
    });
    expect(hitTest(boxes, cell, 0, 16 * 23 + 2)).toEqual({
      grid: 1,
      row: 23,
      col: 0,
    });
  });

  it("names buttons and modifiers as nvim_input_mouse does", () => {
    expect([0, 1, 2, 3].map(mouseButton)).toEqual([
      "left",
      "middle",
      "right",
      undefined,
    ]);
    expect(
      mouseModifiers({
        ctrlKey: true,
        shiftKey: false,
        altKey: true,
        metaKey: true,
      }),
    ).toBe("CAD");
  });

  it("turns trackpad pixels into line steps, keeping the remainder", () => {
    const wheel = new WheelAccumulator();
    // A swipe's first event is a step however small; the pixels after it
    // pay that step back before the next.
    expect(wheel.steps(0, 10, 0, cell, 0)).toEqual(["down"]);
    expect(wheel.steps(0, 10, 0, cell, 16)).toEqual([]);
    expect(wheel.steps(0, -40, 0, cell, 32)).toEqual(["up", "up"]);
    expect(wheel.steps(17, 0, 0, cell, 48)).toEqual(["right", "right"]);
    expect(wheel.steps(0, 3, 1, cell, 64)).toEqual(["down", "down", "down"]);
  });

  it("a tick of a few pixels is a step, each one", () => {
    const wheel = new WheelAccumulator();
    expect(wheel.steps(0, 4, 0, cell, 0)).toEqual(["down"]);
    expect(wheel.steps(0, 4, 0, cell, 100)).toEqual(["down"]);
    expect(wheel.steps(0, -4, 0, cell, 200)).toEqual(["up"]);
  });

  it("fits a grid to the view", () => {
    expect(gridSizeFor(800, 400, cell)).toEqual({ cols: 100, rows: 25 });
  });
});

describe("window borders", () => {
  // Two windows side by side over a third, each with a status line.
  const boxes = [
    box(1, 0, 0, 80, 24, 0),
    box(2, 0, 0, 40, 10, 1),
    box(3, 0, 41, 39, 10, 1),
    box(4, 11, 0, 80, 11, 1),
  ];

  it("finds the column between windows side by side", () => {
    expect(sashAt(boxes, 4, 40)).toEqual({
      dir: "col",
      row: 0,
      col: 40,
      length: 11,
    });
  });

  it("finds a status line with a window under it", () => {
    expect(sashAt(boxes, 10, 5)).toEqual({
      dir: "row",
      row: 10,
      col: 0,
      length: 40,
    });
    // The last window's status line has none under it.
    expect(sashAt(boxes, 22, 5)).toBeUndefined();
  });

  it("is nothing inside a window", () => {
    expect(sashAt(boxes, 4, 10)).toBeUndefined();
  });
});

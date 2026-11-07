import { describe, expect, it } from "vitest";
import {
  WheelAccumulator,
  gridSizeFor,
  hitTest,
  mouseButton,
  mouseModifiers,
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
    expect(wheel.steps(0, 10, 0, cell)).toEqual([]);
    expect(wheel.steps(0, 10, 0, cell)).toEqual(["down"]);
    expect(wheel.steps(0, -40, 0, cell)).toEqual(["up", "up"]);
    expect(wheel.steps(17, 0, 0, cell)).toEqual(["right", "right"]);
    expect(wheel.steps(0, 3, 1, cell)).toEqual(["down", "down", "down"]);
  });

  it("fits a grid to the view", () => {
    expect(gridSizeFor(800, 400, cell)).toEqual({ cols: 100, rows: 25 });
  });
});

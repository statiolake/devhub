import { describe, expect, it } from "vitest";
import { cmdlinePlace, cmdlineUiPos, popupmenuPlace } from "./place";

describe("where the completion menu goes", () => {
  const area = { width: 800, height: 600 };

  it("goes under its anchor when it fits", () => {
    expect(popupmenuPlace(area, 100, 50, 16, 5)).toEqual({
      left: 50,
      top: 118,
      maxHeight: 482,
    });
  });

  it("goes over its anchor near the bottom", () => {
    const place = popupmenuPlace(area, 560, 50, 16, 5);
    expect(place.top + place.maxHeight).toBeLessThanOrEqual(560);
    expect(place.maxHeight).toBe(5 * 21 + 8);
  });

  it("stays inside the right edge", () => {
    expect(popupmenuPlace(area, 100, 790, 16, 5).left).toBe(600);
  });
});

describe("where the command line goes", () => {
  it("is centred on whole cells near the top", () => {
    const place = cmdlinePlace(200, 8);
    expect(place).toEqual({ row: 1, col: 57, cols: 85 });
    expect(cmdlineUiPos(place)).toEqual([3, 57]);
  });

  it("fits a narrow grid", () => {
    const place = cmdlinePlace(40, 8);
    expect(place.cols).toBe(36);
    expect(place.col).toBe(2);
  });
});

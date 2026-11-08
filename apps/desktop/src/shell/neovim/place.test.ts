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
    expect(place.maxHeight).toBe(5 * 16 + 6);
  });

  it("stays inside the right edge", () => {
    expect(popupmenuPlace(area, 100, 790, 16, 5).left).toBe(600);
  });
});

describe("where the command line goes", () => {
  const room = { gridCols: 200, gridRows: 50, cellWidth: 8, cmdheight: 0 };

  it("is centred on whole cells near the top with cmdheight=0", () => {
    const place = cmdlinePlace(room);
    expect(place).toEqual({ row: 1, col: 57, cols: 85, bottom: false });
    expect(cmdlineUiPos(place)).toEqual([3, 57]);
  });

  it("fits a narrow grid", () => {
    const place = cmdlinePlace({ ...room, gridCols: 40 });
    expect(place.cols).toBe(36);
    expect(place.col).toBe(2);
  });

  it("is in the rows cmdheight keeps, from the first column, its text on the first", () => {
    const place = cmdlinePlace({ ...room, cmdheight: 2 });
    expect(place).toEqual({ row: 48, col: 0, cols: 200, bottom: true });
    // blink.cmp's menu goes above the text's own row.
    expect(cmdlineUiPos(place)).toEqual([49, 0]);
    expect(cmdlinePlace({ ...room, cmdheight: 1 }).row).toBe(49);
  });

  it("rises over the windows when it holds more than those rows", () => {
    expect(cmdlinePlace({ ...room, cmdheight: 2, rows: 5 }).row).toBe(45);
    expect(cmdlinePlace({ ...room, cmdheight: 2, rows: 1 }).row).toBe(48);
  });
});

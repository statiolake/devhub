import { describe, expect, it } from "vitest";
import {
  BOX_MARGIN,
  BOX_PAD_Y,
  cmdlinePlace,
  cmdlineUiPos,
  popupmenuPlace,
} from "./place";

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
  const cell = { width: 8, height: 20 };
  const room = {
    gridCols: 100,
    gridRows: 50,
    cell,
    cmdheight: 2,
    statusRow: 47,
  };

  it("is a box centred in the rows cmdheight keeps, its text two cells in", () => {
    const place = cmdlinePlace(room);
    // Rows 48 and 49 are the band: 960..1000 px.
    expect(place.top).toBeGreaterThanOrEqual(960);
    expect(place.top + place.height).toBeLessThanOrEqual(1000);
    expect(place.textTop).toBe(970);
    expect(place.col).toBe(3);
    expect(place.cols).toBe(96);
    // Half a cell in from each edge.
    expect(place.left).toBe(4);
    expect(place.width).toBe(99 * 8);
  });

  it("tells blink the row the box starts in and firstc's column", () => {
    const place = cmdlinePlace(room);
    expect(cmdlineUiPos(place)).toEqual([49, 2]);
    // blink's menu ends on that row's top: over the box, not on it.
    expect(48 * 20).toBeLessThanOrEqual(place.top);
  });

  it("grows upward over the windows when it holds more than its rows", () => {
    const place = cmdlinePlace({ ...room, rows: 5 });
    expect(place.top + place.height).toBe(1000 - BOX_MARGIN);
    expect(place.rows).toBe(5);
    expect(place.height).toBe(5 * 20 + 2 * (1 + place.padY));
  });

  it("cuts a question taller than the editor from the top", () => {
    const place = cmdlinePlace({ ...room, rows: 500 });
    expect(place.top).toBeGreaterThanOrEqual(20);
    expect(place.rows).toBeLessThan(50);
  });

  it("sits on the lowest status line with cmdheight=0", () => {
    const place = cmdlinePlace({ ...room, cmdheight: 0, statusRow: 49 });
    expect(place.top + place.height).toBe(49 * 20 - BOX_MARGIN);
    expect(place.padY).toBe(BOX_PAD_Y);
  });

  it("leaves a long prompt's answer room", () => {
    const place = cmdlinePlace({ ...room, gridCols: 40, lead: 72 });
    expect(place.cols).toBeGreaterThanOrEqual(8);
  });
});

import { describe, expect, it } from "vitest";
import { PANE_MS, plan } from "./paneMotion";
import type { GridBox } from "./redraw";
import { viewportShift, windowRests } from "./windowMotion";

const cell = { width: 8, height: 17 };
const win = (
  grid: number,
  row: number,
  col: number,
  width: number,
  height: number,
): GridBox => ({
  grid,
  row,
  col,
  width,
  height,
  z: 1,
  float: false,
  win: 1000 + grid,
});
const grid1 = { width: 81, height: 30 };

describe("a window at rest", () => {
  it("reaches half into the separator beside it, and over its status line", () => {
    const rests = windowRests(
      [win(2, 0, 0, 40, 27), win(3, 0, 41, 40, 27)],
      grid1,
      2,
      cell,
      2,
    );
    expect(rests.get(2)?.rect).toEqual({
      left: 0,
      top: 0,
      right: 40.5 * 8,
      bottom: 28 * 17,
    });
    expect(rests.get(3)?.rect.left).toBe(40.5 * 8);
    expect(rests.get(3)?.x).toBe(41 * 8);
    expect(rests.get(2)?.status).toBe(true);
  });

  it("has no status line where the row under it is the command line's", () => {
    const rests = windowRests([win(2, 0, 0, 81, 28)], grid1, 2, cell, 2);
    expect(rests.get(2)?.status).toBe(false);
  });
});

describe("a split's windows", () => {
  const before = windowRests([win(2, 0, 0, 81, 27)], grid1, 2, cell, 2);
  const after = windowRests(
    [win(2, 0, 0, 81, 13), win(4, 14, 0, 81, 13)],
    grid1,
    2,
    cell,
    2,
  );

  it("end on their resting places exactly", () => {
    const t = plan({
      now: 0,
      change: { kind: "structural" },
      shown: new Map(before),
      next: [...after].map(([key, rest]) => ({ key, rest })),
    });
    const end = t.at(PANE_MS.structural, 2);
    for (const [grid, rest] of after) expect(end.get(grid)).toBe(rest);
  });

  it("carry their text by the rows its topline moved", () => {
    // The cursor at line 20 kept in view: topline 1 to 8.
    const d = viewportShift(1, 8);
    expect(d).toBe(7);
    const t = plan({
      now: 0,
      change: { kind: "structural" },
      shown: new Map(before),
      next: [...after].map(([key, rest]) => ({ key, rest })),
      anchor: (_grid, was) => ({ x: was.x, y: was.y + d * cell.height }),
    });
    // Line 20: row 19 before, row 12 after; on screen it only rises.
    const line = (ms: number) => t.at(ms, 2).get(2)!.y + 12 * cell.height;
    expect(line(0)).toBe(19 * cell.height);
    expect(line(PANE_MS.structural)).toBe(12 * cell.height);
    expect(viewportShift(undefined, 3)).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { bandGround, drawnRect, floatClusters, touching } from "./floats";
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

  it("use what is drawn of a float: a left-out blank border is not there", () => {
    const solid = float(4, 2, 2, 12, 5, {
      crop: { top: 1, right: 1, bottom: 1, left: 1 },
    });
    expect(drawnRect(solid)).toEqual({ row: 3, col: 3, width: 10, height: 3 });
    // Two cells from the next one once the border is left out: apart.
    expect(
      floatClusters([solid, float(5, 3, 15, 5, 3)]).map((c) => c.key),
    ).toEqual(["4", "5"]);
  });

  it("lose DevHub's hairline only when every member draws its own border", () => {
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

describe("a float's selected row as a band", () => {
  // Rows of a float 6 wide: "n" its ground, "s" the selection, "t" a title.
  const grounds = (rows: readonly string[]) => (r: number, c: number) => {
    const g = rows[r]?.[c];
    return g === undefined ? undefined : g.charCodeAt(0);
  };
  const rows = (list: readonly string[]) => ({ top: 0, bottom: list.length });

  it("is a row in another ground between rows of the float's", () => {
    const list = ["nnnnnn", "ssssss", "nnnnnn", "nnnnnn"];
    expect(bandGround(rows(list), 0, 5, 1, grounds(list))).toBe(110);
  });

  it("is the first row too, with the float's ground under it", () => {
    const list = ["ssssss", "nnnnnn", "nnnnnn"];
    expect(bandGround(rows(list), 0, 5, 0, grounds(list))).toBe(110);
  });

  it("is the selected one of two rows", () => {
    const list = ["ssssss", "nnnnnn"];
    expect(bandGround(rows(list), 0, 5, 0, grounds(list))).toBe(110);
  });

  it("is not the title row above a selected first item", () => {
    // A picker's list: its kept title row in the float's ground, the first
    // item selected under it. The title is not a band cut out of the
    // selection.
    const list = ["nnnnnn", "ssssss", "nnnnnn", "nnnnnn", "nnnnnn"];
    expect(bandGround(rows(list), 0, 5, 0, grounds(list))).toBeUndefined();
    expect(bandGround(rows(list), 0, 5, 1, grounds(list))).toBe(110);
  });
});

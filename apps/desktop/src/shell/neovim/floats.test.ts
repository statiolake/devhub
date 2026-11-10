import { describe, expect, it } from "vitest";
import {
  floatClusters,
  framePieces,
  hugClip,
  insideLines,
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

  it("widens the frame to it, the line inside its outer edge", () => {
    const none = { top: 0, right: 0, bottom: 0, left: 0 };
    const place = { row: 5, col: 10, width: 20, height: 8 };
    const g = frameGeometry(none, place, cell, 2, 4);
    // No border: the line along the menu's own edge, inside it.
    expect(g.x + g.w).toBe(30 * 8);
    const wide = withRightLine(g, 31 * 8, 2);
    expect(wide.middles.right).toBe(31 * 8 - wide.widths.right / 2);
    expect(wide.x).toBe(g.x);
    // Nothing past the scrollbar's cells.
    expect(wide.x + wide.w).toBe(31 * 8);
    // Never pulled in.
    expect(withRightLine(g, 29 * 8, 2)).toBe(g);
  });
});

describe("a float without a border, its frame on its cells", () => {
  const cell = { width: 8, height: 16 };
  const none = { top: 0, right: 0, bottom: 0, left: 0 };

  for (const dpr of [1, 1.5, 2, 3]) {
    it(`cuts its canvas inside the line, the corners round, at DPR ${String(dpr)}`, () => {
      const place = { row: 2, col: 0, width: 20, height: 6 };
      const g = frameGeometry(none, place, cell, dpr, 4);
      const [piece] = framePieces(
        [{ grid: 4, rect: place, geometry: g, ruled: false }],
        dpr,
      );
      if (!piece) throw new Error("no piece");
      // The piece is the cells, at the editor's left edge too: nothing to
      // clear there.
      expect([piece.x, piece.y, piece.x + piece.w, piece.y + piece.h]).toEqual([
        0, 32, 160, 128,
      ]);
      const line = g.widths.left;
      const inside = insideLines(piece, g.widths);
      const want = {
        x: line,
        y: 32 + line,
        w: 160 - 2 * line,
        h: 96 - 2 * line,
        r: 4 - line,
      };
      expect(inside.x).toBeCloseTo(want.x, 9);
      expect(inside.y).toBeCloseTo(want.y, 9);
      expect(inside.w).toBeCloseTo(want.w, 9);
      expect(inside.h).toBeCloseTo(want.h, 9);
      for (const r of Object.values(inside.radii))
        expect(r).toBeCloseTo(want.r, 9);
      // In the canvas's own coordinates.
      expect(hugClip(inside, { x: 0, y: 32 })).toMatch(
        /^path\("M[\d.]+ [\d.]+L.*A.*Z"\)$/,
      );
    });
  }

  it("leaves no line, and no inset, where it meets another without one", () => {
    // blink's menu and its documentation under it, both borderless.
    const menu = { row: 5, col: 10, width: 20, height: 6 };
    const doc = { row: 11, col: 10, width: 20, height: 4 };
    const geo = (r: typeof menu) => frameGeometry(none, r, cell, 2, 4);
    const pieces = framePieces(
      [
        { grid: 4, rect: menu, geometry: geo(menu), ruled: false },
        { grid: 5, rect: doc, geometry: geo(doc), ruled: false },
      ],
      2,
    );
    const [m, d] = pieces;
    if (!m || !d) throw new Error("no pieces");
    // They meet on the cells' shared edge, square there, no line.
    expect(m.y + m.h).toBe(11 * 16);
    expect(d.y).toBe(11 * 16);
    expect(m.draw.bottom).toBe(false);
    expect(d.draw.top).toBe(false);
    expect([m.radii.bl, m.radii.br, d.radii.tl, d.radii.tr]).toEqual([
      0, 0, 0, 0,
    ]);
    // The menu's selection band reaches the doc: no inset at the bottom.
    const inside = insideLines(m, geo(menu).widths);
    expect(inside.y + inside.h).toBe(11 * 16);
    expect(inside.x).toBe(m.x + geo(menu).widths.left);
  });
});

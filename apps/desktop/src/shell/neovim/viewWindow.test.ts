import { describe, expect, it } from "vitest";
import { drawnRows, viewLayout, viewPieces } from "./viewWindow";

const keys = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe("a view's rows as far as they are drawn", () => {
  it("places each row by its measure, else row_height, else the average", () => {
    const measured = new Map([
      [2, 40],
      [3, 30],
    ]);
    expect(viewLayout(keys(4), measured, 22, 4)).toEqual({
      tops: [4, 26, 66, 96],
      heights: [22, 40, 30, 22],
      bottom: 118,
    });
    // No row_height: the measured ones' average.
    expect(viewLayout(keys(4), measured, undefined, 0).heights).toEqual([
      35, 40, 30, 35,
    ]);
  });

  it("draws the rows within a screen of the viewport, and no more", () => {
    const layout = viewLayout(keys(1000), new Map(), 20, 0);
    const drawn = drawnRows(layout, 5000, 400, 400, [], 250);
    expect(drawn[0]).toBe(230);
    expect(drawn.at(-1)).toBe(289);
    expect(drawn).toHaveLength(60);
  });

  it("always draws the sticky rows and the focused one", () => {
    const layout = viewLayout(keys(1000), new Map(), 20, 0);
    const sticky = keys(1000).map((k) => k === 1);
    const drawn = drawnRows(layout, 5000, 400, 0, sticky, 900);
    expect(drawn[0]).toBe(0);
    expect(drawn).toContain(900);
    expect(drawn.slice(1, -1)).toEqual(keys(20).map((k) => 249 + k));
  });

  it("keeps the room of the rows not drawn as spacers, to the pixel", () => {
    const layout = viewLayout(keys(10), new Map([[5, 50]]), 20, 4);
    const pieces = viewPieces(layout, [0, 4, 5], 4);
    expect(pieces).toEqual([
      { kind: "row", index: 0 },
      { kind: "gap", key: "gap:0", height: 60 },
      { kind: "row", index: 4 },
      { kind: "row", index: 5 },
      { kind: "gap", key: "gap:5", height: 80 },
    ]);
    const total = pieces.reduce(
      (sum, p) =>
        sum + (p.kind === "gap" ? p.height : (layout.heights[p.index] ?? 0)),
      4,
    );
    expect(total).toBe(layout.bottom);
  });
});

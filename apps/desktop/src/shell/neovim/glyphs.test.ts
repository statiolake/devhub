import { describe, expect, it } from "vitest";
import {
  boxArms,
  fitIcon,
  glyphKind,
  glyphShapes,
  lightThickness,
  type Shape,
} from "./glyphs";

const rects = (shapes: readonly Shape[] | undefined) =>
  (shapes ?? []).flatMap((s) =>
    s.kind === "rect" ? [[s.x, s.y, s.w, s.h, s.alpha ?? 1]] : [],
  );

// A 7×20 cell at the origin (a 12px font with linespace), at dpr 2: one
// light line is 2 device pixels — one CSS pixel.
const CELL = { x: 0, y: 0, w: 7, h: 20 };

describe("glyph classification", () => {
  it("knows box drawing, blocks, Powerline and Nerd Font icons", () => {
    for (const c of ["│", "─", "╭", "╯", "┴", "┼", "━", "═", "╬", "┄", "╳"])
      expect(glyphKind(c)).toBe("box");
    for (const c of ["▀", "▁", "█", "▏", "▕", "░", "▚"])
      expect(glyphKind(c)).toBe("block");
    for (const c of ["", "", "", "", ""])
      expect(glyphKind(c)).toBe("powerline");
    // nvim-web-devicons' Lua, a Material Design icon (supplementary PUA),
    // a Codicon, the IEC power symbol.
    for (const c of ["", "\u{f0627}", "", "⏻", ""])
      expect(glyphKind(c)).toBe("icon");
  });

  it("leaves everything else to the font", () => {
    for (const c of ["a", "|", "-", "+", "日", "é", "", " ", "ab", "\u{1f600}"])
      expect(glyphKind(c)).toBeUndefined();
  });

  it("reads each box character's arms from its name", () => {
    expect(boxArms("┼")).toEqual({ n: 1, e: 1, s: 1, w: 1 });
    expect(boxArms("┍")).toEqual({ n: 0, e: 2, s: 1, w: 0 });
    expect(boxArms("╋")).toEqual({ n: 2, e: 2, s: 2, w: 2 });
    expect(boxArms("╔")).toEqual({ n: 0, e: 3, s: 3, w: 0 });
    expect(boxArms("╞")).toEqual({ n: 1, e: 3, s: 1, w: 0 });
    expect(boxArms("╽")).toEqual({ n: 1, e: 0, s: 2, w: 0 });
    expect(boxArms("╭")).toBeUndefined();
  });
});

describe("glyph geometry", () => {
  it("gives every box, block and Powerline character something to draw", () => {
    for (let cp = 0x2500; cp <= 0x259f; cp += 1) {
      const shapes = glyphShapes(String.fromCodePoint(cp), CELL, 2, 12);
      expect(shapes?.length, cp.toString(16)).toBeGreaterThan(0);
    }
    for (let cp = 0xe0b0; cp <= 0xe0bf; cp += 1) {
      const shapes = glyphShapes(String.fromCodePoint(cp), CELL, 2, 12);
      expect(shapes?.length, cp.toString(16)).toBeGreaterThan(0);
    }
    expect(glyphShapes("", CELL, 2, 12)).toBeUndefined();
    expect(glyphShapes("a", CELL, 2, 12)).toBeUndefined();
  });

  it("draws │ and ─ through the whole cell on whole device pixels", () => {
    // Two arms that meet at the centre: one column, top to bottom.
    const v = rects(glyphShapes("│", CELL, 2, 12));
    for (const r of v) expect([r[0], r[2]]).toEqual([3, 1]);
    const top = Math.min(...v.map((r) => r[1] ?? 0));
    const bottom = Math.max(...v.map((r) => (r[1] ?? 0) + (r[3] ?? 0)));
    expect([top, bottom]).toEqual([0, 20]);
    // Two half arms that meet: the whole width between them.
    const h = rects(glyphShapes("─", CELL, 2, 12));
    const left = Math.min(...h.map((r) => r[0] ?? 0));
    const right = Math.max(...h.map((r) => (r[0] ?? 0) + (r[2] ?? 0)));
    expect([left, right]).toEqual([0, 7]);
    for (const r of h) expect(r[3]).toBe(1);
    // At dpr 1 a 7px cell's line is not on a half pixel.
    for (const r of rects(glyphShapes("│", CELL, 1, 12)))
      expect(Number.isInteger(r[0])).toBe(true);
  });

  it("draws heavy lines twice as thick, and joins ┼ square", () => {
    const heavy = rects(glyphShapes("┃", CELL, 2, 12));
    expect(heavy[0]?.[2]).toBe(2);
    // ┼: the vertical arms reach the horizontal line, which runs through.
    const cross = rects(glyphShapes("┼", CELL, 2, 12));
    expect(cross).toHaveLength(4);
  });

  it("draws ═ and ║ as two lines and closes ╔'s corners", () => {
    const dh = rects(glyphShapes("═", CELL, 2, 12));
    const ys = [...new Set(dh.map((r) => r[1]))];
    expect(ys).toHaveLength(2);
    // ╔: the outer lines meet at the outer corner, the inner ones inside.
    const corner = rects(glyphShapes("╔", CELL, 2, 12));
    expect(corner).toHaveLength(4);
    const [upper, lower, left, right] = corner as [
      number[],
      number[],
      number[],
      number[],
    ];
    expect(upper[0]).toBe(left[0]); // outer: upper line starts at left line
    expect(lower[0]).toBe(right[0]); // inner: lower line starts at right line
    expect(left[1]).toBe(upper[1]);
    expect(right[1]).toBe(lower[1]);
  });

  it("dashes ┄ into three and ┊ into four", () => {
    expect(rects(glyphShapes("┄", CELL, 2, 12))).toHaveLength(3);
    expect(rects(glyphShapes("┊", CELL, 2, 12))).toHaveLength(4);
  });

  it("fills block elements to the cell's edges, linespace included", () => {
    expect(rects(glyphShapes("█", CELL, 2, 12))).toEqual([[0, 0, 7, 20, 1]]);
    expect(rects(glyphShapes("▀", CELL, 2, 12))).toEqual([[0, 0, 7, 10, 1]]);
    expect(rects(glyphShapes("▁", CELL, 2, 12))).toEqual([
      [0, 17.5, 7, 2.5, 1],
    ]);
    expect(rects(glyphShapes("▏", CELL, 2, 12))).toEqual([[0, 0, 1, 20, 1]]);
    expect(rects(glyphShapes("▕", CELL, 2, 12))).toEqual([[6, 0, 1, 20, 1]]);
    expect(rects(glyphShapes("▒", CELL, 2, 12))).toEqual([[0, 0, 7, 20, 0.5]]);
    expect(rects(glyphShapes("▚", CELL, 2, 12))).toEqual([
      [0, 0, 3.5, 10, 1],
      [3.5, 10, 3.5, 10, 1],
    ]);
  });

  it("draws Powerline's triangle from the top to the bottom of the cell", () => {
    const [tri] = glyphShapes("", CELL, 2, 12) ?? [];
    expect(tri).toEqual({
      kind: "fill",
      path: [["M", 0, 0], ["L", 7, 10], ["L", 0, 20], ["Z"]],
    });
    // Across both cells when Neovim says it is wide.
    const [wide] = glyphShapes("", { ...CELL, w: 14 }, 2, 12) ?? [];
    expect(wide).toEqual({
      kind: "fill",
      path: [["M", 14, 0], ["L", 0, 10], ["L", 14, 20], ["Z"]],
    });
  });

  it("thickens lines with the font", () => {
    expect(lightThickness(12, 2)).toBe(2);
    expect(lightThickness(12, 1)).toBe(1);
    expect(lightThickness(25, 2)).toBe(4);
    expect(lightThickness(6, 1)).toBe(1);
  });
});

describe("icon fit", () => {
  it("leaves an icon that fits its cell at its size, centred", () => {
    const fit = fitIcon(
      { left: 0, right: 6, ascent: 9, descent: 1 },
      { w: 7, h: 14 },
      false,
    );
    expect(fit).toEqual({ scale: 1, dx: -3, dy: 4 });
  });

  it("shrinks an icon wider than its cell", () => {
    const fit = fitIcon(
      { left: 1, right: 13, ascent: 10, descent: 2 },
      { w: 7, h: 14 },
      false,
    );
    expect(fit.scale).toBeCloseTo(0.5);
  });

  it("lets an icon with two cells grow, short of the text box", () => {
    const fit = fitIcon(
      { left: 0, right: 7, ascent: 8, descent: 0 },
      { w: 14, h: 10 },
      true,
    );
    expect(fit.scale).toBeCloseTo(1.0625);
  });
});

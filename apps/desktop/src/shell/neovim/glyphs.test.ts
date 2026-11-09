import { describe, expect, it } from "vitest";
import {
  boxArms,
  glyphKind,
  glyphShapes,
  lightThickness,
  placeIcon,
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

describe("icon placement", () => {
  // Symbols Nerd Font Mono at 12px: every icon in the em square.
  const EM = { left: 0, right: 12, ascent: 9.6, descent: 2.4 };
  // A 7×20 cell, its face 14 tall from 3 down (3 of leading each side).
  const room = {
    x: 0,
    y: 0,
    cellWidth: 7,
    cellHeight: 20,
    cells: 1,
    faceTop: 3,
    faceHeight: 14,
    capHeight: 9,
    align: "first" as const,
  };
  /** The drawn design box: left, top, width, height. */
  const drawn = (p: ReturnType<typeof placeIcon>, box = EM) => [
    p.x - box.left * p.sx,
    p.y - box.ascent * p.sy,
    (box.left + box.right) * p.sx,
    (box.ascent + box.descent) * p.sy,
  ];

  it("fits one cell across, centred on the cell's middle down", () => {
    const [left, top, w, h] = drawn(placeIcon(0xf057, EM, room));
    expect(w).toBeCloseTo(7);
    expect(h).toBeCloseTo(7);
    expect(left).toBeCloseTo(0);
    expect(top! + h! / 2).toBeCloseTo(10);
  });

  it("grows with a blank after it, from the first cell, a gap kept", () => {
    const [left, top, w, h] = drawn(
      placeIcon(0xe628, EM, { ...room, cellWidth: 8, cells: 2 }),
    );
    // Two cells less half of one across (12), under the face's 14.
    expect(w).toBeCloseTo(12);
    expect(h).toBeCloseTo(12);
    // Wider than a cell: from its left edge, as Ghostty's center1.
    expect(left).toBeCloseTo(0);
    expect(top! + h! / 2).toBeCloseTo(10);
    // Taller than one cell's icon would be.
    const [, , one] = drawn(placeIcon(0xe628, EM, { ...room, cellWidth: 8 }));
    expect(w).toBeGreaterThan(one!);
  });

  it("centres a sign across its two cells", () => {
    const [left, , w] = drawn(
      placeIcon(0xf057, EM, {
        ...room,
        x: 10,
        cellWidth: 8,
        cells: 2,
        align: "centre",
      }),
    );
    expect(left! + w! / 2).toBeCloseTo(10 + 8);
  });

  it("keeps a small icon small: the em square is fitted, not the ink", () => {
    // A dot's ink is half the em; its design box is the em all the same.
    const p = placeIcon(0xf444, EM, room);
    const big = placeIcon(0xf057, EM, room);
    expect(p.sx).toBeCloseTo(big.sx);
  });

  it("fits a glyph of another font by its ink, centred both ways", () => {
    const ink = { left: 1, right: 9, ascent: 6, descent: 0 };
    const [left, top, w, h] = drawn(placeIcon(0xe000, ink, room), ink);
    // 10 wide, 6 tall: the cell's 7 across is the limit.
    expect(w).toBeCloseTo(7);
    expect(h).toBeCloseTo(4.2);
    expect(left).toBeCloseTo(0);
    expect(top! + h! / 2).toBeCloseTo(10);
  });

  it("stretches a Powerline Extra separator to the whole cell", () => {
    const [left, top, w, h] = drawn(placeIcon(0xe0c0, EM, room));
    expect([left, top, w, h].map((v) => Number(v!.toFixed(6)))).toEqual([
      0, 0, 7, 20,
    ]);
  });

  it("sits on the cell's true centre at any device pixel ratio and linespace", () => {
    // The cell and its face box as cellMetrics makes them, at fractional
    // ratios: the leading split, its top on a device pixel.
    for (const dpr of [1, 1.25, 1.5, 2, 2.5, 3]) {
      for (const linespace of [0, 1, 3, 5]) {
        const box = Math.ceil(14.2 * dpr);
        const height = box + Math.round(linespace * dpr);
        const faceTop = Math.round((height - box) / 2) / dpr;
        const p = placeIcon(0xf057, EM, {
          ...room,
          y: 37 * (height / dpr),
          cellHeight: height / dpr,
          faceTop,
          faceHeight: 14.2,
        });
        const [, top, , h] = drawn(p);
        const centre = top! + h! / 2 - 37 * (height / dpr);
        // On the face's centre exactly; that is the cell's to within the
        // half device pixel the leading's rounding leaves.
        expect(centre).toBeCloseTo(faceTop + 7.1, 9);
        expect(Math.abs(centre - height / dpr / 2)).toBeLessThanOrEqual(
          0.5 / dpr + 1e-9,
        );
      }
    }
  });
});

import { describe, expect, it } from "vitest";
import { dragBand } from "./dragBand";
import type { Grid, HlAttr } from "./redraw";

/** A grid from rows of text; `n` in `marks` is a line number's cell. */
function grid(rows: readonly string[], marks?: readonly string[]): Grid {
  const width = Math.max(...rows.map((r) => r.length));
  const chars: string[] = [];
  const hls = new Int32Array(width * rows.length);
  rows.forEach((row, y) => {
    for (let x = 0; x < width; x++) {
      const c = row[x] ?? " ";
      chars.push(c === "_" ? "" : c);
      const m = marks?.[y]?.[x] ?? ".";
      hls[y * width + x] = m === "n" ? 1 : m === "~" ? 2 : 0;
    }
  });
  return { id: 2, width, height: rows.length, chars, hls, dirty: new Set() };
}
const hl = new Map<number, HlAttr>([
  [1, { groups: ["LineNr"] }],
  [2, { groups: ["EndOfBuffer"] }],
]);
const at = (row: number, col: number) => ({ row, col });

describe("Visual's band in a drag", () => {
  const g = grid(
    [
      " 1 alpha beta     ",
      " 2                ",
      " 3   gamma        ",
      "~                 ",
    ],
    [
      "nnn...............",
      "nnn...............",
      "nnn...............",
      "~.................",
    ],
  );

  it("is the cells from the press to the pointer on one row", () => {
    expect(dragBand(g, hl, undefined, at(0, 5), at(0, 9))).toEqual([
      { row: 0, col0: 5, col1: 9 },
    ]);
    // Dragged leftwards: the same cells.
    expect(dragBand(g, hl, undefined, at(0, 9), at(0, 5))).toEqual([
      { row: 0, col0: 5, col1: 9 },
    ]);
  });

  it("ends past a line's end on its last character", () => {
    expect(dragBand(g, hl, undefined, at(0, 3), at(0, 16))).toEqual([
      { row: 0, col0: 3, col1: 12 },
    ]);
  });

  it("takes each line's newline across rows, an empty line's included", () => {
    expect(dragBand(g, hl, undefined, at(0, 9), at(2, 7))).toEqual([
      { row: 0, col0: 9, col1: 13 },
      { row: 1, col0: 3, col1: 3 },
      { row: 2, col0: 3, col1: 7 },
    ]);
  });

  it("draws nothing it cannot be sure of", () => {
    // Past the buffer.
    expect(dragBand(g, hl, undefined, at(2, 6), at(3, 4))).toBeUndefined();
    // From the gutter, or a leading blank (a tab, perhaps).
    expect(dragBand(g, hl, undefined, at(0, 1), at(0, 6))).toBeUndefined();
    expect(dragBand(g, hl, undefined, at(2, 4), at(2, 8))).toBeUndefined();
    // A row filled to the edge may wrap onto the next.
    const full = grid(["abcdef", "ghi   "]);
    expect(dragBand(full, hl, undefined, at(0, 1), at(1, 1))).toBeUndefined();
  });

  it("goes on past a full row when the next has a line number of its own", () => {
    // 'nowrap', or a line that just fits: the next row starts a line.
    const cut = grid([" 1 abcdef", " 2 ghi   "], ["nnn......", "nnn......"]);
    expect(dragBand(cut, hl, undefined, at(0, 4), at(1, 4))).toEqual([
      { row: 0, col0: 4, col1: 8 },
      { row: 1, col0: 3, col1: 4 },
    ]);
    // A wrapped line's next row has no number: no band.
    const wrapped = grid(
      [" 1 abcdef", "   ghi   "],
      ["nnn......", "nnn......"],
    );
    expect(
      dragBand(wrapped, hl, undefined, at(0, 4), at(1, 4)),
    ).toBeUndefined();
  });

  it("takes a wide character whole at the pointer", () => {
    const w = grid(["aW_b"]);
    expect(dragBand(w, hl, undefined, at(0, 0), at(0, 2))).toEqual([
      { row: 0, col0: 0, col1: 2 },
    ]);
  });
});

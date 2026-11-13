import { describe, expect, it } from "vitest";
import { clickMode, predictClick } from "./clickCaret";
import type { Grid, HlAttr } from "./redraw";

/**
 * A grid from rows of text, each cell's highlight by a letter in `marks`
 * (`n`: line number, `s`: sign, `v`: virtual text, `~`: past the end, ` `
 * or `.`: plain text). A wide character is `W` followed by `_` (its right
 * half).
 */
function grid(rows: readonly string[], marks?: readonly string[]): Grid {
  const width = Math.max(...rows.map((r) => r.length));
  const chars: string[] = [];
  const hls = new Int32Array(width * rows.length);
  rows.forEach((row, y) => {
    for (let x = 0; x < width; x++) {
      const c = row[x] ?? " ";
      chars.push(c === "_" ? "" : c);
      const m = marks?.[y]?.[x] ?? ".";
      hls[y * width + x] = HL_OF[m] ?? 0;
    }
  });
  return { id: 2, width, height: rows.length, chars, hls, dirty: new Set() };
}
const HL_OF: Record<string, number> = { n: 1, s: 2, v: 3, "~": 4, f: 5 };
const hl = new Map<number, HlAttr>([
  [1, { groups: ["LineNr"] }],
  [2, { groups: ["SignColumn", "DiagnosticSignError"] }],
  [3, { groups: ["LspInlayHint"] }],
  [4, { groups: ["EndOfBuffer"] }],
  [5, { groups: ["Folded"] }],
]);
const at = (row: number, col: number) => ({ grid: 2, row, col });

describe("where a click puts the caret", () => {
  const g = grid(
    [
      " 1 local x = 1  ",
      " 2   return x   ",
      " 3              ",
      "~               ",
    ],
    [
      "nnn.............",
      "nnn.............",
      "nnn.............",
      "~...............",
    ],
  );

  it("is the character clicked", () => {
    expect(predictClick(g, hl, undefined, at(0, 5), "normal")).toEqual(
      at(0, 5),
    );
  });

  it("is a space between two characters", () => {
    expect(predictClick(g, hl, undefined, at(0, 8), "normal")).toEqual(
      at(0, 8),
    );
  });

  it("is the line's last character past its end, after it in Insert mode", () => {
    expect(predictClick(g, hl, undefined, at(0, 14), "normal")).toEqual(
      at(0, 13),
    );
    expect(predictClick(g, hl, undefined, at(0, 14), "insert")).toEqual(
      at(0, 14),
    );
  });

  it("is an empty line's first cell", () => {
    expect(predictClick(g, hl, undefined, at(2, 9), "normal")).toEqual(
      at(2, 3),
    );
  });

  it("is not guessed in the gutter, the leading blanks or past the buffer", () => {
    expect(predictClick(g, hl, undefined, at(0, 1), "normal")).toBeUndefined();
    // A leading blank may be a tab: the cursor would stand at its end.
    expect(predictClick(g, hl, undefined, at(1, 4), "normal")).toBeUndefined();
    expect(predictClick(g, hl, undefined, at(3, 4), "normal")).toBeUndefined();
  });

  it("does not count virtual text as the line", () => {
    // An inlay hint inside the line: Neovim puts the cursor beside it.
    const v = grid(["f(x: number, y)"], ["...vvvvvvvv...."]);
    expect(predictClick(v, hl, undefined, at(0, 6), "normal")).toBeUndefined();
    expect(predictClick(v, hl, undefined, at(0, 13), "normal")).toEqual(
      at(0, 13),
    );
    // Past the text, the line's own last character, not the hint's.
    const eol = grid(["foo()   E: oops   "], ["........vvvvvvv..."]);
    expect(predictClick(eol, hl, undefined, at(0, 17), "normal")).toEqual(
      at(0, 4),
    );
  });

  it("takes a sign column for the gutter", () => {
    const s = grid(["E 12 abc"], ["ssnnn..."]);
    expect(predictClick(s, hl, undefined, at(0, 3), "normal")).toBeUndefined();
    expect(predictClick(s, hl, undefined, at(0, 6), "normal")).toEqual(
      at(0, 6),
    );
  });

  it("puts the caret on a wide character's first half", () => {
    const w = grid(["aW_b"]);
    expect(predictClick(w, hl, undefined, at(0, 2), "normal")).toEqual(
      at(0, 1),
    );
  });

  it("guesses nothing on a closed fold, or in a winbar", () => {
    const f = grid(["+-- 3 lines: x"], ["ffffffffffffff"]);
    expect(predictClick(f, hl, undefined, at(0, 5), "normal")).toBeUndefined();
    const m = { top: 1, right: 0, bottom: 0, left: 0 };
    expect(predictClick(g, hl, m, at(0, 5), "normal")).toBeUndefined();
    expect(predictClick(g, hl, m, at(1, 6), "normal")).toEqual(at(1, 6));
  });

  it("knows which modes a click moves the cursor plainly in", () => {
    expect(clickMode("normal")).toBe("normal");
    expect(clickMode("visual")).toBe("normal");
    expect(clickMode("insert")).toBe("insert");
    expect(clickMode("replace")).toBe("insert");
    expect(clickMode("cmdline_normal")).toBeUndefined();
    expect(clickMode("operator")).toBeUndefined();
    expect(clickMode("terminal")).toBeUndefined();
  });
});

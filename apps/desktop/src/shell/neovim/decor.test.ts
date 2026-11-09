import { describe, expect, it } from "vitest";
import {
  decorOf,
  foldLineOf,
  matchAt,
  placeDecor,
  wordsOf,
  type RowCells,
} from "./decor";

/** A grid row from text: a wide character takes its cell and an empty one. */
function rowOf(text: string, width = 40): RowCells {
  const chars: string[] = [];
  for (const c of text) {
    chars.push(c);
    if (/[\u3000-\u9fff\uff00-\uffef]/u.test(c)) chars.push("");
  }
  while (chars.length < width) chars.push(" ");
  return { chars: chars.slice(0, width), base: 0, width };
}

describe("a decoration in a grid row", () => {
  it("matches exactly the text at its column, wide characters on two cells", () => {
    const row = rowOf("let x: i32 = 1;  ■ unused 変数");
    expect(matchAt(row, 5, ": i32")).toBe(10);
    expect(matchAt(row, 4, ": i32")).toBeUndefined();
    expect(matchAt(row, 17, "■ unused 変数")).toBe(30);
  });

  it("matches text Neovim cut at the row's end only where cutting is allowed", () => {
    const row = rowOf("abc virtual text", 12);
    expect(matchAt(row, 4, "virtual text", true)).toBe(12);
    expect(matchAt(row, 4, "virtual text")).toBeUndefined();
  });

  it("finds end-of-line text after the line's end, a few cells off too", () => {
    const row = rowOf("let x = 1;   ■ unused");
    const spans = [
      { row: 0, col: 12, text: "  ■ unused", kind: "eol" as const },
    ];
    expect(placeDecor(row, spans)).toEqual([
      { start: 11, end: 21, align: "left" },
    ]);
  });

  it("finds right-aligned text only where it ends at the edge", () => {
    const row = rowOf("text           You, 2 days ago", 30);
    const spans = [
      { row: 0, col: 4, text: "You, 2 days ago", kind: "right" as const },
    ];
    expect(placeDecor(row, spans)).toEqual([
      { start: 15, end: 30, align: "right" },
    ]);
    expect(placeDecor(rowOf("You, 2 days ago", 30), spans)).toEqual([]);
  });

  it("puts an inline hint's slack away from the code it names", () => {
    const row = rowOf("foo(name: a): i32");
    expect(
      placeDecor(row, [
        { row: 0, col: 4, text: "name: ", kind: "inline" },
        { row: 0, col: 12, text: ": i32", kind: "inline" },
      ]),
    ).toEqual([
      { start: 4, end: 10, align: "right" },
      { start: 12, end: 17, align: "left" },
    ]);
  });

  it("leaves out what the row does not hold now (a redraw behind)", () => {
    const row = rowOf("let y = 2;");
    expect(
      placeDecor(row, [{ row: 0, col: 5, text: ": i32", kind: "inline" }]),
    ).toEqual([]);
    expect(
      placeDecor(row, [{ row: 0, col: 4, text: "4 lines", kind: "fold" }]),
    ).toEqual([]);
  });

  it("sets the words only: padding and line drawing stay on cells", () => {
    const row = rowOf("    │   └──── unused  ");
    expect(wordsOf(row, { start: 4, end: 22 })).toEqual({ start: 14, end: 20 });
    expect(wordsOf(row, { start: 4, end: 13 })).toBeUndefined();
    const wide = rowOf("  変数  ");
    expect(wordsOf(wide, { start: 0, end: 8 })).toEqual({ start: 2, end: 6 });
  });

  it("reads the event's payload by window, dropping what is malformed", () => {
    const decor = decorOf({
      wins: {
        "1000": [
          { row: 1, col: 2, text: "x", kind: "eol" },
          { row: 1, col: 2, text: "x", kind: "overlay" },
          { row: "1", col: 2, text: "x", kind: "eol" },
        ],
      },
    });
    expect(decor.get(1000)).toEqual([
      { row: 1, col: 2, text: "x", kind: "eol" },
    ]);
    expect(decorOf(undefined).size).toBe(0);
  });
});

describe("a closed fold's line", () => {
  const row = (text: string) => ({
    chars: [...text],
    base: 0,
    width: text.length,
  });

  it("is found from its marker, its chevron a level's two cells in", () => {
    const text = "+---  21 lines: Options·········";
    const fold = foldLineOf(row(text), [
      {
        row: 0,
        col: 0,
        text: "+---  21 lines: Options",
        kind: "fold",
        level: 2,
        count: 21,
        words: "Options",
      },
    ]);
    expect(fold).toEqual({ start: 0, chevron: 2, words: "Options", count: 21 });
  });

  it("keeps a person's foldtext as their words, with no count", () => {
    const fold = foldLineOf(row("  my fold ···"), [
      { row: 0, col: 0, text: "  my fold", kind: "fold", level: 1 },
    ]);
    expect(fold).toMatchObject({ words: "my fold", count: undefined });
  });

  it("is not drawn where the row no longer holds it", () => {
    expect(
      foldLineOf(row("let x = 1"), [
        { row: 0, col: 0, text: "+-- 3 lines: x", kind: "fold" },
      ]),
    ).toBeUndefined();
  });
});

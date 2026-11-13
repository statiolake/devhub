import { describe, expect, it } from "vitest";
import type { FramePlace } from "./layers";
import {
  fieldRuns,
  frameParts,
  frameRowHeight,
  frameRows,
  wheelRows,
} from "./FramedView";

describe("framed view rows", () => {
  it("are a line and a third tall, and as many as fit are told", () => {
    expect(frameRowHeight(18)).toBe(24);
    expect(frameRows(17 * 18 - 8, 24)).toBe(12);
    expect(frameRows(10, 24)).toBe(1);
  });

  it("scroll at least a row per wheel notch, either way", () => {
    expect(wheelRows(0, 24)).toBe(0);
    expect(wheelRows(5, 24)).toBe(1);
    expect(wheelRows(-100, 24)).toBe(-4);
  });
});

describe("frameParts", () => {
  const rect = { row: 3, col: 14, width: 112, height: 48, top: 0 };
  const place: FramePlace = {
    id: 1,
    win: 1002,
    wins: [1002, 1004, 1003, 1005],
    frame: rect,
    query: {
      ...rect,
      height: 2,
      text: "",
      caret: 0,
      current: true,
      insert: true,
    },
    list: { ...rect, row: 5, width: 62, height: 46, cursor: 1, current: false },
    preview: { ...rect, row: 6, col: 76, width: 50, height: 44, win: 1005 },
  };

  it("puts the header on the query's rows, the hints on the last row, the title over the preview", () => {
    expect(frameParts(place, true, true)).toEqual({
      header: { row: 0, col: 0, width: 112, height: 2 },
      list: { row: 2, col: 0, width: 62, height: 45 },
      previewTitle: { row: 2, col: 62, width: 50, height: 1 },
      keys: { row: 47, col: 0, width: 112, height: 1 },
    });
  });

  it("gives the list the rows the hints and the title do not take", () => {
    const parts = frameParts(
      { ...place, query: undefined, preview: undefined },
      false,
      true,
    );
    expect(parts.header).toEqual({ row: 0, col: 0, width: 112, height: 2 });
    expect(parts.list).toEqual({ row: 2, col: 0, width: 62, height: 46 });
    expect(parts.previewTitle).toBeUndefined();
    expect(parts.keys).toBeUndefined();
  });
});

describe("the query field's cursor and selection", () => {
  const show = (runs: ReturnType<typeof fieldRuns>) =>
    runs.map((r) => `${r.caret ? "[" : ""}${r.selected ? "<" : ""}${r.text}`);

  it("puts the cursor on its character, or a blank past the end", () => {
    // Normal mode on the "l" of "file1" (byte 2): a block over it.
    expect(show(fieldRuns("file1", 2))).toEqual(["fi", "[l", "e1"]);
    // Insert mode at the end: a bar there, before a blank.
    expect(show(fieldRuns("file1", 5))).toEqual(["file1", "[ "]);
    // An empty query has the cursor alone.
    expect(show(fieldRuns("", 0))).toEqual(["[ "]);
    // Not the query's turn: no cursor.
    expect(show(fieldRuns("file1", undefined))).toEqual(["file1"]);
  });

  it("counts bytes: the cursor after a wide character is on the next", () => {
    // "日本" is 3 bytes a character: byte 3 is "本".
    expect(show(fieldRuns("日本x", 3))).toEqual(["日", "[本", "x"]);
  });

  it("selects Visual mode's bytes, the last character whole", () => {
    // `vh` from the "l": "il" selected, the cursor on the "i".
    expect(show(fieldRuns("file1", 1, [1, 2]))).toEqual([
      "f",
      "[<i",
      "<l",
      "e1",
    ]);
    expect(show(fieldRuns("日本x", 0, [0, 3]))).toEqual(["[<日", "<本", "x"]);
  });
});

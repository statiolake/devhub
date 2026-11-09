import { describe, expect, it } from "vitest";
import type { FramePlace } from "./layers";
import { frameParts, frameRowHeight, frameRows, wheelRows } from "./FramedView";

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

import { describe, expect, it } from "vitest";
import { draggedTopline, hitScrollbar, markTitle, thumbOf } from "./scrollbar";
import type { MarkRect } from "./marks";

describe("scrollbar", () => {
  const marks: MarkRect[] = [
    { x: 0, y: 50, w: 2, h: 2, color: "g", kind: "git", line: 26 },
    { x: 2, y: 51, w: 4, h: 2, color: "s", kind: "search", line: 26 },
    { x: 5, y: 120, w: 3, h: 2, color: "d", kind: "diag", line: 61 },
    { x: 0, y: 10, w: 8, h: 1, color: "c", kind: "cursor", line: 6 },
  ];
  const thumb = thumbOf(10, 20, 100, 0, 200);

  it("has a thumb for the view, at least 24 pixels", () => {
    expect(thumb).toEqual({ top: 0.1, size: 0.2 });
    expect(thumbOf(0, 1, 1000, 0, 200).size).toBe(24 / 200);
    expect(thumbOf(99, 20, 100, 0, 200).top).toBe(0.8);
  });

  it("goes to the mark under a press, the search before git", () => {
    const away = { top: 0.8, size: 0.1 };
    // The thumb wins over what it covers.
    expect(hitScrollbar(21, 200, thumb, [{ ...marks[1]!, y: 20 }])).toEqual({
      kind: "thumb",
    });
    expect(hitScrollbar(52, 200, away, marks)).toEqual({
      kind: "mark",
      mark: "search",
      line: 26,
    });
    expect(hitScrollbar(124, 200, away, marks)).toEqual({
      kind: "mark",
      mark: "diag",
      line: 61,
    });
  });

  it("drags the thumb and pages on the track; the cursor's mark is not a target", () => {
    expect(hitScrollbar(10, 200, thumb, marks)).toEqual({
      kind: "page",
      dir: -1,
    });
    expect(hitScrollbar(30, 200, thumb, marks)).toEqual({ kind: "thumb" });
    expect(hitScrollbar(180, 200, thumb, marks)).toEqual({
      kind: "page",
      dir: 1,
    });
  });

  it("maps a drag to a top line within the buffer", () => {
    expect(draggedTopline(0.1, 20, 200, 100)).toBe(21);
    expect(draggedTopline(0.1, -400, 200, 100)).toBe(1);
    expect(draggedTopline(0.8, 400, 200, 100)).toBe(100);
  });

  it("names the keys in its tooltip", () => {
    expect(markTitle({ kind: "mark", mark: "diag", line: 3 })).toContain("]d");
    expect(markTitle({ kind: "page", dir: 1 })).toContain("<C-f>");
  });
});

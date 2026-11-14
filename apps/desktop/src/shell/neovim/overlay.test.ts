import { describe, expect, it } from "vitest";
import {
  ModifierMoves,
  forwardsMoves,
  inSpans,
  mouseMoveKey,
  overlayAttr,
  overlayEventOf,
  sameOverlay,
  spanCells,
} from "./overlay";

describe("overlayEventOf", () => {
  it("reads a window's spans, the highlight, the pointer and held", () => {
    const event = overlayEventOf({
      id: "definition",
      win: 1000,
      spans: [{ row: 4, col0: 16, col1: 20 }],
      hl: { fg: 0x3794ff, underline: true, bold: false, nonsense: 1 },
      pointer: "pointer",
      held: true,
    });
    expect(event).toEqual({
      kind: "set",
      overlay: {
        id: "definition",
        win: 1000,
        spans: [{ row: 4, col0: 16, col1: 20 }],
        style: { foreground: 0x3794ff, underline: true },
        pointer: "pointer",
        held: true,
      },
    });
  });

  it("is a clear with no window or no spans, and nothing without an id", () => {
    expect(overlayEventOf({ id: "x" })).toEqual({ kind: "clear", id: "x" });
    expect(overlayEventOf({ id: "x", win: 1, spans: [] })).toEqual({
      kind: "clear",
      id: "x",
    });
    expect(overlayEventOf({ win: 1 })).toBeUndefined();
    expect(overlayEventOf(null)).toBeUndefined();
    expect(overlayEventOf([1])).toBeUndefined();
  });

  it("drops odd spans, colours and pointers", () => {
    const event = overlayEventOf({
      id: "x",
      win: 1,
      spans: [
        { row: 0, col0: 3, col1: 1 },
        { row: 0 },
        { row: 1, col0: 0, col1: 0 },
      ],
      hl: { fg: -1, bg: 0x1000000, sp: 1.5 },
      pointer: "url(evil)",
    });
    expect(event).toEqual({
      kind: "set",
      overlay: {
        id: "x",
        win: 1,
        spans: [{ row: 1, col0: 0, col1: 0 }],
        style: {},
        held: false,
      },
    });
  });
});

describe("overlayAttr", () => {
  it("puts the overlay's ink and underline over the cell's own", () => {
    expect(
      overlayAttr(
        {
          foreground: 1,
          background: 2,
          bold: true,
          reverse: true,
          undercurl: true,
          special: 9,
        },
        { foreground: 0x3794ff, underline: true },
      ),
    ).toEqual({
      foreground: 0x3794ff,
      background: 2,
      bold: true,
      reverse: false,
      underline: true,
      undercurl: false,
      underdouble: false,
      underdotted: false,
      underdashed: false,
      special: 0x3794ff,
    });
  });

  it("keeps the cell's underline when the overlay gives none", () => {
    expect(
      overlayAttr({ undercurl: true, special: 9 }, { background: 5 }),
    ).toEqual({ undercurl: true, special: 9, background: 5, reverse: false });
  });
});

describe("cells", () => {
  it("are the spans' cells, clipped to the grid", () => {
    expect(
      spanCells(10, 3, [
        { row: 1, col0: 8, col1: 12 },
        { row: 5, col0: 0, col1: 1 },
        { row: 0, col0: -2, col1: 0 },
      ]),
    ).toEqual([18, 19, 0]);
    expect(inSpans([{ row: 1, col0: 2, col1: 4 }], 1, 4)).toBe(true);
    expect(inSpans([{ row: 1, col0: 2, col1: 4 }], 1, 5)).toBe(false);
  });

  it("tells overlays apart by what they draw", () => {
    const a = overlayEventOf({
      id: "x",
      win: 1,
      spans: [{ row: 0, col0: 0, col1: 1 }],
    });
    const b = overlayEventOf({
      id: "x",
      win: 1,
      spans: [{ row: 0, col0: 0, col1: 2 }],
    });
    if (a?.kind !== "set" || b?.kind !== "set") throw new Error("not set");
    expect(sameOverlay(a.overlay, a.overlay)).toBe(true);
    expect(sameOverlay(a.overlay, b.overlay)).toBe(false);
  });
});

describe("modifier moves", () => {
  it("are sent with Ctrl, Alt or Cmd, not Shift alone or none", () => {
    expect(["A", "D", "C", "CS", "SA"].map(forwardsMoves)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(forwardsMoves("S")).toBe(false);
    expect(forwardsMoves("")).toBe(false);
  });

  it("name the key Neovim makes of them", () => {
    expect(mouseMoveKey("")).toBe("<MouseMove>");
    expect(mouseMoveKey("A")).toBe("<A-MouseMove>");
    expect(mouseMoveKey("CSAD")).toBe("<C-S-A-D-MouseMove>");
  });

  it("go as mouse moves while held, and one plain move when let go", () => {
    const moves = new ModifierMoves();
    const at = (col: number) => ({ grid: 2, row: 4, col });
    expect(moves.move(at(1), "")).toBeUndefined();
    expect(moves.move(at(2), "A")).toEqual({
      via: "mouse",
      at: at(2),
      modifiers: "A",
    });
    // The same cell, the same keys: nothing new.
    expect(moves.move(at(2), "A")).toBeUndefined();
    expect(moves.move(at(3), "A")).toEqual({
      via: "mouse",
      at: at(3),
      modifiers: "A",
    });
    // Let go over another cell: the plain move that says so.
    expect(moves.move(at(4), "")).toEqual({
      via: "mouse",
      at: at(4),
      modifiers: "",
    });
    expect(moves.move(at(5), "")).toBeUndefined();
    expect(moves.modifiers).toBe("");
  });

  it("are fed as the key at the cell Neovim would drop a move to", () => {
    const moves = new ModifierMoves();
    const at = { grid: 2, row: 0, col: 7 };
    moves.move(at, "A");
    // Alt up with the pointer still: Neovim would drop the move.
    expect(moves.move(at, "")).toEqual({
      via: "feed",
      key: "<MouseMove>",
      modifiers: "",
    });
    // And down again.
    expect(moves.move(at, "A")).toEqual({
      via: "feed",
      key: "<A-MouseMove>",
      modifiers: "A",
    });
    // A click there is Neovim's last mouse event too.
    const other = { grid: 2, row: 1, col: 1 };
    moves.mouse(other);
    expect(moves.move(other, "D")).toEqual({
      via: "feed",
      key: "<D-MouseMove>",
      modifiers: "D",
    });
  });

  it("say a move once more when asked again, only with keys held", () => {
    const moves = new ModifierMoves();
    const at = { grid: 2, row: 0, col: 7 };
    moves.move(at, "A");
    expect(moves.move(at, "A", true)).toEqual({
      via: "feed",
      key: "<A-MouseMove>",
      modifiers: "A",
    });
    moves.move(at, "");
    expect(moves.move(at, "", true)).toBeUndefined();
  });
});

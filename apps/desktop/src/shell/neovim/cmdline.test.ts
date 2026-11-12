import { describe, expect, it } from "vitest";
import { cmdlineByteCell, cmdlineLayout, textCells } from "./cmdline";

const at = (
  text: string,
  pos: number,
  extra: {
    indent?: number;
    special?: { char: string; shift: boolean };
    width?: number;
  } = {},
) => {
  const layout = cmdlineLayout(
    {
      content: [[0, text]],
      pos,
      indent: extra.indent ?? 0,
      ...(extra.special ? { special: extra.special } : {}),
    },
    extra.width ?? 80,
  );
  return {
    caret: layout.caret,
    text: layout.cells.map((c) => c.ch).join(""),
    layout,
  };
};

describe("the command line on cells", () => {
  it("puts the cursor on the character at its byte offset", () => {
    expect(at("%s/foo/bar", 10).caret).toEqual({ row: 0, col: 10 });
    // <Left> three times: before "bar".
    expect(at("%s/foo/bar", 7).caret).toEqual({ row: 0, col: 7 });
    expect(at("", 0).caret).toEqual({ row: 0, col: 0 });
  });

  it("counts bytes of multibyte text and cells of wide text", () => {
    // "日本" is 6 bytes and 4 cells; "é" 2 bytes and 1 cell.
    expect(at("e 日本語", 2).caret.col).toBe(2);
    expect(at("e 日本語", 5).caret.col).toBe(4);
    expect(at("e 日本語", 11).caret.col).toBe(8);
    expect(at("é!", 2).caret.col).toBe(1);
    const cells = at("日a", 0).layout.cells;
    expect(cells.map((c) => [c.ch, c.col, c.cells])).toEqual([
      ["日", 0, 2],
      ["a", 2, 1],
    ]);
  });

  it("keeps a combining mark on the character before it", () => {
    // "e" + U+0301: one cell, three bytes.
    const { layout, caret } = at("éx", 3);
    expect(layout.cells.map((c) => c.ch)).toEqual(["é", "x"]);
    expect(caret.col).toBe(1);
  });

  it("starts after the indent", () => {
    expect(at("if", 0, { indent: 4 }).caret.col).toBe(4);
    expect(at("if", 2, { indent: 4 }).caret.col).toBe(6);
  });

  it("shows a special character at the cursor, shifting or over the text", () => {
    // <C-v> before "bar": `^` put in, "bar" moves along.
    const shifted = at("foobar", 3, { special: { char: "^", shift: true } });
    expect(shifted.text).toBe("foo^bar");
    expect(shifted.caret.col).toBe(3);
    expect(shifted.layout.cells[3]?.special).toBe(true);
    // Without shift: over the character under the cursor.
    const over = at("foobar", 3, { special: { char: "?", shift: false } });
    expect(over.text).toBe("foo?ar");
    expect(over.caret.col).toBe(3);
    // At the end: after the text either way.
    expect(at("foo", 3, { special: { char: '"', shift: false } }).text).toBe(
      'foo"',
    );
  });

  it("wraps at the bar's width, a wide character not split", () => {
    const { layout, caret } = at("abcd日x", 9, { width: 5 });
    expect(layout.cells.map((c) => [c.ch, c.row, c.col])).toEqual([
      ["a", 0, 0],
      ["b", 0, 1],
      ["c", 0, 2],
      ["d", 0, 3],
      ["日", 1, 0],
      ["x", 1, 2],
    ]);
    expect(caret).toEqual({ row: 1, col: 3 });
    expect(layout.rows).toBe(2);
    // The cursor after a full row is on the next one.
    expect(at("abcde", 5, { width: 5 }).caret).toEqual({ row: 1, col: 0 });
  });

  it("keeps highlights per character", () => {
    const layout = cmdlineLayout(
      {
        content: [
          [3, "Name: "],
          [0, "x"],
        ],
        pos: 7,
        indent: 0,
      },
      80,
    );
    expect(layout.cells.map((c) => c.hl)).toEqual([3, 3, 3, 3, 3, 3, 0]);
    expect(layout.caret.col).toBe(7);
  });

  it("measures a prompt in cells", () => {
    expect(textCells("Name: ")).toBe(6);
    expect(textCells("名前: ")).toBe(6);
    expect(textCells(":")).toBe(1);
  });

  it("finds the cell of a byte of the text, for what lines up with it", () => {
    const line = { content: [[0, "e 漢字/ab"]] as const, indent: 0 };
    expect(cmdlineByteCell(line, 40, 0)).toEqual({ row: 0, col: 0 });
    // after "e " and the two wide characters (3 bytes, 2 cells each)
    expect(cmdlineByteCell(line, 40, 8)).toEqual({ row: 0, col: 6 });
    expect(cmdlineByteCell(line, 40, 9)).toEqual({ row: 0, col: 7 });
    // past the end: the cell after the text; wrapped: its row's cell
    expect(cmdlineByteCell(line, 40, 99)).toEqual({ row: 0, col: 9 });
    expect(cmdlineByteCell(line, 4, 9)).toEqual({ row: 1, col: 3 });
  });
});

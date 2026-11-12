/**
 * The command line bar's text on cells, pure: each character where
 * Neovim's own command line would put it — a wide one (漢字, かな) on two
 * cells, a combining mark on the character before it — wrapped at the
 * bar's width, and the cursor's cell from `cmdline_pos`, which is a byte
 * offset into the UTF-8 text. `cmdline_special_char` (after `<C-v>`,
 * `<C-k>`, `<C-r>`) is shown at the cursor: with `shift` it is put in
 * before the text after the cursor, which moves along; without, it is
 * shown over the character under the cursor.
 *
 * The bar draws the text from this, the caret at `caret`, and the editor
 * puts an IME's preedit (and its candidate window) there too.
 */

import { cellsOf } from "./ime";
import type { Chunks } from "./redraw";

export interface CmdlineCell {
  readonly ch: string;
  readonly hl: number;
  readonly row: number;
  readonly col: number;
  readonly cells: number;
  /** The special character shown at the cursor. */
  readonly special?: boolean;
}

export interface CmdlineLayout {
  readonly cells: readonly CmdlineCell[];
  /** The cursor's cell. */
  readonly caret: { readonly row: number; readonly col: number };
  /** Rows the text takes (at least one). */
  readonly rows: number;
}

/** A character's UTF-8 length. */
function utf8Length(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
}

/** The cells a string takes (a prompt, `firstc`). */
export function textCells(text: string): number {
  let n = 0;
  for (const ch of text) n += cellsOf(ch);
  return n;
}

export function cmdlineLayout(
  line: {
    readonly content: Chunks;
    readonly pos: number;
    readonly indent: number;
    readonly special?: { readonly char: string; readonly shift: boolean };
  },
  /** Cells to a row: the text wraps there. */
  width: number,
): CmdlineLayout {
  // The characters, as (character, highlight, byte offset).
  const chars: { ch: string; hl: number; byte: number; special?: boolean }[] =
    [];
  let byte = 0;
  for (let i = 0; i < line.indent; i += 1) {
    chars.push({ ch: " ", hl: 0, byte: -1 });
  }
  for (const [hl, text] of line.content) {
    for (const ch of text) {
      const last = chars.at(-1);
      if (cellsOf(ch) === 0 && last && last.byte >= 0) {
        last.ch += ch;
      } else {
        chars.push({ ch, hl, byte });
      }
      byte += utf8Length(ch);
    }
  }
  // The cursor is before the first character at or after its byte.
  let at = chars.findIndex((c) => c.byte >= line.pos);
  if (at < 0) at = chars.length;
  const special = line.special;
  if (special && special.char.length > 0) {
    const shown = { ch: special.char, hl: 0, byte: -1, special: true };
    if (special.shift || at >= chars.length) chars.splice(at, 0, shown);
    else chars.splice(at, 1, shown);
  }
  const cols = Math.max(1, width);
  const cells: CmdlineCell[] = [];
  let row = 0;
  let col = 0;
  let caret = { row: 0, col: 0 };
  chars.forEach((c, index) => {
    const n = Math.max(1, cellsOf(c.ch));
    if (col + n > cols) {
      row += 1;
      col = 0;
    }
    if (index === at) caret = { row, col };
    cells.push({
      ch: c.ch,
      hl: c.hl,
      row,
      col,
      cells: n,
      ...(c.special ? { special: true } : {}),
    });
    col += n;
  });
  if (at >= chars.length) {
    // After the last character: the next cell, on the next row at the edge.
    if (col >= cols) {
      row += 1;
      col = 0;
    }
    caret = { row, col };
  }
  return { cells, caret, rows: row + 1 };
}

/**
 * The cells `firstc` or an `input()` prompt takes before the text, as
 * Neovim's own command line has them: at least one, and never the whole
 * width.
 */
export function cmdlineLead(
  line: { readonly firstc: string; readonly prompt: string },
  cols: number,
): number {
  return Math.min(
    cols - 1,
    Math.max(1, textCells(line.firstc || line.prompt || "")),
  );
}

/** The rows a line of text takes, wrapped at `width` cells (at least one). */
export function wrappedRows(text: string, width: number): number {
  return Math.max(1, Math.ceil(textCells(text) / Math.max(1, width)));
}

/**
 * The cell of the character at a byte of the text (0-based; the first at
 * or after it, the cell after the text past its end), laid out as
 * `cmdlineLayout` lays the text: where something lined up with that byte
 * (a completion's word, `gui.popup{ anchor = { cmdline = col } }`) goes.
 */
export function cmdlineByteCell(
  line: {
    readonly content: Chunks;
    readonly indent: number;
  },
  width: number,
  byte: number,
): { readonly row: number; readonly col: number } {
  return cmdlineLayout(
    { content: line.content, indent: line.indent, pos: Math.max(0, byte) },
    width,
  ).caret;
}

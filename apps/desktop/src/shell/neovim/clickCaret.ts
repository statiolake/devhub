/**
 * Where a click puts Neovim's cursor, guessed from what is drawn, so the
 * caret is there in the frame the button goes down rather than a round trip
 * later (`provisional.ts`; `docs/neovim-editor.md`, "The pointer").
 *
 * A guess is made only where the grid says plainly what Neovim will do — a
 * click on a character of a window's text, on a space between two of them,
 * or past the end of a line (its last character; in Insert mode, after it).
 * Wherever the cells may not be the buffer's characters one for one, there
 * is no guess and the caret waits for Neovim: the gutter (numbers, signs,
 * folds), virtual text and inlay hints, concealed or `list` characters, a
 * closed fold, a diff's filler, the rows past the buffer's end, a line's
 * leading blanks (which may be a tab, where the cursor stands at its end),
 * and the rows of a winbar.
 *
 * Pure: the grid, its highlights and its margins in, a cell (or nothing) out.
 */

import type { Grid, HlAttr, Margins } from "./redraw";

/** A grid's cell. */
export interface Cell {
  readonly grid: number;
  readonly row: number;
  readonly col: number;
}

/** The gutter's groups: numbers, signs and folds, cursor line or not. */
const GUTTER = new Set([
  "LineNr",
  "LineNrAbove",
  "LineNrBelow",
  "CursorLineNr",
  "SignColumn",
  "CursorLineSign",
  "FoldColumn",
  "CursorLineFold",
]);

/** Groups of cells that are not the buffer's characters as they are. */
const NOT_TEXT =
  /Virt|Inlay|Hint|Conceal|NonText|Whitespace|EndOfBuffer|Ghost|Folded|DiffDelete/;

/** A row no click can be guessed on: a fold, a filler, the buffer's end. */
const NOT_A_LINE = /^(Folded|DiffDelete|EndOfBuffer)$/;

/** Neovim's mode, as `mode_change` names it, and what a click does in it. */
export function clickMode(mode: string): "normal" | "insert" | undefined {
  if (mode.startsWith("insert") || mode.startsWith("replace")) return "insert";
  if (
    mode === "normal" ||
    mode.startsWith("visual") ||
    mode.startsWith("select")
  )
    return "normal";
  return undefined;
}

/**
 * What a row of a window's grid shows of its buffer line, as far as the
 * cells say: where its text area starts after the gutter (`start`), its
 * first and last characters (-1 on an empty line), and the right edge of
 * the text area. Undefined on a row that is no line's (a closed fold, a
 * diff's filler, the rows past the buffer, a winbar).
 */
export interface LineCells {
  readonly start: number;
  readonly first: number;
  readonly last: number;
  readonly right: number;
  /** Whether the cell is not a buffer character as it is (virtual text…). */
  readonly virtual: (col: number) => boolean;
  /** The column a click at `col` is (a wide character's right half: its left). */
  readonly whole: (col: number) => number;
  /**
   * Whether the gutter shows a number: the row starts a line (a wrapped
   * line's next rows leave the number column blank).
   */
  readonly numbered: boolean;
}

export function lineCells(
  grid: Grid,
  hl: ReadonlyMap<number, HlAttr>,
  margins: Margins | undefined,
  row: number,
): LineCells | undefined {
  const top = margins?.top ?? 0;
  const bottom = grid.height - (margins?.bottom ?? 0);
  const left = margins?.left ?? 0;
  const right = grid.width - (margins?.right ?? 0);
  if (row < top || row >= bottom) return undefined;
  const groups = (col: number) =>
    hl.get(grid.hls[row * grid.width + col] ?? 0)?.groups ?? [];
  const char = (col: number) => grid.chars[row * grid.width + col] ?? " ";
  // The gutter: the cells from the left in its groups.
  let start = left;
  while (start < right && groups(start).some((g) => GUTTER.has(g))) start += 1;
  let numbered = false;
  for (let col = left; col < start; col += 1)
    if (/\d/.test(char(col))) numbered = true;
  let first = -1;
  let last = -1;
  for (let col = start; col < right; col += 1) {
    const own = groups(col);
    if (own.some((g) => NOT_A_LINE.test(g))) return undefined;
    if (own.some((g) => NOT_TEXT.test(g))) continue;
    if (char(col) === " ") continue;
    if (first < 0) first = col;
    last = col;
  }
  return {
    start,
    first,
    last,
    right,
    virtual: (col) => groups(col).some((g) => NOT_TEXT.test(g)),
    // The right half of a wide character is the character.
    whole: (col) => (col > start && char(col) === "" ? col - 1 : col),
    numbered,
  };
}

export function predictClick(
  grid: Grid,
  hl: ReadonlyMap<number, HlAttr>,
  margins: Margins | undefined,
  at: Cell,
  mode: "normal" | "insert",
): Cell | undefined {
  const { row } = at;
  const line = lineCells(grid, hl, margins, row);
  const left = margins?.left ?? 0;
  if (line === undefined || at.col < left || at.col >= line.right) return;
  const { start, first, last, right, whole } = line;
  if (at.col < start) return;
  const place = (col: number): Cell => ({ grid: at.grid, row, col });
  if (last < 0) {
    // An empty line: its first cell, whatever the mode.
    return place(start);
  }
  if (at.col > last) {
    // Past the line's end: on its last character; in Insert mode after it.
    if (mode === "insert") {
      const end = last + 1;
      return end < right ? place(end) : undefined;
    }
    return place(whole(last));
  }
  if (line.virtual(at.col)) return;
  // A leading blank may be a tab, which Neovim puts the cursor at the end of.
  if (at.col < first) return;
  return place(whole(at.col));
}

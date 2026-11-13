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

export function predictClick(
  grid: Grid,
  hl: ReadonlyMap<number, HlAttr>,
  margins: Margins | undefined,
  at: Cell,
  mode: "normal" | "insert",
): Cell | undefined {
  const { row } = at;
  const top = margins?.top ?? 0;
  const bottom = grid.height - (margins?.bottom ?? 0);
  const left = margins?.left ?? 0;
  const right = grid.width - (margins?.right ?? 0);
  if (row < top || row >= bottom || at.col < left || at.col >= right) return;
  const groups = (col: number) =>
    hl.get(grid.hls[row * grid.width + col] ?? 0)?.groups ?? [];
  const char = (col: number) => grid.chars[row * grid.width + col] ?? " ";
  // The gutter: the cells from the left in its groups.
  let start = left;
  while (start < right && groups(start).some((g) => GUTTER.has(g))) start += 1;
  if (at.col < start) return;
  // What the line's characters are, as far as the cells say.
  let first = -1;
  let last = -1;
  for (let col = start; col < right; col += 1) {
    const own = groups(col);
    if (own.some((g) => NOT_A_LINE.test(g))) return;
    if (own.some((g) => NOT_TEXT.test(g))) continue;
    const c = char(col);
    if (c === " ") continue;
    if (first < 0) first = col;
    last = col;
  }
  // The right half of a wide character is the character.
  const whole = (col: number) =>
    col > start && char(col) === "" ? col - 1 : col;
  const place = (col: number): Cell => ({ grid: at.grid, row, col });
  if (last < 0) {
    // An empty line: its first cell, whatever the mode.
    return at.col >= start ? place(start) : undefined;
  }
  if (at.col > last) {
    // Past the line's end: on its last character; in Insert mode after it.
    if (mode === "insert") {
      const end = last + 1;
      return end < right ? place(end) : undefined;
    }
    return place(whole(last));
  }
  if (groups(at.col).some((g) => NOT_TEXT.test(g))) return;
  // A leading blank may be a tab, which Neovim puts the cursor at the end of.
  if (at.col < first) return;
  return place(whole(at.col));
}

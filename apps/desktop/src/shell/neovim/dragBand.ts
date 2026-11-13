/**
 * Visual's band in a drag, drawn where the pointer is before Neovim's
 * redraw says so (`docs/neovim-editor.md`, "The pointer"; `provisional.ts`).
 *
 * A drag from a window's cell is charwise Visual from the press to the
 * pointer, both ends included (`'selection'` inclusive): on the first row
 * from the press to the line's end and its newline (one cell past the
 * last character), whole lines between (an empty line: its newline's
 * cell), and on the last row from the text's start to the pointer. Past a
 * line's end an end is the line's last character.
 *
 * As `clickCaret.ts`, only where the cells say plainly what Neovim will
 * select: no band when a row in it is no line's (a fold, a filler, past
 * the buffer), when an end is in the gutter, on virtual text or among a
 * line's leading blanks (which may be a tab), or when a row before the
 * last fills the window to its edge (it may wrap onto the next row) and
 * the next row has no line number of its own.
 *
 * Pure: the grid in, the cells to draw as Visual out.
 */

import { lineCells, type LineCells } from "./clickCaret";
import type { Grid, HlAttr, Margins } from "./redraw";

/** A run of a row's cells, both ends included. */
export interface BandSpan {
  readonly row: number;
  readonly col0: number;
  readonly col1: number;
}

export function dragBand(
  grid: Grid,
  hl: ReadonlyMap<number, HlAttr>,
  margins: Margins | undefined,
  from: { readonly row: number; readonly col: number },
  to: { readonly row: number; readonly col: number },
): BandSpan[] | undefined {
  const before =
    from.row < to.row || (from.row === to.row && from.col <= to.col);
  const a = before ? from : to;
  const b = before ? to : from;
  const lines = new Map<number, LineCells>();
  for (let row = a.row; row <= b.row; row += 1) {
    const line = lineCells(grid, hl, margins, row);
    if (line === undefined) return undefined;
    lines.set(row, line);
  }
  /** An end's column: the character at it, the last one past the end. */
  const end = (line: LineCells, col: number): number | undefined => {
    if (col < line.start || col >= line.right) return undefined;
    if (line.last < 0) return line.start;
    if (col > line.last) return line.whole(line.last);
    if (line.virtual(col) || col < line.first) return undefined;
    return line.whole(col);
  };
  const la = lines.get(a.row);
  const lb = lines.get(b.row);
  if (la === undefined || lb === undefined) return undefined;
  const ca = end(la, a.col);
  const cb = end(lb, b.col);
  if (ca === undefined || cb === undefined) return undefined;
  /** The newline's cell after a line, or its first on an empty one. */
  const newline = (line: LineCells) =>
    line.last < 0 ? line.start : Math.min(line.right - 1, line.last + 1);
  if (a.row === b.row) {
    const wide = (col: number) =>
      grid.chars[a.row * grid.width + col + 1] === "" ? col + 1 : col;
    return [{ row: a.row, col0: ca, col1: wide(cb) }];
  }
  const spans: BandSpan[] = [];
  for (let row = a.row; row <= b.row; row += 1) {
    const line = lines.get(row);
    if (line === undefined) return undefined;
    // A row filled to the edge may go on, wrapped, on the next: unless
    // the next shows a line number of its own (it starts a line).
    if (
      row < b.row &&
      line.last >= line.right - 1 &&
      lines.get(row + 1)?.numbered !== true
    )
      return undefined;
    if (row === a.row) spans.push({ row, col0: ca, col1: newline(line) });
    else if (row === b.row) {
      const wide = grid.chars[row * grid.width + cb + 1] === "" ? cb + 1 : cb;
      spans.push({ row, col0: line.start, col1: wide });
    } else spans.push({ row, col0: line.start, col1: newline(line) });
  }
  return spans;
}

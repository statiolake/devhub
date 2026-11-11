/**
 * The footers and the command line's rows, together: each footer is in the
 * status line row Neovim keeps under its window, and what DevHub draws in
 * the `cmdheight` rows (the mode, the search echo, the box being typed in)
 * is in those rows, never over a footer's (`docs/neovim-editor.md`,
 * "Status lines").
 */
import { describe, expect, it } from "vitest";
import type { GridBox } from "./redraw";
import { cmdlinePlace } from "./place";
import { NO_STATUSLINE, footersOf } from "./statusline";

const COLS = 81;
const ROWS = 30;

const win = (
  grid: number,
  row: number,
  col: number,
  width: number,
  height: number,
): GridBox => ({
  grid,
  row,
  col,
  width,
  height,
  z: 1,
  float: false,
  win: 1000 + grid,
});

/**
 * Two windows side by side over a third, as Neovim lays them out with
 * this `laststatus` and `cmdheight`: the lowest window ends on the row
 * above the status line (2) or the global one (3).
 */
function layout(cmdheight: number): GridBox[] {
  const last = ROWS - cmdheight;
  const bottomEnd = last - 1;
  return [
    { ...win(1, 0, 0, COLS, ROWS), win: undefined },
    win(2, 0, 0, 40, 13),
    win(3, 0, 41, 40, 13),
    win(4, 14, 0, COLS, bottomEnd - 14),
  ];
}

/** The row under the lowest window, as `NeovimEditor.statusRow` says. */
function statusRow(boxes: readonly GridBox[]): number {
  return Math.max(
    ...boxes.filter((b) => b.grid !== 1).map((b) => b.row + b.height),
  );
}

const overlaps = (a0: number, a1: number, b0: number, b1: number) =>
  a0 < b1 - 1e-9 && b0 < a1 - 1e-9;

describe("footers and the command line's rows", () => {
  // Cell heights as the terminal font gives them: whole device pixels at
  // 2x (16.5), at 1x (17), a round one (20).
  for (const ch of [16.5, 17, 20])
    for (const laststatus of [2, 3] as const)
      for (const cmdheight of [0, 1, 2, 3])
        it(`ch ${String(ch)}, laststatus ${String(laststatus)}, cmdheight ${String(cmdheight)}: nothing is over a footer`, () => {
          const boxes = layout(cmdheight);
          const footers = footersOf(
            boxes,
            { width: COLS, height: ROWS },
            {
              laststatus,
              cmdheight,
              current: 1004,
              statusline: NO_STATUSLINE,
            },
          );
          expect(footers.length).toBe(laststatus === 3 ? 1 : 3);
          // Each footer is the row under its window, above the cmdheight rows.
          const lowest = footers.reduce((m, f) => Math.max(m, f.row), 0);
          expect(lowest).toBe(ROWS - cmdheight - 1);
          const place = cmdlinePlace({
            gridCols: COLS,
            gridRows: ROWS,
            cell: { width: 8, height: ch },
            cmdheight,
            statusRow: statusRow(boxes),
          });
          for (const f of footers)
            expect(
              overlaps(
                place.top,
                place.top + place.height,
                f.row * ch,
                (f.row + 1) * ch,
              ),
            ).toBe(false);
          if (cmdheight > 0) {
            // In the rows kept for it, its text on them.
            const bandTop = (ROWS - cmdheight) * ch;
            expect(place.top).toBeGreaterThanOrEqual(bandTop);
            expect(place.top + place.height).toBeLessThanOrEqual(ROWS * ch);
            expect(place.textTop).toBeGreaterThanOrEqual(bandTop);
            expect(place.textTop + ch).toBeLessThanOrEqual(ROWS * ch);
            expect(place.row).toBeGreaterThanOrEqual(ROWS - cmdheight);
          } else {
            // No rows: over the lowest window's last lines, above its footer.
            expect(place.top + place.height).toBeLessThanOrEqual(lowest * ch);
          }
        });

  it("with cmdheight=1 the box is the row, its text on the row's cells", () => {
    const ch = 16.5;
    const place = cmdlinePlace({
      gridCols: COLS,
      gridRows: ROWS,
      cell: { width: 8, height: ch },
      cmdheight: 1,
      statusRow: ROWS - 1,
    });
    expect(place.top).toBe((ROWS - 1) * ch);
    expect(place.height).toBe(ch);
    expect(place.textTop).toBe((ROWS - 1) * ch);
    expect(place.row).toBe(ROWS - 1);
    // The content's top in the box (the band's `nvim-cmdline-content`):
    // the text on the row, the hairline over its leading.
    expect(place.textTop - place.top).toBe(1 + place.padY);
  });

  it("a prompt taller than the rows still grows upward over the windows", () => {
    const ch = 16.5;
    const place = cmdlinePlace({
      gridCols: COLS,
      gridRows: ROWS,
      cell: { width: 8, height: ch },
      cmdheight: 1,
      statusRow: ROWS - 1,
      rows: 3,
    });
    expect(place.rows).toBe(3);
    expect(place.top).toBeLessThan((ROWS - 1) * ch);
  });
});

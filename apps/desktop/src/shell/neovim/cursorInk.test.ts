import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  glideFrames,
  inkPlace,
  inkSpan,
  shiftedRows,
  slideSpan,
} from "./cursorInk";

const cell = { width: 7, height: 16.5 };

/** A grid of `rows` rows of `text` (a wide character's second cell is ""). */
function gridOf(rows: readonly string[][]) {
  const width = rows[0]?.length ?? 0;
  return { width, height: rows.length, chars: rows.flat() };
}

const ascii = (s: string) => [...s];

describe("the cursor's ink: which cells", () => {
  const grid = gridOf([
    ascii("0123456789"),
    ascii("abcdefghij"),
    ascii("ABCDEFGHIJ"),
  ]);
  // The grid's first cell at the editor's cell (1, 2).
  const origin = { row: 1, col: 2 };

  it("is the cell under the cursor at rest, and a column each side", () => {
    const at = { x: (2 + 4) * cell.width, y: (1 + 1) * cell.height };
    expect(
      inkSpan([{ ...at, w: cell.width, h: cell.height }], origin, grid, cell),
    ).toEqual({ row0: 1, row1: 2, col0: 3, col1: 6 });
  });

  it("covers the way a glide goes: where it was seen and where it is", () => {
    const to = { x: (2 + 7) * cell.width, y: (1 + 2) * cell.height };
    const from = { x: (2 + 1) * cell.width, y: (1 + 0) * cell.height };
    expect(
      inkSpan(
        [
          { ...to, w: cell.width, h: cell.height },
          { ...from, w: cell.width, h: cell.height },
        ],
        origin,
        grid,
        cell,
      ),
    ).toEqual({ row0: 0, row1: 3, col0: 0, col1: 9 });
  });

  it("is clamped to the grid, and nothing off it", () => {
    expect(
      inkSpan(
        [{ x: 0, y: 0, w: cell.width, h: cell.height }],
        { row: 5, col: 5 },
        grid,
        cell,
      ),
    ).toBeUndefined();
    const span = inkSpan(
      [{ x: 2 * cell.width, y: cell.height, w: cell.width, h: cell.height }],
      origin,
      grid,
      cell,
    );
    expect(span).toEqual({ row0: 0, row1: 1, col0: 0, col1: 2 });
  });

  it("takes a wide character whole, on either edge", () => {
    // 日 on cells 2-3, 本 on cells 5-6 of the row.
    const wide = gridOf([["a", "b", "日", "", "c", "本", "", "d"]]);
    // The cursor on `c` (cell 4): one column more each side lands on the
    // second cell of 日 and the first of 本 — both are taken whole.
    const span = inkSpan(
      [{ x: 4 * cell.width, y: 0, w: cell.width, h: cell.height }],
      { row: 0, col: 0 },
      wide,
      cell,
    );
    expect(span).toEqual({ row0: 0, row1: 1, col0: 2, col1: 7 });
  });
});

describe("the cursor's ink: where", () => {
  it("is on the grid's cells whatever the cursor's shape or place", () => {
    const span = { row0: 3, row1: 4, col0: 9, col1: 12 };
    const origin = { row: 1, col: 2 };
    // The cells' place in the editor.
    const cells = { x: (2 + 9) * cell.width, y: (1 + 3) * cell.height };
    // A block on cell 10, an underline at its foot, a bar.
    for (const cursor of [
      { x: (2 + 10) * cell.width, y: (1 + 3) * cell.height },
      { x: (2 + 10) * cell.width, y: (1 + 4) * cell.height - 3 },
      { x: (2 + 11) * cell.width, y: (1 + 3) * cell.height },
    ]) {
      const place = inkPlace(span, origin, cursor, cell);
      expect(cursor.x + place.left).toBeCloseTo(cells.x);
      expect(cursor.y + place.top).toBeCloseTo(cells.y);
    }
  });

  it("stays on the text through a glide: the two translates cancel", () => {
    const dx = -5 * cell.width;
    const dy = 2 * cell.height;
    const { cursor, ink } = glideFrames(dx, dy);
    const parse = (frame: Keyframe | undefined) =>
      String(frame?.translate ?? "")
        .split(" ")
        .map((v) => parseFloat(v));
    const [c0, c1] = [parse(cursor[0]), parse(cursor[1])];
    const [i0, i1] = [parse(ink[0]), parse(ink[1])];
    expect(c0).toEqual([dx, dy]);
    expect(c1).toEqual([0, 0]);
    // Both interpolate on one clock and easing: at every progress `p` the
    // shape is at `d·(1 − p)` and the ink at `−d·(1 − p)` inside it.
    for (const p of [0, 0.1, 0.37, 0.5, 0.9, 1]) {
      const lerp = (a: number[], b: number[], k: number) =>
        (a[k] ?? 0) + ((b[k] ?? 0) - (a[k] ?? 0)) * p;
      const shape = [lerp(c0, c1, 0), lerp(c0, c1, 1)];
      const inside = [lerp(i0, i1, 0), lerp(i0, i1, 1)];
      expect((shape[0] ?? 0) + (inside[0] ?? 0)).toBeCloseTo(0);
      expect((shape[1] ?? 0) + (inside[1] ?? 0)).toBeCloseTo(0);
      // ...while the shape itself moves over the text.
      if (p < 1) expect(Math.abs(shape[0] ?? 0)).toBeGreaterThan(0);
    }
  });
});

describe("the cursor's ink while the text moves under it", () => {
  it("holds the rows lines slide in from (a `dd`, an `o`)", () => {
    // The slide's image starts `rows` rows down (`translateY(rows · ch)`),
    // so a cursor's row shows the region's rows from `rows` above it on.
    const span = { row0: 12, row1: 13, col0: 3, col1: 6 };
    // `dd` on row 10: the rows under it close up, row 11 passing row 12.
    expect(slideSpan(span, { top: 10, bot: 30, rows: 1 })).toEqual({
      ...span,
      row0: 11,
    });
    // An `o` on row 10: the rows open up, row 13 passing row 12.
    expect(slideSpan(span, { top: 10, bot: 30, rows: -1 })).toEqual({
      ...span,
      row1: 14,
    });
    // Only the region's rows: a `dd` on the cursor's own row shows a gap
    // above the region, not the row above it.
    expect(slideSpan(span, { top: 12, bot: 30, rows: 1 })).toEqual(span);
    // A region elsewhere adds nothing.
    expect(slideSpan(span, { top: 20, bot: 30, rows: 2 })).toEqual(span);
  });

  it("holds the rows a scrolled display shows at a still cursor", () => {
    // Its canvas at translateY(-off): row r shows grid row r + off / ch.
    expect(shiftedRows(39, 40, -16.5, 16.5, 41)).toEqual({
      row0: 38,
      row1: 40,
    });
    expect(shiftedRows(39, 40, 8, 16.5, 41)).toEqual({ row0: 39, row1: 41 });
    expect(shiftedRows(39, 40, 0, 16.5, 41)).toEqual({ row0: 39, row1: 40 });
    expect(shiftedRows(40, 41, 33, 16.5, 41)).toEqual({ row0: 40, row1: 41 });
  });
});

describe("nothing of the text is drawn in the cursor itself", () => {
  const read = (path: string) =>
    readFile(new URL(path, import.meta.url), "utf8");

  it("the editor's cursor holds only its ink", async () => {
    const source = await read("./editor.ts");
    const appends = [...source.matchAll(/this\.cursor\.append\(([^)]*)\)/g)];
    expect(appends.map((m) => m[1])).toEqual(["this.ink"]);
    expect(source).not.toMatch(/paintCursorCell|this\.cursor\.textContent/);
  });

  it("the terminal's cursor holds only its ink", async () => {
    const source = await read("../terminal/control/ControlTerminalSurface.tsx");
    const appends = [...source.matchAll(/\bcursor\.append\(([^)]*)\)/g)];
    expect(appends.map((m) => m[1])).toEqual(["ink"]);
    expect(source).not.toMatch(/paintCursorCell/);
  });
});

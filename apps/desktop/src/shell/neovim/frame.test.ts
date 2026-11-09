import { describe, expect, it } from "vitest";
import {
  analyzeFrame,
  floatLabelsOf,
  frameGeometry,
  insideRounded,
  labelBox,
  type FloatFrame,
} from "./frame";
import { cutClip, frameCuts, framePieces, type FramedMember } from "./floats";
import { hitTest } from "./mouse";
import type { Grid, GridBox } from "./redraw";

/** A grid from rows of text, one cell per character; `hl` per row. */
function gridOf(
  rows: readonly string[],
  hl: (row: number, col: number) => number = () => 0,
): Grid {
  const width = [...(rows[0] ?? "")].length;
  const chars: string[] = [];
  const hls = new Int32Array(width * rows.length);
  rows.forEach((row, r) => {
    [...row].forEach((c, col) => {
      chars.push(c);
      hls[r * width + col] = hl(r, col);
    });
  });
  return { id: 4, width, height: rows.length, chars, hls, dirty: new Set() };
}

const ALL = { top: 1, right: 1, bottom: 1, left: 1 };

const rounded = gridOf(
  ["╭── Files ──╮", "│hello      │", "│world      │", "╰───────────╯"],
  (row, col) => (row === 0 && col >= 4 && col <= 8 ? 7 : 3),
);

describe("a float's border as a frame", () => {
  it("reads the sides, the corners and a title its config explains", () => {
    const seen = analyzeFrame(rounded, ALL, { title: " Files " });
    expect(seen.frame).toEqual({
      margins: ALL,
      sides: {
        top: { glyph: "─", hl: 3 },
        bottom: { glyph: "─", hl: 3 },
        left: { glyph: "│", hl: 3 },
        right: { glyph: "│", hl: 3 },
      },
      corners: { tl: "╭", tr: "╮", br: "╯", bl: "╰" },
      // The title's cells as Neovim sent them, its blanks included.
      labels: [
        {
          side: "top",
          col: 3,
          cells: 7,
          runs: [
            { text: " ", hl: 3, cells: 1 },
            { text: "Files", hl: 7, cells: 5 },
            { text: " ", hl: 3, cells: 1 },
          ],
        },
      ],
    });
  });

  it("reads a blank border (`'solid'`) and its title's own blanks", () => {
    const solid = gridOf(
      ["   Results   ", " hello       ", "             "],
      (row, col) => (row === 0 && col >= 2 && col <= 10 ? 7 : 3),
    );
    const frame = analyzeFrame(solid, ALL, { title: " Results " }).frame;
    expect(frame?.sides.top).toEqual({ glyph: " ", hl: 3 });
    expect(frame?.corners.tl).toBe(" ");
    expect(frame?.labels).toEqual([
      {
        side: "top",
        col: 2,
        cells: 9,
        runs: [{ text: " Results ", hl: 7, cells: 9 }],
      },
    ]);
    // Without its config, the text is not explained yet.
    expect(analyzeFrame(solid, ALL, undefined)).toEqual({ labels: true });
  });

  it("is drawn cell for cell while the border's text is not explained", () => {
    expect(analyzeFrame(rounded, ALL, undefined)).toEqual({ labels: true });
    expect(analyzeFrame(rounded, ALL, { title: "Other" })).toEqual({
      labels: true,
    });
    expect(analyzeFrame(rounded, ALL, {})).toEqual({ labels: true });
  });

  it("needs no config without text, and keeps a footer and runs of highlights", () => {
    const plain = gridOf(["┌──┐", "│ab│", "└──┘"]);
    expect(analyzeFrame(plain, ALL, undefined).frame?.corners).toEqual({
      tl: "┌",
      tr: "┐",
      br: "┘",
      bl: "└",
    });
    const footer = gridOf(["╔══════╗", "║abcdef║", "╚═1/20═╝"], (row, col) =>
      row === 2 && col === 3 ? 9 : 2,
    );
    const frame = analyzeFrame(footer, ALL, { footer: "1/20" }).frame;
    expect(frame?.sides.bottom).toEqual({ glyph: "═", hl: 2 });
    expect(frame?.labels).toEqual([
      {
        side: "bottom",
        col: 2,
        cells: 4,
        runs: [
          { text: "1", hl: 2, cells: 1 },
          { text: "/", hl: 9, cells: 1 },
          { text: "20", hl: 2, cells: 2 },
        ],
      },
    ]);
  });

  it("frames a border of any characters: ASCII, block elements, mixed sides", () => {
    for (const rows of [
      ["+--+", "|ab|", "+--+"],
      ["▛▀▀▜", "▌ab▐", "▙▄▄▟"],
      ["╭──╮", "│ab ", "╰──╯"],
    ])
      expect(analyzeFrame(gridOf(rows), ALL, {}).frame).toBeDefined();
  });

  it("is no frame for text in a side, a winbar, a border of two cells", () => {
    expect(
      analyzeFrame(gridOf(["╭──╮", "│ab│", "xab│", "╰──╯"]), ALL, {}),
    ).toEqual({});
    expect(
      analyzeFrame(
        gridOf(["winbar", "text  "]),
        { ...ALL, left: 0, right: 0, bottom: 0 },
        {},
      ),
    ).toEqual({ labels: true });
    // A border of two cells (a winbar under a border) is not one.
    expect(analyzeFrame(rounded, { ...ALL, top: 2 }, {})).toEqual({});
  });

  it("takes a border of some sides only (no corners where one is missing)", () => {
    const g = gridOf(["────", "ab  ", "────"]);
    const frame = analyzeFrame(
      g,
      { top: 1, right: 0, bottom: 1, left: 0 },
      {},
    ).frame;
    expect(frame?.sides).toEqual({
      top: { glyph: "─", hl: 0 },
      bottom: { glyph: "─", hl: 0 },
    });
    expect(frame?.corners).toEqual({});
  });

  it("knows a title from `nvim_win_get_config`'s string or chunks", () => {
    expect(floatLabelsOf({ title: " Files " })).toEqual({ title: " Files " });
    expect(
      floatLabelsOf({
        title: [
          [" a", "X"],
          ["b ", "Y"],
        ],
        footer: [["f", "Z"]],
      }),
    ).toEqual({ title: " ab ", footer: "f" });
    expect(floatLabelsOf({ title: "", footer: [] })).toEqual({});
    expect(floatLabelsOf(undefined)).toEqual({});
  });
});

const frameOf = (g: Grid): FloatFrame => {
  const frame = analyzeFrame(g, ALL, { title: " Files " }).frame;
  if (!frame) throw new Error("no frame");
  return frame;
};

describe("where a frame's line is", () => {
  const cell = { width: 8, height: 20 };
  const place = { row: 2, col: 3, width: 13, height: 4 };

  it("runs through the middle of the border's cells, one pixel, on whole device pixels", () => {
    const g = frameGeometry(ALL, place, cell, 2, 4);
    expect(g.widths).toEqual({ top: 1, right: 1, bottom: 1, left: 1 });
    // The text area is 32..120 by 60..100; the border's cells the one
    // around it, their middles half a cell out: the line centred on them.
    expect(g.x + g.widths.left / 2).toBe(4 * 8 - 4);
    expect(g.y + g.widths.top / 2).toBe(3 * 20 - 10);
    expect(g.x + g.w - g.widths.right / 2).toBe(15 * 8 + 4);
    expect(g.y + g.h - g.widths.bottom / 2).toBe(5 * 20 + 10);
    // One radius for every border, the floats' corner.
    expect(g.radii).toEqual({ tl: 4, tr: 4, br: 4, bl: 4 });
    for (const v of [g.x, g.y, g.x + g.w, g.y + g.h])
      expect((v * 2) % 1).toBe(0);
  });

  it("pads a float without a border as much, the line half a cell outside its cells", () => {
    const none = { top: 0, right: 0, bottom: 0, left: 0 };
    const g = frameGeometry(
      none,
      { row: 1, col: 2, width: 10, height: 3 },
      cell,
      2,
      4,
    );
    expect([g.x + 0.5, g.y + 0.5, g.x + g.w - 0.5, g.y + g.h - 0.5]).toEqual([
      2 * 8 - 4,
      20 - 10,
      12 * 8 + 4,
      4 * 20 + 10,
    ]);
  });

  it("keeps the line on the cells' middle at fractional ratios and row heights", () => {
    // Rows of 16.5 and 17.25 px (a line height, a linespace), at ratios
    // from 1 to 3: every side's middle within half a device pixel of the
    // border cells' middle, on whole device pixels, never always low.
    let drift = 0;
    let n = 0;
    for (const dpr of [1, 1.25, 1.5, 1.75, 2, 2.5, 3]) {
      for (const height of [16.5, 17.25, 19.6, 20]) {
        for (const width of [7.2, 8, 8.4]) {
          const c = { width, height };
          const at = { row: 3, col: 5, width: 20, height: 7 };
          const g = frameGeometry(ALL, at, c, dpr, 4);
          const w = g.widths.top;
          expect((w * dpr) % 1).toBeCloseTo(0, 9);
          const middles = [
            [g.y + w / 2, (at.row + 0.5) * height],
            [g.y + g.h - w / 2, (at.row + at.height - 0.5) * height],
            [g.x + w / 2, (at.col + 0.5) * width],
            [g.x + g.w - w / 2, (at.col + at.width - 0.5) * width],
          ];
          for (const [line, cells] of middles) {
            expect(Math.abs(line! - cells!)).toBeLessThanOrEqual(
              0.5 / dpr + 1e-9,
            );
            drift += line! - cells!;
            n += 1;
          }
          for (const v of [g.x, g.y, g.x + g.w, g.y + g.h])
            expect((v * dpr) % 1).toBeCloseTo(Math.round((v * dpr) % 1), 9);
        }
      }
    }
    // No bias downward (or upward) on average: rounded, not floored.
    expect(Math.abs(drift / n)).toBeLessThan(0.1);
  });

  it("puts a title's cells on its line, where Neovim gave them", () => {
    const frame = frameOf(rounded);
    const geo = frameGeometry(frame.margins, place, cell, 2, 4);
    const label = frame.labels[0];
    if (!label) throw new Error("no label");
    expect(labelBox(label, place, geo, cell)).toEqual({
      x: (3 + 3) * 8,
      w: 7 * 8,
      cy: geo.y + 0.5,
    });
  });

  it("tells inside from outside along a rounded corner", () => {
    const r = {
      x: 0,
      y: 0,
      w: 100,
      h: 50,
      radii: { tl: 10, tr: 0, br: 0, bl: 0 },
    };
    expect(insideRounded(r, 1, 1)).toBe(false);
    expect(insideRounded(r, 4, 4)).toBe(true);
    expect(insideRounded(r, 99, 0)).toBe(true);
    expect(insideRounded(r, 100, 10)).toBe(false);
  });
});

describe("a panel of framed floats", () => {
  const cell = { width: 8, height: 20 };
  const member = (
    grid: number,
    rect: { row: number; col: number; width: number; height: number },
    ruled = true,
    dpr = 1,
  ): FramedMember => ({
    grid,
    rect,
    ruled,
    geometry: frameGeometry(
      ruled ? ALL : { top: 0, right: 0, bottom: 0, left: 0 },
      rect,
      cell,
      dpr,
      4,
    ),
  });

  it("draws the edge a list and its preview share once, half way between them", () => {
    const list = member(4, { row: 0, col: 0, width: 10, height: 6 });
    const preview = member(5, { row: 0, col: 10, width: 10, height: 6 });
    const [a, b] = framePieces([list, preview], 1);
    expect(a?.draw).toEqual({
      top: true,
      right: true,
      bottom: true,
      left: true,
    });
    expect(b?.draw).toEqual({
      top: true,
      right: true,
      bottom: true,
      left: false,
    });
    // Two border columns, 9 and 10: the line through the left one's
    // middle (76), one pixel on whole pixels; the preview's ground from it.
    expect(a ? a.x + a.w : 0).toBe(77);
    expect(b?.x).toBe(77);
    // Only the panel's outer corners are round.
    expect(a?.radii.tr).toBe(0);
    expect(a?.radii.tl).toBeGreaterThan(0);
  });

  it("draws the edge beside two stacked members once", () => {
    const input = member(4, { row: 0, col: 0, width: 10, height: 3 });
    const list = member(5, { row: 3, col: 0, width: 10, height: 7 });
    const preview = member(6, { row: 0, col: 10, width: 10, height: 10 });
    const [i, l, p] = framePieces([input, list, preview], 1);
    // The two stacked members' right lines, not the preview's left.
    expect(p?.draw.left).toBe(false);
    expect(i?.draw.right).toBe(true);
    expect(l?.draw.right).toBe(true);
    expect(i ? i.x + i.w : 0).toBe(p?.x);
    // Input over list: the input's bottom line is theirs.
    expect(i?.draw.bottom).toBe(true);
    expect(l?.draw.top).toBe(false);
    expect(i ? i.y + i.h : 0).toBe(l?.y);
  });

  it("runs the line two members share through the row that holds a title", () => {
    // A picker's input over its list, the list's title in its top border
    // (snacks' "Results"): the line through that row's middle, the title
    // on it, not on the edge between the two border rows.
    const input = member(4, { row: 0, col: 0, width: 10, height: 3 }, true, 2);
    const list = {
      ...member(5, { row: 3, col: 0, width: 10, height: 7 }, true, 2),
      labelled: { top: true },
    };
    const [i, l] = framePieces([input, list], 2);
    expect(i?.draw.bottom).toBe(true);
    expect(l?.draw.top).toBe(false);
    // The line [69.5, 70.5]: the input's piece reaches its far side, the
    // list's ground starts there.
    expect(i ? i.y + i.h : 0).toBe(70.5);
    expect(l?.y).toBe(70.5);
    expect(
      labelBox(
        { side: "top", col: 1, cells: 7, runs: [] },
        { row: 3, col: 0, width: 10, height: 7 },
        list.geometry,
        cell,
      ).cy,
    ).toBe(70);
    // No title: through the upper one's bottom row instead (row 2, 50).
    const [i2] = framePieces([input, { ...list, labelled: {} }], 2);
    expect(i2 ? i2.y + i2.h : 0).toBe(50.5);
  });

  it("draws no line where a float without a border meets another", () => {
    // blink's menu and its documentation, side by side.
    const menu = member(4, { row: 0, col: 0, width: 10, height: 6 }, false, 2);
    const docs = member(5, { row: 0, col: 10, width: 10, height: 6 }, false, 2);
    const [a, b] = framePieces([menu, docs], 2);
    expect(a?.draw.right).toBe(false);
    expect(b?.draw.left).toBe(false);
    expect(a?.draw.left).toBe(true);
    // Their grounds meet at the edge they share.
    expect(a ? a.x + a.w : 0).toBe(80);
    expect(b?.x).toBe(80);
  });

  it("keeps a lone float's outline as its line", () => {
    const one = member(4, { row: 1, col: 1, width: 6, height: 4 });
    const [piece] = framePieces([one], 1);
    expect(piece).toMatchObject({
      x: one.geometry.x,
      y: one.geometry.y,
      w: one.geometry.w,
      h: one.geometry.h,
    });
  });
});

describe("a click on a framed float", () => {
  const cell = { width: 8, height: 20 };
  const box: GridBox = {
    grid: 4,
    row: 2,
    col: 3,
    width: 13,
    height: 4,
    z: 150,
    float: true,
    win: 1000,
    lined: true,
    frame: frameOf(rounded),
  };
  const base: GridBox = {
    grid: 1,
    row: 0,
    col: 0,
    width: 40,
    height: 10,
    z: 0,
    float: false,
    win: undefined,
  };

  it("is the float's inside its lines, what is behind outside them", () => {
    // The outer half of the left border cell: behind.
    expect(hitTest([base, box], cell, 3 * 8 + 1, 3 * 20 + 5).grid).toBe(1);
    // The inner half: the float's border cell.
    expect(hitTest([base, box], cell, 3 * 8 + 6, 3 * 20 + 5)).toEqual({
      grid: 4,
      row: 1,
      col: 0,
    });
    // Above the top line: behind; below it, the float.
    expect(hitTest([base, box], cell, 6 * 8, 2 * 20 + 3).grid).toBe(1);
    expect(hitTest([base, box], cell, 6 * 8, 2 * 20 + 15).grid).toBe(4);
    // The text area.
    expect(hitTest([base, box], cell, 5 * 8 + 2, 3 * 20 + 2)).toEqual({
      grid: 4,
      row: 1,
      col: 2,
    });
  });

  it("goes on toward a float edge to edge with it", () => {
    const next: GridBox = { ...box, grid: 5, col: 16, win: 1001 };
    // The outer half of the right border cell, next to the other float.
    expect(hitTest([base, box, next], cell, 15 * 8 + 7, 3 * 20 + 5)).toEqual({
      grid: 4,
      row: 1,
      col: 12,
    });
  });
});

describe("a picker's borderless box behind its framed windows", () => {
  const frame = frameOf(rounded);
  const at = (
    grid: number,
    col: number,
    width: number,
    z: number,
    extra: Partial<GridBox> = {},
  ): GridBox => ({
    grid,
    row: 2,
    col,
    width,
    height: 6,
    z,
    float: true,
    win: 1000 + grid,
    ...extra,
  });
  const root = at(42, 10, 40, 152);
  const list = at(44, 10, 20, 153, { lined: true, frame });
  const preview = at(47, 30, 20, 154, { lined: true, frame });

  it("is cut by the framed windows above it, not hidden", () => {
    expect([...frameCuts([root, list, preview]).entries()]).toEqual([
      [42, [list, preview]],
    ]);
    // A preview a row shorter: the box is cut all the same.
    const short = { ...preview, height: 5 };
    expect([...frameCuts([root, list, short]).keys()]).toEqual([42]);
    // Past the rectangle they span (a backdrop, a hover under the panel):
    // not their box, not cut.
    expect([
      ...frameCuts([{ ...root, width: 41 }, list, preview]).keys(),
    ]).toEqual([]);
    // Above them: not cut.
    expect([...frameCuts([{ ...root, z: 160 }, list, preview]).keys()]).toEqual(
      [],
    );
  });

  it("is drawn inside the frames' lines and where no frame is over it", () => {
    const cell = { width: 8, height: 20 };
    const shape = (col: number) => ({
      x: col * 8 + 4,
      y: 2 * 20 + 10,
      w: 20 * 8 - 8,
      h: 6 * 20 - 20,
      radii: { tl: 0, tr: 0, br: 0, bl: 0 },
    });
    const shapes = new Map([
      [44, shape(10)],
      [47, shape(30)],
    ]);
    const short = { ...preview, height: 5 };
    const clip = cutClip(root, [list, short], shapes, cell, { x: 80, y: 40 });
    // The cells under no frame (the preview's last row), then each
    // frame's inside.
    expect(clip).toBe(
      `path("M160 100h160v20h-160Z` +
        `M4 10L156 10L156 110L4 110L4 10ZM164 10L316 10L316 110L164 110L164 10Z")`,
    );
  });

  it("takes no click: outside the lines is what is behind", () => {
    const base: GridBox = {
      grid: 1,
      row: 0,
      col: 0,
      width: 80,
      height: 20,
      z: 0,
      float: false,
      win: undefined,
    };
    const cell = { width: 8, height: 20 };
    // The outer half of the list's left border cell.
    expect(
      hitTest([base, root, list, preview], cell, 10 * 8 + 1, 4 * 20).grid,
    ).toBe(1);
    expect(
      hitTest([base, root, list, preview], cell, 10 * 8 + 6, 4 * 20).grid,
    ).toBe(44);
  });
});

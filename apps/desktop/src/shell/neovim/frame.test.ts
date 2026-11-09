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

describe("a float's border of lines as a frame", () => {
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
      labels: [
        { side: "top", col: 4, cells: 5, runs: [{ text: "Files", hl: 7 }] },
      ],
    });
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
          { text: "1", hl: 2 },
          { text: "/", hl: 9 },
          { text: "20", hl: 2 },
        ],
      },
    ]);
  });

  it("is no frame for other borders: ASCII, block elements, a winbar, mixed sides", () => {
    expect(analyzeFrame(gridOf(["+--+", "|ab|", "+--+"]), ALL, {})).toEqual({});
    expect(analyzeFrame(gridOf(["▛▀▀▜", "▌ab▐", "▙▄▄▟"]), ALL, {})).toEqual({});
    expect(analyzeFrame(gridOf(["╭──╮", "│ab ", "╰──╯"]), ALL, {})).toEqual({});
    expect(
      analyzeFrame(
        gridOf(["winbar", "text  "]),
        { ...ALL, left: 0, right: 0, bottom: 0 },
        {},
      ),
    ).toEqual({});
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

describe("where a frame's lines are", () => {
  const cell = { width: 8, height: 20 };
  const place = { row: 2, col: 3, width: 13, height: 4 };

  it("is the float's edge at its lines, on whole device pixels", () => {
    const g = frameGeometry(frameOf(rounded), place, cell, 2, 13);
    // A light line at 13px is one CSS pixel (two device pixels), in the
    // middle of its cell: half a cell (less half the line) inside the box.
    expect(g.widths).toEqual({ top: 1, right: 1, bottom: 1, left: 1 });
    expect(g.x).toBe(3 * 8 + 3.5);
    expect(g.y).toBe(2 * 20 + 9.5);
    expect(g.x + g.w).toBe(15 * 8 + 4.5);
    expect(g.y + g.h).toBe(5 * 20 + 10.5);
    expect(g.styles.top).toBe("solid");
    // The rounded corner's arc, measured on its outer edge.
    expect(g.radii.tl).toBeCloseTo(4.5, 5);
    expect(g.radii).toEqual({
      tl: g.radii.tl,
      tr: g.radii.tl,
      br: g.radii.tl,
      bl: g.radii.tl,
    });
    // Every edge is on a device pixel.
    for (const v of [g.x, g.y, g.x + g.w, g.y + g.h])
      expect((v * 2) % 1).toBe(0);
  });

  it("has square corners for `single` and doubled lines for `double`", () => {
    const single = frameGeometry(
      frameOf(gridOf(["┌──┐", "│ab│", "└──┘"])),
      { row: 0, col: 0, width: 4, height: 3 },
      cell,
      1,
      13,
    );
    expect(single.radii).toEqual({ tl: 0, tr: 0, br: 0, bl: 0 });
    const double = frameGeometry(
      frameOf(gridOf(["╔══╗", "║ab║", "╚══╝"])),
      { row: 0, col: 0, width: 4, height: 3 },
      cell,
      1,
      13,
    );
    expect(double.styles).toEqual({
      top: "double",
      right: "double",
      bottom: "double",
      left: "double",
    });
    expect(double.widths.left).toBe(3);
  });

  it("ends a side without a border at the text area", () => {
    const g = gridOf(["────", "ab  ", "────"]);
    const frame = analyzeFrame(
      g,
      { top: 1, right: 0, bottom: 1, left: 0 },
      {},
    ).frame;
    if (!frame) throw new Error("no frame");
    const geo = frameGeometry(
      frame,
      { row: 0, col: 1, width: 4, height: 3 },
      cell,
      1,
      13,
    );
    expect(geo.x).toBe(8);
    expect(geo.w).toBe(32);
    expect(geo.widths.left).toBe(0);
  });

  it("puts a title on its line, over the cells Neovim gave it", () => {
    const frame = frameOf(rounded);
    const geo = frameGeometry(frame, place, cell, 2, 13);
    const label = frame.labels[0];
    if (!label) throw new Error("no label");
    expect(labelBox(label, place, geo, cell)).toEqual({
      x: (3 + 4) * 8,
      w: 5 * 8,
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
  ): FramedMember => ({
    grid,
    rect,
    geometry: frameGeometry(
      frameOf(gridOf(["╭──╮", "│ab│", "╰──╯"])),
      rect,
      cell,
      1,
      13,
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
    // Their lines were in the middle of columns 9 and 10: they meet at 80.
    expect(a ? a.x + a.w : 0).toBe(80);
    expect(b?.x).toBe(80);
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

  it("keeps a lone float's outline as its lines", () => {
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
    // Outside the rounded corner's arc, though inside its cell's inner half.
    expect(hitTest([base, box], cell, 3 * 8 + 4, 2 * 20 + 10).grid).toBe(1);
    expect(hitTest([base, box], cell, 3 * 8 + 6, 2 * 20 + 14).grid).toBe(4);
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

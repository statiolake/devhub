import { describe, expect, it } from "vitest";
import { initialUiState, type GridBox } from "./redraw";
import {
  NO_THEME,
  fillChosen,
  floatScrollbars,
  isEndOfBuffer,
  boundariesOf,
  paneRect,
  rowBleed,
  type Pane,
  windowGround,
  sameTheme,
  themeOf,
} from "./chrome";

const NORMAL = 0x1e1e1e;

describe("the surface notifications wear", () => {
  it("is the floats' colours, else Normal's, with the diagnostics'", () => {
    const theme = themeOf({
      groups: {
        Normal: { bg: NORMAL, fg: 0xd4d4d4 },
        NormalFloat: { bg: 0x252526 },
        DiagnosticWarn: { fg: 0xcca700 },
      },
    });
    expect(theme.surface).toEqual({
      bg: 0x252526,
      fg: 0xd4d4d4,
      ground: NORMAL,
      text: 0xd4d4d4,
      warn: 0xcca700,
    });
    expect(
      sameTheme(theme, themeOf({ groups: { Normal: { bg: NORMAL } } })),
    ).toBe(false);
  });
});

describe("windows side by side", () => {
  const box = (
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

  it("are panes with a boundary in the column between them", () => {
    // Window 2 left (rows 0–3), window 3 right (rows 0–1) over its status
    // line on row 2 and window 4 (row 3); the column is 5. Grid 1 is 10 by
    // 5: row 4 is the status lines'.
    const { lines, panes, gaps, vgaps } = boundariesOf(
      [box(2, 0, 0, 5, 4), box(3, 0, 6, 4, 2), box(4, 3, 6, 4, 1)],
      10,
      5,
    );
    // Each window's region is it and its status line: the line runs down
    // the column beside both, its status lines' row too.
    expect(lines).toEqual([{ vertical: true, x: 5, y: 0, length: 5 }]);
    expect([...gaps]).toEqual([5, 15, 25, 35, 45]);
    expect([...vgaps]).toEqual([...gaps]);
    expect(panes).toEqual([
      {
        grid: 2,
        win: 1002,
        left: false,
        right: true,
        top: false,
        bottom: false,
        status: true,
      },
      {
        grid: 3,
        win: 1003,
        left: true,
        right: false,
        top: false,
        bottom: false,
        status: true,
      },
      {
        grid: 4,
        win: 1004,
        left: true,
        right: false,
        top: false,
        bottom: false,
        status: true,
      },
    ]);
  });

  it("are worked out from where the windows are, whatever scrolls in them", () => {
    // A 4-way split: the column runs the whole height, beside the status
    // lines' rows as well (each status line is its window's).
    const { lines } = boundariesOf(
      [
        box(2, 0, 0, 4, 2),
        box(3, 3, 0, 4, 2),
        box(4, 0, 5, 5, 2),
        box(5, 3, 5, 5, 2),
      ],
      10,
      6,
    );
    expect(lines).toEqual([{ vertical: true, x: 4, y: 0, length: 6 }]);
  });

  it("meet at a separator row when they have no status line of their own", () => {
    // laststatus=3: windows 2 and 3 stacked on the left with a separator
    // row (row 2) between them, window 4 the whole height on the right;
    // the global status line is row 5. The row's line runs from the
    // column's middle (a T); each window reaches half into the row.
    const { lines, panes, gaps, vgaps } = boundariesOf(
      [box(2, 0, 0, 4, 2), box(3, 3, 0, 4, 2), box(4, 0, 5, 5, 5)],
      10,
      6,
      3,
    );
    expect(lines).toEqual([
      { vertical: true, x: 4, y: 0, length: 5 },
      { vertical: false, x: 0, y: 2, length: 4.5 },
    ]);
    expect(gaps.has(2 * 10 + 1)).toBe(true);
    expect(vgaps.has(2 * 10 + 1)).toBe(false);
    expect(vgaps.has(2 * 10 + 4)).toBe(true);
    expect(panes.map((p) => [p.grid, p.top, p.bottom, p.status])).toEqual([
      [2, false, true, false],
      [3, true, false, false],
      [4, false, false, false],
    ]);
  });

  it("cross where four windows meet", () => {
    const { lines } = boundariesOf(
      [
        box(2, 0, 0, 4, 2),
        box(3, 3, 0, 4, 2),
        box(4, 0, 5, 5, 2),
        box(5, 3, 5, 5, 2),
      ],
      10,
      6,
      3,
    );
    expect(lines).toEqual([
      { vertical: true, x: 4, y: 0, length: 5 },
      { vertical: false, x: 0, y: 2, length: 10 },
    ]);
  });

  it("are below a tab line and above the command line, which they leave alone", () => {
    // Grid 1 is 10 by 8: a tab line (row 0), windows on rows 1–4, their
    // status lines on row 5, the command line rows 6–7.
    const { lines, gaps } = boundariesOf(
      [box(2, 1, 0, 4, 4), box(3, 1, 5, 5, 4)],
      10,
      8,
    );
    expect(lines).toEqual([{ vertical: true, x: 4, y: 1, length: 5 }]);
    expect([...gaps].map((i) => Math.floor(i / 10))).toEqual([1, 2, 3, 4, 5]);
  });

  it("reach half into the gap beside them, and out to the editor's reach on its edges", () => {
    const boxes = [box(2, 0, 0, 4, 2), box(3, 3, 0, 4, 2), box(4, 0, 5, 5, 5)];
    const { panes } = boundariesOf(boxes, 10, 6, 3);
    const cell = { width: 7, height: 16.5 };
    const reach = { left: 3.5, right: 3.5, top: 8, bottom: 8 };
    const rect = (grid: number) =>
      paneRect(
        panes.find((p) => p.grid === grid) as Pane,
        boxes.find((b) => b.grid === grid) as GridBox,
        { width: 10, height: 6 },
        cell,
        2,
        reach,
      );
    // Window 2: from the editor's reach on the left to the column's middle
    // (4.5 cells, on a device pixel), from the reach above to the
    // separator row's middle.
    expect(rect(2)).toEqual({ left: -3.5, right: 31.5, top: -8, bottom: 41.5 });
    expect(rect(3)).toEqual({
      left: -3.5,
      right: 31.5,
      top: 41.5,
      bottom: 82.5,
    });
    // Window 4 ends above the global status line: its bottom is its cells'.
    expect(rect(4)).toEqual({ left: 31.5, right: 73.5, top: -8, bottom: 82.5 });
  });

  it("know whether a window's status line is its own (laststatus)", () => {
    const theme = themeOf({ groups: {}, laststatus: 3 });
    expect(theme.laststatus).toBe(3);
    expect(sameTheme(theme, themeOf({ groups: {}, laststatus: 2 }))).toBe(
      false,
    );
  });

  it("are each in its own ground: Normal, or NormalNC when not current", () => {
    const theme = themeOf({
      groups: {},
      grounds: { "1002": { normal: 1, nc: 2 }, "1003": { normal: 3 } },
    });
    expect(windowGround(theme, 1002, true)).toBe(1);
    expect(windowGround(theme, 1002, false)).toBe(2);
    expect(windowGround(theme, 1003, false)).toBe(3);
    expect(windowGround(theme, 1009, false)).toBeUndefined();
  });
});

describe("the end of the buffer", () => {
  it("is a ~ alone in EndOfBuffer's highlight", () => {
    const chars = [..."~    "];
    expect(isEndOfBuffer(chars, 0, 5, true)).toBe(true);
    // A line of text that starts with a tilde, in another highlight.
    expect(isEndOfBuffer(chars, 0, 5, false)).toBe(false);
    expect(isEndOfBuffer([..."~ x  "], 0, 5, true)).toBe(false);
  });

  it("is drawn when the person chose eob:, in the window or globally", () => {
    const theme = themeOf({
      groups: {},
      fillchars: "vert:│,stl:┴",
      wins: { "1001": "eob:~", "1002": "vert:│" },
    });
    expect(fillChosen(theme, 1000, "eob")).toBe(false);
    expect(fillChosen(theme, 1001, "eob")).toBe(true);
    expect(fillChosen(theme, 1002, "eob")).toBe(false);
    expect(
      fillChosen(themeOf({ groups: {}, fillchars: "eob: " }), 1000, "eob"),
    ).toBe(true);
  });
});

describe("a menu's scrollbar drawn as floats", () => {
  it("is the gutter under, the thumb over", () => {
    const state = initialUiState({ foreground: 0, background: 0, special: 0 });
    const float = (grid: number, height: number, text = " ") => {
      state.grids.set(grid, {
        id: grid,
        width: 1,
        height,
        chars: Array.from({ length: height }, () => text),
        hls: new Int32Array(height),
        dirty: new Set(),
      });
      state.windows.set(grid, {
        grid,
        hidden: false,
        placement: {
          kind: "float",
          win: 1000 + grid,
          anchor: "NW",
          anchorGrid: 1,
          anchorRow: 0,
          anchorCol: 15,
          focusable: false,
          zindex: 0,
        },
      });
    };
    float(2, 10);
    float(3, 2);
    float(4, 3, "x");
    const box = (grid: number, height: number, z: number): GridBox => ({
      grid,
      row: 4,
      col: 18,
      width: 1,
      height,
      z,
      float: true,
      win: 1000 + grid,
    });
    const menu: GridBox = {
      grid: 5,
      row: 4,
      col: 0,
      width: 18,
      height: 10,
      z: 1101,
      float: true,
      win: 1005,
    };
    const parts = floatScrollbars(state, [
      menu,
      box(2, 10, 1102),
      box(3, 2, 1103),
      box(4, 3, 1104),
    ]);
    expect([...parts]).toEqual([
      [2, "gutter"],
      [3, "thumb"],
    ]);
    // Not on a menu's edge: a one-column float of a plugin's own.
    expect([
      ...floatScrollbars(state, [
        { ...menu, col: 30 },
        box(2, 10, 1102),
        box(3, 2, 1103),
      ]),
    ]).toEqual([]);
  });
});

describe("the colorscheme's answer", () => {
  it("is nothing from an answer of another shape", () => {
    expect(themeOf(undefined)).toBe(NO_THEME);
    expect(themeOf([1, 2])).toBe(NO_THEME);
    expect(sameTheme(themeOf({ groups: {} }), NO_THEME)).toBe(true);
  });
});

describe("a row's grounds past its cells", () => {
  const cell = { width: 10, height: 20 };
  it("go on from its edge cells sideways", () => {
    expect(rowBleed(3, 4, 1, cell, { l: 5, r: 4, t: 0, b: 0 })).toEqual([
      { col: 0, x: -5, y: 20, w: 5, h: 20 },
      { col: 2, x: 30, y: 20, w: 4, h: 20 },
    ]);
  });

  it("go on up from the first row and down from the last, cell by cell", () => {
    expect(rowBleed(2, 1, 0, cell, { l: 5, r: 0, t: 8, b: 6 })).toEqual([
      { col: 0, x: -5, y: 0, w: 5, h: 20 },
      { col: 0, x: -5, y: -8, w: 5, h: 8 },
      { col: 0, x: 0, y: -8, w: 10, h: 8 },
      { col: 1, x: 10, y: -8, w: 10, h: 8 },
      { col: 0, x: -5, y: 20, w: 5, h: 6 },
      { col: 0, x: 0, y: 20, w: 10, h: 6 },
      { col: 1, x: 10, y: 20, w: 10, h: 6 },
    ]);
  });

  it("are nothing without a bleed", () => {
    expect(rowBleed(3, 4, 0, cell, { l: 0, r: 0, t: 0, b: 0 })).toEqual([]);
  });
});

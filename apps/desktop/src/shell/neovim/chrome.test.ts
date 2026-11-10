import { describe, expect, it } from "vitest";
import { initialUiState, type GridBox } from "./redraw";
import {
  NO_THEME,
  fillChosen,
  floatScrollbars,
  isEndOfBuffer,
  boundariesOf,
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
    const { boundaries, panes } = boundariesOf(
      [box(2, 0, 0, 5, 4), box(3, 0, 6, 4, 2), box(4, 3, 6, 4, 1)],
      10,
      5,
    );
    expect(boundaries).toEqual([{ col: 5, top: 0, bottom: 4 }]);
    expect(panes).toEqual([
      { grid: 2, win: 1002, left: false, right: true },
      { grid: 3, win: 1003, left: true, right: false },
      { grid: 4, win: 1004, left: true, right: false },
    ]);
  });

  it("are worked out from where the windows are, whatever scrolls in them", () => {
    // A 4-way split: the boundary runs beside each pair of windows; the
    // status lines' row crosses it (its junction is the status line's).
    const { boundaries } = boundariesOf(
      [
        box(2, 0, 0, 4, 2),
        box(3, 3, 0, 4, 2),
        box(4, 0, 5, 5, 2),
        box(5, 3, 5, 5, 2),
      ],
      10,
      6,
    );
    expect(boundaries).toEqual([
      { col: 4, top: 0, bottom: 2 },
      { col: 4, top: 3, bottom: 5 },
    ]);
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

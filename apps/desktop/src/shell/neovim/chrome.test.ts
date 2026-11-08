import { describe, expect, it } from "vitest";
import { initialUiState, type GridBox } from "./redraw";
import {
  NO_THEME,
  fillChosen,
  fillerStart,
  fillOf,
  foldFillStart,
  isLineFill,
  floatScrollbars,
  isEndOfBuffer,
  separatorsOf,
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

describe("a window separator", () => {
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

  it("takes each side's ground from the window there, else grid 1", () => {
    // Window 2 left (rows 0–3), window 3 right (rows 0–1) over its status
    // line on row 2 and window 4 (row 3); the column is 5.
    const LEFT = 0x111111;
    const RIGHT = 0x222222;
    const STATUS = 0x333333;
    const CURSORLINE = 0x444444;
    const bgOf = (grid: number, index: number) =>
      grid === 1
        ? STATUS
        : grid === 2
          ? index === 4
            ? CURSORLINE
            : LEFT
          : RIGHT;
    const seps = separatorsOf(
      [box(2, 0, 0, 5, 4), box(3, 0, 6, 4, 2), box(4, 3, 6, 4, 1)],
      10,
      5,
      bgOf,
    );
    expect(seps).toEqual([
      { row: 0, col: 5, left: LEFT, right: RIGHT },
      { row: 1, col: 5, left: LEFT, right: RIGHT },
      { row: 2, col: 5, left: LEFT, right: STATUS },
      { row: 3, col: 5, left: LEFT, right: RIGHT },
    ]);
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

describe("a diff's filler row", () => {
  it("is the dashes in DiffDelete's highlight from the text column on", () => {
    const chars = [..."    ----------"];
    expect(fillerStart(chars, 0, 14, (col) => col >= 4)).toBe(4);
    // Not a filler: dashes in the text's own highlight.
    expect(fillerStart(chars, 0, 14, () => false)).toBeUndefined();
  });

  it("is left alone when the person chose diff:", () => {
    expect(
      fillChosen(themeOf({ groups: {}, fillchars: "diff:╱" }), 1000, "diff"),
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

describe("a closed fold's fill", () => {
  it("is the run of the fill character in Folded to the row's end", () => {
    const chars = [..."+-- 4 lines: x ─────"];
    const folded = () => true;
    expect(foldFillStart(chars, 0, chars.length, "─", folded)).toBe(15);
    expect(
      foldFillStart(chars, 0, chars.length, "─", (c) => c < 18),
    ).toBeUndefined();
    expect(foldFillStart(chars, 0, chars.length, "·", folded)).toBeUndefined();
  });

  it("is a line only when its character draws one", () => {
    expect(isLineFill("─")).toBe(true);
    expect(isLineFill("-")).toBe(true);
    expect(isLineFill("·")).toBe(false);
    expect(isLineFill(" ")).toBe(false);
    expect(isLineFill(undefined)).toBe(false);
  });

  it("is read from the window's fillchars, else the global one", () => {
    const theme = {
      ...NO_THEME,
      fillchars: "vert:│,fold:─",
      winFillchars: new Map([[1001, "fold:·"]]),
    };
    expect(fillOf(theme, 1000, "fold")).toBe("─");
    expect(fillOf(theme, 1001, "fold")).toBe("·");
    expect(fillOf(theme, 1000, "diff")).toBeUndefined();
  });
});

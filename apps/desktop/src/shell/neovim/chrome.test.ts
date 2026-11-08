import { describe, expect, it } from "vitest";
import { initialUiState, type GridBox } from "./redraw";
import {
  NO_THEME,
  barLayout,
  barsOf,
  fillerStart,
  floatScrollbars,
  isEndOfBuffer,
  separatorsOf,
  sameTheme,
  shapedSpans,
  spanCorners,
  spanNotches,
  themeOf,
} from "./chrome";

const VISUAL = 0x264f78;
const SEARCH = 0x613214;
const NORMAL = 0x1e1e1e;

describe("the colorscheme's shaped colours", () => {
  it("are Visual's and the searches' backgrounds", () => {
    const theme = themeOf({
      groups: {
        Visual: { bg: VISUAL },
        Search: { bg: SEARCH, fg: 0xffffff },
        IncSearch: { reverse: true, fg: SEARCH },
        CurSearch: [],
      },
    });
    expect([...theme.shaped].sort()).toEqual([VISUAL, SEARCH].sort());
  });

  it("are none from an answer of another shape", () => {
    expect(themeOf(undefined)).toBe(NO_THEME);
    expect(themeOf([1, 2])).toBe(NO_THEME);
    expect(sameTheme(themeOf({ groups: {} }), NO_THEME)).toBe(true);
  });
});

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
      warn: 0xcca700,
    });
    expect(
      sameTheme(theme, themeOf({ groups: { Normal: { bg: NORMAL } } })),
    ).toBe(false);
  });
});

describe("shaped spans", () => {
  it("are runs of one shaped colour", () => {
    const row = [NORMAL, VISUAL, VISUAL, SEARCH, NORMAL, VISUAL];
    expect(shapedSpans(row, new Set([VISUAL, SEARCH]))).toEqual([
      { start: 1, end: 3, bg: VISUAL },
      { start: 3, end: 4, bg: SEARCH },
      { start: 5, end: 6, bg: VISUAL },
    ]);
  });

  it("round only the outline of a selection of several lines", () => {
    // ··XXXX
    // XXXXXX
    // XXX···
    const top = { start: 2, end: 6 };
    const middle = { start: 0, end: 6 };
    const bottom = { start: 0, end: 3 };
    expect(spanCorners(top, [], [middle])).toEqual({
      tl: true,
      tr: true,
      br: false,
      bl: false,
    });
    expect(spanCorners(middle, [top], [bottom])).toEqual({
      tl: true,
      tr: false,
      br: true,
      bl: false,
    });
    expect(spanCorners(bottom, [middle], [])).toEqual({
      tl: false,
      tr: false,
      br: true,
      bl: true,
    });
  });

  it("fill the inside corners where a neighbour runs on", () => {
    const top = { start: 2, end: 6 };
    const middle = { start: 0, end: 6 };
    const bottom = { start: 0, end: 3 };
    // The top line's left end sits on the middle one, which runs on left.
    expect(spanNotches(top, [], [middle])).toEqual({
      tl: false,
      tr: false,
      br: false,
      bl: true,
    });
    // The bottom line ends where the middle one runs on right.
    expect(spanNotches(bottom, [middle], [])).toEqual({
      tl: false,
      tr: true,
      br: false,
      bl: false,
    });
    expect(spanNotches(middle, [top], [bottom])).toEqual({
      tl: false,
      tr: false,
      br: false,
      bl: false,
    });
  });
});

describe("a status line as a bar", () => {
  const BAR = 0x303030;
  const MODE = 0x569cd6;
  const BRANCH = 0x444444;

  it("is its commonest colour, with the other runs as pills", () => {
    // " NORMAL  main  file.ts " — lualine's sections, Powerline joints.
    const chars = [..." NORMAL \ue0b0 main \ue0b0 file.ts        "];
    const bgs = chars.map((_, col) =>
      col < 8 ? MODE : col === 8 ? BRANCH : col < 15 ? BRANCH : BAR,
    );
    const bar = barLayout(chars, bgs, { start: 0, end: chars.length });
    expect(bar.ground).toBe(BAR);
    expect(bar.joints).toEqual([8, 15]);
    expect(bar.pills).toEqual([
      { start: 0, end: 8, bg: MODE, roundLeft: true, roundRight: true },
      { start: 9, end: 15, bg: BRANCH, roundLeft: true, roundRight: true },
    ]);
  });

  it("rounds touching runs of other colours as one pill", () => {
    const chars = [..." A  B     "];
    const bgs = [MODE, MODE, MODE, BRANCH, BRANCH, BAR, BAR, BAR, BAR, BAR];
    expect(barLayout(chars, bgs, { start: 0, end: 10 }).pills).toEqual([
      { start: 0, end: 3, bg: MODE, roundLeft: true, roundRight: false },
      { start: 3, end: 5, bg: BRANCH, roundLeft: false, roundRight: true },
    ]);
  });

  it("is under each window, but not on the command line's rows", () => {
    const state = initialUiState({
      foreground: 0,
      background: 0,
      special: 0,
    });
    state.grids.set(1, {
      id: 1,
      width: 20,
      height: 10,
      chars: [],
      hls: new Int32Array(200),
      dirty: new Set(),
    });
    state.margins.set(3, { top: 1, right: 0, bottom: 0, left: 0 });
    const win = (grid: number, row: number, height: number): GridBox => ({
      grid,
      row,
      col: 0,
      width: 20,
      height,
      z: 1,
      float: false,
      win: 1000 + grid,
    });
    // Two windows stacked, the lower one's status line on row 8; with
    // `laststatus=0` the row under it would be the command line's.
    const bars = barsOf(state, [win(2, 0, 4), win(3, 5, 3)], 1);
    expect([...(bars.get(1)?.keys() ?? [])]).toEqual([4, 8]);
    expect([...(bars.get(3)?.keys() ?? [])]).toEqual([0]);
    const none = barsOf(state, [win(2, 0, 4), win(3, 5, 4)], 1);
    expect([...(none.get(1)?.keys() ?? [])]).toEqual([4]);
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
  const EOB = 0x3b3b3b;

  it("is not drawn while fillchars leaves eob: alone", () => {
    const theme = themeOf({
      groups: { EndOfBuffer: { fg: EOB } },
      fillchars: "vert:│,stl:┴",
    });
    expect(theme.eob).toBe(EOB);
    const chars = [..."~    "];
    expect(isEndOfBuffer(chars, 0, 5, EOB, theme.eob)).toBe(true);
    // A line of text that starts with a tilde, in another colour.
    expect(isEndOfBuffer(chars, 0, 5, 0xffffff, theme.eob)).toBe(false);
    expect(isEndOfBuffer([..."~ x  "], 0, 5, EOB, theme.eob)).toBe(false);
  });

  it("is drawn when the person chose eob:", () => {
    const theme = themeOf({
      groups: { EndOfBuffer: { fg: EOB } },
      fillchars: "eob:~",
    });
    expect(theme.eob).toBeUndefined();
  });
});

describe("text Neovim adds to a line", () => {
  it("is a pill when its colorscheme gives it a ground", () => {
    const theme = themeOf({
      groups: {
        Visual: { bg: VISUAL },
        DiagnosticVirtualTextError: { fg: 0xdb4b4b, bg: 0x362c3d },
        DiagnosticVirtualTextWarn: { fg: 0xe0af68 },
        LspInlayHint: { bg: VISUAL },
      },
    });
    // A pill colour that is also a selection's stays a selection.
    expect([...theme.pills]).toEqual([0x362c3d]);
  });
});

describe("a diff's filler row", () => {
  const DELETE = 0x562f2d;
  const theme = themeOf({ groups: { DiffDelete: { bg: DELETE } } });
  const colors = (bgs: readonly number[]) => (col: number) => ({
    fg: 0xffffff,
    bg: bgs[col] ?? 0,
  });

  it("is the dashes in DiffDelete's ground from the text column on", () => {
    const chars = [..."    ----------"];
    const bgs = chars.map((_, col) => (col < 4 ? NORMAL : DELETE));
    expect(fillerStart(chars, 0, 14, colors(bgs), theme.diffDelete)).toBe(4);
    // Not a filler: dashes in the text's own colours.
    expect(
      fillerStart(
        chars,
        0,
        14,
        colors(chars.map(() => NORMAL)),
        theme.diffDelete,
      ),
    ).toBeUndefined();
  });

  it("is left alone when the person chose diff:", () => {
    expect(
      themeOf({ groups: { DiffDelete: { bg: DELETE } }, fillchars: "diff:╱" })
        .diffDelete,
    ).toBeUndefined();
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
    const parts = floatScrollbars(state, [
      box(2, 10, 1102),
      box(3, 2, 1103),
      box(4, 3, 1104),
    ]);
    expect([...parts]).toEqual([
      [2, "gutter"],
      [3, "thumb"],
    ]);
  });
});

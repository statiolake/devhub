import { describe, expect, it } from "vitest";
import {
  NO_THEME,
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

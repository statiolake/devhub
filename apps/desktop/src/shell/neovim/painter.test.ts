import { describe, expect, it } from "vitest";
import {
  PART_Z,
  floatLook,
  gridBlends,
  iconBox,
  mixColors,
  parseGuifont,
  signPadded,
} from "./painter";
import { NO_THEME } from "./chrome";
import { initialUiState } from "./redraw";

describe("guifont", () => {
  it("is a CSS family list and a size", () => {
    expect(
      parseGuifont("Menlo,SauceCodePro Nerd Font Mono,Hiragino Sans W3:h12"),
    ).toEqual({
      family: 'Menlo, "SauceCodePro Nerd Font Mono", "Hiragino Sans"',
      size: 12,
    });
  });

  it("reads underscores as spaces and leaves an empty value alone", () => {
    expect(parseGuifont("Fira_Code:h13.5")).toEqual({
      family: '"Fira Code"',
      size: 13.5,
    });
    expect(parseGuifont("")).toBeUndefined();
  });
});

describe("winblend", () => {
  it("mixes a colour into what is under it", () => {
    expect(mixColors(0xffffff, 0x000000, 0)).toBe(0xffffff);
    expect(mixColors(0xffffff, 0x000000, 100)).toBe(0x000000);
    expect(mixColors(0xff0000, 0x0000ff, 50)).toBe(0x800080);
  });
});

describe("a leaf canvas's alpha", () => {
  const hl = new Map([
    [1, { background: 0xffffff }],
    [2, { background: 0x000000, blend: 30 }],
    [3, { background: 0x000000, blend: 0 }],
  ]);

  it("is opaque for a float, a popup or a pane that blends nowhere", () => {
    expect(gridBlends({ hls: Int32Array.from([0, 1, 1, 3]) }, hl)).toBe(false);
  });

  it("has alpha only while a cell blends (`winblend`)", () => {
    expect(gridBlends({ hls: Int32Array.from([1, 1, 2, 1]) }, hl)).toBe(true);
  });
});

describe("a level's parts", () => {
  it("stack by declared order, the page's riders, cursor and covers among them", () => {
    const order = Object.entries(PART_Z)
      .sort(([, a], [, b]) => a - b)
      .map(([part]) => part);
    expect(order).toEqual([
      "pane",
      "shadow",
      "frames",
      "grid",
      "riders",
      "over",
      "cursor",
      "covers",
      "footer",
      "labels",
      "boundary",
      "screen",
    ]);
  });

  it("are never ordered by their place in the page", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      new URL("./painter.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/\.prepend\(|lastElementChild/);
  });
});

describe("what the page lays over a grid", () => {
  it("is in the grid's own clip, never cut or hidden by hand", async () => {
    const { readFile } = await import("node:fs/promises");
    const read = (name: string) =>
      readFile(new URL(name, import.meta.url), "utf8");
    // The cursor is not hidden when its row leaves the text area, and no
    // rider is cut by a clip-path of its own: their clip cuts them.
    expect(await read("./editor.ts")).not.toMatch(/cursor\.style\.visibility/);
    expect(await read("./riders.ts")).not.toMatch(/cutTop|cutBottom/);
    for (const name of [
      "./LayerViews.tsx",
      "./DecorationViews.tsx",
      "./NeovimApp.tsx",
    ])
      expect(await read(name)).not.toMatch(/zIndex: box\.z/);
  });
});

describe("a float's look, from the theme's groups", () => {
  const defaults = { foreground: 0x202020, background: 0xffffff };
  const theme = (surface: object) => ({ ...NO_THEME, surface });

  it("takes FloatBorder's ink for its line and StatusLine's ground for a title's band", () => {
    expect(
      floatLook(
        theme({
          bg: 0xf2f2f6,
          fg: 0x202020,
          border: 0xd8d8d8,
          status: 0xfafafd,
        }),
        defaults,
      ),
    ).toEqual({
      ground: 0xf2f2f6,
      ink: 0x202020,
      line: 0xd8d8d8,
      band: 0xfafafd,
    });
  });

  it("derives a line where FloatBorder is only the float's ink (linked to NormalFloat)", () => {
    const look = floatLook(
      theme({ bg: 0xf2f2f6, fg: 0x202020, border: 0x202020, ground: 0xffffff }),
      defaults,
    );
    expect(look.line).toBe(mixColors(0xf2f2f6, 0x202020, 18));
    // No StatusLine: half way from the editor's ground to the float's.
    expect(look.band).toBe(mixColors(0xffffff, 0xf2f2f6, 50));
  });
});

describe("a sign's two cells", () => {
  // The fold column, a sign padded with its blank, the second (empty) sign
  // slot, a line number: as ext_hlstate names them (a real Neovim's).
  const state = initialUiState();
  state.hl.set(1, { groups: ["FoldColumn", "SignColumn"] });
  state.hl.set(2, { groups: ["SignColumn", "DiagnosticError"] });
  state.hl.set(3, { groups: ["SignColumn"] });
  state.hl.set(4, { groups: ["LineNr"] });
  const chars = [" ", "\u{f057}", " ", " ", " ", "1", "a"];
  const hls = [1, 2, 2, 3, 3, 4, 0];

  it("are the sign column's, its text and the blank after it", () => {
    expect(signPadded(state, chars, hls, 0, 1, chars.length)).toBe(true);
  });

  it("are not the fold column's, a line number's or the text's", () => {
    expect(signPadded(state, chars, hls, 0, 0, chars.length)).toBe(false);
    expect(signPadded(state, chars, hls, 0, 5, chars.length)).toBe(false);
    expect(signPadded(state, ["x", " "], [0, 0], 0, 0, 2)).toBe(false);
  });

  it("are the cursor line's too", () => {
    state.hl.set(5, { groups: ["CursorLineSign", "DiagnosticWarn"] });
    expect(signPadded(state, ["W", " "], [5, 5], 0, 0, 2)).toBe(true);
  });
});

describe("an icon's design box", () => {
  const m = (width: number) => ({
    width,
    actualBoundingBoxLeft: -2,
    actualBoundingBoxRight: 6,
    actualBoundingBoxAscent: 5,
    actualBoundingBoxDescent: 1,
  });

  it("is the em square for Symbols Nerd Font Mono (advance one em)", () => {
    const box = iconBox(m(12), 12);
    expect([box.left, box.right]).toEqual([0, 12]);
    expect(box.ascent).toBeCloseTo(9.6);
    expect(box.descent).toBeCloseTo(2.4);
  });

  it("is the ink for another font's glyph", () => {
    expect(iconBox(m(7), 12)).toEqual({
      left: -2,
      right: 6,
      ascent: 5,
      descent: 1,
    });
  });
});

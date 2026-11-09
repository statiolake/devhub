import { describe, expect, it } from "vitest";
import {
  ABOVE_GRID,
  PART_Z,
  gridBlends,
  isOwnGround,
  mixColors,
  parseGuifont,
} from "./painter";

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

describe("a window's own ground", () => {
  it("is Normal's, NormalNC's or a column's, never what lies over the text", () => {
    expect(isOwnGround(undefined)).toBe(true);
    expect(isOwnGround({ groups: ["Comment"] })).toBe(true);
    expect(isOwnGround({ background: 1, groups: ["NormalNC"] })).toBe(true);
    expect(isOwnGround({ background: 1, groups: ["SignColumn"] })).toBe(true);
    expect(isOwnGround({ background: 1, groups: ["DiffText"] })).toBe(false);
    expect(
      isOwnGround({ background: 1, groups: ["CursorLine", "NormalNC"] }),
    ).toBe(false);
    expect(isOwnGround({ background: 1, groups: ["Visual"] })).toBe(false);
    expect(isOwnGround({ reverse: true })).toBe(false);
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
  it("stack by declared order: shadow, frames, grid, over, labels", () => {
    const order = Object.entries(PART_Z)
      .sort(([, a], [, b]) => a - b)
      .map(([part]) => part);
    expect(order).toEqual(["shadow", "frames", "grid", "over", "labels"]);
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
  it("is riders, then the cursor, then what covers the grid's cells", () => {
    expect(ABOVE_GRID.riders).toBeLessThan(ABOVE_GRID.cursor);
    expect(ABOVE_GRID.cursor).toBeLessThan(ABOVE_GRID.covers);
  });

  it("stays under the next float's zindex band only by its own z", () => {
    // Windows are at 1, floats at 100 + zindex: a window's overlays never
    // reach a float.
    expect(1 + ABOVE_GRID.covers).toBeLessThan(100);
  });
});

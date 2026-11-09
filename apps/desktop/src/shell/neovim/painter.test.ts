import { describe, expect, it } from "vitest";
import {
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
  it("stack by declared order, the page's riders, cursor and covers among them", () => {
    const order = Object.entries(PART_Z)
      .sort(([, a], [, b]) => a - b)
      .map(([part]) => part);
    expect(order).toEqual([
      "shadow",
      "frames",
      "grid",
      "riders",
      "over",
      "cursor",
      "covers",
      "labels",
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

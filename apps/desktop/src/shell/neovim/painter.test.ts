import { describe, expect, it } from "vitest";
import { isBoxChar, mixColors, parseGuifont } from "./painter";

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

describe("box-drawing characters", () => {
  it("are the separators and borders Neovim draws", () => {
    for (const c of ["│", "─", "╭", "╯", "┴", "┼"])
      expect(isBoxChar(c)).toBe(true);
    expect(isBoxChar("a")).toBe(false);
    expect(isBoxChar("|")).toBe(false);
  });
});

describe("winblend", () => {
  it("mixes a colour into what is under it", () => {
    expect(mixColors(0xffffff, 0x000000, 0)).toBe(0xffffff);
    expect(mixColors(0xffffff, 0x000000, 100)).toBe(0x000000);
    expect(mixColors(0xff0000, 0x0000ff, 50)).toBe(0x800080);
  });
});

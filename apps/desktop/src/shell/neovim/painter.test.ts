import { describe, expect, it } from "vitest";
import { isBoxChar, parseGuifont } from "./painter";

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

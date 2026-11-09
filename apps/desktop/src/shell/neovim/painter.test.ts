import { describe, expect, it } from "vitest";
import { isOwnGround, mixColors, parseGuifont } from "./painter";

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

import { describe, expect, it } from "vitest";
import {
  contrast,
  hexOfOklch,
  mix,
  normalizeHex,
  oklchOf,
  withContrast,
} from "./color.js";
import {
  builtinThemes,
  completeTheme,
  formatThemeSelection,
  parseThemeSelection,
  shellPaletteOfTheme,
  ThemeCatalog,
  themeKindOf,
} from "./theme.js";

const HEX = /^#[0-9a-f]{6}$/;

describe("the built-in themes", () => {
  it("are DevHub's two and the collection, each a whole palette", () => {
    const themes = builtinThemes();
    expect(themes[0]?.name).toBe("DevHub Dark");
    expect(themes[1]?.name).toBe("DevHub Light");
    expect(themes.length).toBeGreaterThan(250);
    expect(new Set(themes.map((theme) => theme.name)).size).toBe(themes.length);
    for (const theme of themes) {
      expect(theme.palette).toHaveLength(16);
      for (const color of [
        theme.background,
        theme.foreground,
        theme.cursor,
        theme.cursorText,
        theme.selectionBackground,
        ...theme.palette,
      ]) {
        expect(color).toMatch(HEX);
      }
    }
  });

  it("include the well-known ones", () => {
    const catalog = new ThemeCatalog();
    for (const name of [
      "Catppuccin Mocha",
      "Catppuccin Latte",
      "TokyoNight",
      "Gruvbox Dark",
      "Nord",
      "Rose Pine",
      "Kanagawa Wave",
      "GitHub Light Default",
    ]) {
      expect(catalog.find(name)?.name).toBe(name);
    }
    expect(themeKindOf(catalog.find("Catppuccin Latte")!)).toBe("light");
    expect(themeKindOf(catalog.find("Catppuccin Mocha")!)).toBe("dark");
  });
});

describe("[appearance] theme", () => {
  it("is one name, or a light/dark pair in either order", () => {
    expect(parseThemeSelection(" Nord ")).toEqual({
      light: "Nord",
      dark: "Nord",
    });
    expect(parseThemeSelection("dark:A B,light: C")).toEqual({
      light: "C",
      dark: "A B",
    });
    expect(
      parseThemeSelection("light:Analog Heartbeat: Phosphor,dark:X"),
    ).toEqual({ light: "Analog Heartbeat: Phosphor", dark: "X" });
    for (const bad of [
      "",
      "light:A",
      "light:A,light:B",
      "light:,dark:B",
      "light:A,night:B",
    ]) {
      expect(parseThemeSelection(bad)).toHaveProperty("problem");
    }
    expect(formatThemeSelection({ light: "A", dark: "A" })).toBe("A");
    expect(formatThemeSelection({ light: "A", dark: "B" })).toBe(
      "light:A,dark:B",
    );
  });
});

describe("a custom theme", () => {
  it("fills what it leaves out the way a terminal would", () => {
    const theme = completeTheme({
      name: "Mine",
      background: "#000",
      foreground: "#FFF",
      palette: Array.from({ length: 16 }, () => "#123456"),
    });
    expect(theme.cursor).toBe("#ffffff");
    expect(theme.cursorText).toBe("#000000");
    expect(theme.selectionBackground).toMatch(HEX);
    expect(theme.selectionForeground).toBeUndefined();
  });
});

describe("the shell's palette", () => {
  it("reads the accent at 4.5:1 on the ground, for every built-in theme", () => {
    for (const theme of builtinThemes()) {
      const palette = shellPaletteOfTheme(theme);
      expect(palette.surface).toBe(theme.background);
      expect(contrast(palette.accent, palette.surface)).toBeGreaterThan(4.4);
      expect(palette.chrome).not.toBe(palette.surface);
    }
  });
});

describe("the colour arithmetic", () => {
  it("goes to OKLCH and back", () => {
    for (const hex of ["#000000", "#ffffff", "#1e66f5", "#ebcb8b", "#7f7f7f"]) {
      expect(hexOfOklch(oklchOf(hex))).toBe(hex);
    }
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
  });

  it("mixes in OKLab and reaches a contrast by lightness alone", () => {
    expect(mix("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mix("#000000", "#ffffff", 1)).toBe("#ffffff");
    const lifted = withContrast("#202060", "#101010", 4.5);
    expect(contrast(lifted, "#101010")).toBeGreaterThanOrEqual(4.5);
    expect(Math.abs(oklchOf(lifted).h - oklchOf("#202060").h)).toBeLessThan(6);
    expect(withContrast("#ffffff", "#000000", 4.5)).toBe("#ffffff");
  });
});

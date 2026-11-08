import { describe, expect, it } from "vitest";
import { ThemeCatalog, terminalPaletteOfTheme } from "./themes/theme.js";
import {
  fzfColorsOf,
  opaqueHex,
  publishedThemeOf,
  themeColorsString,
  themeEnvironment,
  themeFilePath,
  themeFileText,
} from "./publishedTheme.js";

function builtin(name: string) {
  const theme = new ThemeCatalog().find(name);
  if (!theme) throw new Error(`no ${name}`);
  return theme;
}

function nord(temporary = false) {
  const theme = builtin("Nord");
  return publishedThemeOf({
    theme,
    terminal: terminalPaletteOfTheme(theme),
    temporary,
  });
}

describe("the published theme", () => {
  it("names the theme and its kind, and every colour as #rrggbb", () => {
    const theme = nord();
    expect(theme).toMatchObject({
      version: 1,
      name: "Nord",
      kind: "dark",
      background: "dark",
      temporary: false,
    });
    expect(theme.colors.background).toBe("#2e3440");
    expect(theme.colors.ansi).toHaveLength(16);
    expect(theme.colors.ansi[4]).toBe("#81a1c1");
    for (const color of theme.colors.ansi) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("says a light theme is light, and whether it is only worn for now", () => {
    const latte = builtin("Catppuccin Latte");
    const theme = publishedThemeOf({
      theme: latte,
      terminal: terminalPaletteOfTheme(latte),
      temporary: true,
    });
    expect(theme.kind).toBe("light");
    expect(theme.background).toBe("light");
    expect(theme.temporary).toBe(true);
  });

  it("spells the colours for a shell and for fzf", () => {
    const { colors } = nord();
    const pairs = themeColorsString(colors).split(" ");
    expect(pairs[0]).toBe("bg=#2e3440");
    expect(pairs).toContain("color15=#eceff4");
    expect(pairs.filter((pair) => pair.startsWith("color"))).toHaveLength(16);
    const fzf = fzfColorsOf(colors);
    expect(fzf).toContain("bg:#2e3440");
    expect(fzf).toContain("hl:#81a1c1");
    expect(fzf).not.toMatch(/\s/);
  });

  it("is the environment a pane gets, with the file only where it is", () => {
    const theme = nord();
    const here = themeEnvironment(
      theme,
      "/home/me/.local/state/devhub/theme.json",
    );
    expect(here).toMatchObject({
      DEVHUB_THEME: "Nord",
      DEVHUB_THEME_KIND: "dark",
      DEVHUB_THEME_BACKGROUND: "dark",
      DEVHUB_FZF_COLORS: theme.fzf,
      DEVHUB_THEME_FILE: "/home/me/.local/state/devhub/theme.json",
    });
    expect(themeEnvironment(theme, undefined)).not.toHaveProperty(
      "DEVHUB_THEME_FILE",
    );
    expect(JSON.parse(themeFileText(theme))).toEqual(theme);
  });

  it("is written where XDG says state goes, one directory per profile", () => {
    const profile = { isDefault: true, profile: "default" };
    expect(themeFilePath(profile, "/home/me", {})).toBe(
      "/home/me/.local/state/devhub/theme.json",
    );
    expect(
      themeFilePath(profile, "/home/me", { XDG_STATE_HOME: "/state" }),
    ).toBe("/state/devhub/theme.json");
    expect(
      themeFilePath({ isDefault: false, profile: "dev" }, "/home/me", {
        XDG_STATE_HOME: "relative",
      }),
    ).toBe("/home/me/.local/state/devhub-dev/theme.json");
  });

  it("makes CSS colours opaque", () => {
    expect(opaqueHex("#abc")).toBe("#aabbcc");
    expect(opaqueHex("rgba(255, 255, 255, 0.5)", "#000000")).toBe("#808080");
    expect(opaqueHex("not a colour")).toBeUndefined();
  });
});

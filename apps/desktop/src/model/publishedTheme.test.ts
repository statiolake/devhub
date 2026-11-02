import { describe, expect, it } from "vitest";
import { ResolvedColorTheme, terminalPaletteOfTheme } from "./colorTheme.js";
import {
  fzfColorsOf,
  opaqueHex,
  publishedThemeOf,
  themeColorsString,
  themeEnvironment,
  themeFilePath,
  themeFileText,
  tokenStyleOf,
} from "./publishedTheme.js";

const NORD = new ResolvedColorTheme({
  settingsId: "Nord",
  label: "Nord",
  type: "dark",
  colors: {
    "editor.background": "#2e3440",
    "editor.foreground": "#d8dee9",
    "terminal.background": "#2e3440",
    "terminal.foreground": "#d8dee9",
    "terminal.selectionBackground": "#434c5ecc",
    "terminal.ansiBlack": "#3b4252",
    "terminal.ansiRed": "#bf616a",
    "terminal.ansiGreen": "#a3be8c",
    "terminal.ansiYellow": "#ebcb8b",
    "terminal.ansiBlue": "#81a1c1",
    "terminal.ansiMagenta": "#b48ead",
    "terminal.ansiCyan": "#88c0d0",
    "terminal.ansiWhite": "#e5e9f0",
    "terminal.ansiBrightBlack": "#4c566a",
    "terminal.ansiBrightRed": "#bf616a",
    "terminal.ansiBrightGreen": "#a3be8c",
    "terminal.ansiBrightYellow": "#ebcb8b",
    "terminal.ansiBrightBlue": "#81a1c1",
    "terminal.ansiBrightMagenta": "#b48ead",
    "terminal.ansiBrightCyan": "#8fbcbb",
    "terminal.ansiBrightWhite": "#eceff4",
  },
  tokenColors: [
    { scopes: [], foreground: "#d8dee9" },
    { scopes: ["comment"], foreground: "#616e88", fontStyle: "italic" },
    { scopes: ["keyword"], foreground: "#81a1c1" },
    { scopes: ["keyword.control"], fontStyle: "bold" },
    { scopes: ["source.js keyword"], foreground: "#ff0000" },
    { scopes: ["string", "string.quoted"], foreground: "#a3be8c" },
  ],
});

function nord(temporary = false) {
  return publishedThemeOf({
    theme: NORD,
    terminal: terminalPaletteOfTheme(NORD),
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
    // #434c5e at 0.8 over #2e3440.
    expect(theme.colors.selectionBackground).toBe("#3f4758");
    for (const color of [
      ...theme.colors.ansi,
      ...Object.values(theme.editor),
    ]) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(theme.editor["editor.background"]).toBe("#2e3440");
    // From the registry's defaults where the theme says nothing.
    expect(theme.editor["editorError.foreground"]).toMatch(/^#/);
  });

  it("says high contrast as hc, with the background it is on", () => {
    const theme = publishedThemeOf({
      theme: new ResolvedColorTheme({
        settingsId: "HC Light",
        label: "HC Light",
        type: "hcLight",
        colors: {},
      }),
      terminal: terminalPaletteOfTheme(
        new ResolvedColorTheme({
          settingsId: "HC Light",
          label: "HC Light",
          type: "hcLight",
          colors: {},
        }),
      ),
      temporary: true,
    });
    expect(theme.kind).toBe("hc");
    expect(theme.background).toBe("light");
    expect(theme.temporary).toBe(true);
  });

  it("takes each syntax style from the most specific rule, and no descendant selectors", () => {
    const rules = NORD.definition.tokenColors ?? [];
    expect(tokenStyleOf(rules, "keyword.control")).toEqual({
      fg: "#81a1c1",
      bold: true,
    });
    expect(tokenStyleOf(rules, "comment.line.double-slash")).toEqual({
      fg: "#616e88",
      italic: true,
    });
    expect(tokenStyleOf(rules, "constant.numeric")).toBeUndefined();
    expect(nord().tokens["string"]).toEqual({ fg: "#a3be8c" });
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

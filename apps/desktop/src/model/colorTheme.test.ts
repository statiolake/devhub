import { describe, expect, it } from "vitest";
import {
  ResolvedColorTheme,
  shellPaletteOfTheme,
  terminalPaletteOfTheme,
  ThemeColor,
  themeTypeOfUiTheme,
  type ColorDefaultsTable,
  type ColorThemeDefinition,
  type ColorThemeType,
} from "./colorTheme.js";
import { COLOR_DEFAULTS } from "./colorDefaults.generated.js";
import { isPaletteColor } from "../ipc/palette.js";
import { terminalPaletteIsValid } from "./wire.js";

function theme(
  type: ColorThemeType,
  colors: Record<string, string> = {},
): ColorThemeDefinition {
  return { settingsId: "Test", label: "Test", type, colors };
}

describe("a colour, as VS Code's Color does it", () => {
  it("parses every hex form, and an unparsable one is red", () => {
    expect(ThemeColor.fromHex("#1f1f1f").toString()).toBe("#1f1f1f");
    expect(ThemeColor.fromHex("#abc").toString()).toBe("#aabbcc");
    expect(ThemeColor.fromHex("#00000080").toString()).toBe(
      "rgba(0, 0, 0, 0.5)",
    );
    expect(ThemeColor.fromHex("#fff8").toString()).toBe(
      "rgba(255, 255, 255, 0.53)",
    );
    expect(ThemeColor.fromHex("blue").toString()).toBe("#ff0000");
  });

  it("transforms the way the registry's transforms do", () => {
    const grey = ThemeColor.fromHex("#808080");
    expect(grey.transparent(0.5).toString()).toBe("rgba(128, 128, 128, 0.5)");
    expect(grey.darken(0.5).toString()).toBe("#404040");
    expect(grey.lighten(0.5).toString()).toBe("#c0c0c0");
    expect(
      ThemeColor.fromHex("#ffffff80")
        .makeOpaque(ThemeColor.fromHex("#000000"))
        .toString(),
    ).toBe("#808080");
    expect(
      ThemeColor.fromHex("#000000")
        .mix(ThemeColor.fromHex("#ffffff"))
        .toString(),
    ).toBe("#7f7f7f");
  });
});

describe("a theme's colours", () => {
  it("are the theme's own where it sets them", () => {
    const resolved = new ResolvedColorTheme(
      theme("dark", { "editor.background": "#123456" }),
    );
    expect(resolved.css("editor.background")).toBe("#123456");
    expect(resolved.defines("editor.background")).toBe(true);
  });

  it("are the registry's default for the theme's type where it does not", () => {
    for (const type of ["light", "dark", "hcDark", "hcLight"] as const) {
      const resolved = new ResolvedColorTheme(theme(type));
      expect(resolved.css("terminal.ansiRed")).toBe(
        ThemeColor.fromHex(
          COLOR_DEFAULTS["terminal.ansiRed"]?.[type] as string,
        ).toString(),
      );
    }
    expect(new ResolvedColorTheme(theme("dark")).css("foreground")).toBe(
      "#cccccc",
    );
    expect(new ResolvedColorTheme(theme("light")).css("foreground")).toBe(
      "#616161",
    );
  });

  it("follow a default that refers to another colour, through the theme", () => {
    // terminal.selectionBackground's default is editor.selectionBackground.
    const resolved = new ResolvedColorTheme(
      theme("dark", { "editor.selectionBackground": "#abcdef" }),
    );
    expect(resolved.css("terminal.selectionBackground")).toBe("#abcdef");
  });

  it("have no colour where neither the theme nor the registry gives one", () => {
    expect(
      new ResolvedColorTheme(theme("dark")).css("terminal.background"),
    ).toBeUndefined();
  });

  it("evaluate every transform a default can be", () => {
    const table: ColorDefaultsTable = Object.fromEntries(
      (
        [
          ["base", "#808080"],
          ["dark", { op: "darken", value: "base", factor: 0.5 }],
          ["clear", { op: "transparent", value: "base", factor: 0.5 }],
          ["firstSet", { op: "oneOf", values: ["unset", "base"] }],
          [
            "picked",
            {
              op: "ifDefinedThenElse",
              if: "own",
              then: "#111111",
              else: "#222222",
            },
          ],
          ["flat", { op: "opaque", value: "clear", background: "#000000" }],
          ["loop", "loop"],
        ] as const
      ).map(([id, value]) => [
        id,
        { light: value, dark: value, hcDark: value, hcLight: value },
      ]),
    );
    const plain = new ResolvedColorTheme(theme("dark"), table);
    expect(plain.css("dark")).toBe("#404040");
    expect(plain.css("clear")).toBe("rgba(128, 128, 128, 0.5)");
    expect(plain.css("firstSet")).toBe("#808080");
    expect(plain.css("picked")).toBe("#222222");
    expect(plain.css("flat")).toBe("#404040");
    expect(plain.css("loop")).toBeUndefined();
    const own = new ResolvedColorTheme(
      theme("dark", { own: "#ffffff" }),
      table,
    );
    expect(own.css("picked")).toBe("#111111");
  });
});

describe("what DevHub paints from a theme", () => {
  it("is the four anchors the window splash carries", () => {
    const palette = shellPaletteOfTheme(
      new ResolvedColorTheme(
        theme("dark", {
          "editor.background": "#1f1f1f",
          "sideBar.background": "#181818",
          "titleBar.activeBackground": "#18181880",
          foreground: "#cccccc",
        }),
      ),
    );
    expect(palette).toEqual({
      base: "dark",
      surface: "#1f1f1f",
      chrome: "#181818",
      // Made opaque over the workbench background, as the splash does.
      canvas: "#1e1e1e",
      ink: "#cccccc",
    });
  });

  it("is a whole palette even for a theme that sets nothing", () => {
    for (const type of ["light", "dark", "hcDark", "hcLight"] as const) {
      const resolved = new ResolvedColorTheme(theme(type));
      const palette = shellPaletteOfTheme(resolved);
      expect(palette.base).toBe(
        type === "light" || type === "hcLight" ? "light" : "dark",
      );
      for (const color of [
        palette.surface,
        palette.chrome,
        palette.canvas,
        palette.ink,
      ]) {
        expect(isPaletteColor(color)).toBe(true);
      }
      expect(terminalPaletteIsValid(terminalPaletteOfTheme(resolved))).toBe(
        true,
      );
    }
  });

  it("gives the terminal VS Code's fallbacks: the editor's background, the foreground's cursor", () => {
    const palette = terminalPaletteOfTheme(
      new ResolvedColorTheme(
        theme("dark", {
          "editor.background": "#1f1f1f",
          "terminal.foreground": "#dddddd",
        }),
      ),
    );
    expect(palette.background).toBe("#1f1f1f");
    expect(palette.cursor).toBe("#dddddd");
    expect(palette.cursorText).toBe("#1f1f1f");
    expect(palette.selectionForeground).toBeUndefined();
    expect(palette.ansi).toHaveLength(16);
  });
});

describe("the theme type", () => {
  it("is the contribution's uiTheme, dark when it says nothing", () => {
    expect(themeTypeOfUiTheme("vs")).toBe("light");
    expect(themeTypeOfUiTheme("vs-dark")).toBe("dark");
    expect(themeTypeOfUiTheme("hc-black")).toBe("hcDark");
    expect(themeTypeOfUiTheme("hc-light")).toBe("hcLight");
    expect(themeTypeOfUiTheme(undefined)).toBe("dark");
  });
});

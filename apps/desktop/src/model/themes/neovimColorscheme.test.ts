import { describe, expect, it } from "vitest";
import { contrast, distance, oklchOf } from "./color.js";
import { neovimColorscheme, neovimRoles } from "./neovimColorscheme.js";
import { builtinThemes, completeTheme, ThemeCatalog } from "./theme.js";

const TEXT = [
  "keyword",
  "func",
  "type",
  "string",
  "constant",
  "special",
  "member",
  "parameter",
  "builtin",
] as const;

function builtin(name: string) {
  const theme = new ThemeCatalog().find(name);
  if (!theme) throw new Error(`no ${name}`);
  return theme;
}

describe("the roles", () => {
  it("read on the background in every built-in theme", () => {
    for (const theme of builtinThemes()) {
      const roles = neovimRoles(theme);
      for (const role of TEXT) {
        // 4.5:1, or as close as the gamut lets a colour of that hue come.
        expect(contrast(roles[role], roles.bg)).toBeGreaterThan(4.3);
      }
      expect(contrast(roles.comment, roles.bg)).toBeGreaterThan(2.9);
      // A theme whose own text is below 3:1 (Matrix) cannot do better.
      expect(contrast(roles.fg, roles.visual)).toBeGreaterThan(
        Math.min(3, contrast(roles.fg, roles.bg) * 0.85),
      );
    }
  });

  it("take the theme's own colours where they read, as the reference schemes assign them", () => {
    const mocha = neovimRoles(builtin("Catppuccin Mocha"));
    const palette = builtin("Catppuccin Mocha").palette;
    expect(mocha.keyword).toBe(palette[5]);
    expect(mocha.func).toBe(palette[4]);
    expect(mocha.type).toBe(palette[3]);
    expect(mocha.string).toBe(palette[2]);
    expect(mocha.special).toBe(palette[6]);
    // Orange is made between red and yellow.
    const hue = oklchOf(mocha.constant).h;
    expect(hue).toBeGreaterThan(oklchOf(mocha.red).h);
    expect(hue).toBeLessThan(oklchOf(mocha.yellow).h);
  });

  it("give a slot with no hue, or a copy of another, a hue of its own", () => {
    const grey = "#888888";
    const theme = completeTheme({
      name: "Broken",
      background: "#101010",
      foreground: "#e0e0e0",
      palette: [
        "#000000",
        "#e06c75",
        "#98c379",
        "#e5c07b",
        "#61afef",
        grey, // magenta is grey
        "#61afef", // cyan is blue
        "#e0e0e0",
        "#5c6370",
        "#e06c75",
        "#98c379",
        "#e5c07b",
        "#61afef",
        grey,
        "#61afef",
        "#ffffff",
      ],
    });
    const roles = neovimRoles(theme);
    expect(oklchOf(roles.keyword).c).toBeGreaterThan(0.05);
    expect(distance(roles.special, roles.func)).toBeGreaterThan(0.04);
  });

  it("leave a grey theme grey, and tell keywords by weight", () => {
    const theme = completeTheme({
      name: "Grey",
      background: "#111111",
      foreground: "#dddddd",
      palette: Array.from({ length: 16 }, (_, i) =>
        i % 2 === 0 ? "#999999" : "#bbbbbb",
      ),
    });
    const scheme = neovimColorscheme(theme);
    expect(scheme.highlights["Statement"]).toEqual({
      fg: "#dddddd",
      bold: true,
    });
  });

  it("are a light scheme's for a light theme", () => {
    const latte = neovimColorscheme(builtin("Catppuccin Latte"));
    expect(latte.background).toBe("light");
    expect(latte.highlights["Normal"]).toEqual({
      fg: "#4c4f69",
      bg: "#eff1f5",
    });
  });
});

describe("the groups", () => {
  it("link only to groups that are there or Neovim's own", () => {
    const { highlights } = neovimColorscheme(builtin("TokyoNight"));
    for (const [name, spec] of Object.entries(highlights)) {
      if (spec.link === undefined) continue;
      expect(
        highlights[spec.link] !== undefined,
        `${name} → ${spec.link}`,
      ).toBe(true);
    }
  });

  it("cover the editor, syntax, Tree-sitter, LSP, diagnostics and diffs", () => {
    const { highlights, terminal } = neovimColorscheme(builtin("Nord"));
    for (const name of [
      "Normal",
      "NormalFloat",
      "FloatBorder",
      "Pmenu",
      "PmenuSel",
      "StatusLine",
      "Visual",
      "CurSearch",
      "Comment",
      "@variable.member",
      "@lsp.type.unresolvedReference",
      "DiagnosticVirtualTextError",
      "DiagnosticUnderlineWarn",
      "DiffAdd",
      "@diff.plus",
      "PmenuMatch",
    ]) {
      expect(highlights[name], name).toBeDefined();
    }
    // Neovim's groups only: no plugin's (DevHub knows none).
    expect(
      Object.keys(highlights).filter((name) =>
        /^(Blink|GitSigns|Snacks|Fidget|NvimTree|CmpItem)/u.test(name),
      ),
    ).toEqual([]);
    expect(highlights["DiagnosticUnderlineError"]).toMatchObject({
      undercurl: true,
    });
    expect(terminal).toHaveLength(16);
  });
});

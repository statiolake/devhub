/**
 * DevHub's colour themes: a terminal palette each, the way Ghostty's are —
 * sixteen ANSI colours, the background and foreground, the cursor and the
 * text under it, the selection — and everything DevHub paints is derived from
 * the one the settings select.
 *
 * - **Built in**: DevHub's own two (`devhubThemes.ts`) and the permissively
 *   licensed part of iTerm2-Color-Schemes (`builtinThemes.generated.ts`,
 *   `distribution/licenses/iTerm2-Color-Schemes.txt`), the collection Ghostty
 *   ships.
 * - **Custom**: `[themes.<name>]` tables in `settings.toml`, the same fields;
 *   one named like a built-in theme replaces it.
 * - **Selected** by `[appearance] theme`: one name for both appearances, or
 *   `light:<name>,dark:<name>`, as Ghostty spells it, the half chosen by the
 *   appearance DevHub is in (`appearance.mode`).
 *
 * Derived from it (`shellPaletteOfTheme`, `terminalPaletteOfTheme`, and
 * `neovimColorscheme.ts`): DevHub's window and pages, its terminals, and the
 * Neovims it draws. VS Code is not asked: a workbench keeps its own theme.
 */

import type { TerminalPaletteWire } from "../../ipc/appShell.js";
import type { ShellPalette } from "../../ipc/palette.js";
import { BUILTIN_THEME_ROWS } from "./builtinThemes.generated.js";
import {
  contrast,
  isDark,
  mix,
  normalizeHex,
  oklchOf,
  shiftLightness,
  withContrast,
} from "./color.js";
import { DEVHUB_THEMES } from "./devhubThemes.js";
import { NEOVIM_PLUGINS } from "./neovimPlugins.js";

export {
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  DEFAULT_THEME_SELECTION,
  formatThemeSelection,
  parseThemeSelection,
  type ThemeSelection,
} from "./selection.js";

/** One theme: every colour `#rrggbb`. */
export interface Theme {
  readonly name: string;
  readonly background: string;
  readonly foreground: string;
  readonly cursor: string;
  readonly cursorText: string;
  readonly selectionBackground: string;
  /** Absent: a selected cell keeps its own colour. */
  readonly selectionForeground?: string;
  /** ANSI 0–15: black, red, green, yellow, blue, magenta, cyan, white, then bright. */
  readonly palette: readonly string[];
  /**
   * The Neovim colorscheme the theme is meant to be worn as (what
   * `:colorscheme` takes), when it has one of its own: the Neovims DevHub
   * draws wear it where it is installed, else the colorscheme DevHub
   * generates. Built-in themes take it from `NEOVIM_PLUGINS`.
   */
  readonly neovimColorscheme?: string;
  /** The plugin that provides it, `owner/repo`: named in the hint to install it. */
  readonly neovimPlugin?: string;
}

/** Where a theme in the catalog comes from. */
export type ThemeOrigin = "devhub" | "builtin" | "custom";

export interface CatalogTheme extends Theme {
  readonly origin: ThemeOrigin;
}

/** `dark` or `light`, by the theme's background. */
export type ThemeKind = "dark" | "light";

export function themeKindOf(theme: Theme): ThemeKind {
  return isDark(theme.background) ? "dark" : "light";
}

let builtins: readonly CatalogTheme[] | undefined;

function rowTheme(name: string, colors: string): CatalogTheme {
  const values = colors.split(" ").map((value) => `#${value}`);
  const [background, foreground, cursor, cursorText, selection, selectionFg] =
    values;
  return {
    name,
    origin: "builtin",
    background: background ?? "#000000",
    foreground: foreground ?? "#ffffff",
    cursor: cursor ?? foreground ?? "#ffffff",
    cursorText: cursorText ?? background ?? "#000000",
    selectionBackground: selection ?? "#808080",
    ...(selectionFg === undefined ? {} : { selectionForeground: selectionFg }),
    palette: values.slice(6, 22),
  };
}

/** A built-in theme with the Neovim colorscheme `NEOVIM_PLUGINS` names for it. */
function withNeovimPlugin(theme: CatalogTheme): CatalogTheme {
  const plugin = NEOVIM_PLUGINS[theme.name];
  return plugin === undefined
    ? theme
    : {
        ...theme,
        neovimColorscheme: plugin.colorscheme,
        neovimPlugin: plugin.plugin,
      };
}

/** Every built-in theme: DevHub's two first, then the collection by name. */
export function builtinThemes(): readonly CatalogTheme[] {
  builtins ??= [
    ...DEVHUB_THEMES.map((theme) => ({ ...theme, origin: "devhub" as const })),
    ...BUILTIN_THEME_ROWS.map(([name, colors]) => rowTheme(name, colors)),
  ].map(withNeovimPlugin);
  return builtins;
}

/** The built-in themes and the person's own, looked up by name. */
export class ThemeCatalog {
  private readonly byName = new Map<string, CatalogTheme>();
  private readonly byFold = new Map<string, CatalogTheme>();

  constructor(custom: readonly Theme[] = []) {
    for (const theme of builtinThemes()) this.add(theme);
    // After the built-in ones: a custom theme of the same name wins.
    for (const theme of custom) this.add({ ...theme, origin: "custom" });
  }

  private add(theme: CatalogTheme): void {
    this.byName.set(theme.name, theme);
    this.byFold.set(theme.name.toLowerCase(), theme);
  }

  /** The theme called `name`: exactly, else ignoring case. */
  find(name: string): CatalogTheme | undefined {
    return this.byName.get(name) ?? this.byFold.get(name.trim().toLowerCase());
  }

  /** Every theme, custom ones first, then DevHub's, then the collection. */
  list(): readonly CatalogTheme[] {
    const all = [...this.byName.values()];
    const rank = (theme: CatalogTheme): number =>
      theme.origin === "custom" ? 0 : theme.origin === "devhub" ? 1 : 2;
    return all.sort((a, b) => rank(a) - rank(b));
  }
}

/** The fields a `[themes.<name>]` table may set, as TOML spells them. */
export const CUSTOM_THEME_KEYS: readonly string[] = [
  "background",
  "foreground",
  "cursor",
  "cursor_text",
  "selection_background",
  "selection_foreground",
  "palette",
  "neovim_colorscheme",
  "neovim_plugin",
];

/**
 * A custom theme's colours, with the optional ones filled in the way a
 * terminal would: the cursor is the foreground, the text under it the
 * background, the selection a quarter of the way from the background to the
 * foreground.
 */
export function completeTheme(fields: {
  readonly name: string;
  readonly background: string;
  readonly foreground: string;
  readonly cursor?: string | undefined;
  readonly cursorText?: string | undefined;
  readonly selectionBackground?: string | undefined;
  readonly selectionForeground?: string | undefined;
  readonly palette: readonly string[];
  readonly neovimColorscheme?: string | undefined;
  readonly neovimPlugin?: string | undefined;
}): Theme {
  const background = normalizeHex(fields.background);
  const foreground = normalizeHex(fields.foreground);
  const selectionForeground =
    fields.selectionForeground === undefined
      ? undefined
      : normalizeHex(fields.selectionForeground);
  return {
    name: fields.name,
    background,
    foreground,
    cursor:
      fields.cursor === undefined ? foreground : normalizeHex(fields.cursor),
    cursorText:
      fields.cursorText === undefined
        ? background
        : normalizeHex(fields.cursorText),
    selectionBackground:
      fields.selectionBackground === undefined
        ? mix(background, foreground, 0.25)
        : normalizeHex(fields.selectionBackground),
    ...(selectionForeground === undefined ? {} : { selectionForeground }),
    palette: fields.palette.map(normalizeHex),
    ...(fields.neovimColorscheme === undefined
      ? {}
      : { neovimColorscheme: fields.neovimColorscheme }),
    ...(fields.neovimPlugin === undefined
      ? {}
      : { neovimPlugin: fields.neovimPlugin }),
  };
}

// ----- what DevHub paints with it

/**
 * The shell's palette: DevHub's window and every page.
 *
 * - `surface` is the theme's background: content sits on the same ground as
 *   the terminal beside it.
 * - `chrome` (the Sidebar, the title band) and `canvas` (the window behind)
 *   are the background moved 0.03 in OKLCH lightness — darker, as an editor's
 *   side bar usually is, or lighter on a ground already near black, where
 *   darker would not show. Same hue: a frame, not a second colour.
 * - `ink` is the foreground.
 * - `accent` is the theme's blue (ANSI 4, or bright blue 12 when that reads
 *   better), lifted to 4.5:1 on the surface if it has to be, since DevHub's
 *   accent is mostly read as ink: links, the selected mark, focus rings.
 * - `accentInk`, drawn on the accent, is whichever of the background and the
 *   foreground holds more contrast on it.
 */
export function shellPaletteOfTheme(theme: Theme): ShellPalette {
  const base = themeKindOf(theme);
  const ground = theme.background;
  const groundL = oklchOf(ground).l;
  // Near black, a step of 0.03 rounds back to the ground itself: lift it
  // to where a step shows.
  const chrome =
    groundL < 0.16
      ? shiftLightness(ground, Math.max(0.03, 0.15 - groundL))
      : shiftLightness(ground, -0.03);
  const blue = theme.palette[4] ?? theme.foreground;
  const brightBlue = theme.palette[12] ?? blue;
  const picked =
    contrast(blue, ground) >= contrast(brightBlue, ground) ? blue : brightBlue;
  const accent = withContrast(picked, ground, 4.5);
  const accentInk =
    contrast(ground, accent) >= contrast(theme.foreground, accent)
      ? ground
      : theme.foreground;
  return {
    base,
    surface: ground,
    chrome,
    canvas: chrome,
    ink: theme.foreground,
    accent,
    accentInk,
  };
}

/** The terminal's palette: the theme itself. */
export function terminalPaletteOfTheme(theme: Theme): TerminalPaletteWire {
  return {
    background: theme.background,
    foreground: theme.foreground,
    cursor: theme.cursor,
    cursorText: theme.cursorText,
    selectionBackground: theme.selectionBackground,
    selectionForeground: theme.selectionForeground,
    ansi: [...theme.palette],
  };
}

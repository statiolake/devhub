/**
 * What DevHub tells the programs in its terminals about the colour theme it
 * wears.
 *
 * It *publishes* the theme — its name, its kind, and the sixteen ANSI colours
 * with the background, foreground, cursor and selection its own terminals
 * were given — for a person's config to use (fzf, a shell prompt, a Neovim
 * DevHub does not draw). Three channels carry the same
 * value (`main/shell/themePublication.ts` sends it):
 *
 * - **the environment** of every new pane (`themeEnvironment`), stated in each
 *   DevHub tmux server's global environment;
 * - **a file** (`themeFileText`, at `themeFilePath`), rewritten atomically on
 *   every change, for programs already running to watch;
 * - **the managed Neovim**, told over msgpack-rpc (`g:devhub_theme`, then
 *   `User DevhubTheme`).
 *
 * This module is the value and its spellings, with nothing to do with how they
 * are delivered. The documented interface is `docs/window-and-pages.md`,
 * "Terminal programs".
 */

import { join } from "node:path";
import type { TerminalPaletteWire } from "../ipc/appShell.js";
import type { ProfileLocations } from "./profile.js";
import { themeKindOf, type Theme, type ThemeKind } from "./themes/theme.js";
import {
  neovimColorscheme,
  type NeovimColorscheme,
} from "./themes/neovimColorscheme.js";

/** `dark` or `light`, by the theme's background. */
export type PublishedThemeKind = ThemeKind;

/** Every colour as `#rrggbb`, made opaque over the background. */
export interface PublishedThemeColors {
  readonly background: string;
  readonly foreground: string;
  readonly cursor: string;
  readonly cursorText: string;
  readonly selectionBackground: string;
  /** Absent when the theme leaves it unset: a selected cell keeps its colour. */
  readonly selectionForeground?: string;
  /** ANSI 0–15: black, red, green, yellow, blue, magenta, cyan, white, then bright. */
  readonly ansi: readonly string[];
}

/** The value itself, as `theme.json` holds it. */
export interface PublishedTheme {
  /** The format of this object; a reader may refuse one it does not know. */
  readonly version: 1;
  /** What `[appearance] theme` names it by. */
  readonly name: string;
  readonly kind: PublishedThemeKind;
  /** What `background` a program that only knows two should take. */
  readonly background: "dark" | "light";
  /** True while a theme is only being worn for this session (Theme: Preview…). */
  readonly temporary: boolean;
  readonly colors: PublishedThemeColors;
  /**
   * DevHub's Neovim colorscheme for the theme (`themes/neovimColorscheme.ts`):
   * `background`, every highlight group as an `nvim_set_hl` spec, and the
   * sixteen terminal colours; with `colorscheme` and `plugin` when the theme
   * has a Neovim colorscheme of its own, which is worn instead where it is
   * installed. DevHub applies it to the Neovims it draws; a Neovim it does
   * not draw can apply the same from `theme.json`.
   */
  readonly neovim: NeovimColorscheme;
  /** A ready `fzf --color=` value. */
  readonly fzf: string;
}

/** The variable names, in one place: they are the interface. */
export const THEME_ENV = {
  name: "DEVHUB_THEME",
  kind: "DEVHUB_THEME_KIND",
  background: "DEVHUB_THEME_BACKGROUND",
  colors: "DEVHUB_THEME_COLORS",
  fzf: "DEVHUB_FZF_COLORS",
  file: "DEVHUB_THEME_FILE",
} as const;

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

function parseCssColor(value: string): Rgb | undefined {
  const text = value.trim();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text)?.[1];
  if (hex !== undefined) {
    const full =
      hex.length <= 4 ? [...hex].map((digit) => digit + digit).join("") : hex;
    const byte = (index: number): number =>
      Number.parseInt(full.slice(index * 2, index * 2 + 2), 16);
    return {
      r: byte(0),
      g: byte(1),
      b: byte(2),
      a: full.length === 8 ? byte(3) / 255 : 1,
    };
  }
  const functional =
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(
      text,
    );
  if (functional) {
    const [, r, g, b, a] = functional;
    return {
      r: Number(r),
      g: Number(g),
      b: Number(b),
      a: a === undefined ? 1 : Number(a),
    };
  }
  return undefined;
}

function hexOf({ r, g, b }: Rgb): string {
  const part = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

/**
 * A CSS colour as `#rrggbb`, a translucent one composited over `over` (which
 * is itself opaque). `undefined` for a value that is not a colour.
 */
export function opaqueHex(value: string, over?: string): string | undefined {
  const color = parseCssColor(value);
  if (!color) return undefined;
  if (color.a >= 1) return hexOf(color);
  const ground = (over !== undefined ? parseCssColor(over) : undefined) ?? {
    r: 0,
    g: 0,
    b: 0,
    a: 1,
  };
  const mix = (top: number, bottom: number): number =>
    top * color.a + bottom * (1 - color.a);
  return hexOf({
    r: mix(color.r, ground.r),
    g: mix(color.g, ground.g),
    b: mix(color.b, ground.b),
    a: 1,
  });
}

/** The palette DevHub's terminals wear, every colour made `#rrggbb`. */
export function publishedColorsOf(
  palette: TerminalPaletteWire,
): PublishedThemeColors {
  const background = opaqueHex(palette.background) ?? "#000000";
  const foreground = opaqueHex(palette.foreground, background) ?? "#cccccc";
  const selectionForeground =
    palette.selectionForeground === undefined
      ? undefined
      : opaqueHex(palette.selectionForeground, background);
  return {
    background,
    foreground,
    cursor: opaqueHex(palette.cursor, background) ?? foreground,
    cursorText: opaqueHex(palette.cursorText, background) ?? background,
    selectionBackground:
      opaqueHex(palette.selectionBackground, background) ?? foreground,
    ...(selectionForeground === undefined ? {} : { selectionForeground }),
    ansi: Array.from(
      { length: 16 },
      (_, index) =>
        opaqueHex(palette.ansi[index] ?? "", background) ?? foreground,
    ),
  };
}

/**
 * `fzf --color=` from the terminal palette: the ground and ink are the
 * terminal's own, the current line is the selection, and the accents are the
 * ANSI colours a hand-made fzf scheme usually takes them from.
 */
export function fzfColorsOf(colors: PublishedThemeColors): string {
  const ansi = (index: number): string =>
    colors.ansi[index] ?? colors.foreground;
  return [
    `fg:${colors.foreground}`,
    `bg:${colors.background}`,
    `hl:${ansi(4)}`,
    `fg+:${colors.selectionForeground ?? colors.foreground}`,
    `bg+:${colors.selectionBackground}`,
    `hl+:${ansi(12)}`,
    `info:${ansi(3)}`,
    `prompt:${ansi(4)}`,
    `pointer:${ansi(5)}`,
    `marker:${ansi(2)}`,
    `spinner:${ansi(5)}`,
    `header:${ansi(6)}`,
    `border:${ansi(8)}`,
    `gutter:${colors.background}`,
    `query:${colors.foreground}`,
  ].join(",");
}

/**
 * `DEVHUB_THEME_COLORS`: `key=#rrggbb` pairs separated by spaces — `bg fg
 * cursor cursor_text selection [selection_fg] color0 … color15` — which a
 * shell splits with nothing but its own word splitting.
 */
export function themeColorsString(colors: PublishedThemeColors): string {
  return [
    `bg=${colors.background}`,
    `fg=${colors.foreground}`,
    `cursor=${colors.cursor}`,
    `cursor_text=${colors.cursorText}`,
    `selection=${colors.selectionBackground}`,
    ...(colors.selectionForeground === undefined
      ? []
      : [`selection_fg=${colors.selectionForeground}`]),
    ...colors.ansi.map((color, index) => `color${String(index)}=${color}`),
  ].join(" ");
}

export interface PublishedThemeSource {
  readonly theme: Theme;
  /** The palette DevHub's own terminals are given under it. */
  readonly terminal: TerminalPaletteWire;
  readonly temporary: boolean;
}

export function publishedThemeOf(source: PublishedThemeSource): PublishedTheme {
  const colors = publishedColorsOf(source.terminal);
  const kind = themeKindOf(source.theme);
  return {
    version: 1,
    name: source.theme.name,
    kind,
    background: kind,
    temporary: source.temporary,
    colors,
    neovim: {
      ...neovimColorscheme(source.theme),
      ...(source.theme.neovimColorscheme === undefined
        ? {}
        : { colorscheme: source.theme.neovimColorscheme }),
      ...(source.theme.neovimPlugin === undefined
        ? {}
        : { plugin: source.theme.neovimPlugin }),
    },
    fzf: fzfColorsOf(colors),
  };
}

/**
 * The variables a new pane is given. `themeFile` only where the file is on the
 * machine the pane runs on — this Mac's; a host's panes are told the rest.
 */
export function themeEnvironment(
  theme: PublishedTheme,
  themeFile: string | undefined,
): Record<string, string> {
  return {
    [THEME_ENV.name]: theme.name,
    [THEME_ENV.kind]: theme.kind,
    [THEME_ENV.background]: theme.background,
    [THEME_ENV.colors]: themeColorsString(theme.colors),
    [THEME_ENV.fzf]: theme.fzf,
    ...(themeFile === undefined ? {} : { [THEME_ENV.file]: themeFile }),
  };
}

/** `theme.json`'s text: stable key order, one trailing newline. */
export function themeFileText(theme: PublishedTheme): string {
  return `${JSON.stringify(theme, null, 2)}\n`;
}

/**
 * `$XDG_STATE_HOME/devhub/theme.json` (`~/.local/state/devhub/theme.json`
 * when it is unset) — a path a config outside DevHub can name without asking
 * DevHub where it is. A profile other than the default writes its own,
 * `devhub-<profile>/`, as it has its own config directory.
 */
export function themeFilePath(
  profile: Pick<ProfileLocations, "isDefault" | "profile">,
  home: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const xdg = environment["XDG_STATE_HOME"];
  const root =
    xdg !== undefined && xdg.startsWith("/")
      ? xdg
      : join(home, ".local", "state");
  const directory = profile.isDefault ? "devhub" : `devhub-${profile.profile}`;
  return join(root, directory, "theme.json");
}

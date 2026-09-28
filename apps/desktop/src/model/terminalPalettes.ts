/**
 * An Agent pane's colours as settings name them: the palettes, the built-in
 * ones, and the word that says "follow the VS Code theme" instead.
 *
 * On its own, apart from `config.ts`, because the Settings page offers the
 * choice and a page cannot import the file store that `config.ts` also is.
 */

export interface TerminalPalette {
  readonly background: string;
  readonly foreground: string;
  readonly cursor: string;
  readonly cursorText: string;
  readonly selectionBackground: string;
  readonly selectionForeground: string;
  readonly ansi: readonly string[];
}

/** One palette for each half of the page's scheme. */
export interface TerminalPalettes {
  readonly light: TerminalPalette;
  readonly dark: TerminalPalette;
}

/**
 * Where an Agent pane's colours come from: `vscode`, the default, is the
 * terminal colours of the theme the Scratch workbench is wearing (see
 * `main/shell/terminalColors.ts`); palettes are the person's own, one for each
 * scheme, and win whenever the file names them.
 *
 * One value rather than a switch beside two palettes, because the palettes
 * mean nothing when the theme is followed: a file that says both would be a
 * file whose tables are read nowhere.
 */
export type TerminalThemeConfig =
  | typeof TERMINAL_THEME_VSCODE
  | TerminalPalettes;

/** The one word `[appearance] terminal_theme` takes in place of palettes. */
export const TERMINAL_THEME_VSCODE = "vscode";

export function defaultTerminalLight(): TerminalPalette {
  return {
    background: "#FFFFFF",
    foreground: "#202020",
    cursor: "#202020",
    cursorText: "#FFFFFF",
    selectionBackground: "#BFD9F2",
    selectionForeground: "#202020",
    ansi: [
      "#202020",
      "#cf222e",
      "#116329",
      "#B69500",
      "#0550ae",
      "#8250df",
      "#0069CC",
      "#606060",
      "#606060",
      "#ad0707",
      "#1a7f37",
      "#9a6700",
      "#0969da",
      "#6639ba",
      "#1f6feb",
      "#1f2328",
    ],
  };
}

export function defaultTerminalDark(): TerminalPalette {
  return {
    background: "#121314",
    foreground: "#BBBEBF",
    cursor: "#BBBEBF",
    cursorText: "#121314",
    selectionBackground: "#245C73",
    selectionForeground: "#BBBEBF",
    ansi: [
      "#555555",
      "#ff7b72",
      "#7ee787",
      "#e5ba7d",
      "#79c0ff",
      "#d2a8ff",
      "#3994BC",
      "#BBBEBF",
      "#8C8C8C",
      "#f48771",
      "#72C892",
      "#ffa657",
      "#48A0C7",
      "#B267E6",
      "#53A5CA",
      "#ededed",
    ],
  };
}

/** The palettes a pane wears before any VS Code theme has been read. */
export function defaultTerminalPalettes(): TerminalPalettes {
  return { light: defaultTerminalLight(), dark: defaultTerminalDark() };
}

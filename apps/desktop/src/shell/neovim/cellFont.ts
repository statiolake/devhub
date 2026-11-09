/**
 * The one font of DevHub's cell grids: terminal panes and every Neovim DevHub
 * draws are set in `[appearance] terminal_font_family`, `terminal_font_size`
 * and `terminal_line_height`, so a Neovim drawn over a pane has the pane's
 * cells exactly and its rows line up with the terminal's around it.
 *
 * A Neovim whose config says otherwise wins for that Neovim: a `guifont`
 * that is not empty (Neovim's default is empty, so a value is the person's)
 * gives its faces and its size, and a `linespace` above 0 (the default) is
 * the pixels between its rows instead of the line height. Both are read
 * again whenever Neovim sends them (`option_set`), so a `:set guifont=` at
 * run time, or a font-size key binding, takes effect at once and an emptied
 * `guifont` hands the grid back to DevHub's font.
 */

import { terminalFontStack } from "../terminal/theme";
import { parseGuifont, type FontSpec } from "./painter";

/** What the appearance says about the terminal font. */
export interface TerminalFontSettings {
  readonly terminalFontFamily?: string | undefined;
  readonly terminalFontSize?: number | undefined;
  readonly terminalLineHeight?: number | undefined;
}

/** `model/config.ts`' defaults, for a page that has no appearance yet. */
const DEFAULT_SIZE = 13;
const DEFAULT_LINE_HEIGHT = 1;

/** The terminal panes' font, from the appearance. */
export function terminalCellFont(
  appearance: TerminalFontSettings | undefined,
): FontSpec {
  return {
    family: terminalFontStack(appearance?.terminalFontFamily),
    size: appearance?.terminalFontSize ?? DEFAULT_SIZE,
    lineHeight: appearance?.terminalLineHeight ?? DEFAULT_LINE_HEIGHT,
  };
}

/** A Neovim's font: the terminal's, unless its `guifont`/`linespace` say. */
export function neovimCellFont(
  terminal: FontSpec,
  options: { readonly guifont?: unknown; readonly linespace?: unknown },
): FontSpec {
  const guifont = parseGuifont(options.guifont);
  const linespace =
    typeof options.linespace === "number" && options.linespace > 0
      ? options.linespace
      : undefined;
  return {
    family: guifont?.family ?? terminal.family,
    size: guifont?.size ?? terminal.size,
    lineHeight: terminal.lineHeight,
    ...(linespace !== undefined ? { linespace } : {}),
  };
}

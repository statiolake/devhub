/**
 * `[editor] definition_modifier`, the one value both main and the pages read.
 *
 * Kept out of `config.ts` so a page can import it: that module reads files.
 */

/**
 * The key that, held over a symbol in the Neovim editor, draws it as a link
 * when it has a definition, and with a click goes to it — VS Code's
 * Cmd-hover and Cmd-click (docs/neovim-editor.md, "Go to definition with the
 * pointer"). `"alt"` (the default) is Option on a Mac; `"cmd"` is Command
 * (the Windows key elsewhere); `"ctrl"` is Control; `"off"` leaves every
 * click Neovim's.
 *
 * Alt by default because Neovim's own Alt-click (a blockwise Visual start
 * with `mousemodel=popup`, Neovim's default) is the least used of the three:
 * Cmd-click is nothing in a terminal Neovim but a Mac's Cmd is the menus' key,
 * and Ctrl-click is a Mac's right click and Neovim's own `<C-LeftMouse>`
 * (`CTRL-]`, a tag jump). A click with the modifier on a word with no
 * definition is still Neovim's.
 */
export type DefinitionModifier = "alt" | "cmd" | "ctrl" | "off";

export const DEFAULT_DEFINITION_MODIFIER: DefinitionModifier = "alt";

export const DEFINITION_MODIFIERS: readonly DefinitionModifier[] = [
  "alt",
  "cmd",
  "ctrl",
  "off",
];

export function isDefinitionModifier(
  value: unknown,
): value is DefinitionModifier {
  return (
    typeof value === "string" &&
    (DEFINITION_MODIFIERS as readonly string[]).includes(value)
  );
}

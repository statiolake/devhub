/**
 * Every colour id DevHub reads out of a theme.
 *
 * On its own, with nothing imported, because `scripts/generate-color-defaults.mjs`
 * runs it too: these are the roots of the table it generates, so a colour
 * added here is in the table the next time it is generated (and
 * `colorDefaults.test.ts` fails until it is).
 */
export const COLOR_IDS = {
  foreground: "foreground",
  editorBackground: "editor.background",
  sideBarBackground: "sideBar.background",
  titleBarBackground: "titleBar.activeBackground",
  textLinkForeground: "textLink.foreground",
  buttonForeground: "button.foreground",
  terminalBackground: "terminal.background",
  terminalForeground: "terminal.foreground",
  cursor: "terminalCursor.foreground",
  cursorText: "terminalCursor.background",
  selectionBackground: "terminal.selectionBackground",
  selectionForeground: "terminal.selectionForeground",
  ansi: [
    "Black",
    "Red",
    "Green",
    "Yellow",
    "Blue",
    "Magenta",
    "Cyan",
    "White",
    "BrightBlack",
    "BrightRed",
    "BrightGreen",
    "BrightYellow",
    "BrightBlue",
    "BrightMagenta",
    "BrightCyan",
    "BrightWhite",
  ].map((name) => `terminal.ansi${name}`),
  /**
   * The editor's colours, as DevHub publishes them to the programs in its
   * terminals (`model/publishedTheme.ts`): what a Neovim colorscheme made
   * from the theme (devhub.nvim) needs beyond the terminal palette.
   */
  editor: [
    "editor.background",
    "editor.foreground",
    "editor.lineHighlightBackground",
    "editor.selectionBackground",
    "editor.findMatchHighlightBackground",
    "editor.findMatchBackground",
    "editorCursor.foreground",
    "editorLineNumber.foreground",
    "editorLineNumber.activeForeground",
    "editorWhitespace.foreground",
    "editorIndentGuide.background1",
    "editorBracketMatch.background",
    "editorError.foreground",
    "editorWarning.foreground",
    "editorInfo.foreground",
    "editorHint.foreground",
    "editorWidget.background",
    "editorWidget.border",
    "diffEditor.insertedTextBackground",
    "diffEditor.removedTextBackground",
    "statusBar.background",
    "statusBar.foreground",
    "tab.activeBackground",
    "tab.activeForeground",
    "tab.inactiveBackground",
    "tab.inactiveForeground",
    "sideBar.background",
    "panel.border",
    "focusBorder",
    "list.activeSelectionBackground",
    "list.activeSelectionForeground",
    "input.background",
    "scrollbarSlider.background",
    "descriptionForeground",
    "textLink.foreground",
  ],
} as const;

/** Every id in `COLOR_IDS`, flat. */
export function colorIdList(): readonly string[] {
  return Object.values(COLOR_IDS).flatMap((value) =>
    typeof value === "string" ? [value] : [...value],
  );
}

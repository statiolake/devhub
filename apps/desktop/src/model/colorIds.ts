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
} as const;

/** Every id in `COLOR_IDS`, flat. */
export function colorIdList(): readonly string[] {
  return Object.values(COLOR_IDS).flatMap((value) =>
    typeof value === "string" ? [value] : [...value],
  );
}

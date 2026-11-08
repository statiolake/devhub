/**
 * `[appearance] theme`: which theme each appearance wears. On its own, apart
 * from the catalog, so the Settings page can check what is typed without
 * carrying every built-in theme's colours.
 */

/** The theme a selection falls back to for a name nobody has. */
export const DEFAULT_DARK_THEME = "DevHub Dark";
export const DEFAULT_LIGHT_THEME = "DevHub Light";
/** `[appearance] theme` when the file does not say. */
export const DEFAULT_THEME_SELECTION = `light:${DEFAULT_LIGHT_THEME},dark:${DEFAULT_DARK_THEME}`;

/** Which theme each appearance wears. */
export interface ThemeSelection {
  readonly light: string;
  readonly dark: string;
}

/**
 * `[appearance] theme`, read: `Name`, or `light:Name,dark:Name` in either
 * order (Ghostty's syntax). A sentence when it is neither.
 */
export function parseThemeSelection(
  text: string,
): ThemeSelection | { readonly problem: string } {
  const value = text.trim();
  if (value === "") return { problem: "it names no theme" };
  const pair = /^(light|dark)\s*:/iu.test(value);
  if (!pair) return { light: value, dark: value };
  const halves: Partial<Record<"light" | "dark", string>> = {};
  for (const part of value.split(",")) {
    const match = /^\s*(light|dark)\s*:\s*(.*?)\s*$/iu.exec(part);
    if (!match?.[1]) {
      return {
        problem: `'${part.trim()}' is not light:<name> or dark:<name>`,
      };
    }
    const half = match[1].toLowerCase() as "light" | "dark";
    if (halves[half] !== undefined) {
      return { problem: `it names the ${half} theme twice` };
    }
    if (!match[2]) return { problem: `the ${half} theme has no name` };
    halves[half] = match[2];
  }
  if (halves.light === undefined || halves.dark === undefined) {
    return {
      problem: "light:<name>,dark:<name> needs both halves",
    };
  }
  return { light: halves.light, dark: halves.dark };
}

/** The selection as `[appearance] theme` writes it. */
export function formatThemeSelection(selection: ThemeSelection): string {
  return selection.light === selection.dark
    ? selection.light
    : `light:${selection.light},dark:${selection.dark}`;
}

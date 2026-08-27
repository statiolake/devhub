import type { ITheme } from "@xterm/xterm";
import type {
  AppAppearance,
  TerminalPaletteWire,
} from "../generated/app-shell";

/**
 * The families appended behind whatever the viewer chose.
 *
 * A family name that resolves to nothing does not fall back to a monospace
 * face — it falls back to the *default* font, which on a Japanese system is a
 * proportional CJK face whose advance widths make a terminal's columns visibly
 * uneven. Ending the stack in the monospace generic makes that impossible.
 */
const FALLBACK_FAMILIES = [
  "ui-monospace",
  "SFMono-Regular",
  "SF Mono",
  "Menlo",
  "monospace",
];

/** CSS generics must not be quoted, or they are read as family names. */
const GENERIC_FAMILIES = new Set([
  "monospace",
  "ui-monospace",
  "serif",
  "sans-serif",
  "system-ui",
  "cursive",
  "fantasy",
]);

function quoted(family: string): string {
  const name = family.trim();
  if (GENERIC_FAMILIES.has(name)) return name;
  return /^[\w-]+$/u.test(name) ? name : `"${name.replaceAll('"', "")}"`;
}

/**
 * The chosen family first, then the fallbacks it does not already name.
 * Accepts a comma-separated list, so a viewer can spell out their own stack.
 */
export function terminalFontStack(family: string | undefined): string {
  const chosen = (family ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const seen = new Set(chosen.map((part) => part.toLowerCase()));
  return [
    ...chosen,
    ...FALLBACK_FAMILIES.filter((part) => !seen.has(part.toLowerCase())),
  ]
    .map(quoted)
    .join(", ");
}

/** True when the viewer's system appearance is Dark. */
export function prefersDark(view: Window = window): boolean {
  return view.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

/**
 * Project a configured palette onto xterm's theme. The ANSI array is in the
 * canonical order the config documents, and this is the one place that order
 * becomes names.
 */
export function xtermTheme(palette: TerminalPaletteWire): ITheme {
  const [
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite,
  ] = palette.ansi;
  return {
    background: palette.background,
    foreground: palette.foreground,
    cursor: palette.cursor,
    cursorAccent: palette.cursorText,
    selectionBackground: palette.selectionBackground,
    selectionForeground: palette.selectionForeground,
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite,
  };
}

/** The palette for the viewer's current system appearance. */
export function activePalette(
  appearance: AppAppearance | undefined,
  dark: boolean,
): TerminalPaletteWire | undefined {
  const theme = appearance?.terminalTheme;
  if (!theme) return undefined;
  return dark ? theme.dark : theme.light;
}

/** The margin the pane keeps around the grid, in CSS pixels. */
export const DEFAULT_TERMINAL_MARGIN = 4;

/**
 * The custom properties the pane needs to paint itself.
 *
 * Built here rather than inline so a missing projection cannot produce an
 * invalid declaration. `--terminal-margin: undefinedpx` is *not* an unset
 * property: `var()` will not fall back to its default for it, and the padding
 * silently computes to zero instead.
 */
export function terminalSurfaceStyle(
  palette: TerminalPaletteWire | undefined,
  margin: number | undefined,
): Record<string, string> {
  const size = Number.isFinite(margin)
    ? Math.max(0, Number(margin))
    : DEFAULT_TERMINAL_MARGIN;
  return {
    "--terminal-margin": `${size}px`,
    ...(palette ? { "--terminal-background": palette.background } : {}),
  };
}

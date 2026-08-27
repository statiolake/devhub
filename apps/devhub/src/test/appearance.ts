import type {
  AppAppearance,
  TerminalPaletteWire,
} from "../generated/app-shell";

/**
 * A stand-in for the appearance the native side projects.
 *
 * The palette's real defaults live in the Rust config; a test that copies them
 * would just assert that two literals match. What tests need from this is a
 * *shaped* appearance, so the colours here are deliberately synthetic and only
 * the light/dark background differs, which is the one thing tests read back.
 */
export function terminalPalette(background: string): TerminalPaletteWire {
  return {
    ansi: Array.from(
      { length: 16 },
      (_unused, index) => `#${index.toString(16).repeat(6)}`,
    ),
    background,
    cursor: "#202020",
    cursorText: "#ffffff",
    foreground: "#202020",
    selectionBackground: "#bfd9f2",
    selectionForeground: "#202020",
  };
}

export function appearanceFixture(
  overrides: Partial<AppAppearance> = {},
): AppAppearance {
  return {
    colorScheme: "light",
    sequence: 1,
    sidebarDensity: "comfortable",
    terminalFontFamily: "SF Mono",
    terminalFontSize: 13,
    terminalLineHeight: 1.2,
    terminalMargin: 4,
    terminalTheme: {
      dark: terminalPalette("#121314"),
      light: terminalPalette("#ffffff"),
    },
    ...overrides,
  };
}

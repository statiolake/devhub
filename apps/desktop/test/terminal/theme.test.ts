/** Ported from the Tauri app's `src/terminal/theme.test.ts`, unchanged in substance. */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_MARGIN,
  activePalette,
  terminalFontStack,
  terminalSurfaceStyle,
  xtermTheme,
  type TerminalAppearance,
} from "../../src/shell/terminal/theme";

const palette = (background: string) => ({
  ansi: [
    "#000000",
    "#010101",
    "#020202",
    "#030303",
    "#040404",
    "#050505",
    "#060606",
    "#070707",
    "#080808",
    "#090909",
    "#0a0a0a",
    "#0b0b0b",
    "#0c0c0c",
    "#0d0d0d",
    "#0e0e0e",
    "#0f0f0f",
  ],
  background,
  cursor: "#202020",
  cursorText: "#ffffff",
  foreground: "#202020",
  selectionBackground: "#bfd9f2",
  selectionForeground: "#202020",
});

describe("terminal font stack", () => {
  it("ends in the monospace generic whatever the viewer chose", () => {
    // A name that resolves to nothing falls back to the *default* font, which
    // on a Japanese system is a proportional CJK face — the reason a terminal
    // ends up with visibly uneven columns.
    expect(terminalFontStack("Cascadia Code NF")).toBe(
      '"Cascadia Code NF", ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    );
    expect(terminalFontStack(undefined).endsWith("monospace")).toBe(true);
    expect(terminalFontStack("").endsWith("monospace")).toBe(true);
  });

  it("leaves a generic unquoted, or it would read as a family name", () => {
    expect(terminalFontStack("ui-monospace").startsWith("ui-monospace")).toBe(
      true,
    );
    expect(terminalFontStack("ui-monospace")).not.toContain('"ui-monospace"');
  });

  it("accepts a stack and never repeats a family it already names", () => {
    expect(terminalFontStack("Menlo, SF Mono")).toBe(
      'Menlo, "SF Mono", ui-monospace, SFMono-Regular, monospace',
    );
  });

  it("reads a quoted name as CSS does, whichever quote was typed", () => {
    // The reported failure: a viewer wrote the CSS they know —
    // `'Cascadia Code NF', 'Noto Sans JP'` — and got a terminal in neither
    // font. The apostrophes survived into the family name, so the stack asked
    // for a font called `'Cascadia Code NF'` that no system has, and every
    // entry fell through to the trailing generic.
    const expected =
      '"Cascadia Code NF", "Noto Sans JP", ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace';
    expect(terminalFontStack("'Cascadia Code NF', 'Noto Sans JP'")).toBe(
      expected,
    );
    expect(terminalFontStack('"Cascadia Code NF", "Noto Sans JP"')).toBe(
      expected,
    );
    expect(terminalFontStack("Cascadia Code NF, Noto Sans JP")).toBe(expected);
    // Whatever the quoting, no quote character may reach the family name.
    for (const written of [
      "'Cascadia Code NF', 'Noto Sans JP'",
      '"Cascadia Code NF", "Noto Sans JP"',
    ]) {
      expect(terminalFontStack(written)).not.toContain("'");
    }
  });

  it("still recognises a generic and a duplicate through the quotes", () => {
    expect(terminalFontStack("'monospace'")).toBe(
      'monospace, ui-monospace, SFMono-Regular, "SF Mono", Menlo',
    );
    expect(terminalFontStack("'Menlo'")).toBe(
      'Menlo, ui-monospace, SFMono-Regular, "SF Mono", monospace',
    );
  });
});

describe("terminal palette projection", () => {
  it("maps the ANSI array onto xterm's names in canonical order", () => {
    const theme = xtermTheme(palette("#ffffff"));
    expect(theme.black).toBe("#000000");
    expect(theme.white).toBe("#070707");
    expect(theme.brightBlack).toBe("#080808");
    expect(theme.brightWhite).toBe("#0f0f0f");
    expect(theme.background).toBe("#ffffff");
    // xterm calls the cursor's text colour `cursorAccent`.
    expect(theme.cursorAccent).toBe("#ffffff");
  });

  it("chooses the scheme by system appearance, not by a saved choice", () => {
    const appearance = {
      terminalTheme: { dark: palette("#121314"), light: palette("#ffffff") },
    } as unknown as TerminalAppearance;
    expect(activePalette(appearance, true)?.background).toBe("#121314");
    expect(activePalette(appearance, false)?.background).toBe("#ffffff");
    expect(activePalette(undefined, false)).toBeUndefined();
  });
});

describe("terminal surface custom properties", () => {
  it("always declares a usable margin", () => {
    expect(terminalSurfaceStyle(undefined, 12)["--terminal-margin"]).toBe(
      "12px",
    );
    expect(terminalSurfaceStyle(undefined, 0)["--terminal-margin"]).toBe("0px");
  });

  it("falls back for a missing margin instead of writing an invalid value", () => {
    // `--terminal-margin: undefinedpx` is set, not unset, so `var()` would not
    // reach its fallback and the padding would compute to zero.
    for (const missing of [undefined, Number.NaN]) {
      expect(
        terminalSurfaceStyle(undefined, missing)["--terminal-margin"],
      ).toBe(`${DEFAULT_TERMINAL_MARGIN}px`);
    }
  });

  it("omits the background until a palette exists, so CSS keeps its own", () => {
    expect(terminalSurfaceStyle(undefined, 4)).not.toHaveProperty(
      "--terminal-background",
    );
    expect(
      terminalSurfaceStyle(palette("#123456"), 4)["--terminal-background"],
    ).toBe("#123456");
  });
});

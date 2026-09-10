/**
 * What the terminal's appearance projection promises.
 *
 * The font stack is the part with teeth: it is written by a viewer in CSS
 * syntax and read back by Chromium as CSS syntax, and every way of getting the
 * quoting wrong fails the same silent way — the family matches no installed
 * font, the stack falls through to its last generic, and the terminal draws in
 * a face nobody chose.
 *
 * The *vertical* half of the appearance cannot be tested here. jsdom has no
 * font stack, no `fontBoundingBoxAscent`, and no layout, so it cannot say where
 * a glyph's ink lands in a cell; that was measured in an isolated Electron
 * instance instead, and the numbers are in the comment on
 * `AppearanceConfig.terminalLineHeight`.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_MARGIN,
  terminalFontStack,
  terminalSurfaceStyle,
} from "./theme";

/** The families `terminalFontStack` appends behind whatever was chosen. */
const FALLBACKS = `ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace`;

describe("terminalFontStack", () => {
  it("ends in the monospace generic so a missing family cannot fall through to a proportional face", () => {
    expect(terminalFontStack(undefined)).toBe(FALLBACKS);
    expect(terminalFontStack("")).toBe(FALLBACKS);
    expect(terminalFontStack("   ")).toBe(FALLBACKS);
  });

  it("keeps the chosen families first, in the order they were written", () => {
    expect(terminalFontStack("Menlo, Monaco")).toBe(
      `Menlo, Monaco, ui-monospace, SFMono-Regular, "SF Mono", monospace`,
    );
  });

  it("re-quotes a family whose name is not a CSS identifier", () => {
    expect(terminalFontStack("SF Mono")).toBe(
      `"SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace`,
    );
  });

  it("strips the quotes a viewer wrote, so the name matches an installed font", () => {
    // `'SauceCodePro Nerd Font Mono'` with the apostrophes kept is a family
    // name no font carries, and the whole stack silently resolves to its last
    // generic.
    const single = terminalFontStack(
      "'SauceCodePro Nerd Font Mono', 'Hiragino Sans W3'",
    );
    const double = terminalFontStack(
      '"SauceCodePro Nerd Font Mono", "Hiragino Sans W3"',
    );
    expect(single).toBe(
      `"SauceCodePro Nerd Font Mono", "Hiragino Sans W3", ${FALLBACKS}`,
    );
    expect(double).toBe(single);
  });

  it("leaves a generic unquoted, or it would name a font instead of a category", () => {
    expect(terminalFontStack("monospace")).toBe(
      `monospace, ui-monospace, SFMono-Regular, "SF Mono", Menlo`,
    );
    expect(terminalFontStack("system-ui")).toBe(`system-ui, ${FALLBACKS}`);
  });

  it("does not repeat a fallback the viewer already named, whatever its case", () => {
    expect(terminalFontStack("menlo")).toBe(
      `menlo, ui-monospace, SFMono-Regular, "SF Mono", monospace`,
    );
  });

  it("drops the empty entries a trailing or doubled comma leaves behind", () => {
    expect(terminalFontStack("Menlo,, ,")).toBe(
      `Menlo, ui-monospace, SFMono-Regular, "SF Mono", monospace`,
    );
  });

  it("unescapes a quoted name and does not carry a backslash into the value", () => {
    expect(terminalFontStack(String.raw`"My\"Font"`)).toBe(
      `"MyFont", ${FALLBACKS}`,
    );
  });
});

describe("terminalSurfaceStyle", () => {
  it("never writes an unparsable margin, because `var()` would not fall back from one", () => {
    expect(terminalSurfaceStyle(undefined, undefined)).toEqual({
      "--terminal-margin": `${DEFAULT_TERMINAL_MARGIN}px`,
    });
    expect(terminalSurfaceStyle(undefined, Number.NaN)).toEqual({
      "--terminal-margin": `${DEFAULT_TERMINAL_MARGIN}px`,
    });
    expect(terminalSurfaceStyle(undefined, -8)).toEqual({
      "--terminal-margin": "0px",
    });
  });
});

import { describe, expect, it } from "vitest";
import { neovimCellFont, terminalCellFont } from "./cellFont";
import { cellMetrics } from "./painter";

// Source Code Pro at 12 px as Chrome reports its line box: an ascent of 11
// and a descent of 4 on Linux (12 and 3 on macOS), an advance of 7.2.
const SCP_12 = { ascent: 11, descent: 4, advance: 7.2 };

const TERMINAL = terminalCellFont({
  terminalFontFamily: "'Source Code Pro', 'Hiragino Sans W3'",
  terminalFontSize: 12,
  terminalLineHeight: 1.1,
});

describe("cell metrics", () => {
  it("is xterm.js' row: the line box on device pixels times the line height, floored", () => {
    const m = cellMetrics(TERMINAL, SCP_12, 2);
    // 30 × 1.1 = 33 device pixels; a linespace of round(12 × 0.1) = 1 css
    // pixel made it 32.
    expect(m.height).toBe(16.5);
    expect(m.width).toBe(7);
    expect(cellMetrics(TERMINAL, SCP_12, 1).height).toBe(16);
  });

  it("centres the line box in the row, on a device pixel", () => {
    const m = cellMetrics(TERMINAL, SCP_12, 2);
    // 3 device pixels of leading: 2 above (rounded as xterm.js rounds), 1 below.
    expect(m.textTop).toBe(1);
    expect(m.baseline).toBe(12);
    const mac = cellMetrics(TERMINAL, { ...SCP_12, ascent: 12, descent: 3 }, 2);
    expect(mac.baseline).toBe(13);
    expect(mac.height).toBe(16.5);
  });

  it("is the line box alone at a line height of 1", () => {
    const m = cellMetrics({ ...TERMINAL, lineHeight: 1 }, SCP_12, 2);
    expect(m.height).toBe(15);
    expect(m.textTop).toBe(0);
    expect(m.baseline).toBe(11);
  });

  it("adds a Neovim linespace to the line box whole, instead of the line height", () => {
    const m = cellMetrics({ ...TERMINAL, linespace: 2 }, SCP_12, 2);
    expect(m.height).toBe(17);
    expect(m.textTop).toBe(1);
    expect(m.baseline).toBe(12);
  });
});

describe("the cell font", () => {
  it("is the terminal's for the panes, families normalised as CSS", () => {
    expect(TERMINAL).toEqual({
      family: `"Source Code Pro", "Hiragino Sans W3", ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace`,
      size: 12,
      lineHeight: 1.1,
    });
    expect(terminalCellFont(undefined)).toMatchObject({
      size: 13,
      lineHeight: 1,
    });
  });

  it("is the terminal's for a Neovim whose guifont is empty and linespace 0 (Neovim's defaults)", () => {
    expect(neovimCellFont(TERMINAL, { guifont: "", linespace: 0 })).toEqual(
      TERMINAL,
    );
    expect(neovimCellFont(TERMINAL, {})).toEqual(TERMINAL);
  });

  it("is the terminal's for a Neovim whose guifont is Neovim 0.12's own default", () => {
    // `nvim --clean` on macOS, Linux and Windows: not the person's choice.
    for (const guifont of [
      "SF Mono,Menlo,Monaco,Courier New,monospace",
      "Source Code Pro,DejaVu Sans Mono,Courier New,monospace",
      "Cascadia Code,Cascadia Mono,Consolas,Courier New,monospace",
      "DejaVu Sans Mono,Courier New,monospace",
    ]) {
      expect(neovimCellFont(TERMINAL, { guifont, linespace: 0 })).toEqual(
        TERMINAL,
      );
    }
    // The same faces with a size are the person's.
    expect(
      neovimCellFont(TERMINAL, {
        guifont: "SF Mono,Menlo,Monaco,Courier New,monospace:h13",
      }).size,
    ).toBe(13);
  });

  it("takes a set guifont's faces and size, keeping the line height", () => {
    expect(
      neovimCellFont(TERMINAL, { guifont: "Fira Code:h14", linespace: 0 }),
    ).toEqual({ family: '"Fira Code"', size: 14, lineHeight: 1.1 });
    // A guifont with no size keeps the terminal's.
    expect(neovimCellFont(TERMINAL, { guifont: "Menlo" })).toEqual({
      family: "Menlo",
      size: 12,
      lineHeight: 1.1,
    });
  });

  it("takes a set linespace in place of the line height", () => {
    expect(neovimCellFont(TERMINAL, { guifont: "", linespace: 3 })).toEqual({
      ...TERMINAL,
      linespace: 3,
    });
  });
});

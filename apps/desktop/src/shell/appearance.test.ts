import { describe, expect, it } from "vitest";
import { contentVariables } from "./appearance";
import type { TerminalAppearance } from "./terminal/theme";

const appearance = {
  terminalFontFamily: "ui-monospace",
  terminalFontSize: 13,
  terminalLineHeight: 1.2,
  terminalMargin: 4,
  terminalTheme: {
    light: { background: "#ffffff" },
    dark: { background: "#121314" },
  },
} as unknown as TerminalAppearance;

describe("contentVariables", () => {
  it("gives the Editor the theme's own surface", () => {
    expect(contentVariables("editor", appearance, "dark")).toEqual({
      "--content": "var(--surface)",
    });
  });

  it("gives both emulator surfaces the terminal background of the scheme", () => {
    // Terminal and Agent are the same emulator, so one rule answers for both;
    // a branch that named only "terminal" would leave the Agent on a mat of a
    // different colour.
    for (const activity of ["terminal", "agent"] as const) {
      expect(contentVariables(activity, appearance, "dark")).toEqual({
        "--content": "#121314",
      });
      expect(contentVariables(activity, appearance, "light")).toEqual({
        "--content": "#ffffff",
      });
    }
  });

  it("falls back to the surface until the appearance projection has arrived", () => {
    expect(contentVariables("terminal", undefined, "dark")).toEqual({
      "--content": "var(--surface)",
    });
  });
});

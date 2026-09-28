// @vitest-environment jsdom

/**
 * Choosing where an Agent pane's colours come from.
 *
 * The VS Code theme is the default and a word in the file; palettes are the
 * tables under `[appearance.terminal_theme]`. Switching to palettes starts
 * from DevHub's own, and switching back drops them.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultTerminalPalettes,
  TERMINAL_THEME_VSCODE,
} from "../model/terminalPalettes";
import type { SettingsTerminalThemeWire } from "../ipc/settings";
import { SettingsApp } from "./SettingsApp";
import { testClient, testConfig } from "./testHarness";

afterEach(() => {
  cleanup();
});

async function open(terminalTheme: SettingsTerminalThemeWire) {
  const config = testConfig();
  const { saves, client } = testClient({
    ...config,
    appearance: { ...config.appearance, terminalTheme },
  });
  render(<SettingsApp client={client} />);
  fireEvent.click(await screen.findByRole("tab", { name: "General" }));
  return {
    popup: screen.getByLabelText("Agent pane colours"),
    themes: () => saves.map((save) => save.appearance.terminalTheme),
  };
}

describe("the Agent pane colours popup", () => {
  it("shows the VS Code theme when that is the setting, and palettes when those are", async () => {
    expect((await open(TERMINAL_THEME_VSCODE)).popup).toHaveValue("vscode");
    cleanup();
    expect((await open(defaultTerminalPalettes())).popup).toHaveValue(
      "palettes",
    );
  });

  it("starts palettes from DevHub's own", async () => {
    const { popup, themes } = await open(TERMINAL_THEME_VSCODE);
    fireEvent.change(popup, { target: { value: "palettes" } });
    await vi.waitFor(() => {
      expect(themes()).toEqual([defaultTerminalPalettes()]);
    });
  });

  it("follows the theme again when asked", async () => {
    const { popup, themes } = await open(defaultTerminalPalettes());
    fireEvent.change(popup, { target: { value: "vscode" } });
    await vi.waitFor(() => {
      expect(themes()).toEqual([TERMINAL_THEME_VSCODE]);
    });
  });
});

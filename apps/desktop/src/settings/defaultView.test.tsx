// @vitest-environment jsdom

/**
 * Choosing what a new Workspace's editor area shows: its terminal or its
 * VS Code editor (`general.default_view`, `docs/terminal-mode.md`). One popup
 * in the Editors group.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsApp } from "./SettingsApp";
import { testClient, testConfig } from "./testHarness";

afterEach(() => {
  cleanup();
});

async function open(defaultView: string) {
  const config = testConfig();
  const { saves, client } = testClient({
    ...config,
    general: { ...config.general, defaultView },
  });
  render(<SettingsApp client={client} />);
  fireEvent.click(await screen.findByRole("tab", { name: "General" }));
  return {
    popup: screen.getByLabelText("Default view"),
    saved: () => saves.map((save) => save.general.defaultView),
  };
}

describe("the default view popup", () => {
  it("shows the setting as it is", async () => {
    expect((await open("terminal")).popup).toHaveValue("terminal");
    cleanup();
    expect((await open("editor")).popup).toHaveValue("editor");
  });

  it("writes the editor", async () => {
    const { popup, saved } = await open("terminal");
    fireEvent.change(popup, { target: { value: "editor" } });
    await vi.waitFor(() => {
      expect(saved()).toEqual(["editor"]);
    });
  });
});

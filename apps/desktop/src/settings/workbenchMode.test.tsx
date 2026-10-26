// @vitest-environment jsdom

/**
 * Choosing what the editor area is: a VS Code workbench per Workspace, or
 * the Workspace's own tmux session (`docs/terminal-mode.md`). One popup,
 * written as `general.workbench`, and a row that says it takes a restart.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsApp } from "./SettingsApp";
import { testClient, testConfig } from "./testHarness";

afterEach(() => {
  cleanup();
});

async function open(workbench: string) {
  const config = testConfig();
  const { saves, client } = testClient({
    ...config,
    general: { ...config.general, workbench },
  });
  render(<SettingsApp client={client} />);
  fireEvent.click(await screen.findByRole("tab", { name: "General" }));
  return {
    popup: screen.getByLabelText("Editor area"),
    saved: () => saves.map((save) => save.general.workbench),
  };
}

describe("the editor area popup", () => {
  it("shows the setting as it is", async () => {
    expect((await open("vscode")).popup).toHaveValue("vscode");
    cleanup();
    expect((await open("terminal")).popup).toHaveValue("terminal");
  });

  it("writes terminal mode, and says it takes effect at the next start", async () => {
    const { popup, saved } = await open("vscode");
    // The title bar says the same about itself; this is the editor area's.
    expect(
      screen.getByText(
        /Whether editors exist is decided at launch, so this takes effect the next time DevHub starts/u,
      ),
    ).toBeInTheDocument();
    fireEvent.change(popup, { target: { value: "terminal" } });
    await vi.waitFor(() => {
      expect(saved()).toEqual(["terminal"]);
    });
  });
});

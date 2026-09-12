// @vitest-environment jsdom

/**
 * "Other…" — the answer no source covers — as a row.
 *
 * It was a button in the picker's footer, and a footer button in this control
 * is `tabIndex={-1}` because focus stays in the field for as long as the sheet
 * stands. So the one answer for a folder DevHub does not know about was the
 * one answer only a mouse could give. Every other answer here is a row; the
 * arrows reach a row and Return takes it, and that is the whole fix.
 */

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppShellContextValue } from "../../useAppShell";
import { AppShellContext } from "../../useAppShell";
import { WorkspacePicker } from "./WorkspacePicker";

Element.prototype.scrollIntoView = vi.fn();
afterEach(cleanup);

function mount(chosenFolder: string | null = "/elsewhere/thing") {
  const chooseWorkspaceFolder = vi
    .fn()
    .mockResolvedValue(chosenFolder ?? undefined);
  const selectWorkspacePicker = vi.fn().mockResolvedValue(undefined);
  const value = {
    pickerCandidates: [],
    pickerBusy: false,
    pickerSourceCount: 1,
    startWorkspacePicker: vi.fn().mockResolvedValue(undefined),
    cancelWorkspacePicker: vi.fn().mockResolvedValue(undefined),
    selectWorkspacePicker,
    chooseWorkspaceFolder,
    listSshHosts: vi.fn().mockResolvedValue([]),
    openSshWorkspace: vi.fn(),
    reportFailure: vi.fn(),
  } as unknown as AppShellContextValue;
  render(
    <AppShellContext.Provider value={value}>
      <WorkspacePicker onDismiss={vi.fn()} />
    </AppShellContext.Provider>,
  );
  return { chooseWorkspaceFolder, selectWorkspacePicker };
}

/** The rows, in the order the arrows and Return walk them. */
function rows(): string[] {
  return screen
    .getAllByRole("option")
    .map((row) => row.querySelector(".mac-list-title")?.textContent ?? "");
}

describe('the picker\'s "Other…"', () => {
  it("is a row, and the last of the ones that do something", async () => {
    mount();
    await screen.findByText("Other…");
    expect(rows()).toEqual([
      "New Project…",
      "Clone Project…",
      "SSH: Connect…",
      "Other…",
    ]);
  });

  it("is reachable and takeable with the keyboard alone", async () => {
    const { chooseWorkspaceFolder, selectWorkspacePicker } = mount();
    await screen.findByText("Other…");
    const field = screen.getByRole("textbox");
    // Three presses from the first row to the last, then Return — no pointer.
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => {
      expect(chooseWorkspaceFolder).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(selectWorkspacePicker).toHaveBeenCalledWith(
        "/elsewhere/thing",
        false,
      );
    });
  });

  it("opens nothing when the native chooser was cancelled", async () => {
    const { chooseWorkspaceFolder, selectWorkspacePicker } = mount(null);
    await screen.findByText("Other…");
    fireEvent.click(screen.getByText("Other…"));
    await waitFor(() => {
      expect(chooseWorkspaceFolder).toHaveBeenCalledTimes(1);
    });
    expect(selectWorkspacePicker).not.toHaveBeenCalled();
  });

  it("leaves the footer with Cancel and nothing else", async () => {
    mount();
    await screen.findByText("Other…");
    const footer = document.querySelector(".picker-actions");
    expect(
      [...(footer?.querySelectorAll("button") ?? [])].map(
        (button) => button.textContent,
      ),
    ).toEqual(["Cancel"]);
  });
});

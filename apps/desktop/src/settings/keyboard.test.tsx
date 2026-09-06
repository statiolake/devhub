// @vitest-environment jsdom

/**
 * The Keyboard screen.
 *
 * What is asserted is that the screen is *the registry*: a row per command,
 * with the keys the resolver says are in effect. Nothing here is a second
 * table, so a command added to DevHub appears here and one that is not in the
 * registry cannot be bound at all.
 *
 * And that a save writes overrides. A file that stated the whole table would
 * delete whatever DevHub adds next — the bug `agent_actions` had to be reshaped
 * to fix — so an unbind is written as an empty string rather than as an absence.
 */

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { COMMANDS } from "../model/commands";
import { SettingsApp } from "./SettingsApp";
import { testClient, testConfig } from "./testHarness";

afterEach(cleanup);

async function open(chords: Record<string, string> = {}) {
  const harness = testClient(
    testConfig({ keybindings: { prefix: "Cmd+q", chords } }),
  );
  render(<SettingsApp client={harness.client} />);
  fireEvent.click(await screen.findByRole("tab", { name: "Keyboard" }));
  return harness;
}

/** The recorder button for one command, by the command's own label. */
function recorder(label: string): HTMLElement {
  return screen.getByRole("button", { name: `Change the key for ${label}` });
}

describe("the keyboard screen", () => {
  it("lists every command in the registry, and nothing else", async () => {
    await open();
    await screen.findByText("Next workspace");
    for (const command of COMMANDS) {
      expect(recorder(command.label), command.id).toBeInTheDocument();
    }
  });

  it("shows the keys that are actually in effect, not the shipped ones", async () => {
    // `g` moved to `next_tab`, so the tab picker has nothing left and says so.
    await open({ g: "next_tab" });
    await screen.findByText("Next sidebar row");
    expect(recorder("Next sidebar row")).toHaveTextContent("Cmd+n");
    expect(recorder("Next sidebar row")).toHaveTextContent("g");
    expect(recorder("Go to workspace or Agent…")).toHaveTextContent("Unbound");
  });

  it("shows the character the key produces", async () => {
    await open();
    await screen.findByText("DevHub Settings…");
    // The stroke *is* `<`. Writing `Shift+,` would be naming a US keyboard's
    // way of making it, which is not what a JIS one does with the same binding.
    expect(recorder("DevHub Settings…")).toHaveTextContent("<");
    expect(recorder("Previous Agent")).toHaveTextContent("{");
    expect(recorder("Keyboard shortcuts")).toHaveTextContent("?");
  });

  it("records the character a keypress produced, not where the key sits", async () => {
    // The same character from the two keys that make it: `}` is Shift and
    // `BracketRight` on a US keyboard and Shift and `Backslash` on a JIS one.
    // Both record the same binding, which is the whole point.
    for (const code of ["BracketRight", "Backslash"]) {
      const harness = await open();
      const button = recorder("Next sidebar row");
      fireEvent.click(button);
      fireEvent.keyDown(button, { key: "}", code, shiftKey: true });
      await waitFor(() => {
        expect(harness.saves.at(-1)?.keybindings.chords["}"], code).toBe(
          "next_tab",
        );
      });
      cleanup();
    }
  });

  it("says which command a recorded key is being taken from", async () => {
    const harness = await open();
    await screen.findByText("Next sidebar row");
    const button = recorder("Next sidebar row");
    fireEvent.click(button);
    // `f` is the workspace picker's. Taking it is allowed; being told is the
    // point, and being told *before* the save is what makes it useful.
    fireEvent.keyDown(button, { code: "KeyF" });
    expect(await screen.findByText(/currently does/u)).toHaveTextContent(
      "Add Workspace…",
    );
    await waitFor(() => {
      expect(harness.saves.at(-1)?.keybindings.chords["f"]).toBe("next_tab");
    });
  });

  it("ignores a modifier pressed on its own while recording", async () => {
    // The same rule the chord layer follows, and the reason a shifted chord
    // used to fall through: `Shift` is not a stroke.
    const harness = await open();
    await screen.findByText("Next sidebar row");
    const button = recorder("Next sidebar row");
    fireEvent.click(button);
    fireEvent.keyDown(button, { code: "ShiftLeft", shiftKey: true });
    expect(harness.saves).toHaveLength(0);
    expect(button).toHaveTextContent("Press a key…");
  });

  it("unbinds a shipped key by writing it as empty, never as an absence", async () => {
    const harness = await open();
    await screen.findByText("Add Workspace…");
    fireEvent.click(
      screen.getAllByRole("button", { name: "Unbind" })[
        COMMANDS.findIndex((command) => command.id === "add_workspace")
      ],
    );
    await waitFor(() => {
      expect(harness.saves.at(-1)?.keybindings.chords["f"]).toBe("");
    });
  });

  it("puts a row back by taking everything it said out of the table", async () => {
    const harness = await open({ f: "", g: "add_workspace" });
    await screen.findByText("Add Workspace…");
    expect(recorder("Add Workspace…")).toHaveTextContent("g");
    fireEvent.click(
      screen.getAllByRole("button", { name: "Reset" })[
        COMMANDS.findIndex((command) => command.id === "add_workspace")
      ],
    );
    await waitFor(() => {
      expect(harness.saves.length).toBeGreaterThan(0);
    });
    const chords = harness.saves.at(-1)?.keybindings.chords ?? {};
    expect(chords["f"]).toBeUndefined();
    expect(chords["g"]).toBeUndefined();
  });

  it("shows a table's problems rather than leaving a key silently dead", async () => {
    await open({ "Hyper+g": "next_tab", h: "teleport" });
    expect(
      await screen.findByText(/keybindings.chords.Hyper\+g/u),
    ).toBeInTheDocument();
    expect(screen.getByText(/keybindings.chords.h/u)).toBeInTheDocument();
  });
});

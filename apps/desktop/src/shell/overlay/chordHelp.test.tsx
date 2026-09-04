// @vitest-environment jsdom

/**
 * The help overlay.
 *
 * What is asserted is that it is a *rendering*, not a table: it draws exactly
 * the rows it is handed, in the order it is handed them, and it says the
 * condition where there is one. Main builds those rows from the command
 * registry and the table actually in effect, which is what makes a hand-written
 * help sheet — always the thing that goes stale first — unnecessary.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeChordKey, parseChordKey } from "../../model/chordKeys";
import {
  COMMANDS,
  defaultKeybindings,
  keysForCommand,
  resolveBindings,
} from "../../model/commands";
import type { ChordHelpRowWire } from "../../ipc/contract";
import { ChordHelpSheet } from "./ChordHelpSheet";

afterEach(cleanup);

/**
 * The rows main would build, built the same way.
 *
 * A copy of `AppController.chordHelpRows` for the test's sake, and the reason
 * the test is worth having: if the two ever disagree, they disagree about the
 * registry, and the registry is the thing both are reading.
 */
function rowsFor(chords: Record<string, string>): readonly ChordHelpRowWire[] {
  const { prefix, bindings } = resolveBindings({
    ...defaultKeybindings(),
    chords,
  });
  const armed = describeChordKey(prefix);
  return COMMANDS.map((command) => ({
    commandId: command.id,
    label: command.label,
    chords: keysForCommand(bindings, command.id).map(
      (key) => `${armed} ${describeChordKey(key)}`,
    ),
    ...(command.needs === "nothing"
      ? {}
      : {
          needs:
            command.needs === "agent"
              ? "with an Agent selected"
              : "with a workspace selected",
        }),
  })).filter((row) => row.chords.length > 0);
}

describe("the chord help", () => {
  it("draws a row for every command that has a key", () => {
    const rows = rowsFor({});
    render(<ChordHelpSheet rows={rows} onDismiss={vi.fn()} />);
    for (const row of rows) {
      // `getAllByText`, because one command is called what the sheet is
      // called: the help has a chord of its own.
      expect(
        screen.getAllByText(row.label).length,
        row.commandId,
      ).toBeGreaterThan(0);
    }
    expect(screen.getAllByText("Cmd+q f")).toHaveLength(1);
  });

  it("shows the keyboard the person has, not the one DevHub ships", () => {
    // `f` moved, `g` taken away, prefix changed. Every one of those has to be
    // visible here, because a help sheet that showed the defaults would be
    // wrong for exactly the person who went and changed something.
    const rows = rowsFor({ f: "next_tab", g: "" });
    render(
      <ChordHelpSheet
        rows={rows.map((row) =>
          row.commandId === "next_tab"
            ? { ...row, chords: row.chords.map((chord) => chord) }
            : row,
        )}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText("Cmd+q f")).toBeInTheDocument();
    expect(screen.queryByText("Go to workspace or Agent…")).toBeNull();
    expect(screen.queryByText("Add Workspace…")).toBeNull();
  });

  it("says what a command needs, so a dead key has a reason on the page", () => {
    render(<ChordHelpSheet rows={rowsFor({})} onDismiss={vi.fn()} />);
    expect(
      screen.getAllByText("with an Agent selected").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText("with a workspace selected").length,
    ).toBeGreaterThan(0);
  });

  it("writes the character beside the key where it can be sure of one", () => {
    render(<ChordHelpSheet rows={rowsFor({})} onDismiss={vi.fn()} />);
    // The binding is `Shift+comma`; what a person looks for is `Shift+,`.
    expect(screen.getByText("Cmd+q Shift+,")).toBeInTheDocument();
    expect(describeChordKey(parseChordKey("Shift+bracketleft"))).toBe(
      "Shift+[",
    );
  });

  it("closes on Escape and on Done", () => {
    const onDismiss = vi.fn();
    render(<ChordHelpSheet rows={rowsFor({})} onDismiss={onDismiss} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });
});

// @vitest-environment jsdom

/**
 * "Send to Agent…"'s sheet draws the rows main hands it, in that order, and
 * answers with the index of the one chosen — the first, the choice made last
 * time, on a bare Return.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SendToAgentRowWire } from "../../ipc/contract";
import { SendToAgentSheet } from "./SendToAgentSheet";

afterEach(cleanup);

const ROWS: readonly SendToAgentRowWire[] = [
  {
    label: "Claude",
    detail: "Claude · GUI · idle · last used",
    kind: "agent",
  },
  { label: "Codex", detail: "Codex · terminal · working", kind: "agent" },
  { label: "New Claude", detail: "Starts a GUI Agent", kind: "new" },
];

function sheet(): HTMLElement {
  return screen.getByRole("dialog");
}

describe("the Send to Agent sheet", () => {
  it("lists the rows it is given, with what each is", () => {
    render(<SendToAgentSheet rows={ROWS} onDismiss={() => undefined} />);
    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual([
      expect.stringContaining("Claude · GUI · idle · last used"),
      expect.stringContaining("Codex · terminal · working"),
      expect.stringContaining("Starts a GUI Agent"),
    ]);
  });

  it("takes the first row on Return, and any row clicked", () => {
    const onDismiss = vi.fn();
    render(<SendToAgentSheet rows={ROWS} onDismiss={onDismiss} />);
    fireEvent.keyDown(sheet(), { key: "Enter" });
    expect(onDismiss).toHaveBeenLastCalledWith(0);
    cleanup();
    render(<SendToAgentSheet rows={ROWS} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("option", { name: /New Claude/u }));
    expect(onDismiss).toHaveBeenLastCalledWith(2);
  });

  it("answers nothing when it is closed", () => {
    const onDismiss = vi.fn();
    render(<SendToAgentSheet rows={ROWS} onDismiss={onDismiss} />);
    fireEvent.keyDown(sheet(), { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledWith();
  });
});

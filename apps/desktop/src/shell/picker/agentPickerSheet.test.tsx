// @vitest-environment jsdom

/**
 * New Agent, and how the Agent it starts is shown.
 *
 * Return launches with the profile's own presentation; Option-Return launches
 * with the other one, for that one Agent. The sheet has to say which of the two
 * the key about to be pressed will do, so each row names it at its right end
 * and names the other while Option is held. A profile whose kind has no GUI
 * has nowhere for Option to turn it, and says so by not changing.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PickerValue } from "./PickerContext";
import { PickerContext } from "./PickerContext";
import { AgentPickerSheet } from "./AgentPickerSheet";

Element.prototype.scrollIntoView = vi.fn();
afterEach(cleanup);

const WORKSPACE = "550e8400-e29b-41d4-a716-446655440000";

function mount(
  listPastSessions: PickerValue["listPastSessions"] = vi
    .fn()
    .mockResolvedValue([]),
) {
  const dispatch = vi.fn().mockResolvedValue(undefined);
  const value = {
    dispatch,
    listPastSessions,
    agentProfiles: {
      availability: "available",
      sequence: 1,
      profiles: [
        {
          id: "claude",
          displayName: "Claude",
          kind: "claude",
          presentation: "tui",
          presentations: ["tui", "gui"],
        },
        {
          id: "codex",
          displayName: "Codex",
          kind: "codex",
          presentation: "gui",
          presentations: ["tui", "gui"],
        },
        {
          id: "cursor",
          displayName: "Cursor",
          kind: "cursor",
          presentation: "tui",
          presentations: ["tui"],
        },
      ],
    },
  } as unknown as PickerValue;
  render(
    <PickerContext.Provider value={value}>
      <AgentPickerSheet workspaceId={WORKSPACE} onDismiss={vi.fn()} />
    </PickerContext.Provider>,
  );
  return { dispatch, listPastSessions };
}

function row(name: RegExp) {
  return screen.getByRole("option", { name });
}

function narrowTo(query: string) {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: query } });
}

describe("launching from New Agent", () => {
  it("launches with the profile's own presentation on Return", () => {
    const { dispatch } = mount();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    expect(dispatch).toHaveBeenCalledWith({
      type: "request_create_agent",
      workspaceId: WORKSPACE,
      profileId: "claude",
      split: false,
      presentation: "tui",
    });
  });

  it("launches with the other presentation on Option-Return", () => {
    const { dispatch } = mount();
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Enter",
      altKey: true,
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "claude", presentation: "gui" }),
    );
  });

  it("turns a GUI default into a terminal the same way", () => {
    const { dispatch } = mount();
    narrowTo("codex");
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Enter",
      altKey: true,
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "codex", presentation: "tui" }),
    );
  });

  it("keeps Command and Option independent when both are held", () => {
    const { dispatch } = mount();
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Enter",
      metaKey: true,
      altKey: true,
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ split: true, presentation: "gui" }),
    );
  });

  it("launches a profile with no GUI as a terminal whatever is held", () => {
    const { dispatch } = mount();
    narrowTo("cursor");
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Enter",
      altKey: true,
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "cursor", presentation: "tui" }),
    );
  });

  it("takes Option from a click too", () => {
    const { dispatch } = mount();
    fireEvent.click(row(/^Codex/u), { altKey: true });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "codex", presentation: "tui" }),
    );
  });
});

describe("what the sheet says will happen", () => {
  it("names each profile's own presentation", () => {
    mount();
    expect(row(/^Claude/u)).toHaveTextContent("TUI");
    expect(row(/^Codex/u)).toHaveTextContent("GUI");
    expect(row(/^Cursor/u)).toHaveTextContent("TUI");
  });

  it("names the other one while Option is held, and only then", () => {
    mount();
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Alt", altKey: true });
    expect(row(/^Claude/u)).toHaveTextContent("GUI");
    expect(row(/^Codex/u)).toHaveTextContent("TUI");
    // Nowhere to turn it, so nothing to say differently.
    expect(row(/^Cursor/u)).toHaveTextContent("TUI");

    fireEvent.keyUp(dialog, { key: "Alt", altKey: false });
    expect(row(/^Claude/u)).toHaveTextContent("TUI");
    expect(row(/^Codex/u)).toHaveTextContent("GUI");
  });

  it("stops naming the other one when the window loses the keyboard", () => {
    mount();
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Alt",
      altKey: true,
    });
    expect(row(/^Claude/u)).toHaveTextContent("GUI");
    // Option let go in another app is a keyup this sheet never hears.
    fireEvent.blur(window);
    expect(row(/^Claude/u)).toHaveTextContent("TUI");
  });

  it("says what Option does", () => {
    mount();
    expect(screen.getByRole("status")).toHaveTextContent(
      "⌥Return opens it as the other of TUI and GUI.",
    );
  });
});

describe("resuming an earlier session", () => {
  it("offers it for the profiles whose CLI keeps sessions", () => {
    mount();
    expect(row(/Resume a Claude session/u)).toBeInTheDocument();
    expect(row(/Resume a Codex session/u)).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /Resume a Cursor session/u }),
    ).toBeNull();
  });

  it("lists the Workspace's sessions of that profile and launches the one picked", async () => {
    const { dispatch, listPastSessions } = mount(
      vi.fn().mockResolvedValue([
        { id: "session-new", title: "Fix the login flow", updatedAt: 2000 },
        { id: "session-old", title: "Write the README" },
      ]),
    );
    // Option on the resume row turns its presentation the way it does a profile's.
    fireEvent.click(row(/Resume a Claude session/u), { altKey: true });
    expect(listPastSessions).toHaveBeenCalledWith(WORKSPACE, "claude");
    fireEvent.click(await screen.findByRole("option", { name: /README/u }));
    expect(dispatch).toHaveBeenCalledWith({
      type: "request_create_agent",
      workspaceId: WORKSPACE,
      profileId: "claude",
      split: false,
      presentation: "gui",
      resume: "session-old",
    });
  });

  it("says why when the sessions cannot be listed", async () => {
    mount(vi.fn().mockRejectedValue(new Error("codex app-server ended: boom")));
    fireEvent.click(row(/Resume a Codex session/u));
    // The reason, and not "there are none", which would be a different fact.
    expect(
      await screen.findByText(/codex app-server ended: boom/u),
    ).toBeInTheDocument();
    expect(screen.queryByText(/has no earlier sessions/u)).toBeNull();
  });
});

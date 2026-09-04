// @vitest-environment jsdom

/**
 * The confirmation on the modal layer, from the moment it is put there.
 *
 * The overlay page is a second page with its own model client: it is created
 * when the first modal opens and its projection arrives over IPC some
 * milliseconds later. So the alert is mounted, always, before it can know
 * anything about the Agent it is asking about — and "I do not know yet" is not
 * "the Agent is gone". Reading them as the same thing is what left the layer
 * on screen with nothing drawn on it.
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
import type {
  AgentProfiles,
  AppAppearance,
  AppOutcome,
  AppSnapshot,
  ConfirmationPurposeWire,
} from "../../ipc/appShell";
import { AppShellProvider } from "../AppShellContext";
import type { AppShellClient } from "../client";
import { CloseConfirmationSheet } from "./CloseConfirmationSheet";

const AGENT_ID = "5d7fd0e2-2a0e-4a2b-9f3e-9a1a0a0b1c2d";
const WORKSPACE_ID = "63752e9f-c93d-4d49-87f0-70f352eea8b0";
const CONFIRMATION_ID = "0d2f8f8e-1f37-4a1f-9b3d-1b0a5a5c6d7e";

function snapshotWith(agents: boolean): AppSnapshot {
  return {
    schemaVersion: 1,
    revision: 7,
    readiness: "ready",
    editorHost: { status: "ready", host: "local" } as AppSnapshot["editorHost"],
    layout: {
      kind: "split",
      editorKey: `workspace-editor:${WORKSPACE_ID}`,
      agentKey: `agent:${AGENT_ID}`,
    },
    selection: {
      context: { kind: "agent", agentId: AGENT_ID },
    } as AppSnapshot["selection"],
    sidebar: { width: 240 } as AppSnapshot["sidebar"],
    splitRatio: 0.55,
    workspaces: [
      {
        id: WORKSPACE_ID,
        label: "folderA",
        root: "/tmp/folderA",
        selectedPath: "/tmp/folderA",
        state: { kind: "available" } as never,
        canCreateAgent: true,
        agents: agents
          ? [
              {
                id: AGENT_ID,
                workspaceId: WORKSPACE_ID,
                displayName: "claude 1",
                profileId: "claude",
                ordinal: 1,
                status: "working",
                unread: false,
                activity: undefined,
                injection: {
                  queued: 0,
                  waitingFor: "nothing_queued",
                  lastResult: undefined,
                },
                controlState: { kind: "running" } as never,
                runtimeHealth: { kind: "healthy" } as never,
              },
            ]
          : [],
      },
    ],
  } as AppSnapshot;
}

const APPEARANCE = {
  sequence: 1,
  colorScheme: "light",
  sidebarDensity: "comfortable",
  terminalFontFamily: "monospace",
  terminalFontSize: 12,
  terminalLineHeight: 1.2,
  terminalMargin: 8,
  terminalTheme: { background: "#fff", foreground: "#000" },
} as unknown as AppAppearance;

const PROFILES: AgentProfiles = {
  sequence: 2,
  availability: "available",
  profiles: [],
} as unknown as AgentProfiles;

/**
 * A transport whose projections arrive after the first render, which is the
 * only way they ever arrive on the overlay page.
 */
function client(
  snapshot: AppSnapshot,
  dispatch: (action: unknown) => Promise<AppOutcome | undefined>,
): AppShellClient {
  const later = <T,>(value: T) =>
    new Promise<T>((resolve) => setTimeout(() => resolve(value), 0));
  return {
    getSnapshot: () => later(snapshot),
    getAppearance: () => later(APPEARANCE),
    getAgentProfiles: () => later(PROFILES),
    replay: () => later({ cursor: 0, events: [], snapshot }),
    dispatch,
    subscribe: () => () => undefined,
    subscribeAppearance: () => () => undefined,
    subscribeAgentProfiles: () => () => undefined,
    subscribeNativeError: () => () => undefined,
    subscribeWorkspacePicker: () => () => undefined,
    getRepositoryStatus: () => later({ sequence: 0, workspaces: [] }),
    subscribeRepositoryStatus: () => () => undefined,
    startWorkspacePicker: async () => "",
    cancelWorkspacePicker: async () => undefined,
    selectWorkspacePicker: async () => ({}) as never,
    chooseWorkspaceFolder: async () => undefined,
    openSettings: async () => undefined,
    openExternalUrl: async () => undefined,
    setContentRect: async () => undefined,
    setContentSurface: async () => undefined,
    openModal: async () => "",
    closeModal: async () => undefined,
  } as unknown as AppShellClient;
}

// jsdom implements no layout, so it has no `scrollIntoView`. Keeping the
// selected row visible is the picker's job, not this file's subject.
Element.prototype.scrollIntoView = vi.fn();

const STOP_AGENT: ConfirmationPurposeWire = { kind: "agent_stop" };

/** A workspace with something open in it, which is the only case that asks. */
const CLOSE_WORKSPACE: ConfirmationPurposeWire = {
  kind: "workspace_close",
  inspection: {
    workspaceId: WORKSPACE_ID,
    workspaceLabel: "folderA",
    agents: { kind: "busy", count: 2 },
    terminalPanes: { kind: "clean" },
    terminalProcesses: { kind: "clean" },
    terminalWindows: { kind: "clean" },
    unsavedEditors: { kind: "unknown", diagnostic: "close_editor_vetoed" },
  },
};

function mount(
  snapshot: AppSnapshot,
  onDismiss: () => void,
  purpose: ConfirmationPurposeWire = STOP_AGENT,
  dispatch = vi.fn(
    async (): Promise<AppOutcome | undefined> =>
      ({ kind: "applied", snapshot }) as never,
  ),
) {
  render(
    <AppShellProvider client={client(snapshot, dispatch)}>
      <CloseConfirmationSheet
        request={{
          kind: "close-confirmation",
          confirmationId: CONFIRMATION_ID,
          purpose,
          ...(purpose.kind === "agent_stop" ? { agentId: AGENT_ID } : {}),
        }}
        onDismiss={onDismiss}
      />
    </AppShellProvider>,
  );
  return dispatch;
}

/** The rows, in the order the arrows and Return walk them. */
function rows(): string[] {
  return screen
    .getAllByRole("option")
    .map((row) => row.querySelector(".mac-list-title")?.textContent ?? "");
}

describe("stopping an Agent, asked on the modal layer", () => {
  afterEach(cleanup);

  it("asks the question instead of taking itself off screen", async () => {
    const onDismiss = vi.fn();
    mount(snapshotWith(true), onDismiss);

    await waitFor(() => {
      expect(screen.getByText("Stop “claude 1”?")).toBeInTheDocument();
    });
    // Nothing settled it, so nothing may close it: a modal that closes itself
    // leaves the layer up with an empty page on it.
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("stops asking once the Agent it asks about is gone", async () => {
    const onDismiss = vi.fn();
    mount(snapshotWith(false), onDismiss);
    await waitFor(() => {
      expect(onDismiss).toHaveBeenCalled();
    });
  });

  /**
   * A confirmation is a list with as many rows as there are answers and the
   * safe one first — the rule in `Picker`'s docstring. It was two buttons with
   * the destructive one under Return, which is the opposite arrangement.
   */
  it("offers two rows, with Cancel first and therefore under Return", async () => {
    mount(snapshotWith(true), vi.fn());
    await waitFor(() => {
      expect(rows()).toEqual(["Cancel", "Stop the Agent"]);
    });
    expect(screen.getAllByRole("option")[0]).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("stops nothing on Return, because Cancel is the row it lands on", async () => {
    const onDismiss = vi.fn();
    const dispatch = mount(snapshotWith(true), onDismiss);
    await waitFor(() => {
      expect(rows()).toHaveLength(2);
    });

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });

    expect(dispatch).not.toHaveBeenCalled();
    // Cancelling settles the confirmation, so the modal goes.
    await waitFor(() => {
      expect(onDismiss).toHaveBeenCalled();
    });
  });

  it("stops nothing on Escape, which means what Cancel means", async () => {
    const onDismiss = vi.fn();
    const dispatch = mount(snapshotWith(true), onDismiss);
    await waitFor(() => {
      expect(rows()).toHaveLength(2);
    });

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(dispatch).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(onDismiss).toHaveBeenCalled();
    });
  });

  it("stops the Agent on the second row", async () => {
    const onDismiss = vi.fn();
    const dispatch = mount(snapshotWith(true), onDismiss);
    await waitFor(() => {
      expect(rows()).toHaveLength(2);
    });

    fireEvent.click(screen.getByText("Stop the Agent"));

    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        type: "confirm_stop_agent",
        confirmationId: CONFIRMATION_ID,
      });
    });
    await waitFor(() => {
      expect(onDismiss).toHaveBeenCalled();
    });
  });

  /**
   * A refused stop has not consumed main's one-shot operation, so it is still
   * there to be answered — and the sheet says why the last answer did nothing
   * rather than standing there looking as if nothing was asked.
   */
  it("re-asks, with the reason, when main refuses", async () => {
    const onDismiss = vi.fn();
    const refuse = vi.fn(
      async (): Promise<AppOutcome | undefined> => undefined,
    );
    mount(snapshotWith(true), onDismiss, STOP_AGENT, refuse);
    await waitFor(() => {
      expect(rows()).toHaveLength(2);
    });

    fireEvent.click(screen.getByText("Stop the Agent"));

    await waitFor(() => {
      expect(
        screen.getByText("The Agent could not be stopped. Try again."),
      ).toBeInTheDocument();
    });
    expect(onDismiss).not.toHaveBeenCalled();
    // Asked again, not locked on the row it took.
    expect(rows()).toEqual(["Cancel", "Stop the Agent"]);
  });
});

describe("closing a workspace with things open in it", () => {
  afterEach(cleanup);

  it("names the workspace and offers the two answers", async () => {
    mount(snapshotWith(true), vi.fn(), CLOSE_WORKSPACE);
    await waitFor(() => {
      expect(screen.getByText("Close “folderA”?")).toBeInTheDocument();
    });
    expect(rows()).toEqual(["Cancel", "Close the workspace"]);
  });

  /**
   * What is open is the whole reason a person hesitates over this question, so
   * it stays on the sheet — under the list, where a picker says things about
   * itself, rather than in a table under a message.
   */
  it("keeps the diagnostics, and only the ones that are not clean", async () => {
    mount(snapshotWith(true), vi.fn(), CLOSE_WORKSPACE);
    await waitFor(() => {
      expect(screen.getByText("Agents")).toBeInTheDocument();
    });
    expect(screen.getByText("2 busy")).toBeInTheDocument();
    expect(screen.getByText("Unsaved editors")).toBeInTheDocument();
    expect(
      screen.getByText("The editor has unsaved changes"),
    ).toBeInTheDocument();
    // A clean resource is not news, and listing it would bury the ones that are.
    expect(screen.queryByText("Terminal panes")).not.toBeInTheDocument();
  });

  it("closes the workspace on the second row", async () => {
    const dispatch = mount(snapshotWith(true), vi.fn(), CLOSE_WORKSPACE);
    await waitFor(() => {
      expect(rows()).toHaveLength(2);
    });

    fireEvent.click(screen.getByText("Close the workspace"));

    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        type: "confirm_close_workspace",
        confirmationId: CONFIRMATION_ID,
      });
    });
  });
});

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
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentProfiles,
  AppAppearance,
  AppOutcome,
  AppSnapshot,
} from "../../ipc/appShell";
import { AppShellProvider } from "../AppShellContext";
import type { AppShellClient } from "../client";
import { CloseConfirmationAlert } from "./CloseConfirmationAlert";

const AGENT_ID = "5d7fd0e2-2a0e-4a2b-9f3e-9a1a0a0b1c2d";
const WORKSPACE_ID = "63752e9f-c93d-4d49-87f0-70f352eea8b0";
const CONFIRMATION_ID = "0d2f8f8e-1f37-4a1f-9b3d-1b0a5a5c6d7e";

function snapshotWith(agents: boolean): AppSnapshot {
  return {
    schemaVersion: 1,
    revision: 7,
    readiness: "ready",
    editorHost: { status: "ready", host: "local" } as AppSnapshot["editorHost"],
    activities: [],
    selection: {
      activity: "agent",
      context: { kind: "agent", agentId: AGENT_ID },
    } as AppSnapshot["selection"],
    sidebar: { expanded: true, width: 240 } as AppSnapshot["sidebar"],
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
function client(snapshot: AppSnapshot): AppShellClient {
  const later = <T,>(value: T) =>
    new Promise<T>((resolve) => setTimeout(() => resolve(value), 0));
  return {
    getSnapshot: () => later(snapshot),
    getAppearance: () => later(APPEARANCE),
    getAgentProfiles: () => later(PROFILES),
    replay: () => later({ cursor: 0, events: [], snapshot }),
    dispatch: vi.fn(
      async (): Promise<AppOutcome> => ({ kind: "applied", snapshot }) as never,
    ),
    subscribe: () => () => undefined,
    subscribeAppearance: () => () => undefined,
    subscribeAgentProfiles: () => () => undefined,
    subscribeNativeError: () => () => undefined,
    subscribeWorkspacePicker: () => () => undefined,
    startWorkspacePicker: async () => "",
    cancelWorkspacePicker: async () => undefined,
    selectWorkspacePicker: async () => ({}) as never,
    chooseWorkspaceFolder: async () => undefined,
    openSettings: async () => undefined,
    openExternalUrl: async () => undefined,
    setContentRect: async () => undefined,
    setSurfaceVisible: async () => undefined,
    openModal: async () => "",
    closeModal: async () => undefined,
  } as unknown as AppShellClient;
}

function mount(snapshot: AppSnapshot, onDismiss: () => void) {
  return render(
    <AppShellProvider client={client(snapshot)}>
      <CloseConfirmationAlert
        request={{
          kind: "close-confirmation",
          confirmationId: CONFIRMATION_ID,
          purpose: { kind: "agent_stop" },
          agentId: AGENT_ID,
        }}
        onDismiss={onDismiss}
      />
    </AppShellProvider>,
  );
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
});

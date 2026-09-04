// @vitest-environment jsdom

/**
 * The sheet that stands between a template and an agent's keyboard.
 *
 * Its whole reason to exist is that it is up *while the agent is starting*, so
 * every case here is about the two waits being independent: it must not send
 * on its own, it must send what the person left in the field rather than what
 * DevHub rendered, and it must say so out loud when the agent it was for is not
 * there any more — the one outcome that a sheet closing quietly would turn into
 * a message somebody believes they sent.
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
} from "../../ipc/appShell";
import { AppShellProvider } from "../AppShellContext";
import type { AppShellClient } from "../client";
import { InjectionReviewSheet } from "./InjectionReviewSheet";

const AGENT_ID = "5d7fd0e2-2a0e-4a2b-9f3e-9a1a0a0b1c2d";
const WORKSPACE_ID = "63752e9f-c93d-4d49-87f0-70f352eea8b0";
const INJECTION_ID = "1a2b3c4d-1f37-4a1f-9b3d-1b0a5a5c6d7e";

const TEMPLATE = "read this Issue and implement it\nhttps://example.test/1\n";

function snapshotWith(agent: "running" | "stopped" | "gone"): AppSnapshot {
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
        agents:
          agent === "gone"
            ? []
            : [
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
                    queued: 1,
                    waitingFor: "awaiting_review",
                    lastResult: undefined,
                  },
                  controlState: { kind: agent } as never,
                  runtimeHealth: { kind: "healthy" } as never,
                },
              ],
      },
    ],
  } as AppSnapshot;
}

const APPEARANCE = {
  sequence: 1,
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

/** Projections that arrive after the first render, as they always do here. */
function client(
  snapshot: AppSnapshot,
  overrides: Partial<AppShellClient> = {},
): AppShellClient {
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
    confirmInjection: async () => ({ kind: "applied", snapshot }) as never,
    cancelInjection: async () => ({ kind: "applied", snapshot }) as never,
    ...overrides,
  } as unknown as AppShellClient;
}

function mount(
  snapshot: AppSnapshot,
  overrides: Partial<AppShellClient> = {},
): { readonly onDismiss: () => void } {
  const onDismiss = vi.fn();
  render(
    <AppShellProvider client={client(snapshot, overrides)}>
      <InjectionReviewSheet
        agentId={AGENT_ID}
        injectionId={INJECTION_ID}
        actionName="Work on the Issue"
        text={TEMPLATE}
        onDismiss={onDismiss}
      />
    </AppShellProvider>,
  );
  return { onDismiss };
}

afterEach(cleanup);

describe("reviewing what DevHub is about to say", () => {
  it("shows the rendered template, with its line breaks, ready to edit", () => {
    mount(snapshotWith("running"));
    const field = screen.getByLabelText("Message to send");
    expect(field).toHaveValue(TEMPLATE);
    expect(field.tagName).toBe("TEXTAREA");
    expect(
      screen.getByText("Review the prompt before it is sent"),
    ).toBeVisible();
  });

  it("sends what the person left in the field, not what was rendered", async () => {
    const applied = snapshotWith("running");
    const confirmInjection = vi.fn(
      async () => ({ kind: "applied", snapshot: applied }) as never,
    );
    const { onDismiss } = mount(applied, { confirmInjection });
    fireEvent.change(screen.getByLabelText("Message to send"), {
      target: { value: "do it my way instead" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      expect(confirmInjection).toHaveBeenCalledWith(
        AGENT_ID,
        INJECTION_ID,
        "do it my way instead",
      );
    });
    await waitFor(() => {
      expect(onDismiss).toHaveBeenCalled();
    });
  });

  it("takes Command-Return, because Return is a newline here", async () => {
    const applied = snapshotWith("running");
    const confirmInjection = vi.fn(
      async () => ({ kind: "applied", snapshot: applied }) as never,
    );
    mount(applied, { confirmInjection });
    const field = screen.getByLabelText("Message to send");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(confirmInjection).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    await waitFor(() => {
      expect(confirmInjection).toHaveBeenCalled();
    });
  });

  /**
   * Escape cancels the message and only the message. The agent was started for
   * a reason, and deciding against a sentence is not deciding against it.
   */
  it("cancels the message on Escape without sending anything", async () => {
    const applied = snapshotWith("running");
    const cancelInjection = vi.fn(
      async () => ({ kind: "applied", snapshot: applied }) as never,
    );
    const confirmInjection = vi.fn();
    const { onDismiss } = mount(applied, { cancelInjection, confirmInjection });
    fireEvent.keyDown(screen.getByLabelText("Message to send"), {
      key: "Escape",
    });
    await waitFor(() => {
      expect(cancelInjection).toHaveBeenCalledWith(AGENT_ID, INJECTION_ID);
    });
    expect(confirmInjection).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(onDismiss).toHaveBeenCalled();
    });
  });

  /**
   * The launch failed, or somebody stopped it. Closing quietly here is the one
   * ending that leaves a person believing their message went.
   */
  it("says so, and refuses to send, when the agent has ended", async () => {
    const { onDismiss } = mount(snapshotWith("gone"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /agent has ended/u,
    );
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close" })).toBeVisible();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("says so when the agent stopped while the sheet stood", async () => {
    mount(snapshotWith("stopped"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /no longer running/u,
    );
  });

  /**
   * "I have not been told yet" is not "the agent is gone". The overlay page's
   * projection is in flight while this mounts, and reading the two as one thing
   * would put a failure on screen for every message DevHub ever queues.
   */
  it("does not call an agent missing before the projection has arrived", () => {
    mount(snapshotWith("running"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });
});

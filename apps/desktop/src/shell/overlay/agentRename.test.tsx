// @vitest-environment jsdom

/**
 * Renaming an Agent, now that it is a picker like every other question.
 *
 * What is checked here is the keyboard, because the keyboard is the reason the
 * rename stopped being an alert: the field starts with the name the Agent has,
 * Return takes the row that means "what I typed", Escape cancels, and an empty
 * field offers no row at all — which is the refusal the disabled button used
 * to be.
 *
 * The overlay page's projection arrives after the first render, always, so the
 * transport here answers late the way the real one does.
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
import { AgentRenameSheet } from "./AgentRenameSheet";

// jsdom implements no layout, so it has no `scrollIntoView`. Keeping the
// selected row visible is the picker's job and not this file's subject.
Element.prototype.scrollIntoView = vi.fn();

const AGENT_ID = "5d7fd0e2-2a0e-4a2b-9f3e-9a1a0a0b1c2d";
const WORKSPACE_ID = "63752e9f-c93d-4d49-87f0-70f352eea8b0";

function snapshotWith(control: "running" | "stopping" | "gone"): AppSnapshot {
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
          control === "gone"
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
                    queued: 0,
                    waitingFor: "nothing_queued",
                    lastResult: undefined,
                  },
                  controlState: control,
                  runtimeHealth: { kind: "healthy" } as never,
                },
              ],
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

function mount(
  snapshot: AppSnapshot,
  onDismiss: () => void,
  dispatch = vi.fn(
    async (): Promise<AppOutcome> =>
      ({ kind: "applied", snapshot }) as unknown as AppOutcome,
  ),
) {
  render(
    <AppShellProvider client={client(snapshot, dispatch)}>
      <AgentRenameSheet agentId={AGENT_ID} onDismiss={onDismiss} />
    </AppShellProvider>,
  );
  return dispatch;
}

/** The picker's one field, once the projection has put the sheet on screen. */
async function field(): Promise<HTMLElement> {
  return await waitFor(() =>
    screen.getByRole("textbox", { name: "Rename Agent" }),
  );
}

describe("renaming an Agent", () => {
  afterEach(cleanup);

  it("starts with the name the Agent already has", async () => {
    mount(snapshotWith("running"), vi.fn());
    expect(await field()).toHaveValue("claude 1");
  });

  it("renames on Return, the way every other picker chooses a row", async () => {
    const onDismiss = vi.fn();
    const dispatch = mount(snapshotWith("running"), onDismiss);
    const input = await field();

    fireEvent.change(input, { target: { value: "reviewer" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        type: "rename_agent",
        agentId: AGENT_ID,
        displayName: "reviewer",
      });
    });
    await waitFor(() => {
      expect(onDismiss).toHaveBeenCalled();
    });
  });

  it("cancels on Escape without renaming anything", async () => {
    const onDismiss = vi.fn();
    const dispatch = mount(snapshotWith("running"), onDismiss);

    fireEvent.keyDown(await field(), { key: "Escape" });

    expect(onDismiss).toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  /**
   * An empty field is not a name, and the picker says so by having no row to
   * take — which is the same refusal the disabled button was, in the vocabulary
   * this control already has.
   */
  it("offers nothing to take while the field is empty", async () => {
    const onDismiss = vi.fn();
    const dispatch = mount(snapshotWith("running"), onDismiss);
    const input = await field();

    fireEvent.change(input, { target: { value: "" } });
    expect(screen.queryByRole("option")).not.toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("keeps the sheet up, with what was typed, when the rename is refused", async () => {
    const onDismiss = vi.fn();
    const refuse = vi.fn(
      async (): Promise<AppOutcome | undefined> => undefined,
    );
    mount(snapshotWith("running"), onDismiss, refuse as never);
    const input = await field();

    fireEvent.change(input, { target: { value: "reviewer" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(
        screen.getByText("The agent could not be renamed. Try again."),
      ).toBeInTheDocument();
    });
    expect(onDismiss).not.toHaveBeenCalled();
    // Re-asked, not left locked on the row it took: the field is answering
    // again and still holds what was typed.
    expect(await field()).toHaveValue("reviewer");
  });

  it("stops asking once the Agent it renames is gone", async () => {
    const onDismiss = vi.fn();
    mount(snapshotWith("gone"), onDismiss);
    await waitFor(() => {
      expect(onDismiss).toHaveBeenCalled();
    });
  });

  it("stops asking once the Agent is no longer running", async () => {
    const onDismiss = vi.fn();
    mount(snapshotWith("stopping"), onDismiss);
    await waitFor(() => {
      expect(onDismiss).toHaveBeenCalled();
    });
  });

  /**
   * The projection is in flight when the sheet mounts. "I have not been told"
   * is not "the Agent is gone", and reading them as one thing would close the
   * sheet on the frame it opens.
   */
  it("does not dismiss before the projection has arrived", () => {
    const onDismiss = vi.fn();
    mount(snapshotWith("gone"), onDismiss);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

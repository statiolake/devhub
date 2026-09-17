// @vitest-environment jsdom

/**
 * What a row's button does with the answer main gives it.
 *
 * Every control in this column raises an intent, and an intent has an
 * *outcome*: a snapshot to apply, a question to put on the modal layer, or a
 * failure to hand back. The page's model client is the one thing that knows
 * what to do with each of them — `useProjection` in `shell/model/pageModel.ts`
 * — so a control that reaches past it for the raw bridge throws all three
 * away.
 *
 * That is not a theoretical loss. Stopping a busy Agent is answered with
 * `confirmation_required`, and main's half of it is a one-shot confirmation
 * waiting to be answered. Dropped here, the question is never asked, the
 * confirmation is stranded in main, and the button does nothing at all —
 * silently, because there is no failure either. Reproduced on an isolated
 * instance before this test existed: the row's Stop button left the tmux
 * session running and put no sheet on the picker page, while the same stop
 * through `Cmd+Q X` — which main raises the sheet for itself — worked.
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
import type { ModalRequest, SidebarBridge } from "../../ipc/contract";
import { SidebarApp } from "./SidebarApp";

const AGENT_ID = "5d7fd0e2-2a0e-4a2b-9f3e-9a1a0a0b1c2d";
const WORKSPACE_ID = "63752e9f-c93d-4d49-87f0-70f352eea8b0";
const CONFIRMATION_ID = "0d2f8f8e-1f37-4a1f-9b3d-1b0a5a5c6d7e";

const SNAPSHOT = {
  schemaVersion: 1,
  revision: 7,
  readiness: "ready",
  editorHost: { status: "ready", host: "local" },
  layout: {
    kind: "split",
    editorKey: `workspace-editor:${WORKSPACE_ID}`,
    agentKey: `agent:${AGENT_ID}`,
  },
  selection: { context: { kind: "agent", agentId: AGENT_ID } },
  sidebar: { width: 240, collapsed: false },
  splitRatio: 0.55,
  workspaces: [
    {
      id: WORKSPACE_ID,
      label: "folderA",
      location: { kind: "local" },
      root: "/tmp/folderA",
      displayRoot: "/tmp/folderA",
      key: "/tmp/folderA",
      groupKey: "/tmp/folderA",
      selectedPath: "/tmp/folderA",
      state: { kind: "available" },
      close: { kind: "idle" },
      canCreateAgent: true,
      agents: [
        {
          id: AGENT_ID,
          workspaceId: WORKSPACE_ID,
          displayName: "claude 1",
          profileId: "claude",
          ordinal: 1,
          status: "working",
          unread: undefined,
          activity: undefined,
          injection: {
            queued: 0,
            waitingFor: "nothing_queued",
            lastResult: undefined,
          },
          controlState: { kind: "running" },
          runtimeHealth: { kind: "healthy" },
        },
      ],
    },
  ],
} as unknown as AppSnapshot;

const APPEARANCE = {
  sequence: 1,
  colorScheme: "light",
  sidebarDensity: "comfortable",
  titleBar: "shown",
  terminalFontFamily: "monospace",
  terminalFontSize: 12,
  terminalLineHeight: 1.2,
  terminalMargin: 8,
  terminalTheme: { background: "#fff", foreground: "#000" },
} as unknown as AppAppearance;

const PROFILES = {
  sequence: 2,
  availability: "available",
  profiles: [],
} as unknown as AgentProfiles;

/** What main answers a stop with while the Agent is doing something. */
const CONFIRMATION_REQUIRED = {
  kind: "confirmation_required",
  confirmationId: CONFIRMATION_ID,
  purpose: { kind: "agent_stop", agentId: AGENT_ID },
  snapshot: SNAPSHOT,
} as unknown as AppOutcome;

function mount() {
  const openModal = vi.fn(async (_request: ModalRequest) => "modal-1");
  const dispatch = vi.fn(
    async (): Promise<AppOutcome> => CONFIRMATION_REQUIRED,
  );
  window.devhub = {
    getSnapshot: async () => SNAPSHOT,
    replay: async () => ({ cursor: 0, events: [], snapshot: SNAPSHOT }),
    onSnapshot: () => () => undefined,
    dispatch,
    getAppearance: async () => APPEARANCE,
    onAppearance: () => () => undefined,
    getRepositoryStatus: async () => ({ sequence: 0, workspaces: [] }),
    onRepositoryStatus: () => () => undefined,
    getAgentProfiles: async () => PROFILES,
    onAgentProfiles: () => () => undefined,
    onTheme: () => () => undefined,
    onMenuCommand: () => () => undefined,
    onSidebarArea: () => () => undefined,
    showTooltip: () => undefined,
    hideTooltip: () => undefined,
    releaseTooltip: () => undefined,
    openModal,
    closeWorkspace: async () => undefined,
    openExternalUrl: async () => undefined,
    previewLayout: async () => undefined,
    focusSurface: async () => undefined,
    raiseFailure: () => undefined,
  } as unknown as SidebarBridge;
  render(<SidebarApp />);
  return { dispatch, openModal };
}

describe("a row's Stop button, on an Agent that is doing something", () => {
  afterEach(cleanup);

  it("asks the question main answered it with", async () => {
    const { dispatch, openModal } = mount();

    const stop = await screen.findByLabelText("Stop claude 1");
    fireEvent.click(stop);

    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        type: "stop_agent",
        agentId: AGENT_ID,
      });
    });
    // The outcome is a question nobody has been asked yet. Dropping it is a
    // button that does nothing and says nothing.
    await waitFor(() => {
      expect(openModal).toHaveBeenCalledWith({
        kind: "close-confirmation",
        confirmationId: CONFIRMATION_ID,
        purpose: { kind: "agent_stop", agentId: AGENT_ID },
      });
    });
  });
});

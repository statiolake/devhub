// @vitest-environment jsdom

/**
 * A failure that began on this page.
 *
 * Half of a rule with exactly two halves. This page raises what originated in
 * it — its root handler, and the intents it started — and draws nothing: main
 * journals the failure and publishes it to the page that draws failures, which
 * is not this one. How long it then stays on screen is that page's rule, and
 * `toasts/alertLifetime.test.tsx` is where it is asserted.
 *
 * The two halves used to be one callback, and which one ran was decided by a
 * prop. That made "a failure arrived" and "a failure happened" the same event
 * on a page that had nowhere to draw one: the failure went round main and back
 * for the rest of the session.
 */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentProfiles,
  AppAppearance,
  AppError,
  AppSnapshot,
} from "../ipc/appShell";
import { AppShellProvider } from "./AppShellContext";
import type { AppShellClient } from "./client";
import { useAppShell } from "./useAppShell";

const SNAPSHOT = {
  schemaVersion: 1,
  revision: 1,
  readiness: "ready",
  editorHost: { status: "ready" },
  layout: { kind: "unavailable" },
  selection: { context: { kind: "global" }, presentation: "full" },
  sidebar: { width: 240 },
  splitRatio: 0.55,
  workspaces: [],
} as unknown as AppSnapshot;

const APPEARANCE = { sequence: 1 } as unknown as AppAppearance;
const PROFILES = {
  sequence: 1,
  availability: "available",
  profiles: [],
} as unknown as AgentProfiles;

/** What this page does with a failure of its own: hand it to main. */
function Probe() {
  const { dispatch } = useAppShell();
  return (
    <button
      type="button"
      onClick={() => {
        void dispatch({ type: "resize_sidebar", width: 300 });
      }}
    >
      Act
    </button>
  );
}

function mount() {
  const raised: AppError[] = [];
  const client = {
    getSnapshot: async () => SNAPSHOT,
    getAppearance: async () => APPEARANCE,
    getAgentProfiles: async () => PROFILES,
    replay: async () => ({ cursor: 0, events: [], snapshot: SNAPSHOT }),
    dispatch: vi.fn(async () => ({ kind: "updated", snapshot: SNAPSHOT })),
    subscribe: () => () => undefined,
    subscribeAppearance: () => () => undefined,
    getWindowTitle: async () => "DevHub",
    subscribeWindowTitle: () => () => undefined,
    subscribeAgentProfiles: () => () => undefined,
    subscribeWorkspacePicker: () => () => undefined,
    getRepositoryStatus: async () => ({ sequence: 0, workspaces: [] }),
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
    reportNoticeRetired: async () => undefined,
    raiseFailure: (error: AppError) => {
      raised.push(error);
    },
  } as unknown as AppShellClient;
  render(
    <AppShellProvider client={client}>
      <Probe />
    </AppShellProvider>,
  );
  return { client, raised };
}

describe("a failure that began on this page", () => {
  afterEach(cleanup);

  it("goes to main, which decides where it is drawn", async () => {
    const { client, raised } = mount();
    (
      client as unknown as { dispatch: ReturnType<typeof vi.fn> }
    ).dispatch.mockRejectedValueOnce(
      new Error("the worktree could not be removed"),
    );

    await act(async () => {
      screen.getByText("Act").click();
    });

    expect(raised).toHaveLength(1);
    expect(raised[0].detail ?? raised[0].summary).toContain(
      "the worktree could not be removed",
    );
    // Not drawn from here: main publishes it to the page that draws failures,
    // and that page draws it when it arrives — one lifetime rule, one site.
    expect(document.querySelector(".toast-stack")).toBeNull();
  });
});

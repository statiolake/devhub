// @vitest-environment jsdom

/**
 * How long a failure stays on screen.
 *
 * One rule, and it does not depend on what raised the failure: the user
 * dismisses it, the user starts another action, or a different failure
 * replaces it. The tests here are about the half that is easy to get wrong —
 * a failure that keeps being raised. A degraded save is re-raised every time
 * anything is persisted, which is every few seconds while agents are
 * reconciling, and an alert that comes back the instant it is closed is an
 * alert nobody can close.
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

function failure(detail: string): AppError {
  return {
    code: "persistence_degraded",
    summary: "DevHub could not save its state file.",
    module: "state",
    timestampMs: 1,
    runtimeVersion: "test",
    actions: ["retry"],
    detail,
  };
}

/** The page's view of the alert, and the two gestures that retire it. */
function Probe() {
  const { intentError, dismissIntentError, dispatch } = useAppShell();
  return (
    <div>
      <p data-testid="alert">
        {intentError
          ? `${intentError.summary} ${intentError.detail ?? ""}`
          : ""}
      </p>
      <button type="button" onClick={dismissIntentError}>
        Dismiss
      </button>
      <button
        type="button"
        onClick={() => {
          void dispatch({ type: "resize_sidebar", width: 300 });
        }}
      >
        Act
      </button>
    </div>
  );
}

function mount() {
  let raise: (error: AppError) => void = () => undefined;
  const client = {
    getSnapshot: async () => SNAPSHOT,
    getAppearance: async () => APPEARANCE,
    getAgentProfiles: async () => PROFILES,
    replay: async () => ({ cursor: 0, events: [], snapshot: SNAPSHOT }),
    dispatch: vi.fn(async () => ({ kind: "updated", snapshot: SNAPSHOT })),
    subscribe: () => () => undefined,
    subscribeAppearance: () => () => undefined,
    subscribeAgentProfiles: () => () => undefined,
    subscribeNativeError: (listener: (error: AppError) => void) => {
      raise = listener;
      return () => undefined;
    },
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
  } as unknown as AppShellClient;
  render(
    <AppShellProvider client={client}>
      <Probe />
    </AppShellProvider>,
  );
  return { raise: (error: AppError) => act(() => raise(error)) };
}

const alert = () => screen.getByTestId("alert").textContent ?? "";

describe("the failure on screen", () => {
  afterEach(cleanup);

  it("says which file could not be saved and why", () => {
    const { raise } = mount();
    raise(failure("/tmp/state.json: permission was denied (EACCES)"));
    expect(alert()).toContain(
      "/tmp/state.json: permission was denied (EACCES)",
    );
  });

  it("stays dismissed when the same failure is raised again", async () => {
    const { raise } = mount();
    raise(failure("/tmp/state.json: permission was denied (EACCES)"));
    await act(async () => {
      screen.getByText("Dismiss").click();
    });
    expect(alert()).toBe("");

    raise(failure("/tmp/state.json: permission was denied (EACCES)"));
    expect(alert()).toBe("");
  });

  it("shows a failure that is not the dismissed one", async () => {
    const { raise } = mount();
    raise(failure("/tmp/state.json: permission was denied (EACCES)"));
    await act(async () => {
      screen.getByText("Dismiss").click();
    });

    raise(failure("/tmp/state.json: the file could not be written (ENOSPC)"));
    expect(alert()).toContain("ENOSPC");
  });

  it("shows it again once the user has started another action", async () => {
    const { raise } = mount();
    raise(failure("/tmp/state.json: permission was denied (EACCES)"));
    await act(async () => {
      screen.getByText("Dismiss").click();
    });

    await act(async () => {
      screen.getByText("Act").click();
    });
    raise(failure("/tmp/state.json: permission was denied (EACCES)"));
    expect(alert()).toContain("permission was denied");
  });
});

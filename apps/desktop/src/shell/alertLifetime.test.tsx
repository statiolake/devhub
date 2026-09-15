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
  const { notices, dismissNewestNotice, dispatch } = useAppShell();
  const alert = notices[notices.length - 1];
  return (
    <div>
      <p data-testid="alert">
        {alert ? `${alert.summary} ${alert.detail ?? ""}` : ""}
      </p>
      <button type="button" onClick={dismissNewestNotice}>
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
    subscribeAppCondition: () => () => undefined,
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
  return {
    client,
    raised,
    raise: (error: AppError) => act(() => raise(error)),
  };
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

    raise({
      code: "native_unavailable",
      summary: "The native app shell is unavailable.",
      module: "app",
      timestampMs: 1,
      runtimeVersion: "test",
      actions: ["retry"],
    });
    expect(alert()).toContain("The native app shell is unavailable.");
  });

  it("keeps a dismissed failure away when it comes back in other words", async () => {
    // The same failure re-worded is the same failure. A save that cannot
    // write has a different reason every time the disk is asked — permission
    // one moment, no space the next — and if the words decided which failure
    // it was, the source would only have to reword itself to put a dismissed
    // alert straight back. It is the code that says what a failure is.
    const { raise } = mount();
    raise(failure("/tmp/state.json: permission was denied (EACCES)"));
    await act(async () => {
      screen.getByText("Dismiss").click();
    });

    raise(failure("/tmp/state.json: the file could not be written (ENOSPC)"));
    expect(alert()).toBe("");
  });

  it("keeps a dismissed close failure away until the next close is asked for", async () => {
    // A close that fails raises the same failure every time it is tried, and
    // the model re-pushes it with no detail to tell one from another. The
    // rule is the same as for every other failure: dismissing it puts it
    // away, and only the person's next action brings it back.
    const closeFailed: AppError = {
      code: "workspace_close_failed",
      summary: "The workspace could not be closed cleanly.",
      module: "app",
      timestampMs: 1,
      runtimeVersion: "test",
      actions: ["retry"],
    };
    const { raise } = mount();
    raise(closeFailed);
    expect(alert()).toContain("could not be closed");

    await act(async () => {
      screen.getByText("Dismiss").click();
    });
    expect(alert()).toBe("");

    // A reconcile, a persist, anything that re-raises it: still away.
    raise(closeFailed);
    raise(closeFailed);
    expect(alert()).toBe("");

    await act(async () => {
      screen.getByText("Act").click();
    });
    raise(closeFailed);
    expect(alert()).toContain("could not be closed");
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

/**
 * The rule with two halves: what began here is raised, what arrived is drawn.
 *
 * Both halves used to live in one callback, and which one ran was decided by a
 * prop the overlay page set. That made "a failure arrived" and "a failure
 * happened" the same event on a page that had nowhere to draw one: the overlay
 * received `nativeError`, took itself to be the raiser, handed it back to main,
 * and main published it again. Nothing in the loop was wrong on its own. The
 * fix is not de-duplication; it is that the two halves are two functions, and
 * the delivered one has no way to raise.
 */
describe("a failure delivered to a page", () => {
  afterEach(cleanup);

  it("is never raised back to main", () => {
    const { raise, raised } = mount();
    // Delivery, over and over — the shape the echo had.
    raise(failure("the worktree could not be removed"));
    raise(failure("the worktree could not be removed"));
    raise(failure("the worktree could not be removed"));
    expect(raised).toEqual([]);
  });

  it("is drawn, which is the only thing a delivered failure is for", () => {
    const { raise } = mount();
    raise(failure("the worktree could not be removed"));
    expect(alert()).toContain("the worktree could not be removed");
  });
});

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
    expect(alert()).toBe("");
  });
});

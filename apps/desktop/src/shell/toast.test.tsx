// @vitest-environment jsdom

/**
 * Where the application says what is wrong with the application.
 *
 * One place: the toast stack. Not the foot of the Sidebar, which is a list of
 * what is open and not an error area — a `gh` that is not on the PATH is not a
 * property of the workspace rows it was drawn under. The tests here are the
 * three things that made the old note the wrong shape as well as the wrong
 * place: a condition that keeps failing must not pile up, a condition its
 * source retracts must go, and one the person put away must stay away.
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
import type { AppShellClient, RepositoryStatusWire } from "./client";
import { AppShellProvider } from "./AppShellContext";
import { Sidebar } from "./components/sidebar/Sidebar";
import { Toasts } from "./components/shell/Toasts";

const SNAPSHOT = {
  schemaVersion: 1,
  revision: 1,
  readiness: "ready",
  editorHost: { status: "ready" },
  layout: { kind: "unavailable" },
  selection: { context: { kind: "global" }, presentation: "full" },
  sidebar: { width: 248 },
  splitRatio: 0.55,
  workspaces: [
    {
      id: "w-1",
      label: "widget",
      location: { kind: "local" },
      root: "/projects/widget",
      key: "/projects/widget",
      selectedPath: "/projects/widget",
      state: { kind: "available" },
      close: { kind: "idle" },
      canCreateAgent: true,
      agents: [],
    },
  ],
} as unknown as AppSnapshot;

const APPEARANCE = { sequence: 1 } as unknown as AppAppearance;
const PROFILES = {
  sequence: 1,
  availability: "available",
  profiles: [],
} as unknown as AgentProfiles;

const GH_MISSING = "`gh` is not on the PATH DevHub was given.";

function status(sequence: number, diagnostic?: string): RepositoryStatusWire {
  return {
    sequence,
    workspaces: [],
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

let menuCommand: (command: string) => void = () => undefined;

function mount() {
  let publishStatus: (next: RepositoryStatusWire) => void = () => undefined;
  let publishError: (error: AppError) => void = () => undefined;
  let publishCondition: (condition: {
    source: string;
    summary?: string;
  }) => void = () => undefined;
  window.devhub = {
    openModal: () => Promise.resolve(""),
    onMenuCommand: (listener: (command: string) => void) => {
      menuCommand = listener;
      return () => undefined;
    },
  } as unknown as typeof window.devhub;

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
    subscribeAppCondition: (
      listener: (condition: { source: string; summary?: string }) => void,
    ) => {
      publishCondition = listener;
      return () => undefined;
    },
    subscribeNativeError: (listener: (error: AppError) => void) => {
      publishError = listener;
      return () => undefined;
    },
    subscribeWorkspacePicker: () => () => undefined,
    getRepositoryStatus: async () => status(0),
    subscribeRepositoryStatus: (
      listener: (next: RepositoryStatusWire) => void,
    ) => {
      publishStatus = listener;
      return () => undefined;
    },
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
  } as unknown as AppShellClient;

  render(
    <AppShellProvider client={client}>
      <Sidebar snapshot={SNAPSHOT} onDispatch={vi.fn()} />
      <Toasts />
    </AppShellProvider>,
  );

  return {
    look: (sequence: number, diagnostic?: string) =>
      act(() => {
        publishStatus(status(sequence, diagnostic));
      }),
    fail: (error: AppError) =>
      act(() => {
        publishError(error);
      }),
    observe: (source: string, summary?: string) =>
      act(() => {
        publishCondition({
          source,
          ...(summary === undefined ? {} : { summary }),
        });
      }),
  };
}

const toasts = () => Array.from(document.querySelectorAll(".toast"));
const said = () => toasts().map((toast) => toast.textContent ?? "");

describe("a condition about the whole application", () => {
  afterEach(cleanup);

  it("is a toast, and is not written at the foot of the Sidebar", () => {
    const { look } = mount();
    look(1, GH_MISSING);

    const toast = screen.getByRole("status");
    expect(toast).toHaveTextContent(GH_MISSING);
    expect(toast.closest(".sidebar")).toBeNull();
    expect(document.querySelector(".sidebar-status-note")).toBeNull();
  });

  it("does not pile up when look after look fails the same way", () => {
    const { look } = mount();
    look(1, GH_MISSING);
    look(2, GH_MISSING);
    look(3, GH_MISSING);
    expect(said()).toEqual([expect.stringContaining(GH_MISSING)]);
  });

  it("goes when a later look succeeds, and comes back if it fails again", () => {
    const { look } = mount();
    look(1, GH_MISSING);
    expect(toasts()).toHaveLength(1);

    // The one thing besides the person that retires a condition: the source
    // that raised it saying it no longer holds.
    look(2);
    expect(toasts()).toHaveLength(0);

    look(3, GH_MISSING);
    expect(toasts()).toHaveLength(1);
  });

  it("stays away once the person has put it away", async () => {
    const { look } = mount();
    look(1, GH_MISSING);
    await act(async () => {
      screen.getByRole("button", { name: "Dismiss" }).click();
    });
    expect(toasts()).toHaveLength(0);

    look(2, GH_MISSING);
    expect(toasts()).toHaveLength(0);
  });

  it("comes back as news once it has ended and started again", async () => {
    const { look } = mount();
    look(1, GH_MISSING);
    await act(async () => {
      screen.getByRole("button", { name: "Dismiss" }).click();
    });

    look(2);
    look(3, GH_MISSING);
    expect(toasts()).toHaveLength(1);
  });

  it("closes on Escape when the keyboard is on it", () => {
    const { look } = mount();
    look(1, GH_MISSING);
    const toast = screen.getByRole("status");
    act(() => {
      toast.focus();
      toast.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(toasts()).toHaveLength(0);
  });
});

describe("a failure and a condition at once", () => {
  afterEach(cleanup);

  const failure: AppError = {
    code: "persistence_degraded",
    summary: "DevHub could not save its state file.",
    module: "state",
    timestampMs: 1,
    runtimeVersion: "test",
    actions: ["retry"],
    detail: "state.json: permission was denied (EACCES)",
  };

  it("are two toasts, newest last", () => {
    const { look, fail } = mount();
    look(1, GH_MISSING);
    fail(failure);
    expect(said()).toEqual([
      expect.stringContaining(GH_MISSING),
      expect.stringContaining("could not save its state file"),
    ]);
  });

  it("give `Cmd+Q D` the newest of the two, and then the other", () => {
    const { look, fail } = mount();
    look(1, GH_MISSING);
    fail(failure);

    act(() => {
      menuCommand("dismiss_alert");
    });
    expect(said()).toEqual([expect.stringContaining(GH_MISSING)]);

    act(() => {
      menuCommand("dismiss_alert");
    });
    expect(toasts()).toHaveLength(0);
  });
});

/**
 * The flicker, as a test: a condition that holds and a source that keeps
 * describing it differently.
 *
 * This is what the owner saw — a sentence blinking five to ten times a second
 * on a machine after a sleep — and every part of it is ordinary. A reconcile
 * round republishes while the condition holds, and the words it publishes
 * carry the failing side's own detail, which moves: `main/terminal/tmux.ts`
 * names the subcommand and the budget it gave up after, so "did not answer
 * within 2 s" becomes "within 4 s" becomes a different subcommand entirely.
 *
 * If any of that reached the notice's identity, each publish would be a
 * different notice, the stack keys by identity, and React would take one node
 * out and put another in — at the publish rate. So the assertion is not about
 * what the toast says: it is that the *same DOM element* is still there after
 * fifty publishes, and that nothing was added or removed on the way.
 */
describe("a condition that holds while its words move", () => {
  afterEach(cleanup);

  it("is one node that never leaves, however often the sentence changes", () => {
    const { observe } = mount();
    observe("machine:ssh:build-box", "DevHub is not getting an answer.");

    const first = screen.getByRole("status");
    const churn: string[] = [];
    const watcher = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement && node.classList.contains("toast")) {
            churn.push("added");
          }
        }
        for (const node of record.removedNodes) {
          if (node instanceof HTMLElement && node.classList.contains("toast")) {
            churn.push("removed");
          }
        }
      }
    });
    watcher.observe(document.body, { childList: true, subtree: true });

    for (let round = 1; round <= 50; round += 1) {
      observe(
        "machine:ssh:build-box",
        `DevHub is not getting an answer. tmux \`list-panes\` did not answer within ${String(round)} s`,
      );
    }
    watcher.takeRecords();
    watcher.disconnect();

    expect(churn).toEqual([]);
    expect(toasts()).toHaveLength(1);
    // Element identity, not text: a node that was replaced by an identical one
    // is exactly the bug, and it reads the same to `toHaveTextContent`.
    expect(screen.getByRole("status")).toBe(first);
  });

  it("is one node for a failure whose detail moves, too", () => {
    const { fail } = mount();
    const raise = (detail: string): AppError => ({
      code: "native_unavailable",
      summary: "The native app shell is unavailable.",
      module: "terminal",
      timestampMs: 1,
      runtimeVersion: "test",
      actions: ["retry", "open_settings"],
      detail,
    });
    fail(raise("tmux `list-panes` did not answer within 1 s"));

    const first = screen.getByRole("alert");
    const churn: string[] = [];
    const watcher = new MutationObserver((records) => {
      for (const record of records) {
        if (record.addedNodes.length > 0) churn.push("added");
        if (record.removedNodes.length > 0) churn.push("removed");
      }
    });
    watcher.observe(document.body, { childList: true, subtree: true });

    for (let round = 1; round <= 50; round += 1) {
      fail(
        raise(
          `tmux \`display-message\` did not answer within ${String(round)} s`,
        ),
      );
    }
    watcher.takeRecords();
    watcher.disconnect();

    expect(churn).toEqual([]);
    expect(toasts()).toHaveLength(1);
    expect(screen.getByRole("alert")).toBe(first);
  });
});

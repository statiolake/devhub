// @vitest-environment jsdom

/**
 * The way into the Sidebar with a keyboard, and the way back out.
 *
 * Everything the Sidebar can do with a keyboard was already written — a roving
 * tree, arrows, Home/End, `:focus-visible` row controls — and none of it could
 * be reached: a workbench is a native view that never gives Tab back, and the
 * Agent pane is an xterm that swallows it. So there is one command that puts
 * the keyboard on the selected row and one key that hands it back, and these
 * are the tests that say both are true.
 */

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSnapshot } from "../../../ipc/appShell";
import type { MenuCommand } from "../../../ipc/contract";
import type { AppShellContextValue } from "../../useAppShell";
import { AppShellContext } from "../../useAppShell";
import { Sidebar } from "./Sidebar";

/** What main has asked the page to do, replayable from the test. */
let listeners: ((command: MenuCommand) => void)[] = [];
const focusSurface = vi.fn(() => Promise.resolve());

window.devhub = {
  openModal: vi.fn(() => Promise.resolve("")),
  focusSurface,
  onMenuCommand: (listener: (command: MenuCommand) => void) => {
    listeners.push(listener);
    return () => {
      listeners = listeners.filter((one) => one !== listener);
    };
  },
} as unknown as typeof window.devhub;

function send(command: MenuCommand): void {
  act(() => {
    for (const listener of [...listeners]) listener(command);
  });
}

afterEach(() => {
  cleanup();
  listeners = [];
  vi.clearAllMocks();
});

function agent(id: string, workspaceId: string, ordinal: number) {
  return {
    id,
    workspaceId,
    ordinal,
    displayName: id,
    profileId: "p",
    status: "idle",
    runtimeHealth: "healthy",
    controlState: { kind: "running" },
    unread: undefined,
    activity: undefined,
    injection: {
      queued: 0,
      waitingFor: "nothing_queued",
      lastResult: undefined,
    },
  };
}

function snapshotOn(context: AppSnapshot["selection"]["context"]): AppSnapshot {
  return {
    schemaVersion: 1,
    revision: 1,
    readiness: "ready",
    editorHost: { status: "ready" },
    layout: { kind: "unavailable" },
    selection: { context, presentation: "full" },
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
        agents: [agent("a-1", "w-1", 0)],
      },
    ],
  } as unknown as AppSnapshot;
}

const dismissIntentError = vi.fn();

function mount(snapshot: AppSnapshot) {
  const value = {
    dispatch: vi.fn(),
    openExternalUrl: vi.fn(),
    answerWorktreeClose: vi.fn(() => Promise.resolve({})),
    closeWorkspace: vi.fn(),
    reportFailure: vi.fn(),
    dismissIntentError,
    agentProfiles: { sequence: 1, availability: "available", profiles: [] },
    repositoryStatus: { sequence: 1, workspaces: [] },
  } as unknown as AppShellContextValue;
  render(
    <AppShellContext.Provider value={value}>
      <Sidebar snapshot={snapshot} onDispatch={vi.fn()} />
    </AppShellContext.Provider>,
  );
}

describe("focus_sidebar", () => {
  it("puts the keyboard on the workspace row that is selected", () => {
    mount(snapshotOn({ kind: "workspace", workspaceId: "w-1" }));
    send("focus_sidebar");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /widget workspace/ }),
    );
  });

  it("puts it on the Agent row when an Agent is what is selected", () => {
    mount(snapshotOn({ kind: "agent", agentId: "a-1" }));
    send("focus_sidebar");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /^a-1,/ }),
    );
  });

  it("lands on Scratch, which is a row outside the tree", () => {
    mount(snapshotOn({ kind: "global" }));
    send("focus_sidebar");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Scratch terminal" }),
    );
  });

  it("leaves the tree walkable from there: the arrows move the focus", () => {
    mount(snapshotOn({ kind: "workspace", workspaceId: "w-1" }));
    send("focus_sidebar");
    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: "ArrowDown",
    });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /^a-1,/ }),
    );
  });
});

describe("Escape in the Sidebar", () => {
  it("asks main to hand the keyboard back, from a row", () => {
    mount(snapshotOn({ kind: "workspace", workspaceId: "w-1" }));
    send("focus_sidebar");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    expect(focusSurface).toHaveBeenCalledTimes(1);
  });

  it("does it from anywhere in the pane, the resize handle included", () => {
    mount(snapshotOn({ kind: "global" }));
    fireEvent.keyDown(
      screen.getByRole("separator", { name: "Resize sidebar" }),
      {
        key: "Escape",
      },
    );
    expect(focusSurface).toHaveBeenCalledTimes(1);
  });

  it("does not do it while a composition is being cancelled", () => {
    mount(snapshotOn({ kind: "global" }));
    fireEvent.keyDown(
      screen.getByRole("button", { name: "Scratch terminal" }),
      {
        key: "Escape",
        isComposing: true,
      },
    );
    expect(focusSurface).not.toHaveBeenCalled();
  });
});

describe("dismiss_alert", () => {
  it("retires the failure the page is showing", () => {
    mount(snapshotOn({ kind: "global" }));
    send("dismiss_alert");
    expect(dismissIntentError).toHaveBeenCalledTimes(1);
  });
});

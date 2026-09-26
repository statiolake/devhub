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
import type { SidebarValue } from "../../sidebar/SidebarContext";
import { SidebarContext } from "../../sidebar/SidebarContext";
import { Sidebar } from "./Sidebar";
import { ON_SCRATCH, SCRATCH_ID, scratchWorkspace } from "./scratchFixture";

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
  // The Sidebar asks main for its tooltips now rather than drawing them
  // (`RowTooltip.tsx`), so every render of it reaches these three.
  onSidebarArea: () => () => undefined,
  showTooltip: () => undefined,
  hideTooltip: () => undefined,
  releaseTooltip: () => undefined,
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
    scratchWorkspaceId: SCRATCH_ID,
    workspaces: [
      scratchWorkspace(),
      {
        id: "w-1",
        label: "widget",
        location: { kind: "local" },
        editor: { kind: "host" },
        root: "/projects/widget",
        displayRoot: "/projects/widget",
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

const retry = vi.fn();

function mount(snapshot: AppSnapshot) {
  const value = {
    dispatch: vi.fn().mockResolvedValue(undefined),
    openExternalUrl: vi.fn(),
    answerWorktreeClose: vi.fn(() => Promise.resolve({})),
    closeWorkspace: vi.fn(),
    reportFailure: vi.fn(),
    retry,
    agentProfiles: { sequence: 1, availability: "available", profiles: [] },
    usageLimits: { clis: [] },
    repositoryStatus: { sequence: 1, workspaces: [] },
  } as unknown as SidebarValue;
  render(
    <SidebarContext.Provider value={value}>
      <Sidebar snapshot={snapshot} />
    </SidebarContext.Provider>,
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
      screen.getByRole("button", { name: /^a-1/ }),
    );
  });

  it("lands on Scratch, the tree's first row, when Scratch is selected", () => {
    mount(snapshotOn(ON_SCRATCH));
    send("focus_sidebar");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /^Scratch workspace/ }),
    );
  });

  it("leaves the tree walkable from there: the arrows move the focus", () => {
    mount(snapshotOn({ kind: "workspace", workspaceId: "w-1" }));
    send("focus_sidebar");
    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: "ArrowDown",
    });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /^a-1/ }),
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
    mount(snapshotOn(ON_SCRATCH));
    fireEvent.keyDown(
      screen.getByRole("separator", { name: "Resize sidebar" }),
      {
        key: "Escape",
      },
    );
    expect(focusSurface).toHaveBeenCalledTimes(1);
  });

  it("does not do it while a composition is being cancelled", () => {
    mount(snapshotOn(ON_SCRATCH));
    fireEvent.keyDown(
      screen.getByRole("button", { name: /^Scratch workspace/ }),
      {
        key: "Escape",
        isComposing: true,
      },
    );
    expect(focusSurface).not.toHaveBeenCalled();
  });
});

/**
 * The two ends of one button, in two pages.
 *
 * "Try Again" is drawn on the `toasts` view and what it restarts is this
 * page's projection, so main is what joins them. `dismiss_alert` is not here
 * any more, for the same reason in the other direction: the page that has the
 * notice is the page that can retire it.
 */
describe("retry_app", () => {
  it("starts this page's projection over", () => {
    mount(snapshotOn(ON_SCRATCH));
    send("retry_app");
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("does not answer for a notice it cannot see", () => {
    mount(snapshotOn(ON_SCRATCH));
    send("dismiss_alert");
    expect(retry).not.toHaveBeenCalled();
  });
});

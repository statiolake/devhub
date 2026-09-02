// @vitest-environment jsdom

/**
 * A Workspace that is on its way out, as the Sidebar draws it.
 *
 * `closing` is a state the model refuses operations in, so the row's job is to
 * stop offering them — before somebody clicks one and is told no. These tests
 * are about that: what a closing row will not let you do, and how it leaves.
 */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSnapshot } from "../../../ipc/appShell";
import type { RepositoryStatusWire } from "../../client";
import type { AppShellContextValue } from "../../useAppShell";
import { AppShellContext } from "../../useAppShell";
import { Sidebar } from "./Sidebar";
import { CLOSING_EXIT_MS, mergeExitingRows, rowsThatLeft } from "./closingExit";

window.devhub = {
  openModal: vi.fn(() => Promise.resolve("")),
  onMenuCommand: () => () => undefined,
} as unknown as typeof window.devhub;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function workspace(state: string) {
  return {
    id: "w-1",
    label: "widget",
    root: "/projects/widget",
    selectedPath: "/projects/widget",
    state,
    // The model says a closing Workspace cannot take a new Agent. The row is
    // given the truthful projection so the test exercises the real pairing.
    canCreateAgent: state === "available",
    agents: [],
  };
}

function snapshotWith(state: string): AppSnapshot {
  return {
    schemaVersion: 1,
    revision: 1,
    readiness: "ready",
    editorHost: { status: "ready" },
    layout: { kind: "unavailable" },
    selection: { context: { kind: "global" }, presentation: "full" },
    sidebar: { width: 248 },
    splitRatio: 0.55,
    workspaces: [workspace(state)],
  } as unknown as AppSnapshot;
}

const EMPTY: AppSnapshot = {
  schemaVersion: 1,
  revision: 2,
  readiness: "ready",
  editorHost: { status: "ready" },
  layout: { kind: "unavailable" },
  selection: { context: { kind: "global" }, presentation: "full" },
  sidebar: { width: 248 },
  splitRatio: 0.55,
  workspaces: [],
} as unknown as AppSnapshot;

// A worktree, so the row offers the destructive control that a closing row
// most needs to withdraw.
const WORKTREE: RepositoryStatusWire = {
  sequence: 1,
  workspaces: [
    {
      workspaceId: "w-1",
      mainWorktree: "/projects/widget-main",
      worktree: "/projects/widget",
    },
  ],
} as unknown as RepositoryStatusWire;

function mount(snapshot: AppSnapshot) {
  const value = {
    dispatch: vi.fn(),
    openExternalUrl: vi.fn(),
    removeWorktree: vi.fn(() => Promise.resolve({})),
    reportFailure: vi.fn(),
    agentProfiles: { sequence: 1, availability: "available", profiles: [] },
    repositoryStatus: WORKTREE,
  } as unknown as AppShellContextValue;
  const view = render(
    <AppShellContext.Provider value={value}>
      <Sidebar snapshot={snapshot} onDispatch={vi.fn()} />
    </AppShellContext.Provider>,
  );
  const rerender = (next: AppSnapshot) => {
    view.rerender(
      <AppShellContext.Provider value={value}>
        <Sidebar snapshot={next} onDispatch={vi.fn()} />
      </AppShellContext.Provider>,
    );
  };
  return { rerender };
}

describe("a closing workspace row", () => {
  it("is not selectable", () => {
    mount(snapshotWith("closing"));
    expect(
      screen.getByRole("button", { name: /widget workspace/ }),
    ).toBeDisabled();
  });

  it("offers no close, no remove and no new agent", () => {
    mount(snapshotWith("closing"));
    expect(screen.queryByRole("button", { name: /^Close/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^Remove the worktree/ }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /^Create agent/ })).toBeNull();
  });

  it("still offers all of them while it is merely open", () => {
    // The negatives above are only worth anything if the controls are there to
    // be withdrawn in the first place.
    mount(snapshotWith("available"));
    expect(screen.getByRole("button", { name: /^Close/ })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Remove the worktree/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Create agent/ }),
    ).toBeInTheDocument();
  });

  it("says it is busy, and is not italic about it", () => {
    mount(snapshotWith("closing"));
    const item = document.querySelector(".sidebar-tree-item");
    expect(item).toHaveAttribute("aria-busy", "true");
    expect(item).toHaveClass("is-closing");
  });
});

describe("the row's exit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a closed row on screen while it fades, then drops it", () => {
    const { rerender } = mount(snapshotWith("closing"));
    act(() => {
      rerender(EMPTY);
    });
    // The Workspace is gone from the snapshot; the ghost is what is left.
    const ghost = document.querySelector(".sidebar-tree-item.is-exiting");
    expect(ghost).not.toBeNull();
    expect(ghost).toHaveTextContent("widget");
    // Not a tree item: it answers nothing, so nothing should land on it.
    expect(ghost).toHaveAttribute("aria-hidden", "true");
    // The empty state does not appear underneath it.
    expect(screen.queryByText("No workspaces open")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(CLOSING_EXIT_MS);
    });
    expect(document.querySelector(".is-exiting")).toBeNull();
    expect(screen.getByText("No workspaces open")).toBeInTheDocument();
  });

  it("does not haunt a row that left without closing", () => {
    // Anything other than a close — a restore, a snapshot replaced wholesale —
    // must not play an exit animation for every row it drops.
    const { rerender } = mount(snapshotWith("available"));
    act(() => {
      rerender(EMPTY);
    });
    expect(document.querySelector(".is-exiting")).toBeNull();
  });

  it("survives a further snapshot arriving mid-fade", () => {
    // The regression this is here for: the removal timer used to be cancelled
    // by the next snapshot, and since that snapshot had nothing new leaving,
    // no replacement was scheduled and the ghost stayed for good.
    const { rerender } = mount(snapshotWith("closing"));
    act(() => {
      rerender(EMPTY);
    });
    act(() => {
      rerender({ ...EMPTY, revision: 3 } as AppSnapshot);
    });
    act(() => {
      vi.advanceTimersByTime(CLOSING_EXIT_MS);
    });
    expect(document.querySelector(".is-exiting")).toBeNull();
  });
});

describe("where a ghost stands", () => {
  it("goes back into the place it held", () => {
    const rows = mergeExitingRows([{ id: "a" }, { id: "c" }] as never, [
      { id: "b", label: "b", index: 1 },
    ]);
    expect(
      rows.map((entry) =>
        entry.kind === "exiting" ? entry.row.id : entry.workspace.id,
      ),
    ).toEqual(["a", "b", "c"]);
  });

  it("lands at the end when the list it left has shrunk past it", () => {
    const rows = mergeExitingRows([], [{ id: "b", label: "b", index: 4 }]);
    expect(rows).toHaveLength(1);
  });

  it("counts only the rows that were closing", () => {
    const left = rowsThatLeft(
      [
        { id: "a", label: "a", closing: true },
        { id: "b", label: "b", closing: false },
      ],
      [],
    );
    expect(left.map((row) => row.id)).toEqual(["a"]);
  });
});

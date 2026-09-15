// @vitest-environment jsdom

/**
 * Dragging a row somewhere else in the Sidebar.
 *
 * The rule about *where* a row may go is `model/workspaceOrder.ts`'s and is
 * tested there, exhaustively, with no DOM in the way. These are the tests for
 * the part that is only true on screen: that the pointer's half of a row means
 * the gap a person would say it means, that the line is drawn in that gap and
 * nowhere else, that the rows out of range say they are out of range, and that
 * letting go raises the intent the model reads — once, and not at all when
 * nothing moved.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppIntent, AppSnapshot } from "../../../ipc/appShell";
import type { SidebarValue } from "../../sidebar/SidebarContext";
import { SidebarContext } from "../../sidebar/SidebarContext";
import { Sidebar } from "./Sidebar";

window.devhub = {
  openModal: vi.fn(() => Promise.resolve("")),
  focusSurface: vi.fn(() => Promise.resolve()),
  onMenuCommand: () => () => undefined,
} as unknown as typeof window.devhub;

/** Every row is twenty pixels tall, so 5 is its top half and 15 its bottom. */
const ROW_HEIGHT = 20;

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    top: 0,
    bottom: ROW_HEIGHT,
    height: ROW_HEIGHT,
    left: 0,
    right: 100,
    width: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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

function workspace(
  id: string,
  label: string,
  groupKey: string,
  agents: ReturnType<typeof agent>[] = [],
) {
  return {
    id,
    label,
    location: { kind: "local" },
    root: `/projects/${label}`,
    key: `/projects/${label}`,
    groupKey,
    selectedPath: `/projects/${label}`,
    state: { kind: "available" },
    close: { kind: "idle" },
    canCreateAgent: true,
    agents,
  };
}

/**
 * `alpha` with two Agents, `widget` with two worktrees under it, then `zebra`.
 *
 * Three groups, one of them of three, which is enough shape for every rule: a
 * repository that moves with its worktrees, two worktrees to move against each
 * other inside it, two plain folders for the group to move past, and two Agents
 * for the level below.
 */
function snapshot(): AppSnapshot {
  return {
    schemaVersion: 1,
    revision: 1,
    readiness: "ready",
    editorHost: { status: "ready" },
    layout: { kind: "unavailable" },
    selection: { context: { kind: "global" }, presentation: "full" },
    sidebar: { width: 248 },
    splitRatio: 0.55,
    workspaces: [
      workspace("w-alpha", "alpha", "/projects/alpha", [
        agent("a-1", "w-alpha", 0),
        agent("a-2", "w-alpha", 1),
      ]),
      workspace("w-widget", "widget", "/projects/widget"),
      workspace("w-wt-a", "widget_a", "/projects/widget"),
      workspace("w-wt-b", "widget_b", "/projects/widget"),
      workspace("w-zebra", "zebra", "/projects/zebra"),
    ],
  } as unknown as AppSnapshot;
}

function mount(onDispatch: (intent: AppIntent) => void) {
  const value = {
    dispatch: vi.fn(),
    openExternalUrl: vi.fn(),
    answerWorktreeClose: vi.fn(() => Promise.resolve({})),
    closeWorkspace: vi.fn(),
    reportFailure: vi.fn(),
    dismissNewestNotice: vi.fn(),
    agentProfiles: { sequence: 1, availability: "available", profiles: [] },
    repositoryStatus: { sequence: 1, workspaces: [] },
  } as unknown as SidebarValue;
  render(
    <SidebarContext.Provider value={value}>
      <Sidebar snapshot={snapshot()} onDispatch={onDispatch} />
    </SidebarContext.Provider>,
  );
}

/** The `treeitem` a row's own button sits in — the element that is dragged. */
function row(name: RegExp): HTMLElement {
  const button = screen.getByRole("button", { name });
  const item = button.closest<HTMLElement>("[role=treeitem]");
  if (!item) throw new Error("row has no tree item");
  return item;
}

const WIDGET = /widget workspace/;
const WT_A = /widget_a workspace/;
const WT_B = /widget_b workspace/;
const ALPHA = /alpha workspace/;
const ZEBRA = /zebra workspace/;

/** `dataTransfer` as jsdom does not supply it; the payload is never read. */
const transfer = () => ({
  setData: vi.fn(),
  effectAllowed: "",
  dropEffect: "",
});

/**
 * `dragover` at a point in the row.
 *
 * Built by hand rather than through `fireEvent.dragOver`: jsdom has no
 * `DragEvent`, so the coordinates a synthetic one is given never reach the
 * handler — and the coordinate is the whole of what this test is about.
 */
function dragOver(target: HTMLElement, half: "top" | "bottom") {
  fireEvent(
    target,
    new MouseEvent("dragover", {
      bubbles: true,
      cancelable: true,
      clientY: half === "top" ? 5 : 15,
    }),
  );
}

describe("picking a row up", () => {
  it("dims the rows it may not land among, and lights the ones it may", () => {
    mount(vi.fn());
    fireEvent.dragStart(row(WT_A), { dataTransfer: transfer() });

    // A worktree moves among the other worktrees of its own repository and
    // nowhere else — the repository included, because there is no gap in front
    // of it a worktree may occupy.
    expect(row(WT_A)).toHaveAttribute("data-reorder-target", "true");
    expect(row(WT_B)).toHaveAttribute("data-reorder-target", "true");
    expect(row(WIDGET)).toHaveAttribute("data-reorder-target", "false");
    expect(row(ALPHA)).toHaveAttribute("data-reorder-target", "false");
    expect(row(ZEBRA)).toHaveAttribute("data-reorder-target", "false");
  });

  it("says which row is in the air, and the pane says a drag is on", () => {
    mount(vi.fn());
    fireEvent.dragStart(row(ZEBRA), { dataTransfer: transfer() });
    expect(row(ZEBRA)).toHaveAttribute("data-dragging", "true");
    expect(row(ALPHA)).not.toHaveAttribute("data-dragging");
    expect(
      screen.getByRole("complementary", { name: "Workspace navigation" }),
    ).toHaveAttribute("data-reordering", "true");
  });

  it("lets a repository move among the other repositories", () => {
    mount(vi.fn());
    fireEvent.dragStart(row(WIDGET), { dataTransfer: transfer() });
    // The group heads, and its own worktree is not one of them: it travels
    // with the repository rather than being somewhere to put it.
    expect(row(ALPHA)).toHaveAttribute("data-reorder-target", "true");
    expect(row(ZEBRA)).toHaveAttribute("data-reorder-target", "true");
    expect(row(WT_A)).toHaveAttribute("data-reorder-target", "false");
  });

  it("says nothing about range when nothing is being dragged", () => {
    mount(vi.fn());
    expect(row(ALPHA)).not.toHaveAttribute("data-reorder-target");
    expect(
      screen.getByRole("complementary", { name: "Workspace navigation" }),
    ).not.toHaveAttribute("data-reordering");
  });
});

describe("the line that says where it will land", () => {
  it("is above the row when the pointer is in its top half", () => {
    mount(vi.fn());
    fireEvent.dragStart(row(ZEBRA), { dataTransfer: transfer() });
    dragOver(row(ALPHA), "top");
    expect(row(ALPHA)).toHaveAttribute("data-drop-before", "true");
    expect(row(ALPHA)).not.toHaveAttribute("data-drop-after");
  });

  it("moves to the next gap when the pointer crosses into the bottom half", () => {
    mount(vi.fn());
    fireEvent.dragStart(row(ZEBRA), { dataTransfer: transfer() });
    dragOver(row(ALPHA), "bottom");
    // The gap behind `alpha` is the gap in front of the group after it.
    expect(row(WIDGET)).toHaveAttribute("data-drop-before", "true");
    expect(row(ALPHA)).not.toHaveAttribute("data-drop-before");
  });

  it("is drawn below the last row for the one gap no row can name", () => {
    mount(vi.fn());
    fireEvent.dragStart(row(ALPHA), { dataTransfer: transfer() });
    dragOver(row(ZEBRA), "bottom");
    expect(row(ZEBRA)).toHaveAttribute("data-drop-after", "true");
  });

  it("is nowhere while the pointer is over a row out of range", () => {
    mount(vi.fn());
    fireEvent.dragStart(row(WT_A), { dataTransfer: transfer() });
    dragOver(row(ALPHA), "top");
    expect(row(ALPHA)).not.toHaveAttribute("data-drop-before");
    expect(row(WIDGET)).not.toHaveAttribute("data-drop-before");
  });

  it("goes away when the row is put down", () => {
    mount(vi.fn());
    fireEvent.dragStart(row(ZEBRA), { dataTransfer: transfer() });
    dragOver(row(ALPHA), "top");
    fireEvent.dragEnd(row(ZEBRA));
    expect(row(ALPHA)).not.toHaveAttribute("data-drop-before");
    expect(
      screen.getByRole("complementary", { name: "Workspace navigation" }),
    ).not.toHaveAttribute("data-reordering");
  });
});

describe("letting go", () => {
  it("asks for the whole order the drop comes to", () => {
    const onDispatch = vi.fn();
    mount(onDispatch);
    fireEvent.dragStart(row(ZEBRA), { dataTransfer: transfer() });
    dragOver(row(ALPHA), "top");
    fireEvent.drop(row(ALPHA), { dataTransfer: transfer() });

    expect(onDispatch).toHaveBeenCalledTimes(1);
    expect(onDispatch).toHaveBeenCalledWith({
      type: "reorder_workspaces",
      // The whole list, and the repository's worktree still behind it.
      order: ["w-zebra", "w-alpha", "w-widget", "w-wt-a", "w-wt-b"],
    });
  });

  it("moves a worktree within its group and takes nothing else with it", () => {
    const onDispatch = vi.fn();
    mount(onDispatch);
    fireEvent.dragStart(row(WT_B), { dataTransfer: transfer() });
    dragOver(row(WT_A), "top");
    fireEvent.drop(row(WT_A), { dataTransfer: transfer() });

    expect(onDispatch).toHaveBeenCalledWith({
      type: "reorder_workspaces",
      // The two worktrees swapped, the repository still at the head of them,
      // and the groups either side exactly where they were.
      order: ["w-alpha", "w-widget", "w-wt-b", "w-wt-a", "w-zebra"],
    });
  });

  it("asks for nothing when the row is let go where it already was", () => {
    const onDispatch = vi.fn();
    mount(onDispatch);
    fireEvent.dragStart(row(WT_A), { dataTransfer: transfer() });
    dragOver(row(WT_A), "top");
    fireEvent.drop(row(WT_A), { dataTransfer: transfer() });
    expect(onDispatch).not.toHaveBeenCalled();
  });

  it("moves an Agent within its own workspace", () => {
    const onDispatch = vi.fn();
    mount(onDispatch);
    const second = row(/^a-2,/);
    fireEvent.dragStart(second, { dataTransfer: transfer() });
    dragOver(row(/^a-1,/), "top");
    fireEvent.drop(row(/^a-1,/), { dataTransfer: transfer() });

    expect(onDispatch).toHaveBeenCalledWith({
      type: "reorder_agents",
      workspaceId: "w-alpha",
      order: ["a-2", "a-1"],
    });
  });

  it("keeps an Agent out of another workspace's list", () => {
    mount(vi.fn());
    fireEvent.dragStart(row(/^a-1,/), { dataTransfer: transfer() });
    expect(row(ZEBRA)).toHaveAttribute("data-reorder-target", "false");
    expect(row(/^a-2,/)).toHaveAttribute("data-reorder-target", "true");
  });

  it("asks for nothing when the row is let go outside the range", () => {
    const onDispatch = vi.fn();
    mount(onDispatch);
    fireEvent.dragStart(row(WT_A), { dataTransfer: transfer() });
    dragOver(row(ZEBRA), "top");
    fireEvent.drop(row(ZEBRA), { dataTransfer: transfer() });
    expect(onDispatch).not.toHaveBeenCalled();
  });
});

describe("what does not move", () => {
  it("leaves Scratch out of it: it is the first row by definition", () => {
    mount(vi.fn());
    const scratch = screen.getByRole("button", { name: "Scratch terminal" });
    expect(scratch.closest("[draggable]")).toBeNull();
  });
});

/**
 * `Cmd+Q S` and then Option and an arrow.
 *
 * The chord `Cmd+Q Alt+↑` does the same thing from anywhere, and this is the
 * version that needs no prefix once the keyboard is already in the tree — so
 * arranging a whole list is one arming and then arrows. It raises the same
 * intent, computed by the same rule, which is why a step the pointer could not
 * have made is a step this cannot make either.
 */
describe("moving a row with the keyboard", () => {
  function focus(name: RegExp): HTMLElement {
    const button = screen.getByRole("button", { name });
    button.focus();
    return button;
  }

  const arrow = (on: HTMLElement, key: "ArrowUp" | "ArrowDown") =>
    fireEvent.keyDown(on, { key, altKey: true });

  it("moves a repository past the group below it, worktrees and all", () => {
    const onDispatch = vi.fn();
    mount(onDispatch);
    arrow(focus(WIDGET), "ArrowDown");
    expect(onDispatch).toHaveBeenCalledWith({
      type: "reorder_workspaces",
      order: ["w-alpha", "w-zebra", "w-widget", "w-wt-a", "w-wt-b"],
    });
  });

  it("moves an Agent within its own workspace", () => {
    const onDispatch = vi.fn();
    mount(onDispatch);
    arrow(focus(/^a-1,/), "ArrowDown");
    expect(onDispatch).toHaveBeenCalledWith({
      type: "reorder_agents",
      workspaceId: "w-alpha",
      order: ["a-2", "a-1"],
    });
  });

  it("will not lift a worktree over its own repository", () => {
    const onDispatch = vi.fn();
    mount(onDispatch);
    arrow(focus(WT_A), "ArrowUp");
    expect(onDispatch).not.toHaveBeenCalled();
  });

  it("is a no-op at the ends, and moves the focus nowhere doing it", () => {
    const onDispatch = vi.fn();
    mount(onDispatch);
    const top = focus(ALPHA);
    arrow(top, "ArrowUp");
    expect(onDispatch).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(top);
  });

  it("leaves the plain arrows walking the tree", () => {
    const onDispatch = vi.fn();
    mount(onDispatch);
    fireEvent.keyDown(focus(ALPHA), { key: "ArrowDown" });
    expect(onDispatch).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /^a-1,/ }),
    );
  });
});

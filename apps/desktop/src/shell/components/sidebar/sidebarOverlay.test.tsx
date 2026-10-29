// @vitest-environment jsdom

/**
 * Compact mode's floating Sidebar: a browser's vertical tab bar.
 *
 * While the pointer is on the rail the expanded Sidebar floats over the
 * content — the same rows, drawn expanded — and goes when the pointer leaves,
 * after a grace. What is pinned here is the page's half: *when* it floats, and
 * that it says so to main (`previewLayout({ sidebarOverlay })`), which owns
 * where the view goes (`windowLayout.test.ts`).
 */

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSnapshot } from "../../../ipc/appShell";
import type { LayoutPreviewWire } from "../../../ipc/contract";
import type { SidebarValue } from "../../sidebar/SidebarContext";
import { SidebarContext } from "../../sidebar/SidebarContext";
import { Sidebar } from "./Sidebar";
import { SCRATCH_ID, scratchWorkspace } from "./scratchFixture";
import { CLOSE_GRACE_MS, LAND_MS } from "./useSidebarOverlay";

let previews: LayoutPreviewWire[] = [];
let tooltips: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  previews = [];
  tooltips = [];
  window.devhub = {
    openModal: vi.fn(() => Promise.resolve("")),
    focusSurface: vi.fn(() => Promise.resolve()),
    previewLayout: (preview: LayoutPreviewWire) => {
      previews.push(preview);
      return Promise.resolve();
    },
    onMenuCommand: () => () => undefined,
    onSidebarArea: () => () => undefined,
    onChordArmed: () => () => undefined,
    showTooltip: () => tooltips.push("show"),
    hideTooltip: () => tooltips.push("hide"),
    releaseTooltip: () => tooltips.push("release"),
  } as unknown as typeof window.devhub;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete window.devhub;
});

function snapshot(collapsed: boolean): AppSnapshot {
  return {
    schemaVersion: 1,
    revision: 1,
    readiness: "ready",
    editorHost: { status: "ready" },
    layout: { kind: "unavailable" },
    selection: {
      context: { kind: "workspace", workspaceId: "w-1" },
      presentation: "full",
    },
    sidebar: { width: 248, collapsed },
    splitRatio: 0.55,
    smartButtons: {},
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
        agents: [],
      },
    ],
  } as unknown as AppSnapshot;
}

const value = {
  dispatch: vi.fn().mockResolvedValue(undefined),
  openExternalUrl: vi.fn(),
  answerWorktreeClose: vi.fn(() => Promise.resolve({})),
  closeWorkspace: vi.fn(),
  reportFailure: vi.fn(),
  dismissIntentError: vi.fn(),
  agentProfiles: { sequence: 1, availability: "available", profiles: [] },
  usageLimits: { clis: [] },
  repositoryStatus: { sequence: 1, workspaces: [] },
} as unknown as SidebarValue;

function mount(collapsed: boolean) {
  const view = render(
    <SidebarContext.Provider value={value}>
      <Sidebar snapshot={snapshot(collapsed)} />
    </SidebarContext.Provider>,
  );
  const pane = () =>
    screen.getByRole("complementary", { name: "Workspace navigation" });
  const setCollapsed = (next: boolean) => {
    view.rerender(
      <SidebarContext.Provider value={value}>
        <Sidebar snapshot={snapshot(next)} />
      </SidebarContext.Provider>,
    );
  };
  return { pane, setCollapsed };
}

/**
 * A pointer move at a place. jsdom's `PointerEvent` drops the coordinates, so
 * it is a `MouseEvent` named `pointermove` — the name is what React listens
 * for, and the coordinates are what this file is about.
 */
function move(pane: HTMLElement, x: number, y: number) {
  fireEvent(
    pane,
    new MouseEvent("pointermove", { bubbles: true, clientX: x, clientY: y }),
  );
}

/** The pointer arrives on the pane and moves on it. */
function point(pane: HTMLElement, x = 20, y = 100) {
  fireEvent.pointerEnter(pane);
  move(pane, x, y);
}

function leave(pane: HTMLElement) {
  fireEvent.pointerLeave(pane);
}

function wait(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

const overlays = () =>
  previews
    .filter((preview) => preview.sidebarOverlay !== undefined)
    .map((preview) => preview.sidebarOverlay);

describe("the floating Sidebar", () => {
  it("floats the expanded Sidebar the moment the pointer moves on the rail", () => {
    const { pane } = mount(true);
    expect(pane()).toHaveAttribute("data-collapsed", "true");
    point(pane());
    expect(pane()).toHaveAttribute("data-overlay", "open");
    // Drawn expanded: the rows are the docked column's.
    expect(pane()).not.toHaveAttribute("data-collapsed");
    expect(overlays()).toEqual([true]);
  });

  it("never floats over the docked column", () => {
    const { pane } = mount(false);
    point(pane());
    expect(pane()).not.toHaveAttribute("data-overlay");
    expect(overlays()).toEqual([]);
  });

  it("goes after the grace once the pointer has left", () => {
    const { pane } = mount(true);
    point(pane());
    leave(pane());
    wait(CLOSE_GRACE_MS - 1);
    expect(pane()).toHaveAttribute("data-overlay", "open");
    wait(1);
    expect(pane()).not.toHaveAttribute("data-overlay");
    expect(pane()).toHaveAttribute("data-collapsed", "true");
    expect(overlays()).toEqual([true, false]);
  });

  it("stays, without flickering, for a pointer that comes back inside the grace", () => {
    const { pane } = mount(true);
    point(pane());
    leave(pane());
    wait(CLOSE_GRACE_MS / 2);
    point(pane(), 30, 120);
    wait(CLOSE_GRACE_MS * 2);
    expect(pane()).toHaveAttribute("data-overlay", "open");
    expect(overlays()).toEqual([true]);
  });

  it("is held by focus the keyboard put in it", () => {
    const { pane } = mount(true);
    point(pane());
    const row = screen.getByRole("button", { name: /widget workspace/ });
    fireEvent.keyDown(row, { key: "ArrowDown" });
    act(() => {
      row.focus();
    });
    leave(pane());
    wait(CLOSE_GRACE_MS * 3);
    expect(pane()).toHaveAttribute("data-overlay", "open");
  });

  it("closes on Escape and stays closed until the pointer has left", () => {
    const { pane } = mount(true);
    point(pane());
    fireEvent.keyDown(pane(), { key: "Escape" });
    expect(pane()).not.toHaveAttribute("data-overlay");
    point(pane(), 25, 110);
    expect(pane()).not.toHaveAttribute("data-overlay");
    leave(pane());
    point(pane(), 25, 140);
    expect(pane()).toHaveAttribute("data-overlay", "open");
  });

  it("folds away after a row is chosen, the way a tab bar does", () => {
    const { pane } = mount(true);
    point(pane());
    fireEvent.click(screen.getByRole("button", { name: /^Scratch workspace/ }));
    expect(pane()).not.toHaveAttribute("data-overlay");
    expect(overlays()).toEqual([true, false]);
  });

  it("closes at once on a press outside the card", () => {
    const { pane } = mount(true);
    point(pane());
    fireEvent.pointerDown(document.body);
    expect(pane()).not.toHaveAttribute("data-overlay");
  });

  it("is held while a row is dragged", () => {
    const { pane } = mount(true);
    point(pane());
    const row = screen
      .getByRole("button", { name: /widget workspace/ })
      .closest<HTMLElement>("[draggable=true]");
    if (!row) throw new Error("the row is not draggable");
    fireEvent.dragStart(row);
    leave(pane());
    wait(CLOSE_GRACE_MS * 3);
    expect(pane()).toHaveAttribute("data-overlay", "open");
    // Let go outside the card: it goes, after the grace.
    fireEvent.dragOver(document.body);
    fireEvent.dragEnd(row);
    wait(CLOSE_GRACE_MS);
    expect(pane()).not.toHaveAttribute("data-overlay");
  });

  /**
   * Compact mode turned on with the pointer on what is now the rail. The
   * pointer did not ask for anything, and Chromium sends a move for a page
   * laid out under a resting pointer at the same place.
   */
  it("does not float under a pointer compact mode was turned on beneath", () => {
    const { pane, setCollapsed } = mount(false);
    move(pane(), 30, 200);
    setCollapsed(true);
    move(pane(), 30, 200);
    expect(pane()).not.toHaveAttribute("data-overlay");
    move(pane(), 31, 200);
    expect(pane()).toHaveAttribute("data-overlay", "open");
  });

  /**
   * Compact mode turned off under the card: it lands. Docked at once — the
   * model's width, drawn expanded — while main still keeps the view as wide
   * as the card, and only after the landing does the view become a column.
   */
  it("lands in place when compact mode is turned off under it", () => {
    const { pane, setCollapsed } = mount(true);
    point(pane());
    setCollapsed(false);
    expect(pane()).toHaveAttribute("data-overlay", "landing");
    expect(pane()).not.toHaveAttribute("data-collapsed");
    expect(pane().style.getPropertyValue("--sidebar-width")).toBe("248px");
    expect(overlays()).toEqual([true]);
    wait(LAND_MS);
    expect(pane()).not.toHaveAttribute("data-overlay");
    expect(overlays()).toEqual([true, false]);
    // The docked column, resize handle and all.
    expect(screen.getByRole("separator")).toBeInTheDocument();
  });

  it("takes down whatever tooltip was up as it opens and closes", () => {
    const { pane } = mount(true);
    point(pane());
    expect(tooltips).toContain("hide");
  });
});

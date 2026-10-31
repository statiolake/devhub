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

import { readFileSync } from "node:fs";
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
import type {
  LayoutPreviewWire,
  SidebarPointerWire,
} from "../../../ipc/contract";
import type { SidebarValue } from "../../sidebar/SidebarContext";
import { SidebarContext } from "../../sidebar/SidebarContext";
import { Sidebar } from "./Sidebar";
import { SCRATCH_ID, scratchWorkspace } from "./scratchFixture";
import { CLOSE_GRACE_MS, CLOSE_MS, LAND_MS } from "./useSidebarOverlay";
import { chromeVariables } from "../../../main/shell/windowLayout";

let previews: LayoutPreviewWire[] = [];
let tooltips: string[] = [];
/** What main says about the cursor when the page asks (`sidebarPointer`). */
let cursor: SidebarPointerWire = { inside: false, active: true };
let asked = 0;

beforeEach(() => {
  vi.useFakeTimers();
  previews = [];
  tooltips = [];
  cursor = { inside: false, active: true };
  asked = 0;
  window.devhub = {
    sidebarPointer: () => {
      asked += 1;
      return Promise.resolve(cursor);
    },
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

/** Time passes, and main's answers arrive. */
async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const overlays = () =>
  previews
    .filter((preview) => preview.sidebarOverlay !== undefined)
    .map((preview) => preview.sidebarOverlay);

describe("the floating Sidebar", () => {
  /**
   * The rail grows into the docked column: drawn as the docked column, which
   * is the rail's arrangement with more of it shown (`tokens.css`), so no row
   * moves as it grows and it lands as what it already is.
   */
  it("grows the rail into the docked column the moment the pointer moves on it", () => {
    const { pane } = mount(true);
    expect(pane()).toHaveAttribute("data-collapsed", "true");
    point(pane());
    expect(pane()).toHaveAttribute("data-overlay", "open");
    expect(pane()).not.toHaveAttribute("data-collapsed");
    // The docked column's own controls are there, as docked.
    expect(
      screen.getByRole("button", { name: "Open workspace picker" }),
    ).toBeInTheDocument();
    expect(overlays()).toEqual([true]);
  });

  it("never floats over the docked column", () => {
    const { pane } = mount(false);
    point(pane());
    expect(pane()).not.toHaveAttribute("data-overlay");
    expect(overlays()).toEqual([]);
  });

  it("asks main after the grace, and retracts once the cursor is off it", async () => {
    const { pane } = mount(true);
    point(pane());
    leave(pane());
    await wait(CLOSE_GRACE_MS - 1);
    expect(asked).toBe(0);
    expect(pane()).toHaveAttribute("data-overlay", "open");
    await wait(1);
    expect(asked).toBe(1);
    expect(pane()).toHaveAttribute("data-overlay", "closing");
    // The view is the card's until it has retracted.
    expect(overlays()).toEqual([true]);
    await wait(CLOSE_MS);
    expect(pane()).not.toHaveAttribute("data-overlay");
    expect(overlays()).toEqual([true, false]);
  });

  it("stays, without flickering, for a pointer that comes back inside the grace", async () => {
    const { pane } = mount(true);
    point(pane());
    leave(pane());
    await wait(CLOSE_GRACE_MS / 2);
    point(pane(), 30, 120);
    await wait(CLOSE_GRACE_MS * 3);
    expect(pane()).toHaveAttribute("data-overlay", "open");
    expect(asked).toBe(0);
    expect(overlays()).toEqual([true]);
  });

  it("comes back out for a pointer that returns while it retracts", async () => {
    const { pane } = mount(true);
    point(pane());
    leave(pane());
    await wait(CLOSE_GRACE_MS);
    expect(pane()).toHaveAttribute("data-overlay", "closing");
    point(pane(), 22, 130);
    expect(pane()).toHaveAttribute("data-overlay", "open");
    await wait(CLOSE_MS * 2);
    expect(pane()).toHaveAttribute("data-overlay", "open");
    expect(overlays()).toEqual([true]);
  });

  /**
   * The tooltip a row raised is a view of its own: the pointer on it has left
   * this document, and only main can say it is still the overlay's.
   */
  it("is held while the cursor is on the tooltip, and goes once it leaves", async () => {
    const { pane } = mount(true);
    point(pane());
    cursor = { inside: true, active: true };
    leave(pane());
    await wait(CLOSE_GRACE_MS * 5);
    expect(asked).toBe(5);
    expect(pane()).toHaveAttribute("data-overlay", "open");
    cursor = { inside: false, active: true };
    await wait(CLOSE_GRACE_MS);
    expect(pane()).toHaveAttribute("data-overlay", "closing");
  });

  it("is kept while the window is in the back, and decided once it is in front", async () => {
    const { pane } = mount(true);
    point(pane());
    fireEvent.blur(window);
    cursor = { inside: false, active: false };
    leave(pane());
    await wait(CLOSE_GRACE_MS * 10);
    expect(pane()).toHaveAttribute("data-overlay", "open");
    cursor = { inside: false, active: true };
    await wait(CLOSE_GRACE_MS);
    expect(pane()).toHaveAttribute("data-overlay", "closing");
  });

  it("is held by focus the keyboard put in it", async () => {
    const { pane } = mount(true);
    point(pane());
    const row = screen.getByRole("button", { name: /widget workspace/ });
    fireEvent.keyDown(row, { key: "ArrowDown" });
    act(() => {
      row.focus();
    });
    leave(pane());
    await wait(CLOSE_GRACE_MS * 3);
    expect(pane()).toHaveAttribute("data-overlay", "open");
  });

  it("closes on Escape and stays closed until the pointer has left", async () => {
    const { pane } = mount(true);
    point(pane());
    fireEvent.keyDown(pane(), { key: "Escape" });
    expect(pane()).toHaveAttribute("data-overlay", "closing");
    await wait(CLOSE_MS);
    expect(pane()).not.toHaveAttribute("data-overlay");
    point(pane(), 25, 110);
    expect(pane()).not.toHaveAttribute("data-overlay");
    leave(pane());
    point(pane(), 25, 140);
    expect(pane()).toHaveAttribute("data-overlay", "open");
  });

  it("folds away after a row is chosen, the way a tab bar does", async () => {
    const { pane } = mount(true);
    point(pane());
    fireEvent.click(screen.getByRole("button", { name: /^Scratch workspace/ }));
    await wait(CLOSE_MS);
    expect(pane()).not.toHaveAttribute("data-overlay");
    expect(overlays()).toEqual([true, false]);
  });

  it("is gone at once on a press outside the card", () => {
    const { pane } = mount(true);
    point(pane());
    fireEvent.pointerDown(document.body);
    expect(pane()).not.toHaveAttribute("data-overlay");
    expect(overlays()).toEqual([true, false]);
  });

  it("is held while a row is dragged", async () => {
    const { pane } = mount(true);
    point(pane());
    const row = screen
      .getByRole("button", { name: /widget workspace/ })
      .closest<HTMLElement>("[draggable=true]");
    if (!row) throw new Error("the row is not draggable");
    fireEvent.dragStart(row);
    leave(pane());
    await wait(CLOSE_GRACE_MS * 3);
    expect(pane()).toHaveAttribute("data-overlay", "open");
    // Let go outside the card: it goes, after the grace.
    fireEvent.dragOver(document.body);
    fireEvent.dragEnd(row);
    await wait(CLOSE_GRACE_MS + CLOSE_MS);
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
   * Compact mode turned off under the card: it is already where the docked
   * column goes, so it stays — docked at once at the same width, while main
   * keeps the view wide enough for the shadow to fade, and then lets it go.
   */
  it("lands in place when compact mode is turned off under it", async () => {
    const { pane, setCollapsed } = mount(true);
    point(pane());
    setCollapsed(false);
    expect(pane()).toHaveAttribute("data-overlay", "landing");
    expect(pane()).not.toHaveAttribute("data-collapsed");
    expect(pane().style.getPropertyValue("--sidebar-width")).toBe("248px");
    expect(overlays()).toEqual([true]);
    await wait(LAND_MS);
    expect(pane()).not.toHaveAttribute("data-overlay");
    expect(overlays()).toEqual([true, false]);
    // The docked column, resize handle and all.
    expect(screen.getByRole("separator")).toBeInTheDocument();
  });

  it("takes down whatever tooltip was up as it opens", () => {
    const { pane } = mount(true);
    point(pane());
    expect(tooltips).toContain("hide");
  });
});

/**
 * The card's shadow is drawn inside the room main leaves for it past the
 * card's edge; a layer reaching further is cut off in a straight line.
 */
describe("the floating Sidebar's shadow", () => {
  it("fits the room main leaves for it", () => {
    const css = readFileSync("src/shell/sidebar/sidebarPage.css", "utf8");
    const declaration = /--sidebar-overlay-elevation:([^;]+);/.exec(css)?.[1];
    if (declaration === undefined) throw new Error("no overlay elevation");
    const room = Number.parseFloat(
      new Map(chromeVariables()).get("--sidebar-overlay-shadow") ?? "",
    );
    const layers = declaration.split(/,(?![^(]*\))/);
    expect(layers.length).toBeGreaterThan(1);
    for (const layer of layers) {
      // `x y blur spread colour`: the lengths are the words before the colour.
      const lengths = layer
        .trim()
        .split(/\s+/)
        .filter((word) => /^-?\d+(\.\d+)?(px)?$/.test(word))
        .map((word) => Number.parseFloat(word));
      expect(lengths.length).toBeGreaterThanOrEqual(3);
      const [x = 0, , blur = 0, spread = 0] = lengths;
      expect(x + blur + spread).toBeLessThanOrEqual(room);
    }
  });
});

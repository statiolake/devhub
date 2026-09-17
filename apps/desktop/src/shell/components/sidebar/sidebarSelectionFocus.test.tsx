// @vitest-environment jsdom

/**
 * What a selection means about the keyboard.
 *
 * Selecting a row is one intent however it was raised, and there are only two
 * things it can mean. A pointer selection means *take me there*: somebody
 * clicked a row and what they want next is the thing they clicked. A keyboard
 * selection means *and stay here*: somebody is standing in the Sidebar after
 * `Cmd+Q S`, walking it with the arrows, and Return there chooses a row without
 * leaving the list — Escape is the way out.
 *
 * The Sidebar cannot put the keys anywhere itself: the surface is a native view
 * this document cannot focus. So the whole of its half is *asking*, through the
 * one door Escape already uses (`focusSurface`), and these tests are about when
 * it asks and when it does not.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSnapshot } from "../../../ipc/appShell";
import type { SidebarValue } from "../../sidebar/SidebarContext";
import { SidebarContext } from "../../sidebar/SidebarContext";
import { Sidebar } from "./Sidebar";

const focusSurface = vi.fn(() => Promise.resolve());

window.devhub = {
  openModal: vi.fn(() => Promise.resolve("")),
  focusSurface,
  onMenuCommand: () => () => undefined,
  onSidebarArea: () => () => undefined,
  showTooltip: () => undefined,
  hideTooltip: () => undefined,
  releaseTooltip: () => undefined,
} as unknown as typeof window.devhub;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
    workspaces: [
      {
        id: "w-1",
        label: "widget",
        location: { kind: "local" },
        root: "/projects/widget",
        displayRoot: "/projects/widget",
        key: "/projects/widget",
        selectedPath: "/projects/widget",
        state: { kind: "available" },
        close: { kind: "idle" },
        canCreateAgent: true,
        agents: [
          {
            id: "a-1",
            workspaceId: "w-1",
            ordinal: 0,
            displayName: "Codex",
            profileId: "p",
            status: "idle",
            runtimeHealth: "healthy",
            controlState: { kind: "running" },
            unread: "idle",
            activity: undefined,
            injection: {
              queued: 0,
              waitingFor: "nothing_queued",
              lastResult: undefined,
            },
          },
        ],
      },
    ],
  } as unknown as AppSnapshot;
}

function mount(
  collapsed = false,
  dispatch = vi.fn().mockResolvedValue(undefined),
) {
  const value = {
    dispatch,
    openExternalUrl: vi.fn(),
    answerWorktreeClose: vi.fn(() => Promise.resolve({})),
    closeWorkspace: vi.fn(),
    reportFailure: vi.fn(),
    dismissIntentError: vi.fn(),
    agentProfiles: { sequence: 1, availability: "available", profiles: [] },
    repositoryStatus: { sequence: 1, workspaces: [] },
  } as unknown as SidebarValue;
  render(
    <SidebarContext.Provider value={value}>
      <Sidebar snapshot={snapshot(collapsed)} />
    </SidebarContext.Provider>,
  );
  return dispatch;
}

/** The row's select button, by the id the tree walk knows it by. */
function row(treeItemId: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(
    `[data-tree-item-id="${treeItemId}"]`,
  );
  if (!found) throw new Error(`no row ${treeItemId}`);
  return found;
}

/**
 * A click as a pointer raises one. `detail` is the count of clicks in the run,
 * and it is what tells a pressed button from an activated one: the DOM sets it
 * to zero when a focused button is activated from the keyboard.
 */
function clickWithPointer(element: HTMLElement): void {
  fireEvent.click(element, { detail: 1 });
}

describe("a pointer selection hands the keyboard to what was selected", () => {
  it("does so from a Workspace row", async () => {
    mount();
    clickWithPointer(row("workspace:w-1"));
    await vi.waitFor(() => {
      expect(focusSurface).toHaveBeenCalledTimes(1);
    });
  });

  it("does so from an Agent row", async () => {
    mount();
    clickWithPointer(row("agent:a-1"));
    await vi.waitFor(() => {
      expect(focusSurface).toHaveBeenCalledTimes(1);
    });
  });

  it("does so from Scratch", async () => {
    mount();
    clickWithPointer(screen.getByRole("button", { name: "Scratch terminal" }));
    await vi.waitFor(() => {
      expect(focusSurface).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * The rail is the same rows with their words taken off, so it is the same
   * rule: a mark is the only thing left to click and clicking it still means
   * "take me there".
   */
  it("does so from the rail", async () => {
    mount(true);
    clickWithPointer(row("agent:a-1"));
    await vi.waitFor(() => {
      expect(focusSurface).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * After the selection, never before. Which child the keys belong to is a
   * function of the selection (`keyboardChild`), so asking any earlier would
   * hand them to the row that was selected a moment ago.
   */
  it("asks only once the selection has been applied", async () => {
    let applied: (() => void) | undefined;
    const dispatch = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          applied = resolve;
        }),
    );
    mount(false, dispatch as unknown as ReturnType<typeof vi.fn>);
    clickWithPointer(row("agent:a-1"));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(focusSurface).not.toHaveBeenCalled();
    applied?.();
    await vi.waitFor(() => {
      expect(focusSurface).toHaveBeenCalledTimes(1);
    });
  });
});

describe("a keyboard selection stays in the Sidebar", () => {
  /**
   * Return on a focused row. The selection is the same intent the click raises
   * and it is dispatched all the same — what does not happen is the handover.
   */
  it("selects without asking for the surface", async () => {
    const dispatch = mount();
    const target = row("agent:a-1");
    target.focus();
    // What a browser raises when a focused button is activated from the
    // keyboard: a click whose `detail` is zero, because no press was counted.
    fireEvent.click(target, { detail: 0 });
    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "select_context" }),
      );
    });
    expect(focusSurface).not.toHaveBeenCalled();
  });

  it("keeps the keys in the tree while the arrows walk it", () => {
    mount();
    const tree = screen.getByRole("tree");
    row("workspace:w-1").focus();
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(document.activeElement).toBe(row("agent:a-1"));
    expect(focusSurface).not.toHaveBeenCalled();
  });
});

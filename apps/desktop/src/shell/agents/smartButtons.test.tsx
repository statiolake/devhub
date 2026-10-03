// @vitest-environment jsdom

/**
 * The Smart Buttons as a person meets them: which are on screen, where the box
 * stands in each kind of pane, what pressing one does, and what dragging the
 * box does.
 *
 * Pressing one does not run git and does not talk to GitHub. It asks main to
 * say a sentence to the Agent, queued like every other (`runAgentAction`).
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
import type { AgentWire, AppSnapshot } from "../../ipc/appShell";
import type {
  AgentActionWire,
  WorkspaceRepositoryWire,
} from "../../ipc/contract";
import type { SmartButtonsSpot } from "../../model/smartButtons";
import { AgentPane } from "./AgentPane";
import { AgentsContext, type AgentsValue } from "./AgentsContext";
import { SmartButtons } from "./SmartButtons";

// The pane mounts a live terminal per running Agent, which wants a channel to
// main; what floats over it is what is under test here.
vi.mock("../terminal/TerminalSurface", () => ({
  TerminalSurface: () => <div data-testid="terminal" />,
}));

const ACTIONS: readonly AgentActionWire[] = [
  {
    id: "issue_assignment",
    displayName: "Work on the Issue",
    trigger: "issue",
    button: false,
  },
  {
    id: "commit_changes",
    displayName: "Commit the changes",
    trigger: "commit",
    button: true,
  },
  {
    id: "commit_in_pieces",
    displayName: "Commit in pieces",
    trigger: "commit",
    button: false,
  },
  {
    id: "push_commits",
    displayName: "Push the commits",
    trigger: "push",
    button: true,
  },
  {
    id: "fix_ci",
    displayName: "Fix CI",
    trigger: "ci_failing",
    button: true,
  },
];

const DIRTY: WorkspaceRepositoryWire = {
  workspaceId: "w-1",
  branch: "feature/128-tidy",
  defaultBranch: "main",
  dirty: true,
  ahead: 0,
  pullRequest: {
    number: 42,
    url: "https://github.com/example/widget/pull/42",
    title: "Tidy",
    state: "open",
    conversations: { unresolved: 0, uncounted: 0 },
  },
};

function agent(over: Partial<AgentWire> = {}): AgentWire {
  return {
    id: "a-1",
    displayName: "Claude 1",
    workspaceId: "w-1",
    status: "idle",
    presentation: "tui",
    injection: {
      queued: 0,
      waitingFor: "nothing_queued",
      lastResult: undefined,
    },
    ...over,
  } as unknown as AgentWire;
}

/**
 * Where each element is, by class: the pane is 1000×600 at the origin, a
 * composer's box spans its lower part, a status sits in its corner, and the
 * box is 240×24 wherever it is drawn.
 */
const RECTS: Record<string, DOMRect> = {
  "agent-pane": rect(0, 0, 1000, 600),
  "conversation-composer-box": rect(100, 480, 900, 580),
  "agent-injection-status": rect(700, 560, 988, 588),
  "smart-buttons": rect(0, 0, 240, 24),
};

function rect(left: number, top: number, right: number, bottom: number) {
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const known = [...this.classList].find((name) => name in RECTS);
      return known === undefined ? rect(0, 0, 0, 0) : (RECTS[known] as DOMRect);
    },
  );
  // jsdom has neither pointer capture nor pointer events: one is a mouse
  // event with a pointer's id.
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  globalThis.PointerEvent ??= class extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  } as unknown as typeof PointerEvent;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount({
  over = {},
  repository = DIRTY,
  stored,
  status,
}: {
  over?: Partial<AgentWire>;
  repository?: WorkspaceRepositoryWire;
  stored?: SmartButtonsSpot;
  status?: boolean;
} = {}) {
  const runAgentAction = vi.fn(() => Promise.resolve({}));
  const dispatch = vi.fn(() => Promise.resolve(undefined));
  const value = {
    repositoryStatus: { sequence: 1, workspaces: [repository] },
    agentActions: ACTIONS,
    runAgentAction,
    dispatch,
    reportFailure: vi.fn(),
  } as unknown as AgentsValue;
  const shown = agent(over);
  render(
    <AgentsContext.Provider value={value}>
      <div className="agent-pane">
        <div data-surface-key="agent:a-1">
          {shown.presentation === "gui" ? (
            <div className="conversation-composer-box" />
          ) : null}
        </div>
        {status ? <div className="agent-injection-status" /> : null}
        <SmartButtons agent={shown} stored={stored} />
      </div>
    </AgentsContext.Provider>,
  );
  return { runAgentAction, dispatch };
}

function box(): HTMLElement {
  return screen.getByRole("toolbar", { name: "Smart Buttons" });
}

/** The Smart Buttons on screen, without their switches or the header. */
function labels(): string[] {
  return [...document.querySelectorAll(".smart-button")].map(
    (button) => button.textContent ?? "",
  );
}

describe("which Smart Buttons are drawn", () => {
  it("draws the configured wording for every condition that holds", () => {
    mount();
    expect(labels()).toEqual(["Commit the changes"]);
  });

  it("leaves out an action whose button is off, and the Issue flow's", () => {
    // `commit_in_pieces` is under a trigger that holds, and still not drawn.
    mount({
      repository: {
        ...DIRTY,
        ahead: 2,
        pullRequest: {
          ...(DIRTY.pullRequest as NonNullable<
            WorkspaceRepositoryWire["pullRequest"]
          >),
          checks: { state: "failing", total: 2, failing: 1, pending: 0 },
        },
      },
    });
    expect(labels()).toEqual([
      "Commit the changes",
      "Push the commits",
      "Fix CI",
    ]);
  });

  it("draws no button while the Agent is not idle, only the quiet Auto menu", () => {
    for (const status of ["working", "waiting", "background", "unknown"]) {
      mount({ over: { status } as Partial<AgentWire> });
      expect(labels()).toEqual([]);
      expect(box()).toHaveAttribute("data-quiet");
      cleanup();
    }
  });

  it("draws no button when no condition holds", () => {
    mount({ repository: { ...DIRTY, dirty: false } });
    expect(labels()).toEqual([]);
    expect(box()).toHaveAttribute("data-quiet");
  });

  it("draws nothing at all when no action may be automatic and none is offered", () => {
    const runAgentAction = vi.fn();
    render(
      <AgentsContext.Provider
        value={
          {
            repositoryStatus: { sequence: 1, workspaces: [DIRTY] },
            agentActions: ACTIONS.filter(
              (action) => action.trigger === "issue",
            ),
            runAgentAction,
            dispatch: vi.fn(),
            reportFailure: vi.fn(),
          } as unknown as AgentsValue
        }
      >
        <div className="agent-pane">
          <SmartButtons agent={agent()} stored={undefined} />
        </div>
      </AgentsContext.Provider>,
    );
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("queues the action rather than running anything", () => {
    const { runAgentAction } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Commit the changes" }));
    expect(runAgentAction).toHaveBeenCalledWith("a-1", "commit_changes");
  });
});

describe("where the box stands", () => {
  it("stands on a GUI Agent's composer, touching it, inset past its corner", () => {
    mount({ over: { presentation: "gui" } });
    expect(box()).toHaveAttribute("data-presentation", "gui");
    // The composer's top is 120px above the pane's bottom; its right edge is
    // 100px in from the pane's, and the box 16px further in.
    expect(box().style.bottom).toBe("128px");
    expect(box().style.right).toBe("116px");
  });

  it("stands in a terminal's bottom right corner", () => {
    mount();
    expect(box()).toHaveAttribute("data-presentation", "tui");
    expect(box().style.right).toBe("12px");
    expect(box().style.bottom).toBe("12px");
  });

  it("stands on a terminal's queued-message status when there is one", () => {
    mount({ status: true });
    // The status's top is 40px above the pane's bottom, plus a 4px gap.
    expect(box().style.bottom).toBe("44px");
    expect(box().style.right).toBe("12px");
  });

  it("stands where it was dragged, clamped to the pane as it is now", () => {
    mount({ stored: { right: 300, bottom: 200 } });
    expect(box()).toHaveAttribute("data-placed", "moved");
    expect(box().style.right).toBe("300px");
    expect(box().style.bottom).toBe("200px");
    cleanup();
    // Remembered from a larger window: drawn inside this one.
    mount({ stored: { right: 5000, bottom: 5000 } });
    expect(box().style.right).toBe("760px");
    expect(box().style.bottom).toBe("576px");
  });
});

describe("dragging the box", () => {
  const handle = () =>
    box().querySelector(".smart-buttons-handle") as HTMLElement;

  it("remembers where it was dropped, and presses no button", () => {
    const { dispatch, runAgentAction } = mount();
    fireEvent.pointerDown(handle(), {
      button: 0,
      clientX: 900,
      clientY: 580,
      pointerId: 1,
    });
    fireEvent.pointerMove(handle(), {
      clientX: 700,
      clientY: 480,
      pointerId: 1,
    });
    expect(box()).toHaveAttribute("data-dragging");
    expect(box().style.right).toBe("212px");
    expect(box().style.bottom).toBe("112px");
    fireEvent.pointerUp(handle(), { clientX: 700, clientY: 480, pointerId: 1 });
    expect(dispatch).toHaveBeenCalledWith({
      type: "place_smart_buttons",
      presentation: "tui",
      spot: { right: 212, bottom: 112 },
    });
    expect(runAgentAction).not.toHaveBeenCalled();
  });

  it("stops the box at the pane's edges", () => {
    const { dispatch } = mount({ over: { presentation: "gui" } });
    fireEvent.pointerDown(handle(), {
      button: 0,
      clientX: 500,
      clientY: 500,
      pointerId: 1,
    });
    fireEvent.pointerMove(handle(), {
      clientX: -4000,
      clientY: -4000,
      pointerId: 1,
    });
    fireEvent.pointerUp(handle(), { pointerId: 1 });
    expect(dispatch).toHaveBeenCalledWith({
      type: "place_smart_buttons",
      presentation: "gui",
      spot: { right: 760, bottom: 576 },
    });
  });

  it("remembers nothing for a press that did not move", () => {
    const { dispatch } = mount();
    fireEvent.pointerDown(handle(), {
      button: 0,
      clientX: 900,
      clientY: 580,
      pointerId: 1,
    });
    fireEvent.pointerMove(handle(), {
      clientX: 901,
      clientY: 581,
      pointerId: 1,
    });
    fireEvent.pointerUp(handle(), { pointerId: 1 });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("goes back to its default spot on a double-click of the handle", () => {
    const { dispatch } = mount({
      over: { presentation: "gui" },
      stored: { right: 300, bottom: 200 },
    });
    fireEvent.doubleClick(handle());
    expect(dispatch).toHaveBeenCalledWith({
      type: "place_smart_buttons",
      presentation: "gui",
    });
  });

  it("snaps to the composer's top edge and is remembered anchored", () => {
    const { dispatch } = mount({ over: { presentation: "gui" } });
    // From the default spot (right 116, bottom 120) up 10px and left 84px:
    // still within the snap of the composer's top, so it stays on it.
    fireEvent.pointerDown(handle(), {
      button: 0,
      clientX: 800,
      clientY: 470,
      pointerId: 1,
    });
    fireEvent.pointerMove(handle(), {
      clientX: 716,
      clientY: 460,
      pointerId: 1,
    });
    expect(box()).toHaveAttribute("data-anchored", "top");
    expect(box().style.bottom).toBe("128px");
    expect(box().style.right).toBe("200px");
    fireEvent.pointerUp(handle(), { pointerId: 1 });
    expect(dispatch).toHaveBeenCalledWith({
      type: "place_smart_buttons",
      presentation: "gui",
      spot: { anchored: "top", along: 100 },
    });
  });

  it("forgets a drop back on the default spot rather than storing a copy", () => {
    const { dispatch } = mount({
      over: { presentation: "gui" },
      stored: { right: 300, bottom: 200 },
    });
    fireEvent.pointerDown(handle(), {
      button: 0,
      clientX: 500,
      clientY: 400,
      pointerId: 1,
    });
    // To right 116, bottom 125: 5px above the default, so it snaps there.
    fireEvent.pointerMove(handle(), {
      clientX: 684,
      clientY: 475,
      pointerId: 1,
    });
    fireEvent.pointerUp(handle(), { pointerId: 1 });
    expect(dispatch).toHaveBeenCalledWith({
      type: "place_smart_buttons",
      presentation: "gui",
    });
  });

  it("moves with the arrow keys, and Home puts it back", () => {
    const { dispatch } = mount({ stored: { right: 300, bottom: 200 } });
    const grip = screen.getByRole("button", { name: "Move the Smart Buttons" });
    fireEvent.keyDown(grip, { key: "ArrowUp" });
    expect(dispatch).toHaveBeenLastCalledWith({
      type: "place_smart_buttons",
      presentation: "tui",
      spot: { right: 300, bottom: 208 },
    });
    fireEvent.keyDown(grip, { key: "Home" });
    expect(dispatch).toHaveBeenLastCalledWith({
      type: "place_smart_buttons",
      presentation: "tui",
    });
  });
});

describe("anchored to the composer", () => {
  it("rides on the composer as it grows", () => {
    mount({
      over: { presentation: "gui" },
      stored: { anchored: "top", along: 40 },
    });
    expect(box()).toHaveAttribute("data-anchored", "top");
    expect(box().style.right).toBe("140px");
    expect(box().style.bottom).toBe("128px");
    cleanup();
    // A taller prompt: the composer's top is 60px higher.
    RECTS["conversation-composer-box"] = rect(100, 420, 900, 580);
    try {
      mount({
        over: { presentation: "gui" },
        stored: { anchored: "top", along: 40 },
      });
      expect(box().style.bottom).toBe("188px");
    } finally {
      RECTS["conversation-composer-box"] = rect(100, 480, 900, 580);
    }
  });

  it("reads a free offset stored before anchoring as the free place it was", () => {
    mount({ stored: { right: 300, bottom: 200 } });
    expect(box()).not.toHaveAttribute("data-anchored");
    expect(box().style.right).toBe("300px");
  });
});

/**
 * The box as the Agent pane draws it, beside everything else floating over
 * the pane — which is where the owner saw the buttons come twice, three
 * times, once more for every drag: each drop is a new snapshot, and a new
 * snapshot is the pane drawn again.
 */
describe("the box in an Agent's pane", () => {
  function snapshotWith(stored: SmartButtonsSpot | undefined): AppSnapshot {
    return {
      smartButtons: stored === undefined ? {} : { tui: stored },
      workspaces: [
        {
          id: "w-1",
          label: "example",
          root: "/example",
          displayRoot: "/example",
          state: { kind: "available" },
          close: { kind: "idle" },
          agents: [
            agent({
              ordinal: 1,
              profileId: "claude",
              profileKind: "claude",
              runtimeHealth: "healthy",
              controlState: { kind: "running" },
            } as Partial<AgentWire>),
          ],
        },
      ],
    } as unknown as AppSnapshot;
  }

  it("stays one box with the same buttons however many times it is dragged", async () => {
    const value = {
      repositoryStatus: { sequence: 1, workspaces: [DIRTY] },
      agentActions: ACTIONS,
      runAgentAction: vi.fn(() => Promise.resolve({})),
      dispatch: vi.fn(() => Promise.resolve(undefined)),
      reportFailure: vi.fn(),
    } as unknown as AgentsValue;
    const pane = (stored: SmartButtonsSpot | undefined) => (
      <AgentsContext.Provider value={value}>
        <AgentPane
          snapshot={snapshotWith(stored)}
          appearance={undefined}
          activeKey="agent:a-1"
        />
      </AgentsContext.Provider>
    );
    const { container, rerender } = render(pane(undefined));
    const drawn = () =>
      [...container.querySelectorAll(".smart-button")].map(
        (button) => button.textContent,
      );
    expect(drawn()).toEqual(["Commit the changes"]);

    for (const step of [1, 2, 3]) {
      const handle = box().querySelector(
        ".smart-buttons-handle",
      ) as HTMLElement;
      fireEvent.pointerDown(handle, {
        button: 0,
        clientX: 900,
        clientY: 580,
        pointerId: 1,
      });
      fireEvent.pointerMove(handle, {
        clientX: 900 - 20 * step,
        clientY: 580,
        pointerId: 1,
      });
      fireEvent.pointerUp(handle, { pointerId: 1 });
      // Main's snapshot, with the offset the drop placed.
      await act(async () => {
        rerender(pane({ right: 12 + 20 * step, bottom: 12 }));
        await Promise.resolve();
      });
      expect(
        screen.getAllByRole("toolbar", { name: "Smart Buttons" }),
      ).toHaveLength(1);
      expect(drawn()).toEqual(["Commit the changes"]);
    }
  });
});

describe("automatic actions", () => {
  it("puts an automatic switch on each button whose action may be automatic", () => {
    const { dispatch, runAgentAction } = mount();
    const bolt = screen.getByRole("button", {
      name: "Send “Commit the changes” automatically",
    });
    expect(bolt).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(bolt);
    expect(dispatch).toHaveBeenCalledWith({
      type: "set_automatic_action",
      agentId: "a-1",
      actionId: "commit_changes",
      automatic: true,
    });
    // Switching is not pressing.
    expect(runAgentAction).not.toHaveBeenCalled();
  });

  it("shows on the very button that it is automatic, and turns it off there", () => {
    const { dispatch } = mount({
      over: { automaticActions: ["commit_changes"] } as Partial<AgentWire>,
    });
    const bolt = screen.getByRole("button", {
      name: "Send “Commit the changes” automatically",
    });
    expect(bolt).toHaveAttribute("aria-pressed", "true");
    expect(bolt.closest(".smart-button-line")).toHaveAttribute(
      "data-automatic",
    );
    expect(box()).not.toHaveAttribute("data-quiet");
    fireEvent.click(bolt);
    expect(dispatch).toHaveBeenCalledWith({
      type: "set_automatic_action",
      agentId: "a-1",
      actionId: "commit_changes",
      automatic: false,
    });
  });

  it("has no switch on a button whose action may not be automatic", () => {
    render(
      <AgentsContext.Provider
        value={
          {
            repositoryStatus: {
              sequence: 1,
              workspaces: [
                { ...DIRTY, dirty: false, pullRequest: undefined, ahead: 1 },
              ],
            },
            agentActions: [
              ...ACTIONS,
              {
                id: "open_pr",
                displayName: "Open a pull request",
                trigger: "pull_request",
                button: true,
              },
            ],
            runAgentAction: vi.fn(),
            dispatch: vi.fn(),
            reportFailure: vi.fn(),
          } as unknown as AgentsValue
        }
      >
        <div className="agent-pane">
          <SmartButtons agent={agent()} stored={undefined} />
        </div>
      </AgentsContext.Provider>,
    );
    expect(labels()).toContain("Open a pull request");
    expect(
      screen.queryByRole("button", {
        name: "Send “Open a pull request” automatically",
      }),
    ).toBeNull();
  });

  it("lists every action that may be automatic in the header, with when it fires", () => {
    const { dispatch } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Automatic actions" }));
    const menu = screen.getByRole("menu");
    const items = [...menu.querySelectorAll('[role="menuitemcheckbox"]')];
    // The Issue flow's is not one of them; commit, push and CI are — CI's
    // although its button is not on screen.
    expect(items.map((item) => item.getAttribute("aria-label"))).toEqual([
      "Commit the changes",
      "Commit in pieces",
      "Push the commits",
      "Fix CI",
    ]);
    expect(
      items.every((item) => item.getAttribute("aria-checked") === "false"),
    ).toBe(true);
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Fix CI" }),
    ).toHaveTextContent("When CI starts failing");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Fix CI" }));
    expect(dispatch).toHaveBeenCalledWith({
      type: "set_automatic_action",
      agentId: "a-1",
      actionId: "fix_ci",
      automatic: true,
    });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("counts what is automatic on the header's switch", () => {
    mount({
      over: {
        automaticActions: ["commit_changes", "fix_ci"],
      } as Partial<AgentWire>,
    });
    const auto = screen.getByRole("button", { name: "Automatic actions" });
    expect(auto).toHaveAttribute("data-armed");
    expect(auto).toHaveTextContent("2");
    fireEvent.click(auto);
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Fix CI" }),
    ).toHaveAttribute("aria-checked", "true");
  });
});

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
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentWire } from "../../ipc/appShell";
import type {
  AgentActionWire,
  WorkspaceRepositoryWire,
} from "../../ipc/contract";
import type { SmartButtonsOffset } from "../../model/smartButtons";
import { AgentsContext, type AgentsValue } from "./AgentsContext";
import { SmartButtons } from "./SmartButtons";

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
  stored?: SmartButtonsOffset;
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

function labels(): string[] {
  return screen
    .queryAllByRole("button")
    .map((button) => button.textContent ?? "");
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

  it("draws nothing while the Agent is not idle", () => {
    for (const status of ["working", "waiting", "background", "unknown"]) {
      mount({ over: { status } as Partial<AgentWire> });
      expect(screen.queryByRole("toolbar")).toBeNull();
      cleanup();
    }
  });

  it("draws nothing when no condition holds", () => {
    mount({ repository: { ...DIRTY, dirty: false } });
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
    expect(box().style.bottom).toBe("120px");
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
      offset: { right: 212, bottom: 112 },
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
      offset: { right: 760, bottom: 576 },
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
});

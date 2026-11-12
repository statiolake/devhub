// @vitest-environment jsdom

/**
 * The orchestrator's work under the Orchestrator row, by lane
 * (`orchestratorLanes.ts`, `docs/orchestrator.md`, "The orchestrator's work
 * in the Sidebar"): which items are there (by the managed flag), in which lane,
 * folded how, walked by which keys, and what holds still.
 */

import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSnapshot } from "../../../ipc/appShell";
import {
  EMPTY_BOARD,
  type AgentOrchestrationWire,
  type OrchestratorBoardWire,
  type TaskStatusWire,
} from "../../../ipc/contract";
import { askingTask, taskWire } from "../../agents/taskFixture";
import type { SidebarValue } from "../../sidebar/SidebarContext";
import { SidebarContext } from "../../sidebar/SidebarContext";
import { Sidebar } from "./Sidebar";
import {
  forgetOrchestratorFolds,
  POINTER_IDLE_MS,
  SETTLE_MS,
} from "./orchestratorGroup";
import { laneOf, orchestratorItems } from "./orchestratorLanes";
import { ON_SCRATCH, SCRATCH_ID, scratchWorkspace } from "./scratchFixture";

let pushArmed: ((armed: boolean) => void) | undefined;

window.devhub = {
  openModal: vi.fn(() => Promise.resolve("")),
  focusSurface: vi.fn(() => Promise.resolve()),
  showContextMenu: vi.fn(() => Promise.resolve(undefined)),
  onMenuCommand: () => () => undefined,
  onSidebarArea: () => () => undefined,
  onChordArmed: (listener: (armed: boolean) => void) => {
    pushArmed = listener;
    return () => undefined;
  },
  showTooltip: () => undefined,
  hideTooltip: () => undefined,
  releaseTooltip: () => undefined,
} as unknown as typeof window.devhub;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  forgetOrchestratorFolds();
  pushArmed = undefined;
});

const ROOT_ID = "orch-ws";

function agent(
  id: string,
  workspaceId: string,
  status = "idle",
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    workspaceId,
    ordinal: 0,
    displayName: id,
    named: true,
    profileId: "p",
    status,
    runtimeHealth: "healthy",
    controlState: { kind: "running" },
    unread: undefined,
    activity: undefined,
    injection: {
      queued: 0,
      waitingFor: "nothing_queued",
      lastResult: undefined,
    },
    ...extra,
  };
}

function workspace(id: string, agents: readonly unknown[], managed = false) {
  return scratchWorkspace({
    id,
    label: id,
    root: `/src/${id}`,
    key: `/src/${id}`,
    agents: agents as never,
    ...(managed ? { managed: true } : {}),
  });
}

/**
 * The mock's fixture: a helper and five Workspaces the orchestrator manages,
 * across the lanes, two it does not, and a managed agent in Scratch.
 */
function snapshot(
  options: {
    readonly context?: AppSnapshot["selection"]["context"];
    readonly empty?: boolean;
  } = {},
): AppSnapshot {
  const managed = options.empty
    ? []
    : [
        workspace("rounding", [agent("r1", "rounding")], true),
        workspace(
          "investigate",
          [agent("i1", "investigate", "working", { managed: true })],
          true,
        ),
        workspace("invoice", [agent("v1", "invoice")], true),
        workspace(
          "review",
          [agent("p1", "review", "working", { managed: true })],
          true,
        ),
        workspace("finished", [], true),
      ];
  return {
    schemaVersion: 1,
    revision: 1,
    readiness: "ready",
    editorHost: { status: "ready" },
    layout: { kind: "unavailable" },
    selection: { context: options.context ?? ON_SCRATCH, presentation: "full" },
    sidebar: { width: 248 },
    splitRatio: 0.55,
    smartButtons: {},
    scratchWorkspaceId: SCRATCH_ID,
    orchestratorAgentId: "orch",
    orchestratorWorkspaceId: ROOT_ID,
    workspaces: [
      scratchWorkspace({
        agents: [
          agent("s1", SCRATCH_ID, "working", { managed: true }),
        ] as never,
      }),
      workspace(ROOT_ID, [
        agent("orch", ROOT_ID, "working"),
        ...(options.empty ? [] : [agent("research", ROOT_ID)]),
      ]),
      ...managed,
      workspace("dotfiles", [agent("d1", "dotfiles", "working")]),
      workspace("notes", []),
    ],
  } as unknown as AppSnapshot;
}

/** Each agent's task, as the board says it: `[agent, task id, status]`. */
function bound(
  ...entries: readonly (readonly [string, number, TaskStatusWire])[]
): Record<string, AgentOrchestrationWire> {
  return Object.fromEntries(
    entries.map(([agentId, id, status]) => [
      agentId,
      { task: { id, title: `#${String(id)}`, status } },
    ]),
  );
}

/** The fixture's: r1 asked, v1 parked, research a managed helper with no task. */
const STATES = {
  ...bound(["r1", 1, "answer"], ["v1", 2, "waiting"]),
  research: { needsAction: "no_task" },
};

function board(
  overrides: Partial<OrchestratorBoardWire> = {},
): OrchestratorBoardWire {
  return {
    ...EMPTY_BOARD,
    orchestratorAgentId: "orch",
    answer: [askingTask(1)],
    waiting: [taskWire({ id: 2, status: "waiting" })],
    agentStates: STATES,
    ...overrides,
  };
}

function contextValue(value: OrchestratorBoardWire): SidebarValue {
  return {
    dispatch: vi.fn().mockResolvedValue(undefined),
    openExternalUrl: vi.fn(),
    closeWorkspace: vi.fn(),
    reportFailure: vi.fn(),
    retry: vi.fn(),
    agentProfiles: { sequence: 1, availability: "available", profiles: [] },
    usageLimits: { clis: [] },
    repositoryStatus: { sequence: 1, workspaces: [] },
    board: value,
  } as unknown as SidebarValue;
}

function mount(
  value: AppSnapshot = snapshot(),
  boardValue: OrchestratorBoardWire = board(),
) {
  const view = render(
    <SidebarContext.Provider value={contextValue(boardValue)}>
      <Sidebar snapshot={value} />
    </SidebarContext.Provider>,
  );
  return {
    update(next: AppSnapshot, nextBoard: OrchestratorBoardWire) {
      view.rerender(
        <SidebarContext.Provider value={contextValue(nextBoard)}>
          <Sidebar snapshot={next} />
        </SidebarContext.Provider>,
      );
    },
  };
}

const orchestratorItem = () =>
  document.querySelector<HTMLElement>("[data-orchestrator='true']")!;

const lanes = () =>
  [
    ...orchestratorItem().querySelectorAll<HTMLElement>(
      "[role=treeitem][aria-level='2']",
    ),
  ].map((heading) => ({
    lane: heading.dataset["lane"],
    open: heading.getAttribute("aria-expanded") === "true",
    count: heading.querySelector(".lane-count")?.textContent,
    items: [
      ...heading.querySelectorAll<HTMLElement>(
        "[role=treeitem][aria-level='3'] [data-tree-item-id]",
      ),
    ]
      .filter(
        (button) =>
          button.closest("[role=treeitem]")?.getAttribute("aria-level") === "3",
      )
      .map((button) => button.dataset["treeItemId"]),
  }));

const topLabels = () =>
  [
    ...screen
      .getByRole("tree", { name: "Open workspaces" })
      .querySelectorAll<HTMLElement>(":scope > [role=treeitem]"),
  ].map((row) => row.querySelector(".row-label")?.textContent);

const button = (id: string) =>
  document.querySelector<HTMLButtonElement>(`[data-tree-item-id="${id}"]`);

const focused = () =>
  (document.activeElement as HTMLElement | null)?.dataset["treeItemId"];

describe("which lane an item is in", () => {
  it("is the first that holds of its tasks: 回答待ち, 処理中, 待機, else 完了", () => {
    const value = board({
      agentStates: {
        ...bound(
          ["r1", 1, "answer"],
          ["x", 3, "in_progress"],
          ["v1", 2, "waiting"],
        ),
        y: { needsAction: "no_task" },
        d: { task: { id: 9, title: "#9", status: "done" } },
      },
    });
    const idle = (id: string) => ({ id, status: "idle" as const });
    expect(laneOf([idle("r1")], undefined, value)).toBe("ask");
    // A task whose stopped agent ran in the Workspace.
    expect(
      laneOf(
        [],
        "ws",
        board({
          answer: [
            taskWire({
              id: 4,
              status: "answer",
              agents: [
                {
                  agentId: "gone",
                  name: "g",
                  live: false,
                  resumable: true,
                  workspaceId: "ws",
                },
              ],
            }),
          ],
        }),
      ),
    ).toBe("ask");
    expect(laneOf([idle("x")], undefined, value)).toBe("progress");
    expect(laneOf([{ id: "w", status: "working" }], undefined, value)).toBe(
      "progress",
    );
    expect(laneOf([idle("v1")], undefined, value)).toBe("waiting");
    // Needing a task, stopped: 待機, with its △.
    expect(laneOf([idle("y")], undefined, value)).toBe("waiting");
    expect(laneOf([idle("d")], undefined, value)).toBe("closed");
    expect(laneOf([idle("z")], undefined, value)).toBe("closed");
    expect(laneOf([], "gone", value)).toBe("closed");
  });

  it("takes the helpers and the managed Workspaces, never the others", () => {
    const items = orchestratorItems(snapshot(), board());
    expect(items.map((item) => [item.key, item.lane])).toEqual([
      ["agent:research", "waiting"],
      ["workspace:rounding", "ask"],
      ["workspace:investigate", "progress"],
      ["workspace:invoice", "waiting"],
      ["workspace:review", "progress"],
      ["workspace:finished", "closed"],
    ]);
  });
});

describe("the Orchestrator row's group", () => {
  it("draws the tasks' statuses in the board's order, 完了 folded, the person's Workspaces where they were", () => {
    mount();
    expect(lanes()).toEqual([
      { lane: "ask", open: true, count: "1", items: ["agent:r1"] },
      {
        lane: "progress",
        open: true,
        count: "2",
        items: ["agent:i1", "agent:p1"],
      },
      {
        lane: "waiting",
        open: true,
        count: "2",
        items: ["agent:research", "agent:v1"],
      },
      { lane: "closed", open: false, count: "1", items: [] },
    ]);
    // Needing action is the row's △, not a place.
    expect(
      button("agent:research")!
        .closest(".agent-row")!
        .querySelector(".row-agent-mark.is-needs-action"),
    ).not.toBeNull();
    expect(topLabels()).toEqual([
      "Orchestrator",
      "Scratch",
      "dotfiles",
      "notes",
    ]);
    // A managed agent in Scratch, a row of its own, keeps its wash there;
    // under the Orchestrator row the place says it.
    expect(button("agent:s1")!.closest(".agent-row")).toHaveClass("is-managed");
    expect(button("agent:i1")!.closest(".agent-row")).not.toHaveClass(
      "is-managed",
    );
  });

  it("draws a Workspace with one Agent as that Agent's row, and one with none as its own", () => {
    mount();
    fireEvent.click(button("lane:closed")!);
    expect(lanes().at(-1)).toEqual({
      lane: "closed",
      open: true,
      count: "1",
      items: ["workspace:finished"],
    });
    // Its one Agent's row is also the Workspace's: the editor is a right-click away.
    expect(button("workspace:investigate")).toBeNull();
  });

  it("keeps a managed Workspace under it when the person starts an Agent there", () => {
    const value = snapshot();
    const mixed = {
      ...value,
      workspaces: value.workspaces.map((one) =>
        one.id === "review"
          ? { ...one, agents: [...one.agents, agent("mine", "review")] }
          : one,
      ),
    } as unknown as AppSnapshot;
    mount(mixed);
    expect(topLabels()).toEqual([
      "Orchestrator",
      "Scratch",
      "dotfiles",
      "notes",
    ]);
    // Two Agents: the Workspace's row, its Agents under it.
    const row =
      button("workspace:review")!.closest<HTMLElement>("[role=treeitem]")!;
    expect(row).toHaveAttribute("aria-level", "3");
    expect(
      [...row.querySelectorAll<HTMLElement>("[aria-level='4']")].map((one) =>
        one
          .querySelector("[data-tree-item-id]")
          ?.getAttribute("data-tree-item-id"),
      ),
    ).toEqual(["agent:p1", "agent:mine"]);
  });

  it("with nothing under it is today's one row: no disclosure, no count, not expandable", () => {
    mount(snapshot({ empty: true }), {
      ...EMPTY_BOARD,
      orchestratorAgentId: "orch",
    });
    const item = orchestratorItem();
    expect(item).not.toHaveAttribute("aria-expanded");
    expect(within(item).queryByRole("group")).toBeNull();
    expect(item.querySelector(".orchestrator-disclosure")).toBeNull();
    expect(item.querySelector(".orchestrator-total")).toBeNull();
    expect(
      item.querySelector(".row-glyph [data-glyph='orchestrator']"),
    ).not.toBeNull();
    expect(topLabels()).toEqual([
      "Orchestrator",
      "Scratch",
      "dotfiles",
      "notes",
    ]);
  });

  it("folds as a whole, keeping the badge and showing the total, and remembers it for the session", () => {
    mount();
    const disclosure = orchestratorItem().querySelector<HTMLButtonElement>(
      ".orchestrator-disclosure",
    )!;
    fireEvent.click(disclosure);
    expect(orchestratorItem()).toHaveAttribute("aria-expanded", "false");
    expect(within(orchestratorItem()).queryByRole("group")).toBeNull();
    expect(
      orchestratorItem().querySelector(".orchestrator-total"),
    ).toHaveTextContent("6");
    expect(
      orchestratorItem().querySelector(".orchestrator-badge"),
    ).toHaveTextContent("1");
    cleanup();
    mount();
    expect(orchestratorItem()).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(
      orchestratorItem().querySelector<HTMLButtonElement>(
        ".orchestrator-disclosure",
      )!,
    );
    // A lane's fold is kept as well.
    fireEvent.click(button("lane:ask")!);
    cleanup();
    mount();
    expect(lanes().map((one) => [one.lane, one.open])).toEqual([
      ["ask", false],
      ["progress", true],
      ["waiting", true],
      ["closed", false],
    ]);
  });

  it("is drawn on the rail as well, the Orchestrator's mark carrying the badge", () => {
    mount();
    const expanded = lanes();
    cleanup();
    mount(railed(snapshot()));
    // The same headings, folded the same way, holding the same items.
    expect(lanes()).toEqual(expanded);
    expect(
      orchestratorItem().querySelector(".orchestrator-badge.is-rail"),
    ).toHaveTextContent("1");
  });

  it("gives the digits to the person's Workspaces only", () => {
    mount();
    act(() => {
      pushArmed?.(true);
    });
    const digits = [
      ...document.querySelectorAll<HTMLElement>("[data-chord-digit]"),
    ].map((one) => [
      one.closest("[role=treeitem]")?.querySelector(".row-label")?.textContent,
      one.dataset["chordDigit"],
    ]);
    expect(digits).toEqual([
      ["Scratch", "0"],
      ["dotfiles", "1"],
      ["notes", "2"],
    ]);
  });
});

describe("the keyboard in the group", () => {
  it("walks it as a tree: → opens or enters, ← folds or goes to the parent", () => {
    mount(snapshot({ context: { kind: "orchestrator" } }));
    const press = (key: string) => {
      fireEvent.keyDown(document.activeElement!, { key });
    };
    button("orchestrator")!.focus();
    press("ArrowRight");
    expect(focused()).toBe("lane:ask");
    press("ArrowRight");
    expect(focused()).toBe("agent:r1");
    press("ArrowLeft");
    expect(focused()).toBe("lane:ask");
    press("ArrowLeft");
    expect(button("lane:ask")!.closest("[role=treeitem]")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(focused()).toBe("lane:ask");
    press("ArrowRight");
    expect(button("lane:ask")!.closest("[role=treeitem]")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    // A folded lane: → opens it, and only then enters it.
    // r1, 処理中, i1, p1, 待機, research, v1, then 完了's heading.
    for (let step = 0; step < 8; step += 1) press("ArrowDown");
    expect(focused()).toBe("lane:closed");
    press("ArrowRight");
    expect(focused()).toBe("lane:closed");
    press("ArrowRight");
    expect(focused()).toBe("workspace:finished");
    // ← from a lane's heading goes to the Orchestrator row, and ← there folds
    // the whole group.
    press("ArrowLeft");
    press("ArrowLeft");
    press("ArrowLeft");
    expect(focused()).toBe("orchestrator");
    press("ArrowLeft");
    expect(orchestratorItem()).toHaveAttribute("aria-expanded", "false");
    expect(focused()).toBe("orchestrator");
    press("ArrowDown");
    expect(focused()).toBe(`workspace:${SCRATCH_ID}`);
  });

  it("keeps the keyboard on a row whose lane changed, and on the heading of a lane folded under it", () => {
    const view = mount();
    button("agent:i1")!.focus();
    expect(focused()).toBe("agent:i1");
    // i1's work now waits for the person: its row moves to 要回答.
    view.update(
      snapshot(),
      board({ agentStates: { ...STATES, ...bound(["i1", 5, "answer"]) } }),
    );
    expect(lanes()[0]!.items).toEqual(["agent:r1", "agent:i1"]);
    expect(focused()).toBe("agent:i1");
    expect(button("agent:i1")).toHaveAttribute("tabindex", "0");
    // Folding its lane with the mouse hands the keyboard to the heading.
    fireEvent.click(button("lane:ask")!);
    expect(focused()).toBe("lane:ask");
  });
});

describe("a lane change under the pointer", () => {
  it("waits while the pointer is in use in the group, and lands when it leaves", () => {
    const view = mount();
    const group = orchestratorItem();
    fireEvent.pointerMove(group);
    view.update(
      snapshot(),
      board({ agentStates: { ...STATES, ...bound(["p1", 1, "answer"]) } }),
    );
    // p1 is still drawn where it was; its row is live.
    expect(lanes().find((one) => one.lane === "progress")!.items).toEqual([
      "agent:i1",
      "agent:p1",
    ]);
    fireEvent.pointerLeave(group);
    expect(lanes()[0]!.items).toEqual(["agent:r1", "agent:p1"]);
  });

  it("lands after the pointer has rested, and never while a button is held", () => {
    vi.useFakeTimers();
    const view = mount();
    const group = orchestratorItem();
    fireEvent.pointerDown(group);
    view.update(
      snapshot(),
      board({ agentStates: { ...STATES, ...bound(["p1", 1, "answer"]) } }),
    );
    act(() => {
      vi.advanceTimersByTime(POINTER_IDLE_MS * 2);
    });
    expect(lanes()[0]!.items).toEqual(["agent:r1"]);
    fireEvent.pointerUp(group);
    act(() => {
      vi.advanceTimersByTime(POINTER_IDLE_MS - 1);
    });
    expect(lanes()[0]!.items).toEqual(["agent:r1"]);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(lanes()[0]!.items).toEqual(["agent:r1", "agent:p1"]);
  });

  it("holds back a new item too, and never one that has gone", () => {
    const view = mount();
    const group = orchestratorItem();
    fireEvent.pointerMove(group);
    const value = snapshot();
    view.update(
      {
        ...value,
        workspaces: [
          ...value.workspaces.filter((one) => one.id !== "rounding"),
          workspace("arrived", [agent("n1", "arrived", "working")], true),
        ],
      } as unknown as AppSnapshot,
      board(),
    );
    expect(button("agent:r1")).toBeNull();
    expect(button("agent:n1")).toBeNull();
    fireEvent.pointerLeave(group);
    expect(button("agent:n1")).not.toBeNull();
  });
});

describe("a lane change once the board is read", () => {
  it("moves a row only once the change has stood, and not for a flicker", () => {
    vi.useFakeTimers();
    const read = (overrides: Partial<OrchestratorBoardWire> = {}) =>
      board({ revision: 1, ...overrides });
    const view = mount(snapshot(), read());
    const asked = read({
      agentStates: { ...STATES, ...bound(["i1", 5, "answer"]) },
    });
    // A flicker: there and back inside the settle time moves nothing.
    view.update(snapshot(), asked);
    act(() => {
      vi.advanceTimersByTime(SETTLE_MS / 2);
    });
    view.update(snapshot(), read());
    act(() => {
      vi.advanceTimersByTime(SETTLE_MS * 2);
    });
    expect(lanes()[0]!.items).toEqual(["agent:r1"]);
    // A change that stands lands after the settle time, not before.
    view.update(snapshot(), asked);
    act(() => {
      vi.advanceTimersByTime(SETTLE_MS - 1);
    });
    expect(lanes()[0]!.items).toEqual(["agent:r1"]);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(lanes()[0]!.items).toEqual(["agent:r1", "agent:i1"]);
  });
});

const railed = (value: AppSnapshot): AppSnapshot =>
  ({ ...value, sidebar: { ...value.sidebar, collapsed: true } }) as AppSnapshot;

/**
 * The rail and the Sidebar it grows into stand every row at the same y: the
 * pointer that went for a row in the rail finds it under it once the rail has
 * grown (or the other way, when compact mode is turned on). jsdom lays
 * nothing out, so the layout is taken in its two halves, which together are
 * the whole of what sets a row's y:
 *
 * - the rows: the same rows, in the same order, in the same boxes, with the
 *   same classes, for every fold of the group and its lanes and any number
 *   of items — so whatever the stylesheets give a row in one mode they give
 *   it in the other;
 * - the stylesheets: what they say only of the rail (`data-collapsed`) or
 *   only of the tree growing in or out of it (`data-tree`) sets nothing
 *   vertical on a box a row's y depends on — no height, margin, padding,
 *   line or display of a row, a group or the tree; inside a row's first
 *   line, nothing taller than its floor. Both densities and both title-bar
 *   arrangements are tokens these rules read, so they are covered by both.
 *
 * See `docs/orchestrator.md`, "In the rail".
 */
describe("the rail and the expanded Sidebar", () => {
  const FOLDS_KEY = "devhub.sidebar.orchestratorFolds";
  const LANE_IDS = ["ask", "progress", "waiting", "closed"] as const;

  /** Every row's box, from the tree down: what a row's y is made of. */
  const rowBoxes = () =>
    [
      ...screen
        .getByRole("tree", { name: "Open workspaces" })
        .querySelectorAll<HTMLElement>(
          ".sidebar-row, .sidebar-section-heading, .sidebar-empty",
        ),
    ].map((row) => {
      const path: string[] = [];
      for (
        let node: HTMLElement | null = row;
        node !== null && node.getAttribute("role") !== "tree";
        node = node.parentElement
      ) {
        path.unshift(
          `${node.tagName.toLowerCase()}.${[...node.classList].sort().join(".")}`,
        );
      }
      const id = row.querySelector<HTMLElement>("[data-tree-item-id]")?.dataset[
        "treeItemId"
      ];
      return `${id ?? "-"} ${path.join(" > ")}`;
    });

  const both = (value: AppSnapshot, boardValue: OrchestratorBoardWire) => {
    mount(value, boardValue);
    const expanded = rowBoxes();
    cleanup();
    mount(railed(value), boardValue);
    const rail = rowBoxes();
    cleanup();
    return { expanded, rail };
  };

  it("draws the same rows in the same boxes, every lane folded or not, the group folded or not", () => {
    for (let mask = 0; mask < 2 ** LANE_IDS.length; mask++) {
      for (const group of [false, true]) {
        const folds = {
          group,
          lanes: Object.fromEntries(
            LANE_IDS.map((lane, index) => [lane, (mask & (1 << index)) !== 0]),
          ),
        };
        window.sessionStorage.setItem(FOLDS_KEY, JSON.stringify(folds));
        const { expanded, rail } = both(snapshot(), board());
        expect(rail, JSON.stringify(folds)).toEqual(expanded);
        // The group is there in both: each open lane's items under it.
        const lanesDrawn = expanded.filter((row) => row.startsWith("lane:"));
        expect(lanesDrawn).toHaveLength(group ? 0 : LANE_IDS.length);
      }
    }
  });

  it("draws the same rows with nothing under the Orchestrator, and with one item", () => {
    const none = both(snapshot({ empty: true }), board());
    expect(none.rail).toEqual(none.expanded);
    expect(none.expanded.some((row) => row.startsWith("lane:"))).toBe(false);
    const value = snapshot();
    const one = {
      ...value,
      workspaces: value.workspaces.filter(
        (each) =>
          ![
            "rounding",
            "investigate",
            "invoice",
            "review",
            "finished",
          ].includes(each.id),
      ),
    } as AppSnapshot;
    const single = both(one, board());
    expect(single.rail).toEqual(single.expanded);
    expect(single.expanded.filter((row) => row.startsWith("lane:"))).toEqual([
      expect.stringMatching(/^lane:waiting /),
    ]);
  });

  const stylesheet = (path: string) =>
    readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );

  /** Each rule's selectors and declarations, `@media` and the like opened. */
  const rules = (css: string) => {
    const found: { selector: string; body: string }[] = [];
    const pattern = /([^{}@]+)\{([^{}]*)\}/g;
    for (const match of css.matchAll(pattern)) {
      for (const selector of match[1]!.split(","))
        found.push({ selector: selector.trim(), body: match[2]! });
    }
    return found;
  };

  it("says nothing vertical of a row's boxes only in the rail, or as the tree grows", () => {
    const css = [
      "../../styles/tokens.css",
      "../../styles/shell.css",
      "../../styles/reorder.css",
      "../../sidebar/sidebarPage.css",
    ]
      .map(stylesheet)
      .join("\n");
    const modal = rules(css).filter(
      (rule) =>
        /\[data-(collapsed|tree)=/.test(rule.selector) &&
        // The pane itself (its width), and the usage rows at its foot,
        // under the scroll region, below every row.
        /\]\s+\S/.test(rule.selector) &&
        !/\.sidebar-usage/.test(rule.selector),
    );
    expect(modal.length).toBeGreaterThan(10);
    // What a row's y is made of: the tree, its items and groups, the rows
    // and their first line, the section heading.
    const box =
      /(\.sidebar-row|\.sidebar-tree-item|\.row-head|\.agent-tree|\.orchestrator-lanes|\.orchestrator-lane-items|\.workspace-tree|\.sidebar-section-heading|\.sidebar-scroll-region|\[role=treeitem\]|\.(workspace|agent|lane|orchestrator)-row)(:[a-z-]+)?$/;
    const vertical =
      /(^|;)\s*(height|min-height|max-height|margin(-top|-bottom|-block)?|padding(-top|-bottom|-block)?|top|bottom|line-height|font(-size)?|display|position|flex-direction|flex-wrap|inset|border(-top|-bottom|-block)?(-width)?|box-sizing|align-self|transform|translate|animation(-name)?)\s*:/g;
    const faults: string[] = [];
    for (const rule of modal) {
      const subject = rule.selector.split(/\s+/).at(-1)!;
      const declarations = [...rule.body.matchAll(vertical)].map(
        (match) => match[2]!,
      );
      if (box.test(subject)) {
        // A row's own boxes: only the inline axis may differ.
        const moved = declarations.filter(
          (name) =>
            // The tree growing in is a translation along x (`shell.css`,
            // "The tree growing in"), checked below.
            !(rule.selector.includes("data-tree=") && name === "animation"),
        );
        if (moved.length > 0) faults.push(`${rule.selector}: ${moved.join()}`);
        continue;
      }
      // Inside a row's first line: words and marks taken off, and marks
      // drawn at a size, none taller than the shortest floor (26px compact,
      // less 2 × 3px of padding).
      for (const match of rule.body.matchAll(
        /(^|;)\s*(height|min-height|line-height|font-size)\s*:\s*([^;]+)/g,
      )) {
        const px = /^(\d+(?:\.\d+)?)px$/.exec(match[3]!.trim());
        if (px === null || Number(px[1]) > 16)
          faults.push(`${rule.selector}: ${match[2]!}: ${match[3]!.trim()}`);
      }
      for (const match of rule.body.matchAll(
        /(^|;)\s*(display|position)\s*:\s*([^;]+)/g,
      )) {
        if (!/^(none|absolute)$/.test(match[3]!.trim()))
          faults.push(`${rule.selector}: ${match[2]!}: ${match[3]!.trim()}`);
      }
    }
    expect(faults).toEqual([]);
    // The tree growing in moves along x only.
    const growth = /@keyframes sidebar-tree-indent-in\s*\{([\s\S]*?)\n\}/.exec(
      css,
    );
    expect(growth?.[1]).toMatch(/translateX\(/);
    expect(growth?.[1]).not.toMatch(
      /translateY|translate\(|scale\(|top|margin/,
    );
  });
});

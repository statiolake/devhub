// @vitest-environment jsdom

/**
 * The orchestrator's work under the Orchestrator row, by lane
 * (`orchestratorLanes.ts`, `docs/orchestrator.md`, "The orchestrator's work
 * in the Sidebar"): which items are there (by the managed flag), in which lane,
 * folded how, walked by which keys, and what holds still.
 */

import "@testing-library/jest-dom/vitest";
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
  type EscalationWire,
  type OrchestratorBoardWire,
} from "../../../ipc/contract";
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

function escalation(
  id: number,
  state: EscalationWire["state"],
  agents: readonly string[],
): EscalationWire {
  return {
    id,
    title: `#${String(id)}`,
    state,
    entries: [],
    agents: agents.map((agentId) => ({ agentId })),
    links: [],
    createdAt: 0,
    updatedAt: 0,
    stateSince: 0,
  };
}

function board(
  overrides: Partial<OrchestratorBoardWire> = {},
): OrchestratorBoardWire {
  return {
    ...EMPTY_BOARD,
    orchestratorAgentId: "orch",
    needsAnswer: [escalation(1, "needs_answer", ["r1"])],
    waiting: [escalation(2, "waiting", ["v1"])],
    agentStates: {
      research: { needsAction: "idle_no_escalation" },
      v1: { waiting: { escalationId: 2, trigger: "deploy" } },
    },
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
  it("is the first that holds: 要回答, 要対応, 対応中, 待機中, else 完了", () => {
    const value = board({
      inProgress: [escalation(3, "in_progress", ["x"])],
      agentStates: {
        y: { needsAction: "idle_no_escalation" },
        k: { kept: { note: "review", at: 0 } },
      },
    });
    const idle = (id: string) => ({ id, status: "idle" as const });
    expect(laneOf([idle("r1")], undefined, value)).toBe("ask");
    // An escalation about the Workspace, whoever its agents are.
    expect(
      laneOf(
        [],
        "ws",
        board({
          needsAnswer: [
            { ...escalation(4, "needs_answer", []), workspaceId: "ws" },
          ],
        }),
      ),
    ).toBe("ask");
    expect(laneOf([idle("y")], undefined, value)).toBe("action");
    expect(laneOf([idle("x")], undefined, value)).toBe("progress");
    expect(laneOf([{ id: "w", status: "working" }], undefined, value)).toBe(
      "progress",
    );
    expect(laneOf([idle("v1")], undefined, value)).toBe("waiting");
    expect(laneOf([idle("k")], undefined, value)).toBe("waiting");
    expect(laneOf([idle("z")], undefined, value)).toBe("closed");
    expect(laneOf([], "gone", value)).toBe("closed");
  });

  it("takes the helpers and the managed Workspaces, never the others", () => {
    const items = orchestratorItems(snapshot(), board());
    expect(items.map((item) => [item.key, item.lane])).toEqual([
      ["agent:research", "action"],
      ["workspace:rounding", "ask"],
      ["workspace:investigate", "progress"],
      ["workspace:invoice", "waiting"],
      ["workspace:review", "progress"],
      ["workspace:finished", "closed"],
    ]);
  });
});

describe("the Orchestrator row's group", () => {
  it("draws the board's lanes in its order, 待機中 and 完了 folded, the person's Workspaces where they were", () => {
    mount();
    expect(lanes()).toEqual([
      { lane: "ask", open: true, count: "1", items: ["agent:r1"] },
      { lane: "action", open: true, count: "1", items: ["agent:research"] },
      {
        lane: "progress",
        open: true,
        count: "2",
        items: ["agent:i1", "agent:p1"],
      },
      { lane: "waiting", open: false, count: "1", items: [] },
      { lane: "closed", open: false, count: "1", items: [] },
    ]);
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
      ["action", true],
      ["progress", true],
      ["waiting", false],
      ["closed", false],
    ]);
  });

  it("is not drawn on the rail, where the Orchestrator's mark carries the badge", () => {
    const value = snapshot();
    mount({
      ...value,
      sidebar: { ...value.sidebar, collapsed: true },
    } as AppSnapshot);
    expect(within(orchestratorItem()).queryByRole("group")).toBeNull();
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
    // r1, 要対応, research, 対応中, i1, p1, then 待機中's heading.
    for (let step = 0; step < 7; step += 1) press("ArrowDown");
    expect(focused()).toBe("lane:waiting");
    press("ArrowRight");
    expect(focused()).toBe("lane:waiting");
    press("ArrowRight");
    expect(focused()).toBe("agent:v1");
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
      board({
        needsAnswer: [
          escalation(1, "needs_answer", ["r1"]),
          escalation(5, "needs_answer", ["i1"]),
        ],
      }),
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
      board({
        inProgress: [],
        needsAnswer: [escalation(1, "needs_answer", ["r1", "p1"])],
      }),
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
      board({ needsAnswer: [escalation(1, "needs_answer", ["r1", "p1"])] }),
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
      needsAnswer: [
        escalation(1, "needs_answer", ["r1"]),
        escalation(5, "needs_answer", ["i1"]),
      ],
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

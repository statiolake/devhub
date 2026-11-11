/**
 * The orchestrator's work in the Sidebar: what is drawn under the Orchestrator
 * row, and in which lane (`docs/orchestrator.md`, "The orchestrator's work in
 * the Sidebar").
 *
 * Shared: the Sidebar draws it, and main counts the 対応中 lane with it for
 * saving mode's "no nudge while two or more tasks are in progress"
 * (`main/orchestrator/mode.ts`), so the rule and the heading cannot disagree.
 *
 * **What is there.** Two kinds of item, read off the snapshot and never
 * stored here:
 *
 * - the helpers: the Agents in the Orchestrator row's own Workspace but the
 *   orchestrator agent itself (they were under the row before lanes, too);
 * - the Workspaces the orchestrator manages (`managed`: the same flag as an
 *   Agent's, kept in `state.json`) — set when its side opened the folder,
 *   when one of its Agents was put under management, or by `workspace
 *   manage` and the row's Manage with Orchestrator — whoever's Agents are in
 *   them now, and with none. Only Scratch's managed Agents stay where they
 *   are, with their wash: Scratch is a row of its own.
 *
 * **Which lane.** The board's lanes, in the board's order, plus 要対応 (the
 * invariant's "needs action", which the board lists above its lanes). An item
 * is in the first lane that holds of it:
 *
 * 1. 要回答 — an open escalation about it waits for the person's answer;
 * 2. 要対応 — one of its Agents breaks the invariant (`agentStates.needsAction`);
 * 3. 対応中 — an escalation about it is 対応中, or one of its Agents is at
 *    work (`working`, `background`, `waiting` on a prompt, `unknown` while
 *    it is read);
 * 4. 待機中 — an escalation about it is 待機中, or one of its Agents is
 *    stopped and fine: on a 待機中 escalation, or kept by the orchestrator;
 * 5. 完了 — nothing about it is open: no Agent left, or its Agents idle with
 *    nothing waiting on them (their escalation closed, or one the person
 *    started and left). The board's 完了 is "closed": this is the same word
 *    for the same fact, an item with nothing open.
 *
 * An escalation is about an item when its `workspaceId` is the item's
 * Workspace or one of its Agents is the item's (for a helper: the helper).
 */

import type {
	AgentSnapshot,
	AppSnapshot,
	WorkspaceSnapshot,
} from "./appShell.js";
import { sidebarWorkspaces } from "./appShell.js";
import type { EscalationWire, OrchestratorBoardWire } from "./contract.js";

export type LaneId = "ask" | "action" | "progress" | "waiting" | "closed";

export interface LaneSpec {
	readonly id: LaneId;
	/** The board's word for it. */
	readonly title: string;
	/** What it means, for the tooltip. */
	readonly hint: string;
	/** Folded when the session starts: 待機中 and 完了, as on the board. */
	readonly startsFolded: boolean;
}

/** In the board's order. */
export const LANES: readonly LaneSpec[] = [
	{
		id: "ask",
		title: "要回答",
		hint: "An escalation about it waits for your answer.",
		startsFolded: false,
	},
	{
		id: "action",
		title: "要対応",
		hint: "One of its agents needs action: managed, stopped, and nothing settles it.",
		startsFolded: false,
	},
	{
		id: "progress",
		title: "対応中",
		hint: "In progress: an agent is at work, or the orchestrator is carrying out an answer.",
		startsFolded: false,
	},
	{
		id: "waiting",
		title: "待機中",
		hint: "Stopped and fine: waiting on an outside condition, or kept by the orchestrator.",
		startsFolded: true,
	},
	{
		id: "closed",
		title: "完了",
		hint: "Nothing open: its agents are done, or it has none left.",
		startsFolded: true,
	},
];

export type OrchestratorItem =
	| {
			readonly kind: "helper";
			/** `agent:<id>`: the item's identity across lanes and commits. */
			readonly key: string;
			readonly agent: AgentSnapshot;
			/** The Orchestrator row's Workspace, which the helper runs in. */
			readonly workspace: WorkspaceSnapshot;
			readonly lane: LaneId;
	  }
	| {
			readonly kind: "workspace";
			/** `workspace:<id>`. */
			readonly key: string;
			readonly workspace: WorkspaceSnapshot;
			readonly lane: LaneId;
	  };

/** What of the board the lanes are read off: no delivery, no GitHub. */
export type LaneBoard = Pick<
	OrchestratorBoardWire,
	"needsAnswer" | "inProgress" | "waiting" | "agentStates"
>;

const AT_WORK = new Set(["working", "background", "waiting", "unknown"]);

/** The lane of an item with these Agents, in this Workspace. */
export function laneOf(
	agents: readonly Pick<AgentSnapshot, "id" | "status">[],
	workspaceId: string | undefined,
	board: LaneBoard,
): LaneId {
	const ids = new Set(agents.map((agent) => agent.id));
	const about = (escalation: EscalationWire): boolean =>
		(workspaceId !== undefined && escalation.workspaceId === workspaceId) ||
		escalation.agents.some((ref) => ids.has(ref.agentId));
	const states = board.agentStates;
	if (board.needsAnswer.some(about)) return "ask";
	if (agents.some((agent) => states[agent.id]?.needsAction !== undefined))
		return "action";
	if (
		board.inProgress.some(about) ||
		agents.some((agent) => AT_WORK.has(agent.status))
	)
		return "progress";
	if (
		board.waiting.some(about) ||
		agents.some(
			(agent) =>
				states[agent.id]?.waiting !== undefined ||
				states[agent.id]?.kept !== undefined,
		)
	)
		return "waiting";
	return "closed";
}

/**
 * Everything under the Orchestrator row, each with its lane: the helpers
 * first, as they are listed in their Workspace, then the Workspaces the
 * orchestrator opened, in the order they arrive in. A lane keeps that order.
 */
export function orchestratorItems(
	snapshot: Pick<
		AppSnapshot,
		| "workspaces"
		| "scratchWorkspaceId"
		| "orchestratorWorkspaceId"
		| "orchestratorAgentId"
	>,
	board: LaneBoard,
): readonly OrchestratorItem[] {
	const { orchestrator, managed } = sidebarWorkspaces(snapshot);
	const helpers: OrchestratorItem[] =
		orchestrator === undefined
			? []
			: orchestrator.agents
					.filter((agent) => agent.id !== snapshot.orchestratorAgentId)
					.map((agent) => ({
						kind: "helper",
						key: `agent:${agent.id}`,
						agent,
						workspace: orchestrator,
						lane: laneOf([agent], undefined, board),
					}));
	const workspaces: OrchestratorItem[] = managed.map((workspace) => ({
		kind: "workspace",
		key: `workspace:${workspace.id}`,
		workspace,
		lane: laneOf(
			workspace.agents.filter(
				(agent) => agent.id !== snapshot.orchestratorAgentId,
			),
			workspace.id,
			board,
		),
	}));
	return [...helpers, ...workspaces];
}

export interface LaneGroup<T> {
	readonly lane: LaneSpec;
	readonly items: readonly T[];
}

/**
 * The lanes with something in them, in the board's order, each with its items
 * in the order given. An empty lane has no heading.
 */
export function groupByLane<T>(
	items: readonly T[],
	laneOfItem: (item: T) => LaneId,
): readonly LaneGroup<T>[] {
	return LANES.map((lane) => ({
		lane,
		items: items.filter((item) => laneOfItem(item) === lane.id),
	})).filter((group) => group.items.length > 0);
}

/**
 * How many items are in 対応中 now: the number the Sidebar's 対応中 heading
 * shows, before its settle delay. Saving mode holds every nudge while this is
 * two or more.
 */
export function inProgressCount(
	snapshot: Parameters<typeof orchestratorItems>[0],
	board: LaneBoard,
): number {
	return orchestratorItems(snapshot, board).filter(
		(item) => item.lane === "progress",
	).length;
}

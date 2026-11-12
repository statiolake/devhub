/**
 * The orchestrator's work in the Sidebar: what is drawn under the Orchestrator
 * row, and under which status (`docs/orchestrator.md`, "The orchestrator's
 * work in the Sidebar").
 *
 * **What is there.** Two kinds of item, read off the snapshot and never
 * stored here:
 *
 * - the helpers: the Agents in the Orchestrator row's own Workspace but the
 *   orchestrator agent itself;
 * - the Workspaces the orchestrator manages (`managed`: the same flag as an
 *   Agent's, kept in `state.json`) — set when its side opened the folder,
 *   when one of its Agents was put under management, or by `workspace
 *   manage` and the row's Manage with Orchestrator — whoever's Agents are in
 *   them now, and with none. Only Scratch's managed Agents stay where they
 *   are, with their wash: Scratch is a row of its own.
 *
 * **Which status.** The board's task statuses, in the board's order. An item
 * is under the first that holds of the tasks its Agents are bound to (or, for
 * a Workspace, the open tasks with an agent that ran there):
 *
 * 1. 回答待ち — one of those tasks has an open escalation;
 * 2. 処理中 — one is 処理中, or one of its Agents is at work (`working`,
 *    `background`, `waiting` on a prompt, `unknown` while it is read);
 * 3. 待機 — one is 待機, or one of its Agents needs action with no task
 *    (stopped, bound to nothing: the △ says so);
 * 4. 完了 — nothing about it is open: its tasks are done, or it has none.
 *
 * Needing action (要対応) is not a place: it is the △ on the row
 * (`agentStates.needsAction`), wherever the row stands.
 */

import type {
	AgentSnapshot,
	AppSnapshot,
	WorkspaceSnapshot,
} from "./appShell.js";
import { sidebarWorkspaces } from "./appShell.js";
import type { OrchestratorBoardWire, TaskWire } from "./contract.js";

export type LaneId = "ask" | "progress" | "waiting" | "closed";

export interface LaneSpec {
	readonly id: LaneId;
	/** The board's word for it. */
	readonly title: string;
	/** What it means, for the tooltip. */
	readonly hint: string;
	/** Folded when the session starts: 完了, as on the board. */
	readonly startsFolded: boolean;
}

/** In the board's order. */
export const LANES: readonly LaneSpec[] = [
	{
		id: "ask",
		title: "回答待ち",
		hint: "Its task has a question waiting for your answer.",
		startsFolded: false,
	},
	{
		id: "progress",
		title: "処理中",
		hint: "Its task is in progress, or an agent is at work.",
		startsFolded: false,
	},
	{
		id: "waiting",
		title: "待機",
		hint: "Its task is parked by the orchestrator, or it has no task yet.",
		startsFolded: false,
	},
	{
		id: "closed",
		title: "完了",
		hint: "Nothing open: its tasks are done, or it has none left.",
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
	"answer" | "inProgress" | "waiting" | "agentStates"
>;

const AT_WORK = new Set(["working", "background", "waiting", "unknown"]);

/**
 * The lane of an item with these Agents, in this Workspace (a Workspace's
 * open tasks include those whose agent ran there and has stopped).
 */
export function laneOf(
	agents: readonly Pick<AgentSnapshot, "id" | "status">[],
	workspaceId: string | undefined,
	board: LaneBoard,
): LaneId {
	const states = board.agentStates;
	const statuses = new Set<string>();
	for (const agent of agents) {
		const status = states[agent.id]?.task?.status;
		if (status !== undefined) statuses.add(status);
	}
	if (workspaceId !== undefined) {
		const here = (task: TaskWire) =>
			task.agents.some((agent) => agent.workspaceId === workspaceId);
		if (board.answer.some(here)) statuses.add("answer");
		if (board.inProgress.some(here)) statuses.add("in_progress");
		if (board.waiting.some(here)) statuses.add("waiting");
	}
	if (statuses.has("answer")) return "ask";
	if (
		statuses.has("in_progress") ||
		agents.some((agent) => AT_WORK.has(agent.status))
	)
		return "progress";
	if (
		statuses.has("waiting") ||
		agents.some((agent) => states[agent.id]?.needsAction !== undefined)
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

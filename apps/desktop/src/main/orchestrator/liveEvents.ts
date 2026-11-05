/**
 * The Workspace and Agent event sources: what DevHub's own projection says
 * happened, worded as `workspace.*` and `agent.*` events.
 *
 * Both are read off the projection the window draws — the Workspaces, the
 * Agents and their statuses, and the branch and pull request the Sidebar
 * shows for each Workspace (`RepositoryStatusWire`, the same GitHub data the
 * row's tooltip and `workspace status` read) — on every projection change,
 * and diffed against the last reading. The first reading after an
 * orchestrator starts is the **baseline**: it says nothing, so starting one
 * is not a flood of "opened" and "started".
 *
 * `workspace.issue_assigned` is not read here: it is said where DevHub
 * assigns an Issue (`assignIssue` in the controller).
 *
 * Nothing is said about the orchestrator itself; the dispatcher drops it
 * anyway (`events.ts`), and the orchestrator's own Workspace is left out.
 */

import {
	workStatus,
	type PendingRequest,
	type TranscriptEntry,
} from "../../model/conversation.js";
import type { EventAgent, EventItem, OrchestratorEvent } from "./events.js";

// --- Workspaces --------------------------------------------------------------

export interface LiveWorkspace {
	readonly id: string;
	/** As `ws=` names it (`workspaceToken`). */
	readonly ws: string;
	readonly root: string;
	/** The checked-out branch, once a round has read it. */
	readonly branch?: string;
	/** The pull request out from that branch, as the Sidebar has it. */
	readonly pullRequest?: EventItem;
	/** Its first agent that is not the orchestrator. */
	readonly agent?: EventAgent;
}

interface WorkspaceMemory {
	readonly ws: string;
	readonly root: string;
	readonly branch: string | undefined;
	readonly pullRequest: string | undefined;
}

export class WorkspaceEventSource {
	#known: Map<string, WorkspaceMemory> | undefined;

	constructor(private readonly dispatch: (event: OrchestratorEvent) => void) {}

	/** Forget everything: the next reading is a baseline again. */
	reset(): void {
		this.#known = undefined;
	}

	observe(workspaces: readonly LiveWorkspace[]): void {
		const before = this.#known;
		const next = new Map<string, WorkspaceMemory>();
		for (const workspace of workspaces) {
			const was = before?.get(workspace.id);
			next.set(workspace.id, {
				ws: workspace.ws,
				root: workspace.root,
				// A round that has not read it yet keeps what was known.
				branch: workspace.branch ?? was?.branch,
				pullRequest: workspace.pullRequest?.url ?? was?.pullRequest,
			});
		}
		this.#known = next;
		if (before === undefined) return;
		for (const workspace of workspaces) {
			const was = before.get(workspace.id);
			if (was === undefined)
				this.dispatch({
					type: "workspace.opened",
					ws: workspace.ws,
					path: workspace.root,
				});
			else if (
				workspace.branch !== undefined &&
				was.branch !== undefined &&
				workspace.branch !== was.branch
			)
				this.dispatch({
					type: "workspace.branch_changed",
					ws: workspace.ws,
					from: was.branch,
					to: workspace.branch,
				});
			const pr = workspace.pullRequest;
			if (pr?.url !== undefined && pr.url !== was?.pullRequest)
				this.dispatch({
					type: "workspace.pr_linked",
					ws: workspace.ws,
					pr,
					...(workspace.agent === undefined ? {} : { agent: workspace.agent }),
				});
		}
		for (const [id, was] of before)
			if (!next.has(id))
				this.dispatch({ type: "workspace.closed", ws: was.ws, path: was.root });
	}
}

// --- Agents --------------------------------------------------------------------

export interface LiveAgentReading {
	readonly id: string;
	readonly name: string;
	readonly ws?: string;
	/** The Sidebar's status: working, background, waiting, idle, error, unknown. */
	readonly status: string;
	/** Why its pane shows a failure, in DevHub's words; absent when none. */
	readonly failure?: string;
	readonly profile?: string;
	/** A GUI Agent: its conversation can be read. */
	readonly gui: boolean;
	/** What it says it is doing (a terminal Agent's only excerpt). */
	readonly activity?: string;
	/**
	 * Its turn running is upkeep, not work (`isMaintenanceTurn`: a
	 * `/compact`): read at the status it had before, so the turn neither
	 * starts nor ends one (`agent.turn_ended`).
	 */
	readonly maintenance?: boolean;
}

/** What is read of a GUI Agent's conversation (`TellConversation`'s half). */
export interface ConversationReading {
	entries(): readonly TranscriptEntry[];
	requests(): readonly PendingRequest[];
}

export interface AgentSourcePorts {
	readonly dispatch: (event: OrchestratorEvent) => void;
	readonly conversation: (
		agentId: string,
	) => Promise<ConversationReading | undefined>;
	/** Absent: a turn's end is said at once (tests). */
	readonly setTimer?: (ms: number, run: () => void) => { cancel(): void };
}

/** A status that ends a turn must hold this long (it flaps between tool calls). */
export const TURN_SETTLE_MS = 1500;

interface AgentMemory {
	reading: LiveAgentReading;
	/** Seen working by this source: the next idle is the end of a turn. */
	armed: boolean;
	/** Requests already said (or there at the baseline). */
	readonly requests: Set<string>;
	/** Its requests have been read once: the ones then were the baseline's. */
	requestsRead: boolean;
	settle: { cancel(): void } | undefined;
	reading$: boolean;
}

function ended(status: string): boolean {
	return status === "idle" || status === "background";
}

/** The text of an assistant entry, its text blocks joined. */
function textOf(entry: TranscriptEntry): string | undefined {
	if (entry.kind !== "assistant") return undefined;
	const text = entry.blocks
		.flatMap((block) => (block.kind === "text" ? [block.markdown] : []))
		.join(" ")
		.trim();
	return text.length === 0 ? undefined : text;
}

/**
 * The cursor this turn is read from (`agent read --since`): the message that
 * started it, and the start of its last message.
 */
export function turnOf(entries: readonly TranscriptEntry[]): {
	readonly since?: string;
	readonly excerpt?: string;
} {
	let start = -1;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const kind = entries[index]!.kind;
		if (kind === "user" || kind === "answer") {
			start = index;
			break;
		}
	}
	let excerpt: string | undefined;
	for (let index = entries.length - 1; index > start; index -= 1) {
		excerpt = textOf(entries[index]!);
		if (excerpt !== undefined) break;
	}
	return {
		...(start < 0 ? {} : { since: entries[start]!.id }),
		...(excerpt === undefined ? {} : { excerpt: excerpt.slice(0, 400) }),
	};
}

function requestWhat(request: PendingRequest): string | undefined {
	const subject = request.subject;
	switch (subject.kind) {
		case "tool":
			return subject.title || subject.tool;
		case "command":
			return subject.command;
		case "file-change":
			return subject.files.map((file) => file.path).join(", ");
		case "elicitation":
			return `${subject.server}: ${subject.message}`;
		case "question":
			return undefined;
	}
}

export class AgentEventSource {
	#known: Map<string, AgentMemory> | undefined;

	constructor(private readonly ports: AgentSourcePorts) {}

	reset(): void {
		for (const memory of this.#known?.values() ?? []) memory.settle?.cancel();
		this.#known = undefined;
	}

	observe(agents: readonly LiveAgentReading[]): void {
		const baseline = this.#known === undefined;
		const known = this.#known ?? new Map<string, AgentMemory>();
		this.#known = known;
		const live = new Set<string>();
		for (const reading of agents) {
			live.add(reading.id);
			const memory = known.get(reading.id);
			if (memory === undefined) {
				known.set(reading.id, {
					reading: { ...reading, status: workStatus(reading, undefined) },
					armed: workStatus(reading, undefined) === "working",
					requests: new Set(),
					// An agent new since the baseline has no requests to forgive.
					requestsRead: !baseline,
					settle: undefined,
					reading$: false,
				});
				if (!baseline)
					this.ports.dispatch({
						type: "agent.started",
						agent: { id: reading.id, name: reading.name },
						...(reading.ws === undefined ? {} : { ws: reading.ws }),
						...(reading.profile === undefined
							? {}
							: { profile: reading.profile }),
					});
				this.#readRequests(reading.id);
				continue;
			}
			this.#step(memory, reading);
		}
		for (const [id, memory] of [...known]) {
			if (live.has(id)) continue;
			memory.settle?.cancel();
			known.delete(id);
			this.ports.dispatch({
				type: "agent.exited",
				agent: { id, name: memory.reading.name },
				...(memory.reading.ws === undefined ? {} : { ws: memory.reading.ws }),
			});
		}
	}

	#step(memory: AgentMemory, seen: LiveAgentReading): void {
		const before = memory.reading;
		const reading =
			seen.maintenance === true
				? { ...seen, status: workStatus(seen, before.status) }
				: seen;
		memory.reading = reading;
		const agent = { id: reading.id, name: reading.name };
		const ws = reading.ws === undefined ? {} : { ws: reading.ws };
		const failed =
			(reading.failure !== undefined && reading.failure !== before.failure) ||
			(reading.status === "error" && before.status !== "error");
		if (failed) {
			memory.armed = false;
			memory.settle?.cancel();
			memory.settle = undefined;
			this.ports.dispatch({
				type: "agent.failed",
				agent,
				...ws,
				reason: reading.failure ?? "its status is error",
			});
			return;
		}
		if (reading.status === "working") {
			memory.armed = true;
			memory.settle?.cancel();
			memory.settle = undefined;
			return;
		}
		if (reading.status === "waiting" && before.status !== "waiting") {
			if (reading.gui) this.#readRequests(reading.id);
			else
				this.ports.dispatch({
					type: "agent.permission_requested",
					agent,
					...ws,
					...(reading.activity === undefined ? {} : { what: reading.activity }),
				});
		}
		if (ended(reading.status) && memory.armed && memory.settle === undefined) {
			const settle = () => {
				memory.settle = undefined;
				if (!memory.armed || !ended(memory.reading.status)) return;
				memory.armed = false;
				void this.#turnEnded(memory);
			};
			if (this.ports.setTimer === undefined) settle();
			else memory.settle = this.ports.setTimer(TURN_SETTLE_MS, settle);
		}
	}

	async #turnEnded(memory: AgentMemory): Promise<void> {
		const reading = memory.reading;
		const agent = { id: reading.id, name: reading.name };
		const ws = reading.ws === undefined ? {} : { ws: reading.ws };
		let turn: { since?: string; excerpt?: string } = {};
		if (reading.gui) {
			const conversation = await this.ports
				.conversation(reading.id)
				.catch(() => undefined);
			if (conversation !== undefined) {
				turn = turnOf(conversation.entries());
				this.#noteRequests(memory, conversation.requests());
			}
		} else if (reading.activity !== undefined) {
			turn = { excerpt: reading.activity };
		}
		this.ports.dispatch({ type: "agent.turn_ended", agent, ...ws, ...turn });
	}

	#readRequests(agentId: string): void {
		const memory = this.#known?.get(agentId);
		if (memory === undefined || !memory.reading.gui || memory.reading$) return;
		memory.reading$ = true;
		void this.ports
			.conversation(agentId)
			.catch(() => undefined)
			.then((conversation) => {
				memory.reading$ = false;
				if (conversation !== undefined && this.#known?.get(agentId) === memory)
					this.#noteRequests(memory, conversation.requests());
			});
	}

	#noteRequests(
		memory: AgentMemory,
		requests: readonly PendingRequest[],
	): void {
		const forgive = !memory.requestsRead;
		memory.requestsRead = true;
		const reading = memory.reading;
		const agent = { id: reading.id, name: reading.name };
		const ws = reading.ws === undefined ? {} : { ws: reading.ws };
		for (const request of requests) {
			if (memory.requests.has(request.id)) continue;
			memory.requests.add(request.id);
			if (forgive) continue;
			if (request.subject.kind === "question")
				this.ports.dispatch({
					type: "agent.asked",
					agent,
					...ws,
					request: request.id,
					headers: request.subject.questions.map(
						(question) => question.header || question.text,
					),
				});
			else {
				const what = requestWhat(request);
				this.ports.dispatch({
					type: "agent.permission_requested",
					agent,
					...ws,
					request: request.id,
					...(what === undefined ? {} : { what }),
				});
			}
		}
	}
}

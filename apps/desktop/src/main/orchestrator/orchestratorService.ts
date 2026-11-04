/**
 * The Orchestrator row's main-process half: the escalations, the board, and
 * the events the orchestrator agent is told.
 *
 * It owns no window and no agent. The controller hands it what it reads —
 * the agents as the Sidebar has them, the settings — and what it may do —
 * queue a message for an agent — and pushes the board to the pages whenever
 * it moves (`OrchestratorBoardWire`). The person's answer arrives from the
 * Agents page's bridge (`answer`), and that is the only door it has; the
 * `--tell` commands reach `raise`, `ask`, `close` and `link`, never `answer`.
 *
 * 不明 is worked out here from live state (`model/escalations.ts`,
 * `unaccountedAgents`): when an agent went idle is this service's own
 * reading of every snapshot, and an agent that crosses the grace is told to
 * the orchestrator once (`unaccounted` event) for each time it went idle.
 */

import type {
	EscalationWire,
	OrchestratorBoardWire,
	UnaccountedAgentWire,
} from "../../ipc/contract.js";
import {
	board,
	escalationState,
	isOpen,
	stateSince,
	UNACCOUNTED_GRACE_MS,
	type BoardAgent,
	type Escalation,
	type NewEscalation,
	type UnaccountedAgent,
} from "../../model/escalations.js";
import type { OrchestratorConfig } from "../../model/orchestratorSettings.js";
import type { EscalationStore } from "./escalationStore.js";
import { EventDispatcher, type OrchestratorEvent } from "./events.js";

/** One agent as the service reads it off the projection. */
export interface LiveAgent {
	readonly id: string;
	readonly name: string;
	readonly workspaceId: string;
	readonly workspaceLabel: string;
	readonly status: string;
	readonly stopping: boolean;
}

export interface OrchestratorServicePorts {
	readonly store: EscalationStore;
	readonly agents: () => readonly LiveAgent[];
	readonly settings: () => OrchestratorConfig;
	/** Why the window cannot start one now, in a sentence; undefined when it can. */
	readonly startProblem: () => string | undefined;
	/** Queue `text` as the person's message to `agentId`, held while it is mid-turn. */
	readonly deliver: (agentId: string, text: string) => void;
	/** The board moved: push it. */
	readonly publish: (board: OrchestratorBoardWire) => void;
	readonly now?: () => number;
	readonly setTimer?: (ms: number, run: () => void) => { cancel(): void };
	readonly log?: (line: string) => void;
}

/** How many closed escalations the board carries for its history. */
const CLOSED_SHOWN = 30;

export class OrchestratorService {
	readonly events: EventDispatcher;
	readonly #idleSince = new Map<string, number>();
	/** `agentId@idleSince`, once told: one event per stretch of idleness. */
	readonly #told = new Set<string>();
	#revision = 0;
	#timer: { cancel(): void } | undefined;
	#graceMs = UNACCOUNTED_GRACE_MS;

	constructor(private readonly ports: OrchestratorServicePorts) {
		this.events = new EventDispatcher({
			orchestrator: () => this.orchestratorAgentId,
			prompts: () => this.ports.settings(),
			deliver: (agentId, text) => {
				this.ports.deliver(agentId, text);
			},
			changed: () => {
				this.publish();
			},
			...(ports.log === undefined ? {} : { log: ports.log }),
		});
		ports.store.onChange(() => {
			this.publish();
		});
	}

	#now(): number {
		return (this.ports.now ?? Date.now)();
	}

	get orchestratorAgentId(): string | undefined {
		const id = this.ports.store.orchestratorAgentId;
		return id !== undefined && this.ports.agents().some((one) => one.id === id)
			? id
			: undefined;
	}

	/** For tests: a shorter grace. */
	setGrace(ms: number): void {
		this.#graceMs = ms;
	}

	// --- the orchestrator ----------------------------------------------------

	/** Assign the orchestrator agent, and tell it it has started. */
	assign(agentId: string, initPrompt?: string): void {
		this.ports.store.setOrchestrator(agentId);
		if (initPrompt !== undefined) this.ports.deliver(agentId, initPrompt);
		else this.events.dispatch({ kind: "init" });
	}

	release(): void {
		this.ports.store.setOrchestrator(undefined);
	}

	// --- escalations: the orchestrator's side ----------------------------------

	raise(request: NewEscalation): Escalation {
		return this.ports.store.create(request, this.#now());
	}

	ask(
		id: number,
		markdown: string,
		options: readonly string[] | undefined,
	): Escalation {
		return this.ports.store.ask(id, markdown, options, this.#now());
	}

	close(id: number, note: string | undefined): Escalation {
		return this.ports.store.close(id, note, this.#now());
	}

	link(id: number, agentId: string): Escalation {
		return this.ports.store.link(id, agentId, this.#now());
	}

	// --- the person's side -----------------------------------------------------

	/** The person's answer, from the window. Moves it to in_progress. */
	answer(id: number, markdown: string): Escalation {
		const answered = this.ports.store.answer(id, markdown, this.#now());
		const names = new Map(this.ports.agents().map((one) => [one.id, one.name]));
		this.events.dispatch({
			kind: "escalation_answered",
			escalationId: answered.id,
			title: answered.title,
			// Named as the person sees them, with the id to address them by.
			agents: answered.agents.map((id) => {
				const name = names.get(id);
				return name === undefined ? id : `${name} (${id})`;
			}),
		});
		return answered;
	}

	// --- live state ------------------------------------------------------------

	/**
	 * A new projection: who is idle since when, and who has crossed into 不明.
	 * Called on every snapshot; cheap, and idempotent.
	 */
	observe(): void {
		const now = this.#now();
		const agents = this.ports.agents();
		const live = new Set<string>();
		for (const agent of agents) {
			live.add(agent.id);
			if (agent.status === "idle") {
				if (!this.#idleSince.has(agent.id)) this.#idleSince.set(agent.id, now);
			} else {
				this.#idleSince.delete(agent.id);
			}
		}
		for (const id of [...this.#idleSince.keys()])
			if (!live.has(id)) this.#idleSince.delete(id);
		this.#announceUnaccounted(now);
		this.#schedule(now);
		this.publish();
	}

	/** 不明, now. */
	unaccounted(): readonly UnaccountedAgent[] {
		return this.#lanes(this.#now()).unaccounted;
	}

	#boardAgents(): readonly BoardAgent[] {
		return this.ports.agents().map((agent) => ({
			...agent,
			idleSince: this.#idleSince.get(agent.id),
		}));
	}

	#lanes(now: number) {
		return board(
			this.ports.store.all(),
			this.#boardAgents(),
			this.ports.store.orchestratorAgentId,
			now,
			this.#graceMs,
		);
	}

	#announceUnaccounted(now: number): void {
		// Only while there is an orchestrator to tell: an agent that went
		// unaccounted for before one started is on the board its init reads.
		if (this.orchestratorAgentId === undefined) return;
		for (const agent of this.#lanes(now).unaccounted) {
			const key = `${agent.agentId}@${String(agent.idleSince)}`;
			if (this.#told.has(key)) continue;
			this.#told.add(key);
			const event: OrchestratorEvent = {
				kind: "unaccounted",
				agentId: agent.agentId,
				name: agent.name,
				workspace: agent.workspaceLabel,
				idleSince: agent.idleSince,
			};
			this.events.dispatch(event);
		}
	}

	/** Wake when the next idle agent's grace is up, to say so. */
	#schedule(now: number): void {
		this.#timer?.cancel();
		this.#timer = undefined;
		const setTimer = this.ports.setTimer;
		if (setTimer === undefined) return;
		const due = [...this.#idleSince.values()]
			.map((since) => since + this.#graceMs - now)
			.filter((ms) => ms > 0);
		if (due.length === 0) return;
		this.#timer = setTimer(Math.min(...due) + 50, () => {
			this.#timer = undefined;
			this.observe();
		});
	}

	// --- the board -------------------------------------------------------------

	/** One escalation as the board and `--tell` carry it. */
	toWire(one: Escalation): EscalationWire {
		const agents = new Map(
			this.ports.agents().map((agent) => [agent.id, agent]),
		);
		return {
			id: one.id,
			title: one.title,
			state: escalationState(one),
			entries: one.entries.map((entry) => ({
				role: entry.role,
				markdown: entry.markdown,
				at: entry.at,
				...(entry.options === undefined ? {} : { options: entry.options }),
			})),
			agents: one.agents.map((agentId) => {
				const agent = agents.get(agentId);
				return agent === undefined
					? { agentId }
					: {
							agentId,
							name: agent.name,
							workspaceLabel: agent.workspaceLabel,
							status: agent.status,
						};
			}),
			...(one.workspaceId === undefined
				? {}
				: { workspaceId: one.workspaceId }),
			links: one.links,
			createdAt: one.createdAt,
			updatedAt: one.updatedAt,
			stateSince: stateSince(one),
			...(one.closed === undefined ? {} : { closed: one.closed }),
		};
	}

	/** Every escalation, closed ones included, as `--tell` lists them. */
	allWires(): readonly EscalationWire[] {
		return this.ports.store.all().map((one) => this.toWire(one));
	}

	wire(): OrchestratorBoardWire {
		const now = this.#now();
		const lanes = this.#lanes(now);
		const escalation = (one: Escalation) => this.toWire(one);
		const settings = this.ports.settings();
		const problem = this.ports.startProblem();
		const orchestrator = this.orchestratorAgentId;
		return {
			revision: this.#revision,
			...(orchestrator === undefined
				? {}
				: { orchestratorAgentId: orchestrator }),
			start: {
				...(settings.root === undefined ? {} : { root: settings.root }),
				...(settings.profile === undefined
					? {}
					: { profile: settings.profile }),
				...(settings.presentation === undefined
					? {}
					: { presentation: settings.presentation }),
				...(problem === undefined ? {} : { problem }),
			},
			paused: this.events.paused,
			held: this.events.held().length,
			needsAnswer: lanes.needsAnswer.map(escalation),
			inProgress: lanes.inProgress.map(escalation),
			closed: lanes.closed.slice(0, CLOSED_SHOWN).map(escalation),
			unaccounted: lanes.unaccounted.map(
				(one): UnaccountedAgentWire => ({ ...one }),
			),
			graceMs: this.#graceMs,
		};
	}

	/** Every escalation, closed ones included, for `--tell`. */
	escalations(): readonly Escalation[] {
		return this.ports.store.all();
	}

	open(): readonly Escalation[] {
		return this.ports.store.all().filter(isOpen);
	}

	#last: string | undefined;

	publish(): void {
		const next = this.wire();
		// Pushed only when something on it moved: `observe` runs on every
		// snapshot, and most of them move nothing here.
		const text = JSON.stringify({ ...next, revision: 0 });
		if (text === this.#last) return;
		this.#last = text;
		this.#revision += 1;
		this.ports.publish({ ...next, revision: this.#revision });
	}

	dispose(): void {
		this.#timer?.cancel();
	}
}

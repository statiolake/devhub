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
 * An escalation's agent going back to work is watched here too
 * (`#watchWorking`): a `needs_answer` escalation about it gets DevHub's note
 * and so moves to `in_progress` until the orchestrator asks again. When the
 * person set it going from that agent's own composer (`personSent`; not
 * `agent send`, not an event or a template), every open escalation about it
 * is told to the orchestrator (`escalation.human_direct`), since what was
 * said may answer or change it.
 *
 * 停滞 is worked out here from live state (`#stalledNow`): an escalation in
 * 対応中 that none of its agents is working on (status `working` or
 * `background`, not stopping) for longer than `STALLED_GRACE_MS`, told once per stretch
 * (`escalation.stalled`). A stretch starts at the latest of: its last entry,
 * the last time one of its agents was seen working, the orchestrator's
 * reading of the answer (`acknowledge`), this service's first reading. An
 * answer the orchestrator has not read yet is not 停滞:
 * `escalation_answered` already says it, and the clock starts once it is
 * read. `escalation_answered` carries the answer itself, so its delivery is
 * the reading (`#deliveredRead`), unless the answer was too long to carry
 * whole: then `escalation show` is, as it always also is.
 *
 * 待機中 (`escalation wait`): a waiting escalation whose time (`dueAt`) has
 * come is told once per wait (`escalation.wait_due`), and every
 * `[orchestrator] wait_reminder_interval` all of them are, as one line
 * (`escalation.waiting_reminder`; nothing when none waits). An agent of one
 * going working takes it out of 待機中 as it does out of 要回答.
 *
 * A maintenance turn (`isMaintenanceTurn`: a `/compact`, DevHub's keep-warm
 * one before the prompt cache goes cold or the person's) is not work: every
 * reading here goes by the status the agent had before it (`workStatus`), so
 * it writes no `resumed` / `direct` note, tells nothing, and does not end a
 * stalled stretch (停滞). A person's `/compact` is not
 * their words to the agent either: its mark goes with it.
 */

import type {
	EscalationWire,
	OrchestratorBoardWire,
} from "../../ipc/contract.js";
import {
	board,
	effortOf,
	escalationState,
	isOpen,
	priorityOf,
	stateSince,
	STALLED_GRACE_MS,
	type Escalation,
	type EscalationRank,
	currentWait,
	openOptions,
	type NewEscalation,
	type WaitRequest,
} from "../../model/escalations.js";
import type { OrchestratorConfig } from "../../model/orchestratorSettings.js";
import { workStatus } from "../../model/conversation.js";
import { agentAtWork } from "../../model/domain.js";
import { parseInterval } from "../../model/orchestratorSettings.js";
import type { EscalationStore } from "./escalationStore.js";
import {
	cappedWords,
	customTypeProblem,
	EventDispatcher,
	eventJson,
	type EventItem,
	type EventLogEntry,
	type OrchestratorEvent,
} from "./events.js";
import { OrchestratorTimers } from "./timers.js";
import {
	usageThresholdRelevant,
	type UsageWindowNow,
} from "./usageThresholds.js";

/** One agent as the service reads it off the projection. */
export interface LiveAgent {
	readonly id: string;
	readonly name: string;
	readonly workspaceId: string;
	readonly workspaceLabel: string;
	readonly status: string;
	readonly stopping: boolean;
	/** Its turn running is upkeep, not work (`isMaintenanceTurn`). */
	readonly maintenance?: boolean;
}

export interface OrchestratorServicePorts {
	readonly store: EscalationStore;
	readonly agents: () => readonly LiveAgent[];
	readonly settings: () => OrchestratorConfig;
	/** Why the window cannot start one now, in a sentence; undefined when it can. */
	readonly startProblem: () => string | undefined;
	/** Queue `text` as the person's message to `agentId`, held while it is mid-turn. */
	readonly deliver: (agentId: string, text: string) => void;
	/**
	 * Whether `agentId` cannot take a message now (mid-turn, on a question, or
	 * something still queued for it): events wait, and go out together.
	 */
	readonly busy?: (agentId: string) => boolean;
	/** The board moved: push it. */
	readonly publish: (board: OrchestratorBoardWire) => void;
	/**
	 * The pause moved: the sources that cost something follow it. On a resume
	 * the promise is awaited before the held events go (a catch-up poll).
	 */
	readonly paused?: (paused: boolean) => Promise<void> | void;
	/** How GitHub polling stands, for the board's header. */
	readonly github?: () => OrchestratorBoardWire["github"];
	/**
	 * Whether the Issue of a pending `github.unattended` still is unattended
	 * (open, mine, no agent linked). Absent: it always is.
	 */
	readonly githubUnattended?: (item: EventItem) => boolean;
	/**
	 * The person's last message to `agentId`, read off its conversation: its
	 * cursor (`agent read --since`) and its text. Undefined when it has none.
	 */
	readonly personMessage?: (
		agentId: string,
	) => Promise<PersonMessage | undefined> | PersonMessage | undefined;
	/**
	 * The orchestrator `agentId` has been delivered escalation `id`'s first
	 * `entries` entries in an event (`escalation_answered`, carried whole):
	 * as read as if it had run `escalation show` (`agent wait --any` stops
	 * reporting the answer).
	 */
	readonly acknowledged?: (
		agentId: string,
		id: number,
		entries: number,
	) => void;
	/**
	 * A plan window as the usage readout has it now, for a pending
	 * `usage.threshold` (`usageThresholds.ts`). Absent: not checked.
	 */
	readonly usageWindow?: (
		cli: string,
		window: string,
	) => UsageWindowNow | undefined;
	readonly now?: () => number;
	readonly setTimer?: (ms: number, run: () => void) => { cancel(): void };
	readonly log?: (line: string) => void;
}

/** The person's last message to an agent, as `escalation.human_direct` carries it. */
export interface PersonMessage {
	readonly since?: string;
	readonly text?: string;
}

/** How many closed escalations the board carries for its history. */
const CLOSED_SHOWN = 30;

/** One event in the log, as `orchestrator events` shows it. */
export interface EventLogView {
	readonly seq: number;
	readonly at: number;
	readonly type: string;
	readonly fate: string;
	readonly line: string;
	readonly into?: number;
	readonly event: Record<string, unknown>;
}

export class OrchestratorService {
	readonly events: EventDispatcher;
	/** `[[orchestrator.timers]]`, and `orchestrator timer` for this session. */
	readonly timers: OrchestratorTimers;
	/**
	 * The agents the person has just written to from their composer, until
	 * they are seen to take it up: `armed` once seen not working (a message
	 * held mid-turn starts the turn after the one running).
	 */
	readonly #direct = new Map<string, { armed: boolean }>();
	/** Each agent's status at the last projection: what moved to working. */
	readonly #status = new Map<string, string>();
	#revision = 0;
	#timer: { cancel(): void } | undefined;
	#graceMs = STALLED_GRACE_MS;
	/** The first reading: nothing before it was seen, so no stretch starts earlier. */
	#startedAt: number | undefined;
	/**
	 * Per open escalation, the last time one of its agents was seen working
	 * (or seen stop), and whether one was at the last reading.
	 */
	readonly #workedAt = new Map<number, { at: number; working: boolean }>();
	/** Per escalation, how many entries the orchestrator has read, and when. */
	readonly #read = new Map<number, { entries: number; at: number }>();
	/** `escalationId@since`, once told: one event per stalled stretch. */
	readonly #stalledTold = new Set<string>();
	/** `escalationId@waitSince`, once told: one `wait_due` per wait. */
	readonly #dueTold = new Set<string>();
	#reminder: { cancel(): void } | undefined;

	constructor(private readonly ports: OrchestratorServicePorts) {
		this.events = new EventDispatcher({
			orchestrator: () => this.orchestratorAgentId,
			settings: () => this.ports.settings(),
			deliver: (agentId, text) => {
				this.ports.deliver(agentId, text);
			},
			...(ports.busy === undefined ? {} : { busy: ports.busy }),
			relevant: (event) => this.#relevant(event),
			delivered: (events) => {
				this.#deliveredRead(events);
			},
			...(ports.paused === undefined ? {} : { paused: ports.paused }),
			changed: () => {
				this.publish();
			},
			now: () => this.#now(),
			...(ports.log === undefined ? {} : { log: ports.log }),
			...(ports.setTimer === undefined ? {} : { setTimer: ports.setTimer }),
		});
		this.timers = new OrchestratorTimers({
			defaults: () => this.ports.settings().timers,
			dispatch: (event) => {
				this.events.dispatch(event);
			},
			now: () => this.#now(),
			// Without a clock (tests) a timer is listed and never fires.
			setTimer: ports.setTimer ?? (() => ({ cancel: () => undefined })),
		});
		this.timers.sync();
		this.#scheduleReminder();
		ports.store.onChange(() => {
			this.publish();
		});
	}

	// --- events ---------------------------------------------------------------

	/** The last `last` events, oldest first, with what came of each. */
	eventLog(last: number): readonly EventLogView[] {
		return this.events.recent(last).map((entry) => this.#view(entry));
	}

	/** `orchestrator emit`: a `custom.*` event, like any source's. */
	emit(type: string, text: string): EventLogView {
		if (customTypeProblem(type))
			throw new Error(
				`--type is custom.NAME (lower-case letters, digits, - and _), not ${JSON.stringify(type)}.`,
			);
		return this.#view(
			this.events.dispatch({ type: type as `custom.${string}`, text }),
		);
	}

	#view(entry: EventLogEntry): EventLogView {
		return {
			seq: entry.seq,
			at: entry.at,
			type: entry.event.type,
			fate: entry.fate,
			line: this.events.line(entry.event),
			...(entry.into === undefined ? {} : { into: entry.into }),
			event: eventJson(entry.event),
		};
	}

	#now(): number {
		return (this.ports.now ?? Date.now)();
	}

	/**
	 * Whether a pending event still needs the orchestrator, by live state,
	 * just before it goes: an escalation no longer stalled, a turn
	 * whose agent is working again (or gone), a question or a permission
	 * prompt no longer waiting, an answer to an escalation since closed —
	 * these have been seen to already.
	 */
	#relevant(event: OrchestratorEvent): boolean {
		const agent = (id: string) => this.#agents().find((one) => one.id === id);
		switch (event.type) {
			case "agent.turn_ended": {
				const live = agent(event.agent.id);
				// At work again — working, or background (`agentAtWork`) — it is
				// not done after all; its real end will be said.
				return live !== undefined && !agentAtWork(live.status);
			}
			case "agent.asked":
			case "agent.permission_requested":
				return agent(event.agent.id)?.status === "waiting";
			case "agent.started":
				return agent(event.agent.id) !== undefined;
			case "escalation.wait_due": {
				const one = this.ports.store
					.all()
					.find((escalation) => escalation.id === event.escalationId);
				return one !== undefined && currentWait(one)?.at === event.waitSince;
			}
			case "escalation.waiting_reminder":
				return this.ports.store
					.all()
					.some(
						(one) =>
							currentWait(one) !== undefined &&
							event.waiting.some((item) => item.escalationId === one.id),
					);
			case "escalation.stalled":
				return this.#stalledNow(this.#now()).some(
					(one) =>
						one.escalation.id === event.escalationId &&
						one.since === event.since,
				);
			case "escalation_answered":
			case "escalation.human_direct": {
				const one = this.ports.store
					.all()
					.find((escalation) => escalation.id === event.escalationId);
				return one !== undefined && one.closed === undefined;
			}
			case "github.unattended":
				return this.ports.githubUnattended?.(event.item) ?? true;
			case "usage.threshold":
				return usageThresholdRelevant(
					event,
					this.ports.usageWindow?.(event.cli, event.window),
					this.#now(),
				);
			default:
				return true;
		}
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
		else this.events.dispatch({ type: "init" });
	}

	release(): void {
		this.ports.store.setOrchestrator(undefined);
	}

	// --- escalations: the orchestrator's side ----------------------------------

	raise(request: NewEscalation): Escalation {
		const made = this.ports.store.create(request, this.#now());
		// Born waiting, maybe on a time: the timer looks for it.
		if (request.wait !== undefined) this.observe();
		return made;
	}

	ask(
		id: number,
		markdown: string,
		options: readonly string[] | undefined,
		links: readonly string[] = [],
	): Escalation {
		return this.ports.store.ask(id, markdown, options, this.#now(), links);
	}

	close(id: number, note: string | undefined): Escalation {
		return this.ports.store.close(id, note, this.#now());
	}

	/**
	 * `escalation hold`: the orchestrator parks it in 対応中 while it works on
	 * it. A `held` note, on the orchestrator's side: never an answer.
	 */
	hold(id: number, note: string | undefined): Escalation {
		return this.ports.store.hold(id, note, this.#now());
	}

	/**
	 * `escalation wait`: parked on an outside condition, its trigger in words
	 * and maybe a time. 待機中 until it is asked, answered, resumed or closed.
	 */
	wait(id: number, request: WaitRequest): Escalation {
		const waiting = this.ports.store.wait(id, request, this.#now());
		this.observe();
		return waiting;
	}

	/** `escalation resume`: off its wait, to 対応中. */
	resume(id: number, note: string | undefined): Escalation {
		return this.ports.store.resume(id, note, this.#now());
	}

	link(id: number, agentId: string): Escalation {
		return this.ports.store.link(id, agentId, this.#now());
	}

	/** The id `raise` will give the next one: its pictures' folder is named for it. */
	/** One escalation, as stored — for the window's title. */
	escalation(id: number): Escalation | undefined {
		return this.ports.store.get(id);
	}

	nextEscalationId(): number {
		return this.ports.store.nextId;
	}

	rank(id: number, rank: EscalationRank): Escalation {
		return this.ports.store.rank(id, rank, this.#now());
	}

	// --- the person's side -----------------------------------------------------

	/** The person's answer, from the window. Moves it to in_progress. */
	answer(id: number, markdown: string): Escalation {
		const before = this.ports.store.all().find((one) => one.id === id);
		// A quick reply is sent as the option's own words.
		const option =
			before === undefined
				? undefined
				: openOptions(before).find((one) => one === markdown.trim());
		const answered = this.ports.store.answer(id, markdown, this.#now());
		const names = new Map(this.ports.agents().map((one) => [one.id, one.name]));
		this.events.dispatch({
			type: "escalation_answered",
			escalationId: answered.id,
			title: answered.title,
			// Named as the person sees them, with the id to address them by.
			agents: answered.agents.map((id) => {
				const name = names.get(id);
				return name === undefined ? { id } : { id, name };
			}),
			answers: [
				{
					text: answered.entries.at(-1)?.markdown ?? markdown,
					...(option === undefined ? {} : { option }),
				},
			],
			readThrough: answered.entries.length,
		});
		return answered;
	}

	/**
	 * The person sent `agentId` a message from its own composer in the window
	 * — the conversation IPC's submit, and nothing else (`agent send`, the
	 * orchestrator's events and templates never come here). Told once the
	 * agent is seen to start working on it (`observe`).
	 */
	personSent(agentId: string): void {
		const live = this.ports.agents().find((one) => one.id === agentId);
		if (live === undefined) return;
		this.#direct.set(agentId, { armed: live.status !== "working" });
	}

	/**
	 * Every agent that went from waiting (idle, or stopped on a question) to
	 * working since the last projection: a `needs_answer` escalation about it
	 * leaves 要回答 (DevHub's note: `direct` when the person's own composer
	 * set it going, `resumed` for anything else), and stays out until the
	 * orchestrator asks again. Only the person's words are told (`escalation.
	 * human_direct`, for every open escalation about the agent): anything
	 * else the orchestrator caused, or hears of as `agent.turn_ended`.
	 */
	#watchWorking(agents: readonly LiveAgent[], now: number): void {
		const before = new Map(this.#status);
		this.#status.clear();
		for (const agent of agents) {
			this.#status.set(agent.id, agent.status);
			const mark = this.#direct.get(agent.id);
			// The person's `/compact`: upkeep they asked for, not their words.
			if (agent.maintenance === true && mark?.armed === true)
				this.#direct.delete(agent.id);
			if (agent.status !== "working") {
				if (mark !== undefined) mark.armed = true;
				continue;
			}
			const was = before.get(agent.id);
			if (was !== "idle" && was !== "waiting") continue;
			const byPerson = mark?.armed === true;
			if (byPerson) this.#direct.delete(agent.id);
			this.#startedWorking(agent, byPerson, now);
		}
		for (const id of [...this.#direct.keys()])
			if (!this.#status.has(id)) this.#direct.delete(id);
	}

	#startedWorking(agent: LiveAgent, byPerson: boolean, now: number): void {
		if (agent.id === this.ports.store.orchestratorAgentId) return;
		const about = this.ports.store
			.all()
			.filter((one) => isOpen(one) && one.agents.includes(agent.id));
		if (about.length === 0) return;
		const told: Escalation[] = [];
		for (const one of about) {
			const state = escalationState(one);
			told.push(
				state === "needs_answer" || state === "waiting"
					? this.ports.store.note(
							one.id,
							byPerson ? "direct" : "resumed",
							agent.id,
							now,
						)
					: one,
			);
		}
		if (!byPerson) return;
		const say = (message: PersonMessage | undefined) => {
			const since = message?.since;
			const text = message?.text;
			for (const one of told)
				this.events.dispatch({
					type: "escalation.human_direct",
					escalationId: one.id,
					title: one.title,
					agent: { id: agent.id, name: agent.name },
					...(since === undefined ? {} : { since }),
					...(text === undefined || text.trim().length === 0
						? {}
						: { messages: [{ text }] }),
				});
		};
		const message = this.ports.personMessage?.(agent.id);
		if (message instanceof Promise)
			void message.catch(() => undefined).then(say);
		else say(message);
	}

	// --- live state ------------------------------------------------------------

	/**
	 * A new projection: who went working, and which 対応中 escalation has
	 * stood still past the grace. Called on every snapshot; cheap, and
	 * idempotent.
	 */
	observe(): void {
		const now = this.#now();
		const agents = this.#agents();
		this.#startedAt ??= now;
		this.#watchWorking(agents, now);
		this.#watchStalled(agents, now);
		this.#announceStalled(now);
		this.#announceDue(now);
		this.#schedule(now);
		// The orchestrator's status may have moved: what waits for it may go.
		this.events.flush();
		this.publish();
	}

	/**
	 * Every agent at the status work goes by: one on a maintenance turn keeps
	 * the status it was last seen with (`workStatus`).
	 */
	#agents(): readonly LiveAgent[] {
		return this.ports
			.agents()
			.map((agent) =>
				agent.maintenance === true
					? { ...agent, status: workStatus(agent, this.#status.get(agent.id)) }
					: agent,
			);
	}

	#lanes() {
		return board(this.ports.store.all());
	}

	// --- 停滞: 対応中 with nobody working on it -----------------------------------

	/**
	 * The orchestrator has been shown escalation `id`'s first `entries`
	 * entries (`escalation show`): an answer among them is read, and a
	 * stalled stretch may start.
	 */
	acknowledge(id: number, entries: number): void {
		if (!this.#markRead(id, entries)) return;
		this.observe();
	}

	/** Escalation `id`'s first `entries` are read now; false: they were already. */
	#markRead(id: number, entries: number): boolean {
		const before = this.#read.get(id);
		if (before !== undefined && before.entries >= entries) return false;
		this.#read.set(id, { entries, at: this.#now() });
		return true;
	}

	/**
	 * Events just delivered: an `escalation_answered` that carried its
	 * answers whole is the orchestrator's reading of them — 停滞's grace
	 * starts now, and `agent wait --any` no longer owes it them. One cut at
	 * `HUMAN_TEXT_CAP` is not: `escalation show` reads the rest, and is the
	 * reading.
	 */
	#deliveredRead(events: readonly OrchestratorEvent[]): void {
		const orchestrator = this.orchestratorAgentId;
		let moved = false;
		for (const event of events) {
			if (event.type !== "escalation_answered") continue;
			if (event.readThrough === undefined) continue;
			if (cappedWords(event.answers ?? []).truncated) continue;
			if (orchestrator !== undefined)
				this.ports.acknowledged?.(
					orchestrator,
					event.escalationId,
					event.readThrough,
				);
			moved = this.#markRead(event.escalationId, event.readThrough) || moved;
		}
		// The grace runs from here: wake when it is up.
		if (moved) this.#schedule(this.#now());
	}

	/** Whether one of `ids` is working now (a maintenance turn is not). */
	#anyWorking(ids: readonly string[], agents: readonly LiveAgent[]): boolean {
		return agents.some(
			(agent) =>
				ids.includes(agent.id) &&
				agent.id !== this.ports.store.orchestratorAgentId &&
				!agent.stopping &&
				agentAtWork(agent.status),
		);
	}

	#watchStalled(agents: readonly LiveAgent[], now: number): void {
		const open = new Set<number>();
		for (const one of this.ports.store.all()) {
			if (!isOpen(one)) continue;
			open.add(one.id);
			const working = this.#anyWorking(one.agents, agents);
			const was = this.#workedAt.get(one.id);
			// Working, or seen to stop just now: the stretch starts here.
			if (working || was?.working === true)
				this.#workedAt.set(one.id, { at: now, working });
		}
		for (const id of [...this.#workedAt.keys()])
			if (!open.has(id)) this.#workedAt.delete(id);
	}

	/**
	 * 停滞 now: every 対応中 escalation none of whose agents is working, past
	 * the grace, whose last answer (if that is its last entry) the
	 * orchestrator has read. With since when.
	 */
	#stalledNow(
		now: number,
	): readonly { readonly escalation: Escalation; readonly since: number }[] {
		const agents = this.#agents();
		const out: { escalation: Escalation; since: number }[] = [];
		for (const one of this.ports.store.all()) {
			const since = this.#stalledSince(one, agents);
			if (since !== undefined && now - since >= this.#graceMs)
				out.push({ escalation: one, since });
		}
		return out;
	}

	/** When `one` started standing still, or undefined while it does not. */
	#stalledSince(
		one: Escalation,
		agents: readonly LiveAgent[],
	): number | undefined {
		if (escalationState(one) !== "in_progress") return undefined;
		if (this.#anyWorking(one.agents, agents)) return undefined;
		const last = one.entries.at(-1);
		const read = this.#read.get(one.id);
		const answer = last?.role === "human" && last.kind === undefined;
		// An answer it has not read: escalation_answered says it already.
		if (answer && (read?.entries ?? 0) < one.entries.length) return undefined;
		return Math.max(
			last?.at ?? one.createdAt,
			this.#workedAt.get(one.id)?.at ?? 0,
			answer ? (read?.at ?? 0) : 0,
			this.#startedAt ?? 0,
		);
	}

	#announceStalled(now: number): void {
		if (this.orchestratorAgentId === undefined) return;
		const names = new Map(this.ports.agents().map((one) => [one.id, one.name]));
		for (const { escalation, since } of this.#stalledNow(now)) {
			const key = `${String(escalation.id)}@${String(since)}`;
			if (this.#stalledTold.has(key)) continue;
			this.#stalledTold.add(key);
			this.events.dispatch({
				type: "escalation.stalled",
				escalationId: escalation.id,
				title: escalation.title,
				agents: escalation.agents
					.filter((id) => id !== this.ports.store.orchestratorAgentId)
					.map((id) => {
						const name = names.get(id);
						return name === undefined ? { id } : { id, name };
					}),
				since,
			});
		}
	}

	// --- 待機中: parked on an outside condition --------------------------------------

	/** Every waiting escalation whose time has come is told, once per wait. */
	#announceDue(now: number): void {
		if (this.orchestratorAgentId === undefined) return;
		for (const one of this.ports.store.all()) {
			const wait = currentWait(one);
			if (wait?.dueAt === undefined || wait.dueAt > now) continue;
			const key = `${String(one.id)}@${String(wait.at)}`;
			if (this.#dueTold.has(key)) continue;
			this.#dueTold.add(key);
			this.events.dispatch({
				type: "escalation.wait_due",
				escalationId: one.id,
				title: one.title,
				trigger: wait.markdown,
				dueAt: wait.dueAt,
				waitSince: wait.at,
			});
		}
	}

	/**
	 * `escalation.waiting_reminder`: every 待機中 escalation and its trigger,
	 * as one line. Nothing when none waits, or no orchestrator runs.
	 * The reminder timer calls it every `wait_reminder_interval`.
	 */
	remindWaiting(): void {
		if (this.orchestratorAgentId === undefined) return;
		const waiting = board(this.ports.store.all()).waiting.map((one) => {
			const wait = currentWait(one)!;
			return {
				escalationId: one.id,
				title: one.title,
				trigger: wait.markdown,
				...(wait.dueAt === undefined ? {} : { dueAt: wait.dueAt }),
			};
		});
		if (waiting.length === 0) return;
		this.events.dispatch({ type: "escalation.waiting_reminder", waiting });
	}

	/** The settings moved: `wait_reminder_interval` counts from now. */
	settingsChanged(): void {
		const ms = parseInterval(this.ports.settings().wait_reminder_interval);
		if (ms === this.#reminderMs) return;
		this.#scheduleReminder();
	}

	#reminderMs: number | undefined;

	#scheduleReminder(): void {
		this.#reminder?.cancel();
		this.#reminder = undefined;
		const setTimer = this.ports.setTimer;
		if (setTimer === undefined) return;
		const ms =
			parseInterval(this.ports.settings().wait_reminder_interval) ?? 3_600_000;
		this.#reminderMs = ms;
		this.#reminder = setTimer(Math.max(ms, 60_000), () => {
			this.#reminder = undefined;
			this.remindWaiting();
			this.#scheduleReminder();
		});
	}

	/** Wake when the next escalation's grace or wait is up, to say so. */
	#schedule(now: number): void {
		this.#timer?.cancel();
		this.#timer = undefined;
		const setTimer = this.ports.setTimer;
		if (setTimer === undefined) return;
		const agents = this.#agents();
		const all = this.ports.store.all();
		const due = [
			...all
				.map((one) => this.#stalledSince(one, agents))
				.filter((since): since is number => since !== undefined)
				.map((since) => since + this.#graceMs),
			...all
				.map((one) => currentWait(one)?.dueAt)
				.filter((at): at is number => at !== undefined),
		]
			.map((at) => at - now)
			.filter((ms) => ms > 0);
		if (due.length === 0) return;
		// A far-off time is looked at again within the hour (a timer cannot
		// wait weeks, and the clock may jump).
		this.#timer = setTimer(Math.min(...due, 3_600_000) + 50, () => {
			this.#timer = undefined;
			this.observe();
		});
	}

	// --- the board -------------------------------------------------------------

	/** One escalation as the board and `--tell` carry it. */
	toWire(one: Escalation): EscalationWire {
		const stalled = this.#stalledSince(one, this.#agents());
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
				...(entry.kind === undefined ? {} : { kind: entry.kind }),
				...(entry.agent === undefined ? {} : { agent: entry.agent }),
				...(entry.dueAt === undefined ? {} : { dueAt: entry.dueAt }),
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
			priority: priorityOf(one),
			effort: effortOf(one),
			...(one.rankNote === undefined ? {} : { rankNote: one.rankNote }),
			...(stalled === undefined || this.#now() - stalled < this.#graceMs
				? {}
				: { stalledSince: stalled }),
		};
	}

	/** Every escalation, closed ones included, as `--tell` lists them. */
	allWires(): readonly EscalationWire[] {
		return this.ports.store.all().map((one) => this.toWire(one));
	}

	wire(): OrchestratorBoardWire {
		const lanes = this.#lanes();
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
				root: settings.root,
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
			github: this.ports.github?.() ?? { state: "idle" },
			needsAnswer: lanes.needsAnswer.map(escalation),
			inProgress: lanes.inProgress.map(escalation),
			waiting: lanes.waiting.map(escalation),
			closed: lanes.closed.slice(0, CLOSED_SHOWN).map(escalation),
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
		this.#reminder?.cancel();
		this.events.dispose();
		this.timers.stop();
	}
}

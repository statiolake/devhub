/**
 * The Orchestrator row's main-process half: the tasks, their escalations,
 * the board, and the events the orchestrator agent is told.
 *
 * It owns no window and no agent. The controller hands it what it reads —
 * the agents as the Sidebar has them, the settings — and what it may do —
 * queue a message for an agent — and pushes the board to the pages whenever
 * it moves (`OrchestratorBoardWire`). The person's answer arrives from the
 * Agents page's bridge (`answer`), and that is the only door it has; the
 * `--tell` commands reach the tasks and `raise` / `withdraw`, never
 * `answer`.
 *
 * Everything the orchestrator is told is about a **task** (`model/tasks.ts`):
 * the invariant (`invariant.ts`) is read here on every projection, and
 * every delivery carries the subjects that need action then (`standing`); a
 * 待機 task whose subjects' facts moved is said (`task.changed`), and once
 * per time when its `--check-at` came. An agent bound to a 待機 task going
 * to work moves it to 処理中 (`TaskStore.agentWorking`): DevHub's
 * bookkeeping, never a decision. When the person writes from an agent's
 * own composer (`personSent`) to an agent of a task with an open question,
 * the orchestrator is told (`task.human_direct`): what was said may answer
 * or change it. Nothing ever proceeds by a deadline: an open question waits
 * for the person.
 *
 * A maintenance turn (`isMaintenanceTurn`: a `/compact`) is not work: every
 * reading here goes by the status the agent had before it (`workStatus`).
 */

import type {
	AgentOrchestrationWire,
	EscalationWire,
	OrchestratorBoardWire,
	OrchestratorNextDeliveryWire,
	TaskAgentWire,
	TaskWire,
	UsageLimitsWire,
} from "../../ipc/contract.js";
import {
	escalationState,
	isOpen,
	type Escalation,
	type NewEscalation,
} from "../../model/escalations.js";
import {
	byPriority,
	priorityOf,
	taskStatus,
	type LiveTaskAgent,
	type NewTask,
	type StoredTaskStatus,
	type Task,
	type TaskAgent,
	type TaskEdit,
	type TaskStatus,
} from "../../model/tasks.js";
import type { OrchestratorConfig } from "../../model/orchestratorSettings.js";
import { workStatus } from "../../model/conversation.js";
import type { TaskStore } from "./taskStore.js";
import {
	customTypeProblem,
	EventDispatcher,
	breachWords,
	eventJson,
	type EventLogEntry,
	type OrchestratorEvent,
	type TriageTask,
} from "./events.js";
import {
	InvariantWatch,
	readInvariant,
	type AgentStanding,
	type InvariantAgent,
	type PullFacts,
	type ItemFacts,
	findItem,
	issueUrlKey,
	itemLinkKey,
	itemToken,
	type ItemStanding,
	type NeedsActionView,
} from "./invariant.js";
import { OrchestratorTimers } from "./timers.js";
import {
	LAUNCH_MODE,
	OrchestratorModeControl,
	usageOver,
	type ModeChange,
	type OrchestratorMode,
	type UsageOver,
} from "./mode.js";
import {
	staleReasons,
	staleWords,
	type StaleItem,
	type StaleReason,
} from "./staleness.js";
import { nextTriageAt } from "./triage.js";
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
	readonly store: TaskStore;
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
	 * The pause moved: the sources that cost something follow it. A resume
	 * delivers at once; what their catch-up finds goes with the next delivery.
	 */
	readonly paused?: (paused: boolean) => void;
	/** How GitHub polling stands, for the board's header. */
	readonly github?: () => OrchestratorBoardWire["github"];
	/**
	 * What the invariant is read off (`invariant.ts`): the registered
	 * Projects' items and the ones tasks link (undefined while not known in
	 * full), and every agent. Absent: no invariant is held (tests).
	 */
	readonly invariant?: () => {
		readonly items: readonly ItemFacts[] | undefined;
		readonly agents: readonly InvariantAgent[];
	};
	/**
	 * The person's last message to `agentId`, read off its conversation: its
	 * cursor (`agent read --since`) and its text. Undefined when it has none.
	 */
	readonly personMessage?: (
		agentId: string,
	) => Promise<PersonMessage | undefined> | PersonMessage | undefined;
	/**
	 * The orchestrator `agentId` has been delivered escalation `id`'s answer
	 * in its event, whole: as read as if it had run `escalation show`
	 * (`agent wait --any` stops reporting it).
	 */
	readonly acknowledged?: (agentId: string, id: number) => void;
	/**
	 * A plan window as the usage readout has it now, for a pending
	 * `usage.threshold` (`usageThresholds.ts`). Absent: not checked.
	 */
	readonly usageWindow?: (
		cli: string,
		window: string,
	) => UsageWindowNow | undefined;
	/** The mode it starts in (`mode.ts`). Absent: `LAUNCH_MODE`, off. */
	readonly mode?: OrchestratorMode;
	/** The mode moved: by the person, or by the usage readout. */
	readonly modeChanged?: (
		change: ModeChange,
		auto: UsageOver | undefined,
	) => void;
	/** The open Workspace at `folder` on `machine`, for a stopped agent's chip. */
	readonly workspaceAt?: (
		machine: string,
		folder: string,
	) => string | undefined;
	readonly now?: () => number;
	readonly setTimer?: (ms: number, run: () => void) => { cancel(): void };
	readonly log?: (line: string) => void;
}

/** The person's last message to an agent, as `task.human_direct` carries it. */
export interface PersonMessage {
	readonly since?: string;
	readonly text?: string;
}

/** An item, as `status` gives it. */
export interface StatusItem {
	readonly kind: "issue" | "pr";
	/** `issue=acme/app#123`, `pr=acme/app#9`: as a line names it. */
	readonly ref: string;
	readonly url?: string;
	readonly title?: string;
	readonly state: "open" | "closed" | "merged";
	readonly assigned: boolean;
	/** Open, assigned to the viewer, on a registered Project. */
	readonly inPopulation: boolean;
	readonly projects: readonly {
		readonly project: string;
		readonly lane: string | null;
	}[];
	/** Its pull request (its own, or the one closing the Issue). */
	readonly pull?: PullFacts;
}

/** An agent, as `status` gives it. */
export interface StatusAgent {
	readonly id: string;
	readonly name: string;
	readonly ws: string;
	readonly workspaceId: string;
	/** working, background, waiting, idle, error, unknown, stopping. */
	readonly status: string;
	readonly managed: boolean;
	/** Its meta `issue=`: the item it was started on. */
	readonly issue?: string;
	/** The clause it (or its task) fails, when it does. */
	readonly needsAction?: string;
}

export interface StatusTaskRef {
	readonly id: number;
	readonly title: string;
	readonly status: TaskStatus;
}

export interface StatusNeedsAction {
	readonly clause: string;
	readonly line: string;
	readonly since: number;
}

/** One subject's whole state now: what `devhub --tell status` prints. */
export type SubjectStatus =
	| {
			readonly subject: "task";
			readonly task: TaskWire;
			readonly needsAction?: StatusNeedsAction;
			/** Its linked items, as DevHub read them. */
			readonly items: readonly StatusItem[];
			readonly agents: readonly StatusAgent[];
	  }
	| {
			readonly subject: "item";
			readonly item: StatusItem;
			readonly needsAction?: StatusNeedsAction;
			/** The open tasks that link it. */
			readonly tasks: readonly StatusTaskRef[];
	  }
	| {
			readonly subject: "agent";
			readonly agent: StatusAgent;
			readonly task?: StatusTaskRef;
			readonly needsAction?: StatusNeedsAction;
	  };

function statusItem(item: ItemStanding): StatusItem {
	const facts = item.facts;
	return {
		kind: facts.kind,
		ref: itemToken(facts.kind, facts.item),
		...(facts.item.url === undefined ? {} : { url: facts.item.url }),
		...(facts.item.title === undefined ? {} : { title: facts.item.title }),
		state: facts.state,
		assigned: facts.assignedToMe,
		inPopulation: item.inPopulation,
		projects: facts.projects,
		...(facts.pull === undefined ? {} : { pull: facts.pull }),
	};
}

function needsActionOf(view: NeedsActionView): StatusNeedsAction {
	return { clause: view.clause, line: view.line, since: view.since };
}

/** How many done tasks the board carries for its history. */
const DONE_SHOWN = 30;

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

/** A task's `--check-at` dropped because it came while off. */
export interface ExpiredWake {
	readonly taskId: number;
	readonly title: string;
	/** The `--check-at` it was given. */
	readonly checkAt: number;
	/** When DevHub saw it come, while off. */
	readonly droppedAt: number;
}

/** A task's escalation as the board carries it. */
export function escalationWire(one: Escalation): EscalationWire {
	return {
		id: one.id,
		taskId: one.taskId,
		title: one.title,
		state: escalationState(one),
		question: one.question,
		...(one.answer === undefined ? {} : { answer: one.answer }),
		...(one.withdrawn === undefined ? {} : { withdrawn: one.withdrawn }),
		links: one.links,
		...(one.linkLabels === undefined ? {} : { linkLabels: one.linkLabels }),
		createdAt: one.createdAt,
	};
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
	/** `taskId@checkAt`, once told: one `due` per time. */
	readonly #dueTold = new Set<string>();
	/** The check-back times that came while off, per task (`expiredWhileOff`). */
	readonly #expired = new Map<number, ExpiredWake>();
	/** The invariant's subjects and their time. */
	readonly #invariant: InvariantWatch;
	/** The agents the invariant was last read with. */
	#invariantAgents: readonly InvariantAgent[] = [];
	/** Full, saving or off, and why saving when it was automatic. */
	readonly #mode: OrchestratorModeControl;
	/** The usage readout as last seen, for the automatic switch. */
	#usage: UsageLimitsWire = { clis: [] };
	/** A look at the readout when the window that made saving resets. */
	#resetTimer: { cancel(): void } | undefined;
	/** The requests handed to the dispatcher this run (held or delivered). */
	readonly #queuedRequests = new Set<number>();
	/** What the next triage is counted from: the last, or the mode going on. */
	#triageAnchor: number | undefined;
	/** When the last `triage` went out to the orchestrator. */
	#triagedAt: number | undefined;
	/** The open tasks that may be stale, since when, and why. */
	#stale = new Map<
		number,
		{ readonly since: number; readonly reasons: readonly StaleReason[] }
	>();

	constructor(private readonly ports: OrchestratorServicePorts) {
		this.#mode = new OrchestratorModeControl(ports.mode ?? LAUNCH_MODE);
		this.events = new EventDispatcher({
			high: (subject) => this.#isHigh(subject),
			mode: this.#mode.mode,
			inProgress: () => this.#inProgressTasks().length,
			inProgressSubject: (subject) => this.#inProgressSubject(subject),
			statePrint: (event) => this.#invariant.print(event),
			orchestrator: () => this.orchestratorAgentId,
			settings: () => this.ports.settings(),
			deliver: (agentId, text) => {
				this.ports.deliver(agentId, text);
			},
			...(ports.busy === undefined ? {} : { busy: ports.busy }),
			relevant: (event) => this.#relevant(event),
			standing: () => this.#invariant.due(),
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
		this.#invariant = new InvariantWatch({
			dispatch: (event) => {
				this.events.dispatch(event);
			},
			now: () => this.#now(),
		});
		// A task linked, bound, parked or done changes what the invariant
		// reads: read it again, not on the next tick.
		ports.store.onChange(() => {
			this.#watchInvariant();
			this.publish();
		});
	}

	#store(): TaskStore {
		return this.ports.store;
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
	 * just before it goes: a task no longer 待機, a window reset — these need
	 * nothing any more.
	 */
	#relevant(event: OrchestratorEvent): boolean {
		switch (event.type) {
			case "task.changed": {
				const task = this.#store().task(event.taskId);
				return task !== undefined && this.statusOf(task) === "waiting";
			}
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
		const id = this.#store().orchestratorAgentId;
		return id !== undefined && this.ports.agents().some((one) => one.id === id)
			? id
			: undefined;
	}

	// --- the mode: full, saving, off --------------------------------------------

	get mode(): OrchestratorMode {
		return this.#mode.mode;
	}

	/** Why saving is in force, when the usage readout switched it on. */
	get autoSaving(): UsageOver | undefined {
		return this.#mode.auto;
	}

	/**
	 * The person chose `mode` (the board, the palette, `orchestrator mode`).
	 * How many held lines went out, turning it on.
	 */
	setMode(mode: OrchestratorMode): number {
		const changes = this.#mode.choose(mode, this.#over());
		return this.#apply(changes);
	}

	// --- tasks ---------------------------------------------------------------------

	/** A task's status as the board files it: 回答待ち derived. */
	statusOf(task: Task): TaskStatus {
		return taskStatus(task, this.#store().escalationsOf(task.id));
	}

	#inProgressTasks(): readonly Task[] {
		return this.#store()
			.tasks()
			.filter((one) => this.statusOf(one) === "in_progress");
	}

	/** Whether a line's subject is a task in progress (処理中). */
	#inProgressSubject(subject: string): boolean {
		const match = /^task (\d+)$/u.exec(subject);
		if (match === null) return false;
		const task = this.#store().task(Number(match[1]));
		return task !== undefined && this.statusOf(task) === "in_progress";
	}

	#isHigh(subject: string): boolean {
		const match = /^task (\d+)$/u.exec(subject);
		if (match === null) return false;
		return this.#store().task(Number(match[1]))?.priority === "high";
	}

	tasks(): readonly Task[] {
		return this.#store().tasks();
	}

	task(id: number): Task | undefined {
		return this.#store().task(id);
	}

	requireTask(id: number): Task {
		return this.#store().requireTask(id);
	}

	/** The open task an agent is bound to. */
	taskOfAgent(agentId: string): Task | undefined {
		return this.#store().taskOfAgent(agentId);
	}

	newTask(request: NewTask): Task {
		return this.#store().createTask(request, this.#now());
	}

	editTask(id: number, edit: TaskEdit): Task {
		const task = this.#store().edit(id, edit, this.#now());
		// A task made high may let a nudge about it go in saving.
		if (edit.priority !== undefined) this.events.flush();
		return task;
	}

	setTaskStatus(
		id: number,
		status: StoredTaskStatus,
		wait: { readonly note?: string; readonly checkAt?: number },
	): Task {
		const task = this.#store().setStatus(id, status, wait, this.#now());
		// Parked on a time: the timer looks for it.
		this.observe();
		return task;
	}

	linkTask(
		id: number,
		links: readonly string[],
		labels?: Readonly<Record<string, string>>,
	): Task {
		return this.#store().link(id, links, labels, this.#now());
	}

	unlinkTask(id: number, links: readonly string[]): Task {
		return this.#store().unlink(id, links, this.#now());
	}

	/** Bind agents (by full id) to a task: each leaves the open task it was on. */
	bindTask(id: number, agentIds: readonly string[]): Task {
		const names = new Map(this.ports.agents().map((one) => [one.id, one.name]));
		const bound = this.#store().bind(
			id,
			agentIds.map((agentId) => ({
				agentId,
				name: names.get(agentId) ?? agentId.slice(0, 8),
			})),
			this.#now(),
		);
		return bound;
	}

	unbindTask(id: number, agentId: string): Task {
		return this.#store().unbind(id, agentId, this.#now());
	}

	completeTask(id: number, note: string | undefined): Task {
		return this.#store().complete(id, note, this.#now());
	}

	/**
	 * The agent `agent resume <task|agent>` brings back: the latest of the
	 * task's bound agents (`text` a task: `task=12`, `#12`, `12`), or the
	 * bound agent `text` names (its id, a 4+ prefix, or its name), newest
	 * task first. Undefined: `text` names neither (it may be a session id).
	 * `live` is the agent running that conversation now, when one is.
	 */
	resumeTarget(text: string):
		| {
				readonly task: Task;
				readonly agent: TaskAgent;
				readonly live?: string;
		  }
		| undefined {
		const liveIds = new Set(this.ports.agents().map((one) => one.id));
		const answer = (task: Task, agent: TaskAgent) => ({
			task,
			agent,
			...(liveIds.has(agent.agentId) ? { live: agent.agentId } : {}),
		});
		const typed = /^(?:task=|#|T)(\d{1,9})$/u.exec(text.trim());
		if (typed !== null) {
			const task = this.#store().requireTask(Number(typed[1]));
			const agent = task.agents.at(-1);
			if (agent === undefined)
				throw new Error(
					`no agent has worked on task #${String(task.id)}: start one (agent new --task ${String(task.id)} / issue assign --task ${String(task.id)}).`,
				);
			return answer(task, agent);
		}
		const id = text.trim();
		const matches: { task: Task; agent: TaskAgent }[] = [];
		for (const task of [...this.#store().tasks()].reverse())
			for (const agent of task.agents)
				if (
					agent.agentId === id ||
					(id.length >= 4 && agent.agentId.startsWith(id)) ||
					agent.name === id
				)
					matches.push({ task, agent });
		if (matches.length === 0) return undefined;
		if (new Set(matches.map((one) => one.agent.agentId)).size > 1)
			throw new Error(
				`${JSON.stringify(id)} names more than one agent of a task: ${[...new Set(matches.map((one) => `${one.agent.agentId} (${one.agent.name})`))].join(", ")}.`,
			);
		return answer(matches[0]!.task, matches[0]!.agent);
	}

	/**
	 * The managed agents open now (every save of the state): each bound
	 * agent's entry brought up to date, one continuing a recorded session
	 * taking its place.
	 */
	observeWork(live: readonly LiveTaskAgent[]): void {
		this.#store().observe(live, this.#now());
	}

	// --- the person's requests ---------------------------------------------------

	/**
	 * The person's request, from the board's +: a 待機 task made with their
	 * words (its title their first line), and the words delivered at once as
	 * theirs — held while off, or until an orchestrator runs.
	 */
	request(text: string): Task {
		const trimmed = text.trim();
		const title =
			trimmed
				.split("\n")[0]!
				.replace(/^#+\s*/u, "")
				.trim()
				.slice(0, 120) || "依頼";
		const made = this.#store().createTask(
			{ title, request: trimmed },
			this.#now(),
		);
		this.#dispatchRequest(made);
		this.publish();
		return made;
	}

	#dispatchRequest(task: Task): void {
		if (task.request === undefined) return;
		const entry = this.events.dispatch({
			type: "request",
			task: { id: task.id, title: task.title },
			text: task.request.text,
		});
		if (entry.fate !== "dropped") this.#queuedRequests.add(task.id);
	}

	/**
	 * The requests waiting for an orchestrator (sent with none running, or
	 * kept from before a restart): to the dispatcher, now there is one.
	 */
	#releaseRequests(): void {
		if (this.orchestratorAgentId === undefined) return;
		for (const one of this.#store().tasks())
			if (
				one.request !== undefined &&
				one.request.sentAt === undefined &&
				one.done === undefined &&
				!this.#queuedRequests.has(one.id)
			)
				this.#dispatchRequest(one);
	}

	/** The usage readout moved: the automatic switch follows it. */
	observeUsage(limits: UsageLimitsWire): void {
		this.#usage = limits;
		this.#observeMode();
	}

	#over(): UsageOver | undefined {
		return usageOver(
			this.#usage,
			this.ports.settings().saving_threshold,
			this.#now(),
		);
	}

	#observeMode(): void {
		const change = this.#mode.observe(this.#over());
		this.#apply(change === undefined ? [] : [change]);
	}

	#apply(changes: readonly ModeChange[]): number {
		let delivered = 0;
		for (const change of changes) {
			// On from off: the next triage counts from now (the turn-on's
			// delivery has the orchestrator look at the board already).
			if (change.from === "off") this.#triageAnchor = this.#now();
			delivered += this.events.setMode(change.to);
			this.ports.log?.(
				`[devhub] orchestrator mode ${change.from} → ${change.to} (${change.by === "person" ? "chosen" : change.to === "saving" ? "usage over saving_threshold" : "usage back under"})`,
			);
		}
		this.#armReset();
		// Full and saving triage at different intervals.
		if (changes.length > 0) this.#schedule(this.#now());
		if (changes.length > 0) {
			const last = changes.at(-1)!;
			this.ports.modeChanged?.(last, this.#mode.auto);
			this.publish();
		}
		return delivered;
	}

	/**
	 * Saving entered automatically comes back to full when its window resets;
	 * the readers will say so, and in case they are slow, a look at the reset.
	 */
	#armReset(): void {
		this.#resetTimer?.cancel();
		this.#resetTimer = undefined;
		const at = this.#mode.auto?.resetsAt;
		const setTimer = this.ports.setTimer;
		if (at === undefined || setTimer === undefined) return;
		this.#resetTimer = setTimer(
			Math.max(1_000, at - this.#now() + 1_000),
			() => {
				this.#resetTimer = undefined;
				this.#observeMode();
			},
		);
	}

	// --- triage ------------------------------------------------------------------

	get triagedAt(): number | undefined {
		return this.#triagedAt;
	}

	/** When the next triage is due; undefined while off or with no orchestrator. */
	get nextTriageAt(): number | undefined {
		if (this.orchestratorAgentId === undefined) return undefined;
		return nextTriageAt(this.#mode.mode, this.#triageAnchor);
	}

	/** Its time came: ask the orchestrator to look at every open task again. */
	#announceTriage(now: number): void {
		const due = this.nextTriageAt;
		if (due === undefined || due > now) return;
		this.#triageAnchor = now;
		this.#observeStale();
		const previous = this.#triagedAt;
		const tasks: TriageTask[] = this.#store()
			.tasks()
			.filter((one) => one.done === undefined)
			.map((one) => {
				const stale = this.#stale.get(one.id);
				return {
					id: one.id,
					title: one.title,
					status: this.statusOf(one) as TriageTask["status"],
					...(one.priority === undefined ? {} : { priority: one.priority }),
					...(stale === undefined
						? {}
						: {
								stale: stale.reasons.map(staleWords),
								...(previous !== undefined && stale.since <= previous
									? { overdue: true }
									: {}),
							}),
				};
			});
		this.events.dispatch({
			type: "triage",
			...(tasks.length === 0 ? {} : { tasks }),
		});
	}

	// --- the orchestrator ----------------------------------------------------

	/** Assign the orchestrator agent, and tell it it has started. */
	assign(agentId: string, initPrompt?: string): void {
		this.#store().setOrchestrator(agentId);
		// `init` reads the board: the first triage is an interval away.
		this.#triageAnchor = this.#now();
		if (initPrompt !== undefined) this.ports.deliver(agentId, initPrompt);
		else this.events.dispatch({ type: "init" });
		// Requests sent while none ran: after init, each as the person's words.
		this.#releaseRequests();
	}

	release(): void {
		this.#store().setOrchestrator(undefined);
	}

	// --- escalations ---------------------------------------------------------

	raise(request: NewEscalation): Escalation {
		return this.#store().raise(request, this.#now());
	}

	withdraw(id: number, note: string | undefined): Escalation {
		return this.#store().withdraw(id, note, this.#now());
	}

	escalation(id: number): Escalation | undefined {
		return this.#store().escalation(id);
	}

	escalations(): readonly Escalation[] {
		return this.#store().escalations();
	}

	/** The id `raise` will give the next one: its pictures' folder is named for it. */
	nextEscalationId(): number {
		return this.#store().nextEscalationId;
	}

	/** The person's answer, from the window: closes it, its task 処理中. */
	answer(id: number, markdown: string): Escalation {
		const answered = this.#store().answer(id, markdown, this.#now());
		const task = this.#store().task(answered.taskId);
		const names = new Map(this.ports.agents().map((one) => [one.id, one.name]));
		this.events.dispatch({
			type: "escalation_answered",
			task: {
				id: answered.taskId,
				...(task === undefined ? {} : { title: task.title }),
			},
			escalationId: answered.id,
			title: answered.title,
			// Named as the person sees them, with the id to address them by.
			agents: (task?.agents ?? [])
				.filter((one) => names.has(one.agentId))
				.map((one) => ({ id: one.agentId, name: names.get(one.agentId)! })),
			answers: [
				{
					text: answered.answer?.markdown ?? markdown,
					...(answered.answer?.option === undefined
						? {}
						: { option: answered.answer.option }),
				},
			],
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
	 * working since the last projection: its 待機 task is 処理中 again; and
	 * when the person's own composer set it going and its task has an open
	 * question, the orchestrator is told (`task.human_direct`).
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
		if (agent.id === this.#store().orchestratorAgentId) return;
		const task = this.#store().taskOfAgent(agent.id);
		if (task === undefined) return;
		this.#store().agentWorking(agent.id, now);
		if (!byPerson || this.statusOf(task) !== "answer") return;
		const say = (message: PersonMessage | undefined) => {
			const since = message?.since;
			const text = message?.text;
			this.events.dispatch({
				type: "task.human_direct",
				task: { id: task.id, title: task.title },
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

	/** A new projection: called on every snapshot; cheap, and idempotent. */
	observe(): void {
		const now = this.#now();
		const agents = this.#agents();
		this.#watchWorking(agents, now);
		this.#announceDue(now);
		this.#announceTriage(now);
		// An orchestrator restored with DevHub picks up the requests kept.
		this.#releaseRequests();
		this.#watchInvariant();
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
		return this.ports.agents().map((agent) =>
			agent.maintenance === true
				? {
						...agent,
						status: workStatus(agent, this.#status.get(agent.id) ?? "unknown"),
					}
				: agent,
		);
	}

	/** The orchestrator has read escalation `id` (`escalation show`). */
	acknowledge(id: number): void {
		const orchestrator = this.orchestratorAgentId;
		if (orchestrator !== undefined) this.ports.acknowledged?.(orchestrator, id);
	}

	/**
	 * Events just delivered: an answer's delivery is the orchestrator's
	 * reading of it; a request's, its being sent; a triage's, its time.
	 */
	#deliveredRead(events: readonly OrchestratorEvent[]): void {
		const orchestrator = this.orchestratorAgentId;
		for (const event of events) {
			if (event.type === "request") {
				this.#store().requestSent(event.task.id, this.#now());
				continue;
			}
			if (event.type === "triage") {
				this.#triagedAt = this.#now();
				continue;
			}
			if (event.type === "escalation_answered" && orchestrator !== undefined)
				this.ports.acknowledged?.(orchestrator, event.escalationId);
		}
	}

	// --- 待機: parked, maybe with a time to look again ----------------------------

	/** Every 待機 task whose `--check-at` has come is told, once per time. */
	#announceDue(now: number): void {
		if (this.orchestratorAgentId === undefined) return;
		for (const task of this.#store().tasks()) {
			if (task.checkAt === undefined || task.checkAt > now) continue;
			if (this.statusOf(task) !== "waiting") continue;
			const key = `${String(task.id)}@${String(task.checkAt)}`;
			if (this.#dueTold.has(key)) continue;
			this.#dueTold.add(key);
			const entry = this.events.dispatch({
				type: "task.changed",
				taskId: task.id,
				reasons: ["due"],
				checkAt: task.checkAt,
			});
			if (entry.fate === "dropped" && entry.reason === "off")
				this.#expired.set(task.id, {
					taskId: task.id,
					title: task.title,
					checkAt: task.checkAt,
					droppedAt: now,
				});
		}
	}

	/**
	 * The check-back times that came while off and were dropped, for as long
	 * as the task waits with that time. Oldest first.
	 */
	expiredWhileOff(): readonly ExpiredWake[] {
		for (const [id, one] of [...this.#expired]) {
			const task = this.#store().task(id);
			if (
				task === undefined ||
				task.checkAt !== one.checkAt ||
				this.statusOf(task) !== "waiting"
			)
				this.#expired.delete(id);
		}
		return [...this.#expired.values()].sort((a, b) => a.checkAt - b.checkAt);
	}

	/** The settings moved: what is read and delivered follows them now. */
	settingsChanged(): void {
		// `saving_threshold` may have moved.
		this.#observeMode();
		this.observe();
	}

	// --- the invariant -----------------------------------------------------------

	/** Read the invariant now, and say what has come of it. */
	#watchInvariant(): void {
		const source = this.ports.invariant?.();
		if (source === undefined) return;
		const orchestrator = this.#store().orchestratorAgentId;
		// A maintenance turn is not work: the status before it (`#agents`).
		const statuses = new Map(this.#agents().map((one) => [one.id, one.status]));
		this.#invariantAgents = source.agents
			.filter((one) => one.id !== orchestrator)
			.map((one) => ({
				...one,
				status: statuses.get(one.id) ?? one.status,
			}));
		const reading = readInvariant({
			items: source.items,
			agents: this.#invariantAgents,
			tasks: this.#store()
				.tasks()
				.filter((one) => one.done === undefined)
				.map((one) => ({
					id: one.id,
					title: one.title,
					status: this.statusOf(one) as Exclude<TaskStatus, "done">,
					links: one.links,
					agents: one.agents.map((agent) => agent.agentId),
					escalations: this.#store()
						.escalationsOf(one.id)
						.filter(isOpen)
						.map((escalation) => escalation.id),
				})),
		});
		this.#invariant.observe(reading, this.orchestratorAgentId !== undefined);
		this.#observeStale();
	}

	// --- may be stale ---------------------------------------------------------------

	/**
	 * Mark the open tasks whose linked pull request merged or closed, or
	 * whose linked Issue closed (`staleness.ts`), from what DevHub already
	 * reads: the items of the last GitHub reading and the agents' Workspace
	 * pull requests. Keeps since when each has been marked.
	 */
	#observeStale(): void {
		const reading = this.#invariant.reading;
		const items = new Map<string, StaleItem>();
		for (const agent of this.#invariantAgents) {
			const pull = agent.pull;
			if (pull?.url === undefined) continue;
			const repo = /github\.com\/([^/]+\/[^/]+)\/pull\//u.exec(pull.url)?.[1];
			items.set(issueUrlKey(pull.url), {
				kind: "pr",
				state:
					pull.state === "merged" || pull.state === "closed"
						? pull.state
						: "open",
				ref: `${repo ?? ""}#${String(pull.number)}`,
			});
		}
		for (const [key, one] of reading.items)
			items.set(key, {
				kind: one.facts.kind,
				state: one.facts.state,
				ref: `${one.facts.item.repo}#${String(one.facts.item.number)}`,
			});
		const now = this.#now();
		const next = new Map<
			number,
			{ readonly since: number; readonly reasons: readonly StaleReason[] }
		>();
		for (const task of this.#store().tasks()) {
			if (task.done !== undefined) continue;
			const reasons = staleReasons(task.links, (key) => items.get(key));
			if (reasons.length === 0) continue;
			next.set(task.id, {
				since: this.#stale.get(task.id)?.since ?? now,
				reasons,
			});
		}
		this.#stale = next;
	}

	/**
	 * The item URLs the open tasks link (Issues and pull requests on
	 * GitHub): read by URL beside the population, so a merged or closed one
	 * is seen and a 待機 task waiting on it hears of it.
	 */
	taskItemLinks(): readonly string[] {
		return this.#store()
			.tasks()
			.filter((one) => one.done === undefined)
			.flatMap((one) =>
				one.links.flatMap((link) => {
					const item =
						/^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:issues|pull)\/\d+/u.exec(
							link.trim(),
						);
					return item === null ? [] : [item[0]];
				}),
			);
	}

	/** How an agent stands against the invariant. */
	standing(agentId: string): AgentStanding | undefined {
		return this.#invariant.standing(agentId);
	}

	/** Every subject that needs action now. */
	needsAction(): readonly NeedsActionView[] {
		return this.#invariant.needsAction();
	}

	/**
	 * `devhub --tell status`: the whole state of one subject now — a task, an
	 * item (its URL, or `owner/repo#N`) or an agent — as far as DevHub knows
	 * it. Undefined when DevHub has read no such item (or has no such agent
	 * or task).
	 */
	status(
		target:
			| { readonly task: number }
			| { readonly item: string }
			| { readonly agentId: string },
	): SubjectStatus | undefined {
		this.observe();
		const reading = this.#invariant.reading;
		if ("task" in target) {
			const task = this.#store().task(target.task);
			if (task === undefined) return undefined;
			const view = this.#invariant.view(`task ${String(task.id)}`);
			return {
				subject: "task",
				task: this.taskWire(task),
				...(view === undefined ? {} : { needsAction: needsActionOf(view) }),
				items: task.links.flatMap((link) => {
					const key = itemLinkKey(link);
					const item = key === undefined ? undefined : reading.items.get(key);
					return item === undefined ? [] : [statusItem(item)];
				}),
				agents: task.agents.flatMap((one) => {
					const agent = this.#statusAgent(one.agentId);
					return agent === undefined ? [] : [agent];
				}),
			};
		}
		if ("item" in target) {
			const item = findItem(reading, target.item);
			if (item === undefined) return undefined;
			const view = this.#invariant.view(`item ${item.key}`);
			return {
				subject: "item",
				item: statusItem(item),
				...(view === undefined ? {} : { needsAction: needsActionOf(view) }),
				tasks: item.tasks.flatMap((id) => {
					const task = this.#store().task(id);
					return task === undefined ? [] : [this.#taskRef(task)];
				}),
			};
		}
		const agent = this.#statusAgent(target.agentId);
		if (agent === undefined) return undefined;
		const task = this.#store().taskOfAgent(target.agentId);
		const view = this.#invariant.view(
			task === undefined
				? `agent ${target.agentId}`
				: `task ${String(task.id)}`,
		);
		return {
			subject: "agent",
			agent,
			...(task === undefined ? {} : { task: this.#taskRef(task) }),
			...(view === undefined ? {} : { needsAction: needsActionOf(view) }),
		};
	}

	#taskRef(task: Task): StatusTaskRef {
		return { id: task.id, title: task.title, status: this.statusOf(task) };
	}

	#statusAgent(id: string): StatusAgent | undefined {
		const agent = this.#invariantAgents.find((one) => one.id === id);
		if (agent === undefined) return undefined;
		const standing = this.#invariant.standing(id);
		const breach = standing?.breach ?? standing?.taskBreach;
		return {
			id: agent.id,
			name: agent.name,
			ws: agent.ws,
			workspaceId: agent.workspaceId,
			status: agent.stopping ? "stopping" : agent.status,
			managed: agent.managed,
			...(agent.issue === undefined ? {} : { issue: agent.issue }),
			...(breach === undefined ? {} : { needsAction: breachWords(breach) }),
		};
	}

	/** Wake when the next task's check-back time or triage is due. */
	#schedule(now: number): void {
		this.#timer?.cancel();
		this.#timer = undefined;
		const setTimer = this.ports.setTimer;
		if (setTimer === undefined) return;
		const due = [
			...this.#store()
				.tasks()
				.map((one) => (one.done === undefined ? one.checkAt : undefined))
				.filter((at): at is number => at !== undefined),
			...(this.nextTriageAt === undefined ? [] : [this.nextTriageAt]),
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

	/** One task as the board and `--tell` carry it. */
	taskWire(task: Task): TaskWire {
		const live = new Map(this.ports.agents().map((agent) => [agent.id, agent]));
		const breach = this.#invariant.reading.tasks.get(task.id);
		const stale = this.#stale.get(task.id);
		const agents: TaskAgentWire[] = task.agents.map((agent) => {
			const now = live.get(agent.agentId);
			const workspaceId =
				now?.workspaceId ??
				(agent.machine === undefined || agent.folder === undefined
					? undefined
					: this.ports.workspaceAt?.(agent.machine, agent.folder));
			const session = agent.sessions.at(-1);
			return {
				agentId: agent.agentId,
				name: now?.name ?? agent.name,
				live: now !== undefined,
				...(now === undefined ? {} : { status: now.status }),
				...(workspaceId === undefined ? {} : { workspaceId }),
				...(now === undefined ? {} : { workspaceLabel: now.workspaceLabel }),
				resumable:
					now === undefined &&
					session !== undefined &&
					(agent.kind === "claude" || agent.kind === "codex"),
				...(agent.stoppedAt === undefined || now !== undefined
					? {}
					: { stoppedAt: agent.stoppedAt }),
				...(agent.profileId === undefined
					? {}
					: { profileId: agent.profileId }),
				...(agent.kind === undefined ? {} : { kind: agent.kind }),
				...(agent.model === undefined ? {} : { model: agent.model }),
				...(agent.machine === undefined ? {} : { machine: agent.machine }),
				...(agent.folder === undefined ? {} : { folder: agent.folder }),
				...(agent.branch === undefined ? {} : { branch: agent.branch }),
				...(session === undefined ? {} : { session }),
			};
		});
		return {
			id: task.id,
			title: task.title,
			status: this.statusOf(task),
			...(task.waitNote === undefined ? {} : { waitNote: task.waitNote }),
			...(task.checkAt === undefined ? {} : { checkAt: task.checkAt }),
			links: task.links,
			...(task.linkLabels === undefined ? {} : { linkLabels: task.linkLabels }),
			agents,
			...(task.memo === undefined ? {} : { memo: task.memo }),
			priority: priorityOf(task),
			...(task.priorityNote === undefined
				? {}
				: { priorityNote: task.priorityNote }),
			...(task.request === undefined ? {} : { request: task.request }),
			createdAt: task.createdAt,
			updatedAt: task.updatedAt,
			...(task.done === undefined ? {} : { done: task.done }),
			...(breach === undefined || task.done !== undefined
				? {}
				: { needsAction: breachWords(breach) }),
			...(stale === undefined || task.done !== undefined
				? {}
				: {
						mayBeStale: {
							since: stale.since,
							reasons: stale.reasons.map(staleWords),
						},
					}),
			escalations: this.#store().escalationsOf(task.id).map(escalationWire),
		};
	}

	wire(): OrchestratorBoardWire {
		const settings = this.ports.settings();
		const problem = this.ports.startProblem();
		const orchestrator = this.orchestratorAgentId;
		const byStatus = new Map<TaskStatus, Task[]>();
		for (const task of this.#store().tasks()) {
			const status = this.statusOf(task);
			byStatus.set(status, [...(byStatus.get(status) ?? []), task]);
		}
		const firstOpen = (task: Task) =>
			Math.min(
				...this.#store()
					.escalationsOf(task.id)
					.filter(isOpen)
					.map((one) => one.question.at),
			);
		const answer = (byStatus.get("answer") ?? []).sort(
			(a, b) => byPriority(a, b) || firstOpen(a) - firstOpen(b) || a.id - b.id,
		);
		const inProgress = (byStatus.get("in_progress") ?? []).sort(
			(a, b) => byPriority(a, b) || a.updatedAt - b.updatedAt || a.id - b.id,
		);
		const waiting = (byStatus.get("waiting") ?? []).sort(
			(a, b) =>
				(a.checkAt ?? Infinity) - (b.checkAt ?? Infinity) ||
				byPriority(a, b) ||
				a.updatedAt - b.updatedAt ||
				a.id - b.id,
		);
		const done = (byStatus.get("done") ?? [])
			.sort((a, b) => (b.done?.at ?? 0) - (a.done?.at ?? 0) || b.id - a.id)
			.slice(0, DONE_SHOWN);
		const wire = (task: Task) => this.taskWire(task);
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
			mode: this.#mode.mode,
			...(this.#mode.auto === undefined ? {} : { autoSaving: this.#mode.auto }),
			inProgressTasks: inProgress.length,
			held: this.events.held().length,
			nextDelivery: this.#nextDelivery(),
			github: this.ports.github?.() ?? { state: "idle" },
			needsAction: this.#invariant.needsAction(),
			triage: {
				...(this.#triagedAt === undefined ? {} : { lastAt: this.#triagedAt }),
				...(this.nextTriageAt === undefined
					? {}
					: { nextAt: this.nextTriageAt }),
			},
			agentStates: this.#agentStates(),
			answer: answer.map(wire),
			inProgress: inProgress.map(wire),
			waiting: waiting.map(wire),
			done: done.map(wire),
		};
	}

	/** The mode control's hover card: what the next delivery would send. */
	#nextDelivery(): OrchestratorNextDeliveryWire {
		const preview = this.events.preview();
		return {
			human: preview.human,
			...(preview.batch === undefined ? {} : { batch: preview.batch }),
			lines: preview.events.length,
			more: preview.more,
			...(preview.when === undefined ? {} : { when: preview.when }),
		};
	}

	/** What each agent's row shows of the orchestration: its task, its flag. */
	#agentStates(): Record<string, AgentOrchestrationWire> {
		const out: Record<string, AgentOrchestrationWire> = {};
		for (const agent of this.ports.agents()) {
			const task = this.#store().taskOfAgent(agent.id);
			const standing = this.#invariant.standing(agent.id);
			const breach = standing?.breach ?? standing?.taskBreach;
			const state: AgentOrchestrationWire = {
				...(task === undefined
					? {}
					: {
							task: {
								id: task.id,
								title: task.title,
								status: this.statusOf(task),
							},
						}),
				...(breach === undefined ? {} : { needsAction: breachWords(breach) }),
			};
			if (Object.keys(state).length > 0) out[agent.id] = state;
		}
		return out;
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
		this.#resetTimer?.cancel();
		this.events.dispose();
		this.timers.stop();
	}
}

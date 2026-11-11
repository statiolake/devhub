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
 * 停滞 is worked out here from live state (`#stalledNow`), for the board
 * only: an escalation in 対応中 that none of its agents is working on
 * (status `working` or `background`, not stopping) for longer than
 * `STALLED_GRACE_MS`. A stretch starts at the latest of: its last entry,
 * the last time one of its agents was seen working, the orchestrator's
 * reading of the answer (`acknowledge`), this service's first reading.
 * `escalation_answered` carries the answer itself, so its delivery is the
 * reading (`#deliveredRead`).
 *
 * The invariant (`invariant.ts`) is read here on every projection, and
 * every delivery carries its subjects that need action then (`standing`:
 * `needs_action`, the kept ones left out). 待機中 (`escalation wait`): a
 * waiting escalation that may be ready is said (`waiting.changed`) when its
 * subjects' facts moved, and once per wait when its time (`dueAt`) came. An
 * agent of one going working takes it out of 待機中 as it does out of 要回答.
 *
 * A maintenance turn (`isMaintenanceTurn`: a `/compact`, DevHub's keep-warm
 * one before the prompt cache goes cold or the person's) is not work: every
 * reading here goes by the status the agent had before it (`workStatus`), so
 * it writes no `resumed` / `direct` note, tells nothing, and does not end a
 * stalled stretch (停滞). A person's `/compact` is not
 * their words to the agent either: its mark goes with it.
 */

import type {
	AgentOrchestrationWire,
	EscalationWire,
	OrchestratorBoardWire,
	OrchestratorNextDeliveryWire,
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
import type { EscalationStore } from "./escalationStore.js";
import {
	customTypeProblem,
	EventDispatcher,
	breachWords,
	eventJson,
	type EventLogEntry,
	type OrchestratorEvent,
} from "./events.js";
import {
	InvariantWatch,
	readInvariant,
	type AgentStanding,
	type InvariantAgent,
	type PullFacts,
	type ItemFacts,
	findItem,
	itemToken,
	type ItemStanding,
	type KeptAgent,
	type NeedsActionView,
} from "./invariant.js";
import type { KeptStore } from "./keptFile.js";
import { OrchestratorTimers } from "./timers.js";
import {
	LAUNCH_MODE,
	OrchestratorModeControl,
	usageOver,
	type ModeChange,
	type OrchestratorMode,
	type UsageOver,
} from "./mode.js";
import type { LaneBoard } from "../../ipc/orchestratorLanes.js";
import {
	PriorityBook,
	nextTriageAt,
	subjectKey,
	type Priority,
	type PriorityEntry,
	type PriorityStorage,
	type SubjectRef,
} from "./triage.js";
import {
	RequestBook,
	type PersonRequest,
	type RequestStorage,
} from "./requests.js";
import type {
	OrchestratorMemoWire,
	OrchestratorWorkWire,
	UsageLimitsWire,
} from "../../ipc/contract.js";
import {
	MemoBook,
	memoClock,
	memoExcerpt,
	memoUpdatedAt,
	type Memo,
	type MemoStorage,
} from "./memos.js";
import {
	WorkBook,
	workSubjectOf,
	type LiveWorkAgent,
	type WorkAgent,
	type WorkRecord,
	type WorkStorage,
} from "./work.js";
import {
	itemKey,
	itemOfUrl,
	normalSubject,
	readSubject,
	subjectToken,
} from "./subjects.js";
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
	 * The pause moved: the sources that cost something follow it. A resume
	 * delivers at once; what their catch-up finds goes with the next delivery.
	 */
	readonly paused?: (paused: boolean) => void;
	/** How GitHub polling stands, for the board's header. */
	readonly github?: () => OrchestratorBoardWire["github"];
	/**
	 * What the invariant is read off (`invariant.ts`): the registered
	 * Projects' items (undefined while not known in full) and every agent but
	 * the orchestrator. Absent: no invariant is held
	 * (tests).
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
	/**
	 * The mode it starts in (`mode.ts`). Absent: `LAUNCH_MODE`, off — what
	 * every launch of DevHub starts in.
	 */
	readonly mode?: OrchestratorMode;
	/**
	 * How many tasks are in progress, read off the board's lanes as the
	 * Sidebar reads them (`inProgressCount`). Absent: none.
	 */
	readonly inProgress?: (board: LaneBoard) => number;
	/** The mode moved: by the person, or by the usage readout. */
	readonly modeChanged?: (
		change: ModeChange,
		auto: UsageOver | undefined,
	) => void;
	/** Where the triage's priorities are kept across restarts; absent: memory. */
	readonly priorities?: PriorityStorage;
	/** Where the person's requests are kept across restarts; absent: memory. */
	readonly requests?: RequestStorage;
	/** Where the memos are kept across restarts (`memos.ts`); absent: memory. */
	readonly memos?: MemoStorage;
	/** Where who-worked-on-what is kept across restarts (`work.ts`); absent: memory. */
	readonly work?: WorkStorage;
	/** The open Workspace at `folder` on `machine`, for the board's work rows. */
	readonly workspaceAt?: (
		machine: string,
		folder: string,
	) => string | undefined;
	/** Where `agent keep`'s keepings are kept across restarts; absent: memory. */
	readonly kept?: KeptStore;
	readonly now?: () => number;
	readonly setTimer?: (ms: number, run: () => void) => { cancel(): void };
	readonly log?: (line: string) => void;
}

/** The person's last message to an agent, as `escalation.human_direct` carries it. */
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
	/** Open and assigned to the viewer: held to the invariant. */
	readonly inPopulation: boolean;
	/** Its lane on each watched Project it is on. */
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
	/** The item URL its meta `issue=` links it to. */
	readonly linked?: string;
	/** Its meta `issue=pending`: no Issue yet, one to be filed and linked. */
	readonly pendingIssue?: boolean;
	/** The clause it fails, when it does. */
	readonly needsAction?: string;
	readonly kept?: { readonly note: string; readonly at: number };
}

export interface StatusEscalation {
	readonly id: number;
	readonly title: string;
	readonly state: string;
	readonly trigger?: string;
	readonly dueAt?: number;
}

export interface StatusNeedsAction {
	readonly clause: string;
	readonly line: string;
	readonly since: number;
	readonly kept?: { readonly note: string; readonly at: number };
}

/** One subject's whole state now: what `devhub --tell status` prints. */
export type SubjectStatus =
	| {
			readonly subject: "item";
			readonly item: StatusItem;
			readonly needsAction?: StatusNeedsAction;
			readonly agents: readonly StatusAgent[];
			readonly escalations: readonly StatusEscalation[];
	  }
	| {
			readonly subject: "agent";
			readonly agent: StatusAgent;
			readonly item?: StatusItem;
			readonly needsAction?: StatusNeedsAction;
			readonly waiting?: {
				readonly escalationId: number;
				readonly trigger: string;
			};
			readonly escalations: readonly StatusEscalation[];
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
	return {
		clause: view.clause,
		line: view.line,
		since: view.since,
		...(view.kept === undefined ? {} : { kept: view.kept }),
	};
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
	/** `escalationId@waitSince`, once told: one `due` per wait. */
	readonly #dueTold = new Set<string>();
	/** The invariant's subjects, their time, and the agents kept as they are. */
	readonly #invariant: InvariantWatch;
	/** The agents the invariant was last read with. */
	#invariantAgents: readonly InvariantAgent[] = [];
	/** Full, saving or off, and why saving when it was automatic. */
	readonly #mode: OrchestratorModeControl;
	/** The usage readout as last seen, for the automatic switch. */
	#usage: UsageLimitsWire = { clis: [] };
	/** A look at the readout when the window that made saving resets. */
	#resetTimer: { cancel(): void } | undefined;
	/** The orchestrator's ranking of the open work (`triage.ts`). */
	readonly #priorities: PriorityBook;
	/** The person's requests (`requests.ts`). */
	readonly #requests: RequestBook;
	/** The memos, per subject (`memos.ts`). */
	readonly #memos: MemoBook;
	/** Who worked on what, and their sessions (`work.ts`). */
	readonly #work: WorkBook;
	/** The requests handed to the dispatcher this run (held or delivered). */
	readonly #queuedRequests = new Set<number>();
	/** What the next triage is counted from: the last, or the mode going on. */
	#triageAnchor: number | undefined;
	/** When the last `triage` went out to the orchestrator. */
	#triagedAt: number | undefined;

	constructor(private readonly ports: OrchestratorServicePorts) {
		this.#mode = new OrchestratorModeControl(ports.mode ?? LAUNCH_MODE);
		this.#priorities = new PriorityBook(ports.priorities);
		this.#requests = new RequestBook(ports.requests);
		this.#memos = new MemoBook(ports.memos);
		this.#work = new WorkBook(ports.work);
		this.events = new EventDispatcher({
			memo: (subject) => this.memoNote(subject),
			high: (subject) => this.#isHigh(subject),
			mode: this.#mode.mode,
			inProgress: () => this.ports.inProgress?.(this.#laneBoard()) ?? 0,
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
			...(ports.kept === undefined ? {} : { kept: ports.kept }),
		});
		// An escalation linked, parked or closed changes what the invariant
		// reads (`escalationAbout`): read it again, not on the next tick.
		ports.store.onChange(() => {
			this.#watchInvariant();
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
	 * just before it goes: a wait no longer waiting, a window reset — these
	 * need nothing any more.
	 */
	#relevant(event: OrchestratorEvent): boolean {
		switch (event.type) {
			case "waiting.changed": {
				const one = this.ports.store
					.all()
					.find((escalation) => escalation.id === event.escalationId);
				return one !== undefined && currentWait(one)?.at === event.waitSince;
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
		const id = this.ports.store.orchestratorAgentId;
		return id !== undefined && this.ports.agents().some((one) => one.id === id)
			? id
			: undefined;
	}

	/** For tests: a shorter grace. */
	setGrace(ms: number): void {
		this.#graceMs = ms;
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

	// --- triage: priorities ------------------------------------------------------

	/** A subject's priority now: an escalation's own, else the book's. */
	priorityOf(subject: string): Priority | undefined {
		const esc = /^esc (\d+)$/u.exec(subject);
		if (esc !== null)
			return this.ports.store.all().find((one) => one.id === Number(esc[1]))
				?.priority;
		return this.#priorities.get(subject)?.priority;
	}

	#isHigh(subject: string): boolean {
		return this.priorityOf(subject) === "high";
	}

	/**
	 * `orchestrator priority set`: an escalation's is its rank; every other
	 * subject's is kept in the book. An agent is named by its full id.
	 */
	setPriority(ref: SubjectRef, priority: Priority, note?: string): string {
		if (ref.kind === "esc") {
			this.rank(ref.id, { priority });
			this.publish();
			return `esc ${String(ref.id)}`;
		}
		if (ref.kind === "req" && this.#requests.get(ref.id) === undefined)
			throw new Error(
				`there is no request #${String(ref.id)}. Run 'devhub --tell orchestrator request list'.`,
			);
		const key = subjectKey(ref);
		this.#priorities.set(key, {
			priority,
			at: this.#now(),
			...(note === undefined || note === "" ? {} : { note }),
		});
		// A line now high may go in saving.
		this.events.flush();
		this.publish();
		return key;
	}

	clearPriority(ref: Exclude<SubjectRef, { kind: "esc" }>): boolean {
		const had = this.#priorities.clear(subjectKey(ref));
		if (had) this.publish();
		return had;
	}

	/** Every recorded priority, the escalations' included, newest first. */
	priorities(): readonly (PriorityEntry & { readonly subject: string })[] {
		const escalations = this.ports.store
			.all()
			.filter(isOpen)
			.map((one) => ({
				subject: `esc ${String(one.id)}`,
				priority: one.priority ?? "normal",
				at: one.updatedAt,
			}));
		const kept = [...this.#priorities.all()].map(([subject, entry]) => ({
			subject,
			...entry,
		}));
		return [...kept.reverse(), ...escalations];
	}

	get triagedAt(): number | undefined {
		return this.#triagedAt;
	}

	/** When the next triage is due; undefined while off or with no orchestrator. */
	get nextTriageAt(): number | undefined {
		if (this.orchestratorAgentId === undefined) return undefined;
		return nextTriageAt(this.#mode.mode, this.#triageAnchor);
	}

	/** Its time came: ask the orchestrator to rank the open work again. */
	#announceTriage(now: number): void {
		const due = this.nextTriageAt;
		if (due === undefined || due > now) return;
		this.#triageAnchor = now;
		this.events.dispatch({ type: "triage" });
	}

	// --- memos and the work agents did -------------------------------------------

	/**
	 * A subject as the command line names it, made a key: `issue=` / `pr=`
	 * / a URL / `OWNER/REPO#N` (an item), `esc=N` and `req=N` (which must
	 * exist), `agent=ID` (a unique prefix of an agent open now or recorded;
	 * an agent whose work is an item's is that item), or `ws=W` (the work of
	 * that Workspace: `workspace`, resolved by the caller).
	 */
	resolveSubject(
		text: string,
		workspace?: {
			readonly machine: string;
			readonly folder: string;
			readonly agentIds: readonly string[];
		},
	): { readonly key: string; readonly token: string } {
		const typed = readSubject(text);
		if (typed === undefined)
			throw new Error(
				`a subject is issue=OWNER/REPO#N, pr=OWNER/REPO#N (or the item's URL), agent=ID, esc=N, req=N or ws=W, as the event lines name it; not ${JSON.stringify(text)}.`,
			);
		const made = (key: string) => ({ key, token: this.subjectTokenOf(key) });
		switch (typed.kind) {
			case "item":
				return {
					key: typed.key,
					token: subjectToken(
						typed.key,
						typed.itemKind ?? this.#itemKindOf(typed.key),
					),
				};
			case "esc": {
				const id = Number(typed.key.slice(4));
				if (!this.ports.store.all().some((one) => one.id === id))
					throw new Error(
						`there is no escalation #${String(id)}. Run 'devhub --tell escalation list'.`,
					);
				return made(typed.key);
			}
			case "req": {
				const id = Number(typed.key.slice(4));
				if (this.#requests.get(id) === undefined)
					throw new Error(
						`there is no request #${String(id)}. Run 'devhub --tell orchestrator request list'.`,
					);
				return made(typed.key);
			}
			case "agent":
				return made(this.#agentWorkKey(this.#agentIdOf(typed.id)));
			case "ws": {
				if (workspace === undefined)
					throw new Error(`ws=${typed.workspace}: no such workspace.`);
				for (const agentId of workspace.agentIds) {
					const key = this.#agentWorkKey(agentId);
					if (this.#work.get(key) !== undefined || this.#memos.get(key))
						return made(key);
				}
				const recorded = this.#work
					.all()
					.find((record) =>
						record.agents.some(
							(agent) =>
								agent.machine === workspace.machine &&
								stripSlash(agent.folder) === stripSlash(workspace.folder),
						),
					);
				if (recorded !== undefined) return made(recorded.subject);
				const first = workspace.agentIds[0];
				if (first !== undefined) return made(this.#agentWorkKey(first));
				throw new Error(
					`ws=${typed.workspace} has no agent and no recorded work: name the subject (issue=…, agent=…).`,
				);
			}
		}
	}

	/** `issue=…` or `pr=…` for an item key, as far as DevHub knows which. */
	subjectTokenOf(key: string): string {
		return subjectToken(key, this.#itemKindOf(key));
	}

	#itemKindOf(key: string): "issue" | "pr" | undefined {
		if (!key.startsWith("item ")) return undefined;
		const recorded = this.#work.get(key)?.itemKind;
		if (recorded !== undefined) return recorded;
		const ref = key.slice(5);
		const facts = this.ports
			.invariant?.()
			.items?.find(
				(one) =>
					`${one.item.repo}#${String(one.item.number)}`.toLowerCase() === ref,
			);
		return facts?.kind;
	}

	/** An agent's full id, from an id or a unique prefix, open now or recorded. */
	#agentIdOf(text: string): string {
		const ids = new Set<string>();
		for (const agent of this.ports.agents())
			if (agent.id === text || agent.id.startsWith(text)) ids.add(agent.id);
		for (const record of this.#work.all())
			for (const agent of record.agents)
				if (agent.agentId === text || agent.agentId.startsWith(text))
					ids.add(agent.agentId);
		for (const memo of this.#memos.all())
			if (memo.subject.startsWith("agent ")) {
				const id = memo.subject.slice(6);
				if (id === text || id.startsWith(text)) ids.add(id);
			}
		if (ids.has(text)) return text;
		if (ids.size === 1 && text.length >= 4) return [...ids][0]!;
		throw new Error(
			ids.size === 0
				? `no agent is ${text}, open or recorded. Run 'devhub --tell agents' or 'devhub --tell memo list'.`
				: ids.size > 1
					? `${text} names ${String(ids.size)} agents: give more of the id.`
					: `give at least 4 characters of the agent's id, not ${JSON.stringify(text)}.`,
		);
	}

	/** The subject an agent's work is kept under: its item, else itself. */
	#agentWorkKey(agentId: string): string {
		const live = this.#invariantSource()?.agents.find(
			(one) => one.id === agentId,
		);
		if (live !== undefined)
			return normalSubject(
				workSubjectOf({
					agentId,
					...(live.issue === undefined ? {} : { issue: live.issue }),
				}).subject,
			);
		return normalSubject(
			this.#work.byAgent(agentId)?.record.subject ?? `agent ${agentId}`,
		);
	}

	#invariantSource() {
		return this.ports.invariant?.();
	}

	memo(key: string): Memo | undefined {
		return this.#memos.get(key);
	}

	memos(): readonly Memo[] {
		return this.#memos.all();
	}

	addMemo(key: string, text: string, by: string | undefined): Memo {
		const memo = this.#memos.add(key, {
			at: this.#now(),
			text,
			...(by === undefined ? {} : { by }),
		});
		this.publish();
		return memo;
	}

	editMemo(key: string, text: string, by: string | undefined): Memo {
		const memo = this.#memos.replace(key, {
			at: this.#now(),
			text,
			...(by === undefined ? {} : { by }),
		});
		this.publish();
		return memo;
	}

	clearMemo(key: string): boolean {
		const had = this.#memos.clear(key);
		if (had) this.publish();
		return had;
	}

	/**
	 * The note a delivered line about `subject` carries of its memo: the
	 * latest entry's time and its start, `[メモ 11/11 10:02: …]`. An agent's
	 * line carries its work's (its item's) memo; an escalation's, its own or
	 * that of the first item it links. Undefined: there is none.
	 */
	memoNote(subject: string): string | undefined {
		const memo = this.#memoAbout(subject);
		if (memo === undefined) return undefined;
		return `[メモ ${memoClock(memoUpdatedAt(memo))}: ${memoExcerpt(memo, 80)} — 全文: devhub --tell memo show ${this.subjectTokenOf(memo.subject)}]`;
	}

	#memoAbout(subject: string): Memo | undefined {
		const key = normalSubject(subject);
		const own = this.#memos.get(key);
		if (own !== undefined) return own;
		if (key.startsWith("agent "))
			return this.#memos.get(this.#agentWorkKey(key.slice(6)));
		const esc = /^esc (\d+)$/u.exec(key);
		if (esc !== null) {
			const one = this.ports.store.all().find((e) => e.id === Number(esc[1]));
			for (const link of one?.links ?? []) {
				const item = itemOfUrl(link);
				const memo =
					item === undefined ? undefined : this.#memos.get(itemKey(item.ref));
				if (memo !== undefined) return memo;
			}
		}
		return undefined;
	}

	/**
	 * The managed agents open now (every save of the state): recorded under
	 * their work's subject; the memos follow a subject that moved; both
	 * stores pruned.
	 */
	observeWork(live: readonly LiveWorkAgent[]): void {
		const now = this.#now();
		const moves = this.#work.observe(live, now);
		this.#afterWork(moves, now);
	}

	/** An agent closed, with the session it was asked for at its close. */
	workClosed(agent: LiveWorkAgent): void {
		const now = this.#now();
		this.#afterWork(this.#work.closed(agent, now), now);
	}

	#afterWork(
		moves: readonly { from: string; to: string }[],
		now: number,
	): void {
		for (const move of moves) this.#memos.rename(move.from, move.to);
		this.#pruneStores(now);
		this.publish();
	}

	#pruneStores(now: number): void {
		const items = this.#invariantSource()?.items;
		const itemDone = (key: string): number | undefined => {
			if (items === undefined) return undefined;
			const facts = items.find(
				(one) =>
					`item ${one.item.repo}#${String(one.item.number)}`.toLowerCase() ===
					key,
			);
			return facts !== undefined && facts.state !== "open" ? now : undefined;
		};
		this.#work.prune(itemDone, now);
		const liveIds = new Set(this.ports.agents().map((one) => one.id));
		this.#memos.prune(
			{
				doneAt: (key) => {
					const esc = /^esc (\d+)$/u.exec(key);
					if (esc !== null)
						return this.ports.store
							.all()
							.find((one) => one.id === Number(esc[1]))?.closed?.at;
					const req = /^req (\d+)$/u.exec(key);
					if (req !== null)
						return this.#requests.get(Number(req[1]))?.filed?.at;
					return itemDone(key);
				},
				gone: (key) => {
					const esc = /^esc (\d+)$/u.exec(key);
					if (esc !== null)
						return !this.ports.store
							.all()
							.some((one) => one.id === Number(esc[1]));
					const req = /^req (\d+)$/u.exec(key);
					return (
						req !== null && this.#requests.get(Number(req[1])) === undefined
					);
				},
				agentKnown: (key) => {
					const id = key.slice(6);
					return (
						liveIds.has(id) ||
						this.#work.get(key) !== undefined ||
						this.#work.byAgent(id) !== undefined
					);
				},
			},
			now,
		);
	}

	/** Every work record, most recently seen first. */
	workRecords(): readonly WorkRecord[] {
		return this.#work.all();
	}

	/**
	 * The agent `agent resume <subject|agent>` brings back: the latest of
	 * the subject's recorded agents (`text` a subject), or the recorded agent
	 * `text` names (its id, a 4+ prefix, or its name). Undefined: `text`
	 * names neither (it may be a session id). `live` is the agent running
	 * that conversation now, when one is.
	 */
	resumeTarget(
		text: string,
		workspace?: {
			readonly machine: string;
			readonly folder: string;
			readonly agentIds: readonly string[];
		},
	):
		| {
				readonly key: string;
				readonly token: string;
				readonly record: WorkRecord;
				readonly agent: WorkAgent;
				readonly live?: string;
		  }
		| undefined {
		const liveIds = new Set(this.ports.agents().map((one) => one.id));
		const answer = (record: WorkRecord, agent: WorkAgent) => ({
			key: normalSubject(record.subject),
			token: this.subjectTokenOf(normalSubject(record.subject)),
			record,
			agent,
			...(liveIds.has(agent.agentId) ? { live: agent.agentId } : {}),
		});
		const typed = readSubject(text);
		if (typed !== undefined && typed.kind !== "agent") {
			if (typed.kind === "esc" || typed.kind === "req") return undefined;
			const { key } = this.resolveSubject(text, workspace);
			const record = this.#work.get(key);
			const agent = record?.agents.at(-1);
			if (record === undefined || agent === undefined)
				throw new Error(
					`DevHub has no record of an agent that worked on ${this.subjectTokenOf(key)}: start a new one (issue assign / agent new), or resume a session by its id ('devhub --tell sessions --all').`,
				);
			return answer(record, agent);
		}
		const id = typed?.kind === "agent" ? typed.id : text;
		const matches: { record: WorkRecord; agent: WorkAgent }[] = [];
		for (const record of this.#work.all())
			for (const agent of record.agents)
				if (
					agent.agentId === id ||
					(id.length >= 4 && agent.agentId.startsWith(id)) ||
					agent.name === id
				)
					matches.push({ record, agent });
		if (matches.length === 0) {
			if (typed?.kind === "agent")
				throw new Error(
					`DevHub has no record of agent ${id}'s work. Run 'devhub --tell memo list' (its WORK lines) or 'devhub --tell sessions --all'.`,
				);
			return undefined;
		}
		if (new Set(matches.map((one) => one.agent.agentId)).size > 1)
			throw new Error(
				`${JSON.stringify(id)} names more than one recorded agent: ${matches.map((one) => `${one.agent.agentId} (${one.agent.name})`).join(", ")}.`,
			);
		return answer(matches[0]!.record, matches[0]!.agent);
	}

	#memoWires(): readonly OrchestratorMemoWire[] {
		return this.#memos.all().map((memo) => ({
			subject: memo.subject,
			token: this.subjectTokenOf(memo.subject),
			updatedAt: memoUpdatedAt(memo),
			entries: memo.entries.map((entry) => ({
				at: entry.at,
				text: entry.text,
				...(entry.by === undefined ? {} : { by: entry.by }),
			})),
		}));
	}

	#workWires(): readonly OrchestratorWorkWire[] {
		const liveIds = new Set(this.ports.agents().map((one) => one.id));
		return this.#work.all().map((record) => ({
			subject: record.subject,
			token: this.subjectTokenOf(normalSubject(record.subject)),
			...(record.url === undefined ? {} : { url: record.url }),
			agents: record.agents.map((agent) => {
				const workspaceId = this.ports.workspaceAt?.(
					agent.machine,
					agent.folder,
				);
				return {
					agentId: agent.agentId,
					name: agent.name,
					profileId: agent.profileId,
					kind: agent.kind,
					machine: agent.machine,
					folder: agent.folder,
					...(agent.branch === undefined ? {} : { branch: agent.branch }),
					...(agent.sessions.at(-1) === undefined
						? {}
						: { session: agent.sessions.at(-1)! }),
					live: liveIds.has(agent.agentId),
					resumable:
						!liveIds.has(agent.agentId) &&
						agent.sessions.length > 0 &&
						(agent.kind === "claude" || agent.kind === "codex"),
					...(agent.stoppedAt === undefined
						? {}
						: { stoppedAt: agent.stoppedAt }),
					...(workspaceId === undefined ? {} : { workspaceId }),
				};
			}),
		}));
	}

	// --- the person's requests ---------------------------------------------------

	/** The person's request, from the board's +: kept, and delivered as their words. */
	request(text: string): PersonRequest {
		const made = this.#requests.add(text, this.#now());
		this.#dispatchRequest(made);
		this.publish();
		return made;
	}

	/**
	 * A request to the dispatcher: delivered at once, or held while off.
	 * With no orchestrator running there is nobody to hold it for, so it is
	 * not queued, and goes when one is started (`#releaseRequests`).
	 */
	#dispatchRequest(request: PersonRequest): void {
		const entry = this.events.dispatch({
			type: "request",
			requestId: request.id,
			text: request.text,
		});
		if (entry.fate !== "dropped") this.#queuedRequests.add(request.id);
	}

	/**
	 * The requests waiting for an orchestrator (sent with none running, or
	 * kept from before a restart): to the dispatcher, now there is one.
	 */
	#releaseRequests(): void {
		if (this.orchestratorAgentId === undefined) return;
		for (const one of this.#requests.open())
			if (one.state === "held" && !this.#queuedRequests.has(one.id))
				this.#dispatchRequest(one);
	}

	/** `orchestrator request done`: filed as a task, and where. */
	fileRequest(id: number, note: string | undefined): PersonRequest {
		const filed = this.#requests.file(id, this.#now(), note);
		this.publish();
		return filed;
	}

	requests(): readonly PersonRequest[] {
		return this.#requests.all();
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

	// --- the orchestrator ----------------------------------------------------

	/** Assign the orchestrator agent, and tell it it has started. */
	assign(agentId: string, initPrompt?: string): void {
		this.ports.store.setOrchestrator(agentId);
		// `init` reads the board: the first triage is an interval away.
		this.#triageAnchor = this.#now();
		if (initPrompt !== undefined) this.ports.deliver(agentId, initPrompt);
		else this.events.dispatch({ type: "init" });
		// Requests sent while none ran: after init, each as the person's words.
		this.#releaseRequests();
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
		linkLabels?: Readonly<Record<string, string>>,
	): Escalation {
		return this.ports.store.ask(
			id,
			markdown,
			options,
			this.#now(),
			links,
			linkLabels,
		);
	}

	close(id: number, note: string | undefined): Escalation {
		return this.ports.store.close(id, note, this.#now());
	}

	/**
	 * `escalation hold`: the orchestrator parks it in 対応中 while it works on
	 * it, or notes where an 対応中 one stands. A `held` note, on the
	 * orchestrator's side: never an answer.
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

	link(
		id: number,
		more: {
			readonly agentId?: string;
			readonly links?: readonly string[];
			readonly linkLabels?: Readonly<Record<string, string>>;
		},
	): Escalation {
		return this.ports.store.link(id, more, this.#now());
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
	 * else the orchestrator caused itself.
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
						// Never seen before it (a restart of DevHub, a resumed
						// session): not known, so going on from it is not going
						// back to work.
						status: workStatus(agent, this.#status.get(agent.id) ?? "unknown"),
					}
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
			if (event.type === "request") {
				this.#requests.sent(event.requestId, this.#now());
				moved = true;
				continue;
			}
			if (event.type === "triage") {
				this.#triagedAt = this.#now();
				moved = true;
				continue;
			}
			if (event.type !== "escalation_answered") continue;
			if (event.readThrough === undefined) continue;
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
				type: "waiting.changed",
				escalationId: one.id,
				reasons: ["due"],
				waitSince: wait.at,
			});
		}
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
		const orchestrator = this.ports.store.orchestratorAgentId;
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
			escalations: this.ports.store
				.all()
				.filter(isOpen)
				.map((one) => ({
					id: one.id,
					title: one.title,
					state: escalationState(one),
					links: one.links,
					agents: one.agents,
					...(one.workspaceId === undefined
						? {}
						: { workspaceId: one.workspaceId }),
					...(currentWait(one) === undefined
						? {}
						: {
								trigger: currentWait(one)!.markdown,
								waitSince: currentWait(one)!.at,
							}),
				})),
		});
		this.#invariant.observe(reading, this.orchestratorAgentId !== undefined);
	}

	/**
	 * `agent keep A --note`: leave a managed agent that needs action as it is, for
	 * the reason given, until its facts change.
	 */
	keep(agentId: string, note: string): KeptAgent {
		this.observe();
		const kept = this.#invariant.keep(agentId, note);
		this.publish();
		return kept;
	}

	/** `agent keep A --clear`: whether it was being kept. */
	unkeep(agentId: string): boolean {
		const was = this.#invariant.unkeep(agentId);
		this.observe();
		return was;
	}

	/** How an agent stands against the invariant, and whether it is kept. */
	standing(
		agentId: string,
	): (AgentStanding & { readonly kept?: KeptAgent }) | undefined {
		const standing = this.#invariant.standing(agentId);
		if (standing === undefined) return undefined;
		const kept = this.#invariant.kept(agentId);
		return kept === undefined ? standing : { ...standing, kept };
	}

	/** Every subject that needs action now. */
	needsAction(): readonly NeedsActionView[] {
		return this.#invariant.needsAction();
	}

	/**
	 * `devhub --tell status`: the whole state of one subject now — an item
	 * (its URL, or `owner/repo#N`) or an agent — as far as DevHub knows it:
	 * the item's state, assignment, lanes and pull request (review decision,
	 * unresolved conversations, checks), the agents linked to it and how each
	 * stands, the escalations about it, the clause it fails and since when,
	 * and `agent keep`'s note. Undefined when DevHub has read no such item
	 * (or has no such agent).
	 */
	status(
		target: { readonly item: string } | { readonly agentId: string },
	): SubjectStatus | undefined {
		this.observe();
		const reading = this.#invariant.reading;
		if ("item" in target) {
			const item = findItem(reading, target.item);
			if (item === undefined) return undefined;
			const view = this.#invariant.view(`item ${item.key}`);
			return {
				subject: "item",
				item: statusItem(item),
				...(view === undefined ? {} : { needsAction: needsActionOf(view) }),
				agents: item.agents.flatMap((id) => {
					const agent = this.#statusAgent(id);
					return agent === undefined ? [] : [agent];
				}),
				escalations: this.#statusEscalations(item.escalations),
			};
		}
		const agent = this.#statusAgent(target.agentId);
		if (agent === undefined) return undefined;
		const standing = this.#invariant.standing(target.agentId);
		const view = this.#invariant.view(`agent ${target.agentId}`);
		const item =
			standing?.item?.item.url === undefined
				? undefined
				: findItem(reading, standing.item.item.url);
		return {
			subject: "agent",
			agent,
			...(item === undefined ? {} : { item: statusItem(item) }),
			...(view === undefined ? {} : { needsAction: needsActionOf(view) }),
			...(standing?.waiting === undefined ? {} : { waiting: standing.waiting }),
			escalations: this.#statusEscalations(standing?.escalations ?? []),
		};
	}

	#statusAgent(id: string): StatusAgent | undefined {
		const agent = this.#invariantAgents.find((one) => one.id === id);
		if (agent === undefined) return undefined;
		const standing = this.#invariant.standing(id);
		const kept = this.#invariant.kept(id);
		return {
			id: agent.id,
			name: agent.name,
			ws: agent.ws,
			workspaceId: agent.workspaceId,
			status: agent.stopping ? "stopping" : agent.status,
			managed: agent.managed,
			...(agent.issue === undefined ? {} : { linked: agent.issue }),
			...(agent.issuePending === true ? { pendingIssue: true } : {}),
			...(standing?.breach === undefined
				? {}
				: { needsAction: breachWords(standing.breach) }),
			...(kept === undefined ? {} : { kept: { note: kept.note, at: kept.at } }),
		};
	}

	#statusEscalations(ids: readonly number[]): StatusEscalation[] {
		return ids.flatMap((id) => {
			const one = this.ports.store.get(id);
			if (one === undefined) return [];
			const wait = currentWait(one);
			return [
				{
					id: one.id,
					title: one.title,
					state: escalationState(one),
					...(wait === undefined ? {} : { trigger: wait.markdown }),
					...(wait?.dueAt === undefined ? {} : { dueAt: wait.dueAt }),
				},
			];
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
			...(one.linkLabels === undefined ? {} : { linkLabels: one.linkLabels }),
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

	/** The board's lanes alone: what `inProgress` is read off. */
	#laneBoard(): LaneBoard {
		const lanes = this.#lanes();
		const escalation = (one: Escalation) => this.toWire(one);
		return {
			needsAnswer: lanes.needsAnswer.map(escalation),
			inProgress: lanes.inProgress.map(escalation),
			waiting: lanes.waiting.map(escalation),
			agentStates: this.#agentStates(),
		};
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
			mode: this.#mode.mode,
			...(this.#mode.auto === undefined ? {} : { autoSaving: this.#mode.auto }),
			inProgressTasks: this.ports.inProgress?.(this.#laneBoard()) ?? 0,
			held: this.events.held().length,
			nextDelivery: this.#nextDelivery(),
			github: this.ports.github?.() ?? { state: "idle" },
			needsAction: this.#invariant.needsAction().map((view) => {
				const priority = this.priorityOf(view.subject);
				return priority === undefined ? view : { ...view, priority };
			}),
			requests: [
				...this.#requests.open(),
				...this.#requests
					.all()
					.filter((one) => one.state === "filed")
					.slice(-3)
					.reverse(),
			].map((one) => ({
				id: one.id,
				text: one.text,
				at: one.at,
				state: one.state,
				...(one.filed === undefined ? {} : { filed: one.filed }),
				...(this.priorityOf(`req ${String(one.id)}`) === undefined
					? {}
					: { priority: this.priorityOf(`req ${String(one.id)}`)! }),
			})),
			agentPriorities: Object.fromEntries(
				this.ports.agents().flatMap((agent) => {
					const priority = this.priorityOf(`agent ${agent.id}`);
					return priority === undefined ? [] : [[agent.id, priority]];
				}),
			),
			triage: {
				...(this.#triagedAt === undefined ? {} : { lastAt: this.#triagedAt }),
				...(this.nextTriageAt === undefined
					? {}
					: { nextAt: this.nextTriageAt }),
			},
			agentStates: this.#agentStates(),
			memos: this.#memoWires(),
			work: this.#workWires(),
			needsAnswer: lanes.needsAnswer.map(escalation),
			inProgress: lanes.inProgress.map(escalation),
			waiting: lanes.waiting.map(escalation),
			closed: lanes.closed.slice(0, CLOSED_SHOWN).map(escalation),
			graceMs: this.#graceMs,
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

	/** What each agent's row shows of the orchestration. */
	#agentStates(): Record<string, AgentOrchestrationWire> {
		const out: Record<string, AgentOrchestrationWire> = {};
		for (const agent of this.ports.agents()) {
			const standing = this.#invariant.standing(agent.id);
			const kept = this.#invariant.kept(agent.id);
			const breach = standing?.breach;
			const needsAction = breach !== undefined && kept === undefined;
			const state: AgentOrchestrationWire = {
				...(standing?.waiting === undefined
					? {}
					: { waiting: standing.waiting }),
				...(needsAction ? { needsAction: breachWords(breach) } : {}),
				...(kept === undefined
					? {}
					: { kept: { note: kept.note, at: kept.at } }),
			};
			if (Object.keys(state).length > 0) out[agent.id] = state;
		}
		return out;
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
		this.#resetTimer?.cancel();
		this.events.dispose();
		this.timers.stop();
	}
}

function stripSlash(path: string): string {
	return path.length > 1 ? path.replace(/\/+$/u, "") : path;
}

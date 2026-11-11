/**
 * Events for the orchestrator: the seam everything that wants the
 * orchestrator to act goes through.
 *
 * A source — the board, the invariant (`invariant.ts`, read off GitHub's
 * items, `githubItems.ts`), the timers (`timers.ts`), the usage readout,
 * `orchestrator emit` — calls `dispatch` with an `OrchestratorEvent`. The
 * dispatcher
 *
 * 1. drops what the `[orchestrator] events` patterns filter out;
 * 2. sends **the person's words** (`escalation_answered`,
 *    `escalation.human_direct`: `isHumanInput`) at once, each as a message of
 *    its own whose text is what they typed, under one line naming the
 *    escalation (`humanMessage`) — never inside an event line or the
 *    `event_prompt` template, so the orchestrator reads it as the person's
 *    own input. Only a pause holds them;
 * 3. keeps the rest **pending** as action items, not a history: **one line
 *    per subject** (`subjectOf`: an item, an agent, an escalation, a timer,
 *    a usage window, a custom type and text). A newer statement about a
 *    pending subject replaces the older one (`merge`):
 *    a line says how the subject stands now, not what happened to it;
 * 4. just before delivery, drops what no longer needs attention (`relevant`:
 *    a wait no longer waiting, a usage window reset) as `dropped-stale`;
 * 5. delivers everything pending, and **the invariant's `needs_action`
 *    lines** (`standing`: every subject that needs action at that moment,
 *    the kept ones left out), as **one** message — one line per subject
 *    (`eventLine`) as `{EVENT}`, at most `MAX_DELIVERY_LINES` and a last
 *    line counting the rest, and as JSON for `{EVENT_JSON}` only when the
 *    template has it — at most once per `[orchestrator] delivery_interval`,
 *    once the orchestrator can take it: not paused, not in a foreground
 *    turn, nothing of ours still queued for it (`busy`). Background work of
 *    its own (shells, tasks, subagents) does not hold it. `needs_action` is
 *    never pending: it is read at each delivery, so while a subject needs
 *    action it is on every one — a delivery every `delivery_interval` while
 *    any does (the nag) — and a subject that settled in between is on none.
 *    A delivery with nothing to carry is not sent.
 *
 * **The mode** (`mode.ts`): `full` is all of the above; `saving` makes the
 * interval `SAVING_INTERVAL_FACTOR` times as long and holds every batch
 * while `inProgress` is `SAVING_BUSY_TASKS` or more (a batch carrying
 * `init` excepted; the person's words are never batches); `off` is the
 * pause below.
 *
 * **Paused** (`off`) holds everything, the person's words too, and the sources that
 * cost something (GitHub) are suspended (`paused`); `resume` sends at once
 * the person's words, then everything else — pending and standing — as one
 * message, whatever the interval, the orchestrator's turn or the pickup
 * wait; the interval counts from there. The sources start again alongside:
 * what their catch-up finds goes with the next delivery.
 *
 * What the next delivery would send is `preview()`: the same composition
 * (`composeDelivery`) a delivery makes, read off the same state, with
 * nothing marked, logged or changed — for the board's hover card.
 *
 * With no orchestrator assigned there is nobody to tell, and an
 * event is dropped (and kept in the log as dropped): the next start's `init`
 * sends it to the board anyway.
 *
 * Every event, whatever came of it, is kept in a short log (`log`) for
 * `devhub --tell orchestrator events`.
 *
 * Adding an event is a variant here, its line in `linePartsOf`, and a
 * `dispatch` where it happens. See `docs/orchestrator.md`, "Events".
 */

import {
	SAVING_BUSY_TASKS,
	SAVING_INTERVAL_FACTOR,
	type OrchestratorMode,
} from "./mode.js";
import {
	EVENT_JSON_PLACEHOLDER,
	EVENT_PLACEHOLDER,
	eventAllowed,
	parseInterval,
	renderEventPrompt,
} from "../../model/orchestratorSettings.js";

/** An agent, as an event names it: its id (to address it by) and its name. */
export interface EventAgent {
	readonly id: string;
	readonly name?: string;
}

/** An Issue or a pull request, as an event names it. */
export interface EventItem {
	/** `owner/name`. */
	readonly repo: string;
	readonly number: number;
	readonly title?: string;
	readonly url?: string;
}

/** What the person wrote, carried in the event itself. */
export interface HumanWords {
	readonly text: string;
	/** The quick reply it is, when the person picked one of the question's options. */
	readonly option?: string;
}

export type OrchestratorEvent =
	/** The orchestrator has just been started (or restarted). */
	| { readonly type: "init" }
	/** The person answered an escalation: it is `in_progress` now. */
	| {
			readonly type: "escalation_answered";
			readonly escalationId: number;
			readonly title: string;
			readonly agents: readonly EventAgent[];
			/** What they wrote. */
			readonly answers?: readonly HumanWords[];
			/**
			 * How many of the escalation's entries the answer completes: what
			 * delivering it acknowledges as read (`acknowledge`).
			 */
			readonly readThrough?: number;
	  }
	/**
	 * The person talked to one of an open escalation's agents directly, from
	 * its own composer, and it took that up (went working). A `needs_answer`
	 * one has moved to `in_progress`; either way what was said may answer it,
	 * or change it.
	 */
	| {
			readonly type: "escalation.human_direct";
			readonly escalationId: number;
			readonly title: string;
			readonly agent: EventAgent;
			/** `agent read --since`: the person's message. */
			readonly since?: string;
			/** What they said; absent when it could not be read. */
			readonly messages?: readonly HumanWords[];
	  }
	/**
	 * A subject that breaks the invariant (`invariant.ts`): an item of the
	 * population or a managed agent, and the clause it fails. No state: that
	 * is `devhub --tell status`'s.
	 */
	| {
			readonly type: "needs_action";
			readonly subject:
				| { readonly kind: "issue" | "pr"; readonly item: EventItem }
				| { readonly kind: "agent"; readonly agent: EventAgent };
			readonly ws?: string;
			readonly breach: Breach;
	  }
	/**
	 * A 待機中 escalation may be ready: what it is about moved (its items,
	 * its agents: `subjects_changed`), or its `--at` time came (`due`, once
	 * per wait). Which of the two, nothing more. Dropped before it goes if it
	 * has left 待機中 or waits anew.
	 */
	| {
			readonly type: "waiting.changed";
			readonly escalationId: number;
			readonly reasons: readonly WaitingReason[];
			/** The wait it is about: its entry's time. */
			readonly waitSince: number;
	  }
	| {
			readonly type: "timer.elapsed";
			readonly name: string;
			readonly interval: string;
	  }
	/**
	 * A plan window's use crossed `threshold` upward (`[orchestrator]
	 * usage_thresholds`; `usageThresholds.ts`): once per threshold per window
	 * period.
	 */
	| {
			readonly type: "usage.threshold";
			/** `claude`, `codex`. */
			readonly cli: string;
			/** `5-hour`, `7-day`: the window, as the readout names it. */
			readonly window: string;
			readonly threshold: number;
			/** 0–100, as read. */
			readonly usedPercent: number;
			/** Epoch ms; absent when the CLI does not say. */
			readonly resetsAt?: number;
	  }
	/**
	 * Time to rank the open work again (`triage.ts`): every escalation, item,
	 * managed agent and request, each `high`, `normal` or `low`, recorded
	 * with `orchestrator priority set`.
	 */
	| { readonly type: "triage" }
	/**
	 * The person's request, from the Orchestrator screen's +: their words,
	 * delivered at once as their own message (`isHumanInput`). The
	 * orchestrator files it as a task and marks it `orchestrator request done`.
	 */
	| {
			readonly type: "request";
			readonly requestId: number;
			readonly text: string;
	  }
	| { readonly type: `custom.${string}`; readonly text: string };

export type OrchestratorEventType = OrchestratorEvent["type"];

/**
 * The invariant's clause a subject fails (`invariant.ts`), as a short code:
 * an item with no agent linked, or whose agents are all stopped with no
 * 要回答 / 待機中 escalation about it (`idle_no_escalation`); a managed agent
 * stopped with no such escalation, or linked to an item outside the
 * population, or to none (`outside_population`, and why).
 */
export type NeedsActionClause =
	| "no_agent"
	| "idle_no_escalation"
	| "outside_population";

/** Why an agent's item is outside the population. */
export type OutsideReason =
	| "closed"
	| "unassigned"
	| "not_in_project"
	| "no_item";

export interface Breach {
	readonly clause: NeedsActionClause;
	/** With `outside_population`. */
	readonly outside?: OutsideReason;
}

/** `no_agent`, `outside_population (closed)`: a breach as a line says it. */
export function breachWords(breach: Breach): string {
	return breach.outside === undefined
		? breach.clause
		: `${breach.clause} (${breach.outside})`;
}

/** Why a 待機中 escalation may be ready, as `waiting.changed` says it. */
export type WaitingReason = "subjects_changed" | "due";

/** Every type DevHub itself emits (`custom.*` is the open family). */
export const EVENT_TYPES = [
	"init",
	"escalation_answered",
	"escalation.human_direct",
	"needs_action",
	"waiting.changed",
	"timer.elapsed",
	"usage.threshold",
	"triage",
	"request",
	"custom.*",
] as const;

/** `custom.NAME`: what `orchestrator emit --type` takes. */
export function customTypeProblem(type: string): boolean {
	return !/^custom\.[a-z0-9][a-z0-9_-]{0,39}$/u.test(type);
}

/** An event that carries the person's own words. */
export type HumanInputEvent = Extract<
	OrchestratorEvent,
	{ type: "escalation_answered" | "escalation.human_direct" | "request" }
>;

/** The person's own words: sent at once, as they typed them. */
export function isHumanInput(
	event: OrchestratorEvent,
): event is HumanInputEvent {
	return (
		event.type === "escalation_answered" ||
		event.type === "escalation.human_direct" ||
		event.type === "request"
	);
}

// --- the line ----------------------------------------------------------------

/** The part of an id `--tell` takes as a unique prefix: a UUID's first block. */
export function shortId(id: string): string {
	const match = /^([0-9a-f]{8})-[0-9a-f-]+$/iu.exec(id);
	return match === null ? id : match[1]!;
}

/**
 * A Workspace as `ws=` names it: its name, which `--tell` takes, unless the
 * name has a space in it (then its id, which it takes too).
 */
export function workspaceToken(label: string, id: string): string {
	return /^\S+$/u.test(label) ? label : id;
}

/** One line, whitespace folded, at most `max` characters. */
export function excerpt(text: string | undefined, max = 120): string {
	const line = (text ?? "").replace(/\s+/gu, " ").trim();
	if (line.length <= max) return line;
	return `${line.slice(0, max - 1)}…`;
}

function agentToken(agent: EventAgent): string {
	const name = agent.name === undefined ? "" : ` (${excerpt(agent.name, 40)})`;
	return `agent=${shortId(agent.id)}${name}`;
}

function title(text: string | undefined): string {
	return text === undefined || text.length === 0
		? ""
		: `「${excerpt(text, 40)}」`;
}

/**
 * A time as a line says it, in this Mac's time zone: `19:20` within the next
 * day, `11-08 10:00` beyond (`joiner` between the two: `T` where a space would
 * split a `key=value`).
 */
export function clockAt(ms: number, now: number, joiner = " "): string {
	const at = new Date(ms);
	const two = (n: number) => String(n).padStart(2, "0");
	const clock = `${two(at.getHours())}:${two(at.getMinutes())}`;
	if (Math.abs(ms - now) < 20 * 3_600_000) return clock;
	return `${two(at.getMonth() + 1)}-${two(at.getDate())}${joiner}${clock}`;
}

/** `5-hour` → `5時間枠`, `7-day` → `7日枠`; another name as it is, `枠` after. */
export function windowWords(window: string): string {
	const match = /^(\d+)-(minute|hour|day)$/u.exec(window);
	if (match === null) return `${window} 枠`;
	const unit = { minute: "分", hour: "時間", day: "日" }[
		match[2] as "minute" | "hour" | "day"
	];
	return `${match[1]!}${unit}枠`;
}

/** `owner/repo#123`, as `issue=` says it. */
function issueRef(item: EventItem): string {
	return `${item.repo}#${String(item.number)}`;
}

/**
 * What `{EVENT}` holds for one event: one line — `[type]`, the ids the next
 * command takes and the facts as `key=value`, then `—` and a short summary
 * where there is one to say.
 */
export function eventLine(event: OrchestratorEvent, now: number): string {
	const parts = linePartsOf(event, now);
	return [
		`[${event.type}]`,
		...parts.head,
		...(parts.summary === undefined ? [] : [`— ${parts.summary}`]),
		...(parts.url === undefined ? [] : [parts.url]),
	]
		.filter((part) => part.length > 0)
		.join(" ");
}

function needsActionParts(
	event: Extract<OrchestratorEvent, { type: "needs_action" }>,
): LineParts {
	const subject = event.subject;
	return {
		head: [
			subject.kind !== "agent"
				? `${subject.kind}=${issueRef(subject.item)}`
				: agentToken(subject.agent),
			...(event.ws === undefined ? [] : [`ws=${event.ws}`]),
		],
		summary: breachWords(event.breach),
	};
}

/**
 * A `needs_action` line without its `[type]`: the subject, its Workspace and
 * the clause — `issue=acme/web#123 ws=web — no_agent`.
 */
export function needsActionWords(
	event: Extract<OrchestratorEvent, { type: "needs_action" }>,
): string {
	const parts = needsActionParts(event);
	return [...parts.head, `— ${parts.summary ?? ""}`].join(" ");
}

interface LineParts {
	readonly head: readonly string[];
	readonly summary?: string;
	readonly url?: string;
}

function linePartsOf(event: OrchestratorEvent, now: number): LineParts {
	switch (event.type) {
		case "init":
			return {
				head: [],
				summary:
					"オーケストレーターが起動しました。devhub --tell board で現状を確認",
			};
		case "escalation_answered":
			return {
				head: [
					`esc=${String(event.escalationId)}${title(event.title)}`,
					...event.agents.map(agentToken),
				],
				summary: "人が回答しました",
			};
		case "escalation.human_direct":
			return {
				head: [
					`esc=${String(event.escalationId)}${title(event.title)}`,
					agentToken(event.agent),
					...(event.since === undefined ? [] : [`since=${event.since}`]),
				],
				summary: "人がエージェントと直接やりとりしました",
			};
		case "needs_action":
			return needsActionParts(event);
		case "waiting.changed":
			return {
				head: [`esc=${String(event.escalationId)}`],
				summary: event.reasons.join(", "),
			};
		case "timer.elapsed":
			return { head: [event.name] };
		case "triage":
			return {
				head: [],
				summary:
					"優先度の見直し: devhub --tell --json board で開いている仕事 (エスカレーション、要対応のアイテムとエージェント、依頼) を見て、それぞれ devhub --tell orchestrator priority set <対象> high|normal|low",
			};
		case "request":
			return {
				head: [`req=${String(event.requestId)}`],
				summary: excerpt(event.text, 200),
			};
		case "usage.threshold":
			return {
				head: [
					`cli=${event.cli}`,
					`window=${event.window}`,
					`pct=${String(Math.floor(event.usedPercent))}`,
					...(event.resetsAt === undefined
						? []
						: [`resets=${clockAt(event.resetsAt, now, "T")}`]),
				],
				summary: `${windowWords(event.window)}が${String(event.threshold)}%を超えました`,
			};
		default:
			return { head: [], summary: excerpt(event.text, 200) };
	}
}

/**
 * The message the person's words go as: one line naming the escalation (and
 * the agent, for a message to it), then their text exactly as typed —
 * unquoted, unwrapped, no template around it.
 */
export function humanMessage(
	event: Extract<
		OrchestratorEvent,
		{ type: "escalation_answered" | "escalation.human_direct" }
	>,
	piece: HumanWords | undefined,
): string {
	const esc = `esc=${String(event.escalationId)}${title(event.title)}`;
	if (event.type === "escalation_answered") {
		const option =
			piece?.option === undefined
				? ""
				: ` (選択肢「${excerpt(piece.option, 80)}」)`;
		return piece === undefined
			? `${esc} に人が回答しました (devhub --tell escalation show ${String(event.escalationId)} で読む)`
			: `${esc} への人の回答${option}:\n${piece.text}`;
	}
	const agent = shortId(event.agent.id);
	return piece === undefined
		? `${esc} agent=${agent} に人が直接話しかけました (devhub --tell agent read ${agent}${event.since === undefined ? "" : ` --since ${event.since}`} で読む)`
		: `${esc} agent=${agent} に人が直接送ったメッセージ:\n${piece.text}`;
}

/** The messages one human event goes as: one per piece of their words. */
export function humanMessages(event: HumanInputEvent): string[] {
	if (event.type === "request")
		return [
			`req=${String(event.requestId)} 人からの依頼 (タスクとして登録し、devhub --tell orchestrator request done ${String(event.requestId)} --note "<登録先>" で受付済みにしてください):\n${event.text}`,
		];
	const pieces =
		event.type === "escalation_answered"
			? (event.answers ?? [])
			: (event.messages ?? []);
	return pieces.length === 0
		? [humanMessage(event, undefined)]
		: pieces.map((piece) => humanMessage(event, piece));
}

// --- subjects: one line per thing that may need attention ------------------------

function prKey(pr: EventItem): string {
	return `${pr.repo}#${String(pr.number)}`;
}

/**
 * What an event is about. While pending, a subject is **one line**: the
 * latest statement about it.
 */
export function subjectOf(event: OrchestratorEvent): string {
	switch (event.type) {
		case "init":
			return "init";
		case "escalation_answered":
		case "escalation.human_direct":
		case "waiting.changed":
			return `esc ${String(event.escalationId)}`;
		case "triage":
			return "triage";
		case "request":
			return `req ${String(event.requestId)}`;
		case "needs_action":
			return event.subject.kind !== "agent"
				? `item ${prKey(event.subject.item)}`
				: `agent ${event.subject.agent.id}`;
		case "timer.elapsed":
			return `timer ${event.name}`;
		case "usage.threshold":
			return `usage ${event.cli} ${event.window}`;
		default:
			return `${event.type} ${event.text}`;
	}
}

/**
 * `older` and `newer` (one subject) as the one statement they become. A
 * timer pending once stands; a wait's two reasons add up; anything else
 * says how the subject stands now, and the latest does.
 */
export function merge(
	older: OrchestratorEvent,
	newer: OrchestratorEvent,
): OrchestratorEvent {
	if (older.type === "timer.elapsed" && newer.type === "timer.elapsed")
		return older;
	// The same wait: both of what happened to it are said.
	if (
		older.type === "waiting.changed" &&
		newer.type === "waiting.changed" &&
		older.waitSince === newer.waitSince
	)
		return {
			...newer,
			reasons: (["due", "subjects_changed"] as const).filter(
				(one) => older.reasons.includes(one) || newer.reasons.includes(one),
			),
		};
	return newer;
}

// --- the dispatcher ------------------------------------------------------------

/** What came of an event, as `orchestrator events` lists it. */
export type EventFate =
	| "pending"
	| "delivered"
	| "filtered"
	/** Replaced by a later event about the same subject (`into`). */
	| "coalesced"
	/** No longer needed attention when it would have gone (`reason`). */
	| "dropped-stale"
	/** Beyond a delivery's cap: counted in its last line, not sent. */
	| "overflow"
	| "dropped";

export interface EventLogEntry {
	readonly seq: number;
	readonly at: number;
	readonly event: OrchestratorEvent;
	fate: EventFate;
	/** When it went out (delivered), or was folded into `into` (coalesced). */
	settledAt?: number;
	into?: number;
	/** Why it was dropped-stale. */
	reason?: string;
}

/** How many events the log keeps. */
export const EVENT_LOG_SIZE = 200;
/** How long a batch waits for more before it goes out. */
export const BATCH_WINDOW_MS = 300;
/**
 * After a delivery, how long the next one waits for the orchestrator to be
 * seen taking the last one (busy, or the message out of the queue) before it
 * goes anyway.
 */
export const PICKUP_TIMEOUT_MS = 60_000;
/** How often a batch held by that wait looks again. */
const PICKUP_RETRY_MS = 2_000;
/** The most lines one delivery carries; the rest are counted on a last line. */
export const MAX_DELIVERY_LINES = 50;

export interface EventDelivery {
	/** The agent to tell, while one is assigned. */
	readonly orchestrator: () => string | undefined;
	/** `[orchestrator]` as DevHub runs on it now. */
	readonly settings: () => {
		readonly event_prompt: string;
		readonly init_prompt: string | undefined;
		readonly events: readonly string[];
		readonly delivery_interval: string;
	};
	/** Queue `text` for `agentId` as the person's message (held mid-turn). */
	readonly deliver: (agentId: string, text: string) => void;
	/**
	 * Whether `agentId` cannot take a batch now: in a foreground turn, or
	 * something of ours is still queued for it. Absent: it always can.
	 */
	readonly busy?: (agentId: string) => boolean;
	/**
	 * Whether a pending event still needs attention, read off live state just
	 * before it goes. False: it is dropped as `dropped-stale`. Absent:
	 * everything does.
	 */
	readonly relevant?: (event: OrchestratorEvent) => boolean;
	/**
	 * The pause moved: the sources that cost something follow it. A resume
	 * does not wait for them.
	 */
	readonly paused?: (paused: boolean) => void;
	/**
	 * How many tasks are in progress now (the Sidebar's 対応中 heading): in
	 * saving, a batch waits while it is `SAVING_BUSY_TASKS` or more. Absent:
	 * none.
	 */
	readonly inProgress?: () => number;
	/**
	 * Whether a line's subject (`subjectOf`) is ranked high now
	 * (`triage.ts`): in saving only those go, until a batch carries
	 * `triage`. Absent: every subject is (no gate).
	 */
	readonly high?: (subject: string, event: OrchestratorEvent) => boolean;
	/** The mode it starts in. Absent: `full` (tests); main starts `off`. */
	readonly mode?: OrchestratorMode;
	/**
	 * What every delivery carries besides what is pending, read just before
	 * it goes: the invariant's `needs_action` lines (`InvariantWatch.due`).
	 * While there are any, a delivery is made every `delivery_interval`.
	 */
	readonly standing?: () => readonly OrchestratorEvent[];
	/** These events have just gone out (queued for the orchestrator). */
	readonly delivered?: (events: readonly OrchestratorEvent[]) => void;
	/** The pause, or what is pending, changed. */
	readonly changed?: () => void;
	readonly log?: (line: string) => void;
	readonly now?: () => number;
	/** Absent: batches go out at once (tests). */
	readonly setTimer?: (ms: number, run: () => void) => { cancel(): void };
}

interface PendingLine {
	readonly subject: string;
	entry: EventLogEntry;
}

/** How often a batch saving holds for the work in progress looks again. */
const SAVING_RECHECK_MS = 30_000;

export class EventDispatcher {
	#mode: OrchestratorMode;
	/** Pending, one line per subject, in the order the subjects came up. */
	readonly #lines: PendingLine[] = [];
	/** The person's words, held by a pause. */
	readonly #human: EventLogEntry[] = [];
	readonly #log: EventLogEntry[] = [];
	#seq = 0;
	#timer: { cancel(): void } | undefined;
	/** The last delivery, until the orchestrator is seen to have taken it. */
	#awaiting: { readonly at: number; sawBusy: boolean } | undefined;
	/** When the last batch went: the next waits `delivery_interval`. */
	#lastBatchAt: number | undefined;

	constructor(private readonly delivery: EventDelivery) {
		this.#mode = delivery.mode ?? "full";
	}

	#now(): number {
		return (this.delivery.now ?? Date.now)();
	}

	/** Off: everything is held. */
	get paused(): boolean {
		return this.#mode === "off";
	}

	get mode(): OrchestratorMode {
		return this.#mode;
	}

	/** What is pending: the person's held words, then one event per subject. */
	held(): readonly OrchestratorEvent[] {
		return [
			...this.#human.map((entry) => entry.event),
			...this.#lines.map((line) => line.entry.event),
		];
	}

	/** The last `last` events, oldest first, whatever came of them. */
	recent(last: number): readonly EventLogEntry[] {
		return this.#log.slice(Math.max(0, this.#log.length - last));
	}

	/** What `{EVENT}` would hold for `event` now. */
	line(event: OrchestratorEvent): string {
		return eventLine(event, this.#now());
	}

	dispatch(event: OrchestratorEvent): EventLogEntry {
		const entry: EventLogEntry = {
			seq: ++this.#seq,
			at: this.#now(),
			event,
			fate: "pending",
		};
		this.#log.push(entry);
		if (this.#log.length > EVENT_LOG_SIZE)
			this.#log.splice(0, this.#log.length - EVENT_LOG_SIZE);
		const orchestrator = this.delivery.orchestrator();
		if (orchestrator === undefined) {
			entry.fate = "dropped";
			this.delivery.log?.(
				`[devhub] orchestrator event ${event.type} dropped: no orchestrator is assigned`,
			);
			return entry;
		}
		if (!eventAllowed(event.type, this.delivery.settings().events)) {
			entry.fate = "filtered";
			return entry;
		}
		if (isHumanInput(event)) {
			if (this.paused) this.#human.push(entry);
			else this.#sendHuman(orchestrator, entry);
			this.delivery.changed?.();
			return entry;
		}
		const subject = subjectOf(event);
		const line = this.#lines.find((one) => one.subject === subject);
		if (line === undefined) this.#lines.push({ subject, entry });
		else {
			const earlier = line.entry;
			earlier.fate = "coalesced";
			earlier.into = entry.seq;
			earlier.settledAt = entry.at;
			(entry as { event: OrchestratorEvent }).event = merge(
				earlier.event,
				event,
			);
			line.entry = entry;
		}
		this.delivery.changed?.();
		this.#schedule(BATCH_WINDOW_MS);
		return entry;
	}

	/** The person's words, now, as messages of their own. */
	#sendHuman(agentId: string, entry: EventLogEntry): void {
		const event = entry.event;
		if (!isHumanInput(event)) return;
		for (const text of humanMessages(event))
			this.delivery.deliver(agentId, text);
		entry.fate = "delivered";
		entry.settledAt = this.#now();
		this.delivery.delivered?.([event]);
	}

	/** Off: hold everything. */
	pause(): void {
		this.setMode("off");
	}

	/** On, as full: see `setMode`. How many lines went out. */
	resume(): number {
		return this.setMode("full");
	}

	/**
	 * Go to `mode`. Into off: hold everything. Out of off: stop holding, and
	 * deliver at once — the person's held words, then what is pending and
	 * what needs action now as one message, with no batch window, interval,
	 * pickup wait or turn to wait for: the person asked for them (in saving,
	 * the batch still waits while two or more tasks are in progress). The
	 * interval counts from this delivery. Between full and saving: the
	 * interval and the gate change, and what waits is looked at again now.
	 * How many lines went out.
	 */
	setMode(mode: OrchestratorMode): number {
		const from = this.#mode;
		if (from === mode) return 0;
		this.#mode = mode;
		if (mode === "off") {
			this.#timer?.cancel();
			this.#timer = undefined;
			this.delivery.paused?.(true);
			this.delivery.changed?.();
			return 0;
		}
		if (from !== "off") {
			this.#flush(false);
			this.delivery.changed?.();
			return 0;
		}
		this.delivery.paused?.(false);
		const count = this.#lines.length + this.#human.length;
		this.#releaseHuman();
		this.#awaiting = undefined;
		this.#lastBatchAt = undefined;
		const standing = this.#flush(true);
		this.delivery.changed?.();
		return count - this.#lines.length - this.#human.length + standing;
	}

	#releaseHuman(): void {
		const agentId = this.delivery.orchestrator();
		for (const entry of this.#human.splice(0)) {
			if (agentId === undefined) entry.fate = "dropped";
			else this.#sendHuman(agentId, entry);
		}
	}

	/** The pending lines that no longer need attention: nothing is changed. */
	#stale(): readonly PendingLine[] {
		const relevant = this.delivery.relevant;
		if (relevant === undefined) return [];
		return this.#lines.filter((line) => !relevant(line.entry.event));
	}

	/** Drop what no longer needs attention. */
	#dropStale(now: number): void {
		for (const line of this.#stale()) {
			line.entry.fate = "dropped-stale";
			line.entry.reason = "no longer needs attention";
			line.entry.settledAt = now;
			this.#lines.splice(this.#lines.indexOf(line), 1);
		}
	}

	/** `delivery_interval`, made longer in saving. */
	#intervalMs(): number {
		const base = parseInterval(this.delivery.settings().delivery_interval) ?? 0;
		return this.#mode === "saving" ? base * SAVING_INTERVAL_FACTOR : base;
	}

	/**
	 * Saving's priority gate: which lines go now, by their subject — none of
	 * it outside saving, or in a batch carrying `init` or `triage` (which
	 * takes everything with it).
	 */
	#priorityGate():
		| ((subject: string, event: OrchestratorEvent) => boolean)
		| undefined {
		const high = this.delivery.high;
		if (this.#mode !== "saving" || high === undefined) return undefined;
		if (
			this.#lines.some(
				(line) =>
					line.entry.event.type === "init" ||
					line.entry.event.type === "triage",
			)
		)
			return undefined;
		return high;
	}

	/**
	 * Saving's gate: how many tasks are in progress, when that holds the
	 * batch now — never for one carrying `init` (a start is not a nudge).
	 */
	#savingHold(): number | undefined {
		if (this.#mode !== "saving") return undefined;
		if (this.#lines.some((line) => line.entry.event.type === "init"))
			return undefined;
		const tasks = this.delivery.inProgress?.() ?? 0;
		return tasks >= SAVING_BUSY_TASKS ? tasks : undefined;
	}

	/** The `needs_action` lines a delivery now would carry. */
	#standing(): readonly OrchestratorEvent[] {
		const events = this.delivery.settings().events;
		return (this.delivery.standing?.() ?? []).filter((event) =>
			eventAllowed(event.type, events),
		);
	}

	/** Each standing line as a log entry: it went out with this delivery. */
	#logged(event: OrchestratorEvent, now: number): PendingLine {
		const entry: EventLogEntry = {
			seq: ++this.#seq,
			at: now,
			event,
			fate: "pending",
		};
		this.#log.push(entry);
		if (this.#log.length > EVENT_LOG_SIZE)
			this.#log.splice(0, this.#log.length - EVENT_LOG_SIZE);
		return { subject: subjectOf(event), entry };
	}

	/**
	 * Deliver what is pending, and the invariant's standing lines, if the
	 * orchestrator can take them now. Called on every projection (its
	 * status moved) and by the batch timer. How many standing lines went.
	 */
	flush(): number {
		return this.#flush(false);
	}

	/** `force`: a resume — the interval, the turn and the pickup do not hold it. */
	#flush(force: boolean): number {
		this.#timer?.cancel();
		this.#timer = undefined;
		if (this.paused) return 0;
		if (this.#human.length > 0) this.#releaseHuman();
		const agentId = this.delivery.orchestrator();
		if (agentId === undefined) {
			if (this.#lines.length === 0) return 0;
			for (const line of this.#lines.splice(0)) line.entry.fate = "dropped";
			this.delivery.changed?.();
			return 0;
		}
		if (this.#lines.length === 0 && this.#standing().length === 0) return 0;
		const now = this.#now();
		// Saving, with two or more tasks in progress: no nudge at all, a
		// resume's included. Looked at again on every projection, and now and
		// then besides (an escalation moving is not one).
		if (this.#savingHold() !== undefined) {
			this.#retry(SAVING_RECHECK_MS);
			return 0;
		}
		const hold = force ? undefined : this.#hold(agentId, now);
		if (hold !== undefined) {
			if (hold.kind === "busy") {
				if (this.#awaiting !== undefined) this.#awaiting.sawBusy = true;
			} else this.#retry(hold.ms);
			return 0;
		}
		this.#dropStale(now);
		// Saving: only what is about a subject ranked high goes; the rest
		// waits for the next triage (or full), one line per subject.
		const goes = this.#priorityGate();
		const standing = this.#standing().filter(
			(event) => goes === undefined || goes(subjectOf(event), event),
		);
		const going = this.#lines.filter(
			(line) => goes === undefined || goes(line.subject, line.entry.event),
		);
		if (going.length === 0 && standing.length === 0) {
			this.delivery.changed?.();
			return 0;
		}
		for (const line of going) this.#lines.splice(this.#lines.indexOf(line), 1);
		const lines = [
			...going,
			...standing.map((event) => this.#logged(event, now)),
		];
		const plan = composeDelivery(
			[],
			lines.map((line) => line.entry.event),
			this.delivery.settings(),
			now,
		);
		const sent = lines.slice(0, plan.events.length);
		const over = lines.slice(plan.events.length);
		if (plan.batch !== undefined) this.delivery.deliver(agentId, plan.batch);
		for (const line of sent) {
			line.entry.fate = "delivered";
			line.entry.settledAt = now;
		}
		for (const line of over) {
			line.entry.fate = "overflow";
			line.entry.settledAt = now;
		}
		this.#lastBatchAt = now;
		this.#awaiting =
			this.delivery.busy === undefined
				? undefined
				: { at: now, sawBusy: false };
		this.delivery.delivered?.(sent.map((line) => line.entry.event));
		this.delivery.changed?.();
		// Still needing action at the next delivery: it is said again then.
		if (standing.length > 0) this.#retry(Math.max(1_000, this.#intervalMs()));
		return standing.length;
	}

	/**
	 * What holds a batch now, if anything: the interval (`wait` until `at`),
	 * the orchestrator's turn (`busy`), or the last message not yet seen
	 * taken (`pickup`, looked at again in `ms`). Reads, changes nothing.
	 */
	#hold(
		agentId: string,
		now: number,
	):
		| { readonly kind: "wait" | "pickup"; readonly ms: number }
		| { readonly kind: "busy" }
		| undefined {
		// At most one batch per `delivery_interval`.
		if (this.#lastBatchAt !== undefined) {
			const wait = this.#lastBatchAt + this.#intervalMs() - now;
			if (wait > 0) return { kind: "wait", ms: wait };
		}
		if (this.delivery.busy?.(agentId) === true) return { kind: "busy" };
		// The last message may still be on its way into the queue the
		// projection reads: wait to see it taken, for a while.
		if (
			this.#awaiting !== undefined &&
			!this.#awaiting.sawBusy &&
			now - this.#awaiting.at < PICKUP_TIMEOUT_MS
		)
			return { kind: "pickup", ms: PICKUP_RETRY_MS };
		return undefined;
	}

	/**
	 * What the next delivery would send if it went now, and when it will go:
	 * the person's held words, each its own message, then the batch — what is
	 * pending (the stale left out) and the standing lines — composed as a
	 * delivery composes it (`composeDelivery`). Nothing is marked, logged,
	 * scheduled or changed.
	 */
	preview(): DeliveryPreview {
		const now = this.#now();
		const stale = new Set(this.#stale());
		const goes = this.#priorityGate();
		const plan = composeDelivery(
			this.#human.flatMap((entry) =>
				isHumanInput(entry.event) ? [entry.event] : [],
			),
			[
				...this.#lines
					.filter((line) => !stale.has(line))
					.filter(
						(line) =>
							goes === undefined || goes(line.subject, line.entry.event),
					)
					.map((line) => line.entry.event),
				...this.#standing().filter(
					(event) => goes === undefined || goes(subjectOf(event), event),
				),
			],
			this.delivery.settings(),
			now,
		);
		const agentId = this.delivery.orchestrator();
		if (agentId === undefined) return { ...plan, when: { kind: "nobody" } };
		if (this.paused) return { ...plan, when: { kind: "paused" } };
		if (plan.batch === undefined) return plan;
		const tasks = this.#savingHold();
		if (tasks !== undefined)
			return { ...plan, when: { kind: "saving_busy", tasks } };
		const hold = this.#hold(agentId, now);
		return {
			...plan,
			when:
				hold === undefined
					? { kind: "now" }
					: hold.kind === "wait"
						? { kind: "at", at: now + hold.ms }
						: { kind: "after_turn" },
		};
	}

	#schedule(ms: number): void {
		const setTimer = this.delivery.setTimer;
		if (setTimer === undefined) {
			this.flush();
			return;
		}
		if (this.#timer !== undefined) return;
		this.#timer = setTimer(ms, () => {
			this.#timer = undefined;
			this.flush();
		});
	}

	/** Look again in `ms`; without a clock (tests) the next `flush` does. */
	#retry(ms: number): void {
		if (this.delivery.setTimer === undefined) return;
		this.#schedule(ms);
	}

	dispose(): void {
		this.#timer?.cancel();
		this.#timer = undefined;
	}
}

/** An event as `{EVENT_JSON}` and `orchestrator events --json` carry it. */
export function eventJson(event: OrchestratorEvent): Record<string, unknown> {
	return { ...event };
}

/** The last line of a delivery that was cut at `MAX_DELIVERY_LINES`. */
export function overflowLine(more: number): string {
	return `…ほか ${String(more)} 件 (devhub --tell orchestrator events で確認)`;
}

/** What a delivery sends: see `composeDelivery`. */
export interface DeliveryPlan {
	/** The person's words, each a message of its own, sent first. */
	readonly human: readonly string[];
	/** The batch's events that go, in order: at most `MAX_DELIVERY_LINES`. */
	readonly events: readonly OrchestratorEvent[];
	/** How many more there were: counted on the batch's last line. */
	readonly more: number;
	/** The batch, as one message (`eventsMessage`); absent with no lines. */
	readonly batch?: string;
}

/**
 * When the next delivery goes: now (or within the batch window), at the
 * interval's end, when the orchestrator has taken the last message or ended
 * its turn, not while paused, not while saving holds it for the work in
 * progress, never with no orchestrator.
 */
export type DeliveryWhen =
	| { readonly kind: "now" }
	| { readonly kind: "at"; readonly at: number }
	| { readonly kind: "after_turn" }
	| { readonly kind: "paused" }
	/** Saving, while `tasks` (two or more) are in progress. */
	| { readonly kind: "saving_busy"; readonly tasks: number }
	| { readonly kind: "nobody" };

/** `preview()`: the plan, and when it goes (absent: nothing to send). */
export interface DeliveryPreview extends DeliveryPlan {
	readonly when?: DeliveryWhen;
}

/**
 * What one delivery sends, composed: `human` (the person's words) as their
 * messages, then `lines` — pending and standing, in that order — as one
 * message, cut at `MAX_DELIVERY_LINES`. Pure: a delivery and the preview
 * both compose with it.
 */
export function composeDelivery(
	human: readonly HumanInputEvent[],
	lines: readonly OrchestratorEvent[],
	prompts: {
		readonly event_prompt: string;
		readonly init_prompt: string | undefined;
	},
	now: number,
): DeliveryPlan {
	const events = lines.slice(0, MAX_DELIVERY_LINES);
	const more = lines.length - events.length;
	return {
		human: human.flatMap((event) => humanMessages(event)),
		events,
		more,
		...(events.length === 0
			? {}
			: { batch: eventsMessage(events, prompts, now, { more }) }),
	};
}

/**
 * The message a batch is sent as: `init_prompt` when it carries `init` (and
 * one is set), else `event_prompt`; `{EVENT}` the lines, one per subject,
 * `{EVENT_JSON}` — only when the template names it — the array.
 */
export function eventsMessage(
	events: readonly OrchestratorEvent[],
	prompts: {
		readonly event_prompt: string;
		readonly init_prompt: string | undefined;
	},
	now: number,
	options: { readonly more?: number } = {},
): string {
	const template =
		prompts.init_prompt !== undefined &&
		events.some((event) => event.type === "init")
			? prompts.init_prompt
			: prompts.event_prompt;
	const more = options.more ?? 0;
	const text = [
		...events.map((event) => eventLine(event, now)),
		...(more > 0 ? [overflowLine(more)] : []),
	].join("\n");
	const json = template.includes(EVENT_JSON_PLACEHOLDER)
		? JSON.stringify(events.map(eventJson))
		: undefined;
	return renderEventPrompt(template, text, json);
}

export { EVENT_JSON_PLACEHOLDER, EVENT_PLACEHOLDER };

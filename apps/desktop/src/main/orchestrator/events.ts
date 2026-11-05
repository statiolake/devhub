/**
 * Events for the orchestrator: the seam everything that wants the
 * orchestrator to act goes through.
 *
 * A source — the board, the invariant (`invariant.ts`), GitHub
 * (`githubEvents.ts`), the timers (`timers.ts`), the usage readout,
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
 *    per subject** (`subjectOf`: an Issue, an agent, an escalation, a pull
 *    request, a timer, a usage window, a custom type and text). A newer
 *    statement about a pending subject replaces the older one (`merge`):
 *    a line says how the subject stands now, not what happened to it;
 * 4. just before delivery, drops what no longer needs attention (`relevant`:
 *    a subject settled since, a wait no longer waiting) as `dropped-stale`;
 * 5. delivers everything pending as **one** message — one line per subject
 *    (`eventLine`) as `{EVENT}`, at most `MAX_DELIVERY_LINES` and a last
 *    line counting the rest, and as JSON for `{EVENT_JSON}` only when the
 *    template has it — at most once per `[orchestrator] delivery_interval`,
 *    once the orchestrator can take it: not paused, not in a foreground
 *    turn, nothing of ours still queued for it (`busy`). Background work of
 *    its own (shells, tasks, subagents) does not hold it.
 *
 * **Paused** holds everything, the person's words too, and the sources that
 * cost something (GitHub) are suspended (`paused`); `resume` lets them catch
 * up first, then sends the person's words, then everything else as one
 * message. With no orchestrator assigned there is nobody to tell, and an
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

/** Where a GitHub event's work is, when DevHub has it open. */
interface Where {
	/** The Workspace, as `--tell` takes it (its name, or its id). */
	readonly ws?: string;
	/** Its agent (not the orchestrator). */
	readonly agent?: EventAgent;
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
	 * A 待機中 escalation's time (`escalation wait --at`) has come: once per
	 * wait. Dropped before it goes if it has left 待機中 (or waits anew).
	 */
	| {
			readonly type: "escalation.wait_due";
			readonly escalationId: number;
			readonly title: string;
			readonly trigger: string;
			readonly dueAt: number;
			/** The wait it is about: its entry's time. */
			readonly waitSince: number;
	  }
	/**
	 * A subject that breaks the invariant (`invariant.ts`): an Issue of the
	 * population or a managed agent, with its facts as they are. No reason.
	 */
	| {
			readonly type: "unsettled";
			readonly subject:
				| { readonly kind: "issue"; readonly item: EventItem }
				| { readonly kind: "agent"; readonly agent: EventAgent };
			readonly ws?: string;
			/** `key=value` facts. */
			readonly facts: readonly string[];
	  }
	/**
	 * What a 待機中 escalation is about moved (its Issue, its pull request,
	 * its agents): the facts as they are now, with the trigger it waits on.
	 */
	| {
			readonly type: "waiting.changed";
			readonly escalationId: number;
			readonly title: string;
			readonly trigger: string;
			readonly facts: readonly string[];
	  }
	/** Someone asked the viewer to review a pull request on a watched board. */
	| ({
			readonly type: "github.review_requested";
			readonly pr: EventItem;
			readonly author?: string;
	  } & Where)
	/** New activity by its author on a pull request the viewer reviewed. */
	| ({
			readonly type: "github.reply";
			readonly pr: EventItem;
			readonly author: string;
			readonly comments: number;
			readonly commits: boolean;
	  } & Where)
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
	| { readonly type: `custom.${string}`; readonly text: string };

export type OrchestratorEventType = OrchestratorEvent["type"];

/** Every type DevHub itself emits (`custom.*` is the open family). */
export const EVENT_TYPES = [
	"init",
	"escalation_answered",
	"escalation.human_direct",
	"escalation.wait_due",
	"unsettled",
	"waiting.changed",
	"github.review_requested",
	"github.reply",
	"timer.elapsed",
	"usage.threshold",
	"custom.*",
] as const;

/** `custom.NAME`: what `orchestrator emit --type` takes. */
export function customTypeProblem(type: string): boolean {
	return !/^custom\.[a-z0-9][a-z0-9_-]{0,39}$/u.test(type);
}

/** The person's own words: sent at once, as they typed them. */
export function isHumanInput(
	event: OrchestratorEvent,
): event is Extract<
	OrchestratorEvent,
	{ type: "escalation_answered" | "escalation.human_direct" }
> {
	return (
		event.type === "escalation_answered" ||
		event.type === "escalation.human_direct"
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

function prItem(one: EventItem): string {
	return `PR #${String(one.number)}${title(one.title)}`;
}

function where(event: Where): string[] {
	return [
		...(event.ws === undefined ? [] : [`ws=${event.ws}`]),
		...(event.agent === undefined ? [] : [agentToken(event.agent)]),
	];
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
		case "escalation.wait_due":
			return {
				head: [
					`esc=${String(event.escalationId)}${title(event.title)}`,
					`due=${clockAt(event.dueAt, now, "T")}`,
				],
				summary: `待機条件: ${excerpt(event.trigger, 150)}`,
			};
		case "unsettled": {
			const subject = event.subject;
			return {
				head: [
					subject.kind === "issue"
						? `issue=${issueRef(subject.item)}${title(subject.item.title)}`
						: agentToken(subject.agent),
					...(event.ws === undefined ? [] : [`ws=${event.ws}`]),
					...event.facts,
				],
				...(subject.kind === "issue" && subject.item.url !== undefined
					? { url: subject.item.url }
					: {}),
			};
		}
		case "waiting.changed":
			return {
				head: [
					`esc=${String(event.escalationId)}${title(event.title)}`,
					...event.facts,
				],
				summary: `待機条件: ${excerpt(event.trigger, 150)}`,
			};
		case "github.review_requested":
			return {
				head: [prItem(event.pr), ...where(event)],
				summary: `${event.author === undefined ? "" : `${event.author} から`}レビュー依頼`,
				...(event.pr.url === undefined ? {} : { url: event.pr.url }),
			};
		case "github.reply":
			return {
				head: [
					prItem(event.pr),
					...where(event),
					`author=${event.author}`,
					`replies=${String(event.comments)}`,
					`new_commits=${event.commits ? "yes" : "no"}`,
				],
				...(event.pr.url === undefined ? {} : { url: event.pr.url }),
			};
		case "timer.elapsed":
			return { head: [event.name] };
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
export function humanMessages(
	event: Extract<
		OrchestratorEvent,
		{ type: "escalation_answered" | "escalation.human_direct" }
	>,
): string[] {
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
		case "escalation.wait_due":
		case "waiting.changed":
			return `esc ${String(event.escalationId)}`;
		case "unsettled":
			return event.subject.kind === "issue"
				? `issue ${prKey(event.subject.item)}`
				: `agent ${event.subject.agent.id}`;
		case "github.review_requested":
		case "github.reply":
			return `gh ${prKey(event.pr)}`;
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
 * reply's counts add up; a timer pending once stands; anything else says how
 * the subject stands now, and the latest does.
 */
export function merge(
	older: OrchestratorEvent,
	newer: OrchestratorEvent,
): OrchestratorEvent {
	if (older.type === "github.reply" && newer.type === "github.reply")
		return {
			...newer,
			comments: older.comments + newer.comments,
			commits: older.commits || newer.commits,
		};
	if (older.type === "timer.elapsed" && newer.type === "timer.elapsed")
		return older;
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
/** How long a resume waits for the sources to catch up before it delivers. */
export const CATCH_UP_TIMEOUT_MS = 20_000;

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
	 * The pause moved. On a resume, what it returns is awaited (at most
	 * `CATCH_UP_TIMEOUT_MS`) before the held events go.
	 */
	readonly paused?: (paused: boolean) => Promise<void> | void;
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

export class EventDispatcher {
	#paused = false;
	/** Catching up after a resume: delivery waits for it. */
	#catchingUp = false;
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

	constructor(private readonly delivery: EventDelivery) {}

	#now(): number {
		return (this.delivery.now ?? Date.now)();
	}

	get paused(): boolean {
		return this.#paused;
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
			if (this.#paused || this.#catchingUp) this.#human.push(entry);
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

	pause(): void {
		if (this.#paused) return;
		this.#paused = true;
		void this.delivery.paused?.(true);
		this.delivery.changed?.();
	}

	/**
	 * Stop holding: let the suspended sources catch up, then send the
	 * person's held words, then what is pending as one message. How many
	 * lines went out.
	 */
	async resume(): Promise<number> {
		if (!this.#paused) return 0;
		this.#paused = false;
		this.delivery.changed?.();
		const catchUp = this.delivery.paused?.(false);
		if (catchUp !== undefined) {
			this.#catchingUp = true;
			let timer: { cancel(): void } | undefined;
			await Promise.race([
				catchUp.catch(() => undefined),
				new Promise<void>((done) => {
					timer = this.delivery.setTimer?.(CATCH_UP_TIMEOUT_MS, done);
				}),
			]);
			timer?.cancel();
			this.#catchingUp = false;
		}
		if (this.#paused) return 0;
		const count = this.#lines.length + this.#human.length;
		this.#releaseHuman();
		// The person asked for them: no batch window, interval or pickup wait.
		this.#awaiting = undefined;
		this.#lastBatchAt = undefined;
		this.flush();
		this.delivery.changed?.();
		return count - this.#lines.length - this.#human.length;
	}

	#releaseHuman(): void {
		const agentId = this.delivery.orchestrator();
		for (const entry of this.#human.splice(0)) {
			if (agentId === undefined) entry.fate = "dropped";
			else this.#sendHuman(agentId, entry);
		}
	}

	/** Drop what no longer needs attention. */
	#dropStale(): void {
		const relevant = this.delivery.relevant;
		if (relevant === undefined) return;
		const now = this.#now();
		for (const line of [...this.#lines])
			if (!relevant(line.entry.event)) {
				line.entry.fate = "dropped-stale";
				line.entry.reason = "no longer needs attention";
				line.entry.settledAt = now;
				this.#lines.splice(this.#lines.indexOf(line), 1);
			}
	}

	#intervalMs(): number {
		return parseInterval(this.delivery.settings().delivery_interval) ?? 0;
	}

	/**
	 * Deliver what is pending if the orchestrator can take it now. Called on
	 * every projection (its status moved) and by the batch timer.
	 */
	flush(): void {
		this.#timer?.cancel();
		this.#timer = undefined;
		if (this.#paused || this.#catchingUp) return;
		if (this.#human.length > 0) this.#releaseHuman();
		if (this.#lines.length === 0) return;
		const agentId = this.delivery.orchestrator();
		if (agentId === undefined) {
			for (const line of this.#lines.splice(0)) line.entry.fate = "dropped";
			this.delivery.changed?.();
			return;
		}
		const now = this.#now();
		// At most one batch per `delivery_interval`.
		if (this.#lastBatchAt !== undefined) {
			const wait = this.#lastBatchAt + this.#intervalMs() - now;
			if (wait > 0) {
				this.#retry(wait);
				return;
			}
		}
		if (this.delivery.busy?.(agentId) === true) {
			if (this.#awaiting !== undefined) this.#awaiting.sawBusy = true;
			return;
		}
		// The last message may still be on its way into the queue the
		// projection reads: wait to see it taken, for a while.
		if (
			this.#awaiting !== undefined &&
			!this.#awaiting.sawBusy &&
			now - this.#awaiting.at < PICKUP_TIMEOUT_MS
		) {
			this.#retry(PICKUP_RETRY_MS);
			return;
		}
		this.#dropStale();
		if (this.#lines.length === 0) {
			this.delivery.changed?.();
			return;
		}
		const lines = this.#lines.splice(0);
		const sent = lines.slice(0, MAX_DELIVERY_LINES);
		const over = lines.slice(MAX_DELIVERY_LINES);
		this.delivery.deliver(
			agentId,
			eventsMessage(
				sent.map((line) => line.entry.event),
				this.delivery.settings(),
				now,
				{ more: over.length },
			),
		);
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

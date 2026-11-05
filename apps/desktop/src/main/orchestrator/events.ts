/**
 * Events for the orchestrator: the seam everything that wants the
 * orchestrator to act goes through.
 *
 * A source — the board, GitHub (`githubEvents.ts`), the Workspaces and the
 * Agents (`liveEvents.ts`), the timers (`timers.ts`), `orchestrator emit` —
 * calls `dispatch` with an `OrchestratorEvent`. The dispatcher
 *
 * 1. drops what is about the orchestrator itself, and what the
 *    `[orchestrator] events` patterns filter out;
 * 2. keeps the rest **pending**, coalesced (`coalesceKey`/`merge`): several
 *    review comments on one pull request are one line with a count, an
 *    agent's turns are its latest, a timer is pending once;
 * 3. delivers everything pending as **one** message — one line per event
 *    (`eventLine`) as `{EVENT}`, and as JSON for `{EVENT_JSON}` only when the
 *    template has it — once the orchestrator can take it: not paused, not
 *    mid-turn, nothing of ours still queued for it. The message is queued for
 *    it as the person's (`deliver`), the same queue `agent send` uses.
 *
 * **Paused** holds everything; `resume` delivers it, as one message. With no
 * orchestrator assigned there is nobody to tell, and an event is dropped
 * (and kept in the log as dropped): the next start's `init` sends it to the
 * board anyway.
 *
 * Every event, whatever came of it, is kept in a short log (`log`) for
 * `devhub --tell orchestrator events`.
 *
 * Adding an event is a variant here, its line in `eventLine`, and a
 * `dispatch` where it happens. See `docs/orchestrator.md`, "Events".
 */

import {
	EVENT_JSON_PLACEHOLDER,
	EVENT_PLACEHOLDER,
	eventAllowed,
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

export type OrchestratorEvent =
	/** The orchestrator has just been started (or restarted). */
	| { readonly type: "init" }
	/** The person answered an escalation: it is `in_progress` now. */
	| {
			readonly type: "escalation_answered";
			readonly escalationId: number;
			readonly title: string;
			readonly agents: readonly EventAgent[];
	  }
	/** An agent appeared in 不明: idle, with no open escalation naming it. */
	| {
			readonly type: "unaccounted";
			readonly agent: EventAgent;
			readonly ws?: string;
			readonly idleSince: number;
	  }
	| ({
			readonly type: "github.assigned" | "github.unassigned";
			readonly item: EventItem;
			readonly kind: "issue" | "pr";
			readonly login: string;
	  } & Where)
	| ({
			readonly type: "github.lane_changed";
			readonly item: EventItem;
			readonly kind: "issue" | "pr";
			readonly project: string;
			readonly from: string | null;
			readonly to: string | null;
	  } & Where)
	| ({
			readonly type: "github.pr_opened";
			readonly pr: EventItem;
			readonly author?: string;
			readonly draft: boolean;
			/** The Issue of mine it is linked to. */
			readonly issue?: number;
	  } & Where)
	| ({
			readonly type:
				| "github.pr_ready"
				| "github.pr_merged"
				| "github.pr_closed"
				| "github.review_requested";
			readonly pr: EventItem;
			readonly author?: string;
	  } & Where)
	| ({
			readonly type: "github.pr_approved" | "github.changes_requested";
			readonly pr: EventItem;
			readonly by: readonly string[];
	  } & Where)
	| ({
			readonly type: "github.review_comment";
			readonly pr: EventItem;
			readonly count: number;
			readonly authors: readonly string[];
			/** Review conversations nobody has resolved, as of this look. */
			readonly unresolved?: number;
	  } & Where)
	| ({
			/** New activity by its author on a pull request I reviewed. */
			readonly type: "github.reply";
			readonly pr: EventItem;
			readonly author: string;
			readonly comments: number;
			readonly commits: boolean;
	  } & Where)
	| ({
			readonly type: "github.checks";
			readonly pr: EventItem;
			readonly result: "passed" | "failed";
			readonly failing?: number;
			readonly total?: number;
	  } & Where)
	| {
			readonly type: "workspace.opened" | "workspace.closed";
			readonly ws: string;
			readonly path: string;
	  }
	| {
			readonly type: "workspace.issue_assigned";
			readonly ws: string;
			readonly issue: EventItem;
			readonly agent?: EventAgent;
	  }
	| {
			readonly type: "workspace.branch_changed";
			readonly ws: string;
			readonly from: string | null;
			readonly to: string | null;
	  }
	| {
			readonly type: "workspace.pr_linked";
			readonly ws: string;
			readonly pr: EventItem;
			readonly agent?: EventAgent;
	  }
	| {
			readonly type: "agent.turn_ended";
			readonly agent: EventAgent;
			readonly ws?: string;
			/** What `agent read --since` takes to read this turn (and later ones). */
			readonly since?: string;
			/** The start of its last message. */
			readonly excerpt?: string;
	  }
	| {
			readonly type: "agent.asked";
			readonly agent: EventAgent;
			readonly ws?: string;
			readonly request: string;
			readonly headers: readonly string[];
	  }
	| {
			readonly type: "agent.permission_requested";
			readonly agent: EventAgent;
			readonly ws?: string;
			readonly request?: string;
			readonly what?: string;
	  }
	| {
			readonly type: "agent.started" | "agent.exited";
			readonly agent: EventAgent;
			readonly ws?: string;
			readonly profile?: string;
	  }
	| {
			readonly type: "agent.failed";
			readonly agent: EventAgent;
			readonly ws?: string;
			readonly reason: string;
	  }
	| {
			readonly type: "timer.elapsed";
			readonly name: string;
			readonly interval: string;
	  }
	| { readonly type: `custom.${string}`; readonly text: string };

export type OrchestratorEventType = OrchestratorEvent["type"];

/** Every type DevHub itself emits (`custom.*` is the open family). */
export const EVENT_TYPES = [
	"init",
	"escalation_answered",
	"unaccounted",
	"github.assigned",
	"github.unassigned",
	"github.lane_changed",
	"github.pr_opened",
	"github.pr_ready",
	"github.pr_approved",
	"github.changes_requested",
	"github.review_comment",
	"github.review_requested",
	"github.reply",
	"github.checks",
	"github.pr_merged",
	"github.pr_closed",
	"workspace.opened",
	"workspace.closed",
	"workspace.issue_assigned",
	"workspace.branch_changed",
	"workspace.pr_linked",
	"agent.turn_ended",
	"agent.asked",
	"agent.permission_requested",
	"agent.started",
	"agent.exited",
	"agent.failed",
	"timer.elapsed",
	"custom.*",
] as const;

/** `custom.NAME`: what `orchestrator emit --type` takes. */
export function customTypeProblem(type: string): boolean {
	return !/^custom\.[a-z0-9][a-z0-9_-]{0,39}$/u.test(type);
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

function item(kind: "issue" | "pr", one: EventItem): string {
	return `${kind === "pr" ? "PR " : ""}#${String(one.number)}${title(one.title)}`;
}

function where(event: Where): string[] {
	return [
		...(event.ws === undefined ? [] : [`ws=${event.ws}`]),
		...(event.agent === undefined ? [] : [agentToken(event.agent)]),
	];
}

function ws(name: string | undefined): string[] {
	return name === undefined ? [] : [`ws=${name}`];
}

function span(ms: number): string {
	const minutes = Math.max(0, Math.round(ms / 60_000));
	if (minutes < 60) return `${String(minutes)}m`;
	const hours = Math.floor(minutes / 60);
	return `${String(hours)}h${minutes % 60 === 0 ? "" : `${String(minutes % 60)}m`}`;
}

function people(logins: readonly string[]): string {
	if (logins.length === 0) return "";
	if (logins.length <= 2) return logins.join("・");
	return `${logins.slice(0, 2).join("・")} ほか${String(logins.length - 2)}人`;
}

/**
 * What `{EVENT}` holds for one event: one line — `[type]`, the ids the next
 * command takes as `key=value`, then `—` and a short summary.
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
				summary: "人が回答しました (escalation show で読む)",
			};
		case "unaccounted":
			return {
				head: [
					agentToken(event.agent),
					...ws(event.ws),
					`idle ${span(now - event.idleSince)}`,
				],
			};
		case "github.assigned":
		case "github.unassigned":
			return {
				head: [item(event.kind, event.item), ...where(event)],
				summary:
					event.type === "github.assigned"
						? `${event.login} にアサイン`
						: `${event.login} のアサインが外れた`,
				...(event.item.url === undefined ? {} : { url: event.item.url }),
			};
		case "github.lane_changed":
			return {
				head: [
					item(event.kind, event.item),
					`${event.from ?? "(なし)"} → ${event.to ?? "(なし)"}`,
					...where(event),
				],
				...(event.item.url === undefined ? {} : { url: event.item.url }),
			};
		case "github.pr_opened":
			return {
				head: [item("pr", event.pr), ...where(event)],
				summary: [
					event.author === undefined ? "" : `${event.author} が`,
					event.draft ? "draft で作成" : "作成",
					event.issue === undefined ? "" : ` (#${String(event.issue)})`,
				].join(""),
				...(event.pr.url === undefined ? {} : { url: event.pr.url }),
			};
		case "github.pr_ready":
		case "github.pr_merged":
		case "github.pr_closed":
		case "github.review_requested":
			return {
				head: [item("pr", event.pr), ...where(event)],
				summary:
					event.type === "github.pr_ready"
						? "ready for review になった"
						: event.type === "github.pr_merged"
							? "マージされた"
							: event.type === "github.pr_closed"
								? "マージされずにクローズ"
								: `${event.author === undefined ? "" : `${event.author} から`}レビュー依頼`,
				...(event.pr.url === undefined ? {} : { url: event.pr.url }),
			};
		case "github.pr_approved":
		case "github.changes_requested":
			return {
				head: [item("pr", event.pr), ...where(event)],
				summary: `${people(event.by)}${event.by.length === 0 ? "" : " が"}${event.type === "github.pr_approved" ? "承認" : "変更を要求"}`,
				...(event.pr.url === undefined ? {} : { url: event.pr.url }),
			};
		case "github.review_comment":
			return {
				head: [item("pr", event.pr), ...where(event)],
				summary: `${people(event.authors)}${event.authors.length === 0 ? "" : " から"}新規${String(event.count)}件${event.unresolved === undefined ? "" : ` (未解決 ${String(event.unresolved)})`}`,
				...(event.pr.url === undefined ? {} : { url: event.pr.url }),
			};
		case "github.reply":
			return {
				head: [item("pr", event.pr), ...where(event)],
				summary: `${event.author} が${[
					...(event.comments > 0 ? [`返信${String(event.comments)}件`] : []),
					...(event.commits ? ["新しいコミット"] : []),
				].join("・")}`,
				...(event.pr.url === undefined ? {} : { url: event.pr.url }),
			};
		case "github.checks":
			return {
				head: [item("pr", event.pr), ...where(event)],
				summary:
					event.result === "passed"
						? "CI 成功"
						: `CI 失敗${event.failing === undefined || event.total === undefined ? "" : ` (${String(event.failing)}/${String(event.total)})`}`,
				...(event.pr.url === undefined ? {} : { url: event.pr.url }),
			};
		case "workspace.opened":
		case "workspace.closed":
			return {
				head: [`ws=${event.ws}`],
				summary: `${event.type === "workspace.opened" ? "開いた" : "閉じた"} ${event.path}`,
			};
		case "workspace.issue_assigned":
			return {
				head: [
					`#${String(event.issue.number)}${title(event.issue.title)}`,
					`ws=${event.ws}`,
					...(event.agent === undefined ? [] : [agentToken(event.agent)]),
				],
				summary: "DevHub で Issue をアサイン",
				...(event.issue.url === undefined ? {} : { url: event.issue.url }),
			};
		case "workspace.branch_changed":
			return {
				head: [
					`ws=${event.ws}`,
					`${event.from ?? "(なし)"} → ${event.to ?? "(なし)"}`,
				],
			};
		case "workspace.pr_linked":
			return {
				head: [
					item("pr", event.pr),
					`ws=${event.ws}`,
					...(event.agent === undefined ? [] : [agentToken(event.agent)]),
				],
				summary: "このブランチの PR",
				...(event.pr.url === undefined ? {} : { url: event.pr.url }),
			};
		case "agent.turn_ended":
			return {
				head: [
					agentToken(event.agent),
					...ws(event.ws),
					...(event.since === undefined ? [] : [`since=${event.since}`]),
				],
				...(event.excerpt === undefined || event.excerpt.length === 0
					? {}
					: { summary: `「${excerpt(event.excerpt, 150)}」` }),
			};
		case "agent.asked": {
			const [first, ...rest] = event.headers;
			return {
				head: [
					agentToken(event.agent),
					...ws(event.ws),
					`req=${event.request}`,
				],
				summary:
					first === undefined
						? "質問"
						: `「${excerpt(first, 60)}」${rest.length === 0 ? "" : `ほか${String(rest.length)}問`}`,
			};
		}
		case "agent.permission_requested":
			return {
				head: [
					agentToken(event.agent),
					...ws(event.ws),
					...(event.request === undefined ? [] : [`req=${event.request}`]),
				],
				summary: `権限確認${event.what === undefined ? "" : `「${excerpt(event.what, 60)}」`} (FYI: 承認できるのは人だけ)`,
			};
		case "agent.started":
			return {
				head: [agentToken(event.agent), ...ws(event.ws)],
				summary: `起動${event.profile === undefined ? "" : ` (${event.profile})`}`,
			};
		case "agent.exited":
			return {
				head: [agentToken(event.agent), ...ws(event.ws)],
				summary: "終了した",
			};
		case "agent.failed":
			return {
				head: [agentToken(event.agent), ...ws(event.ws)],
				summary: `失敗: ${excerpt(event.reason, 150)}`,
			};
		case "timer.elapsed":
			return { head: [event.name] };
		default:
			return { head: [], summary: excerpt(event.text, 200) };
	}
}

/** The agent an event is about, for "never about the orchestrator itself". */
export function eventAgent(event: OrchestratorEvent): string | undefined {
	switch (event.type) {
		case "unaccounted":
		case "agent.turn_ended":
		case "agent.asked":
		case "agent.permission_requested":
		case "agent.started":
		case "agent.exited":
		case "agent.failed":
			return event.agent.id;
		default:
			return undefined;
	}
}

// --- coalescing ----------------------------------------------------------------

function prKey(pr: EventItem): string {
	return `${pr.repo}#${String(pr.number)}`;
}

/**
 * Which pending event a new one folds into; undefined: none, it is its own
 * line. Same key, same line.
 */
export function coalesceKey(event: OrchestratorEvent): string | undefined {
	switch (event.type) {
		case "github.review_comment":
		case "github.reply":
		case "github.checks":
			return `${event.type} ${prKey(event.pr)}`;
		case "github.lane_changed":
			return `${event.type} ${event.project} ${prKey(event.item)}`;
		case "agent.turn_ended":
		case "unaccounted":
			return `${event.type} ${event.agent.id}`;
		case "agent.asked":
			return `${event.type} ${event.agent.id} ${event.request}`;
		case "timer.elapsed":
			return `${event.type} ${event.name}`;
		default:
			return event.type.startsWith("custom.") && "text" in event
				? `${event.type} ${event.text}`
				: undefined;
	}
}

function union(a: readonly string[], b: readonly string[]): string[] {
	return [...new Set([...a, ...b])];
}

/** `older` and `newer` (same `coalesceKey`) as the one line they become. */
export function merge(
	older: OrchestratorEvent,
	newer: OrchestratorEvent,
): OrchestratorEvent {
	if (
		older.type === "github.review_comment" &&
		newer.type === "github.review_comment"
	)
		return {
			...newer,
			count: older.count + newer.count,
			authors: union(older.authors, newer.authors),
		};
	if (older.type === "github.reply" && newer.type === "github.reply")
		return {
			...newer,
			comments: older.comments + newer.comments,
			commits: older.commits || newer.commits,
		};
	if (
		older.type === "github.lane_changed" &&
		newer.type === "github.lane_changed"
	)
		return { ...newer, from: older.from };
	// The latest turn, read from where the first unread one began.
	if (older.type === "agent.turn_ended" && newer.type === "agent.turn_ended")
		return {
			...newer,
			...(older.since === undefined ? {} : { since: older.since }),
		};
	// A timer is pending once: the first stands.
	if (older.type === "timer.elapsed") return older;
	return newer;
}

// --- the dispatcher ------------------------------------------------------------

/** What came of an event, as `orchestrator events` lists it. */
export type EventFate =
	| "pending"
	| "delivered"
	| "filtered"
	| "coalesced"
	| "dropped"
	| "self";

export interface EventLogEntry {
	readonly seq: number;
	readonly at: number;
	readonly event: OrchestratorEvent;
	fate: EventFate;
	/** When it went out (delivered), or was folded into `into` (coalesced). */
	settledAt?: number;
	into?: number;
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

export interface EventDelivery {
	/** The agent to tell, while one is assigned. */
	readonly orchestrator: () => string | undefined;
	/** `[orchestrator]` as DevHub runs on it now. */
	readonly settings: () => {
		readonly event_prompt: string;
		readonly init_prompt: string | undefined;
		readonly events: readonly string[];
	};
	/** Queue `text` for `agentId` as the person's message (held mid-turn). */
	readonly deliver: (agentId: string, text: string) => void;
	/**
	 * Whether `agentId` cannot take a message now: mid-turn, stopped on a
	 * question, or something is still queued for it. Absent: it always can.
	 */
	readonly busy?: (agentId: string) => boolean;
	/** The pause, or what is pending, changed. */
	readonly changed?: () => void;
	readonly log?: (line: string) => void;
	readonly now?: () => number;
	/** Absent: batches go out at once (tests). */
	readonly setTimer?: (ms: number, run: () => void) => { cancel(): void };
}

export class EventDispatcher {
	#paused = false;
	/** Pending, in order: log entries whose fate is `pending`. */
	readonly #pending: EventLogEntry[] = [];
	readonly #log: EventLogEntry[] = [];
	#seq = 0;
	#timer: { cancel(): void } | undefined;
	/** The last delivery, until the orchestrator is seen to have taken it. */
	#awaiting: { readonly at: number; sawBusy: boolean } | undefined;

	constructor(private readonly delivery: EventDelivery) {}

	#now(): number {
		return (this.delivery.now ?? Date.now)();
	}

	get paused(): boolean {
		return this.#paused;
	}

	/** What is pending (paused, or waiting for the orchestrator), oldest first. */
	held(): readonly OrchestratorEvent[] {
		return this.#pending.map((entry) => entry.event);
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
		if (eventAgent(event) === orchestrator) {
			entry.fate = "self";
			return entry;
		}
		if (!eventAllowed(event.type, this.delivery.settings().events)) {
			entry.fate = "filtered";
			return entry;
		}
		const key = coalesceKey(event);
		const earlier =
			key === undefined
				? undefined
				: this.#pending.find((one) => coalesceKey(one.event) === key);
		if (earlier !== undefined) {
			// The new one takes the earlier one's place in line, merged.
			const merged = merge(earlier.event, event);
			(entry as { event: OrchestratorEvent }).event = merged;
			earlier.fate = "coalesced";
			earlier.into = entry.seq;
			earlier.settledAt = entry.at;
			this.#pending.splice(this.#pending.indexOf(earlier), 1, entry);
		} else {
			this.#pending.push(entry);
		}
		this.delivery.changed?.();
		this.#schedule(BATCH_WINDOW_MS);
		return entry;
	}

	pause(): void {
		if (this.#paused) return;
		this.#paused = true;
		this.delivery.changed?.();
	}

	/** Stop holding, and deliver what is pending as one message. How many went out. */
	resume(): number {
		if (!this.#paused) return 0;
		this.#paused = false;
		const count = this.#pending.length;
		// The person asked for them: no batch window, no wait for a pickup.
		this.#awaiting = undefined;
		this.flush();
		this.delivery.changed?.();
		return count - this.#pending.length;
	}

	/**
	 * Deliver what is pending if the orchestrator can take it now. Called on
	 * every projection (its status moved) and by the batch timer.
	 */
	flush(): void {
		this.#timer?.cancel();
		this.#timer = undefined;
		if (this.#pending.length === 0 || this.#paused) return;
		const agentId = this.delivery.orchestrator();
		if (agentId === undefined) {
			for (const entry of this.#pending.splice(0)) entry.fate = "dropped";
			this.delivery.changed?.();
			return;
		}
		const now = this.#now();
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
			this.#schedule(PICKUP_RETRY_MS);
			return;
		}
		const batch = this.#pending.splice(0);
		const events = batch.map((entry) => entry.event);
		this.delivery.deliver(
			agentId,
			eventsMessage(events, this.delivery.settings(), now),
		);
		for (const entry of batch) {
			entry.fate = "delivered";
			entry.settledAt = now;
		}
		this.#awaiting =
			this.delivery.busy === undefined
				? undefined
				: { at: now, sawBusy: false };
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

	dispose(): void {
		this.#timer?.cancel();
		this.#timer = undefined;
	}
}

/** An event as `{EVENT_JSON}` carries it: its type, and its fields. */
export function eventJson(event: OrchestratorEvent): Record<string, unknown> {
	return { ...event };
}

/**
 * The message a batch is sent as: `init_prompt` when it carries `init` (and
 * one is set), else `event_prompt`; `{EVENT}` the lines, `{EVENT_JSON}` —
 * only when the template names it — the array.
 */
export function eventsMessage(
	events: readonly OrchestratorEvent[],
	prompts: {
		readonly event_prompt: string;
		readonly init_prompt: string | undefined;
	},
	now: number,
): string {
	const template =
		prompts.init_prompt !== undefined &&
		events.some((event) => event.type === "init")
			? prompts.init_prompt
			: prompts.event_prompt;
	const lines = events.map((event) => eventLine(event, now)).join("\n");
	const json = template.includes(EVENT_JSON_PLACEHOLDER)
		? JSON.stringify(events.map(eventJson))
		: undefined;
	return renderEventPrompt(template, lines, json);
}

export { EVENT_JSON_PLACEHOLDER, EVENT_PLACEHOLDER };

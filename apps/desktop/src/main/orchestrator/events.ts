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
 * 2. keeps the rest **pending** as action items, not a history: **one line
 *    per subject** (`subjectOf`: a pull request or Issue, an agent, a
 *    Workspace, an escalation, a timer, a custom type and text). A new event
 *    about a pending subject folds into its line (`facetOf`/`merge`): review
 *    comments add up, a lane is first `from` → last `to` (and gone when they
 *    are the same), checks and reviews are the latest, a merge or a close
 *    replaces whatever else was said about the pull request; different
 *    statements share the line, the latest leading it;
 * 3. just before delivery, drops what no longer needs attention (`relevant`:
 *    an agent working again, a question answered, an escalation closed or
 *    no longer stalled) as `dropped-stale`, and never says again what
 *    the last delivery said about a subject unless something about it has
 *    been heard since (`repeat`);
 * 4. delivers everything pending as **one** message — one line per subject
 *    (`heldLineText`) as `{EVENT}`, at most `MAX_DELIVERY_LINES` and a last
 *    line counting the rest, and as JSON for `{EVENT_JSON}` only when the
 *    template has it — once the orchestrator can take it: not paused, not
 *    mid-turn, nothing of ours still queued for it. The message is queued for
 *    it as the person's (`deliver`), the same queue `agent send` uses.
 *
 * **Paused** holds everything, and the sources that cost something (GitHub)
 * are suspended (`paused`); `resume` lets them catch up first and delivers
 * it all as one message. With no
 * orchestrator assigned there is nobody to tell, and an event is dropped
 * (and kept in the log as dropped): the next start's `init` sends it to the
 * board anyway.
 *
 * Every event, whatever came of it (coalesced, dropped-stale, repeat …), is
 * kept in a short log (`log`) for `devhub --tell orchestrator events`.
 *
 * A plan window's use crossing a threshold (`usageThresholds.ts`) is one
 * line per CLI and window, the latest crossing; it is dropped as stale once
 * the window has reset below it.
 *
 * Adding an event is a variant here, its line in `eventLine`, and a
 * `dispatch` where it happens. See `docs/orchestrator.md`, "Events".
 */

import { dueWords } from "../../model/escalations.js";
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

/** One 待機中 escalation, as `escalation.waiting_reminder` lists it. */
export interface WaitingItem {
	readonly escalationId: number;
	readonly title: string;
	readonly trigger: string;
	readonly dueAt?: number;
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
	  }
	/**
	 * Level-triggered: an escalation in 対応中 that none of
	 * its agents is working on (all idle, waiting, stopped or gone, or it
	 * names none), for longer than the grace. Once per stalled stretch
	 * (`since`): said again only after one of them worked, or a new entry.
	 */
	| {
			readonly type: "escalation.stalled";
			readonly escalationId: number;
			readonly title: string;
			/** Its agents (the orchestrator left out); empty when it names none. */
			readonly agents: readonly EventAgent[];
			/** Since when nothing has moved on it: the stretch's start. */
			readonly since: number;
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
	 * Every `[orchestrator] wait_reminder_interval`: every 待機中 escalation
	 * and its trigger, as one line. Not said when none waits; one pending at
	 * most (the latest).
	 */
	| {
			readonly type: "escalation.waiting_reminder";
			readonly waiting: readonly WaitingItem[];
	  }
	| ({
			readonly type: "github.assigned";
			readonly item: EventItem;
			readonly kind: "issue" | "pr";
			readonly login: string;
	  } & Where)
	/**
	 * Level-triggered, unlike the rest: an open Issue on a watched board,
	 * assigned to the viewer, with no live DevHub agent linked to it
	 * (`unattended.ts`). Said once per stretch of being unattended, the
	 * baseline poll included; said again only after an agent was linked and
	 * then was not.
	 */
	| ({
			readonly type: "github.unattended";
			readonly item: EventItem;
			readonly project: string;
			/** Its Status, for information: it does not decide anything. */
			readonly lane: string | null;
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
			/** The commit checked: a new one's result is news, the same one's is not. */
			readonly head?: string;
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
	"escalation.stalled",
	"escalation.wait_due",
	"escalation.waiting_reminder",
	"github.assigned",
	"github.lane_changed",
	"github.unattended",
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
	"usage.threshold",
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

/** A lane as `lane=` says it: quoted when it has a space in it. */
function laneToken(lane: string | null): string {
	if (lane === null) return "(なし)";
	return /^\S+$/u.test(lane) ? lane : JSON.stringify(lane);
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
		case "escalation.human_direct":
			return {
				head: [
					`esc=${String(event.escalationId)}${title(event.title)}`,
					agentToken(event.agent),
					...(event.since === undefined ? [] : [`since=${event.since}`]),
				],
				summary:
					"人がエージェントと直接やりとりしました。エスカレの内容が変わった可能性があります",
			};
		case "escalation.stalled":
			return {
				head: [
					`esc=${String(event.escalationId)}${title(event.title)}`,
					`agents=${event.agents.length === 0 ? "none" : event.agents.map((one) => shortId(one.id)).join(",")}`,
					`idle ${span(now - event.since)}`,
				],
				summary:
					event.agents.length === 0
						? "対応中だが関連エージェントがいない (escalation link で紐づける)"
						: "対応中だが動いているエージェントがいない",
			};
		case "escalation.wait_due":
			return {
				head: [`esc=${String(event.escalationId)}${title(event.title)}`],
				summary: `待機条件の時刻になりました: ${excerpt(event.trigger, 150)}`,
			};
		case "escalation.waiting_reminder":
			return {
				head: [`待機中 ${String(event.waiting.length)} 件`],
				summary: event.waiting
					.map(
						(one) =>
							`esc=${String(one.escalationId)}${title(one.title)}: ${excerpt(one.trigger, 80)}${one.dueAt === undefined ? "" : ` (${dueWords(one.dueAt, now)})`}`,
					)
					.join(" / "),
			};
		case "github.assigned":
			return {
				head: [item(event.kind, event.item), ...where(event)],
				summary: `${event.login} にアサイン`,
				...(event.item.url === undefined ? {} : { url: event.item.url }),
			};
		case "github.unattended":
			return {
				head: [
					item("issue", event.item),
					`lane=${laneToken(event.lane)}`,
					...where(event),
				],
				summary: "自分にアサインされているがエージェントがいない",
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
					event.draft
						? `${event.author === undefined ? "" : " "}draft で作成`
						: "作成",
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

/** The agent an event is about, for "never about the orchestrator itself". */
export function eventAgent(event: OrchestratorEvent): string | undefined {
	switch (event.type) {
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

// --- subjects: one line per thing that may need attention ------------------------

function prKey(pr: EventItem): string {
	return `${pr.repo}#${String(pr.number)}`;
}

/**
 * What an event is about: a pull request or Issue, an agent, a Workspace, an
 * escalation, a timer, a custom type and text. While pending, a subject is
 * **one line**, whatever and however many events said something about it.
 */
export function subjectOf(event: OrchestratorEvent): string {
	switch (event.type) {
		case "init":
			return "init";
		case "escalation_answered":
		case "escalation.human_direct":
		case "escalation.stalled":
		case "escalation.wait_due":
			return `esc ${String(event.escalationId)}`;
		case "escalation.waiting_reminder":
			return "waiting_reminder";
		case "agent.turn_ended":
		case "agent.asked":
		case "agent.permission_requested":
		case "agent.started":
		case "agent.exited":
		case "agent.failed":
			return `agent ${event.agent.id}`;
		case "github.assigned":
		case "github.lane_changed":
		case "github.unattended":
			return `gh ${prKey(event.item)}`;
		case "github.pr_opened":
		case "github.pr_ready":
		case "github.pr_merged":
		case "github.pr_closed":
		case "github.review_requested":
		case "github.pr_approved":
		case "github.changes_requested":
		case "github.review_comment":
		case "github.reply":
		case "github.checks":
			return `gh ${prKey(event.pr)}`;
		case "workspace.opened":
		case "workspace.closed":
		case "workspace.issue_assigned":
		case "workspace.branch_changed":
		case "workspace.pr_linked":
			return `ws ${event.ws}`;
		case "timer.elapsed":
			return `timer ${event.name}`;
		case "usage.threshold":
			return `usage ${event.cli} ${event.window}`;
		default:
			return `${event.type} ${event.text}`;
	}
}

/**
 * Which part of its subject's line an event speaks for. Two events with the
 * same subject and facet fold (`merge`); different facets of one subject
 * share the line, the latest leading it.
 */
export function facetOf(event: OrchestratorEvent): string {
	switch (event.type) {
		case "github.assigned":
			return "assign";
		case "github.lane_changed":
			return `lane ${event.project}`;
		case "github.pr_approved":
		case "github.changes_requested":
			return "review";
		case "github.pr_merged":
		case "github.pr_closed":
		case "agent.started":
		case "agent.exited":
		case "workspace.opened":
		case "workspace.closed":
			return "life";
		case "agent.asked":
		case "agent.permission_requested":
			return `${event.type} ${event.request ?? ""}`;
		case "workspace.pr_linked":
			return `pr ${prKey(event.pr)}`;
		case "workspace.issue_assigned":
			return `issue ${prKey(event.issue)}`;
		case "escalation.human_direct":
			return `${event.type} ${event.agent.id}`;
		default:
			return event.type;
	}
}

/** An event that ends its subject: what was said about it before is moot. */
function terminal(event: OrchestratorEvent): boolean {
	return (
		event.type === "github.pr_merged" ||
		event.type === "github.pr_closed" ||
		event.type === "agent.exited" ||
		event.type === "workspace.closed"
	);
}

/**
 * Events that add news each time (a count, an answer, a turn, a tick): a
 * second one is never a repeat of the first. Every other kind states where
 * its subject stands, and the same statement again says nothing new.
 */
function accumulates(event: OrchestratorEvent): boolean {
	return (
		event.type === "init" ||
		event.type === "escalation_answered" ||
		event.type === "escalation.human_direct" ||
		// Each one reminds anew, even of the same list: never a repeat. While
		// one is pending, the next replaces it (one subject, `merge`).
		event.type === "escalation.waiting_reminder" ||
		event.type === "github.review_comment" ||
		event.type === "github.reply" ||
		// The source says it once per stretch of being unattended: a second
		// one is a new stretch, never a repeat of the first.
		event.type === "github.unattended" ||
		event.type === "agent.turn_ended" ||
		event.type === "timer.elapsed" ||
		event.type.startsWith("custom.")
	);
}

function union(a: readonly string[], b: readonly string[]): string[] {
	return [...new Set([...a, ...b])];
}

/**
 * `older` and `newer` (same subject and facet) as the one statement they
 * become — undefined when they cancel out (a lane moved back, an assignment
 * taken back): nothing changed, nothing to say.
 */
export function merge(
	older: OrchestratorEvent,
	newer: OrchestratorEvent,
): OrchestratorEvent | undefined {
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
		return older.from === newer.to ? undefined : { ...newer, from: older.from };
	if (
		older.type === "workspace.branch_changed" &&
		newer.type === "workspace.branch_changed"
	)
		return older.from === newer.to ? undefined : { ...newer, from: older.from };
	// The latest turn, read from where the first unread one began.
	if (older.type === "agent.turn_ended" && newer.type === "agent.turn_ended")
		return {
			...newer,
			...(older.since === undefined ? {} : { since: older.since }),
		};
	// What the person said, read from their first unread message.
	if (
		older.type === "escalation.human_direct" &&
		newer.type === "escalation.human_direct"
	)
		return {
			...newer,
			...(older.since === undefined ? {} : { since: older.since }),
		};
	// A timer is pending once: the first stands.
	if (older.type === "timer.elapsed") return older;
	// Where it stands now: the latest (checks failed → passed, approved …).
	return newer;
}

// --- the dispatcher ------------------------------------------------------------

/** What came of an event, as `orchestrator events` lists it. */
export type EventFate =
	| "pending"
	| "delivered"
	| "filtered"
	/** Folded into a later event about the same subject (`into`). */
	| "coalesced"
	/** No longer needed attention when it would have gone (`reason`). */
	| "dropped-stale"
	/** Said already, and its subject has not changed since. */
	| "repeat"
	/** Beyond a delivery's cap: counted in its last line, not sent. */
	| "overflow"
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
	/** Why it was dropped-stale. */
	reason?: string;
}

/** One pending line: a subject, and what is to be said about it. */
export interface HeldLine {
	/** The latest statement: its `[type]` leads the line. */
	readonly event: OrchestratorEvent;
	/** The subject's other pending statements, oldest first. */
	readonly also: readonly OrchestratorEvent[];
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
	};
	/** Queue `text` for `agentId` as the person's message (held mid-turn). */
	readonly deliver: (agentId: string, text: string) => void;
	/**
	 * Whether `agentId` cannot take a message now: mid-turn, stopped on a
	 * question, or something is still queued for it. Absent: it always can.
	 */
	readonly busy?: (agentId: string) => boolean;
	/**
	 * Whether a pending event still needs attention, read off live state just
	 * before it goes (an agent working again, a question answered, an
	 * escalation closed). False: it is dropped as `dropped-stale`. Absent:
	 * everything does.
	 */
	readonly relevant?: (event: OrchestratorEvent) => boolean;
	/**
	 * The pause moved. On a resume, what it returns is awaited (at most
	 * `CATCH_UP_TIMEOUT_MS`) before the held events go: a source that was
	 * suspended catches up first, and its news goes in the same message.
	 */
	readonly paused?: (paused: boolean) => Promise<void> | void;
	/** The pause, or what is pending, changed. */
	readonly changed?: () => void;
	readonly log?: (line: string) => void;
	readonly now?: () => number;
	/** Absent: batches go out at once (tests). */
	readonly setTimer?: (ms: number, run: () => void) => { cancel(): void };
}

interface PendingLine {
	readonly subject: string;
	/** Per facet, the entry that now speaks for it. */
	readonly facets: Map<string, EventLogEntry>;
}

function leading(line: PendingLine): EventLogEntry {
	let lead: EventLogEntry | undefined;
	for (const entry of line.facets.values())
		if (lead === undefined || entry.seq > lead.seq) lead = entry;
	return lead!;
}

function heldLine(line: PendingLine): HeldLine {
	const lead = leading(line);
	return {
		event: lead.event,
		also: [...line.facets.values()]
			.filter((entry) => entry !== lead)
			.sort((a, b) => a.seq - b.seq)
			.map((entry) => entry.event),
	};
}

/** What makes two statements of one facet the same statement. */
function fingerprint(event: OrchestratorEvent): string {
	return JSON.stringify(event);
}

export class EventDispatcher {
	#paused = false;
	/** Catching up after a resume: delivery waits for it. */
	#catchingUp = false;
	/** Pending, one line per subject, in the order the subjects came up. */
	readonly #lines: PendingLine[] = [];
	readonly #log: EventLogEntry[] = [];
	/**
	 * What the last delivery said about each subject, per facet, until
	 * something new is heard about it: the same statement again is a repeat.
	 */
	readonly #said = new Map<string, Map<string, string>>();
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

	/** What is pending, one event per subject (the one leading its line). */
	held(): readonly OrchestratorEvent[] {
		return this.#lines.map((line) => leading(line).event);
	}

	/** What is pending, line by line, with what else each line says. */
	heldLines(): readonly HeldLine[] {
		return this.#lines.map(heldLine);
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
		const subject = subjectOf(event);
		const facet = facetOf(event);
		let line = this.#lines.find((one) => one.subject === subject);
		if (
			line === undefined &&
			!accumulates(event) &&
			this.#said.get(subject)?.get(facet) === fingerprint(event)
		) {
			entry.fate = "repeat";
			entry.settledAt = entry.at;
			return entry;
		}
		// Something was heard about it: what was said is no longer the last word.
		this.#said.delete(subject);
		if (line === undefined) {
			line = { subject, facets: new Map() };
			this.#lines.push(line);
		}
		const fold = (earlier: EventLogEntry) => {
			earlier.fate = "coalesced";
			earlier.into = entry.seq;
			earlier.settledAt = entry.at;
		};
		if (terminal(event)) {
			// Merged, closed, gone: that is the line now.
			for (const earlier of line.facets.values()) fold(earlier);
			line.facets.clear();
			line.facets.set(facet, entry);
		} else {
			const earlier = line.facets.get(facet);
			if (earlier === undefined) line.facets.set(facet, entry);
			else {
				fold(earlier);
				const merged = merge(earlier.event, event);
				if (merged === undefined) {
					entry.fate = "dropped-stale";
					entry.reason = "no net change";
					entry.settledAt = entry.at;
					line.facets.delete(facet);
				} else {
					(entry as { event: OrchestratorEvent }).event = merged;
					line.facets.set(facet, entry);
				}
			}
		}
		if (line.facets.size === 0)
			this.#lines.splice(this.#lines.indexOf(line), 1);
		this.delivery.changed?.();
		this.#schedule(BATCH_WINDOW_MS);
		return entry;
	}

	pause(): void {
		if (this.#paused) return;
		this.#paused = true;
		void this.delivery.paused?.(true);
		this.delivery.changed?.();
	}

	/**
	 * Stop holding: let the suspended sources catch up (their news joins the
	 * held events), then deliver what is pending as one message. How many
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
		const count = this.#lines.length;
		// The person asked for them: no batch window, no wait for a pickup.
		this.#awaiting = undefined;
		this.flush();
		this.delivery.changed?.();
		return count - this.#lines.length;
	}

	/** Drop what no longer needs attention; a line left with nothing goes. */
	#dropStale(): void {
		const relevant = this.delivery.relevant;
		if (relevant === undefined) return;
		const now = this.#now();
		for (const line of [...this.#lines]) {
			for (const [facet, entry] of [...line.facets])
				if (!relevant(entry.event)) {
					entry.fate = "dropped-stale";
					entry.reason = "no longer needs attention";
					entry.settledAt = now;
					line.facets.delete(facet);
				}
			if (line.facets.size === 0)
				this.#lines.splice(this.#lines.indexOf(line), 1);
		}
	}

	/**
	 * Deliver what is pending if the orchestrator can take it now. Called on
	 * every projection (its status moved) and by the batch timer.
	 */
	flush(): void {
		this.#timer?.cancel();
		this.#timer = undefined;
		if (this.#lines.length === 0 || this.#paused || this.#catchingUp) return;
		const agentId = this.delivery.orchestrator();
		if (agentId === undefined) {
			for (const line of this.#lines.splice(0))
				for (const entry of line.facets.values()) entry.fate = "dropped";
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
			eventsMessage(sent.map(heldLine), this.delivery.settings(), now, {
				more: over.length,
			}),
		);
		for (const line of sent) {
			const said = new Map<string, string>();
			for (const [facet, entry] of line.facets) {
				entry.fate = "delivered";
				entry.settledAt = now;
				if (!accumulates(entry.event))
					said.set(facet, fingerprint(entry.event));
			}
			this.#said.set(line.subject, said);
		}
		for (const line of over)
			for (const entry of line.facets.values()) {
				entry.fate = "overflow";
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
 * One subject's line: the latest statement's `[type]` and ids, its summary,
 * then each other pending statement about it (`／ [type] …`, without the ids
 * the line already has), and the link once at the end.
 */
export function heldLineText(line: HeldLine, now: number): string {
	if (line.also.length === 0) return eventLine(line.event, now);
	const lead = linePartsOf(line.event, now);
	const parts = [
		`[${line.event.type}]`,
		...lead.head,
		...(lead.summary === undefined ? [] : [`— ${lead.summary}`]),
	];
	let url = lead.url;
	for (const event of line.also) {
		const more = linePartsOf(event, now);
		url ??= more.url;
		parts.push(
			"／",
			`[${event.type}]`,
			...more.head.filter((part) => !lead.head.includes(part)),
			...(more.summary === undefined ? [] : [more.summary]),
		);
	}
	if (url !== undefined) parts.push(url);
	return parts.filter((part) => part.length > 0).join(" ");
}

/** The last line of a delivery that was cut at `MAX_DELIVERY_LINES`. */
export function overflowLine(more: number): string {
	return `…ほか ${String(more)} 件 (devhub --tell orchestrator events で確認)`;
}

/**
 * The message a batch is sent as: `init_prompt` when it carries `init` (and
 * one is set), else `event_prompt`; `{EVENT}` the lines, one per subject,
 * `{EVENT_JSON}` — only when the template names it — the array (a line's
 * other statements as its `also`).
 */
export function eventsMessage(
	items: readonly (OrchestratorEvent | HeldLine)[],
	prompts: {
		readonly event_prompt: string;
		readonly init_prompt: string | undefined;
	},
	now: number,
	options: { readonly more?: number } = {},
): string {
	const lines: HeldLine[] = items.map((one) =>
		"type" in one ? { event: one, also: [] } : one,
	);
	const template =
		prompts.init_prompt !== undefined &&
		lines.some((line) => line.event.type === "init")
			? prompts.init_prompt
			: prompts.event_prompt;
	const more = options.more ?? 0;
	const text = [
		...lines.map((line) => heldLineText(line, now)),
		...(more > 0 ? [overflowLine(more)] : []),
	].join("\n");
	const json = template.includes(EVENT_JSON_PLACEHOLDER)
		? JSON.stringify(
				lines.map((line) => ({
					...eventJson(line.event),
					...(line.also.length === 0 ? {} : { also: line.also.map(eventJson) }),
				})),
			)
		: undefined;
	return renderEventPrompt(template, text, json);
}

export { EVENT_JSON_PLACEHOLDER, EVENT_PLACEHOLDER };

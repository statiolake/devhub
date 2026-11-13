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
 *    `task.human_direct`, `request`: `isHumanInput`) at once, each as a message of
 *    its own whose text is what they typed, under one line naming the
 *    task (`humanMessage`) — never inside an event line or the
 *    `event_prompt` template, so the orchestrator reads it as the person's
 *    own input. Nothing holds them, off included (`isAnswer`); with no
 *    orchestrator running they wait for one. A request waits while off;
 *    so does an agent the person took back (`agent_unmanaged`), which also
 *    waits for an orchestrator to start. An agent handed over
 *    (`agent_managed`) goes the same way, at once in full and saving; off,
 *    or with no orchestrator, it is dropped — the board's `no_task` says it;
 * 3. keeps the rest **pending** as action items, not a history: **one line
 *    per subject** (`subjectOf`: a task, an item, an agent, a timer,
 *    a usage window, a custom type and text). A newer statement about a
 *    pending subject replaces the older one (`merge`):
 *    a line says how the subject stands now, not what happened to it;
 * 3a. sends **the orchestrator's own wake-ups** (`onTime`: a `timer set`
 *    timer, a 待機 task's `due`) at once, each its one line as a message of its
 *    own — not batched, not held by the interval or saving. Off turns them
 *    off: one that comes due while off is dropped (`offDrops`), not sent
 *    later;
 * 4. just before delivery, drops what no longer needs attention (`relevant`:
 *    a task no longer 待機, a usage window reset) as `dropped-stale`;
 * 5. delivers everything pending, and **the invariant's `needs_action`
 *    lines** (`standing`: every subject that needs action at that moment,
 *    as **one** message — one line per subject
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
 * interval `SAVING_INTERVAL_FACTOR` times as long and sorts each line into a
 * state change or a nudge (`savingClassOf`): state changes go with every
 * batch; a nudge only when its subject is ranked high and — while
 * `inProgress` is `SAVING_BUSY_TASKS` or more — about a task in progress
 * (`savingHolds`). A `needs_action` line standing as it stood when it last
 * went (`statePrint`) is said again: a nudge. A batch carrying `init` or
 * `triage` takes everything; the person's words are never batches. `off` is
 * the pause below.
 *
 * **Paused** (`off`) holds everything but the person's answers
 * (`escalation_answered`, `task.human_direct`: they go as in full),
 * the person's requests included, and the sources that cost something
 * (GitHub) are suspended (`paused`). The timers are off too: a
 * `timer.elapsed`, or a task's `due`, that comes while off is dropped
 * (`dropped`, reason `off`), never sent later. `resume` sends at once the
 * held requests, then everything else — pending and standing — as one
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
 * sends it to the board anyway. The person's answers are not: they wait
 * until one runs (and a request is kept by `requests.ts` for the same).
 *
 * Every event, whatever came of it, is kept in a short log (`log`) for
 * `devhub --tell orchestrator events`.
 *
 * Adding an event is a variant here, its line in `linePartsOf`, and a
 * `dispatch` where it happens. See `docs/orchestrator.md`, "Events".
 */

import {
	SAVING_INTERVAL_FACTOR,
	onTime,
	savingClassOf,
	savingHolds,
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

/** A task, as an event names it: its id (to address it by) and its title. */
export interface EventTask {
	readonly id: number;
	readonly title?: string;
}

export type OrchestratorEvent =
	/** The orchestrator has just been started (or restarted). */
	| { readonly type: "init" }
	/**
	 * The person answered an escalation: it is closed, and its task is
	 * 処理中 — the answer is work to carry out. Their words, at once.
	 */
	| {
			readonly type: "escalation_answered";
			readonly task: EventTask;
			readonly escalationId: number;
			readonly title: string;
			readonly agents: readonly EventAgent[];
			/** What they wrote. */
			readonly answers?: readonly HumanWords[];
	  }
	/**
	 * The person talked directly, from its own composer, to an agent of a
	 * task with an open question, and it took that up (went working). The
	 * question stays open; what was said may answer it, or change it.
	 */
	| {
			readonly type: "task.human_direct";
			readonly task: EventTask;
			readonly agent: EventAgent;
			/** `agent read --since`: the person's message. */
			readonly since?: string;
			/** What they said; absent when it could not be read. */
			readonly messages?: readonly HumanWords[];
	  }
	/**
	 * The person handed an agent over to the orchestrator from DevHub's
	 * window (the row menu's Manage with Orchestrator, `Cmd+Q Shift+M`):
	 * the orchestrator adopts it — binds it to a task, or makes one — and
	 * decides its next step. Its own message, at once (`humanMessages`).
	 */
	| AgentHandover<"agent_managed">
	/**
	 * The person took an agent back from the orchestrator (Stop Managing):
	 * it is theirs again — not to be sent to or resumed, its task binding
	 * undone. Its own message, at once; while off, or with no orchestrator,
	 * it waits for one.
	 */
	| AgentHandover<"agent_unmanaged">
	/**
	 * A subject that breaks the invariant (`invariant.ts`): an open task,
	 * an item of the population with no task, or a managed agent with no
	 * task, and the clause it fails. No state: that is `task show` /
	 * `devhub --tell status`'s.
	 */
	| {
			readonly type: "needs_action";
			readonly subject:
				| { readonly kind: "task"; readonly task: EventTask }
				| { readonly kind: "issue" | "pr"; readonly item: EventItem }
				| { readonly kind: "agent"; readonly agent: EventAgent };
			readonly ws?: string;
			readonly breach: Breach;
	  }
	/**
	 * A 待機 task may be ready: what it is about moved (its linked items,
	 * its agents: `subjects_changed`), or the time it was given to look
	 * again came (`due`, once per time). Which of the two, nothing more.
	 * Dropped before it goes if the task is no longer 待機.
	 */
	| {
			readonly type: "task.changed";
			readonly taskId: number;
			readonly reasons: readonly WaitingReason[];
			/** The `--check-at` it was given, for `due`. */
			readonly checkAt?: number;
	  }
	| {
			readonly type: "timer.elapsed";
			readonly name: string;
			readonly interval: string;
			/**
			 * `session`: the orchestrator set it (`orchestrator timer set`).
			 * `settings` (or absent): one of the person's
			 * `[[orchestrator.timers]]`. Either is sent on time (`onTime`).
			 */
			readonly source?: "settings" | "session";
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
	 * Time to rank the open tasks again (`triage.ts`) and re-check each
	 * (`tasks`): the ones DevHub marks as maybe stale, with why
	 * (`staleness.ts`).
	 */
	| {
			readonly type: "triage";
			/** The open tasks as the triage was asked; absent: none. */
			readonly tasks?: readonly TriageTask[];
	  }
	/**
	 * The person's request, from the Orchestrator screen's +: a 待機 task
	 * made with their words, which go at once as their own message
	 * (`isHumanInput`).
	 */
	| {
			readonly type: "request";
			readonly task: EventTask;
			readonly text: string;
	  }
	| { readonly type: `custom.${string}`; readonly text: string };

export type OrchestratorEventType = OrchestratorEvent["type"];

/**
 * An agent the person handed to the orchestrator or took back
 * (`agent_managed`, `agent_unmanaged`): who it is and where, and what it was
 * doing — enough to adopt it, or let go of it, without a call first.
 */
export interface AgentHandover<T extends "agent_managed" | "agent_unmanaged"> {
	readonly type: T;
	readonly agent: EventAgent;
	/** Its Workspace as `ws=` names it (`workspaceToken`). */
	readonly ws: string;
	/** Its Workspace's branch, when it is a repository. */
	readonly branch?: string;
	/** working, background, waiting, idle, error, unknown, stopping. */
	readonly status: string;
	/** The open task it is bound to, when it is. */
	readonly task?: EventTask;
	/** The person's last message to it (`excerpt`), when it has one. */
	readonly request?: string;
}

/** `agent_managed` or `agent_unmanaged`. */
export type AgentHandoverEvent =
	| AgentHandover<"agent_managed">
	| AgentHandover<"agent_unmanaged">;

/** The person handed an agent over, or took it back. */
export function isHandover(
	event: OrchestratorEvent,
): event is AgentHandoverEvent {
	return event.type === "agent_managed" || event.type === "agent_unmanaged";
}

/** An open task, as a `triage` lists it for the re-check. */
export interface TriageTask {
	readonly id: number;
	readonly title: string;
	readonly status: "answer" | "in_progress" | "waiting";
	readonly priority?: "high" | "low";
	/** Why it may be stale (`staleWords`); absent: nothing seen. */
	readonly stale?: readonly string[];
	/**
	 * Marked stale already when the last triage went: to be resolved in this
	 * one (completed, re-linked, or kept with a memo saying why).
	 */
	readonly overdue?: boolean;
}

const TRIAGE_STATUS_WORDS: Record<TriageTask["status"], string> = {
	answer: "回答待ち",
	in_progress: "処理中",
	waiting: "待機",
};

/** A triage's re-check list: one indented line per open task. */
function triageLines(event: Extract<OrchestratorEvent, { type: "triage" }>) {
	return (event.tasks ?? []).map((one) => {
		const stale =
			one.stale === undefined || one.stale.length === 0
				? ""
				: ` — 古いかも: ${one.stale.join("; ")}${one.overdue === true ? " (前回の triage から: この triage で解決する)" : ""}`;
		const priority =
			one.priority === undefined ? "" : ` 優先度=${one.priority}`;
		return `  task=${String(one.id)}${title(one.title)} ${TRIAGE_STATUS_WORDS[one.status]}${priority}${stale}`;
	});
}

/**
 * The invariant's clause a subject fails (`invariant.ts`), as a short code:
 * a 処理中 task with no bound agent open (`no_agent`), or whose bound agents
 * all stopped (`idle`); an item of the population or a managed agent that
 * no open task has (`no_task`).
 */
export type NeedsActionClause = "no_agent" | "idle" | "no_task";

export interface Breach {
	readonly clause: NeedsActionClause;
}

/** `no_agent`, `idle`, `no_task`: a breach as a line says it. */
export function breachWords(breach: Breach): string {
	return breach.clause;
}

/** Why a 待機 task may be ready, as `task.changed` says it. */
export type WaitingReason = "subjects_changed" | "due";

/** Every type DevHub itself emits (`custom.*` is the open family). */
export const EVENT_TYPES = [
	"init",
	"escalation_answered",
	"task.human_direct",
	"needs_action",
	"task.changed",
	"timer.elapsed",
	"usage.threshold",
	"triage",
	"request",
	"agent_managed",
	"agent_unmanaged",
	"custom.*",
] as const;

/** `custom.NAME`: what `orchestrator emit --type` takes. */
export function customTypeProblem(type: string): boolean {
	return !/^custom\.[a-z0-9][a-z0-9_-]{0,39}$/u.test(type);
}

/**
 * An event that carries the person's own words, or their own act: a
 * message of its own, at once.
 */
export type HumanInputEvent =
	| Extract<
			OrchestratorEvent,
			{ type: "escalation_answered" | "task.human_direct" | "request" }
	  >
	| AgentHandoverEvent;

/**
 * The person's own words (sent as they typed them), or their own act — an
 * agent handed over or taken back: sent at once, as a message of its own.
 */
export function isHumanInput(
	event: OrchestratorEvent,
): event is HumanInputEvent {
	return (
		event.type === "escalation_answered" ||
		event.type === "task.human_direct" ||
		event.type === "request" ||
		isHandover(event)
	);
}

/**
 * The person's answer to an escalation, or their words to an agent of a
 * task waiting on them: delivered in every mode, off included — someone
 * answered, so the work they unblock goes on.
 */
export function isAnswer(event: OrchestratorEvent): boolean {
	return (
		event.type === "escalation_answered" || event.type === "task.human_direct"
	);
}

/**
 * What waits for an orchestrator to start when there is none: the person's
 * answers, and an agent taken back from it — which must reach it before it
 * resumes that agent. An agent handed over does not wait: the next start's
 * board says it (`no_task`).
 */
export function waitsForOrchestrator(event: OrchestratorEvent): boolean {
	return isAnswer(event) || event.type === "agent_unmanaged";
}

/**
 * Off turns the timers off: what is left of `event` while off, or undefined
 * when off drops it whole. A `timer.elapsed` (the settings' and `timer set`'s
 * alike) is dropped: the next firing is on its schedule. A task's `due`
 * (`--check-at`) is dropped from a `task.changed` (its `subjects_changed`,
 * a state change, waits as everything does while off).
 */
export function offDrops(
	event: OrchestratorEvent,
): OrchestratorEvent | undefined {
	if (event.type === "timer.elapsed") return undefined;
	if (event.type !== "task.changed" || !event.reasons.includes("due"))
		return event;
	const reasons = event.reasons.filter((one) => one !== "due");
	return reasons.length === 0 ? undefined : { ...event, reasons };
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

/** `task=12「…」`: a task as a line names it. */
export function taskToken(task: EventTask): string {
	return `task=${String(task.id)}${title(task.title)}`;
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
		.join(" ")
		.concat(
			event.type === "triage"
				? triageLines(event)
						.map((line) => `\n${line}`)
						.join("")
				: "",
		);
}

function needsActionParts(
	event: Extract<OrchestratorEvent, { type: "needs_action" }>,
): LineParts {
	const subject = event.subject;
	return {
		head: [
			subject.kind === "task"
				? taskToken(subject.task)
				: subject.kind === "agent"
					? agentToken(subject.agent)
					: `${subject.kind}=${issueRef(subject.item)}`,
			...(event.ws === undefined ? [] : [`ws=${event.ws}`]),
		],
		summary: breachWords(event.breach),
	};
}

/**
 * A `needs_action` line without its `[type]`: the subject, its Workspace and
 * the clause — `task=12「…」 ws=web — idle`, `issue=acme/web#123 — no_task`.
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
					taskToken(event.task),
					`esc=${String(event.escalationId)}${title(event.title)}`,
					...event.agents.map(agentToken),
				],
				summary: "人が回答しました",
			};
		case "task.human_direct":
			return {
				head: [
					taskToken(event.task),
					agentToken(event.agent),
					...(event.since === undefined ? [] : [`since=${event.since}`]),
				],
				summary: "人がエージェントと直接やりとりしました",
			};
		case "needs_action":
			return needsActionParts(event);
		case "task.changed":
			return {
				head: [`task=${String(event.taskId)}`],
				summary: event.reasons.join(", "),
			};
		case "timer.elapsed":
			return { head: [event.name] };
		case "triage":
			return {
				head: [],
				summary:
					(event.tasks ?? []).length === 0
						? "見直し: 開いているタスクはありません。devhub --tell --json board で要対応 (タスクのないエージェント・アイテム) を見て、それぞれタスクにする"
						: "見直し: 下の開いているタスクそれぞれについて、まだ成り立つか確かめ、優先度を devhub --tell task edit <ID> --priority high|normal|low で付け直す。古いかもと出ているものは、終わっていれば task done、対象が変わっていれば task link / unlink、続けるならメモ (task edit --memo) に理由を書く。タスクのないエージェントとアイテム (board の要対応) はタスクにする",
			};
		case "request":
			return {
				head: [taskToken(event.task)],
				summary: excerpt(event.text, 200),
			};
		case "agent_managed":
		case "agent_unmanaged":
			return {
				head: [
					agentToken(event.agent),
					`ws=${event.ws}`,
					...(event.task === undefined ? [] : [taskToken(event.task)]),
				],
				summary:
					event.type === "agent_managed"
						? "人が管理下に移しました"
						: "人が管理から外しました",
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
 * The message the person's words go as: one line naming the task (and the
 * escalation, or the agent), then their text exactly as typed — unquoted,
 * unwrapped, no template around it.
 */
export function humanMessage(
	event: Extract<
		OrchestratorEvent,
		{ type: "escalation_answered" | "task.human_direct" }
	>,
	piece: HumanWords | undefined,
): string {
	const task = taskToken(event.task);
	if (event.type === "escalation_answered") {
		const esc = `esc=${String(event.escalationId)}${title(event.title)}`;
		const option =
			piece?.option === undefined
				? ""
				: ` (選択肢「${excerpt(piece.option, 80)}」)`;
		return piece === undefined
			? `${task} ${esc} に人が回答しました (devhub --tell escalation show ${String(event.escalationId)} で読む)`
			: `${task} ${esc} への人の回答${option}:\n${piece.text}`;
	}
	const agent = shortId(event.agent.id);
	return piece === undefined
		? `${task} agent=${agent} に人が直接話しかけました (devhub --tell agent read ${agent}${event.since === undefined ? "" : ` --since ${event.since}`} で読む)`
		: `${task} agent=${agent} に人が直接送ったメッセージ:\n${piece.text}`;
}

/**
 * The message an agent handed over (`agent_managed`) or taken back
 * (`agent_unmanaged`) goes as: who and where it is, its link, what it was
 * doing, and what the orchestrator does now.
 */
export function handoverMessage(event: AgentHandoverEvent): string {
	const agent = shortId(event.agent.id);
	const where = [
		...(event.agent.name === undefined ? [] : [excerpt(event.agent.name, 40)]),
		`ws=${event.ws}`,
		...(event.branch === undefined ? [] : [`branch=${event.branch}`]),
	].join(", ");
	const who = `エージェント agent=${agent} (${where})`;
	const link = `devhub:agent/${event.agent.id}`;
	const request =
		event.request === undefined || event.request.length === 0
			? "人からの依頼は読めません"
			: `人からの最後の依頼:「${excerpt(event.request, 200)}」`;
	const task =
		event.task === undefined
			? undefined
			: `${taskToken(event.task)} に紐づいています`;
	if (event.type === "agent_managed") {
		const adopt =
			event.task === undefined
				? `引き取ってください: 中身を devhub --tell agent read ${agent} で確かめ、合う開いたタスクがあれば devhub --tell task bind <タスク> ${agent}、なければ devhub --tell task new --title … --status in_progress で作って task bind ${agent} し、次の一手を決める。`
				: `引き取ってください: 中身を devhub --tell agent read ${agent} で確かめ、そのタスクのまま進めるか (合わなければ別のタスクに task bind し直す)、次の一手を決める。`;
		return [
			`人が${who} をあなたの管理下に移しました。${link}`,
			`状態: ${event.status}。${request}。${task ?? "どのタスクにも紐づいていません"}。`,
			adopt,
		].join("\n");
	}
	const release =
		event.task === undefined
			? "このエージェントにはもう送らず、再開もしないでください。追うのをやめるだけです。"
			: `このエージェントにはもう送らず、再開もしないでください。devhub --tell task unbind ${String(event.task.id)} ${agent} で外し、そのタスクは続けるか (別のエージェントで)、待機にするか、終わっていれば task done かを決める。`;
	return [
		`人が${who} をあなたの管理から外しました。人が自分で進めます。${link}`,
		`状態: ${event.status}。${task ?? "どのタスクにも紐づいていません"}。`,
		release,
	].join("\n");
}

/** The messages one human event goes as: one per piece of their words. */
export function humanMessages(event: HumanInputEvent): string[] {
	if (isHandover(event)) return [handoverMessage(event)];
	if (event.type === "request")
		return [
			`${taskToken(event.task)} 人からの依頼 (この依頼からタスクを作りました。devhub --tell task edit ${String(event.task.id)} で題名を整え、task link / エージェントの割り当てで進めてください):\n${event.text}`,
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
		case "task.human_direct":
		case "request":
			return `task ${String(event.task.id)}`;
		case "agent_managed":
		case "agent_unmanaged":
			return `agent ${event.agent.id}`;
		case "task.changed":
			return `task ${String(event.taskId)}`;
		case "triage":
			return "triage";
		case "needs_action":
			return event.subject.kind === "task"
				? `task ${String(event.subject.task.id)}`
				: event.subject.kind === "agent"
					? `agent ${event.subject.agent.id}`
					: `item ${prKey(event.subject.item)}`;
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
 * timer pending once stands; a 待機 task's two reasons add up; anything else
 * says how the subject stands now, and the latest does.
 */
export function merge(
	older: OrchestratorEvent,
	newer: OrchestratorEvent,
): OrchestratorEvent {
	if (older.type === "timer.elapsed" && newer.type === "timer.elapsed")
		return older;
	// The same wait: both of what happened to it are said.
	if (older.type === "task.changed" && newer.type === "task.changed")
		return {
			...newer,
			...(older.checkAt === undefined || newer.checkAt !== undefined
				? {}
				: { checkAt: older.checkAt }),
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
	/** Why it was dropped-stale, or dropped (`off`: the timers are off). */
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
	 * How many tasks are in progress now (処理中): in
	 * saving, while it is `SAVING_BUSY_TASKS` or more, the nudges about other
	 * work wait. Absent: none.
	 */
	readonly inProgress?: () => number;
	/**
	 * Whether a line's subject (`subjectOf`) is one of the tasks in progress
	 * (a 処理中 task). Absent: none is.
	 */
	readonly inProgressSubject?: (subject: string) => boolean;
	/**
	 * Whether a line's subject (`subjectOf`) is ranked high now
	 * (`triage.ts`): in saving a nudge goes only then, until a batch carries
	 * `triage`. Absent: every subject is.
	 */
	readonly high?: (subject: string, event: OrchestratorEvent) => boolean;
	/**
	 * A standing `needs_action` line's state as DevHub reads it — since when
	 * it has needed action, its clause, its facts — to tell a line with
	 * something new (a state change) from one said again as it stood (a
	 * nudge). Undefined, or absent: every standing line is new.
	 */
	readonly statePrint?: (event: OrchestratorEvent) => string | undefined;
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

export class EventDispatcher {
	#mode: OrchestratorMode;
	/** Pending, one line per subject, in the order the subjects came up. */
	readonly #lines: PendingLine[] = [];
	/**
	 * The person's words that wait: a request while off, an answer until an
	 * orchestrator runs.
	 */
	readonly #human: EventLogEntry[] = [];
	readonly #log: EventLogEntry[] = [];
	#seq = 0;
	#timer: { cancel(): void } | undefined;
	/** The last delivery, until the orchestrator is seen to have taken it. */
	#awaiting: { readonly at: number; sawBusy: boolean } | undefined;
	/** When the last batch went: the next waits `delivery_interval`. */
	#lastBatchAt: number | undefined;
	/** Each standing subject's `statePrint` when its line last went. */
	readonly #said = new Map<string, string>();

	constructor(private readonly delivery: EventDelivery) {
		this.#mode = delivery.mode ?? "full";
	}

	#now(): number {
		return (this.delivery.now ?? Date.now)();
	}

	/** Off: everything is held but the person's answers; timers are dropped. */
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
		// An answer (or an agent taken back) waits for an orchestrator to
		// start; the rest has nobody.
		if (orchestrator === undefined && !waitsForOrchestrator(event)) {
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
		// An agent handed over while off: the board says it when the mode
		// goes on (`no_task`), as it does to an orchestrator that starts.
		if (this.paused && event.type === "agent_managed") {
			entry.fate = "dropped";
			entry.reason = "off";
			entry.settledAt = entry.at;
			this.delivery.changed?.();
			return entry;
		}
		if (isHumanInput(event)) {
			if (orchestrator === undefined || this.#waits(event))
				this.#human.push(entry);
			else this.#sendHuman(orchestrator, entry);
			this.delivery.changed?.();
			return entry;
		}
		// Only an answer came this far with nobody to tell.
		if (orchestrator === undefined) return entry;
		// Off: the timers are off too. What comes due now is not sent later.
		if (this.paused) {
			const left = offDrops(event);
			if (left === undefined) {
				entry.fate = "dropped";
				entry.reason = "off";
				entry.settledAt = entry.at;
				this.delivery.changed?.();
				return entry;
			}
			(entry as { event: OrchestratorEvent }).event = left;
		}
		const subject = subjectOf(entry.event);
		const line = this.#lines.find((one) => one.subject === subject);
		if (line === undefined) this.#lines.push({ subject, entry });
		else {
			const earlier = line.entry;
			earlier.fate = "coalesced";
			earlier.into = entry.seq;
			earlier.settledAt = entry.at;
			(entry as { event: OrchestratorEvent }).event = merge(
				earlier.event,
				entry.event,
			);
			line.entry = entry;
		}
		// The orchestrator's own wake-up: at its time, alone, in any mode on.
		if (!this.paused && onTime(entry.event)) {
			this.#sendOnTime(orchestrator, subject);
			this.delivery.changed?.();
			return entry;
		}
		this.delivery.changed?.();
		this.#schedule(BATCH_WINDOW_MS);
		return entry;
	}

	/**
	 * A wake-up the orchestrator set (`onTime`): sent now as its own message
	 * (`event_prompt` around its one line), not batched, not held by the
	 * interval, the pickup wait or saving — like the person's words, queued
	 * for the orchestrator and taken when its turn ends. Re-read first: a
	 * task that is no longer 待機 is dropped-stale. The batch's interval
	 * is not moved by it.
	 */
	#sendOnTime(agentId: string, subject: string): void {
		const line = this.#lines.find((one) => one.subject === subject);
		if (line === undefined) return;
		this.#lines.splice(this.#lines.indexOf(line), 1);
		const now = this.#now();
		const entry = line.entry;
		if (this.delivery.relevant?.(entry.event) === false) {
			entry.fate = "dropped-stale";
			entry.reason = "no longer needs attention";
			entry.settledAt = now;
			return;
		}
		this.delivery.deliver(
			agentId,
			eventsMessage([entry.event], this.delivery.settings(), now),
		);
		entry.fate = "delivered";
		entry.settledAt = now;
		this.delivery.delivered?.([entry.event]);
	}

	/** Whether the person's words wait now: a request, while off. */
	#waits(event: OrchestratorEvent): boolean {
		return this.paused && !isAnswer(event);
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

	/** Off: see `setMode`. */
	pause(): void {
		this.setMode("off");
	}

	/** On, as full: see `setMode`. How many lines went out. */
	resume(): number {
		return this.setMode("full");
	}

	/**
	 * Go to `mode`. Into off: hold everything but the person's answers, and
	 * drop the timers as they fire. Out of off: stop holding, and
	 * deliver at once — the person's held words, then what is pending and
	 * what needs action now as one message, with no batch window, interval,
	 * pickup wait or turn to wait for: the person asked for them (in saving,
	 * the nudges it holds still wait). The
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

	/**
	 * The person's words that may go now: to the orchestrator, once one
	 * runs; a request not while off.
	 */
	#releaseHuman(): number {
		const agentId = this.delivery.orchestrator();
		if (agentId === undefined) return 0;
		let sent = 0;
		for (const entry of [...this.#human]) {
			if (this.#waits(entry.event)) continue;
			this.#human.splice(this.#human.indexOf(entry), 1);
			// An agent taken back, then handed over again while it waited.
			if (
				isHandover(entry.event) &&
				this.delivery.relevant?.(entry.event) === false
			) {
				entry.fate = "dropped-stale";
				entry.reason = "no longer needs attention";
				entry.settledAt = this.#now();
				continue;
			}
			this.#sendHuman(agentId, entry);
			sent += 1;
		}
		return sent;
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
	 * Saving's gate: which lines go now (`savingHolds`) — none of it outside
	 * saving, or in a batch carrying `init` or `triage` (which takes
	 * everything with it).
	 */
	#savingGate():
		| ((subject: string, event: OrchestratorEvent) => boolean)
		| undefined {
		if (this.#mode !== "saving") return undefined;
		if (
			this.#lines.some(
				(line) =>
					line.entry.event.type === "init" ||
					line.entry.event.type === "triage",
			)
		)
			return undefined;
		const tasks = this.delivery.inProgress?.() ?? 0;
		const high = this.delivery.high;
		return (subject, event) =>
			savingHolds({
				class: savingClassOf(event, this.#saidAgain(subject, event)),
				high: high === undefined || high(subject, event),
				inProgress: this.delivery.inProgressSubject?.(subject) ?? false,
				tasks,
			}) === undefined;
	}

	/** A standing line whose subject stands as it did when it last went. */
	#saidAgain(subject: string, event: OrchestratorEvent): boolean {
		if (event.type !== "needs_action") return false;
		const print = this.delivery.statePrint?.(event);
		return print !== undefined && this.#said.get(subject) === print;
	}

	/** The standing lines that went: what each said is what it stood as. */
	#markSaid(events: readonly OrchestratorEvent[]): void {
		for (const event of events) {
			if (event.type !== "needs_action") continue;
			const print = this.delivery.statePrint?.(event);
			if (print !== undefined) this.#said.set(subjectOf(event), print);
		}
	}

	/** Forget what was said of a subject that no longer stands. */
	#forgetSettled(standing: readonly OrchestratorEvent[]): void {
		const now = new Set(standing.map(subjectOf));
		for (const subject of [...this.#said.keys()])
			if (!now.has(subject)) this.#said.delete(subject);
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
		const released = this.#human.length > 0 ? this.#releaseHuman() : 0;
		if (this.paused) {
			if (released > 0) this.delivery.changed?.();
			return 0;
		}
		const agentId = this.delivery.orchestrator();
		if (agentId === undefined) {
			if (this.#lines.length === 0) return 0;
			for (const line of this.#lines.splice(0)) line.entry.fate = "dropped";
			this.delivery.changed?.();
			return 0;
		}
		const standingNow = this.#standing();
		this.#forgetSettled(standingNow);
		if (this.#lines.length === 0 && standingNow.length === 0) return 0;
		const now = this.#now();
		const hold = force ? undefined : this.#hold(agentId, now);
		if (hold !== undefined) {
			if (hold.kind === "busy") {
				if (this.#awaiting !== undefined) this.#awaiting.sawBusy = true;
			} else this.#retry(hold.ms);
			return 0;
		}
		this.#dropStale(now);
		// Saving: state changes go; a nudge only when high (and, with two or
		// more tasks in progress, about one of them). The rest waits for the
		// next triage (or full), one line per subject.
		const goes = this.#savingGate();
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
		this.#markSaid(sent.map((line) => line.entry.event));
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
		const goes = this.#savingGate();
		const waiting = [
			...this.#lines
				.filter((line) => !stale.has(line))
				.map((line) => ({ subject: line.subject, event: line.entry.event })),
			...this.#standing().map((event) => ({
				subject: subjectOf(event),
				event,
			})),
		];
		const going = waiting.filter(
			(one) => goes === undefined || goes(one.subject, one.event),
		);
		const held = waiting.length - going.length;
		const plan = composeDelivery(
			this.#human.flatMap((entry) =>
				isHumanInput(entry.event) ? [entry.event] : [],
			),
			going.map((one) => one.event),
			this.delivery.settings(),
			now,
		);
		const agentId = this.delivery.orchestrator();
		if (agentId === undefined) return { ...plan, when: { kind: "nobody" } };
		if (this.paused) return { ...plan, when: { kind: "paused" } };
		if (plan.batch === undefined)
			return held === 0
				? plan
				: { ...plan, when: { kind: "saving_held", lines: held } };
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
 * its turn, not while paused, not before the next triage when saving holds
 * every line, never with no orchestrator.
 */
export type DeliveryWhen =
	| { readonly kind: "now" }
	| { readonly kind: "at"; readonly at: number }
	| { readonly kind: "after_turn" }
	| { readonly kind: "paused" }
	/**
	 * Saving, with nothing to send now: `lines` nudges wait for the next
	 * triage (or full).
	 */
	| { readonly kind: "saving_held"; readonly lines: number }
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

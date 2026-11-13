/**
 * The Orchestrator's mode: **full**, **saving** or **off**
 * (`docs/orchestrator.md`, "Modes: full, saving, off").
 *
 * - **full** delivers as DevHub always has: a batch at most once per
 *   `delivery_interval`, each carrying every `needs_action` subject again.
 * - **saving** delivers the same things more rarely: a batch at most once per
 *   `SAVING_INTERVAL_FACTOR` × `delivery_interval`, and it tells **state
 *   changes** from **nudges** (`savingClassOf`, the table `SAVING_CLASSES`):
 *   a state change about the work — an agent stopped, on a prompt, errored,
 *   its item's pull request or checks moved, a 待機 task that may be ready — goes
 *   with every batch, whatever its priority and however many tasks are in
 *   progress; a nudge (a subject said again with nothing new, an item nobody
 *   started, the usage readout, `custom.*`) goes only when its subject is
 *   ranked high, and while `SAVING_BUSY_TASKS` or more tasks are in progress
 *   only when it is about one of them (`savingHolds`). What the person did
 *   (`by_person`), a task that may no longer be needed (`obsolete`), `init`
 *   and `triage` are never held, and an explicit timer —
 *   `[[orchestrator.timers]]`, `orchestrator timer set` — or a 待機 task's `--check-at`
 *   goes at its time, alone, as in full (`onTime`).
 * - **off** holds everything else, and GitHub is not polled but for the
 *   items the open tasks link, every `OFF_LINKED_INTERVAL` (`githubItems.ts`).
 *   Two classes go through (`goesWhileOff`): **what the person did** in the
 *   window (`by_person`: their answers, their direct words to an agent,
 *   their requests, an agent handed over or taken back) at once, as in
 *   full — the person is right there, and acted; and **a task that may no
 *   longer be needed** (`obsolete`: its linked Issue closed, its pull
 *   request merged or closed) at once, alone — closing it costs nothing
 *   and leaving it open costs every later turn. The timers are off: a timer
 *   (`[[orchestrator.timers]]`, `timer set`) or a task's `--check-at` that comes
 *   due while off is dropped, not sent when the mode turns on
 *   (`events.ts`: `offDrops`).
 *
 * **Off at every launch.** Nothing of the mode is written anywhere: a DevHub
 * that starts is off until the person turns it on (or starts an
 * orchestrator, which asks for it to run).
 *
 * **The automatic switch** (`observe`). While the mode is full and a plan
 * window of the usage readout (Claude's 5-hour or weekly, Codex's when it is
 * read) stands at `[orchestrator] saving_threshold` or more in its current
 * period, the mode becomes saving, and remembers why (`auto`). Once no window
 * does — each has reset, or reads below — a saving entered that way goes back
 * to full. A saving the person chose stays saving; off is never left
 * automatically.
 *
 * **The person's choice is kept.** Choosing full while saving was in force
 * and a window is still over (leaving saving by hand) holds full until every
 * window is back under: the automatic switch does not undo what the person
 * just did. Choosing full from off while a window is over is not that: the
 * switch happens at once, with its reason, as it would have had the mode
 * been full when the window crossed.
 *
 * Pure: the readout and the time come in, the decision goes out.
 */

import type { UsageLimitsWire } from "../../ipc/contract.js";
import type { OrchestratorEvent } from "./events.js";

export type OrchestratorMode = "full" | "saving" | "off";

export const ORCHESTRATOR_MODES: readonly OrchestratorMode[] = [
	"full",
	"saving",
	"off",
];

export function isOrchestratorMode(value: unknown): value is OrchestratorMode {
	return value === "full" || value === "saving" || value === "off";
}

/** The mode every launch starts in: nothing of it is persisted. */
export const LAUNCH_MODE: OrchestratorMode = "off";

/**
 * While off, how often the items the open tasks link are read (and nothing
 * else of GitHub): often enough that a closed Issue or a merged pull request
 * reaches the orchestrator (`task.obsolete`) within the half hour, rarely
 * enough to cost nothing — one request (`MAX_LINKED_ITEMS` a request) every
 * 20 minutes, about a hundredth of what full polls.
 */
export const OFF_LINKED_INTERVAL_MS = 20 * 60_000;

/**
 * Saving's interval, as a multiple of `delivery_interval`: 5m becomes 15m.
 * Each delivery is one orchestrator turn that reads the batch and hands each
 * line to a subagent, and the nag carries an unresolved subject on every one,
 * so the interval is what the orchestrator spends while things stand still.
 * Three times cuts that by two thirds while an unresolved subject is still
 * said again within a quarter of an hour (a few times an hour against a
 * 5-hour window), so nothing waits long enough to be lost.
 */
export const SAVING_INTERVAL_FACTOR = 3;

/**
 * While this many tasks, or more, are in progress, saving holds the nudges
 * about the other work: the orchestrator has its hands full, and is not to
 * be pushed to start or prod something else. What the work in progress
 * itself says is never held by it.
 */
export const SAVING_BUSY_TASKS = 2;

/**
 * How saving treats a line (`docs/orchestrator.md`, "Saving: state changes
 * and nudges"):
 *
 * - `on_time` — an explicit timer (the person's `[[orchestrator.timers]]`,
 *   the orchestrator's `orchestrator timer set`) or a 待機 task's time
 *   (`task status --check-at`): sent at its time, alone, like the person's
 *   words — in full and saving alike, never batched, never held by the
 *   interval or for triage (`onTime`). What it wakes the orchestrator for
 *   (reading Slack, a thread, someone else's work) has consequences
 *   outside. Off drops it instead: the timers are off with the mode;
 * - `by_person` — caused by the person's own act in the window: their
 *   answer, their words to an agent directly, their request, an agent they
 *   handed over or took back. Sent at once, as a message of its own, in
 *   **every** mode — never batched, held or dropped (with no orchestrator,
 *   it waits for one: `waitsForOrchestrator`);
 * - `obsolete` — a task that may no longer be needed (`task.obsolete`: what
 *   it links closed or merged). Never held: with the next batch in full and
 *   saving, at once and alone while off;
 * - `never_held` — a start (`init`) and a `triage`: they go as in full. A
 *   batch carrying `init` or `triage` takes everything pending and standing
 *   with it;
 * - `state_change` — something happened to work in progress, or to work
 *   waiting on the orchestrator: it goes with the next batch, at saving's
 *   interval, whatever the subject's priority and the tasks in progress;
 * - `nudge` — a reminder or chatter: it goes only when its subject is ranked
 *   high (and, while `SAVING_BUSY_TASKS` or more are in progress, only when
 *   it is about one of them); otherwise it waits, one line per subject, for
 *   the next triage or for full.
 */
export type SavingClass =
	| "by_person"
	| "obsolete"
	| "never_held"
	| "on_time"
	| "state_change"
	| "nudge";

/**
 * Every kind of line the dispatcher handles, finer than the event's type
 * where the class depends on it (`savingKindOf`).
 */
export type SavingKind =
	| "init"
	| "triage"
	| "escalation_answered"
	| "task.human_direct"
	| "request"
	| "agent_managed"
	| "agent_unmanaged"
	| "needs_action task"
	| "needs_action agent no_task"
	| "needs_action item no_task"
	| "needs_action said again"
	| "task.changed subjects_changed"
	| "task.changed due"
	| "task.obsolete"
	| "timer.elapsed timer set"
	| "timer.elapsed settings"
	| "usage.threshold"
	| "custom.*";

/**
 * The classification, explicitly, for every kind: the doc's table is this.
 *
 * - `needs_action task`: an open task newly needing action, or whose state
 *   moved since its line last went — its agents stopped (a turn ended, one
 *   exited or errored), one is on a prompt, its linked item or pull request
 *   moved (merged, closed, review, checks), its questions moved. Whatever
 *   its clause: what the work in progress does is never a mere reminder.
 * - `needs_action agent no_task`: a managed agent bound to no open task —
 *   newly, or with its state moved: work going on outside any task.
 * - `needs_action item no_task`: an item of the population nobody made a
 *   task for — new work, a nudge to take it up.
 * - `needs_action said again`: any `needs_action` subject standing as it
 *   stood when its line last went (the nag: "still idle").
 * - `task.changed subjects_changed`: what a 待機 task is about moved (CI, a
 *   review, a merge, its agents): work waiting on the orchestrator.
 *   `task.changed due`: the time the orchestrator gave it to look again
 *   (`task status --check-at`) came — its own wake-up, on time.
 * - `task.obsolete`: an open task whose linked Issue closed or pull request
 *   merged or closed, seen happen: it may be done (`obsolete`).
 * - `escalation_answered`, `task.human_direct`, `request`, `agent_managed`,
 *   `agent_unmanaged`: the person's own acts (`by_person`).
 * - `timer.elapsed timer set`: a timer the orchestrator set itself
 *   (`orchestrator timer set`, `source: "session"`): its own wake-up ("look
 *   at Slack at 15:00", "re-read the thread in 30 minutes"), on time.
 * - `timer.elapsed settings`: one of the person's `[[orchestrator.timers]]`
 *   (what they set the orchestrator to do on a clock: read Slack, look at a
 *   thread), on time. `usage.threshold`: the plan's use,
 *   status. `custom.*`: what a script says, not DevHub's to judge.
 */
export const SAVING_CLASSES: Readonly<Record<SavingKind, SavingClass>> = {
	init: "never_held",
	triage: "never_held",
	escalation_answered: "by_person",
	"task.human_direct": "by_person",
	request: "by_person",
	agent_managed: "by_person",
	agent_unmanaged: "by_person",
	"task.obsolete": "obsolete",
	"needs_action task": "state_change",
	"needs_action agent no_task": "state_change",
	"needs_action item no_task": "nudge",
	"needs_action said again": "nudge",
	"task.changed subjects_changed": "state_change",
	"task.changed due": "on_time",
	"timer.elapsed timer set": "on_time",
	"timer.elapsed settings": "on_time",
	"usage.threshold": "nudge",
	"custom.*": "nudge",
};

/**
 * A line's kind. `saidAgain`: a `needs_action` line whose subject stands as
 * it did when its line last went (nothing about it moved since).
 */
export function savingKindOf(
	event: OrchestratorEvent,
	saidAgain = false,
): SavingKind {
	switch (event.type) {
		case "init":
		case "triage":
		case "escalation_answered":
		case "task.human_direct":
		case "request":
		case "agent_managed":
		case "agent_unmanaged":
		case "usage.threshold":
		case "task.obsolete":
			return event.type;
		case "timer.elapsed":
			return event.source === "session"
				? "timer.elapsed timer set"
				: "timer.elapsed settings";
		case "needs_action":
			if (saidAgain) return "needs_action said again";
			if (event.subject.kind === "task") return "needs_action task";
			if (event.subject.kind === "agent") return "needs_action agent no_task";
			return "needs_action item no_task";
		case "task.changed":
			return event.reasons.includes("due")
				? "task.changed due"
				: "task.changed subjects_changed";
		default:
			return "custom.*";
	}
}

export function savingClassOf(
	event: OrchestratorEvent,
	saidAgain = false,
): SavingClass {
	return SAVING_CLASSES[savingKindOf(event, saidAgain)];
}

/**
 * A wake-up the orchestrator set itself, whatever else the line says (a
 * task's `due` folded with `subjects_changed` included): sent on time.
 */
export function onTime(event: OrchestratorEvent): boolean {
	return savingClassOf(event) === "on_time";
}

/** Caused by the person's own act: at once, in every mode (`by_person`). */
export function byPerson(event: OrchestratorEvent): boolean {
	return savingClassOf(event) === "by_person";
}

/**
 * What goes while off, and how: `at_once` — the person's acts and a task
 * that may no longer be needed, each as a message of its own; `dropped` —
 * the timers, which are off with the mode; `held` — everything else, until
 * the mode turns on. A `task.changed` carrying `due` is the timers' (its
 * `due` is dropped, its `subjects_changed` held: `offDrops`).
 */
export function goesWhileOff(
	event: OrchestratorEvent,
): "at_once" | "held" | "dropped" {
	const kind = savingClassOf(event);
	if (kind === "by_person" || kind === "obsolete") return "at_once";
	if (kind === "on_time") return "dropped";
	return "held";
}

/** Why saving holds a line now: not high, or the hands are full. */
export type SavingHold = "not_high" | "busy";

/**
 * Whether saving holds a line now, and why; undefined: it goes (with the
 * next batch, at saving's interval).
 *
 * - `by_person`, `obsolete`, `never_held`, `on_time` and `state_change`
 *   lines are never held (a `by_person` or `on_time` one does not wait for
 *   a batch at all: `isHumanInput`, `onTime`).
 * - A `nudge` is held when its subject is not ranked `high`, and — while
 *   `tasks` is `SAVING_BUSY_TASKS` or more — when it is about work that is
 *   not in progress (starting or pushing other work).
 */
export function savingHolds(line: {
	readonly class: SavingClass;
	readonly high: boolean;
	/** Its subject is one of the tasks in progress (処理中). */
	readonly inProgress: boolean;
	readonly tasks: number;
}): SavingHold | undefined {
	if (line.class !== "nudge") return undefined;
	if (line.tasks >= SAVING_BUSY_TASKS && !line.inProgress) return "busy";
	return line.high ? undefined : "not_high";
}

/** A window at or over the threshold: why saving was entered automatically. */
export interface UsageOver {
	readonly cli: string;
	readonly window: string;
	readonly usedPercent: number;
	readonly threshold: number;
	readonly resetsAt?: number;
}

/**
 * The window most over `threshold` now, if any: the highest use, in its
 * current period (one whose reset has passed is the last period's, and says
 * nothing).
 */
export function usageOver(
	limits: UsageLimitsWire,
	threshold: number,
	now: number,
): UsageOver | undefined {
	let best: UsageOver | undefined;
	for (const one of limits.clis)
		for (const window of one.windows ?? []) {
			const used = window.usedPercent;
			if (used === undefined || used < threshold) continue;
			if (window.resetsAt !== undefined && window.resetsAt <= now) continue;
			if (best !== undefined && best.usedPercent >= used) continue;
			best = {
				cli: one.cli,
				window: window.window,
				usedPercent: used,
				threshold,
				...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
			};
		}
	return best;
}

/** What moved the mode, for the notice and the log. */
export type ModeChange =
	| {
			readonly by: "person";
			readonly from: OrchestratorMode;
			readonly to: OrchestratorMode;
	  }
	| {
			readonly by: "usage";
			readonly from: OrchestratorMode;
			readonly to: OrchestratorMode;
			/** Into saving: the window over. Back to full: absent. */
			readonly over?: UsageOver;
	  };

export class OrchestratorModeControl {
	#mode: OrchestratorMode;
	/** Saving entered automatically, and the window that did it. */
	#auto: UsageOver | undefined;
	/** The person left saving for full while over: not undone until under. */
	#heldFull = false;

	constructor(initial: OrchestratorMode = LAUNCH_MODE) {
		this.#mode = initial;
	}

	get mode(): OrchestratorMode {
		return this.#mode;
	}

	/** Why saving is in force, when it was entered automatically. */
	get auto(): UsageOver | undefined {
		return this.#auto;
	}

	/**
	 * The person chose `mode`, with `over` the readout's window over the
	 * threshold now (if any). Every change it makes, in order: the choice,
	 * then — full chosen from off while a window is over — saving.
	 */
	choose(
		mode: OrchestratorMode,
		over: UsageOver | undefined,
	): readonly ModeChange[] {
		const from = this.#mode;
		this.#auto = undefined;
		this.#heldFull = mode === "full" && from === "saving" && over !== undefined;
		const changes: ModeChange[] = [];
		if (from !== mode) {
			this.#mode = mode;
			changes.push({ by: "person", from, to: mode });
		}
		const auto = this.observe(over);
		if (auto !== undefined) changes.push(auto);
		return changes;
	}

	/**
	 * The readout moved (or the threshold, or a reset passed): `over` is the
	 * window over the threshold now, if any. The change it makes, if one.
	 */
	observe(over: UsageOver | undefined): ModeChange | undefined {
		if (over === undefined) {
			this.#heldFull = false;
			if (this.#mode !== "saving" || this.#auto === undefined) return undefined;
			this.#auto = undefined;
			this.#mode = "full";
			return { by: "usage", from: "saving", to: "full" };
		}
		if (this.#mode === "saving" && this.#auto !== undefined) {
			this.#auto = over;
			return undefined;
		}
		if (this.#mode !== "full" || this.#heldFull) return undefined;
		this.#mode = "saving";
		this.#auto = over;
		return { by: "usage", from: "full", to: "saving", over };
	}
}

/** A window's name as a notice says it: `Claude's 5-hour window`. */
export function windowWords(over: Pick<UsageOver, "cli" | "window">): string {
	const cli =
		over.cli === "claude"
			? "Claude"
			: over.cli === "codex"
				? "Codex"
				: over.cli;
	return `${cli}'s ${over.window} window`;
}

/**
 * The notice an automatic switch into saving puts up, saying why and what
 * comes next; undefined for any other change (nothing to explain).
 */
export function savingNotice(change: ModeChange): string | undefined {
	if (change.by !== "usage" || change.over === undefined) return undefined;
	const over = change.over;
	return `Orchestrator switched to saving: ${windowWords(over)} is at ${String(Math.round(over.usedPercent))}% (saving_threshold ${String(over.threshold)}%). What happens to the work in progress still comes, less often; reminders wait for the hourly triage unless high. It goes back to full when the window resets.`;
}

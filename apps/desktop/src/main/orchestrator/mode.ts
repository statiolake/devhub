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
 *   its item's pull request or checks moved, a wait that may be ready — goes
 *   with every batch, whatever its priority and however many tasks are in
 *   progress; a nudge (a subject said again with nothing new, an item nobody
 *   started, a settings timer, the usage readout, `custom.*`) goes only when
 *   its subject is ranked high, and while `SAVING_BUSY_TASKS` or more tasks
 *   are in progress only when it is about one of them (`savingHolds`). The
 *   person's words, requests, `init` and `triage` are never held, and a
 *   wake-up the orchestrator set itself (`orchestrator timer set`, a wait's
 *   `--at`) goes at its time, alone, as in full (`onTime`).
 * - **off** holds everything, the person's words too, and GitHub is not
 *   polled: what the Events switch's off was.
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
 * - `on_time` — a wake-up the orchestrator set itself (`orchestrator timer
 *   set`, `escalation wait --at`): sent at its time, alone, like the
 *   person's words — in full and saving alike, never batched, never held by
 *   the interval or for triage (`onTime`). What it wakes the orchestrator
 *   for (Slack, a thread, someone else's work) has consequences outside;
 * - `never_held` — the person's words, their requests, a start (`init`) and
 *   a `triage`: they go as in full. A batch carrying `init` or `triage`
 *   takes everything pending and standing with it;
 * - `state_change` — something happened to work in progress, or to work
 *   waiting on the orchestrator: it goes with the next batch, at saving's
 *   interval, whatever the subject's priority and the tasks in progress;
 * - `nudge` — a reminder or chatter: it goes only when its subject is ranked
 *   high (and, while `SAVING_BUSY_TASKS` or more are in progress, only when
 *   it is about one of them); otherwise it waits, one line per subject, for
 *   the next triage or for full.
 */
export type SavingClass = "never_held" | "on_time" | "state_change" | "nudge";

/**
 * Every kind of line the dispatcher handles, finer than the event's type
 * where the class depends on it (`savingKindOf`).
 */
export type SavingKind =
	| "init"
	| "triage"
	| "escalation_answered"
	| "escalation.human_direct"
	| "request"
	| "needs_action agent"
	| "needs_action item idle_no_escalation"
	| "needs_action item no_agent"
	| "needs_action said again"
	| "waiting.changed subjects_changed"
	| "waiting.changed due"
	| "timer.elapsed timer set"
	| "timer.elapsed settings"
	| "usage.threshold"
	| "custom.*";

/**
 * The classification, explicitly, for every kind: the doc's table is this.
 *
 * - `needs_action agent`: a managed agent newly needing action, or whose
 *   state moved since its line last went — it stopped (its turn ended, it
 *   exited, it errored), it is on a prompt (a question, a permission), its
 *   item or pull request moved (merged, closed, unassigned, review, checks),
 *   its escalation moved. Whatever its clause: what the agent itself does is
 *   never a mere reminder.
 * - `needs_action item idle_no_escalation`: an item whose agents have all
 *   stopped, newly or with its state moved (the same, seen from the item).
 * - `needs_action item no_agent`: an item nobody has started — new work, a
 *   nudge to start it.
 * - `needs_action said again`: any `needs_action` subject standing as it
 *   stood when its line last went (the nag: "still idle").
 * - `waiting.changed subjects_changed`: what a 待機中 escalation is about
 *   moved (CI, a review, a merge, its agents): work waiting on the
 *   orchestrator. `waiting.changed due`: the time the orchestrator set for it
 *   (`escalation wait --at`) came — its own wake-up, on time.
 * - `timer.elapsed timer set`: a timer the orchestrator set itself
 *   (`orchestrator timer set`, `source: "session"`): its own wake-up ("look
 *   at Slack at 15:00", "re-read the thread in 30 minutes"), on time.
 * - `timer.elapsed settings`: one of `[[orchestrator.timers]]`, a periodic
 *   re-prompt. `usage.threshold`: the plan's use,
 *   status. `custom.*`: what a script says, not DevHub's to judge.
 */
export const SAVING_CLASSES: Readonly<Record<SavingKind, SavingClass>> = {
	init: "never_held",
	triage: "never_held",
	escalation_answered: "never_held",
	"escalation.human_direct": "never_held",
	request: "never_held",
	"needs_action agent": "state_change",
	"needs_action item idle_no_escalation": "state_change",
	"needs_action item no_agent": "nudge",
	"needs_action said again": "nudge",
	"waiting.changed subjects_changed": "state_change",
	"waiting.changed due": "on_time",
	"timer.elapsed timer set": "on_time",
	"timer.elapsed settings": "nudge",
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
		case "escalation.human_direct":
		case "request":
		case "usage.threshold":
			return event.type;
		case "timer.elapsed":
			return event.source === "session"
				? "timer.elapsed timer set"
				: "timer.elapsed settings";
		case "needs_action":
			if (saidAgain) return "needs_action said again";
			if (event.subject.kind === "agent") return "needs_action agent";
			return event.breach.clause === "no_agent"
				? "needs_action item no_agent"
				: "needs_action item idle_no_escalation";
		case "waiting.changed":
			return event.reasons.includes("due")
				? "waiting.changed due"
				: "waiting.changed subjects_changed";
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
 * wait's `due` folded with `subjects_changed` included): sent on time.
 */
export function onTime(event: OrchestratorEvent): boolean {
	return savingClassOf(event) === "on_time";
}

/** Why saving holds a line now: not high, or the hands are full. */
export type SavingHold = "not_high" | "busy";

/**
 * Whether saving holds a line now, and why; undefined: it goes (with the
 * next batch, at saving's interval).
 *
 * - `never_held`, `on_time` and `state_change` lines are never held (an
 *   `on_time` one does not wait for a batch at all: `onTime`).
 * - A `nudge` is held when its subject is not ranked `high`, and — while
 *   `tasks` is `SAVING_BUSY_TASKS` or more — when it is about work that is
 *   not in progress (starting or pushing other work).
 */
export function savingHolds(line: {
	readonly class: SavingClass;
	readonly high: boolean;
	/** Its subject is one of the tasks in progress (対応中). */
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

/**
 * The Orchestrator's mode: **full**, **saving** or **off**
 * (`docs/orchestrator.md`, "Modes: full, saving, off").
 *
 * - **full** delivers as DevHub always has: a batch at most once per
 *   `delivery_interval`, each carrying every `needs_action` subject again.
 * - **saving** delivers the same things more rarely: a batch at most once per
 *   `SAVING_INTERVAL_FACTOR` × `delivery_interval`, and **no batch at all**
 *   while two or more tasks are in progress (`inProgressCount`, the Sidebar's
 *   対応中 heading). The person's words and `init` are not nudges and are
 *   never held by it.
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

/** Saving holds every nudge while this many tasks, or more, are in progress. */
export const SAVING_BUSY_TASKS = 2;

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
	return `Orchestrator switched to saving: ${windowWords(over)} is at ${String(Math.round(over.usedPercent))}% (saving_threshold ${String(over.threshold)}%). Nudges come less often, and none while 2 or more tasks are in progress. It goes back to full when the window resets.`;
}

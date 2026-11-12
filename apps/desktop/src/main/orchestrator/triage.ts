/**
 * Triage (`docs/orchestrator.md`, "Triage: priorities"): on a schedule
 * DevHub asks the orchestrator to look at every open task again — still
 * true? still worth doing? how high? — with the ones DevHub marks as maybe
 * stale (`staleness.ts`) and why, and the orchestrator records each task's
 * priority on the task itself (`devhub --tell task edit T --priority
 * high|normal|low`).
 *
 * **The schedule.** A `triage` event every `TRIAGE_INTERVAL_MS` in full and
 * `SAVING_TRIAGE_INTERVAL_MS` in saving, counted from the last one (or from
 * when the mode went on: `init` already has the orchestrator read the
 * board). Never while off.
 *
 * **Saving's gate** (`mode.ts`, `SAVING_CLASSES`). In saving a state change
 * about a task goes with every batch whatever its priority; a **nudge** (a
 * subject said again unchanged, an item nobody made a task for, the usage
 * readout, `custom.*`) goes only when its task is ranked **high** — and,
 * while two or more tasks are 処理中, only when it is about one of them.
 * Every other nudge stays pending until a batch carrying `triage` — which
 * takes everything pending and standing with it — or until the mode is
 * full.
 */

import type { OrchestratorMode } from "./mode.js";

/**
 * Full's triage interval. A triage is the heaviest turn the orchestrator
 * takes — it reads the board and every subject's state, and ranks them all —
 * so it is a few times rarer than the nag (5 minutes by default): twice an
 * hour keeps the ranking within half an hour of what happened, which is as
 * often as the work it ranks (agents' turns, reviews, CI) tends to change.
 */
export const TRIAGE_INTERVAL_MS = 30 * 60_000;

/**
 * Saving's: once an hour. Saving holds every nudge that is not about a
 * high subject until the next triage, so this is also how long a low nudge
 * waits at most; an hour is a fifth of the 5-hour window, and keeps triage itself
 * to a handful of turns per window.
 */
export const SAVING_TRIAGE_INTERVAL_MS = 60 * 60_000;

export function triageIntervalMs(mode: OrchestratorMode): number | undefined {
	return mode === "full"
		? TRIAGE_INTERVAL_MS
		: mode === "saving"
			? SAVING_TRIAGE_INTERVAL_MS
			: undefined;
}

/** When the next triage is due, counted from `anchor`; never while off. */
export function nextTriageAt(
	mode: OrchestratorMode,
	anchor: number | undefined,
): number | undefined {
	const interval = triageIntervalMs(mode);
	return interval === undefined || anchor === undefined
		? undefined
		: anchor + interval;
}

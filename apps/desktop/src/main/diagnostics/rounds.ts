/**
 * How often each machine is being reconciled, counted where the loop runs.
 *
 * `activityCounters` already counts rounds, but it counts them for the process
 * as a whole, and "DevHub ran nine hundred rounds a minute" stops being an
 * answer the moment two of those machines are on different links. The question
 * `devhub --metrics` has to answer for a remote DevHub is per machine: how
 * often is this host asked, and what does one round of it cost — and the
 * second is the first divided into the runtime's own exec count.
 *
 * It is a rolling minute rather than a total, because a cadence is a rate and
 * a total since launch answers a question nobody asks. Reading it is
 * non-destructive, for the same reason `ActivityCounters.read` is: two readers
 * must not take the answer away from each other.
 */

import type { RuntimeId } from "../runtime/runtime.js";

const A_MINUTE = 60_000;

export class ReconcileRounds {
	readonly #at = new Map<RuntimeId, number[]>();
	readonly #clock: () => number;

	constructor(clock: () => number = Date.now) {
		this.#clock = clock;
	}

	record(id: RuntimeId): void {
		const at = this.#at.get(id) ?? [];
		at.push(this.#clock());
		this.#at.set(id, at);
	}

	/** Rounds this machine completed in the last minute. */
	lastMinute(id: RuntimeId): number {
		const since = this.#clock() - A_MINUTE;
		const at = (this.#at.get(id) ?? []).filter((when) => when >= since);
		this.#at.set(id, at);
		return at.length;
	}
}

/**
 * The process's one register, for the same reason the counters have one: the
 * loop that records is three layers below anything that could hand it a
 * dependency. Tests construct their own and never touch this.
 */
export const reconcileRounds = new ReconcileRounds();

/**
 * What made a repository round happen.
 *
 * There are four ways a Workspace's branch, dirty flag, pull request and Issue
 * get looked at again, and until this existed a person watching a row go stale
 * had no way to tell which of them had last fired — "the sidebar feels slow"
 * and "the poll is the only thing that ever runs" are the same observation
 * until the reading says which trigger it was.
 *
 * `poll` is the clock a minute, `head` is git writing `HEAD` under a checkout,
 * `focus` is the window coming back to the front, and `manual` is somebody
 * pressing the refresh chord.
 */
export type RepositoryRoundTrigger = "poll" | "head" | "focus" | "manual";

/** One Workspace's last full round, for `devhub --metrics`. */
export interface WorkspaceRepositoryRound {
	readonly workspaceId: string;
	readonly lastRepositoryRound: {
		readonly at: string;
		readonly trigger: RepositoryRoundTrigger;
	};
}

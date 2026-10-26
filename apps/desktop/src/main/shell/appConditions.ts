/**
 * Every standing condition that holds right now, one entry per source.
 *
 * A source — the repository watcher, one machine — says what holds as often
 * as it looks, and what it says is about *its own* entry and no other: a
 * repository look that succeeds takes the repository's condition down, not a
 * machine's. So the conditions are a set keyed by source, raising replaces
 * only that source's entry and retracting removes only that source's.
 *
 * Only a change reaches the page. A source that says the same thing again, or
 * retracts what it never raised, has nothing new to tell, and the page that
 * draws the notices hears it once. When that page comes (back) up it is told
 * the whole set, because a condition that went up before it listened still
 * holds.
 */

import type { AppConditionWire } from "../../ipc/contract.js";

export class AppConditions {
	/** Source → what holds. */
	readonly #active = new Map<string, string>();
	readonly #send: (condition: AppConditionWire) => void;

	constructor(send: (condition: AppConditionWire) => void) {
		this.#send = send;
	}

	/** The sources whose condition holds, for diagnostics and tests. */
	get active(): ReadonlyMap<string, string> {
		return this.#active;
	}

	/** What `source` says now; `undefined` is the source retracting its own. */
	observe(source: string, summary: string | undefined): void {
		if (summary === undefined) {
			if (this.#active.delete(source)) this.#send({ source });
			return;
		}
		if (this.#active.get(source) === summary) return;
		this.#active.set(source, summary);
		this.#send({ source, summary });
	}

	/** The page that draws them is listening: everything that holds, again. */
	replay(): void {
		for (const [source, summary] of this.#active) {
			this.#send({ source, summary });
		}
	}
}

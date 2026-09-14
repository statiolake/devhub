/**
 * Whether a machine is answering, said once per episode and not once per round.
 *
 * A machine-wide reconcile round is a loop: one round per cadence tick, for as
 * long as that machine has Agents on it. So "the round failed" is not an event
 * a person can be told about — it is a *condition*, re-observed a second at a
 * time, and telling them each time is how one unreachable host became a notice
 * that appeared, was cleared by the next thing they clicked (a failure is
 * retired by the person's next action — `shell/alertLifetime.ts`), and came
 * back a round later. That is the flapping the owner saw, and the reflow with
 * it: the notice was published as a failure, so it could not stay, and it was
 * republished every round, so it could not go.
 *
 * Both halves are wrong in the same way, and this is the one fix for both: a
 * condition is *raised once* when an episode of failure starts and *retracted
 * once* when the machine has really come back. Nothing in between reaches the
 * screen. A round that fails while the condition is already up is the same
 * condition still holding — not news — and a single round that succeeds is not
 * a recovery either: an ssh master that is half dead answers one round in
 * three, and retracting on the first of them would put the notice back on the
 * next, which is flapping again with extra steps.
 *
 * So a retraction needs a *sustained* recovery: `successesToRetract`
 * consecutive rounds that answered, and at least `minimumAgeMs` since the
 * condition went up, so a notice cannot be gone before it can be read.
 *
 * The episode keeps the words of its *first* round. A later round that fails
 * differently is the same host still not answering, and swapping the sentence
 * would change the notice's identity — which the notice stack reads as one
 * condition ending and another beginning, i.e. a remove and an add, i.e. the
 * flicker this module exists to make impossible. The differing reason still
 * goes to the log, where a second reason is worth having.
 */

import type { RuntimeId } from "../runtime/runtime.js";

/** How a machine's condition is named, so one machine has one slot. */
export function machineConditionSource(machine: RuntimeId): string {
	return `machine:${machine}`;
}

export interface MachineConditionsOptions {
	/**
	 * Where a raise and a retraction go. Called only on a change: once when an
	 * episode starts, once when it ends, and never in between.
	 */
	readonly publish: (source: string, summary: string | undefined) => void;
	/** Consecutive answered rounds a recovery needs. */
	readonly successesToRetract?: number;
	/** How long a raised condition stays up at the very least. */
	readonly minimumAgeMs?: number;
	readonly now?: () => number;
}

interface Episode {
	/** The first round's words; the whole episode is said in them. */
	readonly summary: string;
	readonly raisedAt: number;
	successes: number;
}

const SUCCESSES_TO_RETRACT = 2;
const MINIMUM_AGE_MS = 5_000;

export class MachineConditions {
	readonly #episodes = new Map<RuntimeId, Episode>();
	readonly #publish: MachineConditionsOptions["publish"];
	readonly #successesToRetract: number;
	readonly #minimumAgeMs: number;
	readonly #now: () => number;

	constructor(options: MachineConditionsOptions) {
		this.#publish = options.publish;
		this.#successesToRetract =
			options.successesToRetract ?? SUCCESSES_TO_RETRACT;
		this.#minimumAgeMs = options.minimumAgeMs ?? MINIMUM_AGE_MS;
		this.#now = options.now ?? Date.now;
	}

	/** The machines whose condition is up right now, for `devhub --metrics`. */
	get raised(): readonly RuntimeId[] {
		return [...this.#episodes.keys()];
	}

	/** A round against this machine did not get its answer. */
	failed(machine: RuntimeId, summary: string): void {
		const episode = this.#episodes.get(machine);
		if (episode) {
			// Still the same episode: the count of answered rounds starts again,
			// and the sentence on screen does not move.
			episode.successes = 0;
			return;
		}
		this.#episodes.set(machine, {
			summary,
			raisedAt: this.#now(),
			successes: 0,
		});
		this.#publish(machineConditionSource(machine), summary);
	}

	/** A round against this machine got its answer. */
	succeeded(machine: RuntimeId): void {
		const episode = this.#episodes.get(machine);
		if (!episode) return;
		episode.successes += 1;
		if (episode.successes < this.#successesToRetract) return;
		if (this.#now() - episode.raisedAt < this.#minimumAgeMs) return;
		this.#episodes.delete(machine);
		this.#publish(machineConditionSource(machine), undefined);
	}

	/**
	 * The machine is gone from the model — its last Workspace closed, its loop
	 * stopped. Nothing will ask it again, so a standing condition about it
	 * would never be retracted by anything: it is retracted here instead.
	 */
	forget(machine: RuntimeId): void {
		if (!this.#episodes.delete(machine)) return;
		this.#publish(machineConditionSource(machine), undefined);
	}
}

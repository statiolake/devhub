/**
 * The loop that keeps DevHub's Agents true.
 *
 * A port of the Tauri app's `devhub-agent-reconciler` thread. tmux is not a
 * thing DevHub can be told about: nothing pushes a session's death, and the
 * only authoritative answer is the session list taken now. So the one honest
 * way to know an Agent's status — and the only way to learn that it exited —
 * is to keep asking, for as long as there is an Agent to ask about.
 *
 * Nothing else reconciles on its own. Making this the single cadence is the
 * point: with two of them, a status would be right for one reason here and a
 * different reason there, and a row stuck on "Starting runtime" would be a
 * question about which of the two was supposed to have moved it.
 *
 * The loop never overlaps itself. A round runs to its answer before the next
 * one is scheduled, because a reconcile that is superseded while it is in
 * flight is a reconcile whose answer is thrown away — repeat that every tick
 * and no answer ever lands.
 */

/** What the Tauri reconciler slept between rounds. */
export const AGENT_RECONCILE_INTERVAL_MS = 300;

export interface AgentReconcilerOptions {
	/** Whether there is anything to reconcile. No Agents, no provider traffic. */
	readonly hasAgents: () => boolean;
	/** One round. It resolves when the model has the provider's answer. */
	readonly reconcile: () => Promise<void>;
	/** Where a round's failure goes. There is no other reader for it. */
	readonly onFailure: (error: unknown) => void;
	readonly intervalMs?: number;
}

export class AgentReconciler {
	readonly #options: AgentReconcilerOptions;
	readonly #intervalMs: number;
	#started = false;
	#stopped = false;
	#wake: (() => void) | undefined;

	constructor(options: AgentReconcilerOptions) {
		this.#options = options;
		this.#intervalMs = options.intervalMs ?? AGENT_RECONCILE_INTERVAL_MS;
	}

	/** Idempotent: the loop exists once for the life of the process. */
	start(): void {
		if (this.#started || this.#stopped) return;
		this.#started = true;
		// The loop has no caller, so a rejection escaping it has no reader but
		// the process's `unhandledRejection` — a warning on stderr that nothing
		// in DevHub can show and nothing in DevHub can act on. Rounds already
		// report themselves; this catches the loop *itself* dying, which is a
		// different and worse fact, and says so.
		void this.#run().catch((error: unknown) => {
			this.#options.onFailure(
				new Error("the Agent reconciler loop stopped", { cause: error }),
			);
		});
	}

	/**
	 * Ask for the next round now instead of at the end of the interval.
	 *
	 * The adapter says this when it has seen something on its own — an attach
	 * that read a status, a control stream that died. It is a hint about *when*,
	 * never a second way of learning *what*: the round that follows is the same
	 * round the interval would have run.
	 */
	wake(): void {
		this.#wake?.();
	}

	stop(): void {
		this.#stopped = true;
		this.#wake?.();
	}

	async #run(): Promise<void> {
		while (!this.#stopped) {
			if (this.#options.hasAgents()) {
				try {
					await this.#options.reconcile();
				} catch (error) {
					// A round that failed is a fact about the provider, and it goes
					// where every other failure goes. The loop keeps running: the
					// next snapshot is how a provider outage stops being one.
					this.#options.onFailure(error);
				}
			}
			await this.#sleep();
		}
	}

	#sleep(): Promise<void> {
		return new Promise<void>((resolve) => {
			let settled = false;
			const finish = (): void => {
				if (settled) return;
				settled = true;
				this.#wake = undefined;
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(finish, this.#intervalMs);
			// Reconciling Agents must never be the reason the process stays alive.
			(timer as unknown as { unref?: () => void }).unref?.();
			this.#wake = finish;
		});
	}
}

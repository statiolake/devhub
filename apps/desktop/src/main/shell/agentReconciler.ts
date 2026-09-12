/**
 * The loop that keeps DevHub's Agents true.
 *
 * A port of the Tauri app's `devhub-agent-reconciler` thread. tmux is not a
 * thing DevHub can be told about: nothing pushes a session's death, and the
 * only authoritative answer is the session list taken now. So the one honest
 * way to know an Agent's status — and the only way to learn that it exited —
 * is to keep asking, for as long as there is an Agent to ask about.
 *
 * There is one loop per machine, and nothing else reconciles on its own. One
 * loop per machine rather than one loop, because a cadence is a fact about a
 * link: a host across an ocean must not slow this Mac's Agents down, and a
 * single loop asking two machines would have to pick one number for both. One
 * loop per machine rather than one per Agent, for the reason there was one
 * loop at all: with two cadences over the same tmux server, a status would be
 * right for one reason here and a different reason there, and a row stuck on
 * "Starting runtime" would be a question about which of the two was supposed
 * to have moved it.
 *
 * The interval is read from the runtime *every* sleep rather than captured at
 * construction, because a remote runtime recomputes it from the round trips it
 * has just measured (`runtime/cadence.ts`). A loop that read it once would
 * hold the cadence of the first sixteen commands for the life of the process.
 *
 * The loop never overlaps itself. A round runs to its answer before the next
 * one is scheduled, because a reconcile that is superseded while it is in
 * flight is a reconcile whose answer is thrown away — repeat that every tick
 * and no answer ever lands.
 */

import { activityCounters, COUNTER } from "../diagnostics/counters.js";
import { reconcileRounds } from "../diagnostics/rounds.js";
import type { Runtime, RuntimeId } from "../runtime/runtime.js";

/** The part of a `Runtime` a loop over it reads. */
export type ReconcileHost = Pick<Runtime, "id" | "cadence">;

export interface AgentReconcilerOptions {
	/** The machine this loop asks about, and what it is allowed to cost. */
	readonly host: ReconcileHost;
	/** Whether there is anything to reconcile. No Agents, no provider traffic. */
	readonly hasAgents: () => boolean;
	/** One round. It resolves when the model has the provider's answer. */
	readonly reconcile: () => Promise<void>;
	/** Where a round's failure goes. There is no other reader for it. */
	readonly onFailure: (error: unknown) => void;
}

export class AgentReconciler {
	readonly #options: AgentReconcilerOptions;
	#started = false;
	#stopped = false;
	#wake: (() => void) | undefined;

	constructor(options: AgentReconcilerOptions) {
		this.#options = options;
	}

	get runtimeId(): RuntimeId {
		return this.#options.host.id;
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
					activityCounters.record(COUNTER.agentReconcileRound);
					reconcileRounds.record(this.#options.host.id);
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
			const timer = setTimeout(
				finish,
				this.#options.host.cadence.reconcileIntervalMs,
			);
			// Reconciling Agents must never be the reason the process stays alive.
			(timer as unknown as { unref?: () => void }).unref?.();
			this.#wake = finish;
		});
	}
}

/**
 * One reconciler loop per machine that has Agents on it, and no others.
 *
 * A loop exists while its machine has something to reconcile and stops when it
 * does not, because a loop is a cost: an idle ssh runtime with no Agents left
 * on it would go on paying a round trip a second to be told there is nothing
 * there. `follow` is called whenever the model changes, and it is idempotent —
 * it is the only place a loop is started or stopped, so "which loops exist" has
 * one answer and not one per caller.
 */
export class AgentReconcilers {
	readonly #loops = new Map<RuntimeId, AgentReconciler>();
	readonly #reconcile: (host: ReconcileHost) => Promise<void>;
	readonly #onFailure: (error: unknown) => void;
	#stopped = false;

	constructor(options: {
		/** One round against one machine. */
		readonly reconcile: (host: ReconcileHost) => Promise<void>;
		readonly onFailure: (error: unknown) => void;
	}) {
		this.#reconcile = options.reconcile;
		this.#onFailure = options.onFailure;
	}

	/**
	 * Make the running loops exactly the ones these machines need.
	 *
	 * `hosts` is the machines with at least one Agent on them right now. A
	 * machine that gained its first Agent gets a loop and its first round
	 * immediately; one that lost its last Agent has its loop stopped rather
	 * than left spinning on `hasAgents` for the life of the process.
	 */
	follow(hosts: readonly ReconcileHost[]): void {
		if (this.#stopped) return;
		const wanted = new Map(hosts.map((host) => [host.id, host] as const));
		for (const [id, loop] of this.#loops) {
			if (wanted.has(id)) continue;
			loop.stop();
			this.#loops.delete(id);
		}
		for (const [id, host] of wanted) {
			if (this.#loops.has(id)) continue;
			const loop: AgentReconciler = new AgentReconciler({
				host,
				// The loop's own gate is "does this machine still have Agents",
				// and `follow` has just answered it. It is asked again each round
				// because the model moves between rounds, and a round against a
				// machine whose last Agent has gone is a round for nothing.
				hasAgents: (): boolean => this.#loops.get(id) === loop,
				reconcile: () => this.#reconcile(host),
				onFailure: this.#onFailure,
			});
			this.#loops.set(id, loop);
			loop.start();
		}
	}

	/** Ask every live loop for its next round now. */
	wake(): void {
		for (const loop of this.#loops.values()) loop.wake();
	}

	stop(): void {
		this.#stopped = true;
		for (const loop of this.#loops.values()) loop.stop();
		this.#loops.clear();
	}
}

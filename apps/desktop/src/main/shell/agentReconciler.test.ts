import { describe, expect, it } from "vitest";
import { AgentReconciler, AgentReconcilers } from "./agentReconciler.js";
import type { ReconcileHost } from "./agentReconciler.js";
import type { RuntimeCadence, RuntimeId } from "../runtime/runtime.js";

/** A machine whose loop sleeps for no time at all. */
function host(id: RuntimeId, reconcileIntervalMs = 0): ReconcileHost {
	const cadence: RuntimeCadence = {
		reconcileIntervalMs,
		repositoryPollMs: 60_000,
		headWatchPollMs: undefined,
	};
	return { id, cadence };
}

const instant = host("local");

/** A round that resolves when the test says so. */
function deferred(): {
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: unknown) => void;
} {
	let resolve: () => void = () => undefined;
	let reject: (error: unknown) => void = () => undefined;
	const promise = new Promise<void>((settle, fail) => {
		resolve = settle;
		reject = fail;
	});
	return { promise, resolve, reject };
}

async function until(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error("the reconciler never reached the expected state");
		}
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

describe("the agent reconciler", () => {
	it("keeps asking while there are agents, and stops when told to", async () => {
		let rounds = 0;
		const reconciler = new AgentReconciler({
			host: instant,
			hasAgents: () => true,
			reconcile: () => {
				rounds += 1;
				return Promise.resolve();
			},
			onFailure: () => {
				throw new Error("no round failed");
			},
		});
		reconciler.start();
		await until(() => rounds >= 3);
		reconciler.stop();
		const seen = rounds;
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(rounds).toBe(seen);
	});

	it("asks nothing while there is no agent", async () => {
		let rounds = 0;
		const reconciler = new AgentReconciler({
			host: instant,
			hasAgents: () => false,
			reconcile: () => {
				rounds += 1;
				return Promise.resolve();
			},
			onFailure: () => undefined,
		});
		reconciler.start();
		await new Promise((resolve) => setTimeout(resolve, 20));
		reconciler.stop();
		expect(rounds).toBe(0);
	});

	it("never runs a round while the previous one is still in flight", async () => {
		let started = 0;
		const first = deferred();
		const reconciler = new AgentReconciler({
			host: instant,
			hasAgents: () => true,
			reconcile: () => {
				started += 1;
				return started === 1 ? first.promise : Promise.resolve();
			},
			onFailure: () => undefined,
		});
		reconciler.start();
		await until(() => started === 1);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(started).toBe(1);
		first.resolve();
		await until(() => started >= 2);
		reconciler.stop();
	});

	it("reports a failed round and keeps going", async () => {
		let rounds = 0;
		const failures: unknown[] = [];
		const reconciler = new AgentReconciler({
			host: instant,
			hasAgents: () => true,
			reconcile: () => {
				rounds += 1;
				return rounds === 1
					? Promise.reject(new Error("the provider is unreachable"))
					: Promise.resolve();
			},
			onFailure: (error) => failures.push(error),
		});
		reconciler.start();
		await until(() => rounds >= 2);
		reconciler.stop();
		expect(failures).toHaveLength(1);
		expect((failures[0] as Error).message).toBe("the provider is unreachable");
	});

	it("runs the next round early when the adapter says it saw something", async () => {
		let rounds = 0;
		const reconciler = new AgentReconciler({
			// Long enough that a round inside the test's own patience can only be
			// the wake-up, never the interval.
			host: host("local", 60_000),
			hasAgents: () => true,
			reconcile: () => {
				rounds += 1;
				return Promise.resolve();
			},
			onFailure: () => undefined,
		});
		reconciler.start();
		await until(() => rounds === 1);
		reconciler.wake();
		await until(() => rounds === 2);
		reconciler.stop();
	});
});

describe("one reconciler loop per machine", () => {
	it("does not let a slow machine hold a fast one up", async () => {
		const rounds = new Map<string, number>();
		const loops = new AgentReconcilers({
			reconcile: (about) => {
				rounds.set(about.id, (rounds.get(about.id) ?? 0) + 1);
				return Promise.resolve();
			},
			onFailure: (error: unknown) => {
				throw error;
			},
		});
		// A loop that sleeps for a minute between rounds, beside one that does
		// not. A single loop would have had to pick one of the two numbers, and
		// whichever it picked would have been wrong for the other machine.
		loops.follow([host("local"), host("ssh:far", 60_000)]);
		await until(() => (rounds.get("local") ?? 0) >= 5);
		expect(rounds.get("ssh:far")).toBe(1);
		loops.stop();
	});

	it("keeps a loop only while its machine has something to reconcile", async () => {
		const rounds = new Map<string, number>();
		const loops = new AgentReconcilers({
			reconcile: (about) => {
				rounds.set(about.id, (rounds.get(about.id) ?? 0) + 1);
				return Promise.resolve();
			},
			onFailure: (error: unknown) => {
				throw error;
			},
		});
		loops.follow([host("local"), host("ssh:far")]);
		await until(() => (rounds.get("ssh:far") ?? 0) >= 2);
		// The far machine's last Agent has gone. Its loop stops; the local one
		// carries on, which is the whole point of there being two.
		loops.follow([host("local")]);
		const stoppedAt = rounds.get("ssh:far") ?? 0;
		const localAt = rounds.get("local") ?? 0;
		await until(() => (rounds.get("local") ?? 0) > localAt + 3);
		expect(rounds.get("ssh:far")).toBe(stoppedAt);
		loops.stop();
	});

	it("is idempotent, so a projection change is a nudge and not a restart", async () => {
		let rounds = 0;
		const loops = new AgentReconcilers({
			reconcile: () => {
				rounds += 1;
				return Promise.resolve();
			},
			onFailure: (error: unknown) => {
				throw error;
			},
		});
		loops.follow([host("local")]);
		await until(() => rounds >= 2);
		for (let again = 0; again < 5; again += 1) loops.follow([host("local")]);
		const seen = rounds;
		await new Promise((resolve) => setTimeout(resolve, 20));
		loops.stop();
		const after = rounds;
		await new Promise((resolve) => setTimeout(resolve, 20));
		// Five `follow`s did not make five loops: the count kept climbing at one
		// loop's pace, and stopped dead when the loops did.
		expect(rounds).toBe(after);
		expect(after).toBeGreaterThan(seen);
	});
});

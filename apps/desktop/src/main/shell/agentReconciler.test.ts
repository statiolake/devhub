import { describe, expect, it } from "vitest";
import { AgentReconciler } from "./agentReconciler.js";

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
			intervalMs: 0,
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
			intervalMs: 0,
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
			intervalMs: 0,
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
			intervalMs: 0,
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
			intervalMs: 60_000,
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

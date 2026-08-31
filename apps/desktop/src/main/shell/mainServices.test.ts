/**
 * The launch crash this exists to stop.
 *
 * `startRuntimes` starts the Agent reconciler while VS Code's DI container is
 * still being assembled. Its first round changed the projection, the
 * projection asked for a workbench, and the shell threw "the App Shell was
 * used before the main services were registered" — into a promise nobody was
 * awaiting, so the only place it landed was the process's
 * `unhandledRejection` warning.
 *
 * Two facts are asserted here, and they are the whole fix: reaching for the
 * services early *waits* instead of throwing, and the round that waited runs
 * once the services arrive.
 */

import { describe, expect, it } from "vitest";
import { AgentReconciler } from "./agentReconciler.js";
import { MainServicesGate, type MainServices } from "./mainServices.js";

/** Nothing here calls into VS Code; only identity is ever checked. */
const SERVICES = {} as MainServices;

/** Whether a promise has settled, without awaiting it for real. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
	let done = false;
	void promise.then(() => {
		done = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	return done;
}

async function until(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error("the expected state was never reached");
		}
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

describe("the gate in front of VS Code's main services", () => {
	it("makes an early caller wait rather than fail", async () => {
		const gate = new MainServicesGate();
		const waiting = gate.wait();
		expect(await settled(waiting)).toBe(false);

		gate.register(SERVICES);
		expect(await waiting).toBe(SERVICES);
	});

	it("answers everyone who waited, and everyone who comes later", async () => {
		const gate = new MainServicesGate();
		const early = [gate.wait(), gate.wait()];
		gate.register(SERVICES);
		expect(await Promise.all(early)).toEqual([SERVICES, SERVICES]);

		const late = gate.wait();
		expect(await settled(late)).toBe(true);
		expect(await late).toBe(SERVICES);
	});

	it("refuses a second registration", () => {
		const gate = new MainServicesGate();
		gate.register(SERVICES);
		expect(() => {
			gate.register(SERVICES);
		}).toThrow(/registered twice/);
	});
});

describe("a reconciler round that starts before the services exist", () => {
	it("waits for them instead of crashing, and runs once they are there", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown): void => {
			unhandled.push(error);
		};
		process.on("unhandledRejection", onUnhandled);

		const gate = new MainServicesGate();
		const failures: unknown[] = [];
		let rounds = 0;
		const reconciler = new AgentReconciler({
			intervalMs: 0,
			hasAgents: () => true,
			// The shape of the real chain: a round changes the projection, and a
			// projection change reaches for a workbench.
			reconcile: async () => {
				await gate.wait();
				rounds += 1;
			},
			onFailure: (error) => {
				failures.push(error);
			},
		});

		try {
			reconciler.start();
			// Nothing can run while the gate is shut — and nothing may fail either.
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(rounds).toBe(0);
			expect(failures).toEqual([]);
			expect(unhandled).toEqual([]);

			gate.register(SERVICES);
			await until(() => rounds >= 2);
			expect(failures).toEqual([]);
			expect(unhandled).toEqual([]);
		} finally {
			reconciler.stop();
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("reports a loop that dies instead of leaving it to the process", async () => {
		const gate = new MainServicesGate();
		gate.register(SERVICES);
		const failures: unknown[] = [];
		// `hasAgents` is asked outside the round's own try/catch, so a throw from
		// it is the loop itself failing rather than a round failing.
		const reconciler = new AgentReconciler({
			intervalMs: 0,
			hasAgents: () => {
				throw new Error("the model is gone");
			},
			reconcile: () => Promise.resolve(),
			onFailure: (error) => {
				failures.push(error);
			},
		});
		reconciler.start();
		await until(() => failures.length > 0);
		reconciler.stop();

		const [reported] = failures;
		expect(reported).toBeInstanceOf(Error);
		expect((reported as Error).message).toMatch(/reconciler loop stopped/);
		expect(((reported as Error).cause as Error).message).toBe(
			"the model is gone",
		);
	});
});

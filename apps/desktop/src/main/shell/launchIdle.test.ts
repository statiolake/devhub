import { describe, expect, it } from "vitest";

import { whenIdleAfterLaunch } from "./launchIdle.js";

/** A clock and one timer at a time, fired by hand, `late` ms after due. */
function clock() {
	let now = 0;
	let pending: { fn: () => void; at: number } | undefined;
	return {
		now: () => now,
		setTimer: (fn: () => void, ms: number) => {
			const timer = { fn, at: now + ms };
			pending = timer;
			return {
				cancel: () => {
					if (pending === timer) pending = undefined;
				},
			};
		},
		fire(late = 0) {
			const timer = pending;
			if (timer === undefined) throw new Error("no timer");
			pending = undefined;
			now = timer.at + late;
			timer.fn();
		},
		get pending() {
			return pending !== undefined;
		},
	};
}

const OPTIONS = {
	settleMs: 200,
	sliceMs: 50,
	slackMs: 10,
	quietSlices: 3,
	maxMs: 1_000,
};

describe("work at idle after launch", () => {
	it("runs once main has been quiet for its slices, and not before the settle time", () => {
		const c = clock();
		let ran = 0;
		whenIdleAfterLaunch(() => ran++, { ...OPTIONS, ...c });
		c.fire();
		c.fire();
		c.fire();
		// Three quiet slices, but only 150 ms in.
		expect(ran).toBe(0);
		c.fire();
		expect(ran).toBe(1);
		expect(c.pending).toBe(false);
	});

	it("waits while main is busy: a late slice starts the count again", () => {
		const c = clock();
		let ran = 0;
		whenIdleAfterLaunch(() => ran++, { ...OPTIONS, ...c });
		c.fire();
		c.fire();
		c.fire(80);
		c.fire();
		c.fire();
		expect(ran).toBe(0);
		c.fire();
		expect(ran).toBe(1);
	});

	it("runs at the latest after maxMs of a main that never settles", () => {
		const c = clock();
		let ran = 0;
		whenIdleAfterLaunch(() => ran++, { ...OPTIONS, ...c });
		while (ran === 0) c.fire(40);
		expect(c.now()).toBeGreaterThanOrEqual(1_000);
		expect(c.now()).toBeLessThan(1_100);
	});

	it("runs nothing once cancelled", () => {
		const c = clock();
		let ran = 0;
		const cancel = whenIdleAfterLaunch(() => ran++, { ...OPTIONS, ...c });
		c.fire();
		cancel();
		expect(c.pending).toBe(false);
		expect(ran).toBe(0);
	});
});

import { describe, expect, it } from "vitest";
import { LOCAL_CADENCE } from "./local.js";
import {
	RECONCILE_DUTY_CYCLE,
	REMOTE_RECONCILE_CEILING_MS,
	REMOTE_RECONCILE_FLOOR_MS,
	remoteReconcileIntervalMs,
} from "./cadence.js";

describe("what a reconcile loop over a network costs", () => {
	it("bounds the duty cycle at an eighth, up to where the ceiling takes over", () => {
		for (const rtt of [1, 5, 30, 60, 100, 150, 300, 375]) {
			const interval = remoteReconcileIntervalMs(rtt);
			expect(rtt / interval).toBeLessThanOrEqual(1 / RECONCILE_DUTY_CYCLE);
		}
	});

	it("spends more than an eighth of the clock past the ceiling, and says so", () => {
		// The two rules disagree above 375 ms and the ceiling wins, so the duty
		// cycle is bounded by construction only up to there. It is asserted
		// rather than glossed: on a link that slow DevHub would rather keep
		// asking every three seconds than let a status go minutes stale, and a
		// reader of `--metrics` can see exactly what that costs.
		expect(remoteReconcileIntervalMs(900)).toBe(REMOTE_RECONCILE_CEILING_MS);
		expect(900 / REMOTE_RECONCILE_CEILING_MS).toBeGreaterThan(
			1 / RECONCILE_DUTY_CYCLE,
		);
	});

	it("lands a fast link on the floor rather than polling harder", () => {
		expect(remoteReconcileIntervalMs(5)).toBe(REMOTE_RECONCILE_FLOOR_MS);
		expect(remoteReconcileIntervalMs(60)).toBe(REMOTE_RECONCILE_FLOOR_MS);
		// Just past the point where eight round trips exceed the floor.
		expect(remoteReconcileIntervalMs(70)).toBe(560);
	});

	it("stops slowing down at the ceiling", () => {
		expect(remoteReconcileIntervalMs(300)).toBe(2_400);
		expect(remoteReconcileIntervalMs(1_000)).toBe(REMOTE_RECONCILE_CEILING_MS);
	});

	it("runs at the ceiling when the median is not a measurement", () => {
		expect(remoteReconcileIntervalMs(Number.NaN)).toBe(
			REMOTE_RECONCILE_CEILING_MS,
		);
		expect(remoteReconcileIntervalMs(-1)).toBe(REMOTE_RECONCILE_CEILING_MS);
	});

	it("is not what this machine uses, because this machine has no latency", () => {
		// Eight times nothing is nothing, and the floor would slow the local
		// reconciler down for no reason anybody could name. `LOCAL_CADENCE`
		// states the numbers instead.
		expect(remoteReconcileIntervalMs(0)).toBe(REMOTE_RECONCILE_FLOOR_MS);
		expect(LOCAL_CADENCE.reconcileIntervalMs).toBe(300);
	});
});

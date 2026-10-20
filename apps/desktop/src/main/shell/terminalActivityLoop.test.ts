import { describe, expect, it } from "vitest";
import {
	FailureOnce,
	TERMINAL_ACTIVITY_INTERVAL_MS,
	terminalActivityHost,
} from "./terminalActivityLoop.js";
import type { ReconcileHost } from "./agentReconciler.js";

function host(reconcileIntervalMs: number): ReconcileHost {
	return {
		id: "local",
		cadence: {
			reconcileIntervalMs,
			repositoryPollMs: 60_000,
			repositoryFocusRefreshMinIntervalMs: 10_000,
			headWatchPollMs: undefined,
		},
	};
}

describe("the terminal-activity loop's cadence", () => {
	it("asks a machine at most once a second", () => {
		expect(terminalActivityHost(host(300)).cadence.reconcileIntervalMs).toBe(
			TERMINAL_ACTIVITY_INTERVAL_MS,
		);
	});

	it("goes slower with a machine whose own cadence is slower", () => {
		expect(terminalActivityHost(host(2_400)).cadence.reconcileIntervalMs).toBe(
			2_400,
		);
	});

	it("follows a cadence that moves, as a remote runtime's does", () => {
		let interval = 500;
		const moving: ReconcileHost = {
			id: "ssh:example",
			get cadence() {
				return host(interval).cadence;
			},
		};
		const clamped = terminalActivityHost(moving);
		expect(clamped.cadence.reconcileIntervalMs).toBe(1_000);
		interval = 3_000;
		expect(clamped.cadence.reconcileIntervalMs).toBe(3_000);
	});
});

describe("a machine's failure, in the log", () => {
	it("is said once per reason, and again after it recovered", () => {
		const once = new FailureOnce();
		expect(once.failed("ssh:a", "unreachable")).toBe(true);
		expect(once.failed("ssh:a", "unreachable")).toBe(false);
		expect(once.failed("ssh:b", "unreachable")).toBe(true);
		expect(once.failed("ssh:a", "timeout")).toBe(true);
		once.succeeded("ssh:a");
		expect(once.failed("ssh:a", "timeout")).toBe(true);
	});
});

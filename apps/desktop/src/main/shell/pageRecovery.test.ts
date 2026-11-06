import { describe, expect, it } from "vitest";
import {
	MAX_RELOAD_DELAY_MS,
	UNRESPONSIVE_RELOAD_MS,
	WAKE_GRACE_MS,
	gpuGoneAction,
	pageRecoveryAction,
	reloadDelayMs,
	type PageSituation,
} from "./pageRecovery.js";

const NOW = 1_000_000;

const live = (overrides: Partial<PageSituation> = {}): PageSituation => ({
	quitting: false,
	destroyed: false,
	loaded: true,
	recentReloads: 0,
	waiting: false,
	lastWakeAt: Number.NEGATIVE_INFINITY,
	now: NOW,
	...overrides,
});

const REASONS = [
	"clean-exit",
	"abnormal-exit",
	"killed",
	"crashed",
	"oom",
	"launch-failed",
	"integrity-failure",
	"memory-eviction",
];

describe("a page whose renderer is gone", () => {
	it.each(REASONS)("is reloaded at once for %s", (reason) => {
		expect(
			pageRecoveryAction({ kind: "gone", reason, exitCode: 1 }, live()),
		).toEqual({ kind: "reload", delayMs: 0 });
	});

	it.each(REASONS)("is left alone at quit, for %s too", (reason) => {
		expect(
			pageRecoveryAction({ kind: "gone", reason }, live({ quitting: true })),
		).toEqual({ kind: "nothing" });
	});

	it("is left alone when DevHub closed it (destroyed)", () => {
		expect(
			pageRecoveryAction(
				{ kind: "gone", reason: "clean-exit" },
				live({ destroyed: true }),
			),
		).toEqual({ kind: "nothing" });
	});

	it("has nothing to reload before it was ever loaded", () => {
		expect(
			pageRecoveryAction(
				{ kind: "gone", reason: "crashed" },
				live({ loaded: false }),
			),
		).toEqual({ kind: "nothing" });
	});

	it("backs off when it keeps dying, never past the ceiling, never giving up", () => {
		const delays = [0, 1, 2, 3, 10, 100].map((recentReloads) =>
			pageRecoveryAction(
				{ kind: "gone", reason: "crashed" },
				live({ recentReloads }),
			),
		);
		expect(delays).toEqual([
			{ kind: "reload", delayMs: 0 },
			{ kind: "reload", delayMs: 1_000 },
			{ kind: "reload", delayMs: 2_000 },
			{ kind: "reload", delayMs: 4_000 },
			{ kind: "reload", delayMs: MAX_RELOAD_DELAY_MS },
			{ kind: "reload", delayMs: MAX_RELOAD_DELAY_MS },
		]);
		expect(reloadDelayMs(-1)).toBe(0);
	});
});

describe("a page that stops responding", () => {
	it("is waited for first", () => {
		expect(pageRecoveryAction({ kind: "unresponsive" }, live())).toEqual({
			kind: "wait",
			delayMs: UNRESPONSIVE_RELOAD_MS,
		});
	});

	it("does not start the wait over on a second unresponsive", () => {
		expect(
			pageRecoveryAction(
				{ kind: "unresponsive" },
				live({ waiting: true, waitStartedAt: NOW - 1 }),
			),
		).toEqual({ kind: "nothing" });
	});

	it("is forgiven when it answers again", () => {
		expect(
			pageRecoveryAction({ kind: "responsive" }, live({ waiting: true })),
		).toEqual({ kind: "stop-waiting" });
		expect(pageRecoveryAction({ kind: "responsive" }, live())).toEqual({
			kind: "nothing",
		});
	});

	it("is ended (and so reloaded) when the wait runs out", () => {
		expect(
			pageRecoveryAction(
				{ kind: "unresponsive-elapsed" },
				live({ waiting: true, waitStartedAt: NOW - UNRESPONSIVE_RELOAD_MS }),
			),
		).toEqual({ kind: "kill" });
	});

	it("is waited for again when the Mac slept during the wait", () => {
		const started = NOW - UNRESPONSIVE_RELOAD_MS;
		expect(
			pageRecoveryAction(
				{ kind: "unresponsive-elapsed" },
				live({
					waiting: true,
					waitStartedAt: started,
					lastWakeAt: started + 5,
				}),
			),
		).toEqual({ kind: "wait", delayMs: UNRESPONSIVE_RELOAD_MS });
	});

	it("is waited for again just after a wake", () => {
		expect(
			pageRecoveryAction(
				{ kind: "unresponsive-elapsed" },
				live({
					waiting: true,
					waitStartedAt: NOW - 1,
					lastWakeAt: NOW - WAKE_GRACE_MS - 10,
				}),
			).kind,
		).toBe("kill");
		expect(
			pageRecoveryAction(
				{ kind: "unresponsive-elapsed" },
				live({
					waiting: true,
					waitStartedAt: NOW - 1,
					lastWakeAt: NOW - WAKE_GRACE_MS + 10,
				}),
			).kind,
		).toBe("wait");
	});

	it("is left alone at quit", () => {
		for (const kind of [
			"unresponsive",
			"responsive",
			"unresponsive-elapsed",
		] as const) {
			expect(
				pageRecoveryAction(
					{ kind },
					live({ quitting: true, waiting: true, waitStartedAt: 0 }),
				),
			).toEqual({ kind: "nothing" });
		}
	});

	it("ignores a stale elapse after the wait was stopped", () => {
		expect(
			pageRecoveryAction({ kind: "unresponsive-elapsed" }, live()),
		).toEqual({ kind: "nothing" });
	});
});

describe("a child process gone", () => {
	it("repaints every page when it was the GPU process", () => {
		for (const reason of REASONS) {
			expect(gpuGoneAction({ type: "GPU", reason }, false)).toEqual({
				kind: "repaint",
			});
		}
	});

	it("is not this module's otherwise", () => {
		expect(
			gpuGoneAction({ type: "Utility", reason: "crashed" }, false),
		).toEqual({ kind: "nothing" });
	});

	it("is nothing at quit", () => {
		expect(gpuGoneAction({ type: "GPU", reason: "crashed" }, true)).toEqual({
			kind: "nothing",
		});
	});
});

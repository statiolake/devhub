import { describe, expect, it } from "vitest";
import { ActivityCounters, COUNTER } from "./counters.js";

/** A clock the test moves by hand, so a rate is an exact number. */
function clockFrom(start: number): {
	now: () => number;
	advance: (ms: number) => void;
} {
	let value = start;
	return {
		now: () => value,
		advance: (ms) => {
			value += ms;
		},
	};
}

describe("ActivityCounters", () => {
	it("reports nothing before anything has happened", () => {
		const counters = new ActivityCounters(() => 0);
		expect(counters.read().counters).toEqual([]);
	});

	it("counts each name separately and reports a per-minute rate", () => {
		const clock = clockFrom(1_000);
		const counters = new ActivityCounters(clock.now);
		for (let i = 0; i < 60; i += 1) counters.record(COUNTER.process("tmux"));
		counters.record(COUNTER.agentReconcileRound);
		clock.advance(30_000);

		expect(counters.read()).toEqual({
			elapsedMs: 30_000,
			counters: [
				{ name: "agent.reconcile.round", total: 1, perMinuteSinceStart: 2 },
				{ name: "process.tmux", total: 60, perMinuteSinceStart: 120 },
			],
		});
	});

	it("says zero rather than infinity for a reading taken before the clock moved", () => {
		const counters = new ActivityCounters(() => 5);
		counters.record(COUNTER.tmuxListSessions);
		expect(counters.read()).toEqual({
			elapsedMs: 0,
			counters: [
				{ name: "tmux.list-sessions", total: 1, perMinuteSinceStart: 0 },
			],
		});
	});

	it("does not reset itself, so two readers see the same totals", () => {
		const clock = clockFrom(0);
		const counters = new ActivityCounters(clock.now);
		counters.record(COUNTER.repositoryBranchRound);
		clock.advance(60_000);
		const first = counters.read();
		const second = counters.read();
		expect(second).toEqual(first);
		expect(first.counters[0]?.total).toBe(1);
	});
});

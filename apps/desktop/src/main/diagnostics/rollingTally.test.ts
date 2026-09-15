/**
 * The bound is the point, so the bound is what is pinned here.
 *
 * The thing this replaces was correct and still wrong: it answered "how many
 * in the last minute" exactly, and it did so out of an array holding every
 * event since launch, pruned only by the reading nobody took. So the tests
 * that matter are not only "does it count" but "does a million events cost
 * what a hundred cost", and "is the answer still right when nobody reads".
 */

import { describe, expect, it } from "vitest";
import { RollingTally } from "./rollingTally.js";

const A_SECOND = 1_000;
const A_MINUTE = 60_000;

function atMyOwnPace() {
	let now = 0;
	return {
		clock: () => now,
		pass: (ms: number) => {
			now += ms;
		},
	};
}

describe("counting inside the window", () => {
	it("counts what happened", () => {
		const { clock } = atMyOwnPace();
		const tally = new RollingTally(A_MINUTE, 60, clock);
		tally.record();
		tally.record();
		expect(tally.count()).toBe(2);
	});

	it("keeps each key's count to itself", () => {
		const { clock } = atMyOwnPace();
		const tally = new RollingTally(A_MINUTE, 60, clock);
		tally.record("this-mac");
		tally.record("the-other-one");
		tally.record("the-other-one");
		expect(tally.totals()).toEqual(
			new Map([
				["this-mac", 1],
				["the-other-one", 2],
			]),
		);
	});

	it("forgets what has left the window", () => {
		const { clock, pass } = atMyOwnPace();
		const tally = new RollingTally(A_MINUTE, 60, clock);
		tally.record();
		pass(A_MINUTE + A_SECOND);
		expect(tally.count()).toBe(0);
	});

	it("keeps counting across the ring coming round again", () => {
		const { clock, pass } = atMyOwnPace();
		const tally = new RollingTally(A_MINUTE, 60, clock);
		for (let minute = 0; minute < 10; minute += 1) {
			for (let second = 0; second < 60; second += 1) {
				if (second > 0) pass(A_SECOND);
				tally.record();
			}
			// Each full pass of the ring leaves a minute's worth and no more —
			// the tenth minute reads exactly as the first did.
			expect(tally.count()).toBe(60);
			pass(A_SECOND);
		}
	});

	it("says nothing about a key nothing has said lately", () => {
		const { clock, pass } = atMyOwnPace();
		const tally = new RollingTally(A_MINUTE, 60, clock);
		tally.record("a-machine-that-went-away");
		pass(A_MINUTE + A_SECOND);
		// Not merely zero: the key itself is gone, which is what keeps a tally
		// keyed by something unbounded — an identity, a host — from being a leak
		// with a rolling count on top.
		expect(tally.totals().size).toBe(0);
	});
});

describe("what it costs", () => {
	it("holds a fixed amount however many events there are", () => {
		const { clock } = atMyOwnPace();
		const buckets = 60;
		const tally = new RollingTally(A_MINUTE, buckets, clock);
		for (let i = 0; i < 1_000_000; i += 1) {
			tally.record();
		}
		expect(tally.count()).toBe(1_000_000);
		// The count is exact; the memory is the ring. Nothing here can grow
		// with the number of events, because a bucket holds one number per key.
		expect(tally.buckets).toBe(buckets);
		// A million events, one counter: they all happened in one bucket and a
		// bucket holds one number per key.
		expect(tally.retained()).toBe(1);
	});

	it("holds a fixed amount however long nobody reads it", () => {
		const { clock, pass } = atMyOwnPace();
		const tally = new RollingTally(A_MINUTE, 60, clock);
		for (let i = 0; i < 100_000; i += 1) {
			tally.record();
			pass(10);
		}
		// A hundred thousand events over sixteen minutes, and the first reading
		// at the end of them: one counter per bucket, which is the whole of the
		// ring and the whole of the cost. The old array would be holding all
		// hundred thousand, waiting for this reading to prune them.
		expect(tally.retained()).toBe(tally.buckets);
		expect(tally.count()).toBeLessThanOrEqual(6_000);
	});

	it("holds a fixed amount however many keys go past", () => {
		const { clock, pass } = atMyOwnPace();
		const tally = new RollingTally(A_MINUTE, 60, clock);
		for (let i = 0; i < 100_000; i += 1) {
			tally.record(`identity-${String(i)}`);
			pass(10);
		}
		// The bound with keys is the ring times the rate — a hundred distinct
		// identities a second across sixty buckets — and not the length of the
		// run. A hundred thousand went past; six thousand counters is the most
		// that can be held whether the run was this long or a week long.
		expect(tally.retained()).toBeLessThanOrEqual(6_000);
	});
});

describe("a tally that could not answer", () => {
	it("refuses a window with no buckets rather than dividing by zero", () => {
		expect(() => new RollingTally(A_MINUTE, 0)).toThrow(/at least one/);
	});

	it("refuses a window of no time", () => {
		expect(() => new RollingTally(0)).toThrow(/needs a window/);
	});
});

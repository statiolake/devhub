import { describe, expect, it } from "vitest";
import { type CacheSample, PromptCacheTracker } from "./promptCache.js";

function sample(over: Partial<CacheSample>): CacheSample {
	return {
		inputTokens: 10,
		outputTokens: 100,
		cacheWriteTokens: 0,
		cacheReadTokens: 0,
		write5mTokens: undefined,
		write1hTokens: undefined,
		...over,
	};
}

describe("PromptCacheTracker", () => {
	it("says nothing before a response", () => {
		expect(new PromptCacheTracker().state()).toBeUndefined();
	});

	it("takes the TTL from the write's split and expires that long after", () => {
		const tracker = new PromptCacheTracker();
		const state = tracker.record(
			sample({ cacheWriteTokens: 20_000, write1hTokens: 20_000 }),
			1_000,
		);
		expect(state).toMatchObject({
			ttlSeconds: 3600,
			ttlKnown: true,
			expiresAt: 1_000 + 3_600_000,
			requests: 1,
			misses: 0,
			recacheTokens: 20_110,
		});
		expect(state.hitRatio).toBeCloseTo(0);
	});

	it("assumes 5 minutes until a write says, and keeps a TTL across reads", () => {
		const tracker = new PromptCacheTracker();
		expect(tracker.record(sample({ cacheReadTokens: 5000 }), 0)).toMatchObject({
			ttlSeconds: 300,
			ttlKnown: false,
			expiresAt: 300_000,
		});
		tracker.record(sample({ cacheWriteTokens: 100, write1hTokens: 100 }), 10);
		expect(tracker.record(sample({ cacheReadTokens: 5300 }), 20)).toMatchObject(
			{ ttlSeconds: 3600, ttlKnown: true, expiresAt: 3_600_020 },
		);
	});

	it("is cold when the last response reported no cache tokens", () => {
		const tracker = new PromptCacheTracker();
		tracker.record(sample({ cacheWriteTokens: 1000 }), 0);
		expect(tracker.record(sample({}), 1).expiresAt).toBeUndefined();
	});

	it("counts a warm prefix written again as a miss, a compaction's rebuild not", () => {
		const tracker = new PromptCacheTracker();
		tracker.record(sample({ cacheWriteTokens: 50_000 }), 0);
		// Read what was cached: a hit.
		expect(
			tracker.record(
				sample({ cacheReadTokens: 50_000, cacheWriteTokens: 200 }),
				1000,
			).misses,
		).toBe(0);
		// Wrote it all again while warm: a miss.
		expect(
			tracker.record(sample({ cacheWriteTokens: 50_500 }), 2000).misses,
		).toBe(1);
		tracker.compacted();
		const after = tracker.record(sample({ cacheWriteTokens: 9000 }), 3000);
		expect(after.misses).toBe(1);
		// Cold by then: a rebuild is expected, not a miss.
		expect(
			tracker.record(sample({ cacheWriteTokens: 9500 }), 3000 + 400_000).misses,
		).toBe(1);
	});

	it("divides reads by every input token", () => {
		const tracker = new PromptCacheTracker();
		tracker.record(sample({ inputTokens: 0, cacheWriteTokens: 1000 }), 0);
		const state = tracker.record(
			sample({ inputTokens: 0, cacheReadTokens: 3000 }),
			1,
		);
		expect(state.hitRatio).toBeCloseTo(0.75);
	});
});

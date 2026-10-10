import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	EMPTY_TRANSCRIPT,
	entryId,
	type Transcript,
	type TranscriptEntry,
} from "../../../model/conversation.js";
import {
	CACHE_KEEP_OFF,
	CacheKeeper,
	compactDue,
	type CacheKeepSettings,
} from "./cacheKeeper.js";
import { REAL_CLOCK } from "./limitResume.js";

const ON: CacheKeepSettings = {
	enabled: true,
	leadSeconds: 60,
	minTokens: 20_000,
};
const START = 1_000_000;
const TTL_MS = 300_000;

function idle(
	expiresAt: number | undefined,
	more: Partial<Transcript> = {},
	contextTokens = 50_000,
): Transcript {
	return {
		...EMPTY_TRANSCRIPT,
		state: { phase: "ready", turn: "none" },
		usage: {
			inputTokens: undefined,
			outputTokens: undefined,
			cachedInputTokens: undefined,
			contextTokens,
			contextWindow: undefined,
			costUsd: undefined,
			rateLimits: undefined,
			promptCache: {
				ttlSeconds: 300,
				ttlKnown: true,
				expiresAt,
				hitRatio: undefined,
				requests: 1,
				misses: 0,
				recacheTokens: undefined,
			},
		},
		...more,
	};
}

const COMPACTION: TranscriptEntry = {
	kind: "compaction",
	id: entryId("compaction:1"),
	parent: null,
	trigger: "manual",
	preTokens: 50_000,
	postTokens: 3_000,
};

describe("compactDue", () => {
	it("is lead seconds before expiry for an idle, large, warm conversation", () => {
		expect(compactDue(idle(START + TTL_MS), ON)).toEqual({
			expiresAt: START + TTL_MS,
			at: START + TTL_MS - 60_000,
		});
	});

	it("is never while off, busy, small, cold or just compacted", () => {
		const warm = START + TTL_MS;
		expect(compactDue(idle(warm), CACHE_KEEP_OFF)).toBeUndefined();
		expect(compactDue(idle(undefined), ON)).toBeUndefined();
		expect(compactDue(idle(warm, {}, 10_000), ON)).toBeUndefined();
		expect(
			compactDue(
				idle(warm, { state: { phase: "ready", turn: "running" } }),
				ON,
			),
		).toBeUndefined();
		expect(compactDue(idle(warm, { compacting: true }), ON)).toBeUndefined();
		expect(
			compactDue(
				idle(warm, {
					pending: [
						{
							id: "held:1" as never,
							text: "hi",
							images: [],
							failure: undefined,
							editing: false,
						},
					],
				}),
				ON,
			),
		).toBeUndefined();
		expect(
			compactDue(idle(warm, { entries: [COMPACTION] }), ON),
		).toBeUndefined();
	});
});

describe("CacheKeeper", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(START);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function keeper(settings = ON): {
		keeper: CacheKeeper;
		due: ReturnType<typeof vi.fn>;
	} {
		const due = vi.fn();
		return { keeper: new CacheKeeper(() => settings, REAL_CLOCK, due), due };
	}

	it("fires once, lead seconds before the cache expires", () => {
		const { keeper: k, due } = keeper();
		const transcript = idle(START + TTL_MS);
		k.observe(transcript);
		vi.advanceTimersByTime(TTL_MS - 60_001);
		expect(due).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(due).toHaveBeenCalledOnce();
		expect(k.take(transcript)).toBe(true);
		// The same warm period does not fire again.
		k.observe(transcript);
		vi.advanceTimersByTime(TTL_MS);
		expect(due).toHaveBeenCalledOnce();
		expect(k.take(transcript)).toBe(false);
	});

	it("is called off when the person starts a turn", () => {
		const { keeper: k, due } = keeper();
		k.observe(idle(START + TTL_MS));
		vi.advanceTimersByTime(60_000);
		k.observe(
			idle(START + TTL_MS, { state: { phase: "ready", turn: "running" } }),
		);
		vi.advanceTimersByTime(TTL_MS);
		expect(due).not.toHaveBeenCalled();
	});

	it("skips when the Agent is busy at the deadline", () => {
		const { keeper: k, due } = keeper();
		k.observe(idle(START + TTL_MS));
		vi.advanceTimersByTime(TTL_MS - 60_000);
		expect(due).toHaveBeenCalledOnce();
		expect(
			k.take(
				idle(START + TTL_MS, { state: { phase: "ready", turn: "running" } }),
			),
		).toBe(false);
	});

	it("rearms for a new warm period after a new response", () => {
		const { keeper: k, due } = keeper();
		k.observe(idle(START + TTL_MS));
		vi.advanceTimersByTime(120_000);
		const later = START + 120_000 + TTL_MS;
		k.observe(idle(later));
		vi.advanceTimersByTime(TTL_MS - 120_000 - 60_000);
		expect(due).not.toHaveBeenCalled();
		vi.advanceTimersByTime(120_000);
		expect(due).toHaveBeenCalledOnce();
		expect(k.take(idle(later))).toBe(true);
	});

	it("does nothing when the timer comes late, after a sleep", () => {
		const { keeper: k, due } = keeper();
		const transcript = idle(START + TTL_MS);
		k.observe(transcript);
		// The Mac slept through the deadline: the clock jumps past expiry.
		vi.setSystemTime(START + TTL_MS + 10_000);
		vi.advanceTimersByTime(TTL_MS);
		expect(due).toHaveBeenCalled();
		expect(k.take(transcript)).toBe(false);
	});

	it("does nothing for a cache seen already expired (journal replay)", () => {
		const { keeper: k, due } = keeper();
		const transcript = idle(START - 1_000);
		k.observe(transcript);
		vi.advanceTimersByTime(0);
		expect(due).toHaveBeenCalledOnce();
		expect(k.take(transcript)).toBe(false);
	});

	it("does nothing once stopped", () => {
		const { keeper: k, due } = keeper();
		k.observe(idle(START + TTL_MS));
		k.stop();
		vi.advanceTimersByTime(TTL_MS);
		expect(due).not.toHaveBeenCalled();
	});

	it("stays off while the setting is off", () => {
		const { keeper: k, due } = keeper(CACHE_KEEP_OFF);
		k.observe(idle(START + TTL_MS));
		vi.advanceTimersByTime(TTL_MS);
		expect(due).not.toHaveBeenCalled();
	});
});

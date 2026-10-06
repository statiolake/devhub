/**
 * The main conversation's prompt cache, worked out from each API response's
 * `usage`.
 *
 * Claude Code hands the same statistics to a status line (`prompt_cache`,
 * v2.1.251+), but the status line is a terminal feature: it never runs in the
 * `-p` stream-json mode a GUI Agent is driven in, and the stream carries no
 * `prompt_cache` of its own. What the stream does carry is every assistant
 * message's `usage` — fresh input, cache writes (split by TTL in
 * `cache_creation`), cache reads — which is what Claude Code computes its
 * statistics from too. So this follows its documented rules:
 *
 * - the prefix stays warm for its TTL after the last response that read or
 *   wrote cache tokens, and is cold when the last response reported none;
 * - the TTL is the one the last write was made with (`ephemeral_1h` or
 *   `ephemeral_5m`), and 5 minutes — the API's default — until one says;
 * - a miss is a request that re-processed more than 5% and at least 2,000
 *   tokens of what it could have read from a still-warm cache, unless a
 *   compaction since explains it;
 * - the hit ratio is cache reads over reads, writes and fresh input.
 */

import type { PromptCache } from "../../../../model/conversation.js";

export interface CacheSample {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheWriteTokens: number;
	readonly cacheReadTokens: number;
	/** The write's split by TTL, when the response gave one. */
	readonly write5mTokens: number | undefined;
	readonly write1hTokens: number | undefined;
}

const DEFAULT_TTL_SECONDS = 300;
const MISS_MIN_TOKENS = 2000;
const MISS_MIN_FRACTION = 0.05;

export class PromptCacheTracker {
	private ttlSeconds = DEFAULT_TTL_SECONDS;
	private ttlKnown = false;
	private expiresAt: number | undefined;
	private requests = 0;
	private misses = 0;
	private reads = 0;
	private all = 0;
	/** What the next request could read from cache: the last prompt and its answer. */
	private cachedPrefix: number | undefined;
	private explained = false;
	private seen = false;

	/** One main-conversation response, received (or written) at `at`. */
	record(sample: CacheSample, at: number): PromptCache {
		this.seen = true;
		this.requests += 1;
		const cached = sample.cacheWriteTokens + sample.cacheReadTokens;
		const prompt = sample.inputTokens + cached;
		if (
			!this.explained &&
			this.cachedPrefix !== undefined &&
			this.expiresAt !== undefined &&
			at <= this.expiresAt
		) {
			const shortfall =
				Math.min(this.cachedPrefix, prompt) - sample.cacheReadTokens;
			if (
				shortfall >= MISS_MIN_TOKENS &&
				shortfall > this.cachedPrefix * MISS_MIN_FRACTION
			)
				this.misses += 1;
		}
		this.explained = false;
		if ((sample.write1hTokens ?? 0) > 0) {
			this.ttlSeconds = 3600;
			this.ttlKnown = true;
		} else if ((sample.write5mTokens ?? 0) > 0) {
			this.ttlSeconds = 300;
			this.ttlKnown = true;
		}
		this.expiresAt = cached > 0 ? at + this.ttlSeconds * 1000 : undefined;
		this.reads += sample.cacheReadTokens;
		this.all += prompt;
		this.cachedPrefix = prompt + sample.outputTokens;
		return this.state()!;
	}

	/** The conversation was compacted: the next rebuild is expected, and its size unknown. */
	compacted(): void {
		this.explained = true;
		this.cachedPrefix = undefined;
	}

	state(): PromptCache | undefined {
		if (!this.seen) return undefined;
		return {
			ttlSeconds: this.ttlSeconds,
			ttlKnown: this.ttlKnown,
			expiresAt: this.expiresAt,
			hitRatio: this.all === 0 ? undefined : this.reads / this.all,
			requests: this.requests,
			misses: this.misses,
			recacheTokens: this.cachedPrefix,
		};
	}
}

// Port of apps/desktop/src/main/agent/conversation/claude/promptCache.ts
//
// The main conversation's prompt cache, worked out from each API response's
// `usage`.
//
// Claude Code hands the same statistics to a status line (`prompt_cache`,
// v2.1.251+), but the status line is a terminal feature: it never runs in the
// `-p` stream-json mode a GUI Agent is driven in, and the stream carries no
// `prompt_cache` of its own. What the stream does carry is every assistant
// message's `usage` — fresh input, cache writes (split by TTL in
// `cache_creation`), cache reads — which is what Claude Code computes its
// statistics from too. So this follows its documented rules:
//
// - the prefix stays warm for its TTL after the last response that read or
//   wrote cache tokens, and is cold when the last response reported none;
// - the TTL is the one the last write was made with (`ephemeral_1h` or
//   `ephemeral_5m`), and 5 minutes — the API's default — until one says;
// - a miss is a request that re-processed more than 5% and at least 2,000
//   tokens of what it could have read from a still-warm cache, unless a
//   compaction since explains it;
// - the hit ratio is cache reads over reads, writes and fresh input.

import Foundation

public struct CacheSample: Hashable, Sendable {
    public var inputTokens: Double
    public var outputTokens: Double
    public var cacheWriteTokens: Double
    public var cacheReadTokens: Double
    /// The write's split by TTL, when the response gave one.
    public var write5mTokens: Double?
    public var write1hTokens: Double?

    public init(
        inputTokens: Double, outputTokens: Double, cacheWriteTokens: Double, cacheReadTokens: Double,
        write5mTokens: Double?, write1hTokens: Double?
    ) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheWriteTokens = cacheWriteTokens
        self.cacheReadTokens = cacheReadTokens
        self.write5mTokens = write5mTokens
        self.write1hTokens = write1hTokens
    }
}

private let DEFAULT_TTL_SECONDS: Double = 300
private let MISS_MIN_TOKENS: Double = 2000
private let MISS_MIN_FRACTION = 0.05

public struct PromptCacheTracker: Sendable {
    private var ttlSeconds = DEFAULT_TTL_SECONDS
    private var ttlKnown = false
    private var expiresAt: Double?
    private var requests = 0
    private var misses = 0
    private var reads: Double = 0
    private var all: Double = 0
    /// What the next request could read from cache: the last prompt and its answer.
    private var cachedPrefix: Double?
    private var explained = false
    private var seen = false

    public init() {}

    /// One main-conversation response, received (or written) at `at`.
    @discardableResult
    public mutating func record(_ sample: CacheSample, at: Double) -> PromptCache {
        seen = true
        requests += 1
        let cached = sample.cacheWriteTokens + sample.cacheReadTokens
        let prompt = sample.inputTokens + cached
        if !explained, let cachedPrefix, let expiresAt, at <= expiresAt {
            let shortfall = min(cachedPrefix, prompt) - sample.cacheReadTokens
            if shortfall >= MISS_MIN_TOKENS && shortfall > cachedPrefix * MISS_MIN_FRACTION { misses += 1 }
        }
        explained = false
        if (sample.write1hTokens ?? 0) > 0 {
            ttlSeconds = 3600
            ttlKnown = true
        } else if (sample.write5mTokens ?? 0) > 0 {
            ttlSeconds = 300
            ttlKnown = true
        }
        expiresAt = cached > 0 ? at + ttlSeconds * 1000 : nil
        reads += sample.cacheReadTokens
        all += prompt
        cachedPrefix = prompt + sample.outputTokens
        return state()!
    }

    /// The conversation was compacted: the next rebuild is expected, and its size unknown.
    public mutating func compacted() {
        explained = true
        cachedPrefix = nil
    }

    public func state() -> PromptCache? {
        guard seen else { return nil }
        return PromptCache(
            ttlSeconds: ttlSeconds, ttlKnown: ttlKnown, expiresAt: expiresAt,
            hitRatio: all == 0 ? nil : reads / all, requests: requests, misses: misses,
            recacheTokens: cachedPrefix)
    }
}

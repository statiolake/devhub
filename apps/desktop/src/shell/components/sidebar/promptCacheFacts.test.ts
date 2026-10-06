import { describe, expect, it } from "vitest";
import type { PromptCacheWire } from "../../../ipc/appShell";
import { promptCacheFacts, timeLeft, tokenCount } from "./promptCacheFacts";

const cache: PromptCacheWire = {
  ttlSeconds: 3600,
  ttlKnown: true,
  expiresAt: 10_000_000,
  hitRatio: 0.91,
  requests: 14,
  misses: 0,
  recacheTokens: 82_000,
};

describe("promptCacheFacts", () => {
  it("draws nothing without a cache", () => {
    expect(promptCacheFacts(undefined, 0)).toEqual([]);
  });

  it("counts a warm cache down against its TTL", () => {
    const [fact] = promptCacheFacts(cache, 10_000_000 - 38 * 60_000);
    expect(fact?.text).toBe(
      "Cache: warm · 38m left (1h TTL) · hit 91% · misses 0",
    );
    expect(fact?.tone).toBe("unknown");
  });

  it("turns the waiting colour in the last fifth of its life", () => {
    const [fact] = promptCacheFacts(cache, 10_000_000 - 5 * 60_000);
    expect(fact?.tone).toBe("waiting");
  });

  it("says when the TTL was assumed", () => {
    const [fact] = promptCacheFacts(
      { ...cache, ttlSeconds: 300, ttlKnown: false },
      10_000_000 - 45_000,
    );
    expect(fact?.text).toContain("45s left (5m TTL, assumed)");
  });

  it("says what a cold cache costs the next message", () => {
    const [fact] = promptCacheFacts({ ...cache, misses: 2 }, 10_000_001);
    expect(fact?.text).toBe(
      "Cache: cold · next message re-caches 82k tokens · hit 91% · misses 2",
    );
    expect(
      promptCacheFacts({ ...cache, expiresAt: undefined }, 0)[0]?.text,
    ).toMatch(/^Cache: cold/);
  });
});

describe("formatting", () => {
  it("rounds time up and tokens to the nearest unit", () => {
    expect(timeLeft(58_001)).toBe("59s");
    expect(timeLeft(60_001)).toBe("2m");
    expect(timeLeft(3_600_000)).toBe("1h 0m");
    expect(tokenCount(950)).toBe("950");
    expect(tokenCount(1_250_000)).toBe("1.3M");
  });
});

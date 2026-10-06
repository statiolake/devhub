import type { PromptCacheWire } from "../../../ipc/appShell";
import type { RowFact } from "./rowDescription";

/** Below this share of its TTL left, the cache line is drawn in the waiting colour. */
const LOW_FRACTION = 0.2;

function ttl(seconds: number): string {
  return seconds % 3600 === 0
    ? `${seconds / 3600}h`
    : `${Math.round(seconds / 60)}m`;
}

/** Time left, at the precision a countdown wants: minutes, then seconds in the last one. */
export function timeLeft(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
    : `${minutes}m`;
}

export function tokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

/**
 * An Agent's prompt cache, as the line its tooltip draws, at `now`.
 *
 * Warm: how long until it goes cold, against its TTL, and how well it has
 * been used. Cold: what the next message will cost to cache again. Nothing at
 * all for an Agent with no cache to speak of.
 */
export function promptCacheFacts(
  cache: PromptCacheWire | undefined,
  now: number,
): RowFact[] {
  if (cache === undefined) return [];
  const stats = [
    cache.hitRatio === undefined
      ? undefined
      : `hit ${Math.round(cache.hitRatio * 100)}%`,
    `misses ${cache.misses}`,
  ].filter((part): part is string => part !== undefined);
  const left = cache.expiresAt === undefined ? 0 : cache.expiresAt - now;
  if (left > 0) {
    const low = left < cache.ttlSeconds * 1000 * LOW_FRACTION;
    const lifetime = `${ttl(cache.ttlSeconds)} TTL${cache.ttlKnown ? "" : ", assumed"}`;
    return [
      {
        icon: "checksPending",
        text: [
          `Cache: warm`,
          `${timeLeft(left)} left (${lifetime})`,
          ...stats,
        ].join(" · "),
        spoken: `Prompt cache warm, ${timeLeft(left)} left`,
        style: "muted",
        tone: low ? "waiting" : "unknown",
      },
    ];
  }
  return [
    {
      icon: "checksPending",
      text: [
        "Cache: cold",
        cache.recacheTokens === undefined
          ? undefined
          : `next message re-caches ${tokenCount(cache.recacheTokens)} tokens`,
        ...stats,
      ]
        .filter((part): part is string => part !== undefined)
        .join(" · "),
      spoken: "Prompt cache cold",
      style: "muted",
      tone: "unknown",
    },
  ];
}

/**
 * The bar over a GUI Agent's transcript: what the session has used. The way
 * out of the GUI is the pane's floating Continue in terminal. The settings and Stop live with the composer, where the
 * person is typing when they reach for them.
 */

import type { CSSProperties } from "react";
import {
  mostUsedRateLimit,
  type RateLimit,
  type Transcript,
  type Usage,
} from "../../model/conversation";
import { resetTime } from "../resetTime";

function tokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** How full the context window is, when the CLI has said: 0–100, or undefined. */
export function contextPercent(usage: Usage): number | undefined {
  return usage.contextTokens !== undefined &&
    usage.contextWindow !== undefined &&
    usage.contextWindow > 0
    ? Math.round((usage.contextTokens / usage.contextWindow) * 100)
    : undefined;
}

function contextReadout(usage: Usage): string | undefined {
  if (usage.contextTokens === undefined) return undefined;
  const percent = contextPercent(usage);
  return percent !== undefined
    ? `Context ${percent}% (${tokens(usage.contextTokens)} of ${tokens(usage.contextWindow!)})`
    : `Context ${tokens(usage.contextTokens)}`;
}

function limitReadout(limit: RateLimit): string {
  const used = `${limit.window} limit ${
    limit.usedPercent === undefined ? "?" : Math.round(limit.usedPercent)
  }%`;
  return limit.resetsAt !== undefined
    ? `${used}, resets ${resetTime(limit.resetsAt, Date.now())}`
    : used;
}

/**
 * What the session has spent besides its context: money, and the rate-limit
 * window nearest its limit — the one that stops the CLI first. Every window
 * is in `limitsDetail`.
 */
function spendReadout(usage: Usage): readonly string[] {
  const parts: string[] = [];
  if (usage.costUsd !== undefined) parts.push(`$${usage.costUsd.toFixed(2)}`);
  const most = mostUsedRateLimit(usage.rateLimits ?? []);
  if (most !== undefined) parts.push(limitReadout(most));
  return parts;
}

/** Every rate-limit window the CLI reported, one per line; undefined when none. */
function limitsDetail(usage: Usage): string | undefined {
  const windows = usage.rateLimits ?? [];
  return windows.length === 0
    ? undefined
    : windows.map((one) => limitReadout(one)).join("\n");
}

/** What the session has used, as far as its CLI reports it. */
export function usageReadout(usage: Usage): readonly string[] {
  const context = contextReadout(usage);
  return [...(context === undefined ? [] : [context]), ...spendReadout(usage)];
}

/**
 * The usage line: the context first, with a thin meter of how full it is —
 * the one number that changes what the person does next — and then what was
 * spent, in the same quiet type.
 */
function UsageLine({ usage }: { readonly usage: Usage }) {
  const context = contextReadout(usage);
  const percent = contextPercent(usage);
  const spend = spendReadout(usage);
  if (context === undefined && spend.length === 0) return null;
  return (
    <div className="conversation-usage" aria-label="Usage">
      {context !== undefined ? (
        <span className="conversation-context">
          {percent !== undefined ? (
            <span
              className="conversation-context-meter"
              aria-hidden="true"
              style={
                {
                  "--context-fill": `${Math.min(percent, 100)}%`,
                } as CSSProperties
              }
            />
          ) : null}
          {context}
        </span>
      ) : null}
      {context !== undefined && spend.length > 0 ? " · " : null}
      <span title={limitsDetail(usage)}>{spend.join(" · ")}</span>
    </div>
  );
}

export function SessionHeader({
  transcript,
}: {
  readonly transcript: Transcript;
}) {
  return (
    <header className="conversation-header">
      {transcript.usage ? <UsageLine usage={transcript.usage} /> : null}
    </header>
  );
}

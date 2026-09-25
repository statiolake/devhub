/**
 * The bar over a GUI Agent's transcript: what the session has used. The way
 * out of the GUI is the pane's floating Continue in terminal. The settings and Stop live with the composer, where the
 * person is typing when they reach for them.
 */

import type { CSSProperties } from "react";
import type { Transcript, Usage } from "../../model/conversation";

function tokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function clock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
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

/** What the session has spent besides its context: money and the rate limit. */
function spendReadout(usage: Usage): readonly string[] {
  const parts: string[] = [];
  if (usage.costUsd !== undefined) parts.push(`$${usage.costUsd.toFixed(2)}`);
  const limit = usage.rateLimit;
  if (limit?.usedPercent !== undefined) {
    parts.push(
      limit.resetsAt !== undefined
        ? `Limit ${Math.round(limit.usedPercent)}%, resets ${clock(limit.resetsAt)}`
        : `Limit ${Math.round(limit.usedPercent)}%`,
    );
  }
  return parts;
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
      {spend.join(" · ")}
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

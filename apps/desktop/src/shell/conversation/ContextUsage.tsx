/**
 * How full the Agent's context window is, under the composer.
 *
 * The one usage number that changes what the person does next — a context
 * near its end is a reason to compact or start afresh before the next
 * message — so it sits where the next message is written, small and quiet: a
 * thin meter and the numbers. Nothing else a session has used is drawn in the
 * conversation. Money and per-turn tokens are not drawn at all, and the
 * rate-limit windows, which belong to the CLI's account rather than to this
 * session, are the Sidebar's readout (`sidebar/UsageLimits.tsx`).
 *
 * Nothing is drawn until the CLI has said how many tokens the context holds.
 */

import type { CSSProperties } from "react";
import type { Usage } from "../../model/conversation";
import { usageLevel } from "../usageLevel";

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

export function ContextUsage({ usage }: { readonly usage: Usage | undefined }) {
  if (usage?.contextTokens === undefined) return null;
  const percent = contextPercent(usage);
  const words =
    percent !== undefined
      ? `Context ${percent}% · ${tokens(usage.contextTokens)} of ${tokens(usage.contextWindow!)}`
      : `Context ${tokens(usage.contextTokens)}`;
  return (
    <div
      className="conversation-context"
      role="status"
      aria-label={words}
      data-level={usageLevel(percent)}
    >
      {percent !== undefined ? (
        <span
          className="conversation-context-meter"
          aria-hidden="true"
          style={
            { "--context-fill": `${Math.min(percent, 100)}%` } as CSSProperties
          }
        />
      ) : null}
      {words}
    </div>
  );
}

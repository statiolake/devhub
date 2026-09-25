/**
 * The bar over a GUI Agent's transcript: what the session has used, and the
 * way out of the GUI. The settings and Stop live with the composer, where the
 * person is typing when they reach for them.
 */

import type { Transcript, Usage } from "../../model/conversation";
import { useConversationActions } from "./ConversationContext";

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

/** What the session has used, as far as its CLI reports it. */
export function usageReadout(usage: Usage): readonly string[] {
  const parts: string[] = [];
  if (usage.contextTokens !== undefined) {
    parts.push(
      usage.contextWindow !== undefined && usage.contextWindow > 0
        ? `Context ${Math.round((usage.contextTokens / usage.contextWindow) * 100)}% (${tokens(usage.contextTokens)} of ${tokens(usage.contextWindow)})`
        : `Context ${tokens(usage.contextTokens)}`,
    );
  }
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

export function SessionHeader({
  transcript,
}: {
  readonly transcript: Transcript;
}) {
  const { continueInTerminal, reportFailure } = useConversationActions();
  const readout = transcript.usage ? usageReadout(transcript.usage) : [];
  return (
    <header className="conversation-header">
      {readout.length > 0 ? (
        <div className="conversation-usage" aria-label="Usage">
          {readout.join(" · ")}
        </div>
      ) : null}
      <div className="conversation-header-actions">
        <button
          type="button"
          className="conversation-header-button"
          title="Go on with this session in a terminal Agent"
          onClick={() => {
            void continueInTerminal().catch(reportFailure);
          }}
        >
          Continue in terminal
        </button>
      </div>
    </header>
  );
}

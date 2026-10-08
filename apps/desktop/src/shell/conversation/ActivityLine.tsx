import { useEffect, useState } from "react";
import type { Transcript } from "../../model/conversation";
import {
  activityLabel,
  deriveActivity,
  estimateTokens,
  formatElapsed,
  formatTokens,
} from "./activity";

/**
 * The line on the composer's top edge while a turn runs: a pulsing indicator,
 * what the Agent is doing, how long the turn has taken and roughly how much
 * it has written. Drawn only while a turn runs; it takes no room of its own.
 */
export function ActivityLine({
  transcript,
}: {
  readonly transcript: Transcript;
}) {
  const activity = deriveActivity(transcript);
  const running = activity !== undefined;
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) {
      setStartedAt(undefined);
      return;
    }
    const begun = Date.now();
    setStartedAt((current) => current ?? begun);
    setNow(begun);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  if (activity === undefined) return null;
  const tokens = estimateTokens(transcript);
  const elapsed = formatElapsed(now - (startedAt ?? now));
  return (
    <div
      className="conversation-activity"
      data-phase={activity.phase}
      role="status"
      aria-live="off"
    >
      <span className="conversation-activity-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="conversation-activity-label">
        {activityLabel(activity)}
      </span>
      <span className="conversation-activity-meta">
        {elapsed}
        {tokens > 0 ? ` · ↓ ~${formatTokens(tokens)} tokens` : ""}
      </span>
    </div>
  );
}

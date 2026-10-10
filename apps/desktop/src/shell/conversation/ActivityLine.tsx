import { useEffect, useRef, useState } from "react";
import type { Transcript } from "../../model/conversation";
import {
  type Activity,
  activityLabel,
  deriveActivity,
  estimateTokens,
  formatElapsed,
  formatTokens,
} from "./activity";

/** How long the line takes to fade out once the turn ends (`--motion-base`). */
export const ACTIVITY_EXIT_MS = 180;

/**
 * The line at the end of the transcript while a turn runs, as the CLI draws
 * it: a pulsing indicator, what the Agent is doing, how long the turn has
 * taken and roughly how much it has written. It is the transcript's last
 * child, so a following transcript keeps it in view and one scrolled up is
 * not moved. When the turn ends it fades for a moment, then is gone.
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
    // Kept after the turn ends, so the fading line still says how long it took.
    if (!running) return;
    const begun = Date.now();
    setStartedAt(begun);
    setNow(begun);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  // The last activity, kept through the fade-out after the turn ends.
  const last = useRef<Activity | undefined>(undefined);
  const [, setGone] = useState(0);
  if (activity !== undefined) last.current = activity;
  useEffect(() => {
    if (running || last.current === undefined) return;
    const timer = setTimeout(() => {
      last.current = undefined;
      setGone((count) => count + 1);
    }, ACTIVITY_EXIT_MS);
    return () => clearTimeout(timer);
  }, [running]);
  const shown = activity ?? last.current;
  if (shown === undefined) return null;
  const label = activityLabel(shown);
  const tokens = estimateTokens(transcript);
  const elapsed = formatElapsed(now - (startedAt ?? now));
  return (
    <div
      className="conversation-activity"
      data-phase={shown.phase}
      data-leaving={activity === undefined || undefined}
      role="status"
      aria-live="off"
    >
      <span className="conversation-activity-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {/* Keyed by its words, so a new phase fades in rather than snapping. */}
      <span key={label} className="conversation-activity-label">
        {label}
      </span>
      <span className="conversation-activity-meta">
        {elapsed}
        {tokens > 0 ? ` · ↓ ~${formatTokens(tokens)} tokens` : ""}
      </span>
    </div>
  );
}

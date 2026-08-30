/**
 * What an Agent is doing, as a mark.
 *
 * Four statuses, four silhouettes: a filled disc is working, a ring is waiting
 * for you, a thin outline is idle, a triangle is an error. The colour says the
 * same thing a second time and never the only time — the marks are 8px in a
 * Sidebar row and 8px again on a rail glyph, where hue alone is not something
 * every reader has, and where two dots that differ only in colour are two dots.
 *
 * The same component draws both places, so a status cannot look like one thing
 * in the row and another in the rail.
 */

import type { AgentStatus } from "../../../ipc/appShell";

const STATUS_LABELS: Record<AgentStatus, string> = {
  working: "Working",
  waiting: "Waiting",
  idle: "Idle",
  error: "Error",
};

function StatusShape({ status }: { readonly status: AgentStatus }) {
  switch (status) {
    case "working":
      return <circle cx="5" cy="5" r="3.9" />;
    case "waiting":
      // A ring: open in the middle, because the Agent is open for an answer.
      return <circle className="status-ring" cx="5" cy="5" r="3.1" />;
    case "idle":
      return <circle className="status-outline" cx="5" cy="5" r="3.1" />;
    case "error":
      // The one silhouette that is not a circle at all, so a failure is never
      // one more dot in a column of dots.
      return <path d="M5 0.7 9.5 8.9 H0.5 Z" />;
  }
}

export interface StatusMarkProps {
  readonly status: AgentStatus;
  /** Draw the mark alone; the label stays for a screen reader. */
  readonly compact?: boolean;
}

export function StatusMark({ status, compact = false }: StatusMarkProps) {
  const label = STATUS_LABELS[status];
  return (
    <span
      className={`status-mark status-mark-${status}${compact ? " status-mark-compact" : ""}`}
      title={label}
      aria-label={label}
      role="img"
    >
      <svg className="status-glyph" viewBox="0 0 10 10" focusable="false">
        <StatusShape status={status} />
      </svg>
      {!compact && <span className="status-mark-label">{label}</span>}
    </span>
  );
}

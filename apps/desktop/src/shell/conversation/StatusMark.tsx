/**
 * How a call's work is going, drawn once for everywhere it is drawn: a tool
 * call's row, a subagent's pane and the background tasks under the composer.
 *
 * The glyph at the left says the state, and carries the state's word as its
 * accessible name and tooltip. The words at the right (`workNote`) say only
 * what the glyph cannot: that the work runs in the background, a command's
 * exit code, a call that was denied rather than failed. A plain Running or
 * Done is the glyph alone.
 */

import {
  workState,
  type ToolEntry,
  type WorkState,
} from "../../model/conversation";

export const WORK_STATE_LABELS: Readonly<Record<WorkState, string>> = {
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  denied: "Denied",
  interrupted: "Interrupted",
  idle: "Idle",
  unknown: "Unknown",
};

export function StatusMark({ state }: { readonly state: WorkState }) {
  const label = WORK_STATE_LABELS[state];
  return (
    <span
      className="conversation-tool-mark"
      data-status={state}
      role="img"
      aria-label={label}
      title={label}
    />
  );
}

/** The states whose glyph does not say them alone: ✕ is Failed and Denied both. */
const NAMED_STATES: ReadonlySet<WorkState> = new Set([
  "denied",
  "interrupted",
  "idle",
  "unknown",
]);

/**
 * What a call's row says at its right, beside the glyph: only what the glyph
 * does not. Undefined when there is nothing more to say.
 */
export function workNote(entry: ToolEntry): string | undefined {
  const state = workState(entry);
  const notes: string[] = [];
  if (NAMED_STATES.has(state)) notes.push(WORK_STATE_LABELS[state]);
  if (state === "running" && entry.status === "succeeded")
    notes.push("In the background");
  for (const part of entry.output ?? []) {
    if (part.kind === "command" && (part.exitCode ?? 0) !== 0)
      notes.push(`Exit code ${part.exitCode}`);
  }
  return notes.length === 0 ? undefined : notes.join(" · ");
}

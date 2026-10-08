/**
 * What the Agent is doing while a turn runs, for the composer's status line.
 * Derived from the Transcript alone: a thinking block streaming, text
 * streaming, a call running, a request waiting — nothing is added to the
 * adapters' events. Before any of them, the turn is waiting for the model's
 * first token, which reads as thinking.
 */

import type { Transcript } from "../../model/conversation";

export type Activity =
  | { readonly phase: "thinking" }
  | { readonly phase: "responding" }
  | { readonly phase: "tool"; readonly tool: string }
  | { readonly phase: "permission" }
  | { readonly phase: "compacting" };

/** `undefined` when no turn is running. */
export function deriveActivity(transcript: Transcript): Activity | undefined {
  const { state } = transcript;
  if (state.phase !== "ready" || state.turn !== "running") return undefined;
  if (transcript.requests.length > 0) return { phase: "permission" };
  if (transcript.compacting) return { phase: "compacting" };
  const { entries } = transcript;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.kind === "user" || entry.kind === "turn-end") break;
    if (entry.kind === "assistant" && entry.streaming) {
      const last = entry.blocks[entry.blocks.length - 1];
      return { phase: last?.kind === "text" ? "responding" : "thinking" };
    }
    if (entry.kind === "tool" && entry.status === "running") {
      return { phase: "tool", tool: entry.tool };
    }
  }
  return { phase: "thinking" };
}

/**
 * A rough count of the tokens the Agent has produced since the person's last
 * message (characters over four), from the thinking and text it has streamed.
 */
export function estimateTokens(transcript: Transcript): number {
  let chars = 0;
  const { entries } = transcript;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.kind === "user" || entry.kind === "turn-end") break;
    if (entry.kind !== "assistant") continue;
    for (const block of entry.blocks) {
      if (block.kind === "text") chars += block.markdown.length;
      else if (block.kind === "thinking") chars += block.text.length;
    }
  }
  return Math.round(chars / 4);
}

export function activityLabel(activity: Activity): string {
  switch (activity.phase) {
    case "thinking":
      return "Thinking…";
    case "responding":
      return "Responding…";
    case "tool":
      return `Running ${activity.tool}…`;
    case "permission":
      return "Waiting for permission";
    case "compacting":
      return "Compacting…";
  }
}

/** `45s`, `2m 05s`. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** `850`, `1.2k`. */
export function formatTokens(count: number): string {
  return count < 1000 ? String(count) : `${(count / 1000).toFixed(1)}k`;
}

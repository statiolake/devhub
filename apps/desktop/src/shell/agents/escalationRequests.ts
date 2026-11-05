/**
 * "Open escalation #N on the board", asked from anywhere on the Agents page —
 * a `devhub:escalation` link in a chat answer, or in another escalation's
 * thread (`devhubLinks.tsx`).
 *
 * The board's reading view is the board's own state (`navStack.ts`), and the
 * board may not even be mounted when the link is clicked: the click selects
 * the Orchestrator row first (`select_context`, `reason: "explicit"`). So the
 * request waits here until the board takes it — at once when it is on
 * screen, or when it mounts.
 */

import { useEffect, useRef } from "react";

let pending: number | undefined;
const listeners = new Set<(id: number) => void>();

/** Ask the board to open `id`. The newest request wins. */
export function requestEscalation(id: number): void {
  pending = id;
  for (const listener of [...listeners]) listener(id);
}

/** The request waiting, taken: the board opens it once. */
export function takeEscalationRequest(): number | undefined {
  const id = pending;
  pending = undefined;
  return id;
}

/** Be told of each request as it is made. */
export function onEscalationRequest(
  listener: (id: number) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Answer the requests from a component: the one waiting when it mounts, and
 * each one after. `take` consumes it (the board, which opens it); without,
 * it is only looked at (the screen, which shows the board tab for it).
 */
export function useEscalationRequests(
  handler: (id: number) => void,
  take: boolean,
): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    const waiting = take ? takeEscalationRequest() : pending;
    if (waiting !== undefined) latest.current(waiting);
    return onEscalationRequest((id) => {
      if (take) takeEscalationRequest();
      latest.current(id);
    });
  }, [take]);
}

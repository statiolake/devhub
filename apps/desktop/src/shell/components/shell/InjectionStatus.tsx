/**
 * What became of a message DevHub was asked to type into an Agent.
 *
 * Assigning an Issue and the Agent actions sheet (`Cmd+Q Shift+A`) do not type
 * anything when they are used: they queue a sentence (`main/agent/
 * injection.ts`), which waits until the wording is agreed and the Agent's
 * screen has settled. So the only honest place to read what happened to it is
 * the queue, and this is where the pane says it — in the corner, over the
 * Agent it is about, only while there is something to say.
 *
 * One line for what is waiting, and one for how the last one ended, replaced
 * by the next one and cleared when something new is queued — a rule that does
 * not depend on which ending it is, so a new kind of ending cannot arrive with
 * nobody having chosen to show it. A failure is an alert, in the failure ink.
 */

import type { AgentSnapshot } from "../../../ipc/appShell";

/** Why the message on the front of the queue has not gone yet, in words. */
function waitingNote(injection: AgentSnapshot["injection"]): string {
  const many =
    injection.queued === 1 ? "" : ` (${String(injection.queued)} waiting)`;
  switch (injection.waitingFor) {
    case "awaiting_review":
      return `Waiting for you to confirm the wording${many}`;
    case "agent_busy":
      return `Waiting for the agent to finish its turn${many}`;
    case "agent_asking":
      return `The agent is asking a question; nothing is typed into that${many}`;
    case "agent_unreadable":
      return `DevHub cannot read this agent's screen${many}`;
    default:
      return `Waiting for a prompt to send it${many}`;
  }
}

/** How the last one ended. */
function resultNote(
  result: NonNullable<AgentSnapshot["injection"]["lastResult"]>,
): string {
  switch (result.kind) {
    case "sent":
      return "Sent to the agent.";
    case "cancelled":
      return "Cancelled — nothing was sent.";
    default:
      return result.reason;
  }
}

export function InjectionStatus({ agent }: { readonly agent: AgentSnapshot }) {
  const { queued, lastResult } = agent.injection;
  if (queued === 0 && lastResult === undefined) return null;
  return (
    <div className="agent-injection-status">
      {queued > 0 ? (
        <p className="agent-injection-note" role="status">
          {waitingNote(agent.injection)}
        </p>
      ) : null}
      {lastResult ? (
        <p
          className={
            lastResult.kind === "failed"
              ? "agent-injection-failure"
              : "agent-injection-note"
          }
          role={lastResult.kind === "failed" ? "alert" : "status"}
        >
          {resultNote(lastResult)}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The floating way to carry an Agent's session on in its other presentation:
 * "Continue in terminal" over a GUI Agent's conversation, "Continue in GUI"
 * over a terminal Claude or Codex Agent. Each starts a new Agent from the same
 * profile resuming the session, and stops this one once that one runs (the
 * coordinator's `continue_agent`).
 *
 * A corner control that rests translucent over the work and comes up to full
 * when pointed at or focused. Both directions are this one control in one
 * place: the top right corner of the Agent's own column, the element its
 * surface marks `data-agent-column` — a terminal is its own column, a
 * conversation's is the one beside its subagents, so the button never sits
 * over them. The one rule is `continueElsewhere.css`'s; the only thing
 * measured here is how wide whatever is beside that column is, which is
 * nothing for a terminal. It used to be two rules — over a terminal the top
 * right corner of the pane, over a conversation just above the composer —
 * and switching between two Agents moved it (the bottom right is where the
 * pane says what became of a queued message, `InjectionStatus.tsx`).
 *
 * It is the same size in both, too: both labels are laid out in the one
 * cell, the one it does not say unseen, so it is as wide as the longer.
 *
 * It is always offered while the Agent runs. Pressed while the Agent is not
 * idle, main asks first (`Coordinator.askAbout`), because the continue stops
 * the CLI and whatever it is in the middle of.
 *
 * What it could not do goes to the page's root like every other failure here.
 */

import { useLayoutEffect, useRef, useState } from "react";
import type { AgentWire } from "../../ipc/appShell";
import { useAgents } from "./AgentsContext";
import { devhub } from "./client";
import "./continueElsewhere.css";

/** Whether an Agent of this kind has both presentations, and so a way to the other. */
export function continuesElsewhere(agent: AgentWire): boolean {
  return agent.profileKind === "claude" || agent.profileKind === "codex";
}

const LABELS = {
  toTerminal: "Continue in terminal",
  toGui: "Continue in GUI",
} as const;

export function ContinueElsewhere({ agent }: { readonly agent: AgentWire }) {
  const { reportFailure } = useAgents();
  const own = useRef<HTMLDivElement | null>(null);
  const toTerminal = agent.presentation === "gui";
  const beside = useBesideTheColumn(own, agent.id);
  return (
    <div
      ref={own}
      className="agent-continue"
      style={
        beside === undefined
          ? undefined
          : ({
              "--agent-continue-beside": `${String(beside)}px`,
            } as React.CSSProperties)
      }
    >
      <button
        type="button"
        className="agent-continue-button"
        aria-label={toTerminal ? LABELS.toTerminal : LABELS.toGui}
        title={
          toTerminal
            ? "Go on with this session in a terminal Agent, and stop this one"
            : "Go on with this session in a GUI Agent, and stop this one"
        }
        onClick={() => {
          const bridge = devhub().conversation;
          void (
            toTerminal
              ? bridge.continueInTerminal(agent.id)
              : bridge.continueInGui(agent.id)
          ).catch(reportFailure);
        }}
      >
        <span className="agent-continue-label" aria-hidden={!toTerminal}>
          {LABELS.toTerminal}
        </span>
        <span className="agent-continue-label" aria-hidden={toTerminal}>
          {LABELS.toGui}
        </span>
      </button>
    </div>
  );
}

/**
 * How wide whatever is beside Agent `agentId`'s own column is, from the
 * pane's right edge: the subagents' column beside a conversation, nothing
 * beside a terminal. Kept current as either changes.
 */
function useBesideTheColumn(
  own: React.RefObject<HTMLDivElement | null>,
  agentId: string,
): number | undefined {
  const [beside, setBeside] = useState<number>();
  useLayoutEffect(() => {
    const pane = own.current?.parentElement;
    const column = pane?.querySelector<HTMLElement>(
      `[data-surface-key="agent:${agentId}"] [data-agent-column], [data-surface-key="agent:${agentId}"][data-agent-column]`,
    );
    if (!pane || !column) {
      throw new Error(
        `Agent ${agentId} is on screen with no column of its own to sit in the corner of`,
      );
    }
    const measure = () => {
      setBeside(
        pane.getBoundingClientRect().right -
          column.getBoundingClientRect().right,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const each of [pane, column]) observer.observe(each);
    return () => observer.disconnect();
  }, [own, agentId]);
  return beside;
}

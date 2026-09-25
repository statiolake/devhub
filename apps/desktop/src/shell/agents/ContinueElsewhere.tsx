/**
 * The floating way to carry an Agent's session on in its other presentation:
 * "Continue in terminal" over a GUI Agent's conversation, "Continue in GUI"
 * over a terminal Claude or Codex Agent. Each starts a new Agent from the same
 * profile resuming the session, and stops this one once that one runs (the
 * coordinator's `continue_agent`).
 *
 * A corner control like the Agent shortcuts, under the same rule: it rests
 * translucent over the work and comes up to full when pointed at or focused.
 * Over a conversation it sits at the right of the conversation's own column
 * (never over the subagents beside it), just above the composer; over a
 * terminal, in the top right corner,
 * since the bottom right is the shortcuts'.
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

export function ContinueElsewhere({ agent }: { readonly agent: AgentWire }) {
  const { reportFailure } = useAgents();
  const own = useRef<HTMLDivElement | null>(null);
  const toTerminal = agent.presentation === "gui";
  const corner = useConversationCorner(own, toTerminal ? agent.id : undefined);
  return (
    <div
      ref={own}
      className={`agent-continue${toTerminal ? " is-above-composer" : ""}`}
      style={
        corner === undefined
          ? undefined
          : {
              right: `calc(${String(corner.right)}px + var(--space-3))`,
              bottom: `calc(${String(corner.bottom)}px + var(--space-2))`,
            }
      }
    >
      <button
        type="button"
        className="agent-shortcut"
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
        <span className="agent-shortcut-label">
          {toTerminal ? "Continue in terminal" : "Continue in GUI"}
        </span>
      </button>
    </div>
  );
}

/**
 * Where the conversation's own column leaves room in the pane of Agent
 * `agentId`, from the pane's right and bottom edges: the width of whatever is
 * beside the column (the subagents'), and the composer's height with what is
 * under it. Kept current as either changes; `undefined` for no Agent.
 */
function useConversationCorner(
  own: React.RefObject<HTMLDivElement | null>,
  agentId: string | undefined,
): { readonly right: number; readonly bottom: number } | undefined {
  const [corner, setCorner] = useState<{
    readonly right: number;
    readonly bottom: number;
  }>();
  useLayoutEffect(() => {
    if (agentId === undefined) {
      setCorner(undefined);
      return;
    }
    const pane = own.current?.parentElement;
    const composer = pane?.querySelector<HTMLElement>(
      `[data-surface-key="agent:${agentId}"] .conversation-composer`,
    );
    const column = composer?.closest<HTMLElement>(".conversation-main");
    if (!pane || !composer || !column) {
      throw new Error(
        `the conversation of Agent ${agentId} is on screen with no composer in its column to sit above`,
      );
    }
    const measure = () => {
      const edges = pane.getBoundingClientRect();
      setCorner({
        right: edges.right - column.getBoundingClientRect().right,
        bottom: edges.bottom - composer.getBoundingClientRect().top,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const each of [pane, column, composer]) observer.observe(each);
    return () => observer.disconnect();
  }, [own, agentId]);
  return corner;
}

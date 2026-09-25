/**
 * The floating way to carry an Agent's session on in its other presentation:
 * "Continue in terminal" over a GUI Agent's conversation, "Continue in GUI"
 * over a terminal Claude or Codex Agent. Each starts a new Agent from the same
 * profile resuming the session, and stops this one once that one runs (the
 * coordinator's `continue_agent`).
 *
 * A corner control like the Agent shortcuts, under the same rule: it rests
 * translucent over the work and comes up to full when pointed at or focused.
 * Over a conversation it sits at the right just above the composer, where the
 * transcript's column leaves room; over a terminal, in the top right corner,
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
  const aboveComposer = useComposerHeight(
    own,
    toTerminal ? agent.id : undefined,
  );
  return (
    <div
      ref={own}
      className={`agent-continue${toTerminal ? " is-above-composer" : ""}`}
      style={
        aboveComposer === undefined
          ? undefined
          : { bottom: `calc(${String(aboveComposer)}px + var(--space-2))` }
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
 * The height of the conversation's composer in the pane of Agent `agentId`,
 * kept current as it grows with what is typed; `undefined` for no Agent.
 */
function useComposerHeight(
  own: React.RefObject<HTMLDivElement | null>,
  agentId: string | undefined,
): number | undefined {
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    if (agentId === undefined) {
      setHeight(undefined);
      return;
    }
    const composer = own.current?.parentElement?.querySelector<HTMLElement>(
      `[data-surface-key="agent:${agentId}"] .conversation-composer`,
    );
    if (!composer) {
      throw new Error(
        `the conversation of Agent ${agentId} is on screen with no composer to sit above`,
      );
    }
    const measure = () => setHeight(composer.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(composer);
    return () => observer.disconnect();
  }, [own, agentId]);
  return height;
}

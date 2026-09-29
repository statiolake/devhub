import { useMemo } from "react";
import type { AppAppearance, AppSnapshot } from "../../ipc/appShell";
import { runningAgentSurfaces } from "../components/shell/surfacePool";
import { AgentFailure } from "./AgentFailure";
import { TerminalSurface } from "../terminal/TerminalSurface";
import { InjectionStatus } from "../components/shell/InjectionStatus";
import { SmartButtons } from "./SmartButtons";
import { ConversationPane } from "./ConversationPane";
import { ContinueElsewhere, continuesElsewhere } from "./ContinueElsewhere";
import type { AgentWire } from "../../ipc/appShell";

/**
 * Every running Agent, mounted; the selected one shown.
 *
 * Whether this is the whole content area or the trailing share of a split is
 * not a question this component has any part in: the view it is drawn in *is*
 * the rectangle the owner decided, and the two presentations that used to be a
 * `data-` attribute here are two rectangles in `main/shell/windowLayout.ts`.
 *
 * The pool is why switching between two Agents does not restart either of
 * them: a parked surface keeps its attachment and its scrollback, and coming
 * back to it is unhiding it. There is no cheaper set to keep — these are the
 * Agents the person started.
 */
export function AgentPane({
  snapshot,
  appearance,
  activeKey,
}: {
  readonly snapshot: AppSnapshot;
  readonly appearance: AppAppearance | undefined;
  /**
   * The Agent on screen, as the projection says. `undefined` is "none of
   * them", which is every moment this view is not drawn at all.
   */
  readonly activeKey: string | undefined;
}) {
  const pool = useMemo(() => runningAgentSurfaces(snapshot), [snapshot]);
  // What floats over the pane belongs to the Agent on screen and to no other.
  // The pool keeps every running Agent mounted so that coming back to one is
  // unhiding a pane, not drawing its corner again for each hidden one.
  const active = snapshot.workspaces
    .flatMap((workspace) => workspace.agents)
    .find((agent) => `agent:${agent.id}` === activeKey);
  return (
    <div className="agent-pane" hidden={activeKey === undefined}>
      {[...pool.values()].map((surface) => (
        <div
          className="surface-pool-entry"
          key={surface.key}
          data-surface-key={surface.key}
          // A terminal is its own column; a conversation marks the one it
          // has beside its subagents. Its top right corner is where the
          // Continue button sits (`ContinueElsewhere`).
          {...(surface.presentation === "tui"
            ? { "data-agent-column": "" }
            : {})}
          hidden={surface.key !== activeKey}
        >
          {/* The one place the two presentations differ on this page: which
              surface the pane is. Everything around it — the pool, the
              failure drawn over it, the Smart Buttons — is the same pane. */}
          {surface.presentation === "gui" ? (
            <ConversationPane
              agentId={surface.agentId}
              label={surface.label}
              cli={cliName(snapshot, surface.agentId)}
              appearance={appearance}
              hidden={surface.key !== activeKey}
            />
          ) : (
            <TerminalSurface
              surfaceKey={surface.key}
              surfaceLabel={surface.label}
              appearance={appearance}
              hidden={surface.key !== activeKey}
              // The Sidebar already names the Agent on screen; a title inside
              // the pane would say it twice.
              hideTitle
            />
          )}
        </div>
      ))}
      {active ? (
        <OverThePane key={active.id} agent={active} snapshot={snapshot} />
      ) : null}
    </div>
  );
}

/**
 * What floats over the pane, all of it the Agent on screen's: one subtree
 * keyed by that Agent, so switching Agents draws it afresh, and no two of its
 * parts can share a key among the pane's children — which the Smart Buttons
 * and the Continue button once did, both keyed by the Agent's id, and React
 * left the old box behind and mounted a new one on every snapshot after a
 * drag.
 */
function OverThePane({
  agent: active,
  snapshot,
}: {
  readonly agent: AgentWire;
  readonly snapshot: AppSnapshot;
}) {
  return (
    <>
      {/* A failure about this Agent is drawn over this Agent's pane, because
          that is where its subject is: a sheet over the pane dimmed, then a
          banner once dismissed (`AgentFailure`). Keyed by the failure, so a
          different one is asked about afresh; retired by the next reading
          that does not say it. */}
      {active.failure ? (
        <AgentFailure
          key={`${active.failure.code}\n${active.failure.detail ?? ""}`}
          agent={active}
          failure={active.failure}
        />
      ) : null}
      <InjectionStatus agent={active} />
      {/* After the status, so a terminal's buttons can stand on it. Not over
          a failure: the failure's actions are what the pane offers then. */}
      {active.failure === undefined ? (
        <SmartButtons
          agent={active}
          stored={snapshot.smartButtons[active.presentation]}
        />
      ) : null}
      {/* The way to the other presentation, while the pane is the Agent's
          own: over a failure, the failure's actions are the way out. Offered
          whatever the Agent is doing; main asks first when it is not idle. */}
      {active.failure === undefined &&
      active.controlState.kind === "running" &&
      continuesElsewhere(active) ? (
        <ContinueElsewhere agent={active} />
      ) : null}
    </>
  );
}

/** The name of the CLI an Agent runs, as `/resume`'s picker says it. */
function cliName(snapshot: AppSnapshot, agentId: string): string {
  const agent = snapshot.workspaces
    .flatMap((workspace) => workspace.agents)
    .find((candidate) => candidate.id === agentId);
  if (agent === undefined) {
    throw new Error(
      `the pool has a surface for Agent ${agentId}, which the snapshot does not`,
    );
  }
  switch (agent.profileKind) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    default:
      return agent.profileKind;
  }
}

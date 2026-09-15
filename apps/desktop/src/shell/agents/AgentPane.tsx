import { useMemo } from "react";
import type { AppAppearance, AppSnapshot } from "../../ipc/appShell";
import { useAppShell } from "../useAppShell";
import { runningAgentSurfaces } from "../components/shell/surfacePool";
import { agentFailureSummary } from "../components/shell/diagnosticLabel";
import { Failure } from "../components/shell/SurfaceState";
import { TerminalSurface } from "../terminal/TerminalSurface";
import { AgentShortcuts } from "../components/shell/AgentShortcuts";

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
  const { repositoryStatus } = useAppShell();
  const pool = useMemo(() => runningAgentSurfaces(snapshot), [snapshot]);
  // The shortcuts belong to the Agent on screen and to no other. The pool
  // keeps every running Agent mounted so that coming back to one is unhiding a
  // pane, and a set of buttons per hidden pane would be three more things
  // reading the projection for a workspace nobody is looking at.
  const active = snapshot.workspaces
    .flatMap((workspace) => workspace.agents)
    .find((agent) => `agent:${agent.id}` === activeKey);
  const repository = active
    ? repositoryStatus.workspaces.find(
        (entry) => entry.workspaceId === active.workspaceId,
      )
    : undefined;
  return (
    <div className="agent-pane" hidden={activeKey === undefined}>
      {[...pool.values()].map((surface) => (
        <div
          className="surface-pool-entry"
          key={surface.key}
          hidden={surface.key !== activeKey}
        >
          <TerminalSurface
            surfaceKey={surface.key}
            surfaceLabel={surface.label}
            appearance={appearance}
            hidden={surface.key !== activeKey}
            // The Sidebar already names the Agent on screen; a title inside
            // the pane would say it twice.
            hideTitle
          />
        </div>
      ))}
      {/* A failure about this Agent is drawn over this Agent's pane, because
          that is where its subject is. It covers nothing else: the sidebar,
          the workbench and every other Agent stay usable, which is the whole
          difference between this and the app-wide alert it used to be.

          There is no dismiss and no timer. It is retired by the next
          reconcile that reads this Agent, so the pane simply stops drawing it
          when the condition stops being true — and goes on saying it for as
          long as it is true, which a dismissible banner could not. */}
      {active?.failure ? (
        <div className="agent-pane-failure">
          {/* The code's own sentence leads, and the detail is whatever the
              raising site was allowed to carry. A fixed summary over the top
              of it would put "could not be reached" above a runtime that
              answered and refused — the very conflation this split exists to
              undo. */}
          <Failure
            summary={agentFailureSummary(active.failure.code)}
            {...(active.failure.detail === undefined
              ? {}
              : { detail: active.failure.detail })}
          />
        </div>
      ) : null}
      {active ? (
        <AgentShortcuts agent={active} repository={repository} />
      ) : null}
    </div>
  );
}

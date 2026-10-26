/**
 * One Agent's terminal pane: a terminal surface on that terminal's tmux
 * session, filling the view. No header, no close button, no focus mark.
 *
 * # Where this view is
 *
 * Right of whatever the selection shows, when its Agent is the view's and the
 * pane is open (`model/agentTerminal.ts`, laid out by
 * `main/shell/windowLayout.ts`). The divider left of it is not here: it is the
 * strip no view covers, drawn on the window's own page, which is the only way
 * a pointer can meet the pixels the eye sees between two native views.
 *
 * # Its contract with main
 *
 * - **reads**: the snapshot (its Agent's name, and that its terminal still
 *   exists), the appearance (the terminal's font and theme), the palette.
 * - **is pushed**: `snapshotChanged`, `appearanceChanged`, `themeChanged`.
 * - **asks**: the terminal channels only. Closing is main's: `Cmd+Q X`, the
 *   shell exiting, `devhub --tell terminal close`.
 * - **draws no failure it raised**: what goes wrong here is handed to main.
 *
 * A person who wants a second shell splits inside it with tmux's own keys;
 * DevHub draws one terminal pane.
 *
 * # The editor area, in terminal mode
 *
 * The same page is the editor area when there is no VS Code workbench
 * (`docs/terminal-mode.md`): a fragment of `workspace:<id>` names a
 * Workspace instead of an Agent terminal, and the surface is that
 * Workspace's own tmux session (`workspace-terminal:<id>`) — the session the
 * editor's DevHub terminal tabs attach to in VS Code mode. One terminal
 * surface for both, not a second implementation.
 */

import { useMemo } from "react";
import { devhub } from "./client";
import {
  useAppearance,
  useProjection,
  useRaiseFailure,
} from "../model/pageModel";
import { TerminalSurface } from "../terminal/TerminalSurface";
import type {
  AgentTerminalWire,
  AgentWire,
  AppSnapshot,
} from "../../ipc/appShell";
import {
  paneTerminalSurfaceKey,
  workspaceTerminalSurfaceKey,
} from "../../ipc/terminal";

/** The fragment that names a Workspace's editor-area terminal. */
const WORKSPACE_FRAGMENT = "workspace:";

export function PaneApp({ terminalId }: { readonly terminalId: string }) {
  const bridge = useMemo(() => devhub(), []);
  const reportFailure = useRaiseFailure(bridge);
  // This page asks no questions; a confirmation, should one ever come back
  // from a dispatch here, is the picker's to draw.
  const { state, attempt } = useProjection(bridge, reportFailure, () => {});
  const appearance = useAppearance(bridge, reportFailure, attempt);
  if (state.status !== "ready") return null;
  if (terminalId.startsWith(WORKSPACE_FRAGMENT)) {
    const workspaceId = terminalId.slice(WORKSPACE_FRAGMENT.length);
    const workspace = state.snapshot.workspaces.find(
      (candidate) => candidate.id === workspaceId,
    );
    // Like an Agent terminal's: main takes the view away once its Workspace
    // is gone from the model.
    if (!workspace) return null;
    return (
      <div className="app-shell pane-page">
        <div className="pane-body">
          <TerminalSurface
            surfaceKey={workspaceTerminalSurfaceKey(workspaceId)}
            surfaceLabel={`${workspace.label} terminal`}
            appearance={appearance}
            hideTitle
          />
        </div>
      </div>
    );
  }
  const found = findTerminal(state.snapshot, terminalId);
  // The pane outlives its terminal by at most one projection: main takes the
  // view away once the terminal is gone from the model.
  if (!found) return null;
  const name = `${found.agent.displayName}'s terminal`;
  return (
    <div className="app-shell pane-page">
      <div className="pane-body">
        <TerminalSurface
          surfaceKey={paneTerminalSurfaceKey(terminalId)}
          surfaceLabel={name}
          appearance={appearance}
          hideTitle
        />
      </div>
    </div>
  );
}

function findTerminal(
  snapshot: AppSnapshot,
  terminalId: string,
):
  | { readonly agent: AgentWire; readonly terminal: AgentTerminalWire }
  | undefined {
  for (const workspace of snapshot.workspaces) {
    for (const agent of workspace.agents) {
      if (agent.terminal?.id === terminalId) {
        return { agent, terminal: agent.terminal };
      }
    }
  }
  return undefined;
}

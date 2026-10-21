/**
 * One Agent's terminal pane: a header that says whose terminal this is and
 * which tmux session, and a terminal surface on that session.
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
 * - **reads**: the snapshot (its Agent's name, this terminal's session, and
 *   whether it has the keyboard), the appearance (the terminal's font and
 *   theme), the palette.
 * - **is pushed**: `snapshotChanged`, `appearanceChanged`, `themeChanged`.
 * - **asks**: the terminal channels, and `closePaneTerminal` (the ×).
 * - **draws no failure it raised**: what goes wrong here is handed to main.
 *
 * The header names the session the way tmux does — `tm-<id>` — because that
 * is what an Agent driving it reports to the person ("I am running the tests
 * in tm-…"), and what `tmux -S … -t` takes. A person who wants a second shell
 * splits inside it with tmux's own keys; DevHub draws one terminal pane.
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
import { paneTerminalSurfaceKey } from "../../ipc/terminal";

export function PaneApp({ terminalId }: { readonly terminalId: string }) {
  const bridge = useMemo(() => devhub(), []);
  const reportFailure = useRaiseFailure(bridge);
  // This page asks no questions; a confirmation, should one ever come back
  // from a dispatch here, is the picker's to draw.
  const { state, attempt } = useProjection(bridge, reportFailure, () => {});
  const appearance = useAppearance(bridge, reportFailure, attempt);
  if (state.status !== "ready") return null;
  const found = findTerminal(state.snapshot, terminalId);
  // The pane outlives its terminal by at most one projection: main takes the
  // view away once the terminal is gone from the model.
  if (!found) return null;
  const name = `${found.agent.displayName}'s terminal`;
  return (
    <div
      className="app-shell pane-page"
      data-focused={state.snapshot.paneFocus === terminalId ? "" : undefined}
    >
      <div
        className="pane-header"
        title={`tmux session ${found.terminal.session}. Split it with tmux's own keys.`}
      >
        <span className="pane-name">{name}</span>
        <span className="pane-session">{found.terminal.session}</span>
        <button
          type="button"
          className="pane-close"
          aria-label={`Close ${name}`}
          onClick={() => {
            void bridge.closePaneTerminal(terminalId).catch(reportFailure);
          }}
        >
          ×
        </button>
      </div>
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

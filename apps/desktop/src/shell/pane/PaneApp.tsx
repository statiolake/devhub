/**
 * One terminal pane: a terminal surface on a tmux session, filling the view.
 * No header, no close button, no focus mark. Either an Agent's terminal
 * (`pane.html#<terminal id>`, its `tm-` session), or — with
 * `[general] editor = "neovim"` — a Workspace's editor area
 * (`pane.html#ws:<workspace id>`, its `ws-` session), which is attached again
 * by itself when its session ends: a Workspace's terminal is a place.
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
 * - **is pushed**: `snapshotChanged`, `appearanceChanged`, `themeChanged`,
 *   the Neovims over its panes and keystrokes for them.
 * - **asks**: the terminal channels, and the Neovims' (`neovim`). Closing is main's: `Cmd+Q X`, the
 *   shell exiting, `devhub --tell terminal close`.
 * - **draws no failure it raised**: what goes wrong here is handed to main.
 *
 * A person who wants a second shell splits inside it with tmux's own keys;
 * DevHub draws one terminal pane.
 *
 * # Neovim in it
 *
 * A Neovim DevHub draws over one of the terminal's panes is drawn here, in
 * that pane (`PaneNeovims.tsx`): one page, one layer model, and the pane's
 * motion moves it (docs/rendering-layers.md, docs/pane-motion.md).
 */

import { useCallback, useMemo } from "react";
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
  workspaceOfTerminalPage,
  workspaceTerminalSurfaceKey,
} from "../../ipc/terminal";
import type { TerminalPanesWire } from "../../ipc/contract";
import { PaneNeovimViews, PaneNeovims } from "./PaneNeovims";

export function PaneApp({ terminalId }: { readonly terminalId: string }) {
  const bridge = useMemo(() => devhub(), []);
  const reportFailure = useRaiseFailure(bridge);
  // This page asks no questions; a confirmation, should one ever come back
  // from a dispatch here, is the picker's to draw.
  const { state, attempt } = useProjection(bridge, reportFailure, () => {});
  const appearance = useAppearance(bridge, reportFailure, attempt);
  const reportPanes = useCallback(
    (panes: TerminalPanesWire | null) => {
      bridge.reportTerminalPanes(terminalId, panes);
    },
    [bridge, terminalId],
  );
  // The Neovims drawn over this terminal's panes, drawn in this page.
  const neovims = useMemo(() => new PaneNeovims(), []);
  if (state.status !== "ready") return null;
  const workspaceId = workspaceOfTerminalPage(terminalId);
  const workspace =
    workspaceId === undefined
      ? undefined
      : state.snapshot.workspaces.find((one) => one.id === workspaceId);
  const found =
    workspaceId === undefined
      ? findTerminal(state.snapshot, terminalId)
      : undefined;
  // The pane outlives its terminal by at most one projection: main takes the
  // view away once the terminal is gone from the model.
  if (!found && !workspace) return null;
  const name = found
    ? `${found.agent.displayName}'s terminal`
    : `${workspace?.label ?? "Workspace"} terminal`;
  return (
    <div className="app-shell pane-page">
      <div className="pane-body">
        <TerminalSurface
          surfaceKey={
            workspaceId === undefined
              ? paneTerminalSurfaceKey(terminalId)
              : workspaceTerminalSurfaceKey(workspaceId)
          }
          surfaceLabel={name}
          appearance={appearance}
          hideTitle
          reattachOnExit={workspaceId !== undefined}
          onControlPanes={reportPanes}
          neovims={neovims}
        />
        <PaneNeovimViews
          terminalId={terminalId}
          bridge={bridge}
          appearance={appearance}
          neovims={neovims}
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

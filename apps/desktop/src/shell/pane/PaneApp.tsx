/**
 * One terminal pane: a header that says which tmux session this is, and a
 * terminal surface on that session.
 *
 * # Where this view is
 *
 * Wherever the owner puts it — one leaf of the selected Workspace's tiling
 * (`model/paneLayout.ts`, laid out by `main/shell/windowLayout.ts`). The seams
 * between panes are not here: they are the strips no view covers, drawn on
 * the window's own page, which is the only way a pointer can meet the pixels
 * the eye sees between two native views.
 *
 * # Its contract with main
 *
 * - **reads**: the snapshot (this terminal's name and session, and whether it
 *   has the keyboard), the appearance (the terminal's font and theme), the
 *   palette.
 * - **is pushed**: `snapshotChanged`, `appearanceChanged`, `themeChanged`.
 * - **asks**: the terminal channels, `closePaneTerminal` (the ×), and
 *   `dropPaneHeader` (the header dragged somewhere else).
 * - **draws no failure it raised**: what goes wrong here is handed to main.
 *
 * The header names the session the way tmux does — `tm-<id>` — because that
 * is what an Agent driving it reports to the person ("I am running the tests
 * in tm-…"), and what `tmux -S … -t` takes.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { devhub } from "./client";
import {
  useAppearance,
  useProjection,
  useRaiseFailure,
} from "../model/pageModel";
import { TerminalSurface } from "../terminal/TerminalSurface";
import type { AppSnapshot, PaneTerminalWire } from "../../ipc/appShell";
import { paneTerminalSurfaceKey } from "../../ipc/terminal";

/** How far the pointer has to travel before a press on the header is a drag. */
const DRAG_THRESHOLD = 6;

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
  return (
    <div
      className="app-shell pane-page"
      data-focused={state.snapshot.paneFocus === terminalId ? "" : undefined}
    >
      <PaneHeader
        terminal={found}
        onClose={() => {
          void bridge.closePaneTerminal(terminalId).catch(reportFailure);
        }}
        onDrop={(x, y) => {
          void bridge.dropPaneHeader({ terminalId, x, y }).catch(reportFailure);
        }}
      />
      <div className="pane-body">
        <TerminalSurface
          surfaceKey={paneTerminalSurfaceKey(terminalId)}
          surfaceLabel={found.name}
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
): PaneTerminalWire | undefined {
  for (const workspace of snapshot.workspaces) {
    const found = workspace.paneTerminals?.find(
      (terminal) => terminal.id === terminalId,
    );
    if (found) return found;
  }
  return undefined;
}

/**
 * The pane's title strip: its name, its session, and the ×. Dragged, it is
 * how the pane is moved — let go over another pane, main puts it on the side
 * of that pane nearest the pointer.
 */
function PaneHeader({
  terminal,
  onClose,
  onDrop,
}: {
  readonly terminal: PaneTerminalWire;
  readonly onClose: () => void;
  readonly onDrop: (x: number, y: number) => void;
}) {
  const start = useRef<{ x: number; y: number } | undefined>(undefined);
  const [dragging, setDragging] = useState(false);

  const finish = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const from = start.current;
      start.current = undefined;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      setDragging(false);
      if (from === undefined || event.type === "pointercancel") return;
      const moved = Math.hypot(event.clientX - from.x, event.clientY - from.y);
      if (moved >= DRAG_THRESHOLD) onDrop(event.clientX, event.clientY);
    },
    [onDrop],
  );

  return (
    <div
      className={`pane-header${dragging ? " is-dragging" : ""}`}
      title={`tmux session ${terminal.session}${
        terminal.command ? ` — ${terminal.command}` : ""
      }. Drag to move the pane.`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        if ((event.target as HTMLElement).closest("button")) return;
        start.current = { x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const from = start.current;
        if (from === undefined || dragging) return;
        if (
          Math.hypot(event.clientX - from.x, event.clientY - from.y) >=
          DRAG_THRESHOLD
        ) {
          setDragging(true);
        }
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
    >
      <span className="pane-name">{terminal.name}</span>
      <span className="pane-session">{terminal.session}</span>
      <button
        type="button"
        className="pane-close"
        aria-label={`Close ${terminal.name}`}
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}

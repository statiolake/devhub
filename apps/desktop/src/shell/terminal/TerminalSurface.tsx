import type { TerminalPanesWire } from "../../ipc/contract";
import type { PaneNeovims } from "../pane/PaneNeovims";
import type { TerminalAppearance } from "./theme";
import type { TerminalClient } from "./client";

/**
 * One terminal surface: a tmux control client's session, every pane drawn by
 * DevHub (`control/ControlTerminalSurface.tsx`, `docs/terminal-mode.md`).
 * The identity of the mount is the surface key, so an unrelated re-render
 * never reconnects it; a pooled `hidden` surface keeps its client while
 * another surface is on screen.
 */
export interface TerminalSurfaceProps {
  readonly surfaceKey: string;
  readonly surfaceLabel: string;
  readonly appearance?: TerminalAppearance;
  readonly client?: TerminalClient;
  readonly hideTitle?: boolean;
  /**
   * The surface is mounted but not on screen. A pooled surface keeps its client
   * attached while it waits its turn; it must not report
   * geometry, because a `display: none` host measures as nothing and the
   * fallback size would resize the pane behind the user's back.
   *
   * A surface that has *never* been on screen has neither yet: its client
   * is attached the first time it is shown, and tmux draws its panes as they
   * are then. One that has been on screen and is hidden again tells its
   * control client, which stops sending rows until it is shown.
   */
  readonly hidden?: boolean;
  /**
   * What each pane is, as it changes; `null` when
   * this surface goes (`PaneBridge.reportTerminalPanes`): which panes have
   * a Neovim DevHub draws, and where the keys go.
   */
  readonly onControlPanes?: (panes: TerminalPanesWire | null) => void;
  /**
   * The Neovims DevHub draws over this terminal's panes: the surface puts
   * each in its pane (`shell/pane/PaneNeovims.tsx`).
   */
  readonly neovims?: PaneNeovims;
  /**
   * A session that ended (its last window closed, a detach) is attached
   * again at once — made again — instead of the pane saying it
   * disconnected: a Workspace's terminal is a place, not a process. Every
   * time it ends, however soon after the last: the pane is said to be
   * disconnected only when a session made again ends by itself straight
   * away (`REATTACH_ON_EXIT_MS`), which is a shell that cannot start.
   */
  readonly reattachOnExit?: boolean;
}

export { ControlTerminalSurface as TerminalSurface } from "./control/ControlTerminalSurface";

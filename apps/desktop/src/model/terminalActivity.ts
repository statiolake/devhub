/**
 * What a Workspace's own terminals are doing, in the Agents' vocabulary.
 *
 * A Workspace's integrated terminals are panes in its tmux session (Scratch's
 * are in the `scratch` session). The person types a command into one, goes to
 * another Workspace, and wants the row to say two things an Agent's row already
 * says: *something is still going there*, and *it finished while you were
 * away*. So the reading is an `AgentStatus` and the mark is an `UnreadReason`,
 * and the Sidebar draws them with the Agents' own `StatusMark` — one vocabulary,
 * not a second one that could drift from it.
 *
 * Only two of the statuses are ever used: `working` while any pane is working,
 * `idle` otherwise. A pane is working while a command (not the shell) is in its
 * foreground *and* it has printed within the last few seconds; a command that
 * exits and a command that goes quiet are the same event here — it finished.
 * There is deliberately no "finished" state of its own: an idle terminal that
 * has been seen draws nothing at all (no check mark), and one that finished
 * unseen draws the unread mark until it is seen. Output resuming is working
 * again.
 *
 * **Per pane, then rolled up.** Unread belongs to the pane whose command
 * finished, because "seen" is a fact about a pane: looking at window 1 of the
 * session has not shown you what happened in window 3. The row is the roll-up —
 * working if any pane is, unread if any pane is.
 *
 * **What counts as working** is main's to decide from tmux's answer and its
 * output clock (`main/terminal/paneActivity.ts`); this module is handed a
 * boolean per pane.
 *
 * **Seen** mirrors an Agent's rule (`AppModel.isAgentVisible`): DevHub is the
 * window in front, the Workspace's workbench is what the content area is
 * drawing, and the pane is on screen in its tmux session — its window is the
 * session's current one and a client (a terminal tab) is attached to it. The
 * last half is tmux's, read in the same round as the command; the first two
 * are the model's and are re-applied whenever the selection or the window's
 * focus changes, exactly where an Agent's mark is cleared.
 *
 * Not persisted. It is a reading of live tmux state and is rebuilt by the first
 * round after a launch; a command that finished while DevHub was not running
 * was not watched finishing, so there is nothing to have missed.
 */

import type { AgentStatus, UnreadReason } from "./domain.js";

/** One pane, as one round saw it. */
export interface TerminalPaneObservation {
  /** tmux's pane id (`%12`), stable for the pane's life on its server. */
  readonly pane: string;
  /**
   * Working: a command other than the shell is in the foreground and has
   * printed recently. False once it exits or goes quiet.
   */
  readonly running: boolean;
  /**
   * The pane is on screen in its session: its window is the current one and a
   * client is attached. Whether *DevHub* is showing that session is the
   * model's half and is not in here.
   */
  readonly inView: boolean;
}

/** Every pane of one Workspace's terminal session, from one round. */
export interface WorkspaceTerminalObservation {
  readonly workspaceId: string;
  /** Empty when the Workspace has no terminal session (closed, or never opened). */
  readonly panes: readonly TerminalPaneObservation[];
}

/** A Workspace's terminals, rolled up, in the Agents' types. */
export interface TerminalActivity {
  readonly status: Extract<AgentStatus, "working" | "idle">;
  readonly unread: UnreadReason | undefined;
}

export const TERMINALS_IDLE: TerminalActivity = {
  status: "idle",
  unread: undefined,
};

interface PaneState {
  readonly running: boolean;
  readonly inView: boolean;
  readonly unread: boolean;
}

/**
 * One Workspace's panes and the rule that moves them.
 *
 * working → finished (exited or quiet) unseen → unread → seen → read;
 * finished while seen is never unread; output again while unread is working
 * (the mark is drawn as working, and unread again when it settles); a pane
 * that closes takes its state with it.
 */
export class TerminalPanes {
  private panes = new Map<string, PaneState>();

  clone(): TerminalPanes {
    const copy = new TerminalPanes();
    copy.panes = new Map(this.panes);
    return copy;
  }

  /**
   * Take one round's reading. `workspaceVisible` is the model's half of
   * "seen". Returns whether the roll-up changed.
   */
  observe(
    panes: readonly TerminalPaneObservation[],
    workspaceVisible: boolean,
  ): boolean {
    const before = this.activity;
    const next = new Map<string, PaneState>();
    for (const pane of panes) {
      const previous = this.panes.get(pane.pane);
      const seen = workspaceVisible && pane.inView;
      const finished = previous?.running === true && !pane.running;
      next.set(pane.pane, {
        running: pane.running,
        inView: pane.inView,
        unread: seen ? false : (previous?.unread ?? false) || finished,
      });
    }
    // A pane that is not in the reading has closed (or its whole session has):
    // there is nothing left to look at, so there is nothing left unread.
    this.panes = next;
    return !sameActivity(before, this.activity);
  }

  /**
   * The Workspace became visible (selected, or the window came forward): every
   * pane on screen in its session is read. Returns whether the roll-up changed.
   */
  read(): boolean {
    const before = this.activity;
    for (const [id, pane] of this.panes) {
      if (pane.unread && pane.inView) {
        this.panes.set(id, { ...pane, unread: false });
      }
    }
    return !sameActivity(before, this.activity);
  }

  /** Forget every pane: the session is gone, or the Workspace is. */
  clear(): boolean {
    const before = this.activity;
    this.panes.clear();
    return !sameActivity(before, this.activity);
  }

  get activity(): TerminalActivity {
    let running = false;
    let unread = false;
    for (const pane of this.panes.values()) {
      running ||= pane.running;
      unread ||= pane.unread;
    }
    if (!running && !unread) return TERMINALS_IDLE;
    return {
      status: running ? "working" : "idle",
      unread: unread ? "idle" : undefined,
    };
  }
}

function sameActivity(a: TerminalActivity, b: TerminalActivity): boolean {
  return a.status === b.status && a.unread === b.unread;
}

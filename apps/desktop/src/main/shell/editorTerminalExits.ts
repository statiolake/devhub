/**
 * Terminal mode: the editor area's shell exiting is the Workspace's close
 * button.
 *
 * In terminal mode the editor area is the Workspace's own tmux session
 * (`docs/terminal-mode.md`). When that session ends under the person — they
 * typed `exit` in its last shell, or it was killed — the editor area has
 * nothing left to show, and what they meant is the same as pressing the
 * Workspace's close button. So that is what happens, through the one close
 * path there is (`AppController.closeWorkspaceOrWorktree`): a Workspace with
 * nothing to lose closes, and one with something to ask about asks it, on
 * the same sheet the close button raises.
 *
 * When the answer is that the Workspace stays — the question was cancelled,
 * the close failed — or it cannot be closed at all (Scratch never is), the
 * editor area gets a terminal again: its view is started over, which makes a
 * fresh `ws-` session, in place. A client that ended while its session is
 * still running (the person detached with tmux's own keys) is simply
 * attached again: nothing exited.
 *
 * # What is not an exit
 *
 * Only a client that ended on its own is told here
 * (`AttachmentManagerOptions.onEndedByItself`). Everything DevHub ends
 * itself stops the client first — closing a Workspace, quitting, moving the
 * socket, a view going or started over — and is never one. Once DevHub is
 * shutting down (`dispose`), nothing is acted on at all. And a terminal that
 * keeps ending as soon as it starts — a shell that cannot start — is started
 * over a few times and then left, with the surface's own Retry, rather than
 * looping.
 */

/** Where a Workspace stands, as far as a close is concerned. */
export type WorkspaceCloseStanding =
	/** Not in the model: it closed, or never was. */
	| "gone"
	/** A close of it is being inspected or run. */
	| "closing"
	| "open";

export interface EditorTerminalExitsOptions {
	readonly standing: (workspaceId: string) => WorkspaceCloseStanding;
	/** Whether a close can be asked for at all (Scratch: never). */
	readonly closable: (workspaceId: string) => boolean;
	/** Whether a close's question is on screen, waiting for its answer. */
	readonly asking: () => boolean;
	/** Whether the Workspace's session is there now, without making it. */
	readonly sessionAlive: (workspaceId: string) => Promise<boolean>;
	/** The Workspace's close button: the one close path. */
	readonly close: (workspaceId: string) => void;
	/** Start the editor area's terminal over, on a fresh session. */
	readonly restart: (workspaceId: string) => void;
	readonly log?: (line: string) => void;
	readonly now?: () => number;
	readonly setTimer?: (run: () => void, ms: number) => unknown;
	readonly clearTimer?: (timer: unknown) => void;
}

/** How often a close that is still deciding is looked at again. */
export const SETTLE_POLL_MS = 250;
/**
 * How many looks in a row must find the close decided — no question, no
 * close underway — before the terminal is started over: an answer to one
 * question can be the next close's start, a moment later.
 */
export const SETTLED_LOOKS = 2;
/** At most this many restarts of one Workspace's terminal in `RESTART_WINDOW_MS`. */
export const MAX_RESTARTS = 3;
export const RESTART_WINDOW_MS = 30_000;

export class EditorTerminalExits {
	private readonly options: EditorTerminalExitsOptions;
	/** Workspaces whose exit is being handled, and how many settled looks so far. */
	private readonly pending = new Map<string, number>();
	private readonly restarts = new Map<string, number[]>();
	private timer: unknown;
	private disposed = false;

	constructor(options: EditorTerminalExitsOptions) {
		this.options = options;
	}

	private get now(): number {
		return (this.options.now ?? Date.now)();
	}

	/** The editor area's client of `workspaceId`'s session ended on its own. */
	async ended(workspaceId: string): Promise<void> {
		if (this.disposed || this.pending.has(workspaceId)) return;
		if (this.options.standing(workspaceId) !== "open") return;
		this.pending.set(workspaceId, 0);
		let alive: boolean;
		try {
			alive = await this.options.sessionAlive(workspaceId);
		} catch (failure: unknown) {
			// Not knowing is not an exit: closing a Workspace on a guess is the
			// one answer that must not be given. Its terminal is tried again.
			this.options.log?.(
				`[devhub] editor terminal of ${workspaceId}: could not read its session (${failure instanceof Error ? failure.message : String(failure)}); attaching again`,
			);
			alive = true;
		}
		if (this.disposed || this.options.standing(workspaceId) !== "open") {
			this.pending.delete(workspaceId);
			return;
		}
		if (alive || !this.options.closable(workspaceId)) {
			this.pending.delete(workspaceId);
			this.restart(workspaceId);
			return;
		}
		this.options.close(workspaceId);
		this.look();
	}

	/** Look at every exit still being decided; start the terminal over once one is. */
	private look(): void {
		if (this.disposed) return;
		for (const [workspaceId, settled] of [...this.pending]) {
			const standing = this.options.standing(workspaceId);
			if (standing === "gone") {
				this.pending.delete(workspaceId);
				this.restarts.delete(workspaceId);
				continue;
			}
			if (standing === "closing" || this.options.asking()) {
				this.pending.set(workspaceId, 0);
				continue;
			}
			if (settled + 1 < SETTLED_LOOKS) {
				this.pending.set(workspaceId, settled + 1);
				continue;
			}
			this.pending.delete(workspaceId);
			this.restart(workspaceId);
		}
		this.schedule();
	}

	private schedule(): void {
		if (this.timer !== undefined || this.pending.size === 0) return;
		const setTimer =
			this.options.setTimer ?? ((run, ms) => setTimeout(run, ms));
		this.timer = setTimer(() => {
			this.timer = undefined;
			this.look();
		}, SETTLE_POLL_MS);
	}

	private restart(workspaceId: string): void {
		const now = this.now;
		const recent = (this.restarts.get(workspaceId) ?? []).filter(
			(at) => now - at < RESTART_WINDOW_MS,
		);
		if (recent.length >= MAX_RESTARTS) {
			this.restarts.set(workspaceId, recent);
			this.options.log?.(
				`[devhub] editor terminal of ${workspaceId} ended ${String(recent.length + 1)} times in ${String(RESTART_WINDOW_MS / 1000)}s; leaving it for Retry`,
			);
			return;
		}
		recent.push(now);
		this.restarts.set(workspaceId, recent);
		this.options.restart(workspaceId);
	}

	/** DevHub is going: nothing more is acted on. */
	dispose(): void {
		this.disposed = true;
		this.pending.clear();
		if (this.timer !== undefined) {
			(this.options.clearTimer ?? ((timer) => clearTimeout(timer as never)))(
				this.timer,
			);
			this.timer = undefined;
		}
	}
}

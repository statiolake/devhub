/**
 * Whether a Workspace terminal's pane is working, from what tmux says about it.
 *
 * Every round reads, for every pane on the server, in one batched
 * `list-panes -a` (`TmuxTerminalRuntime.terminalPanes`):
 *
 * - `#{pane_current_command}` — the name of the pane's *foreground* process
 *   (tmux asks the pty for its foreground process group). At a prompt that is
 *   the shell; while a command runs it is the command. What a prompt runs for
 *   itself (a git status in `PS1`) stays in the shell's own process group and
 *   does not show here.
 * - when the pane last wrote output — see "Output" below.
 *
 * **The rule, whole:** a pane is *working* while a live process other than the
 * shell is in its foreground **and** the pane has written output within the
 * last N seconds (`general.terminal_idle_seconds`, default 5). Everything else
 * is idle: the command exited and the shell is back, or it is still there but
 * has been quiet for N seconds — a `less` left open, a REPL waiting for input,
 * a build stuck on a prompt. Going quiet is treated exactly as finishing (the
 * model raises the unread mark if nobody saw it); output resuming is working
 * again. A full-screen program that keeps redrawing (htop) is working for as
 * long as it is open. N = 0 turns the quiet rule off: any foreground command is
 * working until it exits.
 *
 * - *Not a shell*: the configured shell's name, or any of the common shells —
 *   a shell started inside the shell (`bash` from `zsh`) is still a prompt.
 *   The same comparison the close confirmation uses.
 * - *Live*: a pane kept after its process exited (`remain-on-exit`) runs
 *   nothing.
 *
 * **Output.** tmux has no per-pane "last output" time; it keeps
 * `#{window_activity}`, per *window*, to the second. So output is read from
 * two signals and attributed carefully:
 *
 * 1. The pane's own screen moved since the last round — its history grew or
 *    its cursor moved (`#{history_size}`, `#{cursor_x}`, `#{cursor_y}`). Cheap
 *    and per pane, but blind to a redraw that leaves the cursor where it was
 *    (a progress bar, htop) and to scrolling once the history is full.
 * 2. The window's `#{window_activity}` advanced. Exact for the pane that is the
 *    only working candidate in its window, which is the usual shape. With
 *    several candidates in one window it is credited to the ones whose own
 *    screen moved, and to all of them when none did — a pane that might be
 *    writing is better drawn working than marked finished when it is not.
 *
 * A command starting (the foreground process changing) counts as output, so a
 * silent `sleep 60` is working for N seconds and then quiet. A pane first seen
 * by this run is dated by its window's activity, not by "now": a `less` that
 * has sat there since yesterday is quiet on DevHub's first round rather than
 * working for N seconds and then raising an unread mark nobody earned.
 *
 * Commands shorter than one round (about a second) may never be seen working,
 * and so never leave an unread mark — which is what a person wants from `ls`.
 */

/** Shells whose prompt is "nothing running", besides the configured one. */
export const KNOWN_SHELLS: ReadonlySet<string> = new Set([
	"sh",
	"bash",
	"zsh",
	"fish",
	"dash",
	"ksh",
	"mksh",
	"tcsh",
	"csh",
	"nu",
	"xonsh",
	"elvish",
	"pwsh",
	"login",
]);

/** A process name as tmux reports it, without a login shell's `-` or a path. */
export function commandName(command: string): string {
	const trimmed = command.trim().replace(/^-+/u, "");
	return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** Whether a foreground process name is a shell sitting at its prompt. */
export function isShellCommand(
	command: string,
	configuredShell: string | undefined,
): boolean {
	const name = commandName(command);
	// An empty name is tmux not knowing (a pane being created or torn down);
	// not knowing is not a command running.
	if (name.length === 0) return true;
	return name === configuredShell || KNOWN_SHELLS.has(name);
}

/** One pane, as one `list-panes` expanded it. */
export interface PaneSample {
	/** The Workspace whose terminal session the pane is in. */
	readonly workspaceId: string;
	/** tmux's pane id, `%12`: unique on its server for the pane's life. */
	readonly pane: string;
	/** tmux's window id, `@3`. */
	readonly window: string;
	/** Its window is the session's current one, and a client is attached. */
	readonly inView: boolean;
	readonly command: string;
	readonly dead: boolean;
	/** `#{window_activity}`, unix seconds; `undefined` when tmux said nothing. */
	readonly windowActivity: number | undefined;
	/** `history_size:cursor_x:cursor_y` — moves when the pane writes. */
	readonly screen: string;
}

/** One pane's verdict for the model (`model/terminalActivity.ts`). */
export interface PaneVerdict {
	readonly workspaceId: string;
	readonly pane: string;
	readonly running: boolean;
	readonly inView: boolean;
}

interface Remembered {
	readonly command: string;
	readonly screen: string;
	readonly lastOutputMs: number;
}

/**
 * The output clock for one tmux server's panes, round to round.
 *
 * One per machine, because pane and window ids are a server's. It forgets a
 * pane the round it stops being listed.
 */
export class PaneActivityTracker {
	#panes = new Map<string, Remembered>();
	#windows = new Map<string, number | undefined>();

	observe(
		samples: readonly PaneSample[],
		nowMs: number,
		idleSeconds: number,
		configuredShell: string | undefined,
	): PaneVerdict[] {
		const idleMs = Math.max(0, idleSeconds) * 1000;
		const busy = (sample: PaneSample): boolean =>
			!sample.dead && !isShellCommand(sample.command, configuredShell);

		// Which panes' own screens moved (or whose command changed) this round.
		const moved = new Set<string>();
		for (const sample of samples) {
			const before = this.#panes.get(sample.pane);
			if (
				before !== undefined &&
				(before.screen !== sample.screen || before.command !== sample.command)
			) {
				moved.add(sample.pane);
			}
		}

		// Which windows wrote since the last round, and which of their working
		// candidates that output is credited to.
		const credited = new Set<string>();
		const byWindow = new Map<string, PaneSample[]>();
		for (const sample of samples) {
			const list = byWindow.get(sample.window) ?? [];
			list.push(sample);
			byWindow.set(sample.window, list);
		}
		for (const [window, panes] of byWindow) {
			const activity = panes[0]?.windowActivity;
			const previous = this.#windows.get(window);
			const advanced =
				activity !== undefined && previous !== undefined && activity > previous;
			if (!advanced) continue;
			const candidates = panes.filter(busy);
			const movedCandidates = candidates.filter((one) => moved.has(one.pane));
			for (const one of movedCandidates.length > 0
				? movedCandidates
				: candidates) {
				credited.add(one.pane);
			}
		}

		const panes = new Map<string, Remembered>();
		const windows = new Map<string, number | undefined>();
		const verdicts: PaneVerdict[] = [];
		for (const sample of samples) {
			windows.set(sample.window, sample.windowActivity);
			const before = this.#panes.get(sample.pane);
			let lastOutputMs: number;
			if (before === undefined) {
				// First sight: dated by the window, never by "now" (see above).
				lastOutputMs =
					sample.windowActivity === undefined
						? Number.NEGATIVE_INFINITY
						: Math.min(nowMs, sample.windowActivity * 1000);
			} else if (moved.has(sample.pane) || credited.has(sample.pane)) {
				lastOutputMs = nowMs;
			} else {
				lastOutputMs = before.lastOutputMs;
			}
			panes.set(sample.pane, {
				command: sample.command,
				screen: sample.screen,
				lastOutputMs,
			});
			verdicts.push({
				workspaceId: sample.workspaceId,
				pane: sample.pane,
				running:
					busy(sample) && (idleMs === 0 || nowMs - lastOutputMs < idleMs),
				inView: sample.inView,
			});
		}
		this.#panes = panes;
		this.#windows = windows;
		return verdicts;
	}
}

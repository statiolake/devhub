/**
 * The loop that tells the Sidebar what each Workspace's terminals are doing.
 *
 * **Why a poll.** tmux pushes nothing when a pane's foreground process
 * changes: there is no hook for "a command started" or "a command ended", and
 * "this pane has been quiet for five seconds" is not an event tmux has at all
 * (`monitor-silence` is per window, and fires once). Control mode (`tmux -C`) would
 * stream `%output` for every byte every pane prints — a busy build would be a
 * flood of notifications to learn one bit — and shell integration (OSC 133
 * prompt marks) would need DevHub to edit the person's shell config — and the
 * rule is about output going quiet, which no prompt mark says anyway. What tmux
 * *does* keep, for every pane, is what is needed — the foreground command and
 * enough about its output to date it (see `terminal/paneActivity.ts`) — and
 * one `list-panes -a` reads all of it for every session, window and pane on
 * the server at once.
 *
 * **What it costs.** One tmux invocation per machine per round, batched across
 * every Workspace on that machine, at most once a second
 * (`TERMINAL_ACTIVITY_INTERVAL_MS`) — slower when the machine's own cadence is
 * slower (a remote host's is derived from its round trip, `runtime/cadence.ts`).
 * The loop is `AgentReconciler`'s, one per machine with a Workspace on it, so
 * it never overlaps itself and stops with its machine.
 *
 * **When a machine cannot answer** — a host that dropped, a tmux that is not
 * there — the reading is skipped and the rows keep what they last showed. That
 * is the same graceful end a terminal itself has there: this is decoration on
 * a row, not a reason to raise a notice, and the failure is logged once per
 * distinct reason rather than once a second.
 */

import type { WorkspaceTerminalObservation } from "../../model/terminalActivity.js";
import type { PaneVerdict } from "../terminal/paneActivity.js";
import type { ReconcileHost } from "./agentReconciler.js";

/** The fastest the loop runs on any machine. */
export const TERMINAL_ACTIVITY_INTERVAL_MS = 1_000;

/**
 * A machine as the terminal loop sees it: the same id, and its own cadence
 * clamped to at most one round a second. A getter, because a remote runtime's
 * cadence moves with its measured round trips.
 */
export function terminalActivityHost(runtime: ReconcileHost): ReconcileHost {
	return {
		id: runtime.id,
		get cadence() {
			const cadence = runtime.cadence;
			return {
				...cadence,
				reconcileIntervalMs: Math.max(
					TERMINAL_ACTIVITY_INTERVAL_MS,
					cadence.reconcileIntervalMs,
				),
			};
		},
	};
}

/**
 * One machine's panes, grouped by Workspace, with every Workspace on the
 * machine present — an empty list is how a closed session's state is cleared.
 * A pane whose Workspace DevHub does not have (a session left from an earlier
 * run, a Workspace on another profile) is not anybody's row and is dropped.
 */
export function terminalObservations(
	panes: readonly PaneVerdict[],
	workspacesOnMachine: readonly string[],
): WorkspaceTerminalObservation[] {
	const grouped = new Map<
		string,
		WorkspaceTerminalObservation["panes"][number][]
	>(workspacesOnMachine.map((id) => [id, []]));
	for (const reading of panes) {
		grouped.get(reading.workspaceId)?.push({
			pane: reading.pane,
			running: reading.running,
			inView: reading.inView,
		});
	}
	return [...grouped].map(([workspaceId, observed]) => ({
		workspaceId,
		panes: observed,
	}));
}

/** Say a machine's failure once per reason, not once per round. */
export class FailureOnce {
	readonly #last = new Map<string, string>();

	/** Whether this reason is new for this machine (and so worth logging). */
	failed(machine: string, reason: string): boolean {
		if (this.#last.get(machine) === reason) return false;
		this.#last.set(machine, reason);
		return true;
	}

	succeeded(machine: string): void {
		this.#last.delete(machine);
	}
}

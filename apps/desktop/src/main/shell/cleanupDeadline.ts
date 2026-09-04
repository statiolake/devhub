/**
 * A step of a Workspace close, bounded in time.
 *
 * A close is made of calls into things that can stop answering entirely — a
 * `tmux` that never returns, a workbench that never replies to the request to
 * close. Without a bound the close simply stops there: no completion, no
 * failure, and a Workspace left in `closing` — greyed, breathing, refusing
 * every operation — for the rest of the session, with nothing on screen
 * saying why. So every step ends: with its answer, with the error it threw,
 * or with this.
 */

import type { CloseDiagnosticWire } from "../../ipc/appShell.js";
import type { CleanupStep } from "../../model/intents.js";

/**
 * Generous enough that a slow-but-working step still finishes. It is a bound
 * on waiting, not a guess about how long the work ought to take.
 */
export const CLEANUP_STEP_TIMEOUT_MS = 20_000;

/** Which "DevHub could not confirm this" each step reports when time runs out. */
const CLEANUP_TIMEOUT_DIAGNOSTIC = {
	agents: "close_agents_unknown",
	terminal: "close_terminal_unknown",
	// Not "not running": a workbench that never answered the request to close
	// is, as far as anything here can tell, up and busy — and it is very
	// likely the thing the person is looking at.
	editor: "close_editor_unresponsive",
	state_committed: "cleanup_failed",
} as const satisfies Record<CleanupStep, CloseDiagnosticWire>;

export class CleanupTimeout extends Error {
	constructor(readonly diagnostic: CloseDiagnosticWire) {
		super(`cleanup step timed out: ${diagnostic}`);
		this.name = "CleanupTimeout";
	}
}

export function withCleanupDeadline<T>(
	step: CleanupStep,
	work: Promise<T>,
	timeoutMs: number = CLEANUP_STEP_TIMEOUT_MS,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new CleanupTimeout(CLEANUP_TIMEOUT_DIAGNOSTIC[step]));
		}, timeoutMs);
		work.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}

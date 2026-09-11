/**
 * One bound per external call a close makes.
 *
 * A close is made of calls into things that can stop answering entirely — a
 * `tmux` that never returns, a workbench that never replies to the request to
 * close, a `git worktree remove` against a disk that has gone away. Without a
 * bound the close simply stops there: no completion, no failure, and a row
 * that never finishes going, with nothing on screen saying why. So every step
 * ends: with its answer, with the error it threw, or with this.
 *
 * There is no budget arithmetic here beyond the sum, and deliberately: a close
 * is one operation running a fixed sequence, not a multi-step plan with a
 * resumable midpoint. A deadline that is hit is a step failure like any other,
 * and the next close runs the same steps again.
 */

import type { CloseDiagnosticWire } from "../../ipc/appShell.js";
import { CLOSE_STEPS, type CloseStep } from "../../model/domain.js";

/**
 * Generous enough that a slow-but-working step still finishes. It is a bound
 * on waiting, not a guess about how long the work ought to take.
 */
export const CLOSE_STEP_TIMEOUT_MS = 20_000;

/** Which "DevHub could not confirm this" each step reports when time runs out. */
const CLOSE_TIMEOUT_DIAGNOSTIC = {
	// Not "not running": a workbench that never answered the request to close
	// is, as far as anything here can tell, up and busy — and it is very
	// likely the thing the person is looking at.
	editor: "close_editor_unresponsive",
	agents: "close_agents_unknown",
	terminal: "close_terminal_unknown",
	view: "cleanup_failed",
	worktree: "cleanup_failed",
	state: "cleanup_failed",
} as const satisfies Record<CloseStep, CloseDiagnosticWire>;

/**
 * The longest a close can legitimately take before anything has gone wrong.
 *
 * Every step is bounded separately and they run in sequence, so the close's
 * own budget is the number of steps times the step bound. It is derived from
 * `CLOSE_STEPS` rather than written down, because a step added there has to
 * move this number with it — and the operation deadline that has to be longer
 * than it.
 */
export const CLOSE_BUDGET_MS = CLOSE_STEPS.length * CLOSE_STEP_TIMEOUT_MS;

export class CloseTimeout extends Error {
	constructor(readonly diagnostic: CloseDiagnosticWire) {
		super(`close step timed out: ${diagnostic}`);
		this.name = "CloseTimeout";
	}
}

export function withCloseDeadline<T>(
	step: CloseStep,
	work: Promise<T>,
	timeoutMs: number = CLOSE_STEP_TIMEOUT_MS,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new CloseTimeout(CLOSE_TIMEOUT_DIAGNOSTIC[step]));
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

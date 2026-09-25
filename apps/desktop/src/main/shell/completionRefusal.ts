/**
 * What becomes of a completion the coordinator refused.
 *
 * One decision, made in one place for every provider event main feeds back, so
 * that no failure has two ways onto the screen.
 */

import { AppError, AppErrorCode } from "../../model/intents.js";
import { TypedFailure } from "../../model/wire.js";

export type CompletionRefusalRoute =
	/** A bug in main's own flow: nobody is waiting and nothing can answer it. */
	| "crash"
	/** The request that was waiting is refused; nothing is published. */
	| "reject"
	/** The request is refused, and the failure is published as an app notice. */
	| "publish";

/**
 * - A completion for an operation that was never started is a bug in main —
 *   a token invented or completed twice — and stops the process.
 * - A *stale* one answers an operation something newer already settled on
 *   purpose (the reconciler supersedes its own rounds), and a person told so
 *   every time learns nothing and stops reading the error area.
 * - A failure marked `reported` was already drawn at its subject — the
 *   Agent's pane, the machine's condition, or the app notice — by
 *   `failOperation`, and comes back only to answer the request in the same
 *   words. Publishing it again was a second route to the screen: for an
 *   app-wide failure the second notice replaced the first under another
 *   sentence, and for a machine it put an app notice back on every round the
 *   machine condition exists to say once. The page keeps the same rule for
 *   the rejection it is handed (`pageModel`'s `dispatch`).
 * - Anything else is a failure nothing has reported yet, and the app notice
 *   is where it is said.
 */
export function completionRefusalRoute(error: unknown): CompletionRefusalRoute {
	if (isCode(error, AppErrorCode.UnknownOperation)) return "crash";
	if (isCode(error, AppErrorCode.StaleCompletion)) return "reject";
	if (error instanceof TypedFailure && error.wire.reported === true) {
		return "reject";
	}
	return "publish";
}

function isCode(error: unknown, code: AppErrorCode): boolean {
	return error instanceof AppError && error.code === code;
}

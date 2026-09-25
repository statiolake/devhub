/**
 * What becomes of a completion the coordinator refused.
 *
 * One decision, made in one place for every provider event main feeds back, so
 * that no failure has two ways onto the screen.
 */

import {
	AppError,
	AppErrorCode,
	type ProviderEvent,
} from "../../model/intents.js";

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
 * - `operation_failed` is only ever sent by `failOperation`, which has already
 *   reported the failure at its subject — the Agent's pane, the Workspace's
 *   row, the machine's condition, or the app notice. The coordinator's
 *   refusal of the operation is that same failure coming back, and publishing
 *   it again was a second route to the screen: for an app-wide failure the
 *   second notice replaced the first under the coordinator's port word
 *   instead of the failure's own, and for a machine it put an app notice back
 *   on every round the machine condition exists to say once.
 * - Anything else is a failure nothing has reported yet, and the app notice
 *   is where it is said.
 */
export function completionRefusalRoute(
	event: ProviderEvent,
	error: unknown,
): CompletionRefusalRoute {
	if (isCode(error, AppErrorCode.UnknownOperation)) return "crash";
	if (isCode(error, AppErrorCode.StaleCompletion)) return "reject";
	if (event.type === "operation_failed") return "reject";
	return "publish";
}

function isCode(error: unknown, code: AppErrorCode): boolean {
	return error instanceof AppError && error.code === code;
}

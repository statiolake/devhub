/**
 * What becomes of a completion the coordinator refused.
 *
 * One decision, made in one place for every provider event main feeds back, so
 * that no failure has two ways onto the screen.
 */

import type { AppErrorWire } from "../../ipc/appShell.js";
import {
	AppError,
	AppErrorCode,
	type ProviderEvent,
} from "../../model/intents.js";
import { errorWire, TypedFailure } from "../../model/wire.js";

export type CompletionRefusal =
	/** A bug in main's own flow: nobody is waiting and nothing can answer it. */
	| { readonly kind: "crash" }
	| {
			readonly kind: "answer";
			/** Drawn as an app notice, when nothing has drawn it yet. */
			readonly publish?: AppErrorWire;
			/** What the request waiting on the operation is refused with. */
			readonly rejection: unknown;
	  };

/**
 * - A completion for an operation that was never started is a bug in main —
 *   a token invented or completed twice — and stops the process.
 * - A *stale* one answers an operation something newer already settled on
 *   purpose (the reconciler supersedes its own rounds), and a person told so
 *   every time learns nothing and stops reading the error area. Nothing is
 *   drawn.
 * - `operation_failed` is only ever sent by `failOperation`, which has already
 *   drawn the failure at its subject — the Agent's pane, the machine's
 *   condition, or the app notice. Drawing it again was a second route to the
 *   screen: for a machine it put an app notice back on every round the
 *   machine condition exists to say once.
 * - Anything else has not been drawn yet, and the app notice is where it is.
 *
 * Whatever main has drawn, by either route, reaches the request in the same
 * words and marked `reported`, so the page that asked does not raise it a
 * second time (`pageModel`'s `dispatch`) and `devhub` prints exactly what the
 * person saw.
 */
export function completionRefusal(
	event: ProviderEvent,
	error: unknown,
): CompletionRefusal {
	return refusalOf(error, event.type === "operation_failed");
}

/**
 * The same decision for a refusal of any request to the coordinator — a
 * completion, or an intent the coordinator refused on the spot — given
 * whether it was already drawn at its subject.
 */
export function refusalOf(
	error: unknown,
	drawnAtSubject: boolean,
): CompletionRefusal {
	if (isCode(error, AppErrorCode.UnknownOperation)) return { kind: "crash" };
	if (isCode(error, AppErrorCode.StaleCompletion)) {
		return { kind: "answer", rejection: error };
	}
	const drawn = errorWire(error);
	const rejection = new TypedFailure({ ...drawn, reported: true });
	return drawnAtSubject
		? { kind: "answer", rejection }
		: { kind: "answer", publish: drawn, rejection };
}

function isCode(error: unknown, code: AppErrorCode): boolean {
	return error instanceof AppError && error.code === code;
}

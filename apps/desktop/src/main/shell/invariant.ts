/**
 * Failures that are DevHub's own bug, and what is done with them.
 *
 * There are two kinds of failure in main and they want opposite treatment. A
 * fact about the world — a host that will not answer, a folder that is not
 * there, a workbench that died — is news for the person, and the rules for
 * saying it are the subject rules: on the row, on the surface, once per
 * episode. A broken assumption inside DevHub is not news for anybody: nobody
 * can act on "an operation the coordinator never started was completed", and
 * drawing it as a sentence spends the one error surface on something the
 * reader cannot use.
 *
 * Worse, it is usually *repeating*. The paths that violate an invariant are
 * loops — a reconcile round, a projection tick — so the sentence goes up, and
 * up, and up, at the loop's cadence, which is what a person reports as
 * flickering. A notice is the wrong shape for a bug.
 *
 * So a broken assumption crashes. The stack at the moment the assumption broke
 * is the whole diagnosis, and a process that carries on with a broken
 * assumption produces its symptoms somewhere else entirely — which costs far
 * more than the restart does. See the "想定が崩れたら、動かずに落とす" rule in
 * the repository's CLAUDE.md.
 */

/** A fact DevHub believed about itself, found to be false. */
export class InvariantViolation extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvariantViolation";
	}
}

export function isInvariantViolation(error: unknown): boolean {
	return error instanceof InvariantViolation;
}

/**
 * End the process, out of band, with this as the reason.
 *
 * Thrown from a timer rather than returned to the caller, because every caller
 * of this is inside a `catch` whose whole job is to keep going: returning
 * would hand the bug straight back to the code that was about to swallow it.
 * A timer's throw is an `uncaughtException`, which is the one path nothing in
 * DevHub catches.
 */
export function crash(error: unknown): void {
	console.error(
		"[devhub] invariant violated — stopping",
		error instanceof Error ? (error.stack ?? error.message) : error,
	);
	setTimeout(() => {
		throw error instanceof Error ? error : new Error(String(error));
	}, 0);
}

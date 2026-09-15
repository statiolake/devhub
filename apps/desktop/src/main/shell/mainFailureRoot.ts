/**
 * The main process's root failure boundary — the thing it did not have.
 *
 * Every page has one: `shell/failure.ts` puts `error` and `unhandledrejection`
 * on the window, so a promise nobody awaited still reaches somewhere that can
 * say what happened. Main had no such place. A rejected promise that nothing
 * caught produced Node's `unhandledRejection` warning on stderr, which in a
 * packaged app is written to a file nobody opens, and the app went on as
 * though the thing had been done.
 *
 * That absence is what made the `void somePromise()` calls all over main into
 * swallows. They are not swallows once there is a root: `void` does not
 * suppress a rejection, it only declines to wait for it. So this is installed
 * and the `void`s are left exactly as they are — the alternative, a
 * `.catch(report)` at each of them, is the same sentence written twenty-two
 * times, and every one of them a place where somebody can write it slightly
 * differently.
 *
 * # Only rejections
 *
 * `uncaughtException` is deliberately not handled. Taking it means the process
 * carries on after an exception nobody planned for, which is the shape this
 * whole change exists to remove: a program whose assumptions have failed
 * should stop, not paint. A rejection is different only because nothing stops
 * for one today either — reporting it adds what a person can see without
 * changing what the process does.
 *
 * # Except a cancellation
 *
 * A cancellation is not a failure. It is something that was *asked for* —
 * by DevHub, or by VS Code, or by the thing being cancelled going away — and
 * the request that carried it is over because somebody ended it.
 *
 * Measured at launch (stage 0: ten `native_unavailable` raises, and the
 * `flickering` reading that goes with them; stage 2, the same instance, with
 * the stack): VS Code's `RequestStore` gives every pty-host request a timeout
 * with a cancellation token, and disposes it when the reply arrives
 * (`PtyHostService.acceptPtyHostResolvedVariables` → `RequestStore.acceptReply`
 * → `FunctionDisposable.dispose`). Disposing cancels the token, the
 * cancellation is delivered through an `Emitter` to a promise that has already
 * been settled, and it arrives here as an unhandled rejection. One per
 * resolved request, at the moment each workbench asks for its terminal's
 * variables — so the burst is exactly as long as the number of workbenches
 * starting, and every one of it says "the native app shell is unavailable"
 * about nothing at all.
 *
 * Reporting those is worse than not reporting them: a notice that appears at
 * every launch and means nothing is a notice nobody reads, and the flicker
 * reading said so. So a cancellation is dropped here, at the one boundary,
 * rather than at the several places that can produce one — and it is dropped
 * *loudly enough to find*, on the log, because a cancellation nobody expected
 * is still worth being able to look up.
 */

/**
 * Whether this is somebody having cancelled something.
 *
 * VS Code's own test, spelled here rather than imported: this module is main's
 * boundary and must not depend on the editor being loaded to decide what a
 * failure is. `CancellationError` sets both the name and the message, and
 * older paths throw a bare `Error` wearing the same name.
 */
export function isCancellation(reason: unknown): boolean {
	if (!(reason instanceof Error)) return false;
	return reason.name === "Canceled" || reason.name === "CanceledError";
}

function describeCancellation(reason: unknown): string {
	const message = reason instanceof Error ? reason.message : String(reason);
	return message === "" ? "a request with no message" : message;
}

export interface FailureRoot {
	/** Where an unhandled failure goes: journalled, logged, and drawn once. */
	raiseUnhandled(reason: unknown): void;
}

/**
 * @returns a function that takes the listener off again, for a test.
 */
export function installMainFailureRoot(
	root: FailureRoot,
	on: NodeJS.Process["on"] = process.on.bind(process),
	off: NodeJS.Process["off"] = process.off.bind(process),
): () => void {
	const listener = (reason: unknown) => {
		if (isCancellation(reason)) {
			console.log(`[devhub] cancelled: ${describeCancellation(reason)}`);
			return;
		}
		root.raiseUnhandled(reason);
	};
	on("unhandledRejection", listener);
	return () => {
		off("unhandledRejection", listener);
	};
}

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
 */

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
		root.raiseUnhandled(reason);
	};
	on("unhandledRejection", listener);
	return () => {
		off("unhandledRejection", listener);
	};
}

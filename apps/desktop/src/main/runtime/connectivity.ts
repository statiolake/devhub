/**
 * When a machine started answering again.
 *
 * A runtime already knows this: it is the moment `reading().connected` goes
 * from false to true, and until now nothing could hear it. The work that
 * needs to hear it is the work a machine being *away* postponed — a sweep of
 * the sessions DevHub owns over there, most of all, because a machine that
 * was unreachable at startup is a machine nothing would otherwise ask again
 * until the next launch.
 *
 * It is a module-level emitter for the same reason the runtimes themselves
 * are module-level: there is one machine per id, so there is one stream of
 * facts about it, and a listener registered against a second emitter would
 * hear half of them. Listeners are told the machine and nothing else — what
 * to do about it is the listener's, and a listener that throws must not stop
 * the next one hearing about the same machine.
 */

import type { RuntimeId } from "./runtime.js";

type Listener = (machine: RuntimeId) => void;

const listeners = new Set<Listener>();

/** Hear about every machine that comes back. Returns the way to stop. */
export function onRuntimeConnected(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * Say that a machine is answering again.
 *
 * Called by a runtime on the transition only, never on every successful
 * command: "still connected" is not news, and a listener that swept on it
 * would sweep once per exec.
 */
export function runtimeConnected(machine: RuntimeId): void {
	for (const listener of [...listeners]) {
		try {
			listener(machine);
		} catch (error: unknown) {
			console.error(
				`[devhub] ${machine} came back and a listener threw`,
				error instanceof Error ? error.stack : error,
			);
		}
	}
}

/** Forget every listener. For tests, which build a fresh world each time. */
export function forgetRuntimeConnectedListeners(): void {
	listeners.clear();
}

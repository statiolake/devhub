/**
 * The moment at launch the first terminal has its client: what the person
 * waits for after the window. Work that is on nobody's way but would compete
 * with it — the pages nothing on screen needs yet (`ShellWindow.openPage`),
 * the startup sweep (`AppController.startRuntimes`) — waits for it, or for
 * `waitMs` at most, so a launch with no terminal to show is not held up.
 */

let attached = false;
const waiting = new Set<() => void>();

/** A terminal surface's attach was answered (`terminal/service.ts`). */
export function terminalAttached(): void {
	if (attached) return;
	attached = true;
	const ready = [...waiting];
	waiting.clear();
	for (const fn of ready) fn();
}

/** `fn` once the first terminal has attached, or after `waitMs`. */
export function afterFirstTerminal(fn: () => void, waitMs: number): void {
	if (attached) {
		fn();
		return;
	}
	let done = false;
	const run = () => {
		if (done) return;
		done = true;
		waiting.delete(run);
		clearTimeout(timer);
		fn();
	};
	const timer = setTimeout(run, waitMs);
	waiting.add(run);
}

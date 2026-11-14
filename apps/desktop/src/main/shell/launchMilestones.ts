/**
 * The moment at launch the first terminal is drawn — its page has said what
 * its panes are (`TerminalNeovims.controlPanes`), which it does once it has
 * the layout tmux sent its new client: what the person waits for after the
 * window. Work that is on nobody's way but would compete
 * with it — the pages nothing on screen needs yet (`ShellWindow.openPage`),
 * the startup sweep (`AppController.startRuntimes`) — waits for it, or for
 * `waitMs` at most, so a launch with no terminal to show is not held up.
 */

import { startupTrace } from "../diagnostics/startupTrace.js";

let attached = false;
const waiting = new Set<() => void>();

/** A terminal's page has drawn its panes. */
export function terminalShown(): void {
	if (attached) return;
	attached = true;
	startupTrace("launch:terminal-shown");
	const ready = [...waiting];
	waiting.clear();
	for (const fn of ready) fn();
}

/** `fn` once the first terminal is drawn, or after `waitMs`. */
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

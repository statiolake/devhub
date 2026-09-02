/**
 * How many listeners `electron.app` is allowed to carry, and why that number.
 *
 * Node warns when one emitter collects more than ten listeners for the same
 * event, because in an ordinary program that is a leak. On DevHub's startup it
 * was neither a leak nor ordinary:
 *
 *     MaxListenersExceededWarning: Possible EventEmitter memory leak detected.
 *     11 child-process-gone listeners added to [EventEmitter].
 *
 * Every one of them is correct. VS Code spawns each of its helpers as an
 * Electron utility process, and a utility process has no crash event of its
 * own — the only way to hear that it died is `app`'s process-wide
 * `child-process-gone`, filtered by name. So `UtilityProcess.start` adds one
 * listener to `app` per live helper (`utilityProcess.ts`), and disposes it when
 * the helper exits. The count is not a leak; it is the number of helpers
 * running.
 *
 * What makes DevHub cross ten where stock VS Code does not is the shape of the
 * product: one VS Code window is one application, and one DevHub is as many
 * windows as the person has Workspaces open. The helpers scale with them.
 *
 * **Why not `setMaxListeners(0)`.** Because the warning is the only thing that
 * would ever tell us a listener is being added and never removed, and a
 * disabled warning cannot distinguish "eleven workbenches are open" from "one
 * workbench has leaked its extension host eleven times". The ceiling below is a
 * statement about how many helpers DevHub's own structure accounts for, so a
 * count beyond it still warns — which is exactly the case worth hearing about.
 *
 * **Why this is a ceiling on the whole emitter.** Node has no per-event limit;
 * `setMaxListeners` raises the bar for every event `app` carries. That is
 * acceptable here only because `child-process-gone` is the busiest of them by a
 * wide margin — the rest (`open-file`, `open-url`, `ready`, `will-quit`) have a
 * single listener each and are nowhere near ten — so the number below is
 * effectively about this one event.
 *
 * The module is deliberately free of Electron: the arithmetic is the part worth
 * testing, and `allowListenersFor` around it is one line.
 */

import { electron } from "../electron.js";

/**
 * Helpers that exist once per DevHub, however many workbenches are open.
 *
 * - the shared process, which owns extension management and telemetry
 * - the pty host, which owns every terminal in every workbench
 * - the agent host, started the first time an agent session is
 * - the GPU crash watcher `app.ts` installs on macOS, which is not a utility
 *   process but listens to the same event and so counts the same
 */
export const APPLICATION_WIDE_LISTENERS = 4;

/**
 * Helpers a single workbench brings with it.
 *
 * - its extension host, one per window
 * - its file watcher, one per window, started with the first watch
 * - its dictation worker, started only if the person dictates — counted anyway,
 *   because a ceiling that is right until somebody speaks is not a ceiling
 */
export const LISTENERS_PER_WORKBENCH = 3;

/**
 * Node's own default, and the floor.
 *
 * With no workbench open the arithmetic below would come out under ten, and
 * lowering Node's bar is not this module's business: it exists to raise the bar
 * where DevHub's structure justifies it, never to tighten it somewhere else.
 */
export const NODE_DEFAULT_MAX_LISTENERS = 10;

/** The listeners `app` is accounted for at, with this many workbenches open. */
export function appListenerCeiling(workbenches: number): number {
	return Math.max(
		NODE_DEFAULT_MAX_LISTENERS,
		APPLICATION_WIDE_LISTENERS + LISTENERS_PER_WORKBENCH * workbenches,
	);
}

/**
 * Tell `app` what DevHub accounts for, now that the workbench count has moved.
 *
 * Called from both sides of `ShellWindow`'s table of views, because both sides
 * change the answer and a ceiling raised on the way up and never lowered is a
 * ceiling that stops detecting anything.
 */
export function allowListenersFor(workbenches: number): void {
	electron.app.setMaxListeners(appListenerCeiling(workbenches));
}

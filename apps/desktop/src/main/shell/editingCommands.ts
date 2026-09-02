/**
 * The Mac's editing keys, answered for DevHub's own chrome.
 *
 * On a Mac, Cmd+A, Cmd+C, Cmd+V, Cmd+X and Cmd+Z are not something a web page
 * implements. They arrive as menu accelerators on the Edit menu, and the
 * system turns them into editing commands aimed at whatever holds the
 * keyboard. DevHub's menu deliberately registers no accelerators at all (see
 * `menu.ts`): every surface it hosts is a whole application with its own keys,
 * and a menu that claimed Cmd+A would take Select All away from Monaco.
 *
 * The cost was paid by the one surface that has no keys of its own. DevHub's
 * chrome — the App Shell page, the Settings window, the modal overlay — is
 * ordinary HTML with ordinary text boxes, and an ordinary text box has nothing
 * that answers Cmd+A. So selecting all in the Settings window did nothing, and
 * so did copy, cut, paste and undo.
 *
 * This is the same shape of problem the terminal pane had, and it gets the
 * same shape of answer: a surface that cannot answer one of the Mac's chords
 * has it answered for it, by the layer in front of every surface (see
 * `../../shell/surfaces/keys.ts`, which does this for Cmd+Left in a pane, and
 * `keyboard.ts`, which is that layer). Keys stay with the surfaces; the menu
 * stays keyless; and nothing is taken from the workbench, because the answer
 * is given per web contents rather than to the whole application.
 *
 * ## Why not put the accelerators back on the Edit menu
 *
 * The menu bar is one bar for the whole application, and focus is per web
 * contents. An accelerator installed while Settings is in front is installed
 * for the workbench too — there is no "this window only" menu on macOS — so
 * making it right would mean rebuilding the bar on every focus change, and
 * rebuilding it would clobber the menu the workbench installs for itself.
 * A key that has to be right per surface has to be decided per surface.
 *
 * ## One list, two ways to raise it
 *
 * The rows below are the whole of DevHub's editing vocabulary, and both ways
 * of reaching a command read them: `menu.ts` builds the Edit menu from them,
 * and `keyboard.ts` matches keystrokes against them. A role name is also the
 * name of the `WebContents` method that performs it, which is what lets the
 * two paths raise the *same* command rather than two implementations of it.
 */

import type { KeyStroke } from "./chords.js";
import { SHELL_ORIGIN } from "./shellPageProtocol.js";

/**
 * What an editing command is called.
 *
 * Deliberately spelled once: this string is both the `MenuItem` role and the
 * `WebContents` method, and the two call sites type-check it as each.
 */
export type EditingRole =
	| "undo"
	| "redo"
	| "cut"
	| "copy"
	| "paste"
	| "pasteAndMatchStyle"
	| "delete"
	| "selectAll";

export interface EditingCommand {
	readonly role: EditingRole;
	/**
	 * The key that raises it, held with Command, or nothing when the command
	 * is reachable only by clicking the menu item.
	 *
	 * Command is implied because every one of these is a Command chord; Shift
	 * is written out because Cmd+Z and Cmd+Shift+Z are different commands.
	 */
	readonly key?: string;
	readonly shift?: boolean;
}

/**
 * The Edit menu, in the groups the separators divide it into.
 *
 * The grouping is here rather than in `menu.ts` so that the menu's shape and
 * the keys are still one list: a command added here appears in the menu and
 * answers its key without a second edit somewhere else.
 */
export const EDITING_COMMAND_GROUPS: readonly (readonly EditingCommand[])[] = [
	[
		{ role: "undo", key: "z" },
		{ role: "redo", key: "z", shift: true },
	],
	[
		{ role: "cut", key: "x" },
		{ role: "copy", key: "c" },
		{ role: "paste", key: "v" },
		{ role: "pasteAndMatchStyle" },
		{ role: "delete" },
		{ role: "selectAll", key: "a" },
	],
];

/**
 * Is this surface DevHub's own chrome?
 *
 * The App Shell page, the modal overlay and the Settings window are one bundle
 * served under three query strings from the scheme DevHub owns, and they are
 * the only web contents in the process that are DevHub's own HTML. Everything
 * else — a workbench, a Web Inspector — is a whole application with its own
 * keys, and is left alone.
 */
function isShellChrome(surfaceUrl: string): boolean {
	return surfaceUrl.startsWith(SHELL_ORIGIN);
}

/**
 * What this keystroke means on this surface, or nothing.
 *
 * Nothing is the answer for every key on a surface that is not DevHub's own
 * chrome, and for every key that is not one of these chords. Modifiers are
 * matched exactly, as they are for chords: Cmd+Ctrl+A is not Select All, and
 * an unclaimed chord must reach the surface rather than be swallowed.
 */
export function editingCommandFor(
	surfaceUrl: string,
	stroke: KeyStroke,
): EditingCommand | undefined {
	if (!isShellChrome(surfaceUrl)) return undefined;
	if (!stroke.command || stroke.option || stroke.control) return undefined;
	return EDITING_COMMAND_GROUPS.flat().find(
		(command) =>
			command.key !== undefined &&
			command.key.toLowerCase() === stroke.key.toLowerCase() &&
			(command.shift ?? false) === stroke.shift,
	);
}

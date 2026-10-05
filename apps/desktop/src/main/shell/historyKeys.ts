/**
 * Back and Forward from the keyboard, the mouse's side buttons and the
 * trackpad — and which of the two histories each one means.
 *
 * DevHub has two Back buttons' worth of history and they must not be
 * confused. The app's (`model/navigationHistory.ts`) is the places the window
 * has shown: a Workspace, an Agent, a split. A VS Code workbench has its own,
 * `workbench.action.navigateBack`/`navigateForward`, over cursor positions
 * and editors inside that one window. **Over an editor, the editor's history
 * wins**: that is the history the person was making while they typed there,
 * and a key that threw them out to another Agent instead would lose their
 * place in the file. So everything here is decided **per web contents**, the
 * same shape of answer as `terminalZoom.ts` and `editingCommands.ts`, and for
 * the same reason: only the layer in front of every surface (`keyboard.ts`)
 * knows which surface the key landed on.
 *
 * # The keys: `Cmd+[` and `Cmd+]`
 *
 * The Mac's own Back and Forward — Finder, Safari, Xcode, Mail, the App Store
 * all spell them this way — and free on every page DevHub draws: chords are
 * behind the `Cmd+Q` prefix, nothing in the menu has an accelerator
 * (`menu.ts`), and a text box on macOS gives these keys no meaning.
 *
 * They are claimed **only on DevHub's own pages** — the window's page with the
 * title bar, the Sidebar and the Agents — and left alone everywhere else. In a
 * workbench `Cmd+[`/`Cmd+]` are VS Code's Outdent and Indent Line, which no
 * one should lose to an app-level binding, and VS Code's own Back and Forward
 * there are `Ctrl+-` and `Ctrl+Shift+-`, which this layer never touches. That
 * is the editor-first rule for the keyboard: DevHub takes no key in an editor
 * at all, so the editor's bindings are the editor's.
 *
 * `Ctrl+-` was the other candidate, and it was turned down for the shell
 * pages because the Agents page hosts terminals, where `Ctrl+-` is a control
 * character (readline's undo) that a TUI Agent is entitled to receive. The
 * modals' page is left out on purpose: a question that is up holds the
 * keyboard, and leaving the place it was asked about from under it would be
 * answering it by walking away.
 *
 * Like the zoom keys, the bracket is matched by the *character*, as a chord's
 * second stroke is (`model/chordKeys.ts`): `[` and `]` move between the US and
 * JIS layouts, and what the person means is the bracket printed on the key.
 */

import type { KeyStroke } from "./chords.js";
import { SHELL_ORIGIN } from "./shellPageProtocol.js";
import type { NavigationDirection } from "../../model/navigationHistory.js";

/**
 * The pages where the app's history is the only one there is.
 *
 * Every page DevHub draws in the main window except the modals' and the
 * passive layers (notices, the tooltip), which never hold the keyboard.
 */
const APP_HISTORY_PAGES = ["index.html", "sidebar.html", "agents.html"].map(
	(page) => `${SHELL_ORIGIN}/${page}`,
);

/** Whether this web contents is one of DevHub's own pages that walk app history. */
export function isAppHistorySurface(surfaceUrl: string): boolean {
	return APP_HISTORY_PAGES.some((page) => surfaceUrl.startsWith(page));
}

/**
 * What this keystroke means to the app's history, or nothing.
 *
 * Nothing on every other surface — a workbench above all — and for every
 * other key. Modifiers are matched exactly: `Cmd+Shift+[` is a different
 * chord, and an unclaimed chord must travel on untouched.
 */
export function historyDirectionFor(
	surfaceUrl: string,
	stroke: KeyStroke,
): NavigationDirection | undefined {
	if (!isAppHistorySurface(surfaceUrl)) return undefined;
	if (!stroke.command || stroke.option || stroke.control || stroke.shift) {
		return undefined;
	}
	if (stroke.key === "[") return "back";
	if (stroke.key === "]") return "forward";
	return undefined;
}

/**
 * What an Electron `app-command` means, or nothing.
 *
 * Windows and Linux raise `browser-backward`/`browser-forward` for the
 * mouse's side buttons on the window; macOS raises nothing (the buttons
 * arrive in the page as `MouseEvent.button` 3 and 4 instead, which the Agents
 * page answers itself). Kept anyway so that the rule is complete, and so that
 * the same "which surface has the keyboard" question decides it.
 */
export function appCommandDirection(
	command: string,
): NavigationDirection | undefined {
	if (command === "browser-backward") return "back";
	if (command === "browser-forward") return "forward";
	return undefined;
}

/**
 * What a macOS `swipe` on the window means, or nothing.
 *
 * Only a horizontal swipe is a navigation. Swiping left goes Back, as it does
 * in Safari; this is the system's three-finger "swipe between pages", which
 * only arrives at all when the person set the trackpad to it.
 */
export function swipeDirection(
	direction: string,
): NavigationDirection | undefined {
	if (direction === "left") return "back";
	if (direction === "right") return "forward";
	return undefined;
}

/**
 * Where the chord layer meets Electron.
 *
 * Every `WebContents` DevHub owns — the App Shell page, each workbench, the
 * Settings window — gets the same handler, because a chord is about the
 * application, not about whichever surface happens to be focused. One router,
 * so arming in a terminal and completing in an editor is the same chord rather
 * than two half ones; and a change of focus disarms, so the second stroke
 * cannot land somewhere the person did not arm it against.
 *
 * `before-input-event` is the only place this can work. A chord typed over a
 * workbench or an xterm has to be caught before that surface sees it, and only
 * the main process sits in front of every surface at once.
 *
 * Sitting in front of every surface is also what lets this module answer the
 * Mac's editing keys for the one surface that cannot answer them itself. See
 * `editingCommands.ts`: Cmd+A in a Settings text box is decided here, per web
 * contents, because a menu accelerator would decide it for the whole
 * application and take Select All away from the editor.
 *
 * There is no on-screen hint that the prefix is armed. The App Shell page has
 * no status bar to put one in, and the page is covered by a workbench view for
 * most of a session, so a hint drawn there would be invisible exactly when it
 * was wanted. Somewhere to show it is a real gap; inventing a floating badge
 * for it is not this module's call.
 */

import { electron } from "../electron.js";
import { editingCommandFor } from "./editingCommands.js";
import { resolveChord, type ChordEffect } from "./chords.js";
import { KeyRouter, type KeyStroke } from "./keyRouter.js";
import type { AppSnapshotWire, NavigationContext } from "../../ipc/appShell.js";

/**
 * What a chord needs from the rest of the app.
 *
 * Deliberately the same handful of commands the menu bar asks for: a chord is
 * another way to raise a command DevHub already has, never a second
 * implementation of one.
 */
export interface ChordHost {
	/** The model as the page sees it, or nothing before the first projection. */
	snapshot(): AppSnapshotWire | undefined;
	selectContext(context: NavigationContext): void;
	/** Show or hide the integrated terminal in the workbench on screen. */
	toggleIntegratedTerminal(): void;
	openWorkspacePicker(): void;
	openSettings(): void;
}

const router = new KeyRouter();
let installed = false;

function strokeOf(input: Electron.Input): KeyStroke {
	return {
		key: input.key,
		command: input.meta,
		shift: input.shift,
		option: input.alt,
		control: input.control,
		isAutoRepeat: input.isAutoRepeat,
	};
}

function perform(host: ChordHost, effect: ChordEffect): void {
	switch (effect.kind) {
		case "select-context":
			host.selectContext(effect.context);
			return;
		case "toggle-terminal":
			host.toggleIntegratedTerminal();
			return;
		case "open-workspace-picker":
			host.openWorkspacePicker();
			return;
		case "open-settings":
			host.openSettings();
			return;
	}
}

function attach(contents: Electron.WebContents, host: ChordHost): void {
	contents.on("before-input-event", (event, input) => {
		if (input.type !== "keyDown") return;
		const stroke = strokeOf(input);
		const decision = router.route(stroke, Date.now());
		// `forward` and `pass` both mean the same thing to Electron: leave the
		// event alone and let the surface have it. They are separate decisions
		// because they mean different things to a reader.
		if (decision.kind === "forward") return;
		if (decision.kind === "pass") {
			// The chord layer wants nothing from this key. It may still be one of
			// the Mac's editing keys landing on a surface that has no way to
			// answer it — DevHub's own chrome — in which case this layer answers
			// it, and only for that surface. Anywhere else the key travels on
			// untouched, which is what leaves Cmd+A to Monaco.
			const command = editingCommandFor(contents.getURL(), stroke);
			if (!command) return;
			event.preventDefault();
			contents[command.role]();
			return;
		}
		event.preventDefault();
		if (decision.kind !== "run") return;
		// Before the first projection there is no model to resolve against, and
		// a chord that arrives then has nothing to act on. It is still swallowed:
		// the person completed a chord, and a half-eaten one reaching a surface
		// would be worse than one that did nothing.
		const snapshot = host.snapshot();
		if (!snapshot) return;
		const effect = resolveChord(decision.action, snapshot);
		// A chord with nothing to act on — no agents, no seventh workspace — is
		// a no-op by design, not a failure.
		if (effect) perform(host, effect);
	});
	contents.on("focus", () => {
		router.focusChanged();
	});
}

/** Install once, for every web contents this process will ever own. */
export function installKeyboard(host: ChordHost): void {
	if (installed) return;
	installed = true;
	electron.app.on("web-contents-created", (_event, contents) => {
		attach(contents, host);
	});
	for (const contents of electron.webContents.getAllWebContents()) {
		attach(contents, host);
	}
}

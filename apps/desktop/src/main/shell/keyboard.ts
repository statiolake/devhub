/**
 * Where the Command-Q chord meets Electron.
 *
 * Every `WebContents` DevHub owns — the App Shell page and each workbench —
 * gets the same handler, because the chord is about the application, not about
 * whichever surface happens to be focused. One router, so arming in a terminal
 * and completing in an editor is the same chord rather than two half ones; and
 * a change of focus disarms, so the second press cannot land somewhere the
 * person did not arm it against.
 */

import { electron } from "../electron.js";
import { KeyRouter, type KeyStroke } from "./keyRouter.js";

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

function attach(contents: Electron.WebContents): void {
	contents.on("before-input-event", (event, input) => {
		if (input.type !== "keyDown") return;
		const decision = router.route(strokeOf(input), Date.now());
		// `forward` and `pass` both mean the same thing to Electron: leave the
		// event alone and let the surface have it. They are separate decisions
		// because they mean different things to a reader.
		if (decision.kind === "consume" || decision.kind === "armed") {
			event.preventDefault();
		}
	});
	contents.on("focus", () => {
		router.focusChanged();
	});
}

/** Install once, for every web contents this process will ever own. */
export function installKeyboard(): void {
	if (installed) return;
	installed = true;
	electron.app.on("web-contents-created", (_event, contents) => {
		attach(contents);
	});
	for (const contents of electron.webContents.getAllWebContents()) {
		attach(contents);
	}
}

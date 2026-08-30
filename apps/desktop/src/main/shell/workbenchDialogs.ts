/**
 * Questions a workbench asks, drawn by DevHub rather than by Electron.
 *
 * VS Code raises a message box through the dialog service, and Electron shows
 * it as a sheet attached to a window. DevHub has one window, so a question
 * about *one workbench* — "do you want to save the changes you made?" — became
 * a sheet across the whole application, with the sidebar, the activities and
 * every other workspace frozen behind it. That is the wrong scope: the person
 * is being asked about one editor, and should still be able to look at
 * anything else while they decide.
 *
 * So a workbench's question becomes an ordinary DevHub modal: it goes on the
 * overlay layer like every other one, sized to that workbench's own rectangle,
 * and everything outside that rectangle stays live because the layer does not
 * cover it.
 */

import { shellWindow } from "./shellWindow.js";

/**
 * Button labels carry Windows mnemonics — "&&Save All", "Do&&n't Save".
 *
 * Electron strips them per platform on the way to the native dialog; nothing
 * does when the page draws the dialog, so it is done here, at the one place
 * these labels cross over.
 */
function withoutMnemonics(label: string): string {
	return label.replace(/&&/gu, "").replace(/&/gu, "");
}

/** How an Electron message-box type maps onto the page's alert tones. */
function toneOf(
	type: Electron.MessageBoxOptions["type"],
): "none" | "info" | "warning" | "error" | "question" {
	switch (type) {
		case "info":
		case "warning":
		case "error":
		case "question":
			return type;
		default:
			return "none";
	}
}

/**
 * Ask the person, and wait.
 *
 * There is deliberately no timeout: this is a question with no default answer,
 * and answering it for them — either way — is worse than waiting. The promise
 * settles if the window goes away, because then there is nobody to ask.
 */
export async function askWorkbenchDialog(
	options: Electron.MessageBoxOptions,
	surfaceKey: string,
): Promise<Electron.MessageBoxReturnValue> {
	const buttons = options.buttons ?? ["OK"];
	const response = await shellWindow().modals.ask({
		kind: "workbench-dialog",
		surfaceKey,
		message: options.message,
		detail: options.detail,
		buttons: buttons.map(withoutMnemonics),
		defaultId: options.defaultId ?? 0,
		cancelId: options.cancelId ?? Math.max(0, buttons.length - 1),
		tone: toneOf(options.type),
	});
	return { response, checkboxChecked: false };
}

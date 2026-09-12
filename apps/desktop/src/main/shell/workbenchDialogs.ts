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
import type { WorkbenchView } from "./workbenchView.js";

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
 *
 * It also settles when the *workbench* goes away, and that is the whole reason
 * this takes the view rather than only its key. A question stands until the
 * person answers it, until something newer replaces it, or until its subject
 * is gone — and closing a workspace is that third case. Without this, a remote
 * that could not be resolved left "Could not establish connection to …" on
 * screen over a workspace that no longer existed, one per attempt, with no
 * button in DevHub that could take it away: the view it belonged to had been
 * destroyed, so nothing was left to answer it. The alert's lifetime is a
 * property of its subject, not of whoever raised it.
 */
export async function askWorkbenchDialog(
	options: Electron.MessageBoxOptions,
	surfaceKey: string,
	view: WorkbenchView,
): Promise<Electron.MessageBoxReturnValue> {
	const modals = shellWindow().modals;
	const buttons = options.buttons ?? ["OK"];
	const subjectGone = (): void => {
		modals.closeWhere(
			(modal) =>
				modal.request.kind === "workbench-dialog" &&
				modal.request.surfaceKey === surfaceKey,
		);
	};
	view.once("closed", subjectGone);
	try {
		const response = await modals.ask({
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
	} finally {
		view.off("closed", subjectGone);
	}
}

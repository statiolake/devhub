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
 * So a workbench's question is forwarded to the App Shell page, which draws it
 * over that workbench's own area in DevHub's own alert shape, and answers it.
 * Everything outside the viewport keeps working while it stands.
 */

import { randomUUID } from "node:crypto";
import { electron } from "../electron.js";
import {
	CHANNELS,
	type WorkbenchDialogAnswer,
	type WorkbenchDialogRequest,
} from "../../ipc/contract.js";
import { shellWindowIfCreated } from "./shellWindow.js";
import type { WorkbenchView } from "./workbenchView.js";

const pending = new Map<string, (response: number) => void>();
let installed = false;

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
function kindOf(
	type: Electron.MessageBoxOptions["type"],
): WorkbenchDialogRequest["kind"] {
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

export function installWorkbenchDialogs(): void {
	if (installed) return;
	installed = true;
	electron.ipcMain.handle(
		CHANNELS.workbenchDialogAnswer,
		(_event, answer: WorkbenchDialogAnswer) => {
			const settle = pending.get(answer.id);
			if (!settle) return;
			pending.delete(answer.id);
			settle(answer.response);
		},
	);
}

/**
 * Ask the page, and wait for the person.
 *
 * There is deliberately no timeout: this is a question with no default answer,
 * and answering it for them — either way — is worse than waiting. The promise
 * settles if the window goes away, because then there is nobody to ask.
 */
/**
 * The workbench as it looks right now, as a data URL.
 *
 * DOM cannot be painted over a native view, so any DevHub surface that has to
 * appear above a workbench stands that workbench down first — and without this
 * the editor would simply vanish underneath, which is alarming and makes what
 * replaced it harder to read. The still image is what keeps the workbench
 * *there* while it is not accepting input.
 *
 * Only meaningful while the view is actually on screen; an off-screen view
 * captures as nothing, and nothing is the right answer then anyway, because
 * there was nothing to preserve.
 */
export async function captureBackdrop(
	view: WorkbenchView,
): Promise<string | undefined> {
	return view.webContents
		.capturePage()
		.then((image) => (image.isEmpty() ? undefined : image.toDataURL()))
		.catch(() => undefined);
}

export async function askWorkbenchDialog(
	options: Electron.MessageBoxOptions,
	surfaceKey: string,
	view: WorkbenchView,
): Promise<Electron.MessageBoxReturnValue> {
	const shell = shellWindowIfCreated();
	if (!shell) throw new Error("no App Shell window to ask");
	const buttons = options.buttons ?? ["OK"];
	const id = randomUUID();
	// Taken before the view stands down, so the still image is the workbench as
	// it was at the moment it asked.
	const backdrop = await captureBackdrop(view);
	const request: WorkbenchDialogRequest = {
		id,
		surfaceKey,
		backdrop,
		message: options.message,
		detail: options.detail,
		buttons: buttons.map(withoutMnemonics),
		defaultId: options.defaultId ?? 0,
		cancelId: options.cancelId ?? Math.max(0, buttons.length - 1),
		kind: kindOf(options.type),
	};
	const response = await new Promise<number>((resolve) => {
		pending.set(id, resolve);
		const onClosed = () => {
			if (pending.delete(id)) resolve(request.cancelId);
		};
		shell.window.once("closed", onClosed);
		shell.window.webContents.send(CHANNELS.workbenchDialog, request);
	});
	return { response, checkboxChecked: false };
}

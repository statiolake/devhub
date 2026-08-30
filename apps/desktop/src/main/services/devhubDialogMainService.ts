/**
 * Dialogs, put where the thing they are about is.
 *
 * The main process hands `electron.dialog` the "window" a dialog belongs to.
 * For a workbench that is a `WorkbenchView`, and Electron does not accept it:
 * it is not a `BrowserWindow`, so the sheet is not attached at all.
 *
 * Mapping those to the App Shell window is right for a file picker, which is
 * genuinely a question the application is asking. It is wrong for a message
 * box: "do you want to save the changes you made?" is about one workbench, and
 * as a window-modal sheet it covers the whole of DevHub and freezes every
 * other workspace behind it while the person decides. Those go to the page
 * instead, which draws them over the workbench they belong to.
 */

import { DialogMainService } from "code-oss-dev/out/vs/platform/dialogs/electron-main/dialogMainService.js";
import { shellWindowIfCreated } from "../shell/shellWindow.js";
import { askWorkbenchDialog } from "../shell/workbenchDialogs.js";
import { appController } from "../shell/appController.js";

function parentWindow(
	window?: Electron.BrowserWindow,
): Electron.BrowserWindow | undefined {
	const shell = shellWindowIfCreated();
	if (!window || !shell) {
		return window;
	}
	return shell.getViewById(window.id) ? shell.window : window;
}

export class DevHubDialogMainService extends DialogMainService {
	// The `pick*` methods all funnel through `showOpenDialog`, so mapping the
	// three dialogs Electron actually opens covers every caller.

	override showMessageBox(
		options: Electron.MessageBoxOptions,
		window?: Electron.BrowserWindow,
	): Promise<Electron.MessageBoxReturnValue> {
		const shell = shellWindowIfCreated();
		const view = window ? shell?.getViewById(window.id) : undefined;
		const surfaceKey = window
			? appController().editorSurfaceKeyForView(window.id)
			: undefined;
		if (view && surfaceKey !== undefined) {
			return askWorkbenchDialog(options, surfaceKey);
		}
		return super.showMessageBox(options, parentWindow(window));
	}

	override showSaveDialog(
		options: Electron.SaveDialogOptions,
		window?: Electron.BrowserWindow,
	): Promise<Electron.SaveDialogReturnValue> {
		return super.showSaveDialog(options, parentWindow(window));
	}

	override showOpenDialog(
		options: Electron.OpenDialogOptions,
		window?: Electron.BrowserWindow,
	): Promise<Electron.OpenDialogReturnValue> {
		return super.showOpenDialog(options, parentWindow(window));
	}
}

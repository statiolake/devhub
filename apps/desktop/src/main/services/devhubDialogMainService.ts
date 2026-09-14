/**
 * Dialogs, put where the thing they are about is.
 *
 * The main process hands `electron.dialog` the "window" a dialog belongs to.
 * For a workbench that is a `WorkbenchView`, and Electron does not accept it —
 * worse, it does not refuse it either. See `parentWindow`, where the mapping
 * that keeps that from being a crash lives.
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
import { workbenchViewOf } from "../shell/workbenchView.js";

/**
 * The real window a dialog can be attached to.
 *
 * A `WorkbenchView` is not one, and Electron does not say so: `dialog.show*`
 * decides from the *shape* of its first argument whether it was given a parent
 * window or an options object, and a view satisfies neither test cleanly. Given
 * one it reads the options off the view instead — every field `undefined` — and
 * throws `TypeError: Invalid message box type` from inside the dialog queue,
 * which is an uncaught exception in main and takes the application with it.
 *
 * So the mapping is not a nicety; it is what keeps a dialog from being a crash.
 * Which is why it asks the object what it is rather than looking it up in the
 * shell's table of live views: a workbench whose renderer has just died is off
 * that table, and a dialog about a dead workbench is precisely the one upstream
 * raises next.
 */
function parentWindow(
	window?: Electron.BrowserWindow,
): Electron.BrowserWindow | undefined {
	if (!window || !workbenchViewOf(window)) {
		return window;
	}
	return shellWindowIfCreated()?.window;
}

export class DevHubDialogMainService extends DialogMainService {
	// The `pick*` methods all funnel through `showOpenDialog`, so mapping the
	// three dialogs Electron actually opens covers every caller.

	override showMessageBox(
		options: Electron.MessageBoxOptions,
		window?: Electron.BrowserWindow,
	): Promise<Electron.MessageBoxReturnValue> {
		const view = workbenchViewOf(window);
		const surfaceKey = view
			? appController().editorSurfaceKeyForView(view.id)
			: undefined;
		if (view && surfaceKey !== undefined) {
			return askWorkbenchDialog(options, surfaceKey, view);
		}
		if (view?.isDestroyed()) {
			// A question about a workbench that is no longer there. It is drawn
			// over the workbench it is about, and there is no longer one to draw
			// it over; the only such question upstream asks is "the window
			// terminated unexpectedly — reopen it?", which DevHub has already
			// answered by the time it is asked. `editorSupervisor.ts` reopens
			// the workbench, and when it stops reopening it says so on the
			// Workspace's own row with the person's way out attached. Asking
			// again, as a sheet over the whole application, about a window
			// nobody ever saw, would be a second answer to that.
			console.log(
				`[devhub] dialog: '${options.message}' is about a workbench that has gone — the Workspace's row is where that is said`,
			);
			return Promise.resolve({
				response: options.cancelId ?? 0,
				checkboxChecked: false,
			});
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

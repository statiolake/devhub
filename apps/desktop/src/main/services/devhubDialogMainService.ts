/**
 * Native dialogs, parented to the one window DevHub actually has.
 *
 * The main process hands `electron.dialog` the "window" a dialog belongs to.
 * For a workbench that is a `WorkbenchView`, and Electron does not accept it:
 * it is not a `BrowserWindow`, so the sheet is not attached at all. Everything
 * that reaches Electron is therefore mapped to the App Shell window first.
 */

import { DialogMainService } from 'code-oss-dev/out/vs/platform/dialogs/electron-main/dialogMainService.js';
import { shellWindowIfCreated } from '../shell/shellWindow.js';

function parentWindow(window?: Electron.BrowserWindow): Electron.BrowserWindow | undefined {
	const shell = shellWindowIfCreated();
	if (!window || !shell) {
		return window;
	}
	return shell.getViewById(window.id) ? shell.window : window;
}

export class DevHubDialogMainService extends DialogMainService {

	// The `pick*` methods all funnel through `showOpenDialog`, so mapping the
	// three dialogs Electron actually opens covers every caller.

	override showMessageBox(options: Electron.MessageBoxOptions, window?: Electron.BrowserWindow): Promise<Electron.MessageBoxReturnValue> {
		return super.showMessageBox(options, parentWindow(window));
	}

	override showSaveDialog(options: Electron.SaveDialogOptions, window?: Electron.BrowserWindow): Promise<Electron.SaveDialogReturnValue> {
		return super.showSaveDialog(options, parentWindow(window));
	}

	override showOpenDialog(options: Electron.OpenDialogOptions, window?: Electron.BrowserWindow): Promise<Electron.OpenDialogReturnValue> {
		return super.showOpenDialog(options, parentWindow(window));
	}
}

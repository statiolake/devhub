/**
 * Teach Electron's `BrowserWindow` about DevHub's workbench views.
 *
 * VS Code's main process finds windows through four statics on that class —
 * `getAllWindows`, `fromWebContents`, `getFocusedWindow`, `fromId`. DevHub's
 * workbenches are not windows but `WebContentsView`s inside the one App Shell
 * window, so those four are replaced here, once, before any VS Code module
 * loads. Everything upstream that resolves a window by id then keeps working
 * unmodified: `CodeWindow.id` is its window's id, and a view's id is its
 * webContents id.
 *
 * The construction site cannot be reached this way. `electron.BrowserWindow`
 * is a non-configurable accessor on the module object, so the class itself
 * cannot be swapped for a subclass whose constructor returns a view. That one
 * site is therefore the single source patch DevHub carries against the
 * submodule — patches/vscode/0001-workbench-window-is-a-view.patch — and it
 * calls the factory installed here as a global.
 *
 * Both facts are checked at startup and fail loudly. A silent fallback would
 * leave the workbench quietly opening real windows of its own.
 */

import { electron } from "../electron.js";
import { shellWindow, shellWindowIfCreated } from "./shellWindow.js";
import { asBrowserWindow, WorkbenchView } from "./workbenchView.js";

declare global {
	var __devhubCreateWorkbenchWindow:
		| ((
				options: Electron.BrowserWindowConstructorOptions,
		  ) => Electron.BrowserWindow)
		| undefined;
}

function createWorkbenchWindow(
	options: Electron.BrowserWindowConstructorOptions,
): Electron.BrowserWindow {
	const shell = shellWindow();
	const view = new WorkbenchView(shell, options);
	shell.attach(view);
	console.log(
		`[devhub] workbench view ${view.id} created — ${shell.getViews().length} view(s) in the shell`,
	);
	return asBrowserWindow(view);
}

function assertReplaceable(
	target: object,
	property: string,
	what: string,
): void {
	const descriptor = Object.getOwnPropertyDescriptor(target, property);
	if (!descriptor?.writable && !descriptor?.configurable) {
		throw new Error(
			`DevHub cannot replace ${what}: it is a ${descriptor?.get ? "non-configurable accessor" : "read-only property"}`,
		);
	}
}

export function installBrowserWindowShim(): void {
	const BrowserWindow = electron.BrowserWindow;

	// Captured before they are replaced; the replacements call them.
	const realGetAllWindows = BrowserWindow.getAllWindows.bind(BrowserWindow);
	const realFromWebContents = BrowserWindow.fromWebContents.bind(BrowserWindow);
	const realGetFocusedWindow =
		BrowserWindow.getFocusedWindow.bind(BrowserWindow);
	const realFromId = BrowserWindow.fromId.bind(BrowserWindow);

	for (const name of [
		"getAllWindows",
		"fromWebContents",
		"getFocusedWindow",
		"fromId",
	] as const) {
		assertReplaceable(BrowserWindow, name, `BrowserWindow.${name}`);
	}

	/**
	 * The views join the real windows; nothing is taken away. The App Shell
	 * window is one of DevHub's windows too, and code that walks this list is
	 * asking about real windows on screen — the frame authorisation in
	 * `app.ts`, for one, which serves `vscode-file:` only to a frame belonging
	 * to a window it finds here, and the App Shell page is served that way.
	 */
	BrowserWindow.getAllWindows = () => {
		const shell = shellWindowIfCreated();
		if (!shell) {
			return realGetAllWindows();
		}
		return [
			...realGetAllWindows(),
			...shell.getViews().map((view) => asBrowserWindow(view)),
		];
	};

	BrowserWindow.fromWebContents = (webContents) => {
		const view = shellWindowIfCreated()?.getViewById(webContents.id);
		return view ? asBrowserWindow(view) : realFromWebContents(webContents);
	};

	BrowserWindow.fromId = (id) => {
		const view = shellWindowIfCreated()?.getViewById(id);
		return view ? asBrowserWindow(view) : realFromId(id);
	};

	/**
	 * The one place the App Shell window must *not* be the answer. Focus lives
	 * on it, but "which window is focused" is asked in order to find the
	 * workbench the person is working in, and that is whichever view's contents
	 * hold focus inside the shell.
	 */
	BrowserWindow.getFocusedWindow = () => {
		const shell = shellWindowIfCreated();
		const window = realGetFocusedWindow();
		if (!shell || window !== shell.window) {
			return window;
		}
		const view = shell
			.getViews()
			.find((candidate) => candidate.webContents.isFocused());
		return view ? asBrowserWindow(view) : null;
	};

	globalThis.__devhubCreateWorkbenchWindow = createWorkbenchWindow;

	console.log("[devhub] BrowserWindow shim installed");
}

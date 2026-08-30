/**
 * DevHub's answer to "open this folder in a window".
 *
 * VS Code funnels every open — the sidebar, File > Open Folder, `--new-window`
 * from the command line, a window restored from the last session — through
 * `openInBrowserWindow`. DevHub never makes a second window: a folder it
 * already knows gets its view shown, a folder it does not becomes a workspace
 * in the sidebar and a view beside the others.
 *
 * `openInBrowserWindow` is `private` upstream. TypeScript privacy is not
 * runtime privacy: the override below is installed on the prototype, which is
 * where the rest of `WindowsMainService` looks it up. Naming it here is the
 * point — a VS Code bump has to check that this member still exists.
 */

import { WindowsMainService } from "code-oss-dev/out/vs/platform/windows/electron-main/windowsMainService.js";
import type { ICodeWindow } from "code-oss-dev/out/vs/platform/window/electron-main/window.js";
import { isSingleFolderWorkspaceIdentifier } from "code-oss-dev/out/vs/platform/workspace/common/workspace.js";
import { Schemas } from "code-oss-dev/out/vs/base/common/network.js";
import { appController } from "../shell/appController.js";

/** The part of the upstream options DevHub reads, plus the method it replaces. */
interface WindowsMainServiceInternals {
	getWindowById(windowId: number): ICodeWindow | undefined;
	openInBrowserWindow(options: OpenBrowserWindowOptions): Promise<ICodeWindow>;
}

interface OpenBrowserWindowOptions {
	readonly workspace?: unknown;
	readonly forceNewWindow?: boolean;
}

export class DevHubWindowsMainService extends WindowsMainService {}

const upstreamOpenInBrowserWindow = (
	WindowsMainService.prototype as unknown as WindowsMainServiceInternals
).openInBrowserWindow;

(
	DevHubWindowsMainService.prototype as unknown as WindowsMainServiceInternals
).openInBrowserWindow = async function (
	this: WindowsMainServiceInternals,
	options,
) {
	const workspace = options.workspace;
	const folder =
		isSingleFolderWorkspaceIdentifier(workspace) &&
		workspace.uri.scheme === Schemas.file
			? workspace.uri.fsPath
			: undefined;

	if (!folder) {
		console.log("[devhub] open: no folder — a workbench view in the shell");
		return upstreamOpenInBrowserWindow.call(this, options);
	}

	// The folder is the key, not the Workspace identity: a view and a Workspace
	// are two objects with two lifetimes, and the folder is the only thing both
	// agree about — which is what lets this path and a click in the Sidebar land
	// on the same view without an ordering rule between them.
	const controller = appController();
	const existingId = controller.viewIdForFolder(folder);
	const existing =
		existingId === undefined ? undefined : this.getWindowById(existingId);
	if (existing) {
		console.log(`[devhub] open: '${folder}' already has a view — showing it`);
		controller.revealFolderView(folder);
		return existing;
	}

	console.log(
		`[devhub] open: '${folder}' is new — a workbench view in the shell`,
	);
	const window = await upstreamOpenInBrowserWindow.call(this, options);
	controller.bindFolderView(folder, window.id);
	controller.noteFolder(folder);
	return window;
};

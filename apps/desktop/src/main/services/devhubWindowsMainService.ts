/**
 * DevHub's answer to "open this folder in a window".
 *
 * VS Code funnels every open — the sidebar, File > Open Folder, `--new-window`
 * from the command line, a window restored from the last session — through
 * `openInBrowserWindow`. DevHub never makes a second window, and it never
 * makes a workbench that belongs to nothing: every request is reinterpreted as
 * one of DevHub's own two operations.
 *
 *   - **With a folder** it is a Workspace: one DevHub already knows gets its
 *     view shown, one it does not becomes a Workspace in the sidebar and a
 *     view beside the others.
 *   - **With no folder** it is the Scratch editor. "New window" has no meaning
 *     in an app with one window, and an empty workbench that is not Scratch
 *     would be a view with no row in the sidebar, no Workspace, and no way to
 *     get back to it. Any files the request carried go to Scratch too, which
 *     is the same rule `devhub <file>` follows for a file no open Workspace
 *     contains: one policy, two entrances.
 *
 * The `devhub` CLI does **not** come through here. It talks to DevHub's control
 * socket (`src/main/cli/`), which is DevHub's own front door; this path is
 * VS Code's. Two protocols would be two truths about what "open this" means,
 * and only one of them would stay true.
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
	/** Upstream's `IFilesToOpen`, passed on untouched. */
	readonly filesToOpen?: unknown;
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

	const controller = appController();

	if (!folder) {
		// The one no-folder request that is not a request for Scratch is
		// DevHub building Scratch itself: answering that with "here is the
		// Scratch workbench" would be asking for the thing being created.
		if (controller.isOpeningScratch()) {
			console.log("[devhub] open: building the Scratch workbench");
			return upstreamOpenInBrowserWindow.call(this, options);
		}
		console.log("[devhub] open: no folder — the Scratch editor");
		const scratch = await controller.scratchWorkbench();
		if (options.filesToOpen) {
			controller.sendFilesToWorkbench(scratch, options.filesToOpen);
		}
		return scratch;
	}

	// The folder is the key, not the Workspace identity: a view and a Workspace
	// are two objects with two lifetimes, and the folder is the only thing both
	// agree about — which is what lets this path and a click in the Sidebar land
	// on the same view without an ordering rule between them.
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

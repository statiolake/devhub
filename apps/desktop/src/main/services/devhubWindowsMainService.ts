/**
 * DevHub's answer to "open this folder in a window".
 *
 * VS Code funnels every open — the sidebar, File > Open Folder, `--new-window`
 * from the command line, a window restored from the last session — through
 * `openInBrowserWindow`. DevHub never makes a second window for a workbench,
 * and it never makes a workbench that belongs to nothing: every request is
 * reinterpreted as one of DevHub's own two operations.
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
 * The one request that is neither is an **Extension Development Host**: not a
 * place DevHub can hold a Workspace for, but a whole second VS Code that a
 * debug session opens and closes. That one goes to upstream untouched, and
 * gets a real window; see the override below.
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
import type {
	IOpenConfiguration,
	IOpenEmptyConfiguration,
} from "code-oss-dev/out/vs/platform/windows/electron-main/windows.js";
import { OpenContext } from "code-oss-dev/out/vs/platform/windows/electron-main/windows.js";
import type { IOpenEmptyWindowOptions } from "code-oss-dev/out/vs/platform/window/common/window.js";
import { isSingleFolderWorkspaceIdentifier } from "code-oss-dev/out/vs/platform/workspace/common/workspace.js";
import { locationKey } from "../../model/domain.js";
import { locationFromWorkspaceUri } from "../shell/editorPlace.js";
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
	/**
	 * Upstream's `NativeParsedArgs`. Only the one field DevHub reads is named:
	 * `openInBrowserWindow` spreads this over the window configuration, so it is
	 * where "this window is an Extension Development Host" is decided.
	 */
	readonly cli?: { readonly extensionDevelopmentPath?: string[] };
}

export class DevHubWindowsMainService extends WindowsMainService {
	/**
	 * The Dock icon has one answer, and it is DevHub's.
	 *
	 * Clicking a Mac app's Dock icon when it has no visible window means "show
	 * me the application". DevHub answers that in `bootstrapShell.ts`: the App
	 * Shell window comes back, with every workspace, terminal and Agent still
	 * in it. VS Code answers the same event by opening an empty window, and
	 * because DevHub's shell window hides rather than closes, Electron reports
	 * no visible windows and both answers ran — so a click meant to bring the
	 * app back also grew a Scratch workbench nobody asked for.
	 *
	 * Two answers to one question is the problem, not which of them is nicer,
	 * so this drops VS Code's. `OpenContext.DOCK` is the Dock talking, and the
	 * Dock talks to DevHub. Every other context — the menu, the CLI, the API —
	 * goes through untouched.
	 *
	 * A VS Code bump has to re-check that `app.on('activate')` still asks for
	 * `openEmptyWindow({ context: OpenContext.DOCK })` and nothing else. The
	 * other `DOCK` caller is upstream's own Dock menu (`menubar.ts`), whose
	 * "New Window" item this therefore also drops — DevHub's Dock menu is not
	 * VS Code's to write, and taking it back is the `app` fence's job.
	 */
	override openEmptyWindow(
		openConfig: IOpenEmptyConfiguration,
		options?: IOpenEmptyWindowOptions,
	): Promise<ICodeWindow[]> {
		if (openConfig.context === OpenContext.DOCK) {
			console.log("[devhub] open: the Dock icon is the App Shell's to answer");
			return Promise.resolve([]);
		}
		return super.openEmptyWindow(openConfig, options);
	}

	/**
	 * A document handed over by the desktop has one answer too, and it is
	 * DevHub's.
	 *
	 * `OpenContext.DOCK` reaches `open` from exactly one place upstream: the
	 * `app.on('open-file')` handler in `vs/code/electron-main/app.ts`, which is
	 * Finder's "Open With", a drop on the Dock tile and `open -a DevHub <file>`.
	 * Upstream answers it with `preferNewWindow: true` — a new window holding
	 * that file. DevHub has one window, and where a file lands in it is
	 * `AppController.openFromCli`'s rule: the workspace whose root contains it,
	 * or the Scratch editor. Left in place, upstream's answer ran *as well as*
	 * DevHub's and the file was opened twice, the second time in the wrong place.
	 *
	 * So this drops it, and `shell/openFromFinder.ts` is the only listener that
	 * acts. Two answers to one question is the problem, the same one the Dock
	 * icon above has; they are next to each other because they are one rule.
	 *
	 * A VS Code bump has to re-check that `open` still receives `DOCK` only from
	 * that handler. The other `DOCK` caller, `openFirstWindow`, is already
	 * DevHub's own and opens nothing.
	 */
	override open(openConfig: IOpenConfiguration): Promise<ICodeWindow[]> {
		if (openConfig.context === OpenContext.DOCK) {
			console.log(
				"[devhub] open: a document from the desktop is openFromFinder's to answer",
			);
			return Promise.resolve([]);
		}
		return super.open(openConfig);
	}
}

const upstreamOpenInBrowserWindow = (
	WindowsMainService.prototype as unknown as WindowsMainServiceInternals
).openInBrowserWindow;

(
	DevHubWindowsMainService.prototype as unknown as WindowsMainServiceInternals
).openInBrowserWindow = async function (
	this: WindowsMainServiceInternals,
	options,
) {
	// An Extension Development Host is not a DevHub Workspace and is not placed
	// like one. It is a second VS Code, started by a debug session and closed by
	// it, running the extension under development in its own extension host —
	// DevHub has no row to give it, no view to reveal, and nothing to reveal it
	// *in* once the debugger stops. It was reaching here with no folder, which
	// is DevHub's signal for Scratch, so pressing F5 in an extension repository
	// silently re-showed the Scratch editor and the debug session had nothing to
	// attach to. Upstream's path is the whole answer, so upstream gets the whole
	// request; `browserWindowShim.ts` gives it a real `BrowserWindow` to match.
	if (options.cli?.extensionDevelopmentPath?.length) {
		console.log(
			"[devhub] open: an Extension Development Host is a window of its own",
		);
		return upstreamOpenInBrowserWindow.call(this, options);
	}

	const workspace = options.workspace;
	// Which *place*, not which path: a folder on another machine has no local
	// path at all, and reading `fsPath` off a `vscode-remote://` URI produces
	// something that looks like one and names nowhere. See `editorPlace.ts`.
	const location = isSingleFolderWorkspaceIdentifier(workspace)
		? locationFromWorkspaceUri(workspace.uri)
		: undefined;
	const editorKey = location === undefined ? undefined : locationKey(location);

	const controller = appController();

	if (!location || editorKey === undefined) {
		// DevHub never builds a folderless workbench — Scratch is a folder, so
		// its workbench comes through the branch below like any other — and so
		// every request without one is a request for somewhere to scribble.
		console.log("[devhub] open: no folder — Scratch");
		let scratch: ICodeWindow;
		try {
			scratch = await controller.scratchWorkbench();
		} catch (error) {
			// Said in the app as well as answered to whoever asked: a second
			// `code`-style launch from a terminal prints the rejection, but one
			// from Finder or the Dock has nobody reading its output, and a
			// refused Scratch (no settings, no folder) would then be nothing
			// happening. Re-raised, because the request did fail.
			controller.noteFailure(error);
			throw error;
		}
		if (options.filesToOpen) {
			controller.sendFilesToWorkbench(scratch, options.filesToOpen);
		}
		return scratch;
	}

	// The place is the key, not the Workspace identity: a view and a Workspace
	// are two objects with two lifetimes, and the place is the only thing both
	// agree about — which is what lets this path and a click in the Sidebar land
	// on the same view without an ordering rule between them.
	const existingId = controller.viewIdForEditorKey(editorKey);
	const existing =
		existingId === undefined ? undefined : this.getWindowById(existingId);
	if (existing) {
		console.log(
			`[devhub] open: '${editorKey}' already has a view — showing it`,
		);
		controller.assertArrangement();
		return existing;
	}

	console.log(
		`[devhub] open: '${editorKey}' is new — a workbench view in the shell`,
	);
	const window = await upstreamOpenInBrowserWindow.call(this, options);
	controller.bindEditorKeyView(editorKey, window.id);
	controller.noteLocation(location);
	return window;
};

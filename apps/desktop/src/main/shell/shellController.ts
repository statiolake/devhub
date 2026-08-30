/**
 * What the App Shell page can ask for, and what happens when it does.
 *
 * The controller is the only place that knows both halves of DevHub: the
 * workspaces the sidebar lists, and the workbench views the shell hosts. Every
 * route into "show me this workspace" — a click in the sidebar, "open folder"
 * inside a workbench, `--new-window <folder>` from the command line — ends up
 * in `select`, and there is exactly one way from there to a view on screen.
 */

import { electron } from "../electron.js";
import { URI } from "code-oss-dev/out/vs/base/common/uri.js";
import type { NativeParsedArgs } from "code-oss-dev/out/vs/platform/environment/common/argv.js";
import type { IWindowsMainService } from "code-oss-dev/out/vs/platform/windows/electron-main/windows.js";
import { OpenContext } from "code-oss-dev/out/vs/platform/windows/electron-main/windows.js";
import type { IDialogMainService } from "code-oss-dev/out/vs/platform/dialogs/electron-main/dialogMainService.js";
import {
	CHANNELS,
	type ContentRect,
	type ShellState,
} from "../../ipc/contract.js";
import { shellWindow } from "./shellWindow.js";
import {
	toWireWorkspace,
	WorkspaceStore,
	type WorkspaceEntry,
} from "./workspaces.js";

/**
 * The two main-process services the shell drives. They are resolved on demand:
 * the DI container builds them lazily, and the shell exists before it does.
 */
export interface MainServices {
	windows(): IWindowsMainService;
	dialogs(): IDialogMainService;
}

export class ShellController {
	/** workspace id -> the `ICodeWindow` id of its workbench view. */
	private readonly windowIds = new Map<string, number>();

	private selectedId: string | undefined;

	private resolveServices: MainServices | undefined;

	constructor(
		private readonly store: WorkspaceStore,
		private readonly cliArgs: NativeParsedArgs,
	) {
		this.registerIpc();
	}

	/**
	 * The main-process services are built by VS Code's DI container, which is
	 * only assembled once the application starts up; the shell exists before
	 * that so the first workbench has somewhere to go.
	 */
	setServices(services: MainServices): void {
		this.resolveServices = services;
	}

	private services(): MainServices {
		if (!this.resolveServices) {
			throw new Error(
				"the App Shell was used before the main services were registered",
			);
		}
		return this.resolveServices;
	}

	//#region state

	state(): ShellState {
		return {
			workspaces: this.store
				.all()
				.map((entry) => toWireWorkspace(entry, this.windowIds.has(entry.id))),
			selectedId: this.selectedId,
		};
	}

	private publish(): void {
		const shell = shellWindow();
		if (!shell.window.isDestroyed()) {
			shell.window.webContents.send(CHANNELS.stateChanged, this.state());
		}
	}

	//#endregion

	//#region the workbench views

	/** Remembers a folder as a workspace. Idempotent by path. */
	noteWorkspace(folderPath: string): WorkspaceEntry {
		return this.store.add(folderPath);
	}

	windowIdFor(workspaceId: string): number | undefined {
		return this.windowIds.get(workspaceId);
	}

	bind(workspaceId: string, windowId: number): void {
		this.windowIds.set(workspaceId, windowId);
		this.selectedId = workspaceId;
		this.publish();
	}

	/**
	 * Show a workspace. Its view is created on first selection and kept alive
	 * afterwards, so coming back to one costs nothing and loses nothing.
	 */
	async select(workspaceId: string): Promise<void> {
		const entry = this.store.byId(workspaceId);
		if (!entry) {
			throw new Error(`no such workspace: ${workspaceId}`);
		}

		const windowId = this.windowIds.get(workspaceId);
		const view =
			windowId === undefined ? undefined : shellWindow().getViewById(windowId);
		if (view) {
			shellWindow().reveal(view);
			view.focus();
			this.selectedId = workspaceId;
			this.publish();
			return;
		}

		// No view yet: go through VS Code's own open path, which is what
		// creates a `CodeWindow` — and therefore, through the shim, a view.
		await this.services()
			.windows()
			.open({
				context: OpenContext.API,
				cli: this.cliArgs,
				urisToOpen: [{ folderUri: URI.file(entry.path) }],
				forceNewWindow: true,
				noRecentEntry: false,
			});
	}

	private async addWorkspace(): Promise<void> {
		const picked = await this.services().dialogs().pickFolder({});
		const folder = picked?.[0];
		if (!folder) {
			return; // the person cancelled the picker; nothing failed
		}
		const entry = this.noteWorkspace(folder);
		this.publish();
		await this.select(entry.id);
	}

	private async removeWorkspace(workspaceId: string): Promise<void> {
		const entry = this.store.remove(workspaceId);
		if (!entry) {
			throw new Error(`no such workspace: ${workspaceId}`);
		}
		const windowId = this.windowIds.get(workspaceId);
		this.windowIds.delete(workspaceId);
		if (windowId !== undefined) {
			shellWindow().getViewById(windowId)?.destroy();
		}
		if (this.selectedId === workspaceId) {
			this.selectedId = undefined;
		}
		this.publish();
	}

	//#endregion

	//#region the page

	private registerIpc(): void {
		electron.ipcMain.handle(CHANNELS.getState, () => this.state());
		electron.ipcMain.handle(
			CHANNELS.selectWorkspace,
			(_event, workspaceId: string) => this.select(workspaceId),
		);
		electron.ipcMain.handle(CHANNELS.addWorkspace, () => this.addWorkspace());
		electron.ipcMain.handle(
			CHANNELS.removeWorkspace,
			(_event, workspaceId: string) => this.removeWorkspace(workspaceId),
		);
		electron.ipcMain.handle(
			CHANNELS.setContentRect,
			(_event, rect: ContentRect) => {
				shellWindow().setContentRect(rect);
			},
		);
	}

	//#endregion
}

let current: ShellController | undefined;

export function createShellController(
	store: WorkspaceStore,
	cliArgs: NativeParsedArgs,
): ShellController {
	if (current) {
		throw new Error("the App Shell controller already exists");
	}
	current = new ShellController(store, cliArgs);
	return current;
}

export function shellController(): ShellController {
	if (!current) {
		throw new Error("the App Shell controller has not been created yet");
	}
	return current;
}

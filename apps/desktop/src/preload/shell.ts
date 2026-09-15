/**
 * The window's own page's bridge — `index.html`.
 *
 * What is left of the window when the Sidebar, the Agents, the notices and the
 * questions are views of their own: the title bar, the states in which there
 * is no child view to show, and the seam of a split. See `ShellPageBridge`.
 */

import { contextBridge, ipcRenderer } from "electron";
import {
	CHANNELS,
	type EditorRestartingWire,
	type ShellPageBridge,
	type WorkbenchAreaWire,
} from "../ipc/contract.js";
import {
	appearanceBridge,
	closeWorkspace,
	on,
	openModal,
	openSettings,
	pageBridge,
	previewLayout,
	projectionBridge,
} from "./bridge.js";

const api: ShellPageBridge = {
	...pageBridge(),
	...projectionBridge(),
	...appearanceBridge(),

	getWindowTitle: () =>
		ipcRenderer.invoke(CHANNELS.getWindowTitle) as Promise<string>,
	onWindowTitle: (listener) =>
		on<string>(CHANNELS.windowTitleChanged, listener),
	onWorkbenchArea: (listener) =>
		on<WorkbenchAreaWire>(CHANNELS.workbenchAreaChanged, listener),
	onEditorRestarting: (listener) =>
		on<EditorRestartingWire>(CHANNELS.editorRestarting, listener),

	openModal,
	closeWorkspace,
	chooseWorkspaceFolder: () =>
		ipcRenderer.invoke(CHANNELS.chooseWorkspaceFolder) as Promise<
			string | undefined
		>,
	previewLayout,
	openSettings,
};

contextBridge.exposeInMainWorld("devhub", api);

/**
 * The Sidebar's bridge — `sidebar.html`.
 *
 * Everything the leading column reads and asks for, and nothing else. See
 * `SidebarBridge`, and `shell/sidebar/SidebarApp.tsx` for the same contract
 * said in the page's own words.
 */

import { contextBridge, ipcRenderer } from "electron";
import {
	CHANNELS,
	type ContextMenuRequestWire,
	type MenuCommand,
	type SidebarBridge,
	type SidebarPointerWire,
} from "../ipc/contract.js";
import {
	agentProfilesBridge,
	appearanceBridge,
	closeWorkspace,
	continueAgent,
	focusSurface,
	on,
	openExternalUrl,
	openModal,
	pageBridge,
	reopenEditorInContainer,
	reopenEditorLocally,
	previewLayout,
	projectionBridge,
	repositoryStatusBridge,
	usageLimitsBridge,
} from "./bridge.js";

const api: SidebarBridge = {
	...pageBridge(),
	...projectionBridge(),
	...appearanceBridge(),
	...repositoryStatusBridge(),
	...usageLimitsBridge(),
	...agentProfilesBridge(),

	onMenuCommand: (listener) => on<MenuCommand>(CHANNELS.menuCommand, listener),
	openModal,
	closeWorkspace,
	reopenEditorLocally,
	reopenEditorInContainer,
	continueAgent,
	openExternalUrl,
	previewLayout,
	focusSurface,

	sidebarPointer: () =>
		ipcRenderer.invoke(CHANNELS.sidebarPointer) as Promise<SidebarPointerWire>,
	onChordArmed: (listener) => on<boolean>(CHANNELS.chordArmedChanged, listener),
	showContextMenu: (request: ContextMenuRequestWire) =>
		ipcRenderer.invoke(CHANNELS.showContextMenu, request) as Promise<
			string | undefined
		>,
};

contextBridge.exposeInMainWorld("devhub", api);

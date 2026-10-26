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
	type SidebarAreaWire,
	type SidebarBridge,
	type TooltipRequestWire,
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

	onSidebarArea: (listener) =>
		on<SidebarAreaWire>(CHANNELS.sidebarAreaChanged, listener),
	// One way, both of them: what is being sent is a fact about where the
	// pointer is resting, not a request waiting on an answer, and a tooltip
	// that had to await a round trip would arrive after the pointer moved on.
	onChordArmed: (listener) => on<boolean>(CHANNELS.chordArmedChanged, listener),
	showContextMenu: (request: ContextMenuRequestWire) =>
		ipcRenderer.invoke(CHANNELS.showContextMenu, request) as Promise<
			string | undefined
		>,
	showTooltip: (request: TooltipRequestWire) => {
		ipcRenderer.send(CHANNELS.showTooltip, request);
	},
	hideTooltip: () => {
		ipcRenderer.send(CHANNELS.hideTooltip);
	},
	releaseTooltip: () => {
		ipcRenderer.send(CHANNELS.releaseTooltip);
	},
};

contextBridge.exposeInMainWorld("devhub", api);

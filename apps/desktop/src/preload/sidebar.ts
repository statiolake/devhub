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
	type MenuCommand,
	type SidebarAreaWire,
	type SidebarBridge,
	type TooltipRequestWire,
} from "../ipc/contract.js";
import {
	agentProfilesBridge,
	appearanceBridge,
	closeWorkspace,
	focusSurface,
	on,
	openExternalUrl,
	openModal,
	pageBridge,
	previewLayout,
	projectionBridge,
	repositoryStatusBridge,
} from "./bridge.js";

const api: SidebarBridge = {
	...pageBridge(),
	...projectionBridge(),
	...appearanceBridge(),
	...repositoryStatusBridge(),
	...agentProfilesBridge(),

	onMenuCommand: (listener) => on<MenuCommand>(CHANNELS.menuCommand, listener),
	openModal,
	closeWorkspace,
	openExternalUrl,
	previewLayout,
	focusSurface,

	onSidebarArea: (listener) =>
		on<SidebarAreaWire>(CHANNELS.sidebarAreaChanged, listener),
	// One way, both of them: what is being sent is a fact about where the
	// pointer is resting, not a request waiting on an answer, and a tooltip
	// that had to await a round trip would arrive after the pointer moved on.
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

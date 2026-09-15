/**
 * The Sidebar's bridge — `sidebar.html`.
 *
 * Everything the leading column reads and asks for, and nothing else. See
 * `SidebarBridge`, and `shell/sidebar/SidebarApp.tsx` for the same contract
 * said in the page's own words.
 */

import { contextBridge } from "electron";
import {
	CHANNELS,
	type MenuCommand,
	type SidebarBridge,
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
};

contextBridge.exposeInMainWorld("devhub", api);

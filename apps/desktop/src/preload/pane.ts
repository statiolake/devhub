/**
 * One terminal pane's bridge — `pane.html`.
 *
 * A view per terminal opened beside a Workspace's panes, each a terminal
 * surface on that terminal's own tmux session. It reads the projection (its
 * name, its session) and the appearance (its font), and asks for two things
 * no other page may: to close this terminal, and to move it. See `PaneBridge`
 * in `ipc/contract.ts`, and `shell/pane/PaneApp.tsx`.
 */

import { contextBridge, ipcRenderer } from "electron";
import {
	CHANNELS,
	type PaneBridge,
	type PaneDropWire,
} from "../ipc/contract.js";
import {
	appearanceBridge,
	openExternalUrl,
	pageBridge,
	projectionBridge,
	writeClipboard,
} from "./bridge.js";
import { terminalApi } from "./terminal.js";

const api: PaneBridge = {
	...pageBridge(),
	...projectionBridge(),
	...appearanceBridge(),

	openExternalUrl,
	writeClipboard,
	terminal: terminalApi,
	closePaneTerminal: (terminalId: string) =>
		ipcRenderer.invoke(CHANNELS.closePaneTerminal, terminalId) as Promise<void>,
	dropPaneHeader: (drop: PaneDropWire) =>
		ipcRenderer.invoke(CHANNELS.dropPaneHeader, drop) as Promise<void>,
};

contextBridge.exposeInMainWorld("devhub", api);

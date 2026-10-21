/**
 * One Agent terminal pane's bridge — `pane.html`.
 *
 * A view per Agent terminal, each a terminal surface on that terminal's own
 * tmux session. It reads the projection (its Agent's name, its session) and
 * the appearance (its font), and asks for one thing no other page may: to
 * close this terminal. See `PaneBridge` in `ipc/contract.ts`, and
 * `shell/pane/PaneApp.tsx`.
 */

import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS, type PaneBridge } from "../ipc/contract.js";
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
};

contextBridge.exposeInMainWorld("devhub", api);

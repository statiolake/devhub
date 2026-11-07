/**
 * The Neovim editor's bridge — `neovim.html`.
 *
 * One view per Workspace whose editor area is its Neovim. See `NeovimBridge`
 * in `ipc/contract.ts`, and `shell/neovim/NeovimApp.tsx`.
 */

import { contextBridge, ipcRenderer } from "electron";
import type { NeovimBridge } from "../ipc/contract.js";
import {
	NEOVIM_CHANNELS,
	type DevhubNeovimApi,
	type NeovimAttachResult,
	type NeovimGuiEvent,
	type NeovimGuiMessage,
	type NeovimGuiWindowWire,
	type NeovimGuiWindowsWire,
	type NeovimRequestResult,
} from "../ipc/neovim.js";
import {
	appearanceBridge,
	openExternalUrl,
	pageBridge,
	projectionBridge,
	writeClipboard,
} from "./bridge.js";
import { terminalApi } from "./terminal.js";

function listen<A extends unknown[]>(
	channel: string,
	listener: (...args: A) => void,
): () => void {
	const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => {
		listener(...(args as A));
	};
	ipcRenderer.on(channel, handler);
	return () => {
		ipcRenderer.removeListener(channel, handler);
	};
}

const neovim: DevhubNeovimApi = {
	attach: (request) =>
		ipcRenderer.invoke(
			NEOVIM_CHANNELS.attach,
			request,
		) as Promise<NeovimAttachResult>,
	call: (call) => {
		ipcRenderer.send(NEOVIM_CHANNELS.call, call);
	},
	request: (call) =>
		ipcRenderer.invoke(
			NEOVIM_CHANNELS.request,
			call,
		) as Promise<NeovimRequestResult>,
	onRedraw: (listener) =>
		listen<[string, readonly unknown[]]>(NEOVIM_CHANNELS.redraw, listener),
	onEnded: (listener) =>
		listen<[string, string, boolean]>(NEOVIM_CHANNELS.ended, listener),
	onGuiWindow: (listener) =>
		listen<[string, NeovimGuiWindowWire]>(NEOVIM_CHANNELS.guiWindow, listener),
	onGuiWindows: (listener) =>
		listen<[string, NeovimGuiWindowsWire]>(
			NEOVIM_CHANNELS.guiWindows,
			listener,
		),
	onGuiSend: (listener) =>
		listen<[NeovimGuiMessage]>(NEOVIM_CHANNELS.guiSend, listener),
	onGuiEvent: (listener) =>
		listen<[NeovimGuiEvent]>(NEOVIM_CHANNELS.guiEvent, listener),
	guiMessage: (message) => {
		ipcRenderer.send(NEOVIM_CHANNELS.guiMessage, message);
	},
};

const api: NeovimBridge = {
	...pageBridge(),
	...projectionBridge(),
	...appearanceBridge(),

	openExternalUrl,
	writeClipboard,
	terminal: terminalApi,
	neovim,
};

contextBridge.exposeInMainWorld("devhub", api);

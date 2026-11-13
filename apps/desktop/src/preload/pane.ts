/**
 * One terminal pane's bridge — `pane.html`.
 *
 * A view per Agent terminal (and per Workspace's editor area), each a
 * terminal surface on that terminal's own tmux session, with no chrome of
 * its own, and every Neovim DevHub draws over one of its panes drawn in it
 * (`neovim`, `preload/neovimApi.ts`). It reads the projection (its Agent's
 * name) and the appearance (its font). See `PaneBridge` in
 * `ipc/contract.ts`, and `shell/pane/PaneApp.tsx`.
 */

import { contextBridge, ipcRenderer } from "electron";
import {
	CHANNELS,
	type ContextMenuRequestWire,
	type PaneBridge,
	type TerminalNeovimKeyWire,
	type TerminalNeovimsWire,
} from "../ipc/contract.js";
import {
	appearanceBridge,
	on,
	openExternalUrl,
	pageBridge,
	projectionBridge,
	writeClipboard,
} from "./bridge.js";
import { neovimApi } from "./neovimApi.js";
import { terminalApi } from "./terminal.js";

const api: PaneBridge = {
	...pageBridge(),
	...projectionBridge(),
	...appearanceBridge(),

	openExternalUrl,
	writeClipboard,
	terminal: terminalApi,
	neovim: neovimApi,
	reportTerminalPanes(terminalId, panes) {
		ipcRenderer.send(CHANNELS.reportTerminalPanes, terminalId, panes);
	},
	onTerminalNeovims(terminalId, listener) {
		// The value as it stands, asked, then each push: main answers the ask
		// in order with what it pushes.
		let listening = true;
		const stop = on<TerminalNeovimsWire>(CHANNELS.terminalNeovims, listener);
		void (
			ipcRenderer.invoke(
				CHANNELS.askTerminalNeovims,
				terminalId,
			) as Promise<TerminalNeovimsWire>
		).then((value) => {
			if (listening) listener(value);
		});
		return () => {
			listening = false;
			stop();
		};
	},
	onTerminalNeovimKey(listener) {
		return on<TerminalNeovimKeyWire>(CHANNELS.terminalNeovimKey, listener);
	},
	reportUntypedTerminalKeys(terminalId, keys) {
		ipcRenderer.send(CHANNELS.reportUntypedTerminalKeys, terminalId, keys);
	},
	showContextMenu: (request: ContextMenuRequestWire) =>
		ipcRenderer.invoke(CHANNELS.showContextMenu, request) as Promise<
			string | undefined
		>,
	copyText: (text: string) =>
		ipcRenderer.invoke(CHANNELS.copyText, text) as Promise<void>,
	reportNeovimPointer(terminalId, key) {
		ipcRenderer.send(CHANNELS.reportNeovimPointer, terminalId, key);
	},
};

contextBridge.exposeInMainWorld("devhub", api);

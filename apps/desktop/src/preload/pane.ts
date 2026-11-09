/**
 * One Agent terminal pane's bridge — `pane.html`.
 *
 * A view per Agent terminal, each a terminal surface on that terminal's own
 * tmux session, with no chrome of its own. It reads the projection (its
 * Agent's name) and the appearance (its font) and asks for nothing else. See `PaneBridge` in `ipc/contract.ts`, and
 * `shell/pane/PaneApp.tsx`.
 */

import { contextBridge, ipcRenderer } from "electron";
import {
	CHANNELS,
	type PaneBridge,
	type TerminalOverlaidWire,
} from "../ipc/contract.js";
import {
	appearanceBridge,
	on,
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
	reportTerminalScreen(terminalId, screen) {
		ipcRenderer.send(CHANNELS.reportTerminalScreen, terminalId, screen);
	},
	reportTerminalPanes(terminalId, panes) {
		ipcRenderer.send(CHANNELS.reportTerminalPanes, terminalId, panes);
	},
	onTerminalOverlaid(terminalId, listener) {
		// The value as it stands, asked, then each push: main answers the ask
		// in order with what it pushes.
		let listening = true;
		const stop = on<TerminalOverlaidWire>(CHANNELS.terminalOverlaid, listener);
		void (
			ipcRenderer.invoke(
				CHANNELS.askTerminalOverlaid,
				terminalId,
			) as Promise<TerminalOverlaidWire>
		).then((value) => {
			if (listening) listener(value);
		});
		return () => {
			listening = false;
			stop();
		};
	},
};

contextBridge.exposeInMainWorld("devhub", api);

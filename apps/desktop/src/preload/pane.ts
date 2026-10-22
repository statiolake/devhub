/**
 * One Agent terminal pane's bridge — `pane.html`.
 *
 * A view per Agent terminal, each a terminal surface on that terminal's own
 * tmux session, with no chrome of its own. It reads the projection (its
 * Agent's name) and the appearance (its font) and asks for nothing else. See `PaneBridge` in `ipc/contract.ts`, and
 * `shell/pane/PaneApp.tsx`.
 */

import { contextBridge } from "electron";
import type { PaneBridge } from "../ipc/contract.js";
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
};

contextBridge.exposeInMainWorld("devhub", api);

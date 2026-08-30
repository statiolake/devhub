/**
 * The Agent Surface half of `window.devhub`.
 *
 * `preload.ts` imports this module and puts `agentApi` on the object it
 * exposes, as `window.devhub.agent`. Nothing here decides anything: each
 * member forwards one request and lets the rejection through so it reaches the
 * page's one error area.
 *
 * The frame listener is deliberately un-filtered: main sends every attachment's
 * frames on one channel and the client routes them by attachment id, the same
 * way the Tauri build's per-attach Channel carried the id in each frame.
 */

import { ipcRenderer } from "electron";
import {
	AGENT_CHANNELS,
	type AckRequest,
	type AgentApi,
	type AttachReceipt,
	type AttachRequest,
	type DetachRequest,
	type InputRequest,
	type ResizeRequest,
} from "../ipc/agent.js";

export const agentApi: AgentApi = {
	attach: (request: AttachRequest) =>
		ipcRenderer.invoke(
			AGENT_CHANNELS.attach,
			request,
		) as Promise<AttachReceipt>,

	input: (request: InputRequest) =>
		ipcRenderer.invoke(AGENT_CHANNELS.input, request) as Promise<void>,

	resize: (request: ResizeRequest) =>
		ipcRenderer.invoke(AGENT_CHANNELS.resize, request) as Promise<void>,

	acknowledge: (request: AckRequest) =>
		ipcRenderer.invoke(AGENT_CHANNELS.acknowledge, request) as Promise<void>,

	detach: (request: DetachRequest) =>
		ipcRenderer.invoke(AGENT_CHANNELS.detach, request) as Promise<void>,

	onFrame: (listener) => {
		const handler = (_event: Electron.IpcRendererEvent, raw: Uint8Array) =>
			listener(raw);
		ipcRenderer.on(AGENT_CHANNELS.frame, handler);
		return () => ipcRenderer.removeListener(AGENT_CHANNELS.frame, handler);
	},
};

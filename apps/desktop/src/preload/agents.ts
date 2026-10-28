/**
 * The Agents' bridge — `agents.html`.
 *
 * Every running Agent is mounted on one page, and the frames already arrive
 * per surface: `channelId` is the routing key, and the demux is per page. See
 * `AgentsBridge`, and `shell/agents/AgentsApp.tsx`.
 */

import { contextBridge, ipcRenderer } from "electron";
import {
	CHANNELS,
	type AgentsBridge,
	type ContextMenuRequestWire,
} from "../ipc/contract.js";
import {
	agentActionsBridge,
	appearanceBridge,
	openExternalUrl,
	openModal,
	pageBridge,
	projectionBridge,
	repositoryStatusBridge,
	writeClipboard,
	writeClipboardImage,
} from "./bridge.js";
import { conversationApi } from "./conversation.js";
import { terminalApi } from "./terminal.js";
import { voiceApi } from "./voice.js";

const api: AgentsBridge = {
	...pageBridge(),
	...projectionBridge(),
	...appearanceBridge(),
	...repositoryStatusBridge(),
	...agentActionsBridge(),

	openModal,
	openExternalUrl,
	writeClipboard,
	writeClipboardImage,
	showContextMenu: (request: ContextMenuRequestWire) =>
		ipcRenderer.invoke(CHANNELS.showContextMenu, request) as Promise<
			string | undefined
		>,
	terminal: terminalApi,
	conversation: conversationApi,
	voice: voiceApi,
};

contextBridge.exposeInMainWorld("devhub", api);

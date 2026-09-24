/**
 * The Agents' bridge — `agents.html`.
 *
 * Every running Agent is mounted on one page, and the frames already arrive
 * per surface: `channelId` is the routing key, and the demux is per page. See
 * `AgentsBridge`, and `shell/agents/AgentsApp.tsx`.
 */

import { contextBridge } from "electron";
import type { AgentsBridge } from "../ipc/contract.js";
import {
	agentActionsBridge,
	appearanceBridge,
	openExternalUrl,
	openModal,
	pageBridge,
	projectionBridge,
	repositoryStatusBridge,
	writeClipboard,
} from "./bridge.js";
import { conversationApi } from "./conversation.js";
import { terminalApi } from "./terminal.js";

const api: AgentsBridge = {
	...pageBridge(),
	...projectionBridge(),
	...appearanceBridge(),
	...repositoryStatusBridge(),
	...agentActionsBridge(),

	openModal,
	openExternalUrl,
	writeClipboard,
	terminal: terminalApi,
	conversation: conversationApi,
};

contextBridge.exposeInMainWorld("devhub", api);

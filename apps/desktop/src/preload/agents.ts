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
	type OrchestratorFileWire,
	type OrchestratorFolderWire,
	type OrchestratorViewWire,
	type RichClipboardWire,
	type SlideImagesRequestWire,
	type SlidesPdfRequestWire,
} from "../ipc/contract.js";
import {
	agentActionsBridge,
	appearanceBridge,
	on,
	openExternalUrl,
	openModal,
	orchestratorBoardBridge,
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
	...orchestratorBoardBridge(),
	answerEscalation: (id: number, markdown: string) =>
		ipcRenderer.invoke(
			CHANNELS.answerEscalation,
			id,
			markdown,
		) as Promise<void>,
	startOrchestrator: () =>
		ipcRenderer.invoke(CHANNELS.startOrchestrator) as Promise<void>,
	setOrchestratorPaused: (paused: boolean) =>
		ipcRenderer.invoke(CHANNELS.setOrchestratorPaused, paused) as Promise<void>,
	reportOrchestratorView: (view: OrchestratorViewWire) => {
		ipcRenderer.send(CHANNELS.reportOrchestratorView, view);
	},
	listOrchestratorFolder: (path: string) =>
		ipcRenderer.invoke(
			CHANNELS.listOrchestratorFolder,
			path,
		) as Promise<OrchestratorFolderWire>,
	readOrchestratorFile: (path: string) =>
		ipcRenderer.invoke(
			CHANNELS.readOrchestratorFile,
			path,
		) as Promise<OrchestratorFileWire>,
	openOrchestratorFile: (path: string) =>
		ipcRenderer.invoke(CHANNELS.openOrchestratorFile, path) as Promise<void>,
	openLinkedFile: (workspaceId, path, range) =>
		ipcRenderer.invoke(
			CHANNELS.openLinkedFile,
			workspaceId,
			path,
			range,
		) as Promise<void>,
	devhubSessionAgent: (session) =>
		ipcRenderer.invoke(CHANNELS.devhubSessionAgent, session) as Promise<
			string | null
		>,
	resolveEscalationPaths: (cwd, paths) =>
		ipcRenderer.invoke(CHANNELS.resolveEscalationPaths, cwd, paths) as Promise<
			readonly (string | null)[]
		>,
	readEscalationEmbed: (path) =>
		ipcRenderer.invoke(CHANNELS.readEscalationEmbed, path) as ReturnType<
			AgentsBridge["readEscalationEmbed"]
		>,
	escalationEmbedSignature: (path) =>
		ipcRenderer.invoke(CHANNELS.escalationEmbedSignature, path) as Promise<
			string | null
		>,
	onOrchestratorFilesChanged: (listener) =>
		on<readonly string[]>(CHANNELS.orchestratorFilesChanged, listener),

	openModal,
	openExternalUrl,
	writeClipboard,
	writeClipboardImage,
	writeClipboardRich: (content: RichClipboardWire) =>
		ipcRenderer.invoke(CHANNELS.writeClipboardRich, content) as Promise<void>,
	saveSlidesPdf: (request: SlidesPdfRequestWire) =>
		ipcRenderer.invoke(CHANNELS.saveSlidesPdf, request) as Promise<
			string | undefined
		>,
	saveSlideImages: (request: SlideImagesRequestWire) =>
		ipcRenderer.invoke(CHANNELS.saveSlideImages, request) as Promise<
			readonly string[]
		>,
	showContextMenu: (request: ContextMenuRequestWire) =>
		ipcRenderer.invoke(CHANNELS.showContextMenu, request) as Promise<
			string | undefined
		>,
	terminal: terminalApi,
	conversation: conversationApi,
	voice: voiceApi,
};

contextBridge.exposeInMainWorld("devhub", api);

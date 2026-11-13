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
	type OrchestratorModeWire,
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
	previewLayout,
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
	previewLayout,
	answerEscalation: (id: number, markdown: string) =>
		ipcRenderer.invoke(
			CHANNELS.answerEscalation,
			id,
			markdown,
		) as Promise<void>,
	startOrchestrator: () =>
		ipcRenderer.invoke(CHANNELS.startOrchestrator) as Promise<void>,
	setOrchestratorMode: (mode: OrchestratorModeWire) =>
		ipcRenderer.invoke(CHANNELS.setOrchestratorMode, mode) as Promise<void>,
	sendOrchestratorRequest: (text: string) =>
		ipcRenderer.invoke(CHANNELS.sendOrchestratorRequest, text) as Promise<void>,
	onOpenOrchestratorRequest: (listener) =>
		on<void>(CHANNELS.openOrchestratorRequest, () => {
			listener();
		}),
	reportOrchestratorView: (view: OrchestratorViewWire) => {
		ipcRenderer.send(CHANNELS.reportOrchestratorView, view);
	},
	openOrchestratorFile: (path, range) =>
		ipcRenderer.invoke(
			CHANNELS.openOrchestratorFile,
			path,
			range,
		) as Promise<void>,
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
	copyDevhubLink: (link, markdown) =>
		ipcRenderer.invoke(
			CHANNELS.copyDevhubLink,
			link,
			markdown,
		) as Promise<void>,
	copyText: (text) =>
		ipcRenderer.invoke(CHANNELS.copyText, text) as Promise<void>,
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

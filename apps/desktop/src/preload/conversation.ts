/**
 * `window.devhub.conversation`: the Agents page's way to a GUI Agent's
 * conversation. See `ipc/conversation.ts`.
 *
 * Events arrive on one channel for the whole page and are handed to the
 * attachment of the Agent they name. An event for an Agent this page has not
 * attached is dropped here, which is the only place that can know it.
 */

import { ipcRenderer } from "electron";
import {
	CONVERSATION_CHANNELS,
	type ConversationApi,
	type ConversationAttachment,
	type ConversationCommandWire,
	type ConversationEventListener,
} from "../ipc/conversation.js";
import type {
	ConversationEvent,
	RewindOutcome,
} from "../model/conversation.js";

const listeners = new Map<string, ConversationEventListener>();

ipcRenderer.on(
	CONVERSATION_CHANNELS.event,
	(_event, agentId: string, revision: number, event: ConversationEvent) => {
		listeners.get(agentId)?.(revision, event);
	},
);

function command(
	agentId: string,
	wire: ConversationCommandWire,
): Promise<void> {
	return ipcRenderer.invoke(
		CONVERSATION_CHANNELS.command,
		agentId,
		wire,
	) as Promise<void>;
}

export const conversationApi: ConversationApi = {
	attach: async (agentId, onEvent) => {
		// Listening before asking: an event main sends between reading the
		// snapshot and answering arrives before the answer, and the page drops
		// it by its revision rather than never seeing it.
		listeners.set(agentId, onEvent);
		try {
			return (await ipcRenderer.invoke(
				CONVERSATION_CHANNELS.attach,
				agentId,
			)) as ConversationAttachment;
		} catch (failure: unknown) {
			listeners.delete(agentId);
			throw failure;
		}
	},
	detach: async (agentId) => {
		listeners.delete(agentId);
		await ipcRenderer.invoke(CONVERSATION_CHANNELS.detach, agentId);
	},
	send: (agentId, text, images) =>
		command(agentId, { kind: "send", text, images }),
	startEditingPending: (agentId, pending) =>
		command(agentId, { kind: "start-editing-pending", pending }),
	stopEditingPending: (agentId, pending) =>
		command(agentId, { kind: "stop-editing-pending", pending }),
	editPending: (agentId, pending, text) =>
		command(agentId, { kind: "edit-pending", pending, text }),
	removePending: (agentId, pending) =>
		command(agentId, { kind: "remove-pending", pending }),
	sendPendingNow: (agentId, pending) =>
		command(agentId, { kind: "send-pending-now", pending }),
	instruct: (agentId, subagent, text) =>
		command(agentId, { kind: "instruct", subagent, text }),
	rewind: (agentId, message) =>
		ipcRenderer.invoke(
			CONVERSATION_CHANNELS.rewind,
			agentId,
			message,
		) as Promise<RewindOutcome>,
	continueInTerminal: (agentId) =>
		ipcRenderer.invoke(
			CONVERSATION_CHANNELS.continueInTerminal,
			agentId,
		) as Promise<void>,
	continueInGui: (agentId) =>
		ipcRenderer.invoke(
			CONVERSATION_CHANNELS.continueInGui,
			agentId,
		) as Promise<void>,
	listSessions: (agentId, scope) =>
		ipcRenderer.invoke(
			CONVERSATION_CHANNELS.listSessions,
			agentId,
			scope,
		) as ReturnType<ConversationApi["listSessions"]>,
	previewSession: (agentId, session, cwd) =>
		ipcRenderer.invoke(
			CONVERSATION_CHANNELS.previewSession,
			agentId,
			session,
			cwd,
		) as ReturnType<ConversationApi["previewSession"]>,
	resumeSession: (agentId, session) =>
		ipcRenderer.invoke(
			CONVERSATION_CHANNELS.resumeSession,
			agentId,
			session,
		) as Promise<void>,
	interrupt: (agentId) => command(agentId, { kind: "interrupt" }),
	answer: (agentId, request, answer) =>
		command(agentId, { kind: "answer", request, answer }),
	setSetting: (agentId, which, id) =>
		command(agentId, { kind: "set-setting", which, id }),
};

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
import type { ConversationEvent } from "../model/conversation.js";

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
	send: (agentId, text) => command(agentId, { kind: "send", text }),
	interrupt: (agentId) => command(agentId, { kind: "interrupt" }),
	answer: (agentId, request, answer) =>
		command(agentId, { kind: "answer", request, answer }),
	setSetting: (agentId, which, id) =>
		command(agentId, { kind: "set-setting", which, id }),
};

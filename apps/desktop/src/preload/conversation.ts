/**
 * `window.devhub.conversation`: the Agents page's way to a GUI Agent's
 * conversation. See `ipc/conversation.ts`.
 *
 * Events arrive for the whole page and are handed to the attachment of the
 * Agent they name. An event for an Agent this page has not attached is
 * dropped here, which is the only place that can know it.
 *
 * A conversation the conversation engine runs is attached over the page's
 * port to the engine (`CONVERSATION_CHANNELS.port`): its snapshot and its
 * events come from there, never through main. One run in main sends both
 * through main (`events`).
 */

import { ipcRenderer } from "electron";
import {
	CONVERSATION_CHANNELS,
	type ConversationApi,
	type ConversationAttachReply,
	type ConversationAttachment,
	type ConversationCommandWire,
	type ConversationEventBatch,
	type ConversationEventListener,
} from "../ipc/conversation.js";
import type { RewindOutcome, Transcript } from "../model/conversation.js";
import type {
	EngineToPage,
	PageToEngine,
} from "../main/agentEngine/protocol.js";

const listeners = new Map<string, ConversationEventListener>();
const restarts = new Map<string, () => void>();

const deliver = (batch: ConversationEventBatch) => {
	for (const [agentId, revision, event] of batch) {
		listeners.get(agentId)?.(revision, event);
	}
};

ipcRenderer.on(
	CONVERSATION_CHANNELS.events,
	(_event, batch: ConversationEventBatch) => deliver(batch),
);

/** The page's port to the engine of `generation`, once main has handed one out. */
let engine: { port: MessagePort; generation: number } | undefined;
const portWaiters: (() => void)[] = [];
const attaching = new Map<
	number,
	{
		resolve: (snapshot: { transcript: Transcript; revision: number }) => void;
		reject: (error: Error) => void;
	}
>();
let nextAttach = 1;

ipcRenderer.on(
	CONVERSATION_CHANNELS.port,
	(event, { generation }: { generation: number }) => {
		const port = event.ports[0];
		if (port === undefined) return;
		engine?.port.close();
		engine = { port, generation };
		port.onmessage = ({ data }: MessageEvent<EngineToPage>) => {
			switch (data.type) {
				case "events":
					deliver(data.batch);
					return;
				case "attached":
					attaching.get(data.rid)?.resolve(data);
					attaching.delete(data.rid);
					return;
				case "attach-failed":
					attaching.get(data.rid)?.reject(new Error(data.message));
					attaching.delete(data.rid);
					return;
			}
		};
		port.start();
		for (const waiter of portWaiters.splice(0)) waiter();
	},
);

ipcRenderer.on(CONVERSATION_CHANNELS.restarted, () => {
	engine?.port.close();
	engine = undefined;
	// An attach the old engine had not answered is let go of, not failed:
	// its pane attaches again with the rest.
	attaching.clear();
	for (const restarted of [...restarts.values()]) restarted();
});

/** The port to the engine of `generation` or a later one, waited for if main's message is still on its way. */
async function portOf(generation: number): Promise<MessagePort> {
	while (engine === undefined || engine.generation < generation) {
		await new Promise<void>((resolve) => portWaiters.push(resolve));
	}
	return engine.port;
}

function toEngine(port: MessagePort, message: PageToEngine): void {
	port.postMessage(message);
}

/** The snapshot of a conversation the engine runs, asked of the engine. */
async function engineSnapshot(
	agentId: string,
	generation: number,
): Promise<{ transcript: Transcript; revision: number }> {
	const port = await portOf(generation);
	const rid = nextAttach++;
	return new Promise((resolve, reject) => {
		attaching.set(rid, { resolve, reject });
		toEngine(port, { type: "attach", agentId, rid });
	});
}

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
	attach: async (agentId, onEvent, onRestarted) => {
		// Listening before asking: an event sent between reading the snapshot
		// and answering arrives before the answer, and the page drops it by
		// its revision rather than never seeing it.
		listeners.set(agentId, onEvent);
		if (onRestarted !== undefined) restarts.set(agentId, onRestarted);
		try {
			const reply = (await ipcRenderer.invoke(
				CONVERSATION_CHANNELS.attach,
				agentId,
			)) as ConversationAttachReply;
			if (!("port" in reply)) return reply;
			const { port, ...rest } = reply;
			const snapshot = await engineSnapshot(agentId, port);
			return { ...snapshot, ...rest } satisfies ConversationAttachment;
		} catch (failure: unknown) {
			listeners.delete(agentId);
			restarts.delete(agentId);
			throw failure;
		}
	},
	detach: async (agentId) => {
		listeners.delete(agentId);
		restarts.delete(agentId);
		if (engine !== undefined)
			toEngine(engine.port, { type: "detach", agentId });
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
	cancelLimitResume: (agentId) =>
		command(agentId, { kind: "cancel-limit-resume" }),
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
	restartSession: (agentId) =>
		ipcRenderer.invoke(
			CONVERSATION_CHANNELS.restartSession,
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
	resumeSessionElsewhere: (agentId, session) =>
		ipcRenderer.invoke(
			CONVERSATION_CHANNELS.resumeSessionElsewhere,
			agentId,
			session,
		) as Promise<void>,
	interrupt: (agentId) => command(agentId, { kind: "interrupt" }),
	stopTask: (agentId, task) => command(agentId, { kind: "stop-task", task }),
	answer: (agentId, request, answer) =>
		command(agentId, { kind: "answer", request, answer }),
	setSetting: (agentId, which, id) =>
		command(agentId, { kind: "set-setting", which, id }),
	mcp: (agentId, request) => command(agentId, { kind: "mcp", request }),
	signIn: (agentId, server) =>
		ipcRenderer.invoke(
			CONVERSATION_CHANNELS.mcpSignIn,
			agentId,
			server,
		) as Promise<void>,
	signInInput: (agentId, text) =>
		ipcRenderer.invoke(
			CONVERSATION_CHANNELS.mcpSignInInput,
			agentId,
			text,
		) as Promise<void>,
	cancelSignIn: (agentId) =>
		ipcRenderer.invoke(
			CONVERSATION_CHANNELS.mcpSignInCancel,
			agentId,
		) as Promise<void>,
	dismissSignIn: (agentId) =>
		ipcRenderer.invoke(
			CONVERSATION_CHANNELS.mcpSignInDismiss,
			agentId,
		) as Promise<void>,
	saveDraft: (agentId, text) =>
		ipcRenderer.invoke(
			CONVERSATION_CHANNELS.saveDraft,
			agentId,
			text,
		) as Promise<void>,
	resolvePaths: (agentId, cwd, paths) =>
		ipcRenderer.invoke(
			CONVERSATION_CHANNELS.resolvePaths,
			agentId,
			cwd,
			paths,
		) as ReturnType<ConversationApi["resolvePaths"]>,
	readEmbedFile: (agentId, path) =>
		ipcRenderer.invoke(
			CONVERSATION_CHANNELS.readEmbedFile,
			agentId,
			path,
		) as ReturnType<ConversationApi["readEmbedFile"]>,
	embedSignature: (agentId, path) =>
		ipcRenderer.invoke(
			CONVERSATION_CHANNELS.embedSignature,
			agentId,
			path,
		) as ReturnType<ConversationApi["embedSignature"]>,
	openFile: (agentId, path, range) =>
		ipcRenderer.invoke(
			CONVERSATION_CHANNELS.openFile,
			agentId,
			path,
			range,
		) as Promise<void>,
	cliDefaults: (agentId, model) =>
		ipcRenderer.invoke(
			CONVERSATION_CHANNELS.cliDefaults,
			agentId,
			model,
		) as ReturnType<ConversationApi["cliDefaults"]>,
	setCliDefault: (agentId, which, value, model) =>
		ipcRenderer.invoke(
			CONVERSATION_CHANNELS.setCliDefault,
			agentId,
			which,
			value,
			model,
		) as Promise<void>,
};

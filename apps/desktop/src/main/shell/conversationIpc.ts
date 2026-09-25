/**
 * The Agents page's side of the GUI Agents' conversations, in main.
 *
 * Only that page may attach, and it is sent the events of exactly the
 * conversations it attached. A person's words arrive here as the person's:
 * the page cannot claim to be an injection, which is the queue's alone.
 */

import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import {
	CONVERSATION_CHANNELS,
	type ConversationAttachment,
	type ConversationCommandWire,
} from "../../ipc/conversation.js";
import { entryId, type EditOutcome } from "../../model/conversation.js";
import type { AgentId, AgentPresentation } from "../../model/domain.js";
import { sessionScope } from "../agent/conversation/resume.js";
import type {
	ConversationCommand,
	SettingName,
} from "../agent/conversation/protocolAdapter.js";
import type { GuiConversations } from "./agentWiring.js";

export interface ConversationIpcOptions {
	readonly ipcMain: IpcMain;
	readonly conversations: GuiConversations;
	/** The Agents page, the one page that draws conversations, once it exists. */
	readonly agentsPage: () => WebContents | undefined;
	/** Ask the model to carry an Agent on in the other presentation, resuming this session. */
	readonly continueIn: (
		agentId: AgentId,
		presentation: AgentPresentation,
		session: string,
	) => Promise<unknown>;
	/** The session a terminal Agent's CLI is in (`AgentWiring.terminalSession`). */
	readonly terminalSession: (agentId: AgentId) => Promise<string>;
	/** The app's one conversion of a failure into what crosses IPC. */
	readonly fail: (error: unknown) => Error;
}

export function registerConversationIpc(options: ConversationIpcOptions): void {
	const attached = new Set<AgentId>();

	options.conversations.registry.onEvent((agentId, revision, event) => {
		if (!attached.has(agentId)) return;
		const page = options.agentsPage();
		// A page that went away took its attachments with it; the one that
		// replaces it attaches afresh.
		if (page === undefined || page.isDestroyed()) {
			attached.clear();
			return;
		}
		page.send(CONVERSATION_CHANNELS.event, agentId, revision, event);
	});

	/** Every request: from the Agents page, about an Agent, or refused in the app's own shape. */
	const handle = <T>(
		channel: string,
		work: (agentId: AgentId, ...rest: unknown[]) => Promise<T> | T,
	) =>
		options.ipcMain.handle(
			channel,
			async (
				event: IpcMainInvokeEvent,
				agentId: unknown,
				...rest: unknown[]
			) => {
				try {
					if (
						options.agentsPage() === undefined ||
						event.sender !== options.agentsPage()
					) {
						throw new Error(
							"only the Agents page reaches the GUI Agents' conversations",
						);
					}
					if (typeof agentId !== "string")
						throw new Error("a conversation request names no Agent");
					return await work(agentId as AgentId, ...rest);
				} catch (error: unknown) {
					throw options.fail(error);
				}
			},
		);

	handle(
		CONVERSATION_CHANNELS.attach,
		async (agentId): Promise<ConversationAttachment> => {
			const conversation = await options.conversations.of(agentId);
			// Subscribed before the snapshot is taken, so no event can fall between
			// them; the page drops what the snapshot already holds by its revision.
			attached.add(agentId);
			return conversation.snapshot();
		},
	);

	handle(CONVERSATION_CHANNELS.detach, (agentId) => {
		attached.delete(agentId);
	});

	handle(CONVERSATION_CHANNELS.continueInTerminal, async (agentId) => {
		const session = await options.conversations.session(agentId);
		await options.continueIn(agentId, "tui", session);
	});

	handle(CONVERSATION_CHANNELS.continueInGui, async (agentId) => {
		const session = await options.terminalSession(agentId);
		await options.continueIn(agentId, "gui", session);
	});

	handle(CONVERSATION_CHANNELS.listSessions, (agentId, scope) =>
		options.conversations.pastSessions(agentId, sessionScope(scope)),
	);

	handle(CONVERSATION_CHANNELS.previewSession, (agentId, session, cwd) => {
		if (typeof session !== "string" || typeof cwd !== "string")
			throw new Error("a preview names no session and directory");
		return options.conversations.previewSession(agentId, session, cwd);
	});

	handle(CONVERSATION_CHANNELS.resumeSession, (agentId, session) => {
		if (typeof session !== "string")
			throw new Error(`${JSON.stringify(session)} is not a session to resume`);
		return options.conversations.resume(agentId, session);
	});

	handle(
		CONVERSATION_CHANNELS.editLastMessage,
		async (agentId, message, text): Promise<EditOutcome> => {
			if (typeof message !== "string" || typeof text !== "string") {
				throw new Error(
					`${JSON.stringify([message, text])} is not an edit of a message`,
				);
			}
			const conversation = await options.conversations.of(agentId);
			return conversation.editLastMessage(entryId(message), text);
		},
	);

	handle(CONVERSATION_CHANNELS.command, async (agentId, wire) => {
		const request = requestFrom(wire);
		const conversation = await options.conversations.of(agentId);
		await (request.kind === "set-setting"
			? conversation.configure(request.which, request.id)
			: conversation.command(request));
	});
}

/** What the page asked for, checked; a person's words are the person's. */
function requestFrom(wire: unknown):
	| ConversationCommand
	| {
			readonly kind: "set-setting";
			readonly which: SettingName;
			readonly id: string;
	  } {
	const command = wire as ConversationCommandWire;
	switch (command?.kind) {
		case "send":
			if (typeof command.text !== "string") break;
			return { kind: "send", text: command.text, origin: "person" };
		case "interrupt":
			return { kind: "interrupt" };
		case "answer":
			if (
				typeof command.request !== "string" ||
				typeof command.answer !== "object"
			)
				break;
			return {
				kind: "answer",
				request: command.request,
				answer: command.answer,
			};
		case "set-setting":
			if (
				!["model", "effort", "mode"].includes(command.which) ||
				typeof command.id !== "string"
			) {
				break;
			}
			return { kind: "set-setting", which: command.which, id: command.id };
	}
	throw new Error(`${JSON.stringify(wire)} is not a conversation command`);
}

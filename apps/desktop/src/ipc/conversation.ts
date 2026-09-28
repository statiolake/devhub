/**
 * The GUI Agents' conversations, as the Agents page reaches them.
 *
 * main holds each conversation's true `Transcript`; the page asks for it once
 * (`attach`) and is then sent every event after it, numbered, to fold into its
 * copy with the same `applyEvent` main used. Nothing else crosses: the page
 * never learns a protocol, and main never learns what the page drew.
 *
 * Every request resolves when it has been done and rejects when it has not,
 * with the failure in the app's own error shape (`shell/failure.ts` reads it
 * back), so the page hands a rejection to its root and has nothing to decide.
 */

import type {
	ConversationEvent,
	EntryId,
	ImageRef,
	PendingId,
	RequestAnswer,
	RequestId,
	RewindOutcome,
	Transcript,
} from "../model/conversation.js";
import type {
	PastSessionWire,
	SessionPreviewLineWire,
	SessionScopeWire,
} from "./contract.js";

export const CONVERSATION_CHANNELS = {
	attach: "devhub:conversation:attach",
	detach: "devhub:conversation:detach",
	command: "devhub:conversation:command",
	continueInTerminal: "devhub:conversation:continue-in-terminal",
	continueInGui: "devhub:conversation:continue-in-gui",
	listSessions: "devhub:conversation:list-sessions",
	previewSession: "devhub:conversation:preview-session",
	resumeSession: "devhub:conversation:resume-session",
	restartSession: "devhub:conversation:restart-session",
	rewind: "devhub:conversation:rewind",
	saveDraft: "devhub:conversation:save-draft",
	mcpSignIn: "devhub:conversation:mcp-sign-in",
	mcpSignInInput: "devhub:conversation:mcp-sign-in-input",
	mcpSignInCancel: "devhub:conversation:mcp-sign-in-cancel",
	mcpSignInDismiss: "devhub:conversation:mcp-sign-in-dismiss",
	/** main → page: `(agentId, revision, event)`. */
	event: "devhub:conversation:event",
} as const;

/** What the page may ask of a conversation. A person's words are always the person's. */
export type ConversationCommandWire =
	/** The person's words: written at once when the Agent is idle, else held (`Transcript.pending`). */
	| {
			readonly kind: "send";
			readonly text: string;
			/** Attached images, each its own bytes (`source.kind` "data"). */
			readonly images: readonly ImageRef[];
	  }
	/** The person opened a held message to change it: it is not written until they save or cancel. */
	| { readonly kind: "start-editing-pending"; readonly pending: PendingId }
	/** Save the change: new words, and the message is written again in its turn. */
	| {
			readonly kind: "edit-pending";
			readonly pending: PendingId;
			readonly text: string;
	  }
	/** The person gave the change up: the message is written as it was. */
	| { readonly kind: "stop-editing-pending"; readonly pending: PendingId }
	| { readonly kind: "remove-pending"; readonly pending: PendingId }
	/** Write a held message now: a running turn takes it in as it goes. */
	| { readonly kind: "send-pending-now"; readonly pending: PendingId }
	/** The person's words to a subagent whose `spawns.takesMessages` is true. */
	| {
			readonly kind: "instruct";
			readonly subagent: EntryId;
			readonly text: string;
	  }
	| { readonly kind: "interrupt" }
	/** Stop one of the background tasks, by its `RunningTask.id`, whose `stoppable` is true. */
	| { readonly kind: "stop-task"; readonly task: string }
	| {
			readonly kind: "answer";
			readonly request: RequestId;
			readonly answer: RequestAnswer;
	  }
	| {
			readonly kind: "set-setting";
			readonly which: "model" | "effort" | "mode";
			readonly id: string;
	  }
	/** Ask about the MCP servers, or do one of a server's `McpServer.actions` but `sign-in`. */
	| { readonly kind: "mcp"; readonly request: McpRequestWire };

export type McpRequestWire =
	| { readonly action: "refresh" }
	| {
			readonly action: "reconnect" | "enable" | "disable";
			readonly server: string;
	  };

export interface ConversationAttachment {
	readonly transcript: Transcript;
	/** The number of the last event folded into `transcript`; the next event is one more. */
	readonly revision: number;
	/**
	 * What the person was typing to this Agent and had not sent, as last
	 * reported by `saveDraft` — before a restart of DevHub too. Empty when
	 * there is none.
	 */
	readonly draft: string;
}

export type ConversationEventListener = (
	revision: number,
	event: ConversationEvent,
) => void;

/** `window.devhub.conversation`, on the Agents page only. */
export interface ConversationApi {
	/**
	 * The conversation so far, and every event after it to `onEvent`, until
	 * `detach`. One attachment per Agent per page.
	 */
	attach(
		agentId: string,
		onEvent: ConversationEventListener,
	): Promise<ConversationAttachment>;
	detach(agentId: string): Promise<void>;
	send(
		agentId: string,
		text: string,
		images: readonly ImageRef[],
	): Promise<void>;
	/**
	 * Hold a waiting message while the person changes it: it is not written
	 * until `editPending` or `stopEditingPending`, or until this page detaches
	 * or goes away, which gives every such edit up.
	 */
	startEditingPending(agentId: string, pending: PendingId): Promise<void>;
	editPending(agentId: string, pending: PendingId, text: string): Promise<void>;
	stopEditingPending(agentId: string, pending: PendingId): Promise<void>;
	removePending(agentId: string, pending: PendingId): Promise<void>;
	sendPendingNow(agentId: string, pending: PendingId): Promise<void>;
	instruct(agentId: string, subagent: EntryId, text: string): Promise<void>;
	interrupt(agentId: string): Promise<void>;
	stopTask(agentId: string, task: string): Promise<void>;
	answer(
		agentId: string,
		request: RequestId,
		answer: RequestAnswer,
	): Promise<void>;
	/**
	 * Take the conversation back to before `message`, one of `rewindTargets`.
	 * Refused, with the reason, when it cannot be rewound to now.
	 */
	rewind(agentId: string, message: EntryId): Promise<RewindOutcome>;
	/**
	 * Carry the conversation on in a terminal Agent from the same profile,
	 * resuming the session, and stop this one once that one runs. Refused,
	 * with the reason, while there is no session to resume.
	 */
	continueInTerminal(agentId: string): Promise<void>;
	/**
	 * The mirror, for a terminal Claude or Codex Agent: carry its session on in
	 * a GUI Agent from the same profile, and stop this one once that one runs.
	 * Refused, with the reason, when DevHub cannot tell which session it is in.
	 */
	continueInGui(agentId: string): Promise<void>;
	/**
	 * Stop the GUI Agent's CLI and start it again on its session (`/restart`),
	 * asking first on the confirmation sheet when the Agent is not idle, as
	 * the Sidebar's Restart Session does.
	 */
	restartSession(agentId: string): Promise<void>;
	/** The earlier sessions a GUI Agent's `/resume` offers: its Workspace's, or every directory's. */
	listSessions(
		agentId: string,
		scope: SessionScopeWire,
	): Promise<readonly PastSessionWire[]>;
	/** The last exchanges of one of them, read on demand. */
	previewSession(
		agentId: string,
		session: string,
		cwd: string,
	): Promise<readonly SessionPreviewLineWire[]>;
	/**
	 * Have the GUI Agent go on with `session` in place of the one it is in:
	 * resolves once its CLI has it. Refused, with the reason, while a turn
	 * runs or when the session cannot be read back.
	 */
	resumeSession(agentId: string, session: string): Promise<void>;
	setSetting(
		agentId: string,
		which: "model" | "effort" | "mode",
		id: string,
	): Promise<void>;
	/**
	 * Ask the Agent's CLI about its MCP servers, or reconnect, enable or
	 * disable one. Resolves once the request is written; what the CLI
	 * answers is in `Transcript.mcp`.
	 */
	mcp(agentId: string, request: McpRequestWire): Promise<void>;
	/**
	 * Sign in to one of the Agent's MCP servers: its CLI's own `mcp login`,
	 * run on the Agent's machine and shown in `Transcript.mcpSignIn`.
	 * Resolves once it has started.
	 */
	signIn(agentId: string, server: string): Promise<void>;
	/** A line for the running sign-in's prompt (the redirect URL pasted back). */
	signInInput(agentId: string, text: string): Promise<void>;
	cancelSignIn(agentId: string): Promise<void>;
	/** Put away a sign-in that has ended. */
	dismissSignIn(agentId: string): Promise<void>;
	/**
	 * The Agent's unsent draft is now `text` (empty: none). Main keeps the last
	 * one it is told, across restarts, for as long as the Agent exists
	 * (`main/agent/conversation/drafts.ts`).
	 */
	saveDraft(agentId: string, text: string): Promise<void>;
}

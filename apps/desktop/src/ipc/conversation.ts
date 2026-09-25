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
	rewind: "devhub:conversation:rewind",
	/** main → page: `(agentId, revision, event)`. */
	event: "devhub:conversation:event",
} as const;

/** What the page may ask of a conversation. A person's words are always the person's. */
export type ConversationCommandWire =
	/** The person's words: written at once when the Agent is idle, else held (`Transcript.pending`). */
	| { readonly kind: "send"; readonly text: string }
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
	| {
			readonly kind: "answer";
			readonly request: RequestId;
			readonly answer: RequestAnswer;
	  }
	| {
			readonly kind: "set-setting";
			readonly which: "model" | "effort" | "mode";
			readonly id: string;
	  };

export interface ConversationAttachment {
	readonly transcript: Transcript;
	/** The number of the last event folded into `transcript`; the next event is one more. */
	readonly revision: number;
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
	send(agentId: string, text: string): Promise<void>;
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
}

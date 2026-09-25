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
	EditOutcome,
	EntryId,
	RequestAnswer,
	RequestId,
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
	editLastMessage: "devhub:conversation:edit-last-message",
	/** main → page: `(agentId, revision, event)`. */
	event: "devhub:conversation:event",
} as const;

/** What the page may ask of a conversation. A person's words are always the person's. */
export type ConversationCommandWire =
	| { readonly kind: "send"; readonly text: string }
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
	interrupt(agentId: string): Promise<void>;
	answer(
		agentId: string,
		request: RequestId,
		answer: RequestAnswer,
	): Promise<void>;
	/**
	 * Take back the turn of the person's last message (`editableMessage`) and
	 * everything after it, and send `text` in its place. Refused, with the
	 * reason, when that message cannot be edited now.
	 */
	editLastMessage(
		agentId: string,
		message: EntryId,
		text: string,
	): Promise<EditOutcome>;
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

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
	RequestAnswer,
	RequestId,
	Transcript,
} from "../model/conversation.js";

export const CONVERSATION_CHANNELS = {
	attach: "devhub:conversation:attach",
	detach: "devhub:conversation:detach",
	command: "devhub:conversation:command",
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
	setSetting(
		agentId: string,
		which: "model" | "effort" | "mode",
		id: string,
	): Promise<void>;
}

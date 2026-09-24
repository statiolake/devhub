/**
 * A GUI Agent's conversation, read as the round reads a terminal's screen.
 *
 * The round has one question for every Agent — what is its status, what does
 * it say it is doing, is anything wrong with it — and this answers it for a
 * GUI Agent from its conversation (design §5.1). The answer travels the same
 * way a screen's does: as the round's observation, never pushed to the model
 * from the side, so "where does an Agent's status come from" has one answer.
 */

import {
	conversationActivity,
	conversationStatus,
	type ConversationFailureCode,
} from "../../../model/conversation.js";
import type {
	AgentFailure,
	AgentFailureCode,
	AgentStatus,
} from "../../../model/domain.js";
import type { ConversationReading } from "./conversation.js";

export interface ConversationObservation {
	readonly status: AgentStatus;
	readonly activity: string | undefined;
	readonly failure: AgentFailure | undefined;
}

const FAILURE_CODES: Readonly<
	Record<ConversationFailureCode, AgentFailureCode>
> = {
	protocol_mismatch: "conversation_protocol_mismatch",
	not_signed_in: "conversation_not_signed_in",
	refused: "conversation_refused",
};

export function observeConversation(
	reading: ConversationReading,
): ConversationObservation {
	const { transcript, lost } = reading;
	// A conversation DevHub cannot follow is not read at all, whatever the last
	// thing it said was: the status is the one for "nobody is reading it".
	if (lost !== undefined) {
		return {
			status: "unknown",
			activity: undefined,
			failure: { code: "conversation_host_lost", detail: lost.message },
		};
	}
	const { state } = transcript;
	return {
		status: conversationStatus(transcript),
		activity: conversationActivity(transcript),
		failure:
			state.phase === "broken"
				? {
						code: FAILURE_CODES[state.failure.code],
						detail: state.failure.detail,
					}
				: undefined,
	};
}

/**
 * The seam between a structured CLI's lines and the normalized conversation.
 *
 * One adapter per GUI Agent, one implementation per protocol (Claude's
 * stream-json, Codex's app-server JSON-RPC). It does no I/O: it is handed the
 * lines the CLI printed and the lines DevHub wrote, and it answers with
 * `ConversationEvent`s and with the lines to write. That is what lets the same
 * code replay a journal after a restart and follow a live stream — and lets a
 * test drive it with nothing but NDJSON.
 *
 * # Writing is two steps
 *
 * `encode` turns a command into lines and changes nothing. Only when a line
 * has actually been written does the caller hand it back through `sent` — the
 * same call a replay makes for each line of `in.log`. So what the adapter
 * believes DevHub said is exactly what reached the CLI, and a write that
 * failed leaves no trace in the conversation (the request it answered stays
 * open, the message it carried was never said).
 *
 * # Failure
 *
 * A line of a type the adapter knows, in a shape it does not, throws
 * `ProtocolMismatch` naming where in the line it went wrong. The adapter does
 * not catch it: the one loop that feeds lines in turns it into a broken
 * conversation. After a throw the adapter is spent and refuses every further
 * call, because its bookkeeping may be half-updated.
 */

import type {
	ConversationEvent,
	RequestAnswer,
	RequestId,
	Transcript,
} from "../../../model/conversation.js";

export type ConversationCommand =
	/** A user message: a person's words, an injection, or a slash command typed as text. */
	| {
			readonly kind: "send";
			readonly text: string;
			readonly origin: "person" | "injection";
	  }
	| { readonly kind: "interrupt" }
	| {
			readonly kind: "answer";
			readonly request: RequestId;
			readonly answer: RequestAnswer;
	  };

/** The three settings a session offers choices for, as `SessionFacts` names them. */
export type SettingName = "model" | "effort" | "mode";

export interface AdapterStep {
	readonly events: readonly ConversationEvent[];
	/** Lines the protocol requires DevHub to write back at once. */
	readonly replies: readonly string[];
}

export interface ProtocolAdapter {
	/** Every event this adapter has produced, folded. */
	readonly transcript: Transcript;
	/** The lines to write right after the CLI starts (the handshake). Not for a replay: those are in `in.log`. */
	opening(): readonly string[];
	/** The lines that carry `command`. Changes nothing until they come back through `sent`. */
	encode(command: ConversationCommand): readonly string[];
	/**
	 * A setting chosen: one of `SessionFacts[which].choices`.
	 *
	 * The one call that may change what the adapter holds without a line
	 * coming back through `sent`, because a protocol may carry settings on the
	 * next turn rather than set them (Codex): the choice is held, and its
	 * session event is in the step. A protocol that does set them (Claude)
	 * returns the lines that do as `replies`; the caller writes them and hands
	 * them back through `sent`, like every other line, and the setting changes
	 * when the CLI says it has.
	 */
	configure(which: SettingName, id: string): AdapterStep;
	/** A line DevHub wrote to the CLI's stdin — live, or read back from `in.log`. */
	sent(line: string): AdapterStep;
	/** A line the CLI printed on stdout. */
	received(line: string): AdapterStep;
}

/**
 * A line of a known type whose shape the decoder does not accept, or a line
 * that is not JSON. The CLI and DevHub disagree about the protocol (version
 * skew), which is not something either side can talk its way past.
 */
export class ProtocolMismatch extends Error {
	constructor(
		/** Where in the line: `assistant.message.content[2].id`. */
		readonly path: string,
		readonly expected: string,
		/** The CLI's version, when the handshake got far enough to say. */
		readonly agentVersion: string | undefined,
	) {
		super(
			`${path}: expected ${expected}${agentVersion === undefined ? "" : ` (CLI ${agentVersion})`}`,
		);
		this.name = "ProtocolMismatch";
	}
}

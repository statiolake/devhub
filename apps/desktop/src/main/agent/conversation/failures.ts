/**
 * The failures a GUI Agent's conversation and the sessions of its CLI end in
 * that DevHub knows by name.
 *
 * Each is a `NamedFailure` with its own code, so it is drawn with its own
 * title and the sentence it was raised with as the detail, wherever it ends
 * — a toast, the session picker, a launch. A plain `Error` from this part of
 * main is kept for what DevHub did not expect, which is what the app shell's
 * catch-all title is for; a refusal written for the person thrown as one was
 * drawn as "The native app shell is unavailable." over its own words.
 *
 * Which kind a failure is decides only its title; the words that say what
 * happened are the raiser's, its detail.
 */

import type { AppErrorCodeWire } from "../../../ipc/appShell.js";
import { errorWireAt, NamedFailure, withDetail } from "../../../model/wire.js";

type ConversationFailureCode = Extract<
	AppErrorCodeWire,
	| "conversation_refused"
	| "conversation_stopped"
	| "conversation_not_resumable"
	| "sessions_unreadable"
>;

abstract class ConversationFailure extends NamedFailure {
	constructor(
		code: ConversationFailureCode,
		reason: string,
		options?: ErrorOptions,
	) {
		super(withDetail(errorWireAt(code), reason), options);
	}
}

/**
 * The conversation will not take what it was asked, now or with this CLI,
 * and `reason` says what to do instead.
 */
export class ConversationRefused extends ConversationFailure {
	constructor(reason: string) {
		super("conversation_refused", reason);
		this.name = "ConversationRefused";
	}
}

/** The conversation stopped while, or before, it was doing what it was asked. */
export class ConversationStopped extends ConversationFailure {
	constructor(reason: string) {
		super("conversation_stopped", reason);
		this.name = "ConversationStopped";
	}
}

/**
 * A session DevHub was asked to go on with cannot be gone on with: the one a
 * launch or a `/resume` names is not there, or not whole, or the one a
 * terminal Agent is in cannot be told, or a GUI Agent's CLI has named none
 * yet. A launch that ends in one is the profile's refusal instead
 * (`portRefusal`).
 */
export class SessionNotResumable extends ConversationFailure {
	constructor(reason: string) {
		super("conversation_not_resumable", reason);
		this.name = "SessionNotResumable";
	}
}

/**
 * What a CLI keeps of its sessions could not be read on the Workspace's
 * machine: it did not answer, it answered with a failure, or what it holds
 * is not in the shape the CLI writes.
 */
export class SessionsUnreadable extends ConversationFailure {
	constructor(reason: string, options?: ErrorOptions) {
		super("sessions_unreadable", reason, options);
		this.name = "SessionsUnreadable";
	}
}

/**
 * What main, the conversation engine (`engine.ts`) and the Agents page say to
 * each other. Plain data all three ways (structured clone).
 *
 * - **main → engine**: the settings the conversations run on; open a
 *   conversation, call one of its methods, close it; answers to what the
 *   engine asked; the lines of a journal main follows for it (an Agent on
 *   another machine); a page's port.
 * - **engine → main**: each conversation's facts when they change (the
 *   round's reading of it, its session, its MCP servers), its usage, the
 *   results of calls, and what it asks main for: where the host is and what
 *   it runs, a usage-limit record to keep, a host on another machine to use.
 * - **page ↔ engine**, over a `MessagePort` main handed out: attach, detach,
 *   and the events of what the page attached, batched per turn of the
 *   engine's loop. A transcript never passes main.
 */

import type {
	ConversationEvent,
	Transcript,
	Usage,
} from "../../model/conversation.js";
import type { ConversationEventBatch } from "../../ipc/conversation.js";
import type { AgentId } from "../../model/domain.js";
import type { AppErrorWire } from "../../ipc/appShell.js";
import type { CacheKeepSettings } from "../agent/conversation/cacheKeeper.js";
import type { ConversationFacts } from "../agent/conversation/conversation.js";
import type { ConversationHandle } from "../agent/conversation/handle.js";
import type {
	HostLinkFailureCode,
	JournalLine,
	SentRecord,
} from "../agent/conversation/hostLink.js";
import type {
	LimitResumeRecord,
	LimitResumeSettings,
} from "../agent/conversation/limitResume.js";
import {
	ConversationRefused,
	ConversationStopped,
	SessionNotResumable,
	SessionsUnreadable,
} from "../agent/conversation/failures.js";
import { HostLinkFailure } from "../agent/conversation/hostLink.js";
import { NamedFailure } from "../../model/wire.js";

export type { ConversationEventBatch };

/** The settings every conversation runs on; sent at start and on every change. */
export interface EngineSettings {
	readonly limitResume: LimitResumeSettings;
	readonly cacheKeep: CacheKeepSettings;
}

/** What a conversation is made of, as main knows it when it opens one. */
export interface OpenSpec {
	readonly kind: "claude" | "codex";
	/** Names this boot of DevHub in the adapters' control requests. */
	readonly bootId: string;
	readonly cwd: string;
	readonly clientVersion: string;
	/** Codex: the thread the profile's arguments resume. */
	readonly resumeThreadId: string | undefined;
	/**
	 * The engine opens the host itself (an Agent on this machine): it asks
	 * main where (`prepare-host`), then follows the journal and writes on its
	 * own. Otherwise every host call is main's (`host`).
	 */
	readonly hostHere: boolean;
	/** The Agent's usage-limit record, as main keeps it. */
	readonly record: LimitResumeRecord | undefined;
	/** Codex's developer instructions as of now (`instructions` follows). */
	readonly instructions: string | undefined;
}

/** The profile a host's CLI is composed from (`guiAgentCli`), as data. */
export interface CliProfile {
	readonly kind: "claude" | "codex";
	readonly command: string;
	readonly args: readonly string[];
	readonly env: readonly (readonly [string, string])[];
}

/** Where a host on this machine is, and what it runs: main's answer to `prepare-host`. */
export interface PreparedHost {
	readonly directory: string;
	readonly cli: CliProfile;
	readonly instructions: string | undefined;
}

/** The handle's methods a call can name: everything but what main reads itself. */
export type CallMethod = Exclude<
	keyof ConversationHandle,
	"facts" | "pagePort" | "start"
>;

export type HostMethod =
	| "write"
	| "restart"
	| "sleep"
	| "sentLog"
	| "journalSize";

/** A failure crossing a process: its class is part of what it means. */
export type ErrorWire =
	| {
			readonly kind: "host-link";
			readonly code: HostLinkFailureCode;
			readonly message: string;
			readonly offset: number | undefined;
	  }
	| {
			readonly kind: "named";
			readonly name: string;
			readonly wire: AppErrorWire;
	  }
	| { readonly kind: "error"; readonly name: string; readonly message: string };

export type ToEngine =
	| { readonly type: "settings"; readonly settings: EngineSettings }
	| {
			readonly type: "open";
			readonly agentId: AgentId;
			readonly spec: OpenSpec;
	  }
	| {
			readonly type: "call";
			readonly id: number;
			readonly agentId: AgentId;
			readonly method: CallMethod;
			readonly args: readonly unknown[];
	  }
	| {
			readonly type: "instructions";
			readonly agentId: AgentId;
			readonly text: string | undefined;
	  }
	| {
			readonly type: "answer";
			readonly id: number;
			readonly ok: true;
			readonly value: unknown;
	  }
	| {
			readonly type: "answer";
			readonly id: number;
			readonly ok: false;
			readonly error: ErrorWire;
	  }
	| {
			readonly type: "lines";
			readonly stream: number;
			readonly lines: readonly JournalLine[];
	  }
	| {
			readonly type: "lines-end";
			readonly stream: number;
			readonly error: ErrorWire | undefined;
	  }
	/** Carries the page's port as its one transferred port. */
	| { readonly type: "page"; readonly page: number }
	| { readonly type: "page-gone"; readonly page: number };

export type EngineQuestion =
	| { readonly kind: "prepare-host" }
	| {
			readonly kind: "host";
			readonly method: HostMethod;
			readonly args: readonly unknown[];
	  };

export type FromEngine =
	| {
			readonly type: "facts";
			readonly agentId: AgentId;
			readonly facts: ConversationFacts;
	  }
	| { readonly type: "usage"; readonly agentId: AgentId; readonly usage: Usage }
	| {
			readonly type: "result";
			readonly id: number;
			readonly ok: true;
			readonly value: unknown;
	  }
	| {
			readonly type: "result";
			readonly id: number;
			readonly ok: false;
			readonly error: ErrorWire;
	  }
	| {
			readonly type: "ask";
			readonly id: number;
			readonly agentId: AgentId;
			readonly question: EngineQuestion;
	  }
	| {
			readonly type: "record";
			readonly agentId: AgentId;
			readonly record: LimitResumeRecord;
	  }
	| {
			readonly type: "lines-open";
			readonly stream: number;
			readonly agentId: AgentId;
			readonly fromOffset: number;
	  }
	| { readonly type: "lines-cancel"; readonly stream: number };

export type PageToEngine =
	| { readonly type: "attach"; readonly agentId: string; readonly rid: number }
	| { readonly type: "detach"; readonly agentId: string };

export type EngineToPage =
	| {
			readonly type: "attached";
			readonly rid: number;
			readonly transcript: Transcript;
			readonly revision: number;
	  }
	| {
			readonly type: "attach-failed";
			readonly rid: number;
			readonly message: string;
	  }
	| { readonly type: "events"; readonly batch: ConversationEventBatch };

/** `[agentId, revision, event]`, as the page folds it. */
export type EngineEvent = readonly [AgentId, number, ConversationEvent];

const NAMED: Readonly<Record<string, (reason: string) => NamedFailure>> = {
	ConversationRefused: (reason) => new ConversationRefused(reason),
	ConversationStopped: (reason) => new ConversationStopped(reason),
	SessionNotResumable: (reason) => new SessionNotResumable(reason),
	SessionsUnreadable: (reason) => new SessionsUnreadable(reason),
};

export function errorToWire(error: unknown): ErrorWire {
	if (error instanceof HostLinkFailure) {
		return {
			kind: "host-link",
			code: error.code,
			message: error.message,
			offset: error.offset,
		};
	}
	if (error instanceof NamedFailure) {
		return { kind: "named", name: error.name, wire: error.wire };
	}
	if (error instanceof Error) {
		return { kind: "error", name: error.name, message: error.message };
	}
	return { kind: "error", name: "Error", message: String(error) };
}

/** The failure `errorToWire` was made from, as near as this side can make it: the same class, words and code. */
export function errorFromWire(wire: ErrorWire): Error {
	switch (wire.kind) {
		case "host-link":
			return new HostLinkFailure(wire.code, wire.message, wire.offset);
		case "named": {
			const make = NAMED[wire.name];
			if (make !== undefined && typeof wire.wire.detail === "string")
				return make(wire.wire.detail);
			const failure = new NamedFailure(wire.wire);
			failure.name = wire.name;
			return failure;
		}
		case "error": {
			const failure = new Error(wire.message);
			failure.name = wire.name;
			return failure;
		}
	}
}

export type { SentRecord };

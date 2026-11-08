/**
 * What main, the conversation engine (`engine.ts`) and the Agents page say to
 * each other. Plain data all three ways (structured clone).
 *
 * - **main → engine**: the settings the conversations run on; open a
 *   conversation, call one of its methods, close it; answers to what the
 *   engine asked; for an Agent on another machine, the port a stream main
 *   started for it sends its bytes on, and how the stream ended; a page's
 *   port.
 * - **engine → main**: each conversation's facts when they change (the
 *   round's reading of it, its session, its MCP servers), its usage, the
 *   results of calls, and what it asks main for: where the host is and what
 *   it runs, a usage-limit record to keep, a host on another machine to use,
 *   a stream or a command on that machine.
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
	 * own. Otherwise it follows the journal over main's runtime of that
	 * machine (`brokeredRuntime.ts`), and every other host call is main's
	 * (`host`).
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

/** Where the journal of an Agent on another machine is: main's answer to `journal`. */
export interface JournalPlace {
	readonly directory: string;
	/** The runtime's `where`, for the link's sentences. */
	readonly where: string;
}

/** How a command main ran for the engine ended: main's answer to `exec`. */
export type ExecAnswer =
	| {
			readonly kind: "result";
			readonly code: number | null;
			readonly signal: string | null;
			readonly stdout: Uint8Array;
			readonly stderr: Uint8Array;
	  }
	/** It went past a cap under `overflow: "fail"`: the engine says it in its own words. */
	| { readonly kind: "overflow" };

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
	/** Carries the port the stream's bytes come on as its one transferred port. */
	| { readonly type: "stream-port"; readonly stream: number }
	/** `end` when the program ended, `error` when there was no answer. */
	| {
			readonly type: "stream-end";
			readonly stream: number;
			readonly end:
				| {
						readonly code: number | null;
						readonly signal: string | null;
						readonly stderr: Uint8Array;
				  }
				| undefined;
			readonly error: ErrorWire | undefined;
	  }
	/** Carries the page's port as its one transferred port. */
	| { readonly type: "page"; readonly page: number }
	| { readonly type: "page-gone"; readonly page: number };

export type EngineQuestion =
	| { readonly kind: "prepare-host" }
	| { readonly kind: "journal" }
	| {
			readonly kind: "exec";
			readonly argv: readonly string[];
			readonly cwd?: string;
			readonly env?: Readonly<Record<string, string | undefined>>;
			readonly stdin?: Uint8Array;
			readonly timeoutMs: number;
			readonly stdoutBytes: number;
			readonly stderrBytes: number;
			readonly overflow: "truncate" | "fail";
	  }
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
	/** A stream on `agentId`'s machine, for its `HostLink` here (`StreamRequest` as data). */
	| {
			readonly type: "stream-open";
			readonly stream: number;
			readonly agentId: AgentId;
			readonly argv: readonly string[];
			readonly cwd?: string;
			readonly env?: Readonly<Record<string, string | undefined>>;
	  }
	| { readonly type: "stream-cancel"; readonly stream: number };

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

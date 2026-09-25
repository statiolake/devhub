/**
 * What `codex app-server` prints, read into the shapes the adapter uses.
 *
 * The wire is JSON-RPC 2.0, one message per line (app-server leaves out the
 * `"jsonrpc"` member). A line is one of four things: a response to a request
 * DevHub made, an error response to one, a notification, or a request the
 * server makes of DevHub (an approval, a question).
 *
 * Every reader here checks only the fields the adapter reads, and each result
 * type is a `Pick` of the vendored upstream type (`./protocol/`), so a field
 * upstream renames or retypes is a compile error here rather than a silent
 * `undefined` at run time. A field that is absent and a field that is `null`
 * read the same: the server omits some nullable fields and sends others as
 * `null`, and nothing here tells the two apart.
 *
 * A message that does not have the shape its reader expects throws the shared
 * `ProtocolMismatch`, naming the path that did not fit and the CLI's version
 * (which is why every reader takes the `Reader` that knows it). That is the
 * CLI saying something DevHub believed it would never say, so nothing here
 * recovers from it: the loop that feeds lines in turns it into a broken
 * conversation at its one root.
 */

import {
	type JsonValue,
	type RateLimit,
	rateLimitWindowName,
} from "../../../../model/conversation.js";
import { ProtocolMismatch } from "../protocolAdapter.js";
import type { InitializeResponse } from "./protocol/InitializeResponse.js";
import type { RequestId as RpcId } from "./protocol/RequestId.js";
import type { AgentMessageDeltaNotification } from "./protocol/v2/AgentMessageDeltaNotification.js";
import type { CollabAgentStatus } from "./protocol/v2/CollabAgentStatus.js";
import type { CommandExecutionOutputDeltaNotification } from "./protocol/v2/CommandExecutionOutputDeltaNotification.js";
import type { CommandExecutionRequestApprovalParams } from "./protocol/v2/CommandExecutionRequestApprovalParams.js";
import type { ErrorNotification } from "./protocol/v2/ErrorNotification.js";
import type { FileChangePatchUpdatedNotification } from "./protocol/v2/FileChangePatchUpdatedNotification.js";
import type { FileChangeRequestApprovalParams } from "./protocol/v2/FileChangeRequestApprovalParams.js";
import type { FileUpdateChange } from "./protocol/v2/FileUpdateChange.js";
import type { GetAccountResponse } from "./protocol/v2/GetAccountResponse.js";
import type { ConfigWarningNotification } from "./protocol/v2/ConfigWarningNotification.js";
import type { DeprecationNoticeNotification } from "./protocol/v2/DeprecationNoticeNotification.js";
import type { ItemCompletedNotification } from "./protocol/v2/ItemCompletedNotification.js";
import type { McpServerElicitationRequestParams } from "./protocol/v2/McpServerElicitationRequestParams.js";
import type { Model } from "./protocol/v2/Model.js";
import type { ModelReroutedNotification } from "./protocol/v2/ModelReroutedNotification.js";
import type { NetworkPolicyAmendment } from "./protocol/v2/NetworkPolicyAmendment.js";
import type { PermissionsRequestApprovalParams } from "./protocol/v2/PermissionsRequestApprovalParams.js";
import type { PlanDeltaNotification } from "./protocol/v2/PlanDeltaNotification.js";
import type { ReasoningSummaryPartAddedNotification } from "./protocol/v2/ReasoningSummaryPartAddedNotification.js";
import type { ReasoningSummaryTextDeltaNotification } from "./protocol/v2/ReasoningSummaryTextDeltaNotification.js";
import type { ReasoningTextDeltaNotification } from "./protocol/v2/ReasoningTextDeltaNotification.js";
import type { ServerRequestResolvedNotification } from "./protocol/v2/ServerRequestResolvedNotification.js";
import type { Thread } from "./protocol/v2/Thread.js";
import type { ThreadClosedNotification } from "./protocol/v2/ThreadClosedNotification.js";
import type { ThreadItem } from "./protocol/v2/ThreadItem.js";
import type { ThreadStartResponse } from "./protocol/v2/ThreadStartResponse.js";
import type { ThreadTokenUsageUpdatedNotification } from "./protocol/v2/ThreadTokenUsageUpdatedNotification.js";
import type { TokenUsageBreakdown } from "./protocol/v2/TokenUsageBreakdown.js";
import type { ToolRequestUserInputParams } from "./protocol/v2/ToolRequestUserInputParams.js";
import type { ToolRequestUserInputQuestion } from "./protocol/v2/ToolRequestUserInputQuestion.js";
import type { Turn } from "./protocol/v2/Turn.js";
import type { TurnPlanStep } from "./protocol/v2/TurnPlanStep.js";
import type { TurnPlanUpdatedNotification } from "./protocol/v2/TurnPlanUpdatedNotification.js";
import type { WarningNotification } from "./protocol/v2/WarningNotification.js";

/** Reads fields of one message, failing with that message's path and the CLI's version. */
export class Reader {
	constructor(
		/** The CLI's version, once the handshake has said it. */
		readonly version: string | undefined,
	) {}

	fail(path: string, expected: string): never {
		throw new ProtocolMismatch(path, expected, this.version);
	}

	private mismatch(path: string, expected: string, value: unknown): never {
		return this.fail(path, `${expected}, got ${describe(value)}`);
	}

	fields(value: unknown, path: string): Fields {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return this.mismatch(path, "an object", value);
		}
		return value as Fields;
	}

	string(o: Fields, key: string, path: string): string {
		const value = o[key];
		return typeof value === "string"
			? value
			: this.mismatch(`${path}.${key}`, "a string", value);
	}

	nullableString(o: Fields, key: string, path: string): string | null {
		const value = o[key];
		if (value === undefined || value === null) return null;
		return typeof value === "string"
			? value
			: this.mismatch(`${path}.${key}`, "a string or null", value);
	}

	number(o: Fields, key: string, path: string): number {
		const value = o[key];
		return typeof value === "number"
			? value
			: this.mismatch(`${path}.${key}`, "a number", value);
	}

	nullableNumber(o: Fields, key: string, path: string): number | null {
		const value = o[key];
		if (value === undefined || value === null) return null;
		return typeof value === "number"
			? value
			: this.mismatch(`${path}.${key}`, "a number or null", value);
	}

	boolean(o: Fields, key: string, path: string): boolean {
		const value = o[key];
		return typeof value === "boolean"
			? value
			: this.mismatch(`${path}.${key}`, "a boolean", value);
	}

	nullableBoolean(o: Fields, key: string, path: string): boolean | null {
		const value = o[key];
		if (value === undefined || value === null) return null;
		return typeof value === "boolean"
			? value
			: this.mismatch(`${path}.${key}`, "a boolean or null", value);
	}

	oneOf<const T extends string>(
		o: Fields,
		key: string,
		path: string,
		values: readonly T[],
	): T {
		const value = o[key];
		if (
			typeof value === "string" &&
			(values as readonly string[]).includes(value)
		) {
			return value as T;
		}
		return this.mismatch(
			`${path}.${key}`,
			`one of ${values.join(" | ")}`,
			value,
		);
	}

	array<T>(
		o: Fields,
		key: string,
		path: string,
		each: (value: unknown, path: string) => T,
	): T[] {
		const value = o[key];
		if (!Array.isArray(value)) {
			return this.mismatch(`${path}.${key}`, "an array", value);
		}
		return value.map((item, index) => each(item, `${path}.${key}[${index}]`));
	}

	nullableArray<T>(
		o: Fields,
		key: string,
		path: string,
		each: (value: unknown, path: string) => T,
	): T[] | null {
		const value = o[key];
		if (value === undefined || value === null) return null;
		return this.array(o, key, path, each);
	}

	readonly stringItem = (value: unknown, path: string): string =>
		typeof value === "string" ? value : this.mismatch(path, "a string", value);

	/** Any JSON: what the adapter keeps only to show. */
	json(o: Fields, key: string): JsonValue {
		const value = o[key];
		return value === undefined ? null : (value as JsonValue);
	}

	rpcId(o: Fields, key: string, path: string): RpcId {
		const value = o[key];
		if (typeof value === "string" || typeof value === "number") return value;
		return this.mismatch(`${path}.${key}`, "a string or number id", value);
	}
}

type Fields = Readonly<Record<string, unknown>>;

function describe(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	return `a ${typeof value}`;
}

// ---------------------------------------------------------------------------
// The envelope.

export type Message =
	| { readonly kind: "response"; readonly id: RpcId; readonly result: unknown }
	| {
			readonly kind: "error";
			readonly id: RpcId | null;
			readonly code: number;
			readonly message: string;
			readonly data: JsonValue;
	  }
	| {
			readonly kind: "notification";
			readonly method: string;
			readonly params: unknown;
	  }
	| {
			readonly kind: "request";
			readonly id: RpcId;
			readonly method: string;
			readonly params: unknown;
	  };

/** One line off app-server's stdout. */
export function decodeLine(r: Reader, line: string): Message {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		return r.fail(
			"line",
			`JSON, got ${line.slice(0, 200)} (${(error as Error).message})`,
		);
	}
	const o = r.fields(value, "message");
	if ("method" in o) {
		const method = r.string(o, "method", "message");
		const params = o["params"];
		return "id" in o
			? { kind: "request", id: r.rpcId(o, "id", "message"), method, params }
			: { kind: "notification", method, params };
	}
	if ("error" in o) {
		const error = r.fields(o["error"], "message.error");
		const id = o["id"] === null ? null : r.rpcId(o, "id", "message");
		return {
			kind: "error",
			id,
			code: r.number(error, "code", "message.error"),
			message: r.string(error, "message", "message.error"),
			data: r.json(error, "data"),
		};
	}
	if ("result" in o) {
		return {
			kind: "response",
			id: r.rpcId(o, "id", "message"),
			result: o["result"],
		};
	}
	return r.fail(
		"message",
		`a request, notification or response, got ${line.slice(0, 200)}`,
	);
}

// ---------------------------------------------------------------------------
// Responses to DevHub's requests.

export type Initialized = Pick<InitializeResponse, "userAgent">;

export function initializeResponse(r: Reader, value: unknown): Initialized {
	const o = r.fields(value, "result");
	return { userAgent: r.string(o, "userAgent", "result") };
}

export type AccountReading = {
	readonly signedIn: boolean;
	readonly requiresOpenaiAuth: GetAccountResponse["requiresOpenaiAuth"];
};

export function accountResponse(r: Reader, value: unknown): AccountReading {
	const o = r.fields(value, "result");
	const account = o["account"];
	if (account !== null && account !== undefined) {
		// Which kind of account it is does not matter to DevHub, only that there is one.
		r.string(r.fields(account, "result.account"), "type", "result.account");
	}
	return {
		signedIn: account !== null && account !== undefined,
		requiresOpenaiAuth: r.boolean(o, "requiresOpenaiAuth", "result"),
	};
}

export type ThreadFacts = Pick<
	Thread,
	"id" | "parentThreadId" | "agentNickname" | "historyMode"
> & {
	readonly turns: readonly TurnFacts[];
	/**
	 * Whether the person may start or steer this thread's turns themselves:
	 * `canAcceptDirectInput`, which app-server prints (0.156.1 does) though
	 * its pinned schema does not list it. Absent is no: nothing says yes.
	 */
	readonly takesDirectInput: boolean;
};

function thread(r: Reader, value: unknown, path: string): ThreadFacts {
	const o = r.fields(value, path);
	return {
		id: r.string(o, "id", path),
		parentThreadId: r.nullableString(o, "parentThreadId", path),
		agentNickname: r.nullableString(o, "agentNickname", path),
		historyMode: r.oneOf(o, "historyMode", path, ["legacy", "paginated"]),
		takesDirectInput:
			r.nullableBoolean(o, "canAcceptDirectInput", path) === true,
		turns:
			r.nullableArray(o, "turns", path, (value, at) => turn(r, value, at)) ??
			[],
	};
}

export type ThreadOpened = Pick<ThreadStartResponse, "model" | "cwd"> & {
	readonly thread: ThreadFacts;
	readonly reasoningEffort: string | null;
	readonly approvalPolicy: JsonValue;
	readonly sandbox: JsonValue;
};

/** `thread/start` and `thread/resume` answer with the same facts. */
export function threadOpenedResponse(r: Reader, value: unknown): ThreadOpened {
	const o = r.fields(value, "result");
	return {
		thread: thread(r, o["thread"], "result.thread"),
		model: r.string(o, "model", "result"),
		cwd: r.string(o, "cwd", "result"),
		reasoningEffort: r.nullableString(o, "reasoningEffort", "result"),
		approvalPolicy: r.json(o, "approvalPolicy"),
		sandbox: r.json(o, "sandbox"),
	};
}

/** One earlier thread, as `thread/list` names it: what the resume picker shows. */
export type ListedThread = Pick<
	Thread,
	"id" | "preview" | "name" | "updatedAt" | "cwd"
>;

/** `thread/list`'s page of threads, newest first as asked. */
export function threadListResponse(
	r: Reader,
	value: unknown,
): readonly ListedThread[] {
	const o = r.fields(value, "result");
	return r.array(o, "data", "result", (each, at) => {
		const t = r.fields(each, at);
		return {
			id: r.string(t, "id", at),
			preview: r.string(t, "preview", at),
			name: r.nullableString(t, "name", at),
			updatedAt: r.number(t, "updatedAt", at),
			cwd: r.string(t, "cwd", at),
		};
	});
}

export type ModelChoice = Pick<Model, "id" | "displayName" | "hidden"> & {
	readonly efforts: readonly string[];
	/** The effort a turn on this model runs at when none is given. */
	readonly defaultEffort: string;
};

export function modelListResponse(
	r: Reader,
	value: unknown,
): readonly ModelChoice[] {
	const o = r.fields(value, "result");
	return r.array(o, "data", "result", (item, path) => {
		const m = r.fields(item, path);
		return {
			id: r.string(m, "id", path),
			displayName: r.string(m, "displayName", path),
			hidden: r.boolean(m, "hidden", path),
			efforts: r.array(m, "supportedReasoningEfforts", path, (option, at) =>
				r.string(r.fields(option, at), "reasoningEffort", at),
			),
			defaultEffort: r.string(m, "defaultReasoningEffort", path),
		};
	});
}

/** A response whose content DevHub does not read still has to be an object. */
export function anyObjectResponse(r: Reader, value: unknown): void {
	r.fields(value, "result");
}

/** `thread/revert`'s answer. What it took back is the request's to say; the thread is only checked. */
export function threadRevertResponse(r: Reader, value: unknown): void {
	const o = r.fields(value, "result");
	r.string(r.fields(o["thread"], "result.thread"), "id", "result.thread");
}

// ---------------------------------------------------------------------------
// Turns and items.

export type TurnFacts = Pick<Turn, "id" | "status" | "durationMs"> & {
	readonly items: readonly Item[];
	readonly error: string | null;
};

const TURN_STATUSES = [
	"completed",
	"interrupted",
	"failed",
	"inProgress",
] as const;

function turn(r: Reader, value: unknown, path: string): TurnFacts {
	const o = r.fields(value, path);
	const error = o["error"];
	let message: string | null = null;
	if (error !== null && error !== undefined) {
		const e = r.fields(error, `${path}.error`);
		const details = r.nullableString(e, "additionalDetails", `${path}.error`);
		message = r.string(e, "message", `${path}.error`);
		if (details !== null) message = `${message}\n${details}`;
	}
	return {
		id: r.string(o, "id", path),
		status: r.oneOf(o, "status", path, TURN_STATUSES),
		durationMs: r.nullableNumber(o, "durationMs", path),
		items: r.array(o, "items", path, (value, at) => item(r, value, at)),
		error: message,
	};
}

export type TurnNotification = {
	readonly threadId: string;
	readonly turn: TurnFacts;
};

export function turnNotification(r: Reader, params: unknown): TurnNotification {
	const o = r.fields(params, "params");
	return {
		threadId: r.string(o, "threadId", "params"),
		turn: turn(r, o["turn"], "params.turn"),
	};
}

type Of<T extends ThreadItem["type"]> = Extract<ThreadItem, { type: T }>;

const COMMAND_STATUSES = [
	"inProgress",
	"completed",
	"failed",
	"declined",
] as const;
const TOOL_CALL_STATUSES = ["inProgress", "completed", "failed"] as const;
const COLLAB_STATUSES = [
	"inProgress",
	"completed",
	"failed",
	"interrupted",
] as const;
const COLLAB_TOOLS = [
	"spawnAgent",
	"sendInput",
	"resumeAgent",
	"wait",
	"closeAgent",
	"sendMessage",
	"followupTask",
	"interruptAgent",
	"listAgents",
] as const;
const COLLAB_AGENT_STATUSES = [
	"pendingInit",
	"running",
	"interrupted",
	"completed",
	"errored",
	"shutdown",
	"notFound",
] as const satisfies readonly CollabAgentStatus[];
const SUBAGENT_ACTIVITY = [
	"started",
	"interacted",
	"interrupted",
	"completed",
] as const;

export type UserMessageInput =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "image"; readonly label: string }
	| { readonly type: "other"; readonly label: string };

/**
 * The items the adapter draws, each as the fields it reads. Every other item
 * type the protocol names comes back as `other` with the item whole, and one
 * the protocol does not name as `unknown`: the adapter shows both, but only
 * the second is a surprise.
 */
export type Item =
	| (Pick<Of<"userMessage">, "type" | "id" | "clientId"> & {
			readonly content: readonly UserMessageInput[];
	  })
	| Pick<Of<"agentMessage">, "type" | "id" | "text">
	| Pick<Of<"plan">, "type" | "id" | "text">
	| Pick<Of<"reasoning">, "type" | "id" | "summary" | "content">
	| Pick<
			Of<"commandExecution">,
			| "type"
			| "id"
			| "command"
			| "cwd"
			| "status"
			| "aggregatedOutput"
			| "exitCode"
	  >
	| (Pick<Of<"fileChange">, "type" | "id" | "status"> & {
			readonly changes: readonly FileChange[];
	  })
	| (Pick<Of<"mcpToolCall">, "type" | "id" | "server" | "tool" | "status"> & {
			/** Kept only to show, so as DevHub's JSON rather than upstream's. */
			readonly arguments: JsonValue;
			readonly result: JsonValue;
			readonly error: string | null;
	  })
	| (Pick<
			Of<"dynamicToolCall">,
			"type" | "id" | "namespace" | "tool" | "status"
	  > & {
			readonly arguments: JsonValue;
			readonly output: readonly string[];
	  })
	| (Pick<
			Of<"collabAgentToolCall">,
			| "type"
			| "id"
			| "tool"
			| "status"
			| "receiverThreadIds"
			| "prompt"
			| "model"
	  > & { readonly agentsStates: Readonly<Record<string, CollabAgentStatus>> })
	| Pick<
			Of<"subAgentActivity">,
			"type" | "id" | "kind" | "agentThreadId" | "agentPath"
	  >
	| {
			readonly type: "webSearch";
			readonly id: string;
			readonly query: string;
			readonly results: JsonValue;
	  }
	| Pick<Of<"imageView">, "type" | "id" | "path">
	| Pick<Of<"enteredReviewMode">, "type" | "id" | "review">
	| Pick<Of<"exitedReviewMode">, "type" | "id" | "review">
	| Pick<Of<"contextCompaction">, "type" | "id">
	| {
			readonly type: "other";
			readonly itemType: ThreadItem["type"];
			readonly id: string;
			readonly raw: JsonValue;
	  }
	| {
			readonly type: "unknown";
			readonly itemType: string;
			readonly id: string;
			readonly raw: JsonValue;
	  };

export type FileChange = Pick<FileUpdateChange, "path" | "diff"> & {
	readonly kind: FileUpdateChange["kind"]["type"];
};

function fileChange(r: Reader, value: unknown, path: string): FileChange {
	const o = r.fields(value, path);
	return {
		path: r.string(o, "path", path),
		diff: r.string(o, "diff", path),
		kind: r.oneOf(r.fields(o["kind"], `${path}.kind`), "type", `${path}.kind`, [
			"add",
			"delete",
			"update",
		]),
	};
}

function userInput(r: Reader, value: unknown, path: string): UserMessageInput {
	const o = r.fields(value, path);
	const type = r.string(o, "type", path);
	switch (type) {
		case "text":
			return { type: "text", text: r.string(o, "text", path) };
		case "image":
			return {
				type: "image",
				label: r.nullableString(o, "url", path) ?? "image",
			};
		case "localImage":
			return { type: "image", label: r.string(o, "path", path) };
		default:
			return {
				type: "other",
				label:
					r.nullableString(o, "name", path) ??
					r.nullableString(o, "path", path) ??
					type,
			};
	}
}

/**
 * Every item type the vendored `ThreadItem` names, and whether the adapter
 * draws it. A type upstream adds is a compile error here until it is placed.
 */
const ITEM_TYPES: { readonly [T in ThreadItem["type"]]: "drawn" | "other" } = {
	userMessage: "drawn",
	hookPrompt: "other",
	agentMessage: "drawn",
	functionCallOutput: "other",
	plan: "drawn",
	reasoning: "drawn",
	commandExecution: "drawn",
	fileChange: "drawn",
	mcpToolCall: "drawn",
	dynamicToolCall: "drawn",
	collabAgentToolCall: "drawn",
	subAgentActivity: "drawn",
	webSearch: "drawn",
	imageView: "drawn",
	sleep: "other",
	imageGeneration: "other",
	enteredReviewMode: "drawn",
	exitedReviewMode: "drawn",
	contextCompaction: "drawn",
};

function isItemType(type: string): type is ThreadItem["type"] {
	return Object.hasOwn(ITEM_TYPES, type);
}

export function item(r: Reader, value: unknown, path: string): Item {
	const o = r.fields(value, path);
	const type = r.string(o, "type", path);
	const id = r.string(o, "id", path);
	switch (type) {
		case "userMessage":
			return {
				type,
				id,
				clientId: r.nullableString(o, "clientId", path),
				content: r.array(o, "content", path, (value, at) =>
					userInput(r, value, at),
				),
			};
		case "agentMessage":
		case "plan":
			return { type, id, text: r.string(o, "text", path) };
		case "reasoning":
			return {
				type,
				id,
				summary: r.array(o, "summary", path, r.stringItem),
				content: r.array(o, "content", path, r.stringItem),
			};
		case "commandExecution":
			return {
				type,
				id,
				command: r.string(o, "command", path),
				cwd: r.string(o, "cwd", path),
				status: r.oneOf(o, "status", path, COMMAND_STATUSES),
				aggregatedOutput: r.nullableString(o, "aggregatedOutput", path),
				exitCode: r.nullableNumber(o, "exitCode", path),
			};
		case "fileChange":
			return {
				type,
				id,
				status: r.oneOf(o, "status", path, COMMAND_STATUSES),
				changes: r.array(o, "changes", path, (value, at) =>
					fileChange(r, value, at),
				),
			};
		case "mcpToolCall": {
			const error = o["error"];
			return {
				type,
				id,
				server: r.string(o, "server", path),
				tool: r.string(o, "tool", path),
				status: r.oneOf(o, "status", path, TOOL_CALL_STATUSES),
				arguments: r.json(o, "arguments"),
				result: r.json(o, "result"),
				error:
					error === null || error === undefined
						? null
						: r.string(
								r.fields(error, `${path}.error`),
								"message",
								`${path}.error`,
							),
			};
		}
		case "dynamicToolCall":
			return {
				type,
				id,
				namespace: r.nullableString(o, "namespace", path),
				tool: r.string(o, "tool", path),
				status: r.oneOf(o, "status", path, TOOL_CALL_STATUSES),
				arguments: r.json(o, "arguments"),
				output: (
					r.nullableArray(o, "contentItems", path, (content, at) => {
						const c = r.fields(content, at);
						return r.string(c, "type", at) === "inputText"
							? r.string(c, "text", at)
							: null;
					}) ?? []
				).filter((text): text is string => text !== null),
			};
		case "collabAgentToolCall": {
			const states = r.fields(o["agentsStates"], `${path}.agentsStates`);
			const agentsStates: Record<string, CollabAgentStatus> = {};
			for (const [threadId, state] of Object.entries(states)) {
				const at = `${path}.agentsStates.${threadId}`;
				agentsStates[threadId] = r.oneOf(
					r.fields(state, at),
					"status",
					at,
					COLLAB_AGENT_STATUSES,
				);
			}
			return {
				type,
				id,
				tool: r.oneOf(o, "tool", path, COLLAB_TOOLS),
				status: r.oneOf(o, "status", path, COLLAB_STATUSES),
				receiverThreadIds: r.array(o, "receiverThreadIds", path, r.stringItem),
				prompt: r.nullableString(o, "prompt", path),
				model: r.nullableString(o, "model", path),
				agentsStates,
			};
		}
		case "subAgentActivity":
			return {
				type,
				id,
				kind: r.oneOf(o, "kind", path, SUBAGENT_ACTIVITY),
				agentThreadId: r.string(o, "agentThreadId", path),
				agentPath: r.string(o, "agentPath", path),
			};
		case "webSearch":
			return {
				type,
				id,
				query: r.string(o, "query", path),
				results: r.json(o, "results"),
			};
		case "imageView":
			return { type, id, path: r.string(o, "path", path) };
		case "enteredReviewMode":
		case "exitedReviewMode":
			return { type, id, review: r.string(o, "review", path) };
		case "contextCompaction":
			return { type, id };
		default:
			return isItemType(type)
				? { type: "other", itemType: type, id, raw: value as JsonValue }
				: { type: "unknown", itemType: type, id, raw: value as JsonValue };
	}
}

export type ItemNotification = Pick<
	ItemCompletedNotification,
	"threadId" | "turnId"
> & {
	readonly item: Item;
};

export function itemNotification(r: Reader, params: unknown): ItemNotification {
	const o = r.fields(params, "params");
	return {
		threadId: r.string(o, "threadId", "params"),
		turnId: r.string(o, "turnId", "params"),
		item: item(r, o["item"], "params.item"),
	};
}

// ---------------------------------------------------------------------------
// Deltas.

export type TextDelta = Pick<
	AgentMessageDeltaNotification,
	"threadId" | "itemId" | "delta"
> &
	Pick<PlanDeltaNotification, "threadId" | "itemId" | "delta"> &
	Pick<
		CommandExecutionOutputDeltaNotification,
		"threadId" | "itemId" | "delta"
	>;

/** `item/agentMessage/delta`, `item/plan/delta`, `item/commandExecution/outputDelta`. */
export function textDelta(r: Reader, params: unknown): TextDelta {
	const o = r.fields(params, "params");
	return {
		threadId: r.string(o, "threadId", "params"),
		itemId: r.string(o, "itemId", "params"),
		delta: r.string(o, "delta", "params"),
	};
}

export type ReasoningDelta = TextDelta & {
	/** Which part: the summary part for a summary delta, the content part for a raw one. */
	readonly index: number;
};

export function reasoningSummaryDelta(
	r: Reader,
	params: unknown,
): ReasoningDelta &
	Pick<ReasoningSummaryTextDeltaNotification, "summaryIndex"> {
	const o = r.fields(params, "params");
	const summaryIndex = r.number(o, "summaryIndex", "params");
	return { ...textDelta(r, params), index: summaryIndex, summaryIndex };
}

export function reasoningTextDelta(
	r: Reader,
	params: unknown,
): ReasoningDelta & Pick<ReasoningTextDeltaNotification, "contentIndex"> {
	const o = r.fields(params, "params");
	const contentIndex = r.number(o, "contentIndex", "params");
	return { ...textDelta(r, params), index: contentIndex, contentIndex };
}

export type SummaryPartAdded = Pick<
	ReasoningSummaryPartAddedNotification,
	"threadId" | "itemId" | "summaryIndex"
>;

export function summaryPartAdded(r: Reader, params: unknown): SummaryPartAdded {
	const o = r.fields(params, "params");
	return {
		threadId: r.string(o, "threadId", "params"),
		itemId: r.string(o, "itemId", "params"),
		summaryIndex: r.number(o, "summaryIndex", "params"),
	};
}

export type PatchUpdated = Pick<
	FileChangePatchUpdatedNotification,
	"threadId" | "itemId"
> & {
	readonly changes: readonly FileChange[];
};

export function patchUpdated(r: Reader, params: unknown): PatchUpdated {
	const o = r.fields(params, "params");
	return {
		threadId: r.string(o, "threadId", "params"),
		itemId: r.string(o, "itemId", "params"),
		changes: r.array(o, "changes", "params", (value, at) =>
			fileChange(r, value, at),
		),
	};
}

// ---------------------------------------------------------------------------
// Everything else the adapter reads off a notification.

export type PlanUpdated = Pick<
	TurnPlanUpdatedNotification,
	"threadId" | "turnId"
> & {
	readonly plan: readonly Pick<TurnPlanStep, "step" | "status">[];
};

export function planUpdated(r: Reader, params: unknown): PlanUpdated {
	const o = r.fields(params, "params");
	return {
		threadId: r.string(o, "threadId", "params"),
		turnId: r.string(o, "turnId", "params"),
		plan: r.array(o, "plan", "params", (value, path) => {
			const s = r.fields(value, path);
			return {
				step: r.string(s, "step", path),
				status: r.oneOf(s, "status", path, [
					"pending",
					"inProgress",
					"completed",
				]),
			};
		}),
	};
}

export type RequestResolved = Pick<
	ServerRequestResolvedNotification,
	"threadId" | "requestId"
>;

export function requestResolved(r: Reader, params: unknown): RequestResolved {
	const o = r.fields(params, "params");
	return {
		threadId: r.string(o, "threadId", "params"),
		requestId: r.rpcId(o, "requestId", "params"),
	};
}

export type TokenUsage = Pick<
	ThreadTokenUsageUpdatedNotification,
	"threadId" | "turnId"
> & {
	readonly total: Tokens;
	readonly last: Tokens;
	readonly modelContextWindow: number | null;
};

type Tokens = Pick<
	TokenUsageBreakdown,
	"totalTokens" | "inputTokens" | "cachedInputTokens" | "outputTokens"
>;

function tokens(r: Reader, value: unknown, path: string): Tokens {
	const o = r.fields(value, path);
	return {
		totalTokens: r.number(o, "totalTokens", path),
		inputTokens: r.number(o, "inputTokens", path),
		cachedInputTokens: r.number(o, "cachedInputTokens", path),
		outputTokens: r.number(o, "outputTokens", path),
	};
}

export function tokenUsage(r: Reader, params: unknown): TokenUsage {
	const o = r.fields(params, "params");
	const usage = r.fields(o["tokenUsage"], "params.tokenUsage");
	return {
		threadId: r.string(o, "threadId", "params"),
		turnId: r.string(o, "turnId", "params"),
		total: tokens(r, usage["total"], "params.tokenUsage.total"),
		last: tokens(r, usage["last"], "params.tokenUsage.last"),
		modelContextWindow: r.nullableNumber(
			usage,
			"modelContextWindow",
			"params.tokenUsage",
		),
	};
}

export type RateLimits = {
	/**
	 * The windows the update reports, primary before secondary. A window that
	 * is null in a sparse update is left out: "not reported this time", never
	 * "cleared".
	 */
	readonly windows: readonly RateLimit[];
};

export function rateLimits(r: Reader, params: unknown): RateLimits {
	const o = r.fields(params, "params");
	const snapshot = r.fields(o["rateLimits"], "params.rateLimits");
	return {
		windows: (["primary", "secondary"] as const).flatMap((slot) => {
			const value = snapshot[slot];
			if (value === null || value === undefined) return [];
			const at = `params.rateLimits.${slot}`;
			const w = r.fields(value, at);
			const minutes = r.nullableNumber(w, "windowDurationMins", at);
			const resetsAt = r.nullableNumber(w, "resetsAt", at);
			return [
				{
					window: minutes === null ? slot : rateLimitWindowName(minutes),
					usedPercent: r.number(w, "usedPercent", at),
					// Unix seconds on the wire, as Codex's core protocol keeps it.
					resetsAt: resetsAt === null ? undefined : resetsAt * 1000,
				},
			];
		}),
	};
}

export type TurnErrorNotice = Pick<
	ErrorNotification,
	"threadId" | "turnId" | "willRetry"
> & {
	readonly message: string;
};

export function errorNotification(r: Reader, params: unknown): TurnErrorNotice {
	const o = r.fields(params, "params");
	const error = r.fields(o["error"], "params.error");
	const details = r.nullableString(error, "additionalDetails", "params.error");
	const message = r.string(error, "message", "params.error");
	return {
		threadId: r.string(o, "threadId", "params"),
		turnId: r.string(o, "turnId", "params"),
		willRetry: r.boolean(o, "willRetry", "params"),
		message: details === null ? message : `${message}\n${details}`,
	};
}

export type Warning = Pick<WarningNotification, "threadId" | "message">;

/** `warning` and `guardianWarning`: a message for the user and nothing else. */
export function warning(r: Reader, params: unknown): Warning {
	const o = r.fields(params, "params");
	return {
		threadId: r.nullableString(o, "threadId", "params"),
		message: r.string(o, "message", "params"),
	};
}

export type Summary = Pick<
	DeprecationNoticeNotification,
	"summary" | "details"
> &
	Pick<ConfigWarningNotification, "summary" | "details">;

/** `deprecationNotice` and `configWarning`: a summary for the user and its details. */
export function summaryNotice(r: Reader, params: unknown): Summary {
	const o = r.fields(params, "params");
	return {
		summary: r.string(o, "summary", "params"),
		details: r.nullableString(o, "details", "params"),
	};
}

export type Rerouted = Pick<
	ModelReroutedNotification,
	"threadId" | "fromModel" | "toModel"
> & {
	readonly reason: string;
};

export function rerouted(r: Reader, params: unknown): Rerouted {
	const o = r.fields(params, "params");
	const reason = o["reason"];
	return {
		threadId: r.string(o, "threadId", "params"),
		fromModel: r.string(o, "fromModel", "params"),
		toModel: r.string(o, "toModel", "params"),
		reason: typeof reason === "string" ? reason : JSON.stringify(reason),
	};
}

/** `thread/closed`: which thread, and nothing else. */
export function threadClosed(
	r: Reader,
	params: unknown,
): Pick<ThreadClosedNotification, "threadId"> {
	return {
		threadId: r.string(r.fields(params, "params"), "threadId", "params"),
	};
}

export function threadStarted(r: Reader, params: unknown): ThreadFacts {
	return thread(r, r.fields(params, "params")["thread"], "params.thread");
}

// ---------------------------------------------------------------------------
// Requests the server makes of DevHub.

export type CommandApproval = Pick<
	CommandExecutionRequestApprovalParams,
	"threadId" | "turnId" | "itemId"
> & {
	readonly kind: CommandExecutionRequestApprovalParams["kind"];
	readonly reason: string | null;
	readonly command: string | null;
	readonly cwd: string | null;
	readonly networkHost: string | null;
	readonly execpolicyAmendment: readonly string[] | null;
	readonly networkAmendments: readonly NetworkPolicyAmendment[];
};

export function commandApproval(r: Reader, params: unknown): CommandApproval {
	const o = r.fields(params, "params");
	const network = o["networkApprovalContext"];
	return {
		threadId: r.string(o, "threadId", "params"),
		turnId: r.string(o, "turnId", "params"),
		itemId: r.string(o, "itemId", "params"),
		kind:
			"kind" in o
				? r.oneOf(o, "kind", "params", ["command", "writeStdin"])
				: "command",
		reason: r.nullableString(o, "reason", "params"),
		command: r.nullableString(o, "command", "params"),
		cwd: r.nullableString(o, "cwd", "params"),
		networkHost:
			network === null || network === undefined
				? null
				: r.string(
						r.fields(network, "params.networkApprovalContext"),
						"host",
						"params.networkApprovalContext",
					),
		execpolicyAmendment: r.nullableArray(
			o,
			"proposedExecpolicyAmendment",
			"params",
			r.stringItem,
		),
		networkAmendments:
			r.nullableArray(
				o,
				"proposedNetworkPolicyAmendments",
				"params",
				(value, path) => {
					const a = r.fields(value, path);
					return {
						host: r.string(a, "host", path),
						action: r.oneOf(a, "action", path, ["allow", "deny"]),
					};
				},
			) ?? [],
	};
}

export type FileChangeApproval = Pick<
	FileChangeRequestApprovalParams,
	"threadId" | "turnId" | "itemId"
> & { readonly reason: string | null };

export function fileChangeApproval(
	r: Reader,
	params: unknown,
): FileChangeApproval {
	const o = r.fields(params, "params");
	return {
		threadId: r.string(o, "threadId", "params"),
		turnId: r.string(o, "turnId", "params"),
		itemId: r.string(o, "itemId", "params"),
		reason: r.nullableString(o, "reason", "params"),
	};
}

export type PermissionsApproval = Pick<
	PermissionsRequestApprovalParams,
	"threadId" | "turnId" | "itemId" | "cwd" | "reason"
> & {
	/** Granted back whole when the person allows it. */
	readonly permissions: {
		readonly network: JsonValue;
		readonly fileSystem: JsonValue;
	};
};

export function permissionsApproval(
	r: Reader,
	params: unknown,
): PermissionsApproval {
	const o = r.fields(params, "params");
	const permissions = r.fields(o["permissions"], "params.permissions");
	return {
		threadId: r.string(o, "threadId", "params"),
		turnId: r.string(o, "turnId", "params"),
		itemId: r.string(o, "itemId", "params"),
		cwd: r.string(o, "cwd", "params"),
		reason: r.nullableString(o, "reason", "params"),
		permissions: {
			network: r.json(permissions, "network"),
			fileSystem: r.json(permissions, "fileSystem"),
		},
	};
}

export type UserInputRequest = Pick<
	ToolRequestUserInputParams,
	"threadId" | "turnId" | "itemId"
> & {
	readonly questions: readonly (Pick<
		ToolRequestUserInputQuestion,
		"id" | "header" | "question" | "isOther" | "isSecret"
	> & {
		readonly options: readonly { label: string; description: string }[];
	})[];
};

export function userInputRequest(r: Reader, params: unknown): UserInputRequest {
	const o = r.fields(params, "params");
	return {
		threadId: r.string(o, "threadId", "params"),
		turnId: r.string(o, "turnId", "params"),
		itemId: r.string(o, "itemId", "params"),
		questions: r.array(o, "questions", "params", (value, path) => {
			const q = r.fields(value, path);
			return {
				id: r.string(q, "id", path),
				header: r.string(q, "header", path),
				question: r.string(q, "question", path),
				isOther: r.boolean(q, "isOther", path),
				isSecret: r.boolean(q, "isSecret", path),
				options:
					r.nullableArray(q, "options", path, (option, at) => {
						const p = r.fields(option, at);
						return {
							label: r.string(p, "label", at),
							description: r.string(p, "description", at),
						};
					}) ?? [],
			};
		}),
	};
}

export type Elicitation = Pick<
	McpServerElicitationRequestParams,
	"threadId" | "serverName"
> & {
	readonly mode: McpServerElicitationRequestParams["mode"];
	readonly message: string;
	/** The form's schema, or `{ url }` for a URL elicitation. */
	readonly schema: JsonValue;
};

export function elicitation(r: Reader, params: unknown): Elicitation {
	const o = r.fields(params, "params");
	const mode = r.oneOf(o, "mode", "params", [
		"form",
		"openai/form",
		"openaiForm",
		"url",
	]);
	return {
		threadId: r.string(o, "threadId", "params"),
		serverName: r.string(o, "serverName", "params"),
		mode,
		message: r.string(o, "message", "params"),
		schema:
			mode === "url"
				? { url: r.string(o, "url", "params") }
				: r.json(o, "requestedSchema"),
	};
}

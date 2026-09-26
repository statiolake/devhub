/**
 * Claude's stream-json lines, read into DevHub's own types.
 *
 * Written from the public headless / Agent SDK documentation and from what
 * `.spike/agent-gui/research.md` records of the wire — not from the SDK's
 * type declarations, which are proprietary. Every shape here is DevHub's
 * reading of the protocol, and stage 0's captures are what confirm it.
 *
 * # How strict
 *
 * A field DevHub uses is checked, and a line of a known type that lacks it or
 * carries it in another type throws `ProtocolMismatch` with the path. A field
 * DevHub does not use is not looked at, so the CLI adding one is not a
 * mismatch. A `type` (or `subtype`) DevHub has never heard of is not a
 * mismatch either: it decodes as `unknown`, and the adapter shows it.
 *
 * Some types DevHub knows and deliberately does not use. They decode as
 * `unused` rather than `unknown`, so that knowing them is written down here
 * and they never raise the "DevHub does not know this event" notice.
 */

import {
	type ImageRef,
	type JsonValue,
	type Question,
	type RateLimit,
	rateLimitWindowName,
} from "../../../../model/conversation.js";
import { ProtocolMismatch } from "../protocolAdapter.js";

type JsonObject = { readonly [key: string]: JsonValue };

export type ClaudeLine =
	| {
			readonly type: "control_response";
			readonly requestId: string;
			readonly outcome:
				| { readonly ok: true; readonly payload: JsonObject | undefined }
				| { readonly ok: false; readonly error: string };
	  }
	| {
			readonly type: "can_use_tool";
			readonly requestId: string;
			readonly toolName: string;
			readonly input: JsonObject;
			readonly suggestions: readonly JsonObject[];
			readonly reason: string | undefined;
			readonly toolUseId: string | undefined;
			/** AskUserQuestion's questions; undefined for every other tool. */
			readonly questions: readonly Question[] | undefined;
	  }
	/** A control request from the CLI of a subtype DevHub does not serve. */
	| {
			readonly type: "control_request_unserved";
			readonly requestId: string;
			readonly subtype: string;
			readonly raw: JsonObject;
	  }
	| { readonly type: "control_cancel_request"; readonly requestId: string }
	| {
			readonly type: "init";
			readonly sessionId: string;
			readonly cwd: string;
			readonly model: string;
			readonly permissionMode: string | undefined;
			readonly slashCommands: readonly string[];
			readonly version: string | undefined;
	  }
	| {
			readonly type: "stream";
			readonly parent: string | null;
			readonly event: StreamEvent;
	  }
	| {
			readonly type: "assistant";
			readonly parent: string | null;
			/** The message's place in the session (its record there), where a resume can cut it. */
			readonly uuid: string | undefined;
			readonly messageId: string;
			readonly content: readonly ContentBlock[];
			/** The API error the message stands for (`authentication_failed`, `rate_limit`, …). */
			readonly error: string | undefined;
			/** The model that wrote it, as the API names it. */
			readonly model: string | undefined;
			/**
			 * How much of the context window the conversation filled once this
			 * message was written: everything the request carried (fresh, cache
			 * written, cache read) and what it wrote back.
			 */
			readonly contextTokens: number | undefined;
	  }
	| {
			readonly type: "user";
			readonly parent: string | null;
			readonly uuid: string | undefined;
			readonly content: readonly UserBlock[];
			/** The tool's own account of the result a tool_result block carries. */
			readonly toolResult: ToolUseResult;
	  }
	| {
			readonly type: "result";
			readonly isError: boolean;
			readonly subtype: string;
			readonly durationMs: number | undefined;
			readonly result: string | undefined;
			readonly errors: readonly string[];
			readonly costUsd: number | undefined;
			readonly usage: ResultUsage | undefined;
			/** Each model the turn used (`modelUsage`), and the context window it has. */
			readonly contextWindows: Readonly<Record<string, number>>;
	  }
	| {
			readonly type: "api_retry";
			readonly attempt: number | undefined;
			readonly maxRetries: number | undefined;
			readonly retryDelayMs: number | undefined;
			readonly errorStatus: number | undefined;
			readonly raw: JsonObject;
	  }
	| {
			readonly type: "compact_boundary";
			readonly trigger: string | undefined;
			readonly preTokens: number | undefined;
	  }
	| { readonly type: "status"; readonly permissionMode: string | undefined }
	/** Something the CLI says to the person in so many words: a recap, a warning, a refusal. */
	| {
			readonly type: "said";
			readonly level: "info" | "warning" | "error";
			readonly text: string;
	  }
	/** A command the CLI ran itself, or what it printed, as a system event. */
	| { readonly type: "local_command"; readonly blocks: readonly UserBlock[] }
	| { readonly type: "permission_denied"; readonly raw: JsonObject }
	| {
			readonly type: "task";
			readonly subtype: string;
			readonly taskId: string | undefined;
			readonly toolUseId: string | undefined;
			readonly status: string | undefined;
			readonly text: string | undefined;
			readonly raw: JsonObject;
	  }
	| {
			readonly type: "rate_limit";
			/** Every window the event reports. */
			readonly windows: readonly RateLimit[];
	  }
	/**
	 * A message of the session this conversation resumed, put at the head of
	 * the journal by DevHub (`resume.ts`) — not something the CLI printed.
	 */
	/**
	 * The host started the CLI again on the session cut short before
	 * `message` (the person edited it), and put this line between the two
	 * CLIs' output — not something the CLI printed.
	 */
	| { readonly type: "rewind"; readonly message: string }
	/**
	 * The host started the CLI again on another session (`/resume`), and put
	 * this line between the two CLIs' output, followed by that session's past
	 * as `devhub_history` lines — not something the CLI printed.
	 */
	| { readonly type: "resume"; readonly session: string }
	| {
			readonly type: "history";
			readonly message: Extract<ClaudeLine, { type: "assistant" | "user" }>;
	  }
	| { readonly type: "unused" }
	| {
			readonly type: "unknown";
			readonly key: string;
			readonly raw: JsonObject;
	  };

export interface ResultUsage {
	readonly inputTokens: number | undefined;
	readonly outputTokens: number | undefined;
	readonly cacheReadTokens: number | undefined;
}

export type StreamEvent =
	| { readonly kind: "message_start"; readonly messageId: string }
	| {
			readonly kind: "block_start";
			readonly index: number;
			readonly block: ContentBlock;
	  }
	| { readonly kind: "delta"; readonly index: number; readonly delta: Delta }
	| { readonly kind: "message_stop" }
	| { readonly kind: "unused" }
	| {
			readonly kind: "unknown";
			readonly key: string;
			readonly raw: JsonObject;
	  };

export type Delta =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "thinking"; readonly text: string }
	| { readonly kind: "unused" }
	| {
			readonly kind: "unknown";
			readonly key: string;
			readonly raw: JsonObject;
	  };

export type ContentBlock =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "thinking"; readonly text: string }
	| {
			readonly kind: "tool_use";
			readonly id: string;
			readonly name: string;
			readonly input: JsonObject;
	  }
	| { readonly kind: "unused" }
	| {
			readonly kind: "unknown";
			readonly key: string;
			readonly raw: JsonObject;
	  };

/**
 * What a tool says of its own result (`tool_use_result`), beside the blocks
 * the model reads: an object for most tools, the error's words for a call
 * that failed, the content blocks again for an MCP tool. Only an object says
 * more than the blocks do, so the others read as `NO_TOOL_RESULT`.
 */
export interface ToolUseResult {
	/**
	 * The task the call started in the background (`status`
	 * "async_launched"): its result says only that it began, and its end
	 * arrives later as a task notification.
	 */
	readonly launchedTask: string | undefined;
	/** A command's streams, apart (Bash). */
	readonly stdout: string | undefined;
	readonly stderr: string | undefined;
	readonly interrupted: boolean;
	/**
	 * The task a command run in the background is (`backgroundTaskId`), whose
	 * end a task notification tells by that id.
	 */
	readonly backgroundTask: string | undefined;
	/** The edit a file tool made (Edit, MultiEdit, Write), as unified-diff hunks. */
	readonly patch: { readonly path: string; readonly hunks: string } | undefined;
	/** Where the CLI saved output too large for the conversation. */
	readonly persistedPath: string | undefined;
}

export const NO_TOOL_RESULT: ToolUseResult = {
	launchedTask: undefined,
	stdout: undefined,
	stderr: undefined,
	interrupted: false,
	backgroundTask: undefined,
	patch: undefined,
	persistedPath: undefined,
};

/** A block of a tool result's content. */
export type ResultPart =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "image"; readonly image: ImageRef }
	/** A tool the result made available to the model (a tool search's find). */
	| { readonly kind: "reference"; readonly name: string }
	| {
			readonly kind: "unknown";
			readonly key: string;
			readonly raw: JsonObject;
	  };

export type UserBlock =
	| { readonly kind: "text"; readonly text: string }
	/** A command the CLI ran itself: `/model sonnet`, `! ls`. */
	| { readonly kind: "command"; readonly line: string }
	/** What such a command printed. */
	| {
			readonly kind: "command_output";
			readonly output: string;
			readonly failed: boolean;
	  }
	/** An image the person put in the message. */
	| { readonly kind: "image"; readonly image: ImageRef }
	| {
			readonly kind: "task_notification";
			readonly taskId: string | undefined;
			readonly toolUseId: string | undefined;
			readonly status: string | undefined;
			readonly summary: string | undefined;
			readonly raw: JsonObject;
	  }
	| {
			readonly kind: "tool_result";
			readonly toolUseId: string;
			readonly isError: boolean;
			readonly parts: readonly ResultPart[];
	  }
	| { readonly kind: "unused" }
	| {
			readonly kind: "unknown";
			readonly key: string;
			readonly raw: JsonObject;
	  };

/** What DevHub writes, read back: the lines of `in.log`. */
export type SentLine =
	| {
			readonly type: "user";
			readonly text: string;
			readonly images: readonly ImageRef[];
			readonly origin: "person" | "injection";
	  }
	| {
			readonly type: "control_request";
			readonly requestId: string;
			readonly subtype: string;
			readonly request: JsonObject;
	  }
	| {
			readonly type: "control_response";
			readonly requestId: string;
			readonly behavior: "allow" | "deny";
	  }
	/** DevHub's refusal of a control request it does not serve. */
	| { readonly type: "control_refusal"; readonly requestId: string };

/**
 * The key DevHub adds to a user message it writes, saying who made the Agent
 * say it. The CLI does not read it; `in.log` keeps it, so the origin survives
 * a restart of DevHub.
 */
export const ORIGIN_KEY = "devhub_origin";

/** Reads fields of one line, failing with that line's path and the CLI's version. */
class Fields {
	constructor(private readonly version: string | undefined) {}

	fail(path: string, expected: string): never {
		throw new ProtocolMismatch(path, expected, this.version);
	}

	object(value: JsonValue | undefined, path: string): JsonObject {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return this.fail(path, "an object");
		}
		return value as JsonObject;
	}

	array(value: JsonValue | undefined, path: string): readonly JsonValue[] {
		if (!Array.isArray(value)) return this.fail(path, "an array");
		return value;
	}

	string(value: JsonValue | undefined, path: string): string {
		if (typeof value !== "string") return this.fail(path, "a string");
		return value;
	}

	number(value: JsonValue | undefined, path: string): number {
		if (typeof value !== "number") return this.fail(path, "a number");
		return value;
	}

	boolean(value: JsonValue | undefined, path: string): boolean {
		if (typeof value !== "boolean") return this.fail(path, "a boolean");
		return value;
	}

	optionalString(
		value: JsonValue | undefined,
		path: string,
	): string | undefined {
		return value === undefined || value === null
			? undefined
			: this.string(value, path);
	}

	optionalNumber(
		value: JsonValue | undefined,
		path: string,
	): number | undefined {
		return value === undefined || value === null
			? undefined
			: this.number(value, path);
	}

	/** `parent_tool_use_id`: present on every message, null at the top level. */
	parent(line: JsonObject, type: string): string | null {
		const value = line.parent_tool_use_id;
		return value === undefined || value === null
			? null
			: this.string(value, `${type}.parent_tool_use_id`);
	}
}

function parse(line: string, fields: Fields, side: string): JsonObject {
	let value: JsonValue;
	try {
		value = JSON.parse(line) as JsonValue;
	} catch {
		// Not JSON is itself the finding; the parser's message adds nothing
		// the path does not already say.
		return fields.fail(side, "a line of JSON");
	}
	return fields.object(value, side);
}

export function decodeReceived(
	line: string,
	version: string | undefined,
): ClaudeLine {
	const f = new Fields(version);
	const raw = parse(line, f, "line");
	const type = f.string(raw.type, "type");
	switch (type) {
		case "control_response":
			return decodeControlResponse(raw, f);
		case "control_request":
			return decodeControlRequest(raw, f);
		case "control_cancel_request":
			return {
				type: "control_cancel_request",
				requestId: f.string(
					raw.request_id,
					"control_cancel_request.request_id",
				),
			};
		case "system":
			return decodeSystem(raw, f);
		case "stream_event":
			return {
				type: "stream",
				parent: f.parent(raw, "stream_event"),
				event: decodeStreamEvent(f.object(raw.event, "stream_event.event"), f),
			};
		case "assistant":
			return decodeAssistant(raw, f);
		case "user":
			return decodeUser(raw, f);
		case "result":
			return decodeResult(raw, f);
		case "rate_limit_event":
			return decodeRateLimit(raw, f);
		case "devhub_history":
			return decodeHistory(raw, f);
		case "devhub_rewind":
			return {
				type: "rewind",
				message: f.string(raw.message, "devhub_rewind.message"),
			};
		case "devhub_resume":
			return {
				type: "resume",
				session: f.string(raw.session, "devhub_resume.session"),
			};
		// `tool_progress`: ticks of a running tool, whose entry already says it
		// runs. `prompt_suggestion`: suggested next prompts, which v1 does not
		// offer (design §3.5).
		case "tool_progress":
		case "prompt_suggestion":
			return { type: "unused" };
		default:
			return { type: "unknown", key: type, raw };
	}
}

/** A session file's message, in the shape stream-json prints the same message. */
function decodeHistory(raw: JsonObject, f: Fields): ClaudeLine {
	const record = f.object(raw.record, "devhub_history.record");
	const type = f.string(record.type, "devhub_history.record.type");
	switch (type) {
		case "assistant":
			return { type: "history", message: decodeAssistant(record, f) };
		case "user":
			return { type: "history", message: decodeUser(record, f) };
		default:
			return f.fail("devhub_history.record.type", "assistant or user");
	}
}

function decodeControlResponse(raw: JsonObject, f: Fields): ClaudeLine {
	const response = f.object(raw.response, "control_response.response");
	const requestId = f.string(
		response.request_id,
		"control_response.response.request_id",
	);
	const subtype = f.string(
		response.subtype,
		"control_response.response.subtype",
	);
	if (subtype === "success") {
		const payload = response.response;
		return {
			type: "control_response",
			requestId,
			outcome: {
				ok: true,
				payload:
					payload === undefined || payload === null
						? undefined
						: f.object(payload, "control_response.response.response"),
			},
		};
	}
	if (subtype === "error") {
		return {
			type: "control_response",
			requestId,
			outcome: {
				ok: false,
				error: f.string(response.error, "control_response.response.error"),
			},
		};
	}
	return f.fail(
		"control_response.response.subtype",
		`"success" or "error", not ${JSON.stringify(subtype)}`,
	);
}

function decodeControlRequest(raw: JsonObject, f: Fields): ClaudeLine {
	const requestId = f.string(raw.request_id, "control_request.request_id");
	const request = f.object(raw.request, "control_request.request");
	const subtype = f.string(request.subtype, "control_request.request.subtype");
	if (subtype !== "can_use_tool") {
		return { type: "control_request_unserved", requestId, subtype, raw };
	}
	const at = "control_request.request";
	const suggestions = request.permission_suggestions;
	const toolName = f.string(request.tool_name, `${at}.tool_name`);
	const input = f.object(request.input, `${at}.input`);
	return {
		type: "can_use_tool",
		requestId,
		toolName,
		input,
		questions:
			toolName === ASK_USER_QUESTION
				? decodeQuestions(input, `${at}.input`, f)
				: undefined,
		suggestions:
			suggestions === undefined || suggestions === null
				? []
				: f
						.array(suggestions, `${at}.permission_suggestions`)
						.map((each, index) =>
							f.object(each, `${at}.permission_suggestions[${index}]`),
						),
		// The reason's shape is not pinned down by any public document; a
		// sentence is shown and anything else is left to the input it is about.
		reason:
			typeof request.decision_reason === "string"
				? request.decision_reason
				: undefined,
		toolUseId: f.optionalString(request.tool_use_id, `${at}.tool_use_id`),
	};
}

/** The tool whose permission request is a set of questions for the person. */
export const ASK_USER_QUESTION = "AskUserQuestion";

/**
 * AskUserQuestion's input. Its answers are filed under each question's text,
 * so the text is the question's id.
 */
function decodeQuestions(
	input: JsonObject,
	at: string,
	f: Fields,
): readonly Question[] {
	return f.array(input.questions, `${at}.questions`).map((each, index) => {
		const path = `${at}.questions[${index}]`;
		const question = f.object(each, path);
		const text = f.string(question.question, `${path}.question`);
		return {
			id: text,
			header: f.optionalString(question.header, `${path}.header`) ?? "",
			text,
			options: f
				.array(question.options, `${path}.options`)
				.map((option, at) => {
					const read = f.object(option, `${path}.options[${at}]`);
					return {
						label: f.string(read.label, `${path}.options[${at}].label`),
						description:
							f.optionalString(
								read.description,
								`${path}.options[${at}].description`,
							) ?? "",
					};
				}),
			multiSelect:
				question.multiSelect === undefined
					? false
					: f.boolean(question.multiSelect, `${path}.multiSelect`),
			allowsOther: true,
		};
	});
}

export interface InitializeFacts {
	readonly commands: readonly {
		readonly name: string;
		readonly description: string;
		readonly argumentHint: string | undefined;
	}[];
	readonly models: readonly {
		readonly id: string;
		readonly label: string;
		/** The full model name the choice resolves to, as a session reports its model. */
		readonly resolved: string | undefined;
		/** The effort levels the model takes; none for a model without effort. */
		readonly efforts: readonly string[];
	}[];
	/** The permission mode the session is in, before any turn has said so. */
	readonly currentMode: string | undefined;
}

/** The payload of the CLI's success response to DevHub's `initialize`. */
export function decodeInitialize(
	payload: JsonObject | undefined,
	version: string | undefined,
): InitializeFacts {
	const f = new Fields(version);
	const at = "control_response(initialize).response.response";
	const body = f.object(payload, at);
	const list = (key: string) =>
		body[key] === undefined ? [] : f.array(body[key], `${at}.${key}`);
	return {
		commands: list("commands").map((each, index) => {
			const path = `${at}.commands[${index}]`;
			const command = f.object(each, path);
			const hint = f.optionalString(
				command.argumentHint,
				`${path}.argumentHint`,
			);
			return {
				name: f.string(command.name, `${path}.name`),
				description:
					f.optionalString(command.description, `${path}.description`) ?? "",
				argumentHint: hint === "" ? undefined : hint,
			};
		}),
		models: list("models").map((each, index) => {
			const path = `${at}.models[${index}]`;
			const model = f.object(each, path);
			return {
				id: f.string(model.value, `${path}.value`),
				label: f.string(model.displayName, `${path}.displayName`),
				resolved: f.optionalString(
					model.resolvedModel,
					`${path}.resolvedModel`,
				),
				efforts: (model.supportedEffortLevels === undefined
					? []
					: f.array(
							model.supportedEffortLevels,
							`${path}.supportedEffortLevels`,
						)
				).map((level, at) =>
					f.string(level, `${path}.supportedEffortLevels[${at}]`),
				),
			};
		}),
		currentMode: f.optionalString(
			body.current_permission_mode,
			`${at}.current_permission_mode`,
		),
	};
}

function decodeSystem(raw: JsonObject, f: Fields): ClaudeLine {
	const subtype = f.string(raw.subtype, "system.subtype");
	const at = `system/${subtype}`;
	switch (subtype) {
		case "init":
			return {
				type: "init",
				sessionId: f.string(raw.session_id, `${at}.session_id`),
				cwd: f.string(raw.cwd, `${at}.cwd`),
				model: f.string(raw.model, `${at}.model`),
				permissionMode: f.optionalString(
					raw.permissionMode,
					`${at}.permissionMode`,
				),
				slashCommands: (raw.slash_commands === undefined
					? []
					: f.array(raw.slash_commands, `${at}.slash_commands`)
				).map((each, index) =>
					f.string(each, `${at}.slash_commands[${index}]`),
				),
				version: f.optionalString(
					raw.claude_code_version,
					`${at}.claude_code_version`,
				),
			};
		case "api_retry":
			return {
				type: "api_retry",
				attempt: f.optionalNumber(raw.attempt, `${at}.attempt`),
				maxRetries: f.optionalNumber(raw.max_retries, `${at}.max_retries`),
				retryDelayMs: f.optionalNumber(
					raw.retry_delay_ms,
					`${at}.retry_delay_ms`,
				),
				errorStatus: f.optionalNumber(raw.error_status, `${at}.error_status`),
				raw,
			};
		case "compact_boundary": {
			const metadata =
				raw.compact_metadata === undefined
					? {}
					: f.object(raw.compact_metadata, `${at}.compact_metadata`);
			return {
				type: "compact_boundary",
				trigger: f.optionalString(
					metadata.trigger,
					`${at}.compact_metadata.trigger`,
				),
				preTokens: f.optionalNumber(
					metadata.pre_tokens,
					`${at}.compact_metadata.pre_tokens`,
				),
			};
		}
		case "status":
			return {
				type: "status",
				permissionMode: f.optionalString(
					raw.permissionMode,
					`${at}.permissionMode`,
				),
			};
		case "permission_denied":
			return { type: "permission_denied", raw };
		case "away_summary":
			return {
				type: "said",
				level: "info",
				text: `While you were away: ${f.string(raw.content, `${at}.content`)}`,
			};
		case "informational":
			return {
				type: "said",
				level: noticeLevel(raw.level, `${at}.level`, f),
				text: f.string(raw.content, `${at}.content`),
			};
		case "model_refusal_no_fallback": {
			const why = f.optionalString(
				raw.apiRefusalExplanation,
				`${at}.apiRefusalExplanation`,
			);
			return {
				type: "said",
				level: "error",
				text: `${f.string(raw.content, `${at}.content`)}${why === undefined ? "" : ` (${why})`}`,
			};
		}
		case "local_command": {
			const content = f.string(raw.content, `${at}.content`);
			return { type: "local_command", blocks: textBlock(content) };
		}
		// A stop hook's round, drawn only when a hook failed: hooks are the
		// owner's configuration (below), and one that ran well says nothing.
		case "stop_hook_summary": {
			const errors = (
				raw.hookErrors === undefined
					? []
					: f.array(raw.hookErrors, `${at}.hookErrors`)
			).map((each, index) => f.string(each, `${at}.hookErrors[${index}]`));
			return errors.length === 0
				? { type: "unused" }
				: {
						type: "said",
						level: "warning",
						text: `A stop hook failed: ${errors.join("; ")}`,
					};
		}
		case "task_started":
		case "task_progress":
		case "task_updated":
		case "task_notification":
			return {
				type: "task",
				subtype,
				taskId: f.optionalString(raw.task_id, `${at}.task_id`),
				toolUseId: f.optionalString(raw.tool_use_id, `${at}.tool_use_id`),
				status: f.optionalString(raw.status, `${at}.status`),
				text:
					f.optionalString(raw.summary, `${at}.summary`) ??
					f.optionalString(raw.description, `${at}.description`),
				raw,
			};
		// Known, and not drawn:
		// - hook_*: a hook the owner configured (SessionStart and the like)
		//   reports itself whether or not hook events were asked for; v1 does
		//   not draw hooks (design §3.5), and what a hook prints is the owner's
		//   configuration, not the conversation;
		// - thinking_tokens: an estimate of the thinking while it streams;
		// - background_tasks_changed: the set of background tasks as a whole,
		//   whose each task's lifecycle arrives as task_*;
		// - turn_duration: how long a turn took, which the transcript does not
		//   draw (a turn that completed draws nothing);
		// - bridge_status: the CLI's link to a remote control of the session,
		//   which is not the conversation and which DevHub does not offer.
		case "thinking_tokens":
		case "background_tasks_changed":
		case "turn_duration":
		case "bridge_status":
		case "hook_started":
		case "hook_progress":
		case "hook_response":
			return { type: "unused" };
		default:
			return { type: "unknown", key: `system/${subtype}`, raw };
	}
}

/** A system event's `level`, as a notice's: anything but a warning or an error is information. */
function noticeLevel(
	value: JsonValue | undefined,
	at: string,
	f: Fields,
): "info" | "warning" | "error" {
	const level = f.optionalString(value, at);
	return level === "warning" || level === "error" ? level : "info";
}

function decodeStreamEvent(event: JsonObject, f: Fields): StreamEvent {
	const type = f.string(event.type, "stream_event.event.type");
	const at = `stream_event.event(${type})`;
	switch (type) {
		case "message_start": {
			const message = f.object(event.message, `${at}.message`);
			return {
				kind: "message_start",
				messageId: f.string(message.id, `${at}.message.id`),
			};
		}
		case "content_block_start":
			return {
				kind: "block_start",
				index: f.number(event.index, `${at}.index`),
				block: decodeContentBlock(
					f.object(event.content_block, `${at}.content_block`),
					`${at}.content_block`,
					f,
				),
			};
		case "content_block_delta":
			return {
				kind: "delta",
				index: f.number(event.index, `${at}.index`),
				delta: decodeDelta(
					f.object(event.delta, `${at}.delta`),
					`${at}.delta`,
					f,
				),
			};
		case "message_stop":
			return { kind: "message_stop" };
		// The block's end is told by its complete `assistant` message; the
		// message's usage and stop reason, by the turn's `result`.
		case "content_block_stop":
		case "message_delta":
		case "ping":
			return { kind: "unused" };
		default:
			return { kind: "unknown", key: `stream_event/${type}`, raw: event };
	}
}

function decodeDelta(delta: JsonObject, at: string, f: Fields): Delta {
	const type = f.string(delta.type, `${at}.type`);
	switch (type) {
		case "text_delta":
			return { kind: "text", text: f.string(delta.text, `${at}.text`) };
		case "thinking_delta":
			return {
				kind: "thinking",
				text: f.string(delta.thinking, `${at}.thinking`),
			};
		// A tool's input arrives whole in the complete message; a thinking
		// block's signature and a text's citations are not drawn.
		case "input_json_delta":
		case "signature_delta":
		case "citations_delta":
			return { kind: "unused" };
		default:
			return { kind: "unknown", key: `delta/${type}`, raw: delta };
	}
}

function decodeContentBlock(
	block: JsonObject,
	at: string,
	f: Fields,
): ContentBlock {
	const type = f.string(block.type, `${at}.type`);
	switch (type) {
		case "text":
			return { kind: "text", text: f.string(block.text, `${at}.text`) };
		case "thinking":
			return {
				kind: "thinking",
				text: f.string(block.thinking, `${at}.thinking`),
			};
		case "tool_use":
			return {
				kind: "tool_use",
				id: f.string(block.id, `${at}.id`),
				name: f.string(block.name, `${at}.name`),
				input: f.object(block.input, `${at}.input`),
			};
		// Thinking the API withholds: there is nothing to draw.
		case "redacted_thinking":
			return { kind: "unused" };
		default:
			return { kind: "unknown", key: `content/${type}`, raw: block };
	}
}

function decodeAssistant(
	raw: JsonObject,
	f: Fields,
): Extract<ClaudeLine, { type: "assistant" }> {
	const message = f.object(raw.message, "assistant.message");
	return {
		type: "assistant",
		parent: f.parent(raw, "assistant"),
		uuid: f.optionalString(raw.uuid, "assistant.uuid"),
		messageId: f.string(message.id, "assistant.message.id"),
		content: f
			.array(message.content, "assistant.message.content")
			.map((block, index) =>
				decodeContentBlock(
					f.object(block, `assistant.message.content[${index}]`),
					`assistant.message.content[${index}]`,
					f,
				),
			),
		error: f.optionalString(raw.error, "assistant.error"),
		model: f.optionalString(message.model, "assistant.message.model"),
		contextTokens: contextTokens(message.usage, f),
	};
}

function contextTokens(
	value: JsonValue | undefined,
	f: Fields,
): number | undefined {
	if (value === undefined || value === null) return undefined;
	const usage = f.object(value, "assistant.message.usage");
	const counts = [
		"input_tokens",
		"cache_creation_input_tokens",
		"cache_read_input_tokens",
		"output_tokens",
	].map((key) =>
		f.optionalNumber(usage[key], `assistant.message.usage.${key}`),
	);
	return counts.every((count) => count === undefined)
		? undefined
		: counts.reduce<number>((sum, count) => sum + (count ?? 0), 0);
}

function contextWindows(
	value: JsonValue | undefined,
	f: Fields,
): Readonly<Record<string, number>> {
	if (value === undefined || value === null) return {};
	const models = f.object(value, "result.modelUsage");
	const windows: Record<string, number> = {};
	for (const [model, usage] of Object.entries(models)) {
		const path = `result.modelUsage.${model}`;
		const window = f.optionalNumber(
			f.object(usage, path).contextWindow,
			`${path}.contextWindow`,
		);
		if (window !== undefined) windows[model] = window;
	}
	return windows;
}

function decodeUser(
	raw: JsonObject,
	f: Fields,
): Extract<ClaudeLine, { type: "user" }> {
	const message = f.object(raw.message, "user.message");
	const content = message.content;
	return {
		type: "user",
		parent: f.parent(raw, "user"),
		uuid: f.optionalString(raw.uuid, "user.uuid"),
		content: (typeof content === "string"
			? [textBlock(content)]
			: f
					.array(content, "user.message.content")
					.map((block, index) =>
						decodeUserBlock(
							f.object(block, `user.message.content[${index}]`),
							`user.message.content[${index}]`,
							f,
						),
					)
		).flat(),
		toolResult: decodeToolUseResult(raw.tool_use_result, f),
	};
}

function decodeToolUseResult(
	value: JsonValue | undefined,
	f: Fields,
): ToolUseResult {
	// A string is the words of a call that failed, and an array an MCP
	// tool's content blocks again: both are what the tool_result block
	// already carries, and neither starts a task.
	if (
		value === undefined ||
		value === null ||
		typeof value === "string" ||
		Array.isArray(value)
	)
		return NO_TOOL_RESULT;
	const at = "user.tool_use_result";
	const result = f.object(value, at);
	const text = (key: string) => f.optionalString(result[key], `${at}.${key}`);
	const path = text("filePath");
	const hunks =
		result.structuredPatch === undefined || result.structuredPatch === null
			? []
			: f
					.array(result.structuredPatch, `${at}.structuredPatch`)
					.map((each, index) =>
						unifiedHunk(
							f.object(each, `${at}.structuredPatch[${index}]`),
							`${at}.structuredPatch[${index}]`,
							f,
						),
					);
	return {
		launchedTask:
			result.status === "async_launched"
				? f.string(result.agentId, `${at}.agentId`)
				: undefined,
		stdout: text("stdout"),
		stderr: text("stderr"),
		interrupted:
			result.interrupted === undefined
				? false
				: f.boolean(result.interrupted, `${at}.interrupted`),
		backgroundTask: text("backgroundTaskId"),
		patch:
			path === undefined || hunks.length === 0
				? undefined
				: { path, hunks: hunks.join("\n") },
		persistedPath: text("persistedOutputPath"),
	};
}

/** One hunk of a `structuredPatch`, as a unified diff writes it. */
function unifiedHunk(hunk: JsonObject, at: string, f: Fields): string {
	const n = (key: string) => f.number(hunk[key], `${at}.${key}`);
	const lines = f
		.array(hunk.lines, `${at}.lines`)
		.map((line, index) => f.string(line, `${at}.lines[${index}]`));
	return [
		`@@ -${n("oldStart")},${n("oldLines")} +${n("newStart")},${n("newLines")} @@`,
		...lines,
	].join("\n");
}

/** Whether a text is task notifications: it opens with one, bare or in a system reminder. */
export function isTaskNotificationText(text: string): boolean {
	return /^\s*(?:<system-reminder>[\s\S]*?)?<task-notification>/u.test(text);
}

const TASK_NOTIFICATION =
	/<task-notification>([\s\S]*?)<\/task-notification>/gu;

/**
 * A text the CLI put in the conversation. One made of `<task-notification>`
 * elements is not anybody's words: it is how the CLI tells the model that a
 * background task ended (a session file records it so), and each element is
 * that task's end. Whatever wraps them (a system reminder) is the model's
 * reading aid, not something to draw.
 */
function textBlock(text: string): UserBlock[] {
	const command = commandBlock(text);
	if (command !== undefined) return command;
	if (!isTaskNotificationText(text)) return [{ kind: "text", text }];
	const notifications = [...text.matchAll(TASK_NOTIFICATION)].map(
		([, body]): UserBlock => ({
			kind: "task_notification",
			taskId: notificationField(body!, "task-id"),
			toolUseId: notificationField(body!, "tool-use-id"),
			status: notificationField(body!, "status"),
			summary: notificationField(body!, "summary"),
			raw: { text },
		}),
	);
	return notifications;
}

/**
 * A text the CLI wrote of a command it ran itself, as the session file
 * records it: the command (`<command-name>` and `<command-args>`, or a
 * shell-mode `<bash-input>`), what it printed (`<local-command-stdout>` /
 * `-stderr`, `<bash-stdout>` / `-stderr`), or the caveat it puts before
 * them, which is for the model and is not drawn.
 */
function commandBlock(text: string): UserBlock[] | undefined {
	const opening = /^\s*<([a-z-]+)>/u.exec(text)?.[1];
	switch (opening) {
		case "local-command-caveat":
			return [];
		case "command-name":
		case "command-message": {
			const name = notificationField(text, "command-name") ?? "";
			const args = (notificationField(text, "command-args") ?? "").trim();
			const line = name.startsWith("/") ? name : `/${name}`;
			return [
				{ kind: "command", line: args === "" ? line : `${line} ${args}` },
			];
		}
		case "bash-input":
			return [
				{
					kind: "command",
					line: `! ${notificationField(text, "bash-input") ?? ""}`,
				},
			];
		case "local-command-stdout":
		case "local-command-stderr":
		case "bash-stdout":
		case "bash-stderr": {
			const family = opening.startsWith("bash") ? "bash" : "local-command";
			const stdout = plain(notificationField(text, `${family}-stdout`));
			const stderr = plain(notificationField(text, `${family}-stderr`));
			return [
				{
					kind: "command_output",
					output: [stdout, stderr].filter((each) => each !== "").join("\n"),
					failed: stderr !== "",
				},
			];
		}
		default:
			return undefined;
	}
}

/** A command's printout without the terminal's colours. */
function plain(text: string | undefined): string {
	// eslint-disable-next-line no-control-regex
	return (text ?? "").replace(/\u001b\[[0-9;]*m/gu, "").trim();
}

/** The first `<name>` of a notification, as written (the CLI escapes nothing it would need undone here). */
function notificationField(body: string, name: string): string | undefined {
	const start = body.indexOf(`<${name}>`);
	if (start < 0) return undefined;
	const from = start + name.length + 2;
	const end = body.indexOf(`</${name}>`, from);
	return end < 0 ? undefined : body.slice(from, end);
}

function decodeUserBlock(
	block: JsonObject,
	at: string,
	f: Fields,
): UserBlock | UserBlock[] {
	const type = f.string(block.type, `${at}.type`);
	switch (type) {
		case "text":
			return textBlock(f.string(block.text, `${at}.text`));
		case "tool_result":
			return {
				kind: "tool_result",
				toolUseId: f.string(block.tool_use_id, `${at}.tool_use_id`),
				isError:
					block.is_error === undefined
						? false
						: f.boolean(block.is_error, `${at}.is_error`),
				parts: toolResultParts(block.content, `${at}.content`, f),
			};
		case "image":
			return { kind: "image", image: decodeImage(block, at, f) };
		default:
			return { kind: "unknown", key: `content/${type}`, raw: block };
	}
}

/** A tool result's content: a string, or blocks, each read as a message's blocks are. */
function toolResultParts(
	content: JsonValue | undefined,
	at: string,
	f: Fields,
): readonly ResultPart[] {
	if (content === undefined || content === null) return [];
	if (typeof content === "string") return [{ kind: "text", text: content }];
	return f.array(content, at).map((each, index): ResultPart => {
		const path = `${at}[${index}]`;
		const block = f.object(each, path);
		const type = f.string(block.type, `${path}.type`);
		switch (type) {
			case "text":
				return { kind: "text", text: f.string(block.text, `${path}.text`) };
			case "image":
				return { kind: "image", image: decodeImage(block, path, f) };
			case "tool_reference":
				return {
					kind: "reference",
					name: f.string(block.tool_name, `${path}.tool_name`),
				};
			default:
				return { kind: "unknown", key: `tool_result/${type}`, raw: block };
		}
	});
}

/** An image block: its pixels inline (base64), or where they are (url). */
function decodeImage(block: JsonObject, at: string, f: Fields): ImageRef {
	const source = f.object(block.source, `${at}.source`);
	const type = f.string(source.type, `${at}.source.type`);
	switch (type) {
		case "base64":
			return {
				mediaType: f.string(source.media_type, `${at}.source.media_type`),
				source: {
					kind: "data",
					base64: f.string(source.data, `${at}.source.data`),
				},
				label: "image",
			};
		case "url": {
			const url = f.string(source.url, `${at}.source.url`);
			return {
				mediaType: "image/*",
				source: { kind: "url", url },
				label: url,
			};
		}
		// An image the API's file store holds: named by its id, not drawable here.
		case "file": {
			const id = f.string(source.file_id, `${at}.source.file_id`);
			return {
				mediaType: "image/*",
				source: { kind: "file", path: id },
				label: id,
			};
		}
		default:
			return f.fail(
				`${at}.source.type`,
				`"base64", "url" or "file", not ${JSON.stringify(type)}`,
			);
	}
}

function decodeResult(raw: JsonObject, f: Fields): ClaudeLine {
	const usage =
		raw.usage === undefined || raw.usage === null
			? undefined
			: f.object(raw.usage, "result.usage");
	return {
		type: "result",
		isError: f.boolean(raw.is_error, "result.is_error"),
		subtype: f.string(raw.subtype, "result.subtype"),
		durationMs: f.optionalNumber(raw.duration_ms, "result.duration_ms"),
		result: f.optionalString(raw.result, "result.result"),
		errors: (raw.errors === undefined
			? []
			: f.array(raw.errors, "result.errors")
		).map((each, index) => f.string(each, `result.errors[${index}]`)),
		costUsd: f.optionalNumber(raw.total_cost_usd, "result.total_cost_usd"),
		contextWindows: contextWindows(raw.modelUsage, f),
		usage:
			usage === undefined
				? undefined
				: {
						inputTokens: f.optionalNumber(
							usage.input_tokens,
							"result.usage.input_tokens",
						),
						outputTokens: f.optionalNumber(
							usage.output_tokens,
							"result.usage.output_tokens",
						),
						cacheReadTokens: f.optionalNumber(
							usage.cache_read_input_tokens,
							"result.usage.cache_read_input_tokens",
						),
					},
	};
}

/**
 * A `rate_limit_event`. The CLI reports every window it tracks under
 * `unifiedWindows`, keyed by its name (`five_hour`, `seven_day`, …); the
 * top-level fields repeat one of them, named by `rateLimitType`. An event
 * without `unifiedWindows` reports that one window alone.
 */
function decodeRateLimit(raw: JsonObject, f: Fields): ClaudeLine {
	const at = "rate_limit_event.rate_limit_info";
	const info = f.object(raw.rate_limit_info, at);
	// The limiting window is named only when the CLI knows it
	// (`rateLimitType` is optional): an event that names none says nothing
	// about any one window.
	const limiting = f.optionalString(info.rateLimitType, `${at}.rateLimitType`);
	const windows =
		info.unifiedWindows === undefined
			? limiting === undefined
				? []
				: [[limiting, info, at] as const]
			: Object.entries(
					f.object(info.unifiedWindows, `${at}.unifiedWindows`),
				).map(([key, value]) => {
					const path = `${at}.unifiedWindows.${key}`;
					return [key, f.object(value, path), path] as const;
				});
	return {
		type: "rate_limit",
		windows: windows.map(([key, window, path]) => {
			const utilization = f.optionalNumber(
				window.utilization,
				`${path}.utilization`,
			);
			const resetsAt = f.optionalNumber(window.resetsAt, `${path}.resetsAt`);
			return {
				window: claudeWindowName(key),
				// A fraction on the wire; a percentage in the model.
				usedPercent: utilization === undefined ? undefined : utilization * 100,
				// Epoch seconds on the wire; milliseconds in the model.
				resetsAt: resetsAt === undefined ? undefined : resetsAt * 1000,
			};
		}),
	};
}

/** The windows whose length the name says, named as Codex's are; any other by its own name. */
const CLAUDE_WINDOW_MINUTES: Readonly<Record<string, number>> = {
	five_hour: 5 * 60,
	seven_day: 7 * 24 * 60,
};

function claudeWindowName(key: string): string {
	const minutes = CLAUDE_WINDOW_MINUTES[key];
	return minutes === undefined
		? key.replaceAll("_", " ")
		: rateLimitWindowName(minutes);
}

/**
 * A line of `in.log`. DevHub wrote every one of them, so a line of any other
 * shape is not the CLI's doing and not a version skew: it is DevHub's own
 * writer and reader disagreeing.
 */
export function decodeSent(line: string): SentLine {
	const f = new Fields(undefined);
	const raw = parse(line, f, "sent line");
	const type = f.string(raw.type, "sent line.type");
	switch (type) {
		case "user": {
			const message = f.object(raw.message, "sent user.message");
			const origin = f.string(raw[ORIGIN_KEY], `sent user.${ORIGIN_KEY}`);
			if (origin !== "person" && origin !== "injection") {
				return f.fail(`sent user.${ORIGIN_KEY}`, `"person" or "injection"`);
			}
			const content = message.content;
			if (typeof content === "string")
				return { type: "user", text: content, images: [], origin };
			const blocks = f
				.array(content, "sent user.message.content")
				.map((each, index): { text: string } | { image: ImageRef } => {
					const at = `sent user.message.content[${index}]`;
					const block = f.object(each, at);
					switch (f.string(block.type, `${at}.type`)) {
						case "text":
							return { text: f.string(block.text, `${at}.text`) };
						case "image":
							return { image: decodeImage(block, at, f) };
						default:
							return f.fail(`${at}.type`, `"text" or "image"`);
					}
				});
			return {
				type: "user",
				text: blocks
					.flatMap((each) => ("text" in each ? [each.text] : []))
					.join("\n"),
				images: blocks.flatMap((each) => ("image" in each ? [each.image] : [])),
				origin,
			};
		}
		case "control_request": {
			const request = f.object(raw.request, "sent control_request.request");
			return {
				type: "control_request",
				requestId: f.string(raw.request_id, "sent control_request.request_id"),
				subtype: f.string(
					request.subtype,
					"sent control_request.request.subtype",
				),
				request,
			};
		}
		case "control_response": {
			const response = f.object(raw.response, "sent control_response.response");
			const requestId = f.string(
				response.request_id,
				"sent control_response.response.request_id",
			);
			if (
				f.string(response.subtype, "sent control_response.response.subtype") ===
				"error"
			) {
				return { type: "control_refusal", requestId };
			}
			const inner = f.object(
				response.response,
				"sent control_response.response.response",
			);
			const behavior = f.string(
				inner.behavior,
				"sent control_response.response.response.behavior",
			);
			if (behavior !== "allow" && behavior !== "deny") {
				return f.fail(
					"sent control_response.response.response.behavior",
					`"allow" or "deny"`,
				);
			}
			return { type: "control_response", requestId, behavior };
		}
		default:
			return f.fail(
				"sent line.type",
				`a line DevHub writes, not ${JSON.stringify(type)}`,
			);
	}
}

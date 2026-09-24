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

import type { JsonValue, Question } from "../../../../model/conversation.js";
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
			readonly messageId: string;
			readonly content: readonly ContentBlock[];
			/** The API error the message stands for (`authentication_failed`, `rate_limit`, …). */
			readonly error: string | undefined;
	  }
	| {
			readonly type: "user";
			readonly parent: string | null;
			readonly uuid: string | undefined;
			readonly content: readonly UserBlock[];
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
	| { readonly type: "permission_denied"; readonly raw: JsonObject }
	| {
			readonly type: "task";
			readonly subtype: string;
			readonly toolUseId: string | undefined;
			readonly status: string | undefined;
			readonly text: string | undefined;
			readonly raw: JsonObject;
	  }
	| {
			readonly type: "rate_limit";
			readonly usedPercent: number | undefined;
			readonly resetsAt: number | undefined;
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

export type UserBlock =
	| { readonly kind: "text"; readonly text: string }
	| {
			readonly kind: "tool_result";
			readonly toolUseId: string;
			readonly isError: boolean;
			readonly text: string;
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
	readonly models: readonly { readonly id: string; readonly label: string }[];
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
			};
		}),
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
		case "task_started":
		case "task_progress":
		case "task_updated":
		case "task_notification":
			return {
				type: "task",
				subtype,
				toolUseId: f.optionalString(raw.tool_use_id, `${at}.tool_use_id`),
				status: f.optionalString(raw.status, `${at}.status`),
				text:
					f.optionalString(raw.summary, `${at}.summary`) ??
					f.optionalString(raw.description, `${at}.description`),
				raw,
			};
		default:
			return { type: "unknown", key: `system/${subtype}`, raw };
	}
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

function decodeAssistant(raw: JsonObject, f: Fields): ClaudeLine {
	const message = f.object(raw.message, "assistant.message");
	return {
		type: "assistant",
		parent: f.parent(raw, "assistant"),
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
	};
}

function decodeUser(raw: JsonObject, f: Fields): ClaudeLine {
	const message = f.object(raw.message, "user.message");
	const content = message.content;
	return {
		type: "user",
		parent: f.parent(raw, "user"),
		uuid: f.optionalString(raw.uuid, "user.uuid"),
		content:
			typeof content === "string"
				? [{ kind: "text", text: content }]
				: f
						.array(content, "user.message.content")
						.map((block, index) =>
							decodeUserBlock(
								f.object(block, `user.message.content[${index}]`),
								`user.message.content[${index}]`,
								f,
							),
						),
	};
}

function decodeUserBlock(block: JsonObject, at: string, f: Fields): UserBlock {
	const type = f.string(block.type, `${at}.type`);
	switch (type) {
		case "text":
			return { kind: "text", text: f.string(block.text, `${at}.text`) };
		case "tool_result":
			return {
				kind: "tool_result",
				toolUseId: f.string(block.tool_use_id, `${at}.tool_use_id`),
				isError:
					block.is_error === undefined
						? false
						: f.boolean(block.is_error, `${at}.is_error`),
				text: toolResultText(block.content, `${at}.content`, f),
			};
		// Images are not drawn in v1 (design §3.5).
		case "image":
			return { kind: "unused" };
		default:
			return { kind: "unknown", key: `content/${type}`, raw: block };
	}
}

/** A tool result is a string, or blocks of which the text ones are drawn. */
function toolResultText(
	content: JsonValue | undefined,
	at: string,
	f: Fields,
): string {
	if (content === undefined || content === null) return "";
	if (typeof content === "string") return content;
	return f
		.array(content, at)
		.flatMap((block, index) => {
			const each = f.object(block, `${at}[${index}]`);
			return f.string(each.type, `${at}[${index}].type`) === "text"
				? [f.string(each.text, `${at}[${index}].text`)]
				: [];
		})
		.join("\n");
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

function decodeRateLimit(raw: JsonObject, f: Fields): ClaudeLine {
	const info = f.object(
		raw.rate_limit_info,
		"rate_limit_event.rate_limit_info",
	);
	const utilization = f.optionalNumber(
		info.utilization,
		"rate_limit_event.rate_limit_info.utilization",
	);
	const resetsAt = f.optionalNumber(
		info.resetsAt,
		"rate_limit_event.rate_limit_info.resetsAt",
	);
	return {
		type: "rate_limit",
		// A fraction on the wire; a percentage in the model.
		usedPercent: utilization === undefined ? undefined : utilization * 100,
		// Epoch seconds on the wire; milliseconds in the model.
		resetsAt: resetsAt === undefined ? undefined : resetsAt * 1000,
	};
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
			return {
				type: "user",
				text: f.string(message.content, "sent user.message.content"),
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

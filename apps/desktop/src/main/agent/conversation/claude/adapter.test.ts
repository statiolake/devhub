/**
 * Claude's stream-json, read into the normalized conversation and written
 * back from DevHub's commands.
 *
 * The two fixtures are whole turns in the order the lines happened; the rest
 * are single lines around a state built from them. The fixtures are
 * hand-written from the documented shapes (their headers say so) until stage
 * 0 puts captures of a real CLI beside them.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	childrenOf,
	conversationStatus,
	entryId,
	requestId,
	rewindTargets,
	type ConversationEvent,
	type NoticeEntry,
	type ToolEntry,
	type TranscriptEntry,
	type UserEntry,
} from "../../../../model/conversation.js";
import {
	ProtocolMismatch,
	type ConversationCommand,
} from "../protocolAdapter.js";
import { claudeHistoryLines } from "../resume.js";
import { ClaudeAdapter } from "./adapter.js";

const FIXTURES = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"fixtures",
);

interface FixtureLine {
	readonly side: "sent" | "received";
	readonly line: string;
}

function fixture(name: string): readonly FixtureLine[] {
	return readFileSync(join(FIXTURES, name), "utf8")
		.split("\n")
		.filter((text) => text !== "" && !text.startsWith("#"))
		.map((text) => {
			if (text.startsWith("> ")) return { side: "sent", line: text.slice(2) };
			if (text.startsWith("< "))
				return { side: "received", line: text.slice(2) };
			throw new Error(
				`fixture ${name} has a line that is neither "> " nor "< ": ${text}`,
			);
		});
}

function play(
	adapter: ClaudeAdapter,
	lines: readonly FixtureLine[],
): ConversationEvent[] {
	const events: ConversationEvent[] = [];
	for (const { side, line } of lines) {
		const step = side === "sent" ? adapter.sent(line) : adapter.received(line);
		events.push(...step.events);
	}
	return events;
}

function json(value: unknown): string {
	return JSON.stringify(value);
}

/** Choose a setting, and write whatever lines it takes, as the caller does. */
function configure(
	adapter: ClaudeAdapter,
	which: "model" | "effort" | "mode",
	id: string,
): readonly string[] {
	const step = adapter.configure(which, id);
	for (const line of step.replies) adapter.sent(line);
	return step.replies;
}

/** Send what `encode` makes of a command, as the caller does once the write succeeds. */
function perform(
	adapter: ClaudeAdapter,
	command: ConversationCommand,
): readonly string[] {
	const lines = adapter.encode(command);
	for (const line of lines) adapter.sent(line);
	return lines;
}

function entry(adapter: ClaudeAdapter, id: string): TranscriptEntry {
	const found = adapter.transcript.entries.find((each) => each.id === id);
	if (found === undefined) {
		throw new Error(
			`no entry ${id}; have ${adapter.transcript.entries.map((each) => each.id).join(", ")}`,
		);
	}
	return found;
}

const SESSION = "00000000-0000-4000-8000-000000000009";

function init(fields: Record<string, unknown> = {}): string {
	return json({
		type: "system",
		subtype: "init",
		session_id: SESSION,
		cwd: "/home/testuser/project",
		model: "claude-sonnet-5",
		permissionMode: "default",
		slash_commands: [
			"review",
			"model",
			"effort",
			"permissions",
			"login",
			"logout",
		],
		claude_code_version: "2.1.0",
		...fields,
	});
}

function echo(text: string, uuid: string): string {
	return json({
		type: "user",
		message: { role: "user", content: text },
		parent_tool_use_id: null,
		session_id: SESSION,
		uuid,
	});
}

function assistantLine(
	messageId: string,
	content: unknown[],
	parent: string | null = null,
	extra: Record<string, unknown> = {},
): string {
	return json({
		type: "assistant",
		message: { id: messageId, role: "assistant", content },
		parent_tool_use_id: parent,
		session_id: SESSION,
		...extra,
	});
}

function toolUse(
	id: string,
	name: string,
	input: Record<string, unknown>,
): unknown {
	return { type: "tool_use", id, name, input };
}

function toolResult(
	toolUseId: string,
	content: string,
	isError = false,
): string {
	return json({
		type: "user",
		message: {
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: toolUseId,
					content,
					is_error: isError,
				},
			],
		},
		parent_tool_use_id: null,
		session_id: SESSION,
	});
}

function stream(event: unknown, parent: string | null = null): string {
	return json({
		type: "stream_event",
		event,
		parent_tool_use_id: parent,
		session_id: SESSION,
	});
}

function canUseTool(id: string, request: Record<string, unknown>): string {
	return json({
		type: "control_request",
		request_id: id,
		request: { subtype: "can_use_tool", ...request },
	});
}

function result(fields: Record<string, unknown> = {}): string {
	return json({
		type: "result",
		subtype: "success",
		is_error: false,
		duration_ms: 100,
		result: "done",
		session_id: SESSION,
		total_cost_usd: 0.5,
		usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
		...fields,
	});
}

/** An adapter past the handshake, in a turn started by "go". */
function inTurn(): ClaudeAdapter {
	const adapter = new ClaudeAdapter("boot");
	adapter.received(init());
	perform(adapter, { kind: "send", text: "go", origin: "person" });
	adapter.received(echo("go", "u-go"));
	return adapter;
}

/** `inTurn`, with a Bash call whose permission request `perm` is pending. */
function askingForBash(): ClaudeAdapter {
	const adapter = inTurn();
	adapter.received(
		assistantLine("msg_1", [
			toolUse("toolu_1", "Bash", { command: "rm -rf build" }),
		]),
	);
	adapter.received(
		canUseTool("perm", {
			tool_name: "Bash",
			input: { command: "rm -rf build" },
			tool_use_id: "toolu_1",
			decision_reason: "rm is not in the allow list",
			permission_suggestions: [
				{
					type: "addRules",
					rules: [{ toolName: "Bash", ruleContent: "rm -rf build" }],
					behavior: "allow",
					destination: "localSettings",
				},
				{ type: "setMode", mode: "acceptEdits", destination: "session" },
			],
		}),
	);
	return adapter;
}

describe("the handshake", () => {
	it("opens with an initialize request named by this boot of DevHub", () => {
		const adapter = new ClaudeAdapter("boot-a");
		expect(adapter.opening().map((line) => JSON.parse(line))).toEqual([
			{
				type: "control_request",
				request_id: "boot-a:1",
				request: { subtype: "initialize" },
			},
		]);
	});

	it("writes the same lines the permission fixture recorded", () => {
		const adapter = new ClaudeAdapter("boot-a");
		const recorded = fixture("claude-permission-turn.ndjson").filter(
			(each) => each.side === "sent",
		);
		expect(adapter.opening()).toEqual([recorded[0]!.line]);
	});

	it("is connecting until the CLI says it is up", () => {
		const adapter = new ClaudeAdapter("boot");
		expect(adapter.transcript.state).toEqual({ phase: "connecting" });
		adapter.received(init());
		expect(adapter.transcript.state).toEqual({ phase: "ready", turn: "none" });
	});

	it("is ready on the initialize response too, whichever comes first", () => {
		const fresh = new ClaudeAdapter("boot");
		for (const line of fresh.opening()) fresh.sent(line);
		fresh.received(
			json({
				type: "control_response",
				response: {
					subtype: "success",
					request_id: "boot:1",
					response: { commands: [], models: [] },
				},
			}),
		);
		expect(fresh.transcript.state).toEqual({ phase: "ready", turn: "none" });
	});

	it("learns the session from system/init: id, cwd, model, mode, version and commands", () => {
		const adapter = new ClaudeAdapter("boot");
		adapter.received(init());
		const { session } = adapter.transcript;
		expect(session.sessionId).toBe(SESSION);
		expect(session.cwd).toBe("/home/testuser/project");
		expect(session.agentVersion).toBe("2.1.0");
		expect(session.model.current).toBe("claude-sonnet-5");
		expect(session.mode.current).toBe("default");
		expect(session.mode.choices.map((each) => each.id)).toContain(
			"acceptEdits",
		);
		expect(session.commands).toEqual([
			{
				name: "review",
				description: "",
				argumentHint: undefined,
				route: "message",
			},
			{
				name: "model",
				description: "",
				argumentHint: undefined,
				route: "model",
			},
			{
				name: "effort",
				description: "",
				argumentHint: undefined,
				route: "effort",
			},
			{
				name: "permissions",
				description: "",
				argumentHint: undefined,
				route: "mode",
			},
			{
				name: "resume",
				description: "Go on with an earlier session in this Workspace",
				argumentHint: undefined,
				route: "resume",
			},
		]);
	});
});

describe("the permission fixture", () => {
	const lines = fixture("claude-permission-turn.ndjson");

	function played(): ClaudeAdapter {
		const adapter = new ClaudeAdapter("boot-a");
		play(adapter, lines);
		return adapter;
	}

	it("ends in one idle transcript: the message, the thinking and text, the tool, the answer, the turn", () => {
		const adapter = played();
		expect(adapter.transcript.entries).toEqual([
			{
				kind: "user",
				id: "user:00000000-0000-4000-8000-0000000000a1",
				parent: null,
				text: "Run pwd with Bash",
				images: [],
				origin: "person",
				rewindable: true,
			},
			{
				kind: "assistant",
				id: "assistant:msg_01:0",
				parent: null,
				blocks: [
					{ kind: "thinking", text: "The user wants pwd." },
					{ kind: "text", markdown: "I'll run `pwd`." },
				],
				streaming: false,
			},
			{
				kind: "tool",
				id: "tool:toolu_01",
				parent: null,
				tool: "Bash",
				title: "Bash: pwd",
				input: { command: "pwd", description: "Print the working directory" },
				status: "succeeded",
				output: {
					kind: "text",
					text: "/home/testuser/project",
					truncated: false,
				},
				spawns: undefined,
			},
			{
				kind: "assistant",
				id: "assistant:msg_02:0",
				parent: null,
				blocks: [
					{ kind: "text", markdown: "You are in `/home/testuser/project`." },
				],
				streaming: false,
			},
			{
				kind: "turn-end",
				id: "turn:1",
				outcome: "completed",
				detail: undefined,
				usage: {
					inputTokens: 1500,
					outputTokens: 80,
					cachedInputTokens: 1200,
					contextTokens: undefined,
					contextWindow: undefined,
					costUsd: 0.0123,
					rateLimits: [
						{ window: "5-hour", usedPercent: 25, resetsAt: 1_800_000_000_000 },
					],
				},
				durationMs: 4210,
			},
		]);
		expect(adapter.transcript.requests).toEqual([]);
		expect(adapter.transcript.state).toEqual({ phase: "ready", turn: "none" });
		expect(conversationStatus(adapter.transcript)).toBe("idle");
	});

	it("carries the commands and models the initialize response listed, without the sign-in ones", () => {
		const { session } = played().transcript;
		expect(session.commands).toEqual([
			{
				name: "review",
				description: "Review a pull request",
				argumentHint: "<pr>",
				route: "message",
			},
			{
				name: "model",
				description: "Set the AI model",
				argumentHint: undefined,
				route: "model",
			},
			{
				name: "compact",
				description: "Compact the conversation",
				argumentHint: "[instructions]",
				route: "message",
			},
			{
				name: "init",
				description: "",
				argumentHint: undefined,
				route: "message",
			},
			{
				name: "resume",
				description: "Go on with an earlier session in this Workspace",
				argumentHint: undefined,
				route: "resume",
			},
		]);
		expect(session.model).toEqual({
			current: "claude-sonnet-5",
			choices: [
				{ id: "default", label: "Default" },
				{ id: "sonnet", label: "Sonnet" },
			],
		});
	});

	it("keeps the usage of the conversation: cost, tokens and the rate limit", () => {
		expect(played().transcript.usage).toEqual({
			inputTokens: 1500,
			outputTokens: 80,
			cachedInputTokens: 1200,
			contextTokens: undefined,
			contextWindow: undefined,
			costUsd: 0.0123,
			rateLimits: [
				{ window: "5-hour", usedPercent: 25, resetsAt: 1_800_000_000_000 },
			],
		});
	});

	it("streams the assistant message block by block before it is final", () => {
		const adapter = new ClaudeAdapter("boot-a");
		const upToSecondDelta = lines.findIndex((each) =>
			each.line.includes('`pwd`."}}'),
		);
		play(adapter, lines.slice(0, upToSecondDelta + 1));
		expect(entry(adapter, "assistant:msg_01:0")).toEqual({
			kind: "assistant",
			id: "assistant:msg_01:0",
			parent: null,
			blocks: [
				{ kind: "thinking", text: "The user wants pwd." },
				{ kind: "text", markdown: "I'll run `pwd`." },
			],
			streaming: true,
		});
		expect(adapter.transcript.state).toEqual({
			phase: "ready",
			turn: "running",
		});
		expect(conversationStatus(adapter.transcript)).toBe("working");
	});

	it("sends the text of a delta as a delta, not as the whole message again", () => {
		const adapter = new ClaudeAdapter("boot-a");
		const events = play(adapter, lines);
		expect(events).toContainEqual({
			type: "text-delta",
			entry: entryId("assistant:msg_01:0"),
			block: 1,
			text: "I'll run ",
		});
	});

	it("shows the tool running from the moment its block starts", () => {
		const adapter = new ClaudeAdapter("boot-a");
		const toolStart = lines.findIndex((each) =>
			each.line.includes('"content_block_start","index":2'),
		);
		play(adapter, lines.slice(0, toolStart + 1));
		expect(entry(adapter, "tool:toolu_01")).toMatchObject({
			status: "running",
			title: "Bash",
			input: {},
		});
	});

	it("waits on the permission request, about the tool it names, until DevHub answers", () => {
		const adapter = new ClaudeAdapter("boot-a");
		const asked = lines.findIndex((each) => each.line.includes("can_use_tool"));
		play(adapter, lines.slice(0, asked + 1));
		expect(adapter.transcript.requests).toEqual([
			{
				id: requestId("perm-1"),
				entry: entryId("tool:toolu_01"),
				subject: {
					kind: "tool",
					tool: "Bash",
					title: "Bash: pwd",
					input: { command: "pwd", description: "Print the working directory" },
					reason: undefined,
				},
				choices: [
					{ id: "allow", label: "Allow once", tone: "allow", takesText: false },
					{
						id: "suggestion:0",
						label: "Always allow Bash(pwd)",
						tone: "allow",
						takesText: false,
					},
					{ id: "deny", label: "Deny", tone: "deny", takesText: true },
				],
			},
		]);
		expect(conversationStatus(adapter.transcript)).toBe("waiting");

		const answer = adapter.encode({
			kind: "answer",
			request: requestId("perm-1"),
			answer: { kind: "choice", choiceId: "allow", text: undefined },
		});
		expect(answer).toEqual([lines[asked + 1]!.line]);
		expect(adapter.transcript.requests).toHaveLength(1);
		adapter.sent(answer[0]!);
		expect(adapter.transcript.requests).toEqual([]);
	});

	it("writes the user message the fixture recorded", () => {
		const adapter = new ClaudeAdapter("boot-a");
		expect(
			adapter.encode({
				kind: "send",
				text: "Run pwd with Bash",
				origin: "person",
			}),
		).toEqual([
			lines.find(
				(each) => each.side === "sent" && each.line.includes('"type":"user"'),
			)!.line,
		]);
	});

	it("folds to the same transcript whether replayed or followed live", () => {
		const live = new ClaudeAdapter("boot-a");
		const liveEvents = play(live, lines);
		const replayed = new ClaudeAdapter("boot-b");
		play(replayed, lines);
		expect(replayed.transcript).toEqual(live.transcript);
		expect(liveEvents.length).toBeGreaterThan(0);
	});
});

describe("the subagent fixture", () => {
	function played(): ClaudeAdapter {
		const adapter = new ClaudeAdapter("boot");
		play(adapter, fixture("claude-subagent-turn.ndjson"));
		return adapter;
	}

	it("hangs the subagent's messages and tools under the Task call that started it", () => {
		const { transcript } = played();
		expect(childrenOf(transcript, null).map((each) => each.id)).toEqual([
			"user:00000000-0000-4000-8000-0000000000c1",
			"tool:toolu_task",
			"assistant:msg_11:0",
			"turn:1",
		]);
		expect(
			childrenOf(transcript, entryId("tool:toolu_task")).map((each) => each.id),
		).toEqual(["assistant:msg_s1:0", "tool:toolu_grep", "assistant:msg_s2:0"]);
	});

	it("describes the subagent on the Task call and follows its lifecycle", () => {
		const adapter = played();
		expect(entry(adapter, "tool:toolu_task")).toMatchObject({
			tool: "Task",
			title: "Task: Find the reducer",
			status: "succeeded",
			spawns: {
				label: "Explore",
				prompt: "Look for applyEvent",
				model: "haiku",
				state: "completed",
			},
		});
		expect(entry(adapter, "tool:toolu_grep")).toMatchObject({
			parent: "tool:toolu_task",
			title: "Grep: applyEvent",
			status: "succeeded",
			output: {
				kind: "text",
				text: "src/model/conversation.ts",
				truncated: false,
			},
		});
	});

	it("marks the subagent running while its task runs", () => {
		const adapter = new ClaudeAdapter("boot");
		const lines = fixture("claude-subagent-turn.ndjson");
		play(
			adapter,
			lines.slice(
				0,
				lines.findIndex((each) => each.line.includes("task_started")) + 1,
			),
		);
		expect((entry(adapter, "tool:toolu_task") as ToolEntry).spawns?.state).toBe(
			"running",
		);
	});

	it("keeps the origin DevHub wrote: this message was an injection", () => {
		expect(
			entry(played(), "user:00000000-0000-4000-8000-0000000000c1"),
		).toMatchObject({
			origin: "injection",
			text: "Find the reducer",
		});
	});

	it("does not repeat the subagent's prompt as a user message: the Task call carries it", () => {
		const users = played().transcript.entries.filter(
			(each) => each.kind === "user",
		);
		expect(users).toHaveLength(1);
	});

	it("takes the mode system/init reports", () => {
		expect(played().transcript.session.mode.current).toBe("acceptEdits");
	});
});

describe("context usage", () => {
	function withUsage(
		messageId: string,
		parent: string | null,
		model: string,
		usage: Record<string, number>,
	): string {
		return json({
			type: "assistant",
			message: {
				id: messageId,
				role: "assistant",
				model,
				content: [{ type: "text", text: "ok" }],
				usage,
			},
			parent_tool_use_id: parent,
			session_id: SESSION,
		});
	}

	it("is the latest top-level message's tokens, against the window the turn's result names for its model", () => {
		const adapter = inTurn();
		adapter.received(
			withUsage("m1", null, "claude-example-1", {
				input_tokens: 10,
				cache_creation_input_tokens: 1000,
				cache_read_input_tokens: 20_000,
				output_tokens: 90,
			}),
		);
		// Known as soon as the message is: before the turn has ended.
		expect(adapter.transcript.usage?.contextTokens).toBe(21_100);
		expect(adapter.transcript.usage?.contextWindow).toBeUndefined();
		adapter.received(
			result({
				modelUsage: {
					"claude-example-1": { contextWindow: 200_000 },
					"claude-example-small": { contextWindow: 100_000 },
				},
			}),
		);
		expect(adapter.transcript.usage).toMatchObject({
			contextTokens: 21_100,
			contextWindow: 200_000,
		});
	});
});

describe("user messages", () => {
	it("write the text as a stream-json user message, marked with who made the Agent say it", () => {
		const adapter = new ClaudeAdapter("boot");
		const [line] = adapter.encode({
			kind: "send",
			text: "/review 12",
			origin: "injection",
		});
		expect(JSON.parse(line!)).toEqual({
			type: "user",
			message: { role: "user", content: "/review 12" },
			parent_tool_use_id: null,
			session_id: "",
			devhub_origin: "injection",
		});
	});

	it("appear when the CLI takes them, and the turn starts then", () => {
		const adapter = new ClaudeAdapter("boot");
		adapter.received(init());
		perform(adapter, { kind: "send", text: "hello", origin: "person" });
		expect(adapter.transcript.entries).toEqual([]);
		expect(adapter.transcript.state).toEqual({ phase: "ready", turn: "none" });
		adapter.received(echo("hello", "u1"));
		expect(entry(adapter, "user:u1")).toMatchObject({
			text: "hello",
			origin: "person",
		});
		expect(adapter.transcript.state).toEqual({
			phase: "ready",
			turn: "running",
		});
	});

	it("are matched to what DevHub sent in order, so each keeps its own origin", () => {
		const adapter = new ClaudeAdapter("boot");
		adapter.received(init());
		perform(adapter, { kind: "send", text: "same", origin: "injection" });
		perform(adapter, { kind: "send", text: "same", origin: "person" });
		adapter.received(echo("same", "u1"));
		adapter.received(echo("same", "u2"));
		expect((entry(adapter, "user:u1") as UserEntry).origin).toBe("injection");
		expect((entry(adapter, "user:u2") as UserEntry).origin).toBe("person");
	});

	it("that DevHub did not send are shown as what the CLI said, not as the person's words", () => {
		const adapter = inTurn();
		adapter.received(echo("[Request interrupted by user]", "u9"));
		const notice = adapter.transcript.entries.at(-1) as NoticeEntry;
		expect(notice).toMatchObject({
			kind: "notice",
			level: "info",
			text: "[Request interrupted by user]",
		});
	});
});

describe("tool calls", () => {
	it("end failed when the result is an error", () => {
		const adapter = inTurn();
		adapter.received(
			assistantLine("m", [
				toolUse("toolu_1", "Read", { file_path: "src/x.ts" }),
			]),
		);
		adapter.received(toolResult("toolu_1", "File does not exist.", true));
		expect(entry(adapter, "tool:toolu_1")).toMatchObject({
			title: "Read: src/x.ts",
			status: "failed",
			output: { kind: "text", text: "File does not exist.", truncated: false },
		});
	});

	it("refuse a result for a tool call nobody made", () => {
		const adapter = inTurn();
		expect(() => adapter.received(toolResult("toolu_ghost", "x"))).toThrow(
			ProtocolMismatch,
		);
	});

	it("keep text and tool calls of one message in the order they were said", () => {
		const adapter = inTurn();
		adapter.received(
			assistantLine("m", [
				{ type: "text", text: "First." },
				toolUse("toolu_1", "Bash", { command: "ls" }),
				{ type: "text", text: "Then." },
			]),
		);
		expect(adapter.transcript.entries.slice(1).map((each) => each.id)).toEqual([
			"assistant:m:0",
			"tool:toolu_1",
			"assistant:m:2",
		]);
	});
});

describe("permission requests", () => {
	it("offer allowing once, each suggestion, and denying with a reason", () => {
		const adapter = askingForBash();
		const [request] = adapter.transcript.requests;
		expect(request!.subject).toMatchObject({
			kind: "tool",
			reason: "rm is not in the allow list",
		});
		expect(request!.choices.map((each) => each.label)).toEqual([
			"Allow once",
			"Always allow Bash(rm -rf build)",
			"Switch to acceptEdits",
			"Deny",
		]);
	});

	it("carry a chosen suggestion back as the permission update", () => {
		const adapter = askingForBash();
		const [line] = adapter.encode({
			kind: "answer",
			request: requestId("perm"),
			answer: { kind: "choice", choiceId: "suggestion:0", text: undefined },
		});
		expect(JSON.parse(line!)).toEqual({
			type: "control_response",
			response: {
				subtype: "success",
				request_id: "perm",
				response: {
					behavior: "allow",
					updatedInput: { command: "rm -rf build" },
					updatedPermissions: [
						{
							type: "addRules",
							rules: [{ toolName: "Bash", ruleContent: "rm -rf build" }],
							behavior: "allow",
							destination: "localSettings",
						},
					],
				},
			},
		});
	});

	it("deny with the person's words, and the tool call ends denied", () => {
		const adapter = askingForBash();
		const [line] = perform(adapter, {
			kind: "answer",
			request: requestId("perm"),
			answer: { kind: "choice", choiceId: "deny", text: "use make clean" },
		});
		expect(JSON.parse(line!).response.response).toEqual({
			behavior: "deny",
			message: "use make clean",
		});
		expect(adapter.transcript.requests).toEqual([]);
		adapter.received(toolResult("toolu_1", "use make clean", true));
		expect((entry(adapter, "tool:toolu_1") as ToolEntry).status).toBe("denied");
	});

	it("deny with a stock sentence when the person gave none", () => {
		const adapter = askingForBash();
		const [line] = adapter.encode({
			kind: "answer",
			request: requestId("perm"),
			answer: { kind: "choice", choiceId: "deny", text: undefined },
		});
		expect(JSON.parse(line!).response.response.message).toMatch(/denied/);
	});

	it("close when the CLI cancels them", () => {
		const adapter = askingForBash();
		adapter.received(
			json({ type: "control_cancel_request", request_id: "perm" }),
		);
		expect(adapter.transcript.requests).toEqual([]);
	});

	it("ignore a cancel for a request already answered", () => {
		const adapter = askingForBash();
		perform(adapter, {
			kind: "answer",
			request: requestId("perm"),
			answer: { kind: "choice", choiceId: "allow", text: undefined },
		});
		expect(
			adapter.received(
				json({ type: "control_cancel_request", request_id: "perm" }),
			).events,
		).toEqual([]);
	});

	it("refuse an answer to a request that is not pending, or with a choice it did not offer", () => {
		const adapter = askingForBash();
		expect(() =>
			adapter.encode({
				kind: "answer",
				request: requestId("nope"),
				answer: { kind: "choice", choiceId: "allow", text: undefined },
			}),
		).toThrow(/not pending/);
		expect(() =>
			adapter.encode({
				kind: "answer",
				request: requestId("perm"),
				answer: { kind: "choice", choiceId: "sometimes", text: undefined },
			}),
		).toThrow(/did not offer/);
	});

	it("ask AskUserQuestion's questions as a question, and answer with the chosen options", () => {
		const adapter = inTurn();
		const input = {
			questions: [
				{
					question: "Which database?",
					header: "Database",
					options: [
						{ label: "SQLite", description: "a file" },
						{ label: "Postgres", description: "a server" },
					],
					multiSelect: false,
				},
				{
					question: "Which features?",
					header: "Features",
					options: [
						{ label: "Auth", description: "" },
						{ label: "Search", description: "" },
					],
					multiSelect: true,
				},
			],
		};
		adapter.received(
			assistantLine("m", [toolUse("toolu_q", "AskUserQuestion", input)]),
		);
		adapter.received(
			canUseTool("q", {
				tool_name: "AskUserQuestion",
				input,
				tool_use_id: "toolu_q",
			}),
		);
		const [request] = adapter.transcript.requests;
		expect(request).toMatchObject({
			entry: "tool:toolu_q",
			subject: {
				kind: "question",
				questions: [
					{
						id: "Which database?",
						header: "Database",
						text: "Which database?",
						options: [
							{ label: "SQLite", description: "a file" },
							{ label: "Postgres", description: "a server" },
						],
						multiSelect: false,
						allowsOther: true,
					},
					{ id: "Which features?", multiSelect: true },
				],
			},
			choices: [
				{ id: "deny", label: "Decline", tone: "deny", takesText: true },
			],
		});
		const [line] = adapter.encode({
			kind: "answer",
			request: requestId("q"),
			answer: {
				kind: "answers",
				values: {
					"Which database?": "SQLite",
					"Which features?": ["Auth", "Search"],
				},
			},
		});
		expect(JSON.parse(line!).response.response).toEqual({
			behavior: "allow",
			updatedInput: {
				...input,
				answers: {
					"Which database?": "SQLite",
					"Which features?": "Auth, Search",
				},
			},
		});
	});

	it("are refused in a malformed shape", () => {
		const adapter = inTurn();
		expect(() =>
			adapter.received(canUseTool("p", { tool_name: 7, input: {} })),
		).toThrow(
			/control_request.request.tool_name: expected a string \(CLI 2.1.0\)/,
		);
	});
});

describe("interrupting", () => {
	it("writes an interrupt control request", () => {
		const adapter = inTurn();
		const [line] = adapter.encode({ kind: "interrupt" });
		expect(JSON.parse(line!)).toEqual({
			type: "control_request",
			request_id: "boot:1",
			request: { subtype: "interrupt" },
		});
	});

	it("ends the running tool interrupted and the turn interrupted", () => {
		const adapter = inTurn();
		adapter.received(
			assistantLine("m", [
				toolUse("toolu_1", "Bash", { command: "sleep 100" }),
			]),
		);
		perform(adapter, { kind: "interrupt" });
		adapter.received(
			json({
				type: "control_response",
				response: { subtype: "success", request_id: "boot:1" },
			}),
		);
		adapter.received(
			toolResult("toolu_1", "[Request interrupted by user for tool use]", true),
		);
		adapter.received(
			result({ subtype: "error_during_execution", is_error: true, errors: [] }),
		);
		expect((entry(adapter, "tool:toolu_1") as ToolEntry).status).toBe(
			"interrupted",
		);
		expect(adapter.transcript.entries.at(-1)).toMatchObject({
			kind: "turn-end",
			outcome: "interrupted",
		});
		expect(conversationStatus(adapter.transcript)).toBe("idle");
	});

	it("does not reach into the next turn", () => {
		const adapter = inTurn();
		perform(adapter, { kind: "interrupt" });
		adapter.received(
			result({ subtype: "error_during_execution", is_error: true }),
		);
		perform(adapter, { kind: "send", text: "again", origin: "person" });
		adapter.received(echo("again", "u2"));
		adapter.received(
			result({
				is_error: true,
				subtype: "error_max_turns",
				errors: ["Reached max turns"],
			}),
		);
		expect(adapter.transcript.entries.at(-1)).toMatchObject({
			kind: "turn-end",
			outcome: "failed",
			detail: "Reached max turns",
		});
	});
});

describe("settings", () => {
	it("change the model with set_model, and the session follows once the CLI agrees", () => {
		const adapter = inTurn();
		const [line] = configure(adapter, "model", "opus");
		expect(JSON.parse(line!)).toEqual({
			type: "control_request",
			request_id: "boot:1",
			request: { subtype: "set_model", model: "opus" },
		});
		expect(adapter.transcript.session.model.current).toBe("claude-sonnet-5");
		adapter.received(
			json({
				type: "control_response",
				response: { subtype: "success", request_id: "boot:1" },
			}),
		);
		expect(adapter.transcript.session.model.current).toBe("opus");
	});

	it("change the mode with set_permission_mode", () => {
		const adapter = inTurn();
		const [line] = configure(adapter, "mode", "plan");
		expect(JSON.parse(line!).request).toEqual({
			subtype: "set_permission_mode",
			mode: "plan",
		});
		adapter.received(
			json({
				type: "control_response",
				response: { subtype: "success", request_id: "boot:1" },
			}),
		);
		expect(adapter.transcript.session.mode.current).toBe("plan");
	});

	it("show a refusal as an error notice and leave the setting as it was", () => {
		const adapter = inTurn();
		configure(adapter, "model", "nonsense");
		adapter.received(
			json({
				type: "control_response",
				response: {
					subtype: "error",
					request_id: "boot:1",
					error: "Unknown model nonsense",
				},
			}),
		);
		expect(adapter.transcript.session.model.current).toBe("claude-sonnet-5");
		expect(adapter.transcript.entries.at(-1)).toMatchObject({
			kind: "notice",
			level: "error",
			text: "set_model was refused: Unknown model nonsense",
		});
	});

	it("change the effort with the /effort command, as a message", () => {
		const adapter = inTurn();
		const [line] = configure(adapter, "effort", "high");
		expect(JSON.parse(line!).message).toEqual({
			role: "user",
			content: "/effort high",
		});
		expect(adapter.transcript.session.effort.current).toBe("high");
	});

	it("follow a mode change the CLI reports by itself", () => {
		const adapter = inTurn();
		adapter.received(
			json({
				type: "system",
				subtype: "status",
				status: null,
				permissionMode: "plan",
			}),
		);
		expect(adapter.transcript.session.mode.current).toBe("plan");
	});

	it("refuse a response to a request DevHub never made", () => {
		const adapter = inTurn();
		expect(() =>
			adapter.received(
				json({
					type: "control_response",
					response: { subtype: "success", request_id: "x:9" },
				}),
			),
		).toThrow(
			/control_response.response.request_id: expected a request DevHub made/,
		);
	});
});

describe("the end of a turn", () => {
	it("records a failed turn with the CLI's own words, and the Agent reads as in error", () => {
		const adapter = inTurn();
		adapter.received(
			result({
				subtype: "error_during_execution",
				is_error: true,
				errors: ["API Error: 500", "gave up"],
			}),
		);
		expect(adapter.transcript.entries.at(-1)).toMatchObject({
			kind: "turn-end",
			outcome: "failed",
			detail: "API Error: 500\ngave up",
		});
		expect(conversationStatus(adapter.transcript)).toBe("error");
	});

	it("falls back to the result text as the detail of a failure with no errors listed", () => {
		const adapter = inTurn();
		adapter.received(
			result({ is_error: true, result: "Credit balance is too low" }),
		);
		expect(adapter.transcript.entries.at(-1)).toMatchObject({
			detail: "Credit balance is too low",
		});
	});

	it("shows an API error the assistant message stands for", () => {
		const adapter = inTurn();
		// Any error but the one that means "not signed in".
		adapter.received(
			assistantLine(
				"m",
				[{ type: "text", text: "API Error: Rate limit reached" }],
				null,
				{ error: "rate_limit" },
			),
		);
		expect(adapter.transcript.entries.at(-1)).toMatchObject({
			kind: "notice",
			level: "error",
			text: "The API refused the request: rate_limit",
		});
		expect(adapter.transcript.state).toEqual({
			phase: "ready",
			turn: "running",
		});
	});
});

describe("a CLI that cannot work", () => {
	it("is not signed in when the API refuses it as unauthenticated: the conversation stops, saying how to sign in", () => {
		const adapter = inTurn();
		adapter.received(
			assistantLine(
				"m",
				[{ type: "text", text: "Invalid API key · Please run /login" }],
				null,
				{ error: "authentication_failed" },
			),
		);
		expect(adapter.transcript.state).toEqual({
			phase: "broken",
			failure: {
				code: "not_signed_in",
				detail:
					"claude is not signed in. Open a terminal Agent from this profile and run /login there.",
			},
		});
		// The turn still ends, and the conversation stays broken past it.
		adapter.received(result({ is_error: true, result: "Invalid API key" }));
		expect(adapter.transcript.state.phase).toBe("broken");
		// What the CLI said is still in the transcript, in its own words.
		expect(
			adapter.transcript.entries.find((entry) => entry.kind === "assistant"),
		).toMatchObject({
			blocks: [
				{ kind: "text", markdown: "Invalid API key · Please run /login" },
			],
		});
	});

	it("refused the conversation when it refuses the handshake", () => {
		const adapter = new ClaudeAdapter("boot");
		for (const line of adapter.opening()) adapter.sent(line);
		adapter.received(
			json({
				type: "control_response",
				response: {
					subtype: "error",
					request_id: "boot:1",
					error: "unsupported protocol",
				},
			}),
		);
		expect(adapter.transcript.state).toEqual({
			phase: "broken",
			failure: {
				code: "refused",
				detail: "claude refused the handshake: unsupported protocol",
			},
		});
	});
});

describe("system events", () => {
	it("show an API retry as a warning", () => {
		const adapter = inTurn();
		adapter.received(
			json({
				type: "system",
				subtype: "api_retry",
				attempt: 2,
				max_retries: 10,
				retry_delay_ms: 4000,
				error_status: 529,
			}),
		);
		expect(adapter.transcript.entries.at(-1)).toMatchObject({
			kind: "notice",
			level: "warning",
			text: "The API request failed (529); retrying in 4s (attempt 2 of 10)",
		});
	});

	it("show a compaction as information", () => {
		const adapter = inTurn();
		adapter.received(
			json({
				type: "system",
				subtype: "compact_boundary",
				compact_metadata: { trigger: "auto", pre_tokens: 150000 },
			}),
		);
		expect(adapter.transcript.entries.at(-1)).toMatchObject({
			kind: "notice",
			level: "info",
			text: "The conversation was compacted (auto, from 150000 tokens)",
		});
	});

	it("show a background task's end on the call that started it, not as a notice", () => {
		const adapter = inTurn();
		adapter.received(
			assistantLine("m", [
				toolUse("toolu_bg", "Bash", {
					command: "npm test",
					run_in_background: true,
				}),
			]),
		);
		adapter.received(
			json({
				type: "system",
				subtype: "task_notification",
				tool_use_id: "toolu_bg",
				status: "completed",
				summary: "npm test finished",
			}),
		);
		expect(entry(adapter, "tool:toolu_bg")).toMatchObject({
			background: { state: "completed", summary: "npm test finished" },
		});
		expect(
			adapter.transcript.entries.filter((each) => each.kind === "notice"),
		).toEqual([]);
	});

	it("mark a failed subagent failed", () => {
		const adapter = inTurn();
		adapter.received(
			assistantLine("m", [
				toolUse("toolu_t", "Agent", {
					description: "d",
					prompt: "p",
					subagent_type: "general",
				}),
			]),
		);
		adapter.received(
			json({
				type: "system",
				subtype: "task_notification",
				tool_use_id: "toolu_t",
				status: "failed",
				summary: "crashed",
			}),
		);
		expect((entry(adapter, "tool:toolu_t") as ToolEntry).spawns?.state).toBe(
			"failed",
		);
	});
});

describe("what DevHub does not know", () => {
	it("is a warning notice carrying the raw event, once per kind of event", () => {
		const adapter = inTurn();
		const raw = { type: "hologram", payload: 1 };
		adapter.received(json(raw));
		adapter.received(json({ type: "hologram", payload: 2 }));
		const notices = adapter.transcript.entries.filter(
			(each) => each.kind === "notice",
		);
		expect(notices).toEqual([
			{
				kind: "notice",
				id: expect.any(String),
				parent: null,
				level: "warning",
				text: 'claude 2.1.0 printed a "hologram" event DevHub does not know',
				raw,
			},
		]);
		expect(conversationStatus(adapter.transcript)).toBe("working");
	});

	it("covers system subtypes, stream events, deltas and content blocks", () => {
		const adapter = inTurn();
		adapter.received(json({ type: "system", subtype: "weather" }));
		adapter.received(stream({ type: "message_start", message: { id: "m" } }));
		adapter.received(
			stream({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
		);
		adapter.received(
			stream({
				type: "content_block_delta",
				index: 0,
				delta: { type: "sparkle_delta" },
			}),
		);
		adapter.received(stream({ type: "novel_event" }));
		adapter.received(
			assistantLine("m", [
				{ type: "text", text: "" },
				{ type: "hologram_block" },
			]),
		);
		const texts = adapter.transcript.entries
			.filter((each): each is NoticeEntry => each.kind === "notice")
			.map((each) => each.text);
		expect(texts).toEqual([
			'claude 2.1.0 printed a "system/weather" event DevHub does not know',
			'claude 2.1.0 printed a "delta/sparkle_delta" event DevHub does not know',
			'claude 2.1.0 printed a "stream_event/novel_event" event DevHub does not know',
			'claude 2.1.0 printed a "content/hologram_block" event DevHub does not know',
		]);
	});

	it("is not raised for the events DevHub knows and does not use", () => {
		const adapter = inTurn();
		adapter.received(json({ type: "prompt_suggestion", suggestion: "next" }));
		adapter.received(
			json({
				type: "tool_progress",
				tool_use_id: "t",
				tool_name: "Bash",
				elapsed_time_seconds: 3,
			}),
		);
		adapter.received(stream({ type: "ping" }));
		// A SessionStart hook reports itself even without --include-hook-events,
		// and what it says is the owner's own configuration, not the conversation.
		adapter.received(
			json({
				type: "system",
				subtype: "hook_started",
				hook_id: "h",
				hook_name: "SessionStart:startup",
			}),
		);
		adapter.received(
			json({ type: "system", subtype: "hook_progress", hook_id: "h" }),
		);
		adapter.received(
			json({
				type: "system",
				subtype: "hook_response",
				hook_id: "h",
				output: "private",
			}),
		);
		expect(
			adapter.transcript.entries.filter((each) => each.kind === "notice"),
		).toEqual([]);
	});

	it("includes a control request DevHub does not serve: it is refused at once, so the CLI does not wait", () => {
		const adapter = inTurn();
		const step = adapter.received(
			json({
				type: "control_request",
				request_id: "cli-7",
				request: { subtype: "hook_callback", callback_id: "h" },
			}),
		);
		expect(step.replies.map((line) => JSON.parse(line))).toEqual([
			{
				type: "control_response",
				response: {
					subtype: "error",
					request_id: "cli-7",
					error: 'DevHub does not serve the control request "hook_callback"',
				},
			},
		]);
		expect(adapter.transcript.entries.at(-1)).toMatchObject({
			kind: "notice",
			level: "warning",
		});
		expect(adapter.sent(step.replies[0]!).events).toEqual([]);
	});
});

describe("a line DevHub cannot read", () => {
	it("of a known type in the wrong shape throws with the path and the CLI version", () => {
		const adapter = inTurn();
		let thrown: unknown;
		try {
			adapter.received(
				json({
					type: "assistant",
					message: { id: "m", content: "not an array" },
				}),
			);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ProtocolMismatch);
		expect(thrown).toMatchObject({
			path: "assistant.message.content",
			expected: "an array",
			agentVersion: "2.1.0",
		});
	});

	it("that is not JSON throws", () => {
		const adapter = inTurn();
		expect(() => adapter.received("{half a line")).toThrow(
			/line: expected a line of JSON/,
		);
	});

	it("leaves the adapter spent: nothing further is taken", () => {
		const adapter = inTurn();
		expect(() => adapter.received("nope")).toThrow(ProtocolMismatch);
		expect(() => adapter.received(result())).toThrow(/spent/);
		expect(() => adapter.sent("{}")).toThrow(/spent/);
		expect(() => adapter.encode({ kind: "interrupt" })).toThrow(/spent/);
	});

	it("includes a delta for a block that never started", () => {
		const adapter = inTurn();
		adapter.received(stream({ type: "message_start", message: { id: "m" } }));
		expect(() =>
			adapter.received(
				stream({
					type: "content_block_delta",
					index: 3,
					delta: { type: "text_delta", text: "x" },
				}),
			),
		).toThrow(
			/stream_event.event\(content_block_delta\).index: expected a block that started/,
		);
	});

	it("includes a block with no message around it", () => {
		const adapter = inTurn();
		expect(() =>
			adapter.received(
				stream({
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "" },
				}),
			),
		).toThrow(/expected a message_start before it/);
	});

	it("includes a subagent message whose parent call nobody made", () => {
		const adapter = inTurn();
		expect(() =>
			adapter.received(
				assistantLine("m", [{ type: "text", text: "hi" }], "toolu_ghost"),
			),
		).toThrow(
			/assistant.parent_tool_use_id: expected a tool call that was made/,
		);
	});

	it("includes a line in in.log that DevHub would never have written", () => {
		const adapter = inTurn();
		expect(() => adapter.sent(json({ type: "assistant" }))).toThrow(
			/sent line.type/,
		);
	});
});

describe("the assistant message without partial messages", () => {
	it("arrives whole and final from its complete message alone", () => {
		const adapter = inTurn();
		adapter.received(
			assistantLine("m", [{ type: "thinking", thinking: "hmm" }]),
		);
		adapter.received(assistantLine("m", [{ type: "text", text: "Done." }]));
		expect(entry(adapter, "assistant:m:0")).toEqual({
			kind: "assistant",
			id: "assistant:m:0",
			parent: null,
			blocks: [
				{ kind: "thinking", text: "hmm" },
				{ kind: "text", markdown: "Done." },
			],
			streaming: false,
		});
	});
});

/**
 * A real session, scrubbed (see the capture's header): what the CLI printed
 * and what DevHub wrote, in the order they happened. Where it and the
 * hand-written fixtures disagree, the capture is right.
 */
describe("the captured session", () => {
	const lines = fixture("claude-session.capture.ndjson");

	function played(upTo = lines.length): ClaudeAdapter {
		const adapter = new ClaudeAdapter("replay");
		play(adapter, lines.slice(0, upTo));
		return adapter;
	}

	it("plays through to an idle conversation, with every turn completed and nothing it does not know", () => {
		const { transcript } = played();
		expect(transcript.state).toEqual({ phase: "ready", turn: "none" });
		expect(
			transcript.entries
				.filter((entry) => entry.kind === "turn-end")
				.map((entry) => (entry.kind === "turn-end" ? entry.outcome : "")),
		).toEqual([
			"completed",
			"completed",
			"completed",
			"completed",
			"completed",
		]);
		expect(
			transcript.entries.filter((entry) => entry.kind === "notice"),
		).toEqual([]);
		expect(
			transcript.entries
				.filter((entry) => entry.kind === "user")
				.map((entry) => entry.kind === "user" && entry.origin),
		).toEqual(["person", "person", "person", "person"]);
	});

	it("draws no thinking the API withheld: no empty block, and no message made of nothing else", () => {
		const { transcript } = played();
		for (const entry of transcript.entries) {
			if (entry.kind !== "assistant") continue;
			expect(entry.blocks.length).toBeGreaterThan(0);
			for (const block of entry.blocks) {
				if (block.kind === "thinking") expect(block.text).not.toBe("");
			}
		}
	});

	it("hangs a background subagent's work under the Agent call, and asks for its Bash call after the turn is over", () => {
		const adapter = new ClaudeAdapter("replay");
		const asked = lines.findIndex((each) =>
			each.line.includes('"subtype":"can_use_tool"'),
		);
		play(adapter, lines.slice(0, asked + 1));
		const agent = adapter.transcript.entries.find(
			(entry) => entry.kind === "tool" && entry.tool === "Agent",
		) as ToolEntry;
		expect(agent.spawns).toMatchObject({
			label: "general-purpose",
			state: "running",
		});
		const [request] = adapter.transcript.requests;
		const bash = adapter.transcript.entries.find(
			(entry) => entry.id === request?.entry,
		) as ToolEntry;
		expect(bash).toMatchObject({
			tool: "Bash",
			parent: agent.id,
			status: "running",
		});
		expect(request?.choices.map((choice) => choice.id)).toContain("allow");
		// The turn that started it has already ended; the request is still owed an answer.
		expect(adapter.transcript.state).toEqual({ phase: "ready", turn: "none" });
		expect(conversationStatus(adapter.transcript)).toBe("waiting");

		play(adapter, lines.slice(asked + 1));
		const { transcript } = adapter;
		expect(transcript.requests).toEqual([]);
		expect(
			transcript.entries.find((entry) => entry.id === bash.id),
		).toMatchObject({ status: "succeeded" });
		expect(
			(transcript.entries.find((entry) => entry.id === agent.id) as ToolEntry)
				.spawns?.state,
		).toBe("completed");
	});

	it("reads a turn the CLI starts by itself, when a background subagent finishes, as running", () => {
		const own = lines.findLastIndex(
			(each) =>
				each.line.includes('"type":"message_start"') &&
				each.line.includes('"parent_tool_use_id":null'),
		);
		const adapter = new ClaudeAdapter("replay");
		play(adapter, lines.slice(0, own + 1));
		expect(adapter.transcript.state).toEqual({
			phase: "ready",
			turn: "running",
		});
	});

	it("draws the Markdown and runs the Bash call to its output", () => {
		const { transcript } = played();
		const texts = transcript.entries.flatMap((entry) =>
			entry.kind === "assistant"
				? entry.blocks.flatMap((block) =>
						block.kind === "text" ? [block.markdown] : [],
					)
				: [],
		);
		expect(texts[0]).toContain("| Key | Value |");
		expect(texts[0]).toContain("```typescript");
		expect(
			transcript.entries.find((entry) => entry.kind === "tool"),
		).toMatchObject({
			tool: "Bash",
			title: "Bash: pwd",
			status: "succeeded",
			output: { kind: "text", text: "/home/testuser/project" },
		});
	});

	it("knows the mode from the handshake, before the first turn names it", () => {
		const { transcript } = played(2);
		expect(transcript.state).toEqual({ phase: "ready", turn: "none" });
		expect(transcript.session.mode.current).toBe("default");
	});

	it("names the model by the choice the CLI resolved it from, and offers the effort that model has", () => {
		const firstTurn = lines.findIndex((each) =>
			each.line.includes('"subtype":"init"'),
		);
		const { session } = played(firstTurn + 1).transcript;
		expect(session.agentVersion).toBe("2.1.281");
		expect(session.cwd).toBe("/home/testuser/project");
		// Haiku, reported by its full name, is the "haiku" choice — and has no effort to choose.
		expect(session.model.current).toBe("haiku");
		expect(session.effort).toEqual({ current: undefined, choices: [] });
	});

	it("offers every effort level a model supports, as the handshake lists them", () => {
		const adapter = played(2);
		adapter.received(init({ model: "claude-sonnet-5" }));
		const { session } = adapter.transcript;
		expect(session.model.current).toBe("sonnet");
		expect(session.effort.choices.map((choice) => choice.id)).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});
});

describe("a usage limit", () => {
	it("is said, and the conversation still takes the person's next message", () => {
		const adapter = inTurn();
		// The limit's event names no window when the CLI cannot tell which
		// one limits (`rateLimitType` is optional in its schema).
		adapter.received(
			json({
				type: "rate_limit_event",
				rate_limit_info: {
					status: "rejected",
					resetsAt: 1_800_000_000,
					isUsingOverage: false,
				},
				session_id: SESSION,
			}),
		);
		adapter.received(
			assistantLine(
				"m",
				[{ type: "text", text: "You've hit your limit · resets 3am" }],
				null,
				{ error: "rate_limit" },
			),
		);
		adapter.received(
			result({ is_error: true, result: "You've hit your limit" }),
		);
		expect(adapter.transcript.state).toEqual({ phase: "ready", turn: "none" });
		expect(
			adapter.transcript.entries.some(
				(each) => each.kind === "notice" && each.text.includes("rate_limit"),
			),
		).toBe(true);
		expect(
			perform(adapter, { kind: "send", text: "again", origin: "person" }),
		).toHaveLength(1);
	});
});

describe("a subagent's end", () => {
	// `claude-session-background-agents.handwritten.jsonl` is HAND-WRITTEN,
	// shaped from what claude 2.1.x writes (read from its binary): background
	// Agent calls whose results only say they launched (`toolUseResult.status`
	// "async_launched"), a foreground one whose result is its end, and the
	// ends of two background ones as `<task-notification>`s — one a meta user
	// message naming the call, one a queued command naming only the task.
	// One background subagent's end is recorded nowhere.
	function resumed(): ClaudeAdapter {
		const adapter = new ClaudeAdapter("boot");
		const file = readFileSync(
			join(FIXTURES, "claude-session-background-agents.handwritten.jsonl"),
			"utf8",
		);
		for (const line of claudeHistoryLines(SESSION, file))
			adapter.received(line);
		return adapter;
	}
	const states = (adapter: ClaudeAdapter) =>
		adapter.transcript.entries.flatMap((each) =>
			each.kind === "tool" && each.spawns !== undefined
				? [`${each.id} ${each.spawns.state}`]
				: [],
		);

	it("is read back from a session file: as recorded, or unknown when nothing recorded it, never running", () => {
		const adapter = resumed();
		expect(states(adapter)).toEqual([
			"tool:toolu_a completed",
			"tool:toolu_b unknown",
			"tool:toolu_c completed",
			"tool:toolu_d failed",
		]);
		// A notification is nobody's words: no bubble, no notice.
		expect(
			adapter.transcript.entries.flatMap((each) =>
				each.kind === "user" ? [each.text] : [],
			),
		).toEqual(["Survey A to D", "And D?"]);
		expect(
			adapter.transcript.entries.filter((each) => each.kind === "notice"),
		).toEqual([]);
	});

	it("is taken from a notification that names only the task a background call launched", () => {
		const adapter = inTurn();
		adapter.received(
			assistantLine("m", [
				toolUse("toolu_bg", "Agent", {
					description: "d",
					prompt: "p",
					subagent_type: "general",
				}),
			]),
		);
		adapter.received(
			json({
				...JSON.parse(toolResult("toolu_bg", "Async agent launched")),
				tool_use_result: {
					isAsync: true,
					status: "async_launched",
					agentId: "agent-1",
				},
			}),
		);
		expect(states(adapter)).toEqual(["tool:toolu_bg running"]);
		adapter.received(
			json({
				type: "system",
				subtype: "task_notification",
				task_id: "agent-1",
				status: "completed",
				summary: "done",
			}),
		);
		expect(states(adapter)).toEqual(["tool:toolu_bg completed"]);
	});

	it("is unknown once the CLI running it is replaced, when nothing told it", () => {
		const adapter = inTurn();
		adapter.received(
			assistantLine("m", [
				toolUse("toolu_bg", "Agent", {
					description: "d",
					prompt: "p",
					subagent_type: "general",
				}),
			]),
		);
		adapter.received(
			json({
				...JSON.parse(toolResult("toolu_bg", "Async agent launched")),
				tool_use_result: {
					isAsync: true,
					status: "async_launched",
					agentId: "agent-1",
				},
			}),
		);
		adapter.received(result());
		perform(adapter, { kind: "send", text: "next", origin: "person" });
		adapter.received(echo("next", "u-next"));
		adapter.received(result());
		adapter.received(json({ type: "devhub_rewind", message: "user:u-next" }));
		expect(states(adapter)).toEqual(["tool:toolu_bg unknown"]);
	});
});

describe("a resumed session's history", () => {
	// The lines `resume.ts` makes of the hand-written session file
	// (`claude-session-file.handwritten.jsonl`), put before the CLI's own.
	function resumed(): ClaudeAdapter {
		const adapter = new ClaudeAdapter("boot");
		const file = readFileSync(
			join(FIXTURES, "claude-session-file.handwritten.jsonl"),
			"utf8",
		);
		for (const line of claudeHistoryLines(SESSION, file))
			adapter.received(line);
		return adapter;
	}

	it("draws the past as the same entries a live turn makes, the person's words as the person's", () => {
		const adapter = resumed();
		expect(entry(adapter, "user:u2")).toMatchObject({
			kind: "user",
			text: "List the files in src",
			origin: "person",
		});
		expect(entry(adapter, "user:u6")).toMatchObject({
			text: "Now read main.ts",
		});
		const tools = adapter.transcript.entries.filter(
			(each): each is ToolEntry => each.kind === "tool",
		);
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({
			status: "succeeded",
			output: { kind: "text", text: "main.ts" },
		});
		expect(
			adapter.transcript.entries.flatMap((each) =>
				each.kind === "assistant" ? each.blocks : [],
			),
		).toEqual([
			{ kind: "thinking", text: "Use ls." },
			{ kind: "text", markdown: "There is one file: main.ts." },
			{ kind: "text", markdown: "It is empty." },
		]);
		expect(
			adapter.transcript.entries.every(
				(each) => each.kind !== "assistant" || !each.streaming,
			),
		).toBe(true);
		// Nothing of the past is a notice: it is what was said, not news.
		expect(
			adapter.transcript.entries.filter((each) => each.kind === "notice"),
		).toEqual([]);
	});

	it("is no turn running now: the conversation is ready once the CLI says so", () => {
		const adapter = resumed();
		expect(adapter.transcript.state.phase).toBe("connecting");
		adapter.received(init());
		expect(adapter.transcript.state).toEqual({ phase: "ready", turn: "none" });
	});
});

describe("taking back the last turn", () => {
	const TEXT = (text: string) => ({ type: "text", text });
	/** Two whole turns, "first" and "second", on a CLI that can resume at a message. */
	function twoTurns(version = "2.1.282"): ClaudeAdapter {
		const adapter = new ClaudeAdapter("boot");
		adapter.received(init({ claude_code_version: version }));
		perform(adapter, { kind: "send", text: "first", origin: "person" });
		adapter.received(echo("first", "u1"));
		adapter.received(
			assistantLine("msg_1", [TEXT("one")], null, { uuid: "a1" }),
		);
		adapter.received(result());
		perform(adapter, { kind: "send", text: "second", origin: "person" });
		adapter.received(echo("second", "u2"));
		adapter.received(
			assistantLine("msg_2", [TEXT("two")], null, { uuid: "a2" }),
		);
		adapter.received(result());
		return adapter;
	}

	function initialized(requestId: string): string {
		return json({
			type: "control_response",
			response: {
				subtype: "success",
				request_id: requestId,
				response: { commands: [], models: [] },
			},
		});
	}

	it("starts the CLI again on the session cut short before the message, and drops that turn when the host's mark comes back", () => {
		const adapter = twoTurns();
		expect(adapter.transcript.session.canRewind).toBe(true);
		const plan = adapter.rewind(entryId("user:u2"));
		expect(plan).toEqual({
			kind: "restart",
			session: ["--resume", SESSION, "--resume-session-at", "a1"],
			mark: [json({ type: "devhub_rewind", message: "user:u2" })],
		});
		// Nothing changes until the host says the CLI was started again.
		expect(adapter.transcript.entries.map((each) => each.id)).toContain(
			"user:u2",
		);
		if (plan.kind !== "restart") throw new Error("not a restart");

		const step = adapter.received(plan.mark[0]!);
		expect(step.events).toContainEqual({
			type: "rewound",
			from: entryId("user:u2"),
		});
		expect(adapter.transcript.entries.map((each) => each.id)).toEqual([
			"user:u1",
			"assistant:msg_1:0",
			"turn:1",
		]);
		expect(adapter.transcript.state).toEqual({
			phase: "ready",
			turn: "rewinding",
		});
		// The new CLI is greeted, as a reply: once, and not again on a replay.
		expect(step.replies.map((line) => JSON.parse(line))).toEqual([
			{
				type: "control_request",
				request_id: "boot:1",
				request: { subtype: "initialize" },
			},
		]);
		for (const line of step.replies) adapter.sent(line);
		adapter.received(initialized("boot:1"));
		expect(adapter.transcript.state).toEqual({ phase: "ready", turn: "none" });

		perform(adapter, { kind: "send", text: "second, again", origin: "person" });
		adapter.received(echo("second, again", "u3"));
		expect(entry(adapter, "user:u3")).toMatchObject({ text: "second, again" });
		// And that message is the one to take back next, from the same anchor.
		adapter.received(result());
		const again = adapter.rewind(entryId("user:u3"));
		expect(again).toMatchObject({
			session: ["--resume", SESSION, "--resume-session-at", "a1"],
		});
	});

	it("starts a fresh session when the message was the first", () => {
		const adapter = new ClaudeAdapter("boot");
		adapter.received(init({ claude_code_version: "2.1.282" }));
		perform(adapter, { kind: "send", text: "first", origin: "person" });
		adapter.received(echo("first", "u1"));
		adapter.received(result());
		expect(adapter.rewind(entryId("user:u1"))).toMatchObject({
			kind: "restart",
			session: [],
		});
	});

	it("resumes at the last message of a resumed session's past", () => {
		const adapter = new ClaudeAdapter("boot");
		const history = claudeHistoryLines(
			SESSION,
			readFileSync(
				join(FIXTURES, "claude-session-file.handwritten.jsonl"),
				"utf8",
			),
		);
		for (const line of history) adapter.received(line);
		adapter.received(init({ claude_code_version: "2.1.282" }));
		perform(adapter, { kind: "send", text: "next", origin: "person" });
		adapter.received(echo("next", "u9"));
		adapter.received(result());
		const last = (JSON.parse(history.at(-1)!) as { record: { uuid: string } })
			.record.uuid;
		expect(adapter.rewind(entryId("user:u9"))).toMatchObject({
			session: ["--resume", SESSION, "--resume-session-at", last],
		});
	});

	it("is not offered by a CLI too old to resume at a message, and refused if asked", () => {
		const adapter = twoTurns("2.1.222");
		expect(adapter.transcript.session.canRewind).toBe(false);
		expect(() => adapter.rewind(entryId("user:u2"))).toThrow(
			/claude 2.1.222 cannot take back a turn: resuming at a message needs 2.1.223 or later/,
		);
	});

	it("goes back to before an earlier message too: the session is cut after the message before it, and every turn from it on is dropped", () => {
		const adapter = twoTurns();
		expect([...rewindTargets(adapter.transcript)]).toEqual([
			"user:u1",
			"user:u2",
		]);
		const plan = adapter.rewind(entryId("user:u1"));
		// The first message has nothing before it: a fresh session.
		expect(plan).toMatchObject({ kind: "restart", session: [] });
		if (plan.kind !== "restart") throw new Error("not a restart");
		adapter.received(plan.mark[0]!);
		expect(adapter.transcript.entries).toEqual([]);

		const three = twoTurns();
		perform(three, { kind: "send", text: "third", origin: "person" });
		three.received(echo("third", "u3"));
		three.received(result());
		const cut = three.rewind(entryId("user:u2"));
		expect(cut).toMatchObject({
			session: ["--resume", SESSION, "--resume-session-at", "a1"],
		});
		if (cut.kind !== "restart") throw new Error("not a restart");
		three.received(cut.mark[0]!);
		expect(three.transcript.entries.map((each) => each.id)).toEqual([
			"user:u1",
			"assistant:msg_1:0",
			"turn:1",
		]);
	});

	it("refuses a message that is not a rewind target now", () => {
		const adapter = twoTurns();
		perform(adapter, { kind: "send", text: "third", origin: "person" });
		adapter.received(echo("third", "u3"));
		expect(() => adapter.rewind(entryId("user:u1"))).toThrow(
			/user:u1 is not a message the conversation can be rewound to now/,
		);
	});

	it("refuses a mark for a message that is not in the conversation", () => {
		const adapter = twoTurns();
		expect(() =>
			adapter.received(json({ type: "devhub_rewind", message: "user:nope" })),
		).toThrow(/user:nope, which is not an entry/);
	});
});

describe("a message written while a turn runs", () => {
	it("is queued for the turn's next step, and one written between turns starts one", () => {
		const adapter = new ClaudeAdapter("boot");
		adapter.received(init());
		const idle = adapter.encode({ kind: "send", text: "go", origin: "person" });
		expect(JSON.parse(idle[0]!)).not.toHaveProperty("priority");
		perform(adapter, { kind: "send", text: "go", origin: "person" });
		adapter.received(echo("go", "u1"));
		const midTurn = adapter.encode({
			kind: "send",
			text: "and also this",
			origin: "person",
		});
		expect(JSON.parse(midTurn[0]!)).toMatchObject({
			type: "user",
			priority: "next",
			message: { content: "and also this" },
		});
		// It is the person's like any other once the CLI takes it.
		perform(adapter, { kind: "send", text: "and also this", origin: "person" });
		adapter.received(echo("and also this", "u2"));
		expect(entry(adapter, "user:u2")).toMatchObject({
			origin: "person",
			rewindable: true,
		});
	});
});

describe("a subagent", () => {
	it("takes no message from the person: stream-json has no way to reach one", () => {
		const adapter = new ClaudeAdapter("boot");
		adapter.received(init());
		expect(() =>
			adapter.encode({
				kind: "instruct",
				subagent: entryId("tool:toolu_1"),
				text: "look deeper",
			}),
		).toThrow(/no way to say something to a subagent/);
	});
});

describe("going on with another session (/resume)", () => {
	const OTHER = "00000000-0000-4000-8000-0000000000a1";
	function oneTurn(): ClaudeAdapter {
		const adapter = new ClaudeAdapter("boot");
		adapter.received(init());
		perform(adapter, { kind: "send", text: "first", origin: "person" });
		adapter.received(echo("first", "u1"));
		adapter.received(
			assistantLine("msg_1", [{ type: "text", text: "one" }], null, {
				uuid: "a1",
			}),
		);
		adapter.received(result());
		return adapter;
	}
	const history = claudeHistoryLines(
		OTHER,
		readFileSync(
			join(FIXTURES, "claude-session-file.handwritten.jsonl"),
			"utf8",
		),
	);

	it("starts the CLI again on the other session, with its past in the mark after the switch", () => {
		const adapter = oneTurn();
		const plan = adapter.resumeSession(OTHER, history);
		expect(plan).toEqual({
			kind: "restart",
			session: ["--resume", OTHER],
			mark: [json({ type: "devhub_resume", session: OTHER }), ...history],
		});
		// Nothing changes until the host puts the mark in the journal.
		expect(entry(adapter, "user:u1")).toMatchObject({ text: "first" });
		if (plan.kind !== "restart") throw new Error("not a restart");

		const [switched, ...past] = plan.mark;
		const step = adapter.received(switched!);
		expect(step.events).toContainEqual({
			type: "session-switched",
			session: OTHER,
		});
		expect(adapter.transcript.entries).toEqual([]);
		expect(adapter.transcript.session.sessionId).toBe(OTHER);
		expect(adapter.transcript.state).toEqual({
			phase: "ready",
			turn: "rewinding",
		});
		expect(step.replies.map((line) => JSON.parse(line))).toEqual([
			{
				type: "control_request",
				request_id: "boot:1",
				request: { subtype: "initialize" },
			},
		]);
		for (const line of past) adapter.received(line);
		expect(entry(adapter, "user:u2")).toMatchObject({
			text: "List the files in src",
		});
		for (const line of step.replies) adapter.sent(line);
		adapter.received(
			json({
				type: "control_response",
				response: {
					subtype: "success",
					request_id: "boot:1",
					response: { commands: [], models: [] },
				},
			}),
		);
		expect(adapter.transcript.state).toEqual({ phase: "ready", turn: "none" });
		// The other session's past is where an edit cuts now.
		expect(
			adapter.transcript.entries.some((each) => each.id === "user:u1"),
		).toBe(false);
	});

	it("offers /resume as DevHub's own picker, listed or not", () => {
		expect(
			oneTurn().transcript.session.commands.find(
				(command) => command.name === "resume",
			),
		).toMatchObject({ route: "resume" });
	});

	it("is refused while a turn runs", () => {
		const adapter = new ClaudeAdapter("boot");
		adapter.received(init());
		perform(adapter, { kind: "send", text: "first", origin: "person" });
		adapter.received(echo("first", "u1"));
		expect(() => adapter.resumeSession(OTHER, [])).toThrow(/not idle/);
	});
});

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
import { describe, expect, it, vi } from "vitest";
import {
	childrenOf,
	conversationStatus,
	entryId,
	requestId,
	rewindTargets,
	type ConversationEvent,
	type NoticeEntry,
	type PendingRequest,
	type Question,
	type RequestAnswer,
	type ToolEntry,
	type TranscriptEntry,
	type UserEntry,
} from "../../../../model/conversation.js";
import {
	ProtocolMismatch,
	RESTARTED,
	RESTART_MARK,
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
	perform(adapter, { kind: "send", text: "go", images: [], origin: "person" });
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
				trigger: "/",
				name: "review",
				description: "",
				argumentHint: undefined,
				route: "message",
			},
			{
				trigger: "/",
				name: "model",
				description: "",
				argumentHint: undefined,
				route: "model",
			},
			{
				trigger: "/",
				name: "effort",
				description: "",
				argumentHint: undefined,
				route: "effort",
			},
			{
				trigger: "/",
				name: "permissions",
				description: "",
				argumentHint: undefined,
				route: "mode",
			},
			{
				trigger: "/",
				name: "resume",
				description: "Go on with an earlier session in this Workspace",
				argumentHint: undefined,
				route: "resume",
			},
			{
				trigger: "/",
				name: "restart",
				description:
					"Restart the session: start the CLI again, reconnecting its MCP servers",
				argumentHint: undefined,
				route: "restart",
			},
			{
				trigger: "/",
				name: "mcp",
				description:
					"MCP servers: how each stands, reconnect, enable or disable, sign in",
				argumentHint: undefined,
				route: "mcp",
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
				output: [{ kind: "text", text: "/home/testuser/project" }],
				spawns: undefined,
				outsideSandbox: false,
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
						{
							window: "5-hour",
							durationMinutes: 300,
							usedPercent: 25,
							resetsAt: 1_800_000_000_000,
						},
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
				trigger: "/",
				name: "review",
				description: "Review a pull request",
				argumentHint: "<pr>",
				route: "message",
			},
			{
				trigger: "/",
				name: "model",
				description: "Set the AI model",
				argumentHint: undefined,
				route: "model",
			},
			{
				trigger: "/",
				name: "compact",
				description: "Compact the conversation",
				argumentHint: "[instructions]",
				route: "message",
			},
			{
				trigger: "/",
				name: "init",
				description: "",
				argumentHint: undefined,
				route: "message",
			},
			{
				trigger: "/",
				name: "resume",
				description: "Go on with an earlier session in this Workspace",
				argumentHint: undefined,
				route: "resume",
			},
			{
				trigger: "/",
				name: "restart",
				description:
					"Restart the session: start the CLI again, reconnecting its MCP servers",
				argumentHint: undefined,
				route: "restart",
			},
			{
				trigger: "/",
				name: "mcp",
				description:
					"MCP servers: how each stands, reconnect, enable or disable, sign in",
				argumentHint: undefined,
				route: "mcp",
			},
		]);
		// This handshake names no `resolvedModel`, so no choice is known to be
		// the session's model: it is a choice of its own.
		expect(session.model).toEqual({
			current: "claude-sonnet-5",
			choices: [
				{ id: "claude-sonnet-5", label: "claude-sonnet-5" },
				{ id: "default", label: "default", detail: "Default" },
				{ id: "sonnet", label: "sonnet", detail: "Sonnet" },
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
				{
					window: "5-hour",
					durationMinutes: 300,
					usedPercent: 25,
					resetsAt: 1_800_000_000_000,
				},
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
				images: [],
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
			output: [{ kind: "text", text: "src/model/conversation.ts" }],
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
			images: [],
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

	it("appear when the CLI takes them, in a turn under way from the moment one is written", () => {
		const adapter = new ClaudeAdapter("boot");
		adapter.received(init());
		perform(adapter, {
			kind: "send",
			text: "hello",
			images: [],
			origin: "person",
		});
		expect(adapter.transcript.entries).toEqual([]);
		expect(adapter.transcript.state).toEqual({
			phase: "ready",
			turn: "running",
		});
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
		perform(adapter, {
			kind: "send",
			text: "same",
			images: [],
			origin: "injection",
		});
		perform(adapter, {
			kind: "send",
			text: "same",
			images: [],
			origin: "person",
		});
		adapter.received(echo("same", "u1"));
		adapter.received(echo("same", "u2"));
		expect((entry(adapter, "user:u1") as UserEntry).origin).toBe("injection");
		expect((entry(adapter, "user:u2") as UserEntry).origin).toBe("person");
	});

	it("that DevHub did not send are not the person's: live, and the same in a replay", () => {
		/** What DevHub wrote and what the CLI printed, in the order they happened. */
		const play = (adapter: ClaudeAdapter) => {
			adapter.received(init());
			perform(adapter, {
				kind: "send",
				text: "go",
				images: [],
				origin: "person",
			});
			adapter.received(echo("go", "u-go"));
			adapter.received(
				echo("A message another session sent to this one.", "u9"),
			);
			return adapter.transcript.entries.map((each) =>
				each.kind === "user" ? [each.text, each.origin] : [each.kind],
			);
		};
		const drawn = [
			["go", "person"],
			["A message another session sent to this one.", "other"],
		];
		expect(play(new ClaudeAdapter("boot"))).toEqual(drawn);
		// A replay feeds the journal and `in.log` back through the same path.
		expect(play(new ClaudeAdapter("boot"))).toEqual(drawn);
	});

	it("read back from a session file are the person's: the file does not say who sent them", () => {
		const adapter = new ClaudeAdapter("boot");
		adapter.received(
			json({
				type: "devhub_history",
				record: {
					type: "user",
					uuid: "u1",
					message: { role: "user", content: "an earlier message" },
				},
			}),
		);
		expect(adapter.transcript.entries).toMatchObject([
			{ kind: "user", text: "an earlier message", origin: "person" },
		]);
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
			output: [{ kind: "text", text: "File does not exist." }],
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

	it("keep each option's preview", () => {
		const adapter = inTurn();
		const input = {
			questions: [
				{
					question: "Which layout?",
					header: "Layout",
					options: [
						{
							label: "Sidebar",
							description: "",
							preview: "+------+----+\n| menu | .. |\n+------+----+",
						},
						{ label: "Tabs", description: "" },
					],
					multiSelect: false,
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
		expect(adapter.transcript.requests[0]!.subject).toMatchObject({
			kind: "question",
			questions: [
				{
					options: [
						{
							label: "Sidebar",
							preview: "+------+----+\n| menu | .. |\n+------+----+",
						},
						{ label: "Tabs", preview: undefined },
					],
				},
			],
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
		perform(adapter, {
			kind: "send",
			text: "again",
			images: [],
			origin: "person",
		});
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
	it("is not signed in when the API refuses it as unauthenticated: the conversation stops, saying what claude said and how to sign in", () => {
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
					"claude said: “Invalid API key · Please run /login”. Sign in with `claude auth login` (or `/login` in claude) in a terminal on this Agent's machine, then try again.",
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

	it("goes on after a restart once signed out: the new CLI's start lifts the stop and is greeted afresh", () => {
		const adapter = inTurn();
		adapter.received(
			assistantLine(
				"m",
				[{ type: "text", text: "OAuth token has expired" }],
				null,
				{ error: "authentication_failed" },
			),
		);
		adapter.received(
			result({ is_error: true, result: "OAuth token has expired" }),
		);
		expect(adapter.transcript.state.phase).toBe("broken");
		expect(adapter.restart()).toEqual({
			kind: "restart",
			session: ["--resume", SESSION],
			mark: [RESTART_MARK],
		});
		const step = adapter.received(RESTART_MARK);
		expect(adapter.transcript.state).toEqual({
			phase: "ready",
			turn: "rewinding",
		});
		expect(step.replies.map((line) => JSON.parse(line))).toMatchObject([
			{ type: "control_request", request: { subtype: "initialize" } },
		]);
		for (const line of step.replies) adapter.sent(line);
		const initialize = JSON.parse(step.replies[0]!) as { request_id: string };
		adapter.received(
			json({
				type: "control_response",
				response: {
					subtype: "success",
					request_id: initialize.request_id,
					response: { commands: [], models: [] },
				},
			}),
		);
		expect(adapter.transcript.state).toEqual({ phase: "ready", turn: "none" });
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

	it("covers stream events, deltas and content blocks", () => {
		const adapter = inTurn();
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
			'claude 2.1.0 printed a "delta/sparkle_delta" event DevHub does not know',
			'claude 2.1.0 printed a "stream_event/novel_event" event DevHub does not know',
			'claude 2.1.0 printed a "content/hologram_block" event DevHub does not know',
		]);
	});

	it("is, for a system event, a quiet report of the event, once per subtype, with the event under it", () => {
		const adapter = inTurn();
		const raw = {
			type: "system",
			subtype: "weather",
			forecast: "sunny",
			session_id: "s",
		};
		adapter.received(json(raw));
		adapter.received(json({ ...raw, forecast: "rain" }));
		const notices = adapter.transcript.entries.filter(
			(each) => each.kind === "notice",
		);
		expect(notices).toEqual([
			{
				kind: "notice",
				id: expect.any(String),
				parent: null,
				level: "info",
				text: 'claude 2.1.0 reported "weather"',
				raw,
			},
		]);
	});

	it("still breaks the conversation for a system event without a subtype", () => {
		const adapter = inTurn();
		expect(() =>
			adapter.received(json({ type: "system", session_id: "s" })),
		).toThrow(ProtocolMismatch);
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

describe("an MCP server's elicitation", () => {
	function elicit(
		adapter: ClaudeAdapter,
		request: Record<string, unknown>,
	): PendingRequest {
		const step = adapter.received(
			json({
				type: "control_request",
				request_id: "el-1",
				request: {
					subtype: "elicitation",
					mcp_server_name: "tickets",
					...request,
				},
			}),
		);
		expect(step.replies).toEqual([]);
		return adapter.transcript.requests[0]!;
	}

	function answered(adapter: ClaudeAdapter, answer: RequestAnswer): unknown {
		const [line] = perform(adapter, {
			kind: "answer",
			request: requestId("el-1"),
			answer,
		});
		return JSON.parse(line!);
	}

	it("is the card Codex's is: its form, then Decline and Cancel, and no remembering", () => {
		const adapter = inTurn();
		const request = elicit(adapter, {
			message: "File a ticket",
			mode: "form",
			requested_schema: {
				type: "object",
				properties: {
					title: { type: "string", title: "Title" },
					count: { type: "integer", minimum: 1 },
				},
				required: ["title"],
			},
		});
		expect(request).toEqual({
			id: requestId("el-1"),
			entry: undefined,
			subject: {
				kind: "elicitation",
				server: "tickets",
				message: "File a ticket",
				url: undefined,
				fields: [
					{
						key: "title",
						label: "Title",
						description: undefined,
						required: true,
						input: {
							kind: "text",
							format: undefined,
							minLength: undefined,
							maxLength: undefined,
							default: undefined,
						},
					},
					{
						key: "count",
						label: "count",
						description: undefined,
						required: false,
						input: {
							kind: "number",
							integer: true,
							minimum: 1,
							maximum: undefined,
							default: undefined,
						},
					},
				],
			},
			choices: [
				{ id: "decline", label: "Decline", tone: "deny", takesText: false },
				{ id: "cancel", label: "Cancel", tone: "neutral", takesText: false },
			],
		});
	});

	it("is accepted by its form, answered as an ElicitResult with the content typed, and closes", () => {
		const adapter = inTurn();
		elicit(adapter, {
			message: "File a ticket",
			requested_schema: {
				type: "object",
				properties: {
					title: { type: "string" },
					count: { type: "integer" },
				},
			},
		});
		expect(
			answered(adapter, {
				kind: "answers",
				values: { title: "Login fails", count: "3" },
			}),
		).toEqual({
			type: "control_response",
			response: {
				subtype: "success",
				request_id: "el-1",
				response: {
					action: "accept",
					content: { title: "Login fails", count: 3 },
				},
			},
		});
		expect(adapter.transcript.requests).toEqual([]);
	});

	it("with no schema is a plain confirmation, accepted with empty content", () => {
		const adapter = inTurn();
		const request = elicit(adapter, { message: "Go on?" });
		expect(request.subject).toMatchObject({ fields: [], url: undefined });
		expect(answered(adapter, { kind: "answers", values: {} })).toMatchObject({
			response: { response: { action: "accept", content: {} } },
		});
	});

	it.each(["decline", "cancel"] as const)(
		"answers %s with no content",
		(action) => {
			const adapter = inTurn();
			elicit(adapter, {
				message: "Go on?",
				requested_schema: { type: "object", properties: {} },
			});
			expect(
				answered(adapter, {
					kind: "choice",
					choiceId: action,
					text: undefined,
				}),
			).toMatchObject({ response: { response: { action } } });
			expect(adapter.transcript.requests).toEqual([]);
		},
	);

	it("of a page to visit shows the page and is accepted with no content", () => {
		const adapter = inTurn();
		const request = elicit(adapter, {
			message: "Sign in to the tracker",
			mode: "url",
			url: "https://tracker.example.com/auth",
			elicitation_id: "e-1",
		});
		expect(request.subject).toEqual({
			kind: "elicitation",
			server: "tickets",
			message: "Sign in to the tracker",
			url: "https://tracker.example.com/auth",
			fields: [],
		});
		expect(answered(adapter, { kind: "answers", values: {} })).toMatchObject({
			response: { response: { action: "accept" } },
		});
	});

	it("refuses an answer it did not offer, and a form sent unfinished", () => {
		const adapter = inTurn();
		elicit(adapter, {
			message: "File a ticket",
			requested_schema: {
				type: "object",
				properties: { title: { type: "string" } },
				required: ["title"],
			},
		});
		expect(() =>
			adapter.encode({
				kind: "answer",
				request: requestId("el-1"),
				answer: {
					kind: "choice",
					choiceId: "remember:session",
					text: undefined,
				},
			}),
		).toThrow(/has no choice/);
		const fresh = inTurn();
		elicit(fresh, {
			message: "File a ticket",
			requested_schema: {
				type: "object",
				properties: { title: { type: "string" } },
				required: ["title"],
			},
		});
		expect(() =>
			fresh.encode({
				kind: "answer",
				request: requestId("el-1"),
				answer: { kind: "answers", values: { title: "" } },
			}),
		).toThrow(/sent unfinished/);
	});

	it("closes when the CLI cancels it", () => {
		const adapter = inTurn();
		elicit(adapter, { message: "Go on?" });
		adapter.received(
			json({ type: "control_cancel_request", request_id: "el-1" }),
		);
		expect(adapter.transcript.requests).toEqual([]);
	});

	it("of a mode DevHub does not know is a mismatch, not a refusal", () => {
		expect(() =>
			elicit(inTurn(), { message: "Go on?", mode: "openai/form" }),
		).toThrow(/control_request\.request\.mode/);
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
			// The captured result carries Bash's own account (stdout apart).
			output: [
				{
					kind: "command",
					exitCode: undefined,
					output: "/home/testuser/project",
					stderr: undefined,
					interrupted: false,
				},
			],
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

describe("the model a session reports, against the models the handshake listed", () => {
	const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
	function listed(
		value: string,
		resolvedModel: string,
		efforts?: readonly string[],
	) {
		return {
			value,
			displayName: `${value} (label)`,
			description: "",
			resolvedModel,
			...(efforts === undefined ? {} : { supportedEffortLevels: efforts }),
		};
	}
	/** A CLI whose `model` setting is `opus[1m]` lists the 1M variant. */
	const WITH_1M = [
		listed("default", "claude-opus-5-5[1m]", EFFORTS),
		listed("opus[1m]", "claude-opus-5-5[1m]", EFFORTS),
		listed("sonnet", "claude-sonnet-5", EFFORTS),
		listed("haiku", "claude-haiku-4-5-20251001"),
	];
	/** One whose setting is plain `opus` lists no 1M variant. */
	const WITHOUT_1M = [
		listed("default", "claude-opus-5-5", EFFORTS),
		listed("opus", "claude-opus-5-5", EFFORTS),
		listed("sonnet", "claude-sonnet-5", EFFORTS),
		listed("haiku", "claude-haiku-4-5-20251001"),
	];

	/** Answer the `initialize` DevHub wrote with this list. */
	function answer(
		adapter: ClaudeAdapter,
		written: readonly string[],
		models: readonly unknown[],
	): void {
		for (const line of written) adapter.sent(line);
		const request = written
			.map((line) => JSON.parse(line))
			.find((line) => line.request?.subtype === "initialize");
		adapter.received(
			json({
				type: "control_response",
				response: {
					subtype: "success",
					request_id: request.request_id,
					response: { commands: [], models },
				},
			}),
		);
	}

	function started(models: readonly unknown[], model: string): ClaudeAdapter {
		const adapter = new ClaudeAdapter("boot");
		answer(adapter, adapter.opening(), models);
		adapter.received(init({ model }));
		return adapter;
	}

	it("is the listed choice that resolves to it, [1m] included, on a fresh start", () => {
		const { session } = started(WITH_1M, "claude-opus-5-5[1m]").transcript;
		expect(session.model.current).toBe("opus[1m]");
		expect(session.model.choices.map((choice) => choice.id)).toEqual([
			"default",
			"opus[1m]",
			"sonnet",
			"haiku",
		]);
		expect(session.effort).toEqual({
			current: undefined,
			choices: EFFORTS.map((level) => ({ id: level, label: level })),
		});
	});

	it("is a choice of its own when a resumed session keeps a [1m] model the list does not offer, with that model's effort levels", () => {
		// Started on a resumed session (Continue in GUI, `--resume`): the
		// session keeps its transcript's model, whatever the setting is.
		const { session } = started(WITHOUT_1M, "claude-opus-5-5[1m]").transcript;
		expect(session.model.current).toBe("claude-opus-5-5[1m]");
		expect(session.model.choices[0]).toEqual({
			id: "claude-opus-5-5[1m]",
			label: "claude-opus-5-5[1m]",
		});
		expect(session.model.choices.slice(1).map((choice) => choice.id)).toEqual([
			"default",
			"opus",
			"sonnet",
			"haiku",
		]);
		expect(session.effort).toEqual({
			current: undefined,
			choices: EFFORTS.map((level) => ({ id: level, label: level })),
		});
	});

	it("reads the same after /resume switches the CLI to a session on a model the list does not offer", () => {
		const adapter = started(WITHOUT_1M, "claude-opus-5-5");
		expect(adapter.transcript.session.model.current).toBe("opus");
		const step = adapter.received(
			json({ type: "devhub_resume", session: "other" }),
		);
		answer(adapter, step.replies, WITHOUT_1M);
		adapter.received(
			init({ model: "claude-opus-5-5[1m]", session_id: "other" }),
		);
		const { session } = adapter.transcript;
		expect(session.model.current).toBe("claude-opus-5-5[1m]");
		expect(session.effort.choices.map((choice) => choice.id)).toEqual(EFFORTS);
		expect(session.effort.unchangeable).toBeUndefined();
	});

	it("takes the session's own model back with set_model, and reads it as the resume did", () => {
		const adapter = started(WITHOUT_1M, "claude-opus-5-5[1m]");
		const request = (line: string) => JSON.parse(line).request_id as string;
		const agreed = (line: string) =>
			adapter.received(
				json({
					type: "control_response",
					response: { subtype: "success", request_id: request(line) },
				}),
			);
		agreed(configure(adapter, "model", "opus")[0]!);
		expect(adapter.transcript.session.model.current).toBe("opus");
		expect(adapter.transcript.session.model.choices[0]?.id).toBe("default");
		const [back] = configure(adapter, "model", "claude-opus-5-5[1m]");
		expect(JSON.parse(back!).request).toEqual({
			subtype: "set_model",
			model: "claude-opus-5-5[1m]",
		});
		agreed(back!);
		const { session } = adapter.transcript;
		expect(session.model.current).toBe("claude-opus-5-5[1m]");
		expect(session.effort.choices.map((choice) => choice.id)).toEqual(EFFORTS);
	});

	it("says why the effort can't be changed for a model the list names in no form", () => {
		const { session } = started(WITHOUT_1M, "claude-opus-4-1").transcript;
		expect(session.model.current).toBe("claude-opus-4-1");
		expect(session.model.choices[0]).toEqual({
			id: "claude-opus-4-1",
			label: "claude-opus-4-1",
		});
		expect(session.effort.choices).toEqual([]);
		expect(session.effort.unchangeable).toContain("claude-opus-4-1");
	});

	it("reads every choice, and so the current one, by the full model name it resolves to, the value /model takes beside it when that differs", () => {
		const { session } = started(WITH_1M, "claude-opus-5-5[1m]").transcript;
		expect(session.model.choices).toEqual([
			{
				id: "default",
				label: "claude-opus-5-5[1m] (default)",
				detail: "default (label)",
			},
			{
				id: "opus[1m]",
				label: "claude-opus-5-5[1m] (opus[1m])",
				detail: "opus[1m] (label)",
			},
			{
				id: "sonnet",
				label: "claude-sonnet-5 (sonnet)",
				detail: "sonnet (label)",
			},
			{
				id: "haiku",
				label: "claude-haiku-4-5-20251001 (haiku)",
				detail: "haiku (label)",
			},
		]);
		expect(
			session.model.choices.find(
				(choice) => choice.id === session.model.current,
			)?.label,
		).toBe("claude-opus-5-5[1m] (opus[1m])");
	});

	it("is the effort system/init says the session runs at, when the CLI says it", () => {
		const adapter = started(WITH_1M, "claude-opus-5-5[1m]");
		expect(adapter.transcript.session.effort.current).toBeUndefined();
		adapter.received(init({ model: "claude-opus-5-5[1m]", effort: "xhigh" }));
		expect(adapter.transcript.session.effort.current).toBe("xhigh");
		// A later init that does not say keeps what is known.
		adapter.received(init({ model: "claude-opus-5-5[1m]" }));
		expect(adapter.transcript.session.effort.current).toBe("xhigh");
	});

	it("offers no effort, and says nothing, for a listed model that takes none", () => {
		const { session } = started(
			WITH_1M,
			"claude-haiku-4-5-20251001",
		).transcript;
		expect(session.model.current).toBe("haiku");
		expect(session.effort).toEqual({ current: undefined, choices: [] });
	});
});

describe("a message being sent", () => {
	it("is sending from its write until the CLI's echo makes it an entry, in one step", () => {
		const adapter = new ClaudeAdapter("boot");
		adapter.received(init());
		perform(adapter, {
			kind: "send",
			text: "go",
			images: [],
			origin: "person",
		});
		expect(adapter.transcript.sending).toEqual([
			{ id: "sent:1", text: "go", images: [], origin: "person" },
		]);
		expect(adapter.transcript.entries).toEqual([]);
		const step = adapter.received(echo("go", "u-go"));
		expect(adapter.transcript.sending).toEqual([]);
		expect(entry(adapter, "user:u-go")).toMatchObject({ text: "go" });
		// The entry comes before the sending list lets go of it.
		expect(step.events.map((event) => event.type).slice(0, 2)).toEqual([
			"entry",
			"sending",
		]);
	});

	it("is sending again on a replay that has its write and no echo yet", () => {
		const live = new ClaudeAdapter("boot");
		const greeting = init();
		live.received(greeting);
		const written = perform(live, {
			kind: "send",
			images: [],
			text: "go",
			origin: "person",
		});
		const replayed = new ClaudeAdapter("replay");
		replayed.received(greeting);
		for (const line of written) replayed.sent(line);
		expect(replayed.transcript.sending).toEqual(live.transcript.sending);
		expect(replayed.transcript.sending).toHaveLength(1);
	});

	it("is dropped with everything else the old CLI had when it is started again", () => {
		const adapter = new ClaudeAdapter("boot");
		adapter.received(init());
		perform(adapter, {
			kind: "send",
			text: "go",
			images: [],
			origin: "person",
		});
		adapter.received(json({ type: "devhub_resume", session: "other" }));
		expect(adapter.transcript.sending).toEqual([]);
	});
});

describe("a usage limit", () => {
	it("keeps each window's length, decided from its key: five_hour and seven_day, and none for a key of no documented length", () => {
		const adapter = inTurn();
		adapter.received(
			json({
				type: "rate_limit_event",
				rate_limit_info: {
					status: "allowed",
					unifiedWindows: {
						five_hour: { utilization: 0.1, resetsAt: 1_800_000_000 },
						seven_day: { utilization: 0.2, resetsAt: 1_800_000_100 },
						seven_day_opus: { utilization: 0.3, resetsAt: 1_800_000_200 },
					},
				},
				session_id: SESSION,
			}),
		);
		expect(
			adapter.transcript.usage?.rateLimits?.map(
				({ window, durationMinutes }) => ({ window, durationMinutes }),
			),
		).toEqual([
			{ window: "5-hour", durationMinutes: 300 },
			{ window: "7-day", durationMinutes: 10_080 },
			{ window: "seven day opus", durationMinutes: undefined },
		]);
	});

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
			perform(adapter, {
				kind: "send",
				text: "again",
				images: [],
				origin: "person",
			}),
		).toHaveLength(1);
	});
});

describe("a turn a usage limit stopped", () => {
	const RESETS = 1_800_000_000;
	const rejected = (fields: Record<string, unknown> = {}) =>
		json({
			type: "rate_limit_event",
			rate_limit_info: {
				status: "rejected",
				resetsAt: RESETS,
				rateLimitType: "five_hour",
				...fields,
			},
			session_id: SESSION,
		});
	const limitAnswer = assistantLine(
		"m",
		[{ type: "text", text: "You've hit your limit · resets 3am" }],
		null,
		{ error: "rate_limit" },
	);
	const lastEnd = (adapter: ClaudeAdapter) =>
		adapter.transcript.entries.findLast((each) => each.kind === "turn-end");

	it("ends with the limit and the reset of the window that stopped it", () => {
		const adapter = inTurn();
		adapter.received(rejected());
		adapter.received(limitAnswer);
		adapter.received(
			result({ is_error: true, result: "You've hit your limit" }),
		);
		expect(lastEnd(adapter)).toMatchObject({
			outcome: "failed",
			limit: { resetsAt: RESETS * 1000 },
		});
	});

	it("is a limit on the model's limit answer alone, its reset from a used-up window", () => {
		const adapter = inTurn();
		adapter.received(
			json({
				type: "rate_limit_event",
				rate_limit_info: {
					status: "allowed_warning",
					unifiedWindows: {
						five_hour: { utilization: 1, resetsAt: RESETS },
						seven_day: { utilization: 0.4, resetsAt: RESETS + 99 },
					},
				},
				session_id: SESSION,
			}),
		);
		adapter.received(limitAnswer);
		adapter.received(
			result({ is_error: true, result: "You've hit your limit" }),
		);
		expect(
			lastEnd(adapter)?.kind === "turn-end" && lastEnd(adapter)?.limit,
		).toEqual({ resetsAt: RESETS * 1000 });
	});

	it("learns its reset from a refusal the CLI reports after the turn ended", () => {
		const adapter = inTurn();
		adapter.received(limitAnswer);
		adapter.received(
			result({ is_error: true, result: "You've hit your limit" }),
		);
		expect(lastEnd(adapter)).toMatchObject({ limit: { resetsAt: undefined } });
		adapter.received(rejected());
		expect(lastEnd(adapter)).toMatchObject({
			limit: { resetsAt: RESETS * 1000 },
		});
	});

	it("is not a turn that failed otherwise, nor one the person stopped", () => {
		const failed = inTurn();
		failed.received(result({ is_error: true, result: "Something broke" }));
		expect(lastEnd(failed)).toMatchObject({ limit: undefined });

		const stopped = inTurn();
		stopped.received(rejected());
		perform(stopped, { kind: "interrupt" });
		stopped.received(result({ is_error: true, result: "interrupted" }));
		expect(lastEnd(stopped)).toMatchObject({
			outcome: "interrupted",
			limit: undefined,
		});
	});

	it("is not carried into the next turn", () => {
		const adapter = inTurn();
		adapter.received(rejected());
		adapter.received(result());
		perform(adapter, {
			kind: "send",
			text: "more",
			images: [],
			origin: "person",
		});
		adapter.received(echo("more", "u-more"));
		adapter.received(result({ is_error: true, result: "Something broke" }));
		expect(lastEnd(adapter)).toMatchObject({ limit: undefined });
	});

	it("is gone on with by a message sent for the person, which says so, live and replayed", () => {
		const adapter = inTurn();
		adapter.received(rejected());
		adapter.received(limitAnswer);
		adapter.received(
			result({ is_error: true, result: "You've hit your limit" }),
		);
		const written = perform(adapter, {
			kind: "send",
			text: "続けて",
			images: [],
			origin: "after-limit",
		});
		expect(adapter.transcript.sending).toMatchObject([
			{ text: "続けて", origin: "after-limit" },
		]);
		const replayed = new ClaudeAdapter("replay");
		replayed.received(init());
		for (const line of written) replayed.sent(line);
		expect(replayed.transcript.sending).toMatchObject([
			{ text: "続けて", origin: "after-limit" },
		]);
		adapter.received(echo("続けて", "u-resume"));
		expect(adapter.transcript.entries.at(-1)).toMatchObject({
			kind: "user",
			text: "続けて",
			origin: "after-limit",
		});
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
		perform(adapter, {
			kind: "send",
			text: "next",
			images: [],
			origin: "person",
		});
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
			output: [{ kind: "command", output: "main.ts" }],
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
		perform(adapter, {
			kind: "send",
			text: "first",
			images: [],
			origin: "person",
		});
		adapter.received(echo("first", "u1"));
		adapter.received(
			assistantLine("msg_1", [TEXT("one")], null, { uuid: "a1" }),
		);
		adapter.received(result());
		perform(adapter, {
			kind: "send",
			text: "second",
			images: [],
			origin: "person",
		});
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
		const greetings = step.replies.map((line) => JSON.parse(line));
		expect(greetings).toEqual([
			{
				type: "control_request",
				request_id: expect.stringMatching(/^boot:\d+$/u),
				request: { subtype: "initialize" },
			},
		]);
		for (const line of step.replies) adapter.sent(line);
		adapter.received(initialized(greetings[0].request_id));
		expect(adapter.transcript.state).toEqual({ phase: "ready", turn: "none" });

		perform(adapter, {
			kind: "send",
			text: "second, again",
			images: [],
			origin: "person",
		});
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
		perform(adapter, {
			kind: "send",
			text: "first",
			images: [],
			origin: "person",
		});
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
		perform(adapter, {
			kind: "send",
			text: "next",
			images: [],
			origin: "person",
		});
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
		perform(three, {
			kind: "send",
			text: "third",
			images: [],
			origin: "person",
		});
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
		perform(adapter, {
			kind: "send",
			text: "third",
			images: [],
			origin: "person",
		});
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
		const idle = adapter.encode({
			kind: "send",
			text: "go",
			images: [],
			origin: "person",
		});
		expect(JSON.parse(idle[0]!)).not.toHaveProperty("priority");
		perform(adapter, {
			kind: "send",
			text: "go",
			images: [],
			origin: "person",
		});
		adapter.received(echo("go", "u1"));
		const midTurn = adapter.encode({
			kind: "send",
			images: [],
			text: "and also this",
			origin: "person",
		});
		expect(JSON.parse(midTurn[0]!)).toMatchObject({
			type: "user",
			priority: "next",
			message: { content: "and also this" },
		});
		// It is the person's like any other once the CLI takes it.
		perform(adapter, {
			kind: "send",
			text: "and also this",
			images: [],
			origin: "person",
		});
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
		perform(adapter, {
			kind: "send",
			text: "first",
			images: [],
			origin: "person",
		});
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
				request_id: expect.stringMatching(/^boot:\d+$/u),
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
					request_id: JSON.parse(step.replies[0]!).request_id,
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
		perform(adapter, {
			kind: "send",
			text: "first",
			images: [],
			origin: "person",
		});
		adapter.received(echo("first", "u1"));
		expect(() => adapter.resumeSession(OTHER, [])).toThrow(/not idle/);
	});
});

describe("restarting the session", () => {
	it("starts the CLI again on the session it is on, with the restart mark between the two", () => {
		const adapter = inTurn();
		expect(adapter.restart()).toEqual({
			kind: "restart",
			session: ["--resume", SESSION],
			mark: [RESTART_MARK],
		});
		// Nothing changes until the host puts the mark in the journal.
		expect(adapter.transcript.state).toEqual({
			phase: "ready",
			turn: "running",
		});
	});

	it("starts a CLI that has named no session yet on a new one", () => {
		expect(new ClaudeAdapter("boot").restart()).toEqual({
			kind: "restart",
			session: [],
			mark: [RESTART_MARK],
		});
	});

	it("keeps the conversation, stops what the CLI had going under a quiet divider, and greets the new CLI", () => {
		const adapter = askingForBash();
		const step = adapter.received(RESTART_MARK);
		expect(step.events).toContainEqual({ type: "restarted" });
		const { transcript } = adapter;
		expect(entry(adapter, "user:u-go")).toMatchObject({ text: "go" });
		expect((entry(adapter, "tool:toolu_1") as ToolEntry).status).toBe(
			"interrupted",
		);
		expect(transcript.requests).toEqual([]);
		expect(transcript.entries.at(-1)).toMatchObject({
			kind: "notice",
			level: "info",
			text: RESTARTED,
		});
		expect(transcript.session.sessionId).toBe(SESSION);
		expect(transcript.state).toEqual({ phase: "ready", turn: "rewinding" });
		expect(step.replies.map((line) => JSON.parse(line))).toEqual([
			{
				type: "control_request",
				request_id: "boot:1",
				request: { subtype: "initialize" },
			},
		]);
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
		// The new CLI offers the commands again, DevHub's own with them.
		expect(
			adapter.transcript.session.commands.find(
				(command) => command.name === "restart",
			),
		).toMatchObject({ trigger: "/", route: "restart" });
	});
});

describe("what a tool gave back", () => {
	/** A tool_result for `toolUseId`, with its content as the CLI gives it and the tool's own account. */
	function resultOf(
		toolUseId: string,
		content: unknown,
		{
			isError = false,
			toolUseResult,
		}: { isError?: boolean; toolUseResult?: unknown } = {},
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
			...(toolUseResult === undefined
				? {}
				: { tool_use_result: toolUseResult }),
		});
	}

	function called(name: string, input: Record<string, unknown>): ClaudeAdapter {
		const adapter = inTurn();
		adapter.received(assistantLine("msg_t", [toolUse("toolu_t", name, input)]));
		return adapter;
	}

	function output(adapter: ClaudeAdapter): ToolEntry["output"] {
		return (entry(adapter, "tool:toolu_t") as ToolEntry).output;
	}

	const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";

	const change = (adapter: ClaudeAdapter) =>
		(entry(adapter, "tool:toolu_t") as ToolEntry).change;

	it("is an Edit's change from its input while it runs, and the CLI's patch, with its line numbers, once done", () => {
		const adapter = called("Edit", {
			file_path: "/home/testuser/project/src/x.ts",
			old_string: "const a = 1;",
			new_string: "const a = 2;",
		});
		expect(change(adapter)).toEqual([
			{
				path: "/home/testuser/project/src/x.ts",
				unifiedDiff: "@@\n-const a = 1;\n+const a = 2;",
			},
		]);
		adapter.received(
			resultOf("toolu_t", "The file has been updated.", {
				toolUseResult: {
					filePath: "/home/testuser/project/src/x.ts",
					oldString: "const a = 1;",
					newString: "const a = 2;",
					structuredPatch: [
						{
							oldStart: 3,
							oldLines: 1,
							newStart: 3,
							newLines: 1,
							lines: ["-const a = 1;", "+const a = 2;"],
						},
					],
				},
			}),
		);
		expect(change(adapter)).toEqual([
			{
				path: "/home/testuser/project/src/x.ts",
				unifiedDiff: "@@ -3,1 +3,1 @@\n-const a = 1;\n+const a = 2;",
			},
		]);
		// The result's words stay its output; the change is not repeated there.
		expect(output(adapter)).toEqual([
			{ kind: "text", text: "The file has been updated." },
		]);
	});

	it("is an edit's change from its input when the CLI gave no patch: Edit, MultiEdit, and a Write of a new file", () => {
		const edit = called("Edit", {
			file_path: "src/x.ts",
			old_string: "a\nb",
			new_string: "c",
		});
		edit.received(resultOf("toolu_t", "The file has been updated."));
		expect(change(edit)).toEqual([
			{ path: "src/x.ts", unifiedDiff: "@@\n-a\n-b\n+c" },
		]);
		const multi = called("MultiEdit", {
			file_path: "src/y.ts",
			edits: [
				{ old_string: "one", new_string: "1" },
				{ old_string: "two", new_string: "2" },
			],
		});
		multi.received(resultOf("toolu_t", "Applied 2 edits."));
		expect(change(multi)).toEqual([
			{ path: "src/y.ts", unifiedDiff: "@@\n-one\n+1\n@@\n-two\n+2" },
		]);
		const write = called("Write", {
			file_path: "notes.md",
			content: "# Notes\nhi",
		});
		write.received(
			resultOf("toolu_t", "File created.", {
				toolUseResult: {
					type: "create",
					filePath: "notes.md",
					content: "# Notes\nhi",
					structuredPatch: [],
				},
			}),
		);
		expect(change(write)).toEqual([
			{ path: "notes.md", unifiedDiff: "@@\n+# Notes\n+hi" },
		]);
	});

	it("is a failed edit's own words, beside the change it meant to make", () => {
		const adapter = called("Edit", {
			file_path: "src/x.ts",
			old_string: "a",
			new_string: "b",
		});
		adapter.received(
			resultOf("toolu_t", "String to replace not found in file.", {
				isError: true,
				toolUseResult: "Error: String to replace not found in file.",
			}),
		);
		expect(output(adapter)).toEqual([
			{ kind: "text", text: "String to replace not found in file." },
		]);
		// What it meant to change is still what the call was.
		expect(change(adapter)).toEqual([
			{ path: "src/x.ts", unifiedDiff: "@@\n-a\n+b" },
		]);
	});

	it("is a command's output with stderr apart, and whether it was interrupted", () => {
		const adapter = called("Bash", { command: "make" });
		adapter.received(
			resultOf("toolu_t", "built\nwarning: old", {
				toolUseResult: {
					stdout: "built",
					stderr: "warning: old",
					interrupted: true,
					isImage: false,
				},
			}),
		);
		expect(output(adapter)).toEqual([
			{
				kind: "command",
				exitCode: undefined,
				output: "built",
				stderr: "warning: old",
				interrupted: true,
			},
		]);
	});

	it("is a failed command's exit code and output, read from the words the CLI gives the model", () => {
		const adapter = called("Bash", { command: "npm test" });
		adapter.received(
			resultOf("toolu_t", "Exit code 2\n1 test failed", {
				isError: true,
				toolUseResult: "Error: Exit code 2\n1 test failed",
			}),
		);
		expect(output(adapter)).toEqual([
			{
				kind: "command",
				exitCode: 2,
				output: "1 test failed",
				stderr: undefined,
				interrupted: false,
			},
		]);
		expect((entry(adapter, "tool:toolu_t") as ToolEntry).status).toBe("failed");
	});

	it("is output too large for the conversation, as the CLI's note of where it saved it and the start it kept", () => {
		const adapter = called("Bash", { command: "cat big.log" });
		adapter.received(
			resultOf(
				"toolu_t",
				"<persisted-output>\nOutput too large (60KB). Full output saved to: /home/testuser/.claude/out/abc.txt\n\nPreview (first 2KB):\nline 1\nline 2\n</persisted-output>",
				{
					toolUseResult: {
						stdout: "line 1\nline 2\n…",
						stderr: "",
						interrupted: false,
						persistedOutputPath: "/home/testuser/.claude/out/abc.txt",
						persistedOutputSize: 61440,
					},
				},
			),
		);
		expect(output(adapter)).toEqual([
			{
				kind: "persisted",
				note: "Output too large (60KB). Full output saved to: /home/testuser/.claude/out/abc.txt",
				path: "/home/testuser/.claude/out/abc.txt",
				preview: "line 1\nline 2",
			},
		]);
	});

	it("keeps an image and a tool reference in the order the tool gave them, beside its words", () => {
		const adapter = called("mcp__browser__screenshot", { tabId: 1 });
		adapter.received(
			resultOf(
				"toolu_t",
				[
					{ type: "text", text: "Captured the page." },
					{
						type: "image",
						source: { type: "base64", media_type: "image/png", data: PNG },
					},
					{ type: "tool_reference", tool_name: "mcp__browser__click" },
				],
				{ toolUseResult: [{ type: "text", text: "Captured the page." }] },
			),
		);
		expect(output(adapter)).toEqual([
			{ kind: "text", text: "Captured the page." },
			{
				kind: "image",
				image: {
					mediaType: "image/png",
					source: { kind: "data", base64: PNG },
					label: "image",
				},
			},
			{ kind: "reference", name: "mcp__browser__click" },
		]);
		expect(
			adapter.transcript.entries.filter((each) => each.kind === "notice"),
		).toEqual([]);
	});

	it("says once that a tool result held a block DevHub does not know, never dropping it in silence", () => {
		const adapter = called("Read", { file_path: "a.bin" });
		adapter.received(
			resultOf("toolu_t", [
				{ type: "text", text: "read" },
				{ type: "hologram", data: "…" },
			]),
		);
		const notices = adapter.transcript.entries.filter(
			(each): each is NoticeEntry => each.kind === "notice",
		);
		expect(notices.map((each) => [each.level, each.text])).toEqual([
			[
				"warning",
				'claude 2.1.0 printed a "tool_result/hologram" event DevHub does not know',
			],
		]);
		expect(output(adapter)).toEqual([{ kind: "text", text: "read" }]);
	});

	it("reads a result whose own account is the error's words as no launch, not as a mismatch", () => {
		const adapter = called("Agent", { description: "look", prompt: "look" });
		adapter.received(
			resultOf("toolu_t", "User rejected the call.", {
				isError: true,
				toolUseResult: "User rejected the call.",
			}),
		);
		expect(entry(adapter, "tool:toolu_t")).toMatchObject({
			status: "failed",
			spawns: { state: "failed" },
		});
	});
});

describe("images the person put in a message", () => {
	const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";

	it("are on the message's entry, with its words, when the CLI echoes it", () => {
		const adapter = new ClaudeAdapter("boot");
		adapter.received(init());
		perform(adapter, {
			kind: "send",
			text: "what is this?",
			images: [],
			origin: "person",
		});
		adapter.received(
			json({
				type: "user",
				message: {
					role: "user",
					content: [
						{
							type: "image",
							source: { type: "base64", media_type: "image/png", data: PNG },
						},
						{ type: "text", text: "what is this?" },
					],
				},
				parent_tool_use_id: null,
				session_id: SESSION,
				uuid: "u-img",
			}),
		);
		expect(entry(adapter, "user:u-img")).toMatchObject({
			text: "what is this?",
			images: [
				{
					mediaType: "image/png",
					source: { kind: "data", base64: PNG },
				},
			],
		});
		expect(adapter.transcript.sending).toEqual([]);
	});
});

describe("images the person sends", () => {
	const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";
	const IMAGE = {
		mediaType: "image/png",
		source: { kind: "data", base64: PNG },
		label: "shot.png",
	} as const;

	it("are written as image blocks before the words, and the message is sending with them until its echo", () => {
		const adapter = new ClaudeAdapter("boot");
		adapter.received(init());
		const [line] = perform(adapter, {
			kind: "send",
			text: "what is this?",
			origin: "person",
			images: [IMAGE],
		});
		expect(JSON.parse(line!)).toMatchObject({
			type: "user",
			message: {
				role: "user",
				content: [
					{
						type: "image",
						source: { type: "base64", media_type: "image/png", data: PNG },
					},
					{ type: "text", text: "what is this?" },
				],
			},
		});
		// What was written is what it is known by: the API's block names no file.
		expect(adapter.transcript.sending).toEqual([
			{
				id: "sent:1",
				text: "what is this?",
				images: [{ ...IMAGE, label: "image" }],
				origin: "person",
			},
		]);
		adapter.received(
			json({
				type: "user",
				message: JSON.parse(line!).message,
				parent_tool_use_id: null,
				session_id: SESSION,
				uuid: "u-img",
			}),
		);
		expect(adapter.transcript.sending).toEqual([]);
		expect(entry(adapter, "user:u-img")).toMatchObject({
			text: "what is this?",
			images: [
				{ mediaType: "image/png", source: { kind: "data", base64: PNG } },
			],
		});
	});

	it("can be sent without words", () => {
		const adapter = new ClaudeAdapter("boot");
		adapter.received(init());
		const [line] = perform(adapter, {
			kind: "send",
			text: "",
			origin: "person",
			images: [IMAGE],
		});
		expect(JSON.parse(line!).message.content).toEqual([
			{
				type: "image",
				source: { type: "base64", media_type: "image/png", data: PNG },
			},
		]);
	});

	it("are refused when the image is not the page's own bytes", () => {
		const adapter = new ClaudeAdapter("boot");
		adapter.received(init());
		expect(() =>
			adapter.encode({
				kind: "send",
				text: "x",
				origin: "person",
				images: [
					{
						mediaType: "image/png",
						source: { kind: "file", path: "/a.png" },
						label: "/a.png",
					},
				],
			}),
		).toThrow(/only an image's own bytes/);
	});
});

describe("a command run outside the sandbox", () => {
	it("is marked on its call, from the call's own input, and no other call is", () => {
		const adapter = inTurn();
		adapter.received(
			assistantLine("msg_s", [
				toolUse("toolu_off", "Bash", {
					command: "brew install jq",
					dangerouslyDisableSandbox: true,
				}),
				toolUse("toolu_on", "Bash", { command: "ls" }),
			]),
		);
		expect(entry(adapter, "tool:toolu_off")).toMatchObject({
			outsideSandbox: true,
		});
		expect(entry(adapter, "tool:toolu_on")).toMatchObject({
			outsideSandbox: false,
		});
	});
});

describe("a slash command and its output", () => {
	/** A user record of a session file, as `devhub_history` carries it. */
	function past(uuid: string, content: string): string {
		return json({
			type: "devhub_history",
			record: { type: "user", uuid, message: { role: "user", content } },
		});
	}

	function commands(adapter: ClaudeAdapter) {
		return adapter.transcript.entries.filter((each) => each.kind === "command");
	}

	it("is one compact entry, the command with its arguments and what it printed, with the caveat left out", () => {
		const adapter = new ClaudeAdapter("boot");
		adapter.received(
			past(
				"u1",
				"<local-command-caveat>Caveat: the messages below were generated by the user while running local commands.</local-command-caveat>",
			),
		);
		adapter.received(
			past(
				"u2",
				"<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>sonnet</command-args>",
			),
		);
		adapter.received(
			past(
				"u3",
				"<local-command-stdout>Set model to \u001b[1msonnet\u001b[22m</local-command-stdout>",
			),
		);
		expect(adapter.transcript.entries).toEqual([
			{
				kind: "command",
				id: "command:u2",
				parent: null,
				line: "/model sonnet",
				output: "Set model to sonnet",
				failed: false,
			},
		]);
	});

	it("says a command's error as failed, and a shell-mode command the same way", () => {
		const adapter = new ClaudeAdapter("boot");
		adapter.received(
			past(
				"u1",
				"<command-name>/nope</command-name>\n<command-args></command-args>",
			),
		);
		adapter.received(
			past(
				"u2",
				"<local-command-stderr>Unknown command: /nope</local-command-stderr>",
			),
		);
		adapter.received(past("u3", "<bash-input>ls src</bash-input>"));
		adapter.received(
			past(
				"u4",
				"<bash-stdout>main.ts</bash-stdout><bash-stderr></bash-stderr>",
			),
		);
		expect(commands(adapter)).toEqual([
			{
				kind: "command",
				id: "command:u1",
				parent: null,
				line: "/nope",
				output: "Unknown command: /nope",
				failed: true,
			},
			{
				kind: "command",
				id: "command:u3",
				parent: null,
				line: "! ls src",
				output: "main.ts",
				failed: false,
			},
		]);
	});

	it("is output alone when nothing said which command printed it", () => {
		const adapter = new ClaudeAdapter("boot");
		adapter.received(
			past("u1", "<local-command-stdout>Compacted.</local-command-stdout>"),
		);
		expect(commands(adapter)).toEqual([
			{
				kind: "command",
				id: "command:u1",
				parent: null,
				line: undefined,
				output: "Compacted.",
				failed: false,
			},
		]);
	});

	it("takes the echo of a command DevHub sent as that command, no longer sending", () => {
		const adapter = new ClaudeAdapter("boot");
		adapter.received(init());
		perform(adapter, {
			kind: "send",
			text: "/review 12",
			images: [],
			origin: "injection",
		});
		adapter.received(
			echo(
				"<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>12</command-args>",
				"u-cmd",
			),
		);
		expect(adapter.transcript.sending).toEqual([]);
		expect(commands(adapter)).toEqual([
			{
				kind: "command",
				id: "command:u-cmd",
				parent: null,
				line: "/review 12",
				output: undefined,
				failed: false,
			},
		]);
		expect(
			adapter.transcript.entries.filter((each) => each.kind === "notice"),
		).toEqual([]);
	});

	it("takes the echo of a command sent with spaces and a newline around its arguments as that command", () => {
		const adapter = new ClaudeAdapter("boot");
		adapter.received(init());
		perform(adapter, {
			kind: "send",
			text: "/review   12\n",
			images: [],
			origin: "injection",
		});
		adapter.received(
			echo(
				"<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>12</command-args>",
				"u-cmd",
			),
		);
		expect(adapter.transcript.sending).toEqual([]);
		expect(commands(adapter)).toMatchObject([{ line: "/review 12" }]);
	});

	it("is a command the CLI answered itself, in place, and the Agent idle again once the CLI says the command is done", () => {
		const adapter = new ClaudeAdapter("boot");
		const statuses: string[] = [];
		for (const { side, line } of fixture(
			"claude-local-command.handwritten.ndjson",
		)) {
			if (side === "sent") adapter.sent(line);
			else adapter.received(line);
			statuses.push(conversationStatus(adapter.transcript));
		}
		expect(adapter.transcript.sending).toEqual([]);
		expect(
			adapter.transcript.entries
				.filter((each) => each.kind !== "turn-end")
				.map((each) =>
					each.kind === "command"
						? ["command", each.line, each.output]
						: each.kind === "user"
							? ["user", each.text, each.origin]
							: [each.kind],
				),
		).toEqual([
			["command", "/mcp reconnect", "Reconnecting is not available here."],
			["user", "What changed?", "person"],
			["assistant"],
			["command", "/mcp", "2 MCP servers."],
		]);
		// Working from each send until its result, idle again after it.
		expect(statuses).toEqual([
			"unknown",
			"idle",
			"idle",
			...["working", "working", "working", "idle"],
			...["working", "working", "working", "working", "idle"],
			...["working", "working", "working", "idle"],
		]);
	});

	it("says a local command's error as failed, as the session file does", () => {
		const adapter = new ClaudeAdapter("boot");
		adapter.received(init());
		perform(adapter, {
			kind: "send",
			text: "/mcp nope",
			images: [],
			origin: "person",
		});
		adapter.received(
			assistantLine(
				"00000000-0000-4000-8000-0000000000e1",
				[{ type: "text", text: "Unknown subcommand." }],
				null,
				{
					uuid: "u-local",
					local_command_run: { command: "mcp", args: "nope" },
					local_command_source:
						"<local-command-stderr>Unknown subcommand.</local-command-stderr>",
				},
			),
		);
		expect(adapter.transcript.sending).toEqual([]);
		expect(commands(adapter)).toEqual([
			{
				kind: "command",
				id: "command:u-local",
				parent: null,
				line: "/mcp nope",
				output: "Unknown subcommand.",
				failed: true,
			},
		]);
	});
});

describe("the turn a message starts, ended by the CLI's result", () => {
	function status(fields: Record<string, unknown>): string {
		return json({
			type: "system",
			subtype: "status",
			session_id: SESSION,
			...fields,
		});
	}

	function boundary(metadata: Record<string, unknown>): string {
		return json({
			type: "system",
			subtype: "compact_boundary",
			session_id: SESSION,
			compact_metadata: metadata,
		});
	}

	function localResult(command: string, text = ""): string {
		return result({
			num_turns: 0,
			result: text,
			total_cost_usd: 0,
			local_command: command,
		});
	}

	function send(adapter: ClaudeAdapter, text: string): void {
		perform(adapter, { kind: "send", text, images: [], origin: "person" });
	}

	/** Each line received, with the Agent's status after it. */
	function statuses(
		adapter: ClaudeAdapter,
		lines: readonly string[],
	): string[] {
		return lines.map((line) => {
			adapter.received(line);
			return conversationStatus(adapter.transcript);
		});
	}

	function outline(adapter: ClaudeAdapter): string[] {
		return adapter.transcript.entries.map((each) => {
			switch (each.kind) {
				case "command":
					return `command: ${each.line}${each.output === undefined ? "" : ` -> ${each.output}`}${each.failed ? " (failed)" : ""}`;
				case "user":
					return `user(${each.origin}): ${each.text}`;
				case "compaction":
					return `compaction: ${each.trigger} ${each.preTokens} -> ${each.postTokens}`;
				case "turn-end":
					return `turn-end ${each.outcome}`;
				case "notice":
					return `notice(${each.level}): ${each.text}`;
				default:
					return each.kind;
			}
		});
	}

	function ready(): ClaudeAdapter {
		const adapter = new ClaudeAdapter("boot");
		adapter.received(init());
		return adapter;
	}

	it("is working from the write of /compact, shows the compaction while it runs, and is idle at the result, with no echo", () => {
		const adapter = ready();
		send(adapter, "/compact");
		expect(conversationStatus(adapter.transcript)).toBe("working");
		expect(adapter.transcript.compacting).toBe(false);
		adapter.received(init());
		adapter.received(status({ status: "compacting" }));
		expect(adapter.transcript.compacting).toBe(true);
		expect(conversationStatus(adapter.transcript)).toBe("working");
		adapter.received(
			boundary({ trigger: "manual", pre_tokens: 90000, post_tokens: 12000 }),
		);
		expect(adapter.transcript.compacting).toBe(false);
		expect(
			statuses(adapter, [
				status({ status: null, compact_result: "success" }),
				localResult("compact"),
			]),
		).toEqual(["working", "idle"]);
		expect(adapter.transcript.sending).toEqual([]);
		expect(outline(adapter)).toEqual([
			"compaction: manual 90000 -> 12000",
			"command: /compact",
			"turn-end completed",
		]);
	});

	it("takes an echoed /compact as the command, and is idle at the result that follows the boundary", () => {
		const adapter = ready();
		send(adapter, "/compact keep the plan");
		adapter.received(
			echo(
				"<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>keep the plan</command-args>",
				"u-compact",
			),
		);
		expect(adapter.transcript.sending).toEqual([]);
		expect(
			statuses(adapter, [
				status({ status: "compacting" }),
				boundary({ trigger: "manual", pre_tokens: 5000 }),
				localResult("compact"),
			]),
		).toEqual(["working", "working", "idle"]);
		expect(outline(adapter)).toEqual([
			"command: /compact keep the plan",
			"compaction: manual 5000 -> undefined",
			"turn-end completed",
		]);
	});

	it("says a compaction that failed, and the indicator ends with it", () => {
		const adapter = ready();
		send(adapter, "/compact");
		adapter.received(status({ status: "compacting" }));
		adapter.received(
			status({
				status: null,
				compact_result: "failed",
				compact_error: "The summary was too long.",
			}),
		);
		expect(adapter.transcript.compacting).toBe(false);
		adapter.received(localResult("compact"));
		expect(conversationStatus(adapter.transcript)).toBe("idle");
		expect(outline(adapter)).toEqual([
			"notice(error): Compacting the conversation failed: The summary was too long.",
			"command: /compact",
			"turn-end completed",
		]);
	});

	it("shows an automatic compaction inside a turn, which the turn's end ends in any case", () => {
		const adapter = inTurn();
		adapter.received(status({ status: "compacting" }));
		expect(adapter.transcript.compacting).toBe(true);
		adapter.received(result());
		expect(adapter.transcript.compacting).toBe(false);
		expect(conversationStatus(adapter.transcript)).toBe("idle");
	});

	it("is idle after each local command 2.1.284 answers without an echo, drawn in place: /compact with nothing to compact, /cost that runs usage, /clear", () => {
		const adapter = new ClaudeAdapter("boot");
		const seen: string[] = [];
		for (const { side, line } of fixture(
			"claude-local-command-2.1.284.handwritten.ndjson",
		)) {
			if (side === "sent") adapter.sent(line);
			else adapter.received(line);
			seen.push(conversationStatus(adapter.transcript));
		}
		expect(adapter.transcript.sending).toEqual([]);
		expect(outline(adapter)).toEqual([
			"command: /compact -> Error: Nothing to compact yet. (failed)",
			"turn-end completed",
			"command: /usage -> Current session: 1% used.",
			"turn-end completed",
			"notice(info): Context cleared: the model starts afresh from here.",
			"command: /clear",
			"turn-end completed",
		]);
		expect(seen).toEqual([
			"unknown",
			"idle",
			"idle",
			...["working", "working", "working", "idle"],
			...["working", "working", "working", "idle"],
			...["working", "working", "working", "idle"],
		]);
	});

	it("draws a command the CLI names nowhere as sent, with what the result said when the model was not asked", () => {
		const adapter = ready();
		send(adapter, "/context");
		adapter.received(init());
		adapter.received(localResult("context", "12k of 200k tokens."));
		expect(conversationStatus(adapter.transcript)).toBe("idle");
		expect(outline(adapter)).toEqual([
			"command: /context -> 12k of 200k tokens.",
			"turn-end completed",
		]);
	});

	it("is idle after an unknown command the CLI hands to the model, echoed or not", () => {
		const echoed = ready();
		send(echoed, "/nope");
		expect(
			statuses(echoed, [
				init(),
				echo("/nope", "u-nope"),
				assistantLine("msg_n", [{ type: "text", text: "No such command." }]),
				result({ num_turns: 1, result: "No such command." }),
			]),
		).toEqual(["working", "working", "working", "idle"]);
		expect(outline(echoed)).toEqual([
			"user(person): /nope",
			"assistant",
			"turn-end completed",
		]);

		const silent = ready();
		send(silent, "/nope");
		expect(
			statuses(silent, [
				init(),
				assistantLine("msg_n", [{ type: "text", text: "No such command." }]),
				result({ num_turns: 1, result: "No such command." }),
			]),
		).toEqual(["working", "working", "idle"]);
		expect(outline(silent)).toEqual([
			"assistant",
			"command: /nope",
			"turn-end completed",
		]);
	});

	it("is idle after a prompt the model answered, and after one the CLI answered without echoing it", () => {
		const adapter = ready();
		send(adapter, "hello");
		expect(
			statuses(adapter, [
				echo("hello", "u-hello"),
				assistantLine("msg_h", [{ type: "text", text: "Hi." }]),
				result(),
			]),
		).toEqual(["working", "working", "idle"]);
		send(adapter, "and again");
		expect(
			statuses(adapter, [result({ is_error: true, subtype: "error" })]),
		).toEqual(["error"]);
		expect(adapter.transcript.sending).toEqual([]);
		expect(outline(adapter)).toEqual([
			"user(person): hello",
			"assistant",
			"turn-end completed",
			"user(person): and again",
			"turn-end failed",
		]);
	});

	it("answers two sends in a row in order when only the second is echoed: working until the second's result", () => {
		const adapter = ready();
		send(adapter, "/compact");
		send(adapter, "then this");
		expect(adapter.transcript.sending.map((each) => each.text)).toEqual([
			"/compact",
			"then this",
		]);
		expect(
			statuses(adapter, [
				status({ status: "compacting" }),
				boundary({ trigger: "manual", pre_tokens: 3000 }),
				localResult("compact"),
			]),
		).toEqual(["working", "working", "working"]);
		expect(adapter.transcript.sending.map((each) => each.text)).toEqual([
			"then this",
		]);
		expect(
			statuses(adapter, [
				echo("then this", "u-then"),
				assistantLine("msg_t", [{ type: "text", text: "Done." }]),
				result(),
			]),
		).toEqual(["working", "working", "idle"]);
		expect(outline(adapter)).toEqual([
			"compaction: manual 3000 -> undefined",
			"command: /compact",
			"turn-end completed",
			"user(person): then this",
			"assistant",
			"turn-end completed",
		]);
	});

	it("answers every message up to the last one a turn took in, when the second is echoed into the turn of the first", () => {
		const adapter = ready();
		send(adapter, "/compact");
		send(adapter, "meanwhile");
		expect(
			statuses(adapter, [echo("meanwhile", "u-mean"), localResult("compact")]),
		).toEqual(["working", "idle"]);
		expect(adapter.transcript.sending).toEqual([]);
		expect(outline(adapter)).toEqual([
			"user(person): meanwhile",
			"command: /compact",
			"turn-end completed",
		]);
	});

	it("replays the same way from the journal", () => {
		const live = ready();
		const written: string[] = [];
		const received = [
			status({ status: "compacting" }),
			boundary({ trigger: "manual", pre_tokens: 1000 }),
			localResult("compact"),
		];
		written.push(
			...perform(live, {
				kind: "send",
				text: "/compact",
				images: [],
				origin: "person",
			}),
		);
		for (const line of received) live.received(line);
		const replayed = ready();
		for (const line of written) replayed.sent(line);
		for (const line of received) replayed.received(line);
		expect(replayed.transcript).toEqual(live.transcript);
	});
});

describe("the CLI's other system events", () => {
	function system(
		subtype: string,
		fields: Record<string, unknown> = {},
	): string {
		return json({ type: "system", subtype, session_id: SESSION, ...fields });
	}

	function notices(adapter: ClaudeAdapter): [string, string][] {
		return adapter.transcript.entries.flatMap((each) =>
			each.kind === "notice" ? [[each.level, each.text]] : [],
		);
	}

	it("are drawn as what each says, or left out by a rule, never as an event DevHub does not know", () => {
		const adapter = inTurn();
		for (const line of [
			system("turn_duration", { durationMs: 1200, messageCount: 4 }),
			system("thinking_tokens", { tokens: 10 }),
			system("bridge_status", {
				content: "Remote Control on",
				url: "https://example.com/x",
			}),
			system("stop_hook_summary", {
				hookCount: 1,
				hookInfos: [{ command: "true", durationMs: 3 }],
				hookErrors: [],
				preventedContinuation: false,
				hasOutput: false,
				level: "info",
			}),
			system("away_summary", {
				content: "You were away; the tests were fixed.",
			}),
			system("informational", {
				content: "Auto-update installed.",
				level: "info",
			}),
			system("informational", { content: "Low disk space.", level: "warning" }),
			system("model_refusal_no_fallback", {
				content: "The model declined to answer.",
				level: "error",
				apiRefusalExplanation: "policy",
			}),
			system("stop_hook_summary", {
				hookCount: 1,
				hookInfos: [],
				hookErrors: ["lint failed"],
				preventedContinuation: true,
				stopReason: "fix lint",
				hasOutput: true,
				level: "warning",
			}),
		])
			adapter.received(line);
		expect(notices(adapter)).toEqual([
			["info", "While you were away: You were away; the tests were fixed."],
			["info", "Auto-update installed."],
			["warning", "Low disk space."],
			["error", "The model declined to answer. (policy)"],
			["warning", "A stop hook failed: lint failed"],
		]);
	});

	it("draw a change the CLI made to the repository as a quiet line saying what it did, on which branch", () => {
		const adapter = inTurn();
		const vcs = (fields: Record<string, unknown>) =>
			system("vcs_state_changed", {
				cwd: "/home/testuser/project",
				uuid: "u-vcs",
				...fields,
			});
		for (const line of [
			vcs({ kind: "push", branch: "main" }),
			vcs({ kind: "commit", branch: "feature" }),
			vcs({ kind: "merge", branch: "main" }),
			vcs({ kind: "rebase", branch: "topic" }),
			vcs({ kind: "commit" }),
			vcs({ kind: "stash", branch: "main" }),
			vcs({ kind: "tag" }),
		])
			adapter.received(line);
		expect(notices(adapter)).toEqual([
			["info", "Pushed main"],
			["info", "Committed on feature"],
			["info", "Merged into main"],
			["info", "Rebased topic"],
			["info", "Committed"],
			["info", "Changed the repository (stash) on main"],
			["info", "Changed the repository (tag)"],
		]);
	});

	it("draw a repository change read back from a session file the same way", () => {
		const adapter = new ClaudeAdapter("boot");
		adapter.received(
			json({
				type: "devhub_history",
				record: {
					type: "system",
					subtype: "vcs_state_changed",
					kind: "push",
					branch: "main",
					cwd: "/home/testuser/project",
				},
			}),
		);
		expect(notices(adapter)).toEqual([["info", "Pushed main"]]);
	});

	it("break the conversation for a repository change that does not say its kind", () => {
		const adapter = inTurn();
		expect(() =>
			adapter.received(system("vcs_state_changed", { branch: "main" })),
		).toThrow(ProtocolMismatch);
	});

	it("draw a local command the CLI ran as that command and its output", () => {
		const adapter = inTurn();
		adapter.received(
			system("local_command", {
				content:
					"<command-name>/cost</command-name>\n<command-args></command-args>",
				level: "info",
			}),
		);
		adapter.received(
			system("local_command", {
				content:
					"<local-command-stdout>Total cost: $0.10</local-command-stdout>",
				level: "info",
			}),
		);
		expect(
			adapter.transcript.entries.filter((each) => each.kind === "command"),
		).toMatchObject([{ line: "/cost", output: "Total cost: $0.10" }]);
		expect(notices(adapter)).toEqual([]);
	});

	it("end a task named only by its id, by the call task_started tied it to", () => {
		const adapter = inTurn();
		adapter.received(
			assistantLine("m", [
				toolUse("toolu_bg", "Bash", {
					command: "npm run watch",
					run_in_background: true,
				}),
			]),
		);
		adapter.received(
			system("task_started", {
				task_id: "b7",
				tool_use_id: "toolu_bg",
				description: "watch",
			}),
		);
		adapter.received(
			system("task_notification", {
				task_id: "b7",
				status: "stopped",
				summary: "stopped",
			}),
		);
		expect((entry(adapter, "tool:toolu_bg") as ToolEntry).background).toEqual({
			state: "failed",
			summary: "stopped",
		});
	});

	it("run on from a command's result that names its background task, until news of the task ends it", () => {
		for (const input of [
			{ command: "npm run watch", run_in_background: true },
			// One that outran its timeout and was moved to the background.
			{ command: "npm run build" },
		]) {
			const adapter = inTurn();
			adapter.received(
				assistantLine("msg_bg", [toolUse("toolu_bg", "Bash", input)]),
			);
			adapter.received(
				json({
					type: "user",
					message: {
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "toolu_bg",
								content: "Moved to the background with ID: b5",
								is_error: false,
							},
						],
					},
					parent_tool_use_id: null,
					session_id: SESSION,
					tool_use_result: {
						stdout: "",
						stderr: "",
						interrupted: false,
						backgroundTaskId: "b5",
					},
				}),
			);
			expect(entry(adapter, "tool:toolu_bg")).toMatchObject({
				status: "succeeded",
				background: { state: "running", summary: undefined },
			});
			adapter.received(
				system("task_notification", {
					task_id: "b5",
					status: "completed",
					summary: "build finished",
				}),
			);
			expect((entry(adapter, "tool:toolu_bg") as ToolEntry).background).toEqual(
				{ state: "completed", summary: "build finished" },
			);
		}
	});

	it("end a background command read back from a session file, named only by its task id", () => {
		const adapter = new ClaudeAdapter("boot");
		const past = (record: Record<string, unknown>) =>
			adapter.received(json({ type: "devhub_history", record }));
		past({
			type: "assistant",
			uuid: "a1",
			message: {
				id: "m1",
				role: "assistant",
				content: [
					toolUse("toolu_bg", "Bash", {
						command: "sleep 9",
						run_in_background: true,
					}),
				],
			},
		});
		past({
			type: "user",
			uuid: "u1",
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_bg",
						content: "Running in the background with ID: b9",
					},
				],
			},
			tool_use_result: {
				stdout: "",
				stderr: "",
				interrupted: false,
				backgroundTaskId: "b9",
			},
		});
		past({
			type: "user",
			uuid: "u2",
			message: {
				role: "user",
				content:
					"<task-notification>\n<task-id>b9</task-id>\n<status>completed</status>\n<summary>sleep ended</summary>\n</task-notification>",
			},
		});
		expect((entry(adapter, "tool:toolu_bg") as ToolEntry).background).toEqual({
			state: "completed",
			summary: "sleep ended",
		});
	});
});

describe("a teammate", () => {
	function spawned(): ClaudeAdapter {
		const adapter = inTurn();
		adapter.received(
			assistantLine("m", [
				toolUse("toolu_tm", "Agent", {
					description: "research",
					prompt: "look into it",
					subagent_type: "general",
				}),
			]),
		);
		adapter.received(
			json({
				...JSON.parse(toolResult("toolu_tm", "Spawned successfully.")),
				tool_use_result: {
					status: "teammate_spawned",
					prompt: "look into it",
					teammate_id: "researcher@team",
					agent_id: "researcher@team",
					name: "researcher",
					team_name: "team",
				},
			}),
		);
		return adapter;
	}

	function says(
		adapter: ClaudeAdapter,
		body: string,
		from = "researcher",
	): void {
		adapter.received(
			echo(
				`<teammate-message teammate_id="${from}" color="blue" summary="a note">\n${body}\n</teammate-message>`,
				`u-${Math.random()}`,
			),
		);
	}

	const state = (adapter: ClaudeAdapter) =>
		(entry(adapter, "tool:toolu_tm") as ToolEntry).spawns?.state;

	it("runs once spawned, not completed by its spawn call's result", () => {
		expect(state(spawned())).toBe("running");
	});

	it("is idle when it says so, failed when its idleness names a failure, and done when its shutdown is approved", () => {
		const adapter = spawned();
		says(
			adapter,
			JSON.stringify({
				type: "idle_notification",
				from: "researcher",
				idleReason: "available",
				timestamp: "t",
			}),
		);
		expect(state(adapter)).toBe("idle");
		says(
			adapter,
			JSON.stringify({
				type: "shutdown_approved",
				from: "researcher",
				requestId: "r",
				timestamp: "t",
			}),
		);
		expect(state(adapter)).toBe("completed");
		const failing = spawned();
		says(
			failing,
			JSON.stringify({
				type: "idle_notification",
				from: "researcher",
				idleReason: "failed",
				failureReason: "crashed",
				timestamp: "t",
			}),
		);
		expect(state(failing)).toBe("failed");
	});

	it("draws what it says as a quiet line from it, not as the person's message, and its protocol messages not at all", () => {
		const adapter = spawned();
		says(adapter, "Found the cause in parser.ts.");
		says(
			adapter,
			JSON.stringify({
				type: "idle_notification",
				from: "researcher",
				idleReason: "available",
				timestamp: "t",
			}),
		);
		const drawn = adapter.transcript.entries.filter(
			(each) => each.kind === "notice" || each.kind === "user",
		);
		expect(
			drawn.map((each) => [each.kind, "text" in each ? each.text : ""]),
		).toEqual([
			["user", "go"],
			["notice", "From researcher: Found the cause in parser.ts."],
		]);
	});

	it("is unknown, never running or done, when read back from a session file with nothing after its spawn", () => {
		const adapter = new ClaudeAdapter("boot");
		const past = (record: Record<string, unknown>) =>
			adapter.received(json({ type: "devhub_history", record }));
		past({
			type: "assistant",
			uuid: "a1",
			message: {
				id: "m1",
				role: "assistant",
				content: [
					toolUse("toolu_tm", "Agent", {
						description: "research",
						prompt: "p",
					}),
				],
			},
		});
		past({
			type: "user",
			uuid: "u1",
			message: {
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "toolu_tm", content: "Spawned." },
				],
			},
			tool_use_result: {
				status: "teammate_spawned",
				name: "researcher",
				teammate_id: "researcher@team",
			},
		});
		expect(state(adapter)).toBe("unknown");
	});
});

describe("a TodoWrite call", () => {
	it("carries the plan it sets, each step with its status, the one under way in its present form", () => {
		const adapter = inTurn();
		adapter.received(
			assistantLine("m", [
				toolUse("toolu_todo", "TodoWrite", {
					todos: [
						{
							content: "Read the code",
							status: "completed",
							activeForm: "Reading the code",
						},
						{
							content: "Fix the bug",
							status: "in_progress",
							activeForm: "Fixing the bug",
						},
						{
							content: "Run the tests",
							status: "pending",
							activeForm: "Running the tests",
						},
					],
				}),
			]),
		);
		expect(entry(adapter, "tool:toolu_todo")).toMatchObject({
			title: "TodoWrite: 1 of 3 done",
			plan: [
				{ text: "Read the code", status: "completed" },
				{ text: "Fixing the bug", status: "in_progress" },
				{ text: "Run the tests", status: "pending" },
			],
		});
	});
});

describe("a resumed session's past, whole", () => {
	it("draws what was live beside the messages: a queued message, an attached and an edited file, an away summary, a command, and the compaction as a divider", () => {
		const adapter = new ClaudeAdapter("boot");
		const file = readFileSync(
			join(FIXTURES, "claude-session-resume-complete.handwritten.jsonl"),
			"utf8",
		);
		for (const line of claudeHistoryLines(SESSION, file))
			adapter.received(line);
		expect(
			adapter.transcript.entries.map((each) => {
				switch (each.kind) {
					case "user":
						return `user: ${each.text}`;
					case "assistant":
						return `assistant: ${each.blocks.map((block) => (block.kind === "text" ? block.markdown : "")).join("")}`;
					case "notice":
						return `notice(${each.level}): ${each.text}`;
					case "command":
						return `command: ${each.line} -> ${each.output}`;
					case "compaction":
						return `compaction: ${each.trigger} ${each.preTokens}`;
					default:
						return each.kind;
				}
			}),
		).toEqual([
			"user: Start on the docs",
			"assistant: Working on it.",
			"user: also check the changelog",
			"notice(info): Attached notes.md",
			"notice(info): Changed outside the conversation: /home/testuser/project/src/x.ts",
			"notice(info): While you were away: The docs were checked.",
			"command: /cost -> Total cost: $0.01",
			"compaction: manual 1200",
			"user: Go on",
			"assistant: Done.",
		]);
	});

	it("draws a compaction live as the same divider", () => {
		const adapter = inTurn();
		adapter.received(
			json({
				type: "system",
				subtype: "compact_boundary",
				session_id: SESSION,
				compact_metadata: { trigger: "auto", pre_tokens: 150000 },
			}),
		);
		expect(adapter.transcript.entries.at(-1)).toMatchObject({
			kind: "compaction",
			trigger: "auto",
			preTokens: 150000,
		});
	});
});

describe("what works in the background", () => {
	function system(
		subtype: string,
		fields: Record<string, unknown> = {},
	): string {
		return json({ type: "system", subtype, session_id: SESSION, ...fields });
	}

	/** The CLI's whole list of background tasks, as `background_tasks_changed` prints it. */
	function listed(
		...tasks: [id: string, type: string, description: string][]
	): string {
		return system("background_tasks_changed", {
			uuid: `u-${tasks.length}`,
			tasks: tasks.map(([task_id, task_type, description]) => ({
				task_id,
				task_type,
				description,
			})),
		});
	}

	/** A turn that ran `npm run dev` in the background (task b1) and ended. */
	function serverLeftRunning(): ClaudeAdapter {
		const adapter = inTurn();
		adapter.received(
			assistantLine("m", [
				toolUse("toolu_bg", "Bash", {
					command: "npm run dev",
					description: "Start the dev server",
					run_in_background: true,
				}),
			]),
		);
		// The CLI prints the list before the task's own start, which names the call.
		adapter.received(listed(["b1", "local_bash", "Start the dev server"]));
		adapter.received(
			system("task_started", {
				task_id: "b1",
				tool_use_id: "toolu_bg",
				task_type: "local_bash",
				description: "Start the dev server",
				is_backgrounded: true,
			}),
		);
		adapter.received(result());
		return adapter;
	}

	it("is the CLI's own list, each task tied to its call once a task event names it, and started when the CLI wrote that call", () => {
		const adapter = inTurn();
		adapter.received(
			assistantLine(
				"m",
				[
					toolUse("toolu_bg", "Bash", {
						command: "npm run dev",
						run_in_background: true,
					}),
				],
				null,
				{ timestamp: "2026-09-20T10:00:00.500Z" },
			),
		);
		adapter.received(listed(["b1", "local_bash", "Start the dev server"]));
		expect(adapter.transcript.backgroundTasks).toEqual([
			{
				id: "b1",
				kind: "shell",
				title: "Start the dev server",
				call: undefined,
				stoppable: true,
			},
		]);
		adapter.received(
			system("task_started", {
				task_id: "b1",
				tool_use_id: "toolu_bg",
				task_type: "local_bash",
				description: "Start the dev server",
			}),
		);
		expect(adapter.transcript.backgroundTasks).toEqual([
			{
				id: "b1",
				kind: "shell",
				title: "Start the dev server",
				call: entryId("tool:toolu_bg"),
				startedAt: Date.parse("2026-09-20T10:00:00.500Z"),
				stoppable: true,
			},
		]);
	});

	it("starts at the same time in a replay, whenever the replay runs: the time is the journal's", () => {
		const play = () => {
			const adapter = inTurn();
			adapter.received(
				assistantLine(
					"m",
					[toolUse("toolu_bg", "Bash", { command: "sleep 99" })],
					null,
					{ timestamp: "2026-09-20T10:00:00.000Z" },
				),
			);
			adapter.received(listed(["b1", "local_bash", "sleep"]));
			adapter.received(
				system("task_started", { task_id: "b1", tool_use_id: "toolu_bg" }),
			);
			return adapter.transcript.backgroundTasks;
		};
		const live = play();
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-09-21T00:00:00Z"));
			expect(play()).toEqual(live);
		} finally {
			vi.useRealTimers();
		}
		expect(live[0]!.startedAt).toBe(Date.parse("2026-09-20T10:00:00.000Z"));
	});

	it("has no start when the CLI wrote no time on the call, and refuses a time that is not one", () => {
		const adapter = inTurn();
		adapter.received(
			assistantLine("m", [
				toolUse("toolu_bg", "Bash", {
					command: "npm run dev",
					run_in_background: true,
				}),
			]),
		);
		adapter.received(listed(["b1", "local_bash", "Start the dev server"]));
		adapter.received(
			system("task_started", { task_id: "b1", tool_use_id: "toolu_bg" }),
		);
		expect(adapter.transcript.backgroundTasks[0]!.startedAt).toBeUndefined();
		expect(() =>
			adapter.received(
				assistantLine("m2", [], null, { timestamp: "yesterday-ish" }),
			),
		).toThrow(/assistant.timestamp/);
	});

	it("keeps an Agent whose turn ended with a task still working out of idle, and lets it go when the list does", () => {
		const adapter = serverLeftRunning();
		expect(conversationStatus(adapter.transcript)).toBe("background");
		adapter.received(listed());
		expect(adapter.transcript.backgroundTasks).toEqual([]);
		expect(conversationStatus(adapter.transcript)).toBe("idle");
	});

	it("names a subagent's task as a subagent and any other kind by the CLI's own name", () => {
		const adapter = inTurn();
		adapter.received(
			listed(
				["a1", "local_agent", "Research the parser"],
				["w1", "local_workflow", "Nightly checks"],
			),
		);
		expect(
			adapter.transcript.backgroundTasks.map((task) => [task.id, task.kind]),
		).toEqual([
			["a1", "subagent"],
			["w1", "local_workflow"],
		]);
	});

	it("counts a teammate at work, and not one that sits idle", () => {
		const adapter = inTurn();
		adapter.received(
			assistantLine("m", [
				toolUse("toolu_tm", "Agent", {
					description: "research",
					prompt: "look into it",
				}),
			]),
		);
		adapter.received(
			json({
				...JSON.parse(toolResult("toolu_tm", "Spawned successfully.")),
				tool_use_result: {
					status: "teammate_spawned",
					name: "researcher",
					teammate_id: "researcher@team",
				},
			}),
		);
		adapter.received(result());
		expect(adapter.transcript.backgroundTasks).toEqual([
			{
				id: "teammate:researcher",
				kind: "teammate",
				title: "research",
				call: entryId("tool:toolu_tm"),
				// `stop_task` is documented for the CLI's own tasks, not teammates.
				stoppable: { reason: "A teammate can't be stopped from here." },
			},
		]);
		expect(() =>
			adapter.encode({ kind: "stop-task", task: "teammate:researcher" }),
		).toThrow(/cannot be stopped from DevHub/);
		expect(conversationStatus(adapter.transcript)).toBe("background");
		adapter.received(
			echo(
				`<teammate-message teammate_id="researcher" color="blue" summary="idle">\n${JSON.stringify({ type: "idle_notification", from: "researcher", idleReason: "available", timestamp: "t" })}\n</teammate-message>`,
				"u-idle",
			),
		);
		expect(adapter.transcript.backgroundTasks).toEqual([]);
		expect(conversationStatus(adapter.transcript)).toBe("idle");
	});

	it("ends with the CLI that ran it, when the conversation is taken back past its call", () => {
		const adapter = new ClaudeAdapter("boot");
		adapter.received(init({ claude_code_version: "2.1.282" }));
		perform(adapter, {
			kind: "send",
			text: "go",
			images: [],
			origin: "person",
		});
		adapter.received(echo("go", "u-go"));
		adapter.received(
			assistantLine(
				"m",
				[
					toolUse("toolu_bg", "Bash", {
						command: "npm run dev",
						run_in_background: true,
					}),
				],
				null,
				{ uuid: "a1" },
			),
		);
		adapter.received(listed(["b1", "local_bash", "dev server"]));
		adapter.received(
			system("task_started", { task_id: "b1", tool_use_id: "toolu_bg" }),
		);
		adapter.received(result());
		const plan = adapter.rewind(entryId("user:u-go"));
		if (plan.kind !== "restart") throw new Error("not a restart");
		adapter.received(plan.mark[0]!);
		expect(adapter.transcript.backgroundTasks).toEqual([]);
		expect(adapter.transcript.entries).toEqual([]);
	});

	it("stops a task the CLI lists with its `stop_task` request, and lets it go only when the CLI says it stopped", () => {
		const adapter = serverLeftRunning();
		const [line] = perform(adapter, { kind: "stop-task", task: "b1" });
		const written = JSON.parse(line!) as {
			type: string;
			request_id: string;
			request: unknown;
		};
		expect(written.type).toBe("control_request");
		expect(written.request).toEqual({ subtype: "stop_task", task_id: "b1" });
		adapter.received(
			json({
				type: "control_response",
				response: {
					subtype: "success",
					request_id: written.request_id,
					response: {},
				},
			}),
		);
		// Asked, not done: the task is listed until the CLI says otherwise.
		expect(adapter.transcript.backgroundTasks.map((task) => task.id)).toEqual([
			"b1",
		]);
		adapter.received(
			system("task_notification", {
				task_id: "b1",
				status: "stopped",
				summary: "Start the dev server",
			}),
		);
		adapter.received(listed());
		expect(adapter.transcript.backgroundTasks).toEqual([]);
		expect(
			(entry(adapter, "tool:toolu_bg") as ToolEntry).background?.state,
		).toBe("failed");
	});

	it("says so when the CLI refuses to stop a task, and keeps it listed", () => {
		const adapter = serverLeftRunning();
		const [line] = perform(adapter, { kind: "stop-task", task: "b1" });
		adapter.received(
			json({
				type: "control_response",
				response: {
					subtype: "error",
					request_id: (JSON.parse(line!) as { request_id: string }).request_id,
					error: "No task found with ID: b1",
				},
			}),
		);
		expect(adapter.transcript.entries.at(-1)).toMatchObject({
			kind: "notice",
			level: "error",
			text: "stop_task was refused: No task found with ID: b1",
		});
		expect(adapter.transcript.backgroundTasks.map((task) => task.id)).toEqual([
			"b1",
		]);
	});

	it("refuses to stop a task that is not running", () => {
		const adapter = serverLeftRunning();
		expect(() => adapter.encode({ kind: "stop-task", task: "b9" })).toThrow(
			/b9 is not a background task running now/,
		);
	});

	it("breaks the conversation for a list whose task does not say its kind", () => {
		const adapter = inTurn();
		expect(() =>
			adapter.received(
				system("background_tasks_changed", {
					tasks: [{ task_id: "b1", description: "x" }],
				}),
			),
		).toThrow(ProtocolMismatch);
	});
});

describe("the person's answer to AskUserQuestion", () => {
	const QUESTIONS = [
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
				{ label: "Auth, SSO", description: "" },
				{ label: "Search", description: "" },
				{ label: "Export", description: "" },
			],
			multiSelect: true,
		},
		{
			question: "Which name?",
			header: "Name",
			options: [
				{ label: "devhub", description: "" },
				{ label: "hub", description: "" },
			],
			multiSelect: false,
		},
	];

	/** What the CLI records of the answer: the questions, each answer by its text, and a note. */
	const RECORDED = {
		questions: QUESTIONS,
		answers: {
			"Which database?": "Postgres",
			"Which features?": "Auth, SSO, Search, and CSV, too",
			"Which name?": "workbench",
		},
		annotations: { "Which database?": { notes: "the one we run already" } },
	};

	const ANSWER = {
		kind: "answer",
		id: "answer:toolu_q",
		parent: null,
		answers: [
			{
				header: "Database",
				question: "Which database?",
				chosen: ["Postgres"],
				written: undefined,
				notes: "the one we run already",
				secret: false,
			},
			{
				header: "Features",
				question: "Which features?",
				chosen: ["Auth, SSO", "Search"],
				written: "and CSV, too",
				notes: undefined,
				secret: false,
			},
			{
				header: "Name",
				question: "Which name?",
				chosen: [],
				written: "workbench",
				notes: undefined,
				secret: false,
			},
		],
	};

	function answered(toolUseResult: unknown): string {
		return json({
			type: "user",
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_q",
						content: "User has answered your questions.",
						is_error: false,
					},
				],
			},
			parent_tool_use_id: null,
			session_id: SESSION,
			tool_use_result: toolUseResult,
		});
	}

	it("is the person's message after the call, read from what the CLI recorded of it", () => {
		const adapter = inTurn();
		adapter.received(
			assistantLine("m", [
				toolUse("toolu_q", "AskUserQuestion", { questions: QUESTIONS }),
			]),
		);
		adapter.received(
			canUseTool("q", {
				tool_name: "AskUserQuestion",
				input: { questions: QUESTIONS },
				tool_use_id: "toolu_q",
			}),
		);
		perform(adapter, {
			kind: "answer",
			request: requestId("q"),
			answer: {
				kind: "answers",
				values: {
					"Which database?": "Postgres",
					"Which features?": ["Auth, SSO", "Search", "and CSV, too"],
					"Which name?": "workbench",
				},
			},
		});
		adapter.received(answered(RECORDED));
		const entries = adapter.transcript.entries;
		expect(entries.at(-1)).toEqual(ANSWER);
		expect(entries.at(-2)).toMatchObject({ id: "tool:toolu_q" });
	});

	it("is drawn the same by a replay, which reads only what the CLI printed", () => {
		const adapter = inTurn();
		adapter.received(
			assistantLine("m", [
				toolUse("toolu_q", "AskUserQuestion", { questions: QUESTIONS }),
			]),
		);
		adapter.received(answered(RECORDED));
		expect(entry(adapter, "answer:toolu_q")).toEqual(ANSWER);
	});

	it("is drawn the same from a resumed session's file", () => {
		const adapter = new ClaudeAdapter("boot");
		const past = (record: Record<string, unknown>) =>
			adapter.received(json({ type: "devhub_history", record }));
		past({
			type: "assistant",
			uuid: "a1",
			message: {
				id: "m1",
				role: "assistant",
				content: [
					toolUse("toolu_q", "AskUserQuestion", { questions: QUESTIONS }),
				],
			},
		});
		past({
			type: "user",
			uuid: "u1",
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_q",
						content: "User has answered your questions.",
					},
				],
			},
			tool_use_result: RECORDED,
		});
		expect(entry(adapter, "answer:toolu_q")).toEqual(ANSWER);
	});

	it("takes a multi-select answer the CLI recorded as a list", () => {
		const adapter = inTurn();
		adapter.received(
			assistantLine("m", [
				toolUse("toolu_q", "AskUserQuestion", { questions: QUESTIONS }),
			]),
		);
		adapter.received(
			answered({
				questions: [QUESTIONS[1]],
				answers: { "Which features?": ["Search", "Export"] },
			}),
		);
		expect(entry(adapter, "answer:toolu_q")).toMatchObject({
			answers: [{ chosen: ["Search", "Export"], written: undefined }],
		});
	});

	it("is not drawn for questions the person declined", () => {
		const adapter = inTurn();
		adapter.received(
			assistantLine("m", [
				toolUse("toolu_q", "AskUserQuestion", { questions: QUESTIONS }),
			]),
		);
		adapter.received(toolResult("toolu_q", "The user declined.", true));
		expect(adapter.transcript.entries.map((each) => each.kind)).toEqual([
			"user",
			"tool",
		]);
	});

	it("breaks the conversation when an answered call's record carries no answers", () => {
		const adapter = inTurn();
		adapter.received(
			assistantLine("m", [
				toolUse("toolu_q", "AskUserQuestion", { questions: QUESTIONS }),
			]),
		);
		expect(() => adapter.received(answered({ questions: QUESTIONS }))).toThrow(
			/user.tool_use_result.answers/,
		);
	});
});

describe("an AskUserQuestion whose options carry previews", () => {
	const LINES = fixture("claude-question-previews.handwritten.ndjson");
	const ASKING = LINES.findIndex(({ line }) => line.includes("can_use_tool"));
	const CALL = LINES.find(
		({ line }) =>
			line.startsWith('{"type":"assistant"') && line.includes("toolu_q1"),
	)!;
	const RESULT = LINES.find(({ line }) => line.includes("tool_use_result"))!;
	const ASKED = (
		JSON.parse(CALL.line) as {
			message: { content: [{ input: { questions: unknown[] } }] };
		}
	).message.content[0].input.questions as {
		question: string;
		options: { label: string; preview?: string }[];
	}[];
	const previews = ASKED[0]!.options.map((option) => option.preview);

	function previewsOf(questions: readonly Question[]) {
		return questions.map((question) =>
			question.options.map((option) => option.preview),
		);
	}

	function askedOfCall(adapter: ClaudeAdapter) {
		const call = entry(adapter, "tool:toolu_q1") as ToolEntry;
		return call.asked!.map(({ question, answer }) => ({
			previews: question.options.map((option) => option.preview),
			chosen: answer.chosen,
		}));
	}

	const RECORD = [
		{ previews, chosen: ["タブ"] },
		{ previews: [undefined, undefined], chosen: ["自動"] },
	];

	it("hands the card every option's preview as written, lines and box-drawing and all, for each question", () => {
		expect(previews.every((each) => each!.includes("\n│"))).toBe(true);
		const adapter = new ClaudeAdapter("boot");
		play(adapter, LINES.slice(0, ASKING + 1));
		const [request] = adapter.transcript.requests;
		expect(request!.subject.kind).toBe("question");
		if (request!.subject.kind !== "question") return;
		expect(previewsOf(request!.subject.questions)).toEqual([
			previews,
			[undefined, undefined],
		]);
		// Before the answer, the call keeps no record of it.
		expect(
			(entry(adapter, "tool:toolu_q1") as ToolEntry).asked,
		).toBeUndefined();
	});

	it("keeps what was asked and chosen on the call once answered, the previews with it, and the answer as the person's message", () => {
		const adapter = new ClaudeAdapter("boot");
		play(adapter, LINES);
		expect(askedOfCall(adapter)).toEqual(RECORD);
		expect(entry(adapter, "answer:toolu_q1")).toMatchObject({
			answers: [{ chosen: ["タブ"] }, { chosen: ["自動"] }],
		});
	});

	it("keeps the same record in a resumed session's file", () => {
		const adapter = new ClaudeAdapter("boot");
		const past = (line: string) => {
			const record = JSON.parse(line) as Record<string, unknown>;
			adapter.received(json({ type: "devhub_history", record }));
		};
		past(CALL.line);
		past(RESULT.line);
		expect(askedOfCall(adapter)).toEqual(RECORD);
	});
});

describe("a call the CLI's own permission check refused", () => {
	function denied(fields: Record<string, unknown>): string {
		return json({
			type: "system",
			subtype: "permission_denied",
			session_id: SESSION,
			tool_name: "Bash",
			decision_reason_type: "classifier",
			decision_reason: "[Modify Shared Resources]",
			message:
				"The classifier judged that this command changes a shared resource.",
			...fields,
		});
	}

	/** `inTurn`, with an Agent call launched in the background as agent-x. */
	function withBackgroundAgent(): ClaudeAdapter {
		const adapter = inTurn();
		adapter.received(
			assistantLine("m", [
				toolUse("toolu_agent", "Agent", {
					description: "Survey",
					prompt: "survey it",
					subagent_type: "general",
				}),
			]),
		);
		adapter.received(
			json({
				...JSON.parse(toolResult("toolu_agent", "Async agent launched")),
				tool_use_result: {
					isAsync: true,
					status: "async_launched",
					agentId: "agent-x",
				},
			}),
		);
		return adapter;
	}

	it("is said on the call, by who refused it and why, with the CLI's words folded under it", () => {
		const adapter = inTurn();
		adapter.received(
			assistantLine("m", [toolUse("toolu_1", "Bash", { command: "git push" })]),
		);
		adapter.received(denied({ tool_use_id: "toolu_1" }));
		adapter.received(toolResult("toolu_1", "Permission denied.", true));
		expect(entry(adapter, "tool:toolu_1")).toMatchObject({
			status: "denied",
			denial: {
				summary: "Denied by auto mode: Modify Shared Resources",
				detail:
					"The classifier judged that this command changes a shared resource.",
			},
		});
		expect(adapter.transcript.entries.map((each) => each.kind)).toEqual([
			"user",
			"tool",
		]);
	});

	it("is said on a subagent's own call, where that call is drawn", () => {
		const adapter = withBackgroundAgent();
		adapter.received(
			assistantLine(
				"m2",
				[toolUse("toolu_inner", "Bash", { command: "rm -rf shared" })],
				"toolu_agent",
			),
		);
		adapter.received(
			denied({ tool_use_id: "toolu_inner", agent_id: "agent-x" }),
		);
		expect(entry(adapter, "tool:toolu_inner")).toMatchObject({
			parent: "tool:toolu_agent",
			denial: { summary: "Denied by auto mode: Modify Shared Resources" },
		});
		expect(
			adapter.transcript.entries.filter((each) => each.kind === "notice"),
		).toEqual([]);
	});

	it("is a line in the subagent's transcript when its call is not drawn", () => {
		const adapter = withBackgroundAgent();
		adapter.received(
			denied({ tool_use_id: "toolu_unseen", agent_id: "agent-x" }),
		);
		expect(
			adapter.transcript.entries.filter((each) => each.kind === "notice"),
		).toMatchObject([
			{
				parent: "tool:toolu_agent",
				level: "info",
				text: "Bash: Denied by auto mode: Modify Shared Resources",
			},
		]);
	});

	it("is a line in the conversation only when it names neither a call nor a subagent DevHub knows", () => {
		const adapter = inTurn();
		adapter.received(
			denied({
				tool_use_id: "toolu_unseen",
				agent_id: "agent-unknown",
				decision_reason_type: "rule",
				decision_reason: "Bash(git push:*)",
			}),
		);
		expect(
			adapter.transcript.entries.filter((each) => each.kind === "notice"),
		).toMatchObject([
			{
				parent: null,
				level: "info",
				text: "Bash: Denied by a permission rule: Bash(git push:*)",
			},
		]);
	});
});

describe("a subagent woken again by SendMessage", () => {
	function task(subtype: string, fields: Record<string, unknown>): string {
		return json({ type: "system", subtype, session_id: SESSION, ...fields });
	}

	/** Launch in the background, fail, wake it with SendMessage, work, finish. */
	function play(adapter: ClaudeAdapter): string[] {
		const seen: string[] = [];
		const look = () => {
			const agent = entry(adapter, "tool:toolu_agent") as ToolEntry;
			const send = adapter.transcript.entries.find(
				(each) => each.id === "tool:toolu_send",
			) as ToolEntry | undefined;
			seen.push(
				[
					`agent ${agent.spawns!.state}`,
					`send ${send?.status ?? "-"}/${send?.background?.state ?? "-"}`,
					`bar ${adapter.transcript.backgroundTasks.map((each) => each.call ?? "-").join(",")}`,
				].join(" "),
			);
		};
		adapter.received(
			assistantLine("m1", [
				toolUse("toolu_agent", "Agent", {
					description: "Survey",
					prompt: "survey it",
					subagent_type: "general",
					run_in_background: true,
				}),
			]),
		);
		adapter.received(
			json({
				...JSON.parse(toolResult("toolu_agent", "Async agent launched")),
				tool_use_result: {
					isAsync: true,
					status: "async_launched",
					agentId: "agent-x",
				},
			}),
		);
		adapter.received(
			task("task_notification", {
				task_id: "agent-x",
				tool_use_id: "toolu_agent",
				status: "failed",
				summary: "It stopped.",
			}),
		);
		look();
		adapter.received(
			assistantLine("m2", [
				toolUse("toolu_send", "SendMessage", {
					to: "agent-x",
					message: "try again",
				}),
			]),
		);
		adapter.received(
			task("task_started", {
				task_id: "agent-x",
				tool_use_id: "toolu_send",
				task_type: "local_agent",
				description: "Survey",
			}),
		);
		adapter.received(
			task("background_tasks_changed", {
				tasks: [
					{
						task_id: "agent-x",
						task_type: "local_agent",
						description: "Survey",
					},
				],
			}),
		);
		adapter.received(toolResult("toolu_send", "Message sent."));
		look();
		adapter.received(
			task("task_progress", {
				task_id: "agent-x",
				tool_use_id: "toolu_send",
				description: "Survey",
			}),
		);
		look();
		adapter.received(
			task("task_notification", {
				task_id: "agent-x",
				tool_use_id: "toolu_send",
				status: "completed",
				summary: "Done this time.",
			}),
		);
		adapter.received(task("background_tasks_changed", { tasks: [] }));
		look();
		return seen;
	}

	const STATES = [
		"agent failed send -/- bar ",
		"agent running send succeeded/- bar tool:toolu_agent",
		"agent running send succeeded/- bar tool:toolu_agent",
		"agent completed send succeeded/- bar ",
	];

	it("is the subagent the Agent call started, running again and then done, and the SendMessage call only a message", () => {
		expect(play(inTurn())).toEqual(STATES);
	});

	it("reads the same in a replay", () => {
		play(inTurn());
		expect(play(inTurn())).toEqual(STATES);
	});
});

describe("the MCP servers", () => {
	const SLACK = "plugin:slack:slack";

	/** The handshake answered; returns what the answer had DevHub write. */
	function handshake(adapter: ClaudeAdapter): readonly unknown[] {
		for (const line of adapter.opening()) adapter.sent(line);
		const step = adapter.received(
			json({
				type: "control_response",
				response: {
					subtype: "success",
					request_id: "boot:1",
					response: { commands: [], models: [] },
				},
			}),
		);
		for (const line of step.replies) adapter.sent(line);
		return step.replies.map((line) => JSON.parse(line));
	}

	function status(requestId: string, servers: readonly unknown[]): string {
		return json({
			type: "control_response",
			response: {
				subtype: "success",
				request_id: requestId,
				response: { mcpServers: servers },
			},
		});
	}

	function refused(requestId: string, error: string): string {
		return json({
			type: "control_response",
			response: { subtype: "error", request_id: requestId, error },
		});
	}

	/** The person's MCP request, written; the control request it was. */
	function request(
		adapter: ClaudeAdapter,
		mcp: Extract<ConversationCommand, { kind: "mcp" }>["request"],
	): { readonly request_id: string; readonly request: unknown } {
		const lines = adapter.encode({ kind: "mcp", request: mcp });
		expect(lines).toHaveLength(1);
		adapter.sent(lines[0]!);
		return JSON.parse(lines[0]!);
	}

	/** Up, with the status request answered with `servers`. */
	function reporting(servers: readonly unknown[]): ClaudeAdapter {
		const adapter = new ClaudeAdapter("boot");
		handshake(adapter);
		adapter.received(status("boot:2", servers));
		return adapter;
	}

	it("asks how they stand as soon as the CLI is up, before anything is said", () => {
		const adapter = new ClaudeAdapter("boot");
		expect(handshake(adapter)).toEqual([
			{
				type: "control_request",
				request_id: "boot:2",
				request: { subtype: "mcp_status" },
			},
		]);
		expect(adapter.transcript.mcp.servers).toBeUndefined();
	});

	it("reads each server's status, source and failure into the panel's state, with what can be done about it", () => {
		const adapter = reporting([
			{ name: "playwright", status: "connected", scope: "user" },
			{ name: SLACK, status: "needs-auth", scope: "plugin" },
			{ name: "db", status: "failed", error: "HTTP 503", scope: "project" },
			{ name: "slow", status: "pending", scope: "local" },
			{ name: "off", status: "disabled", scope: "user" },
			{ name: "odd", status: "sleeping" },
		]);
		expect(adapter.transcript.mcp.servers).toEqual([
			{
				name: "playwright",
				status: "connected",
				said: "connected",
				error: undefined,
				source: "user",
				actions: ["reconnect", "disable"],
			},
			{
				name: SLACK,
				status: "needs-sign-in",
				said: "needs-auth",
				error: undefined,
				source: "plugin",
				actions: ["sign-in", "reconnect", "disable"],
			},
			{
				name: "db",
				status: "failed",
				said: "failed",
				error: "HTTP 503",
				source: "project",
				actions: ["reconnect", "disable"],
			},
			{
				name: "slow",
				status: "connecting",
				said: "pending",
				error: undefined,
				source: "local",
				actions: ["disable"],
			},
			{
				name: "off",
				status: "disabled",
				said: "disabled",
				error: undefined,
				source: "user",
				actions: ["enable"],
			},
			{
				name: "odd",
				status: "unknown",
				said: "sleeping",
				error: undefined,
				source: undefined,
				actions: ["reconnect", "disable"],
			},
		]);
	});

	it("says nothing about them in the conversation: they are the panel's", () => {
		const adapter = reporting([{ name: SLACK, status: "needs-auth" }]);
		adapter.received(
			init({
				mcp_servers: [{ name: SLACK, status: "failed", error: "HTTP 503" }],
				plugin_errors: [
					{ plugin: "broken", type: "dependency", message: "needs x@2" },
				],
			}),
		);
		expect(adapter.transcript.entries).toEqual([]);
		expect(adapter.transcript.mcp.pluginErrors).toEqual([
			{ plugin: "broken", message: "needs x@2" },
		]);
	});

	it("keeps them up to date: each turn's init, which keeps where each is configured, then the status asked after the turn", () => {
		const adapter = reporting([
			{ name: SLACK, status: "pending", scope: "plugin" },
		]);
		adapter.received(
			init({
				mcp_servers: [{ name: SLACK, status: "failed", error: "HTTP 503" }],
			}),
		);
		expect(adapter.transcript.mcp.servers).toEqual([
			expect.objectContaining({
				name: SLACK,
				status: "failed",
				error: "HTTP 503",
				source: "plugin",
			}),
		]);
		perform(adapter, {
			kind: "send",
			text: "hi",
			images: [],
			origin: "person",
		});
		adapter.received(echo("hi", "u1"));
		const ended = adapter.received(result());
		const asked = ended.replies.map((line) => JSON.parse(line));
		expect(asked).toEqual([
			{
				type: "control_request",
				request_id: expect.stringMatching(/^boot:\d+$/u),
				request: { subtype: "mcp_status" },
			},
		]);
		for (const line of ended.replies) adapter.sent(line);
		adapter.received(
			status(asked[0].request_id, [
				{ name: SLACK, status: "connected", scope: "plugin" },
			]),
		);
		expect(adapter.transcript.mcp.servers?.[0]?.status).toBe("connected");
	});

	it("asks again when the panel asks (refresh)", () => {
		const adapter = reporting([]);
		expect(request(adapter, { action: "refresh" }).request).toEqual({
			subtype: "mcp_status",
		});
	});

	it("reconnects a server with the documented mcp_reconnect, working until it is answered, and asks how they stand after", () => {
		const adapter = reporting([{ name: "db", status: "failed" }]);
		const sent = request(adapter, { action: "reconnect", server: "db" });
		expect(sent.request).toEqual({
			subtype: "mcp_reconnect",
			serverName: "db",
		});
		expect(adapter.transcript.mcp.working).toEqual([
			{ server: "db", action: "reconnect" },
		]);
		const answered = adapter.received(
			json({
				type: "control_response",
				response: {
					subtype: "success",
					request_id: sent.request_id,
					response: {},
				},
			}),
		);
		expect(adapter.transcript.mcp.working).toEqual([]);
		expect(answered.replies.map((line) => JSON.parse(line))).toEqual([
			expect.objectContaining({ request: { subtype: "mcp_status" } }),
		]);
	});

	it("enables and disables a server with the documented mcp_toggle", () => {
		const adapter = reporting([
			{ name: "on", status: "connected" },
			{ name: "off", status: "disabled" },
		]);
		expect(
			request(adapter, { action: "disable", server: "on" }).request,
		).toEqual({
			subtype: "mcp_toggle",
			serverName: "on",
			enabled: false,
		});
		expect(
			request(adapter, { action: "enable", server: "off" }).request,
		).toEqual({
			subtype: "mcp_toggle",
			serverName: "off",
			enabled: true,
		});
		expect(adapter.transcript.mcp.working).toEqual([
			{ server: "on", action: "disable" },
			{ server: "off", action: "enable" },
		]);
	});

	it("refuses an action it does not offer for that server now", () => {
		const adapter = reporting([{ name: "off", status: "disabled" }]);
		expect(() =>
			adapter.encode({
				kind: "mcp",
				request: { action: "reconnect", server: "off" },
			}),
		).toThrow("reconnect is not offered for the MCP server off now");
		expect(() =>
			adapter.encode({
				kind: "mcp",
				request: { action: "disable", server: "nowhere" },
			}),
		).toThrow("disable is not offered for the MCP server nowhere now");
	});

	it("says a refused request in the panel until the person makes the next one", () => {
		const adapter = reporting([{ name: "db", status: "failed" }]);
		const first = request(adapter, { action: "reconnect", server: "db" });
		adapter.received(refused(first.request_id, "Server not found: db"));
		expect(adapter.transcript.mcp.failure).toBe(
			"Reconnecting db failed: Server not found: db",
		);
		expect(adapter.transcript.mcp.working).toEqual([]);
		expect(adapter.transcript.entries).toEqual([]);
		request(adapter, { action: "reconnect", server: "db" });
		expect(adapter.transcript.mcp.failure).toBeUndefined();
	});

	it("says a refused status request in the panel", () => {
		const adapter = new ClaudeAdapter("boot");
		handshake(adapter);
		adapter.received(refused("boot:2", "unknown subtype"));
		expect(adapter.transcript.mcp.failure).toBe(
			"Listing the MCP servers failed: unknown subtype",
		);
		expect(adapter.transcript.entries).toEqual([]);
	});

	it("refuses a server reported without its status", () => {
		const adapter = new ClaudeAdapter("boot");
		handshake(adapter);
		expect(() => adapter.received(status("boot:2", [{ name: SLACK }]))).toThrow(
			ProtocolMismatch,
		);
	});
});

describe("a subagent whose Agent call this transcript never drew", () => {
	function task(subtype: string, fields: Record<string, unknown>): string {
		return json({ type: "system", subtype, session_id: SESSION, ...fields });
	}

	/**
	 * The shape seen: the Agent call that started "agent-old" is not in what
	 * DevHub read (it came before the history drawn, or a rewind cut it), and
	 * SendMessage wakes the subagent, whose messages name that call.
	 */
	function lines(): string[] {
		return [
			assistantLine("m1", [
				toolUse("toolu_send", "SendMessage", {
					to: "agent-old",
					message: "one more thing",
				}),
			]),
			task("task_started", {
				task_id: "agent-old",
				tool_use_id: "toolu_send",
				task_type: "local_agent",
				description: "Survey",
			}),
			toolResult("toolu_send", "Message sent."),
			stream({ type: "message_start", message: { id: "s1" } }, "toolu_earlier"),
			stream(
				{
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "" },
				},
				"toolu_earlier",
			),
			stream(
				{
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "Looking again." },
				},
				"toolu_earlier",
			),
			assistantLine(
				"s1",
				[
					{ type: "text", text: "Looking again." },
					toolUse("toolu_sub_bash", "Bash", { command: "ls" }),
				],
				"toolu_earlier",
			),
			json({
				type: "user",
				message: {
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu_sub_bash",
							content: "a.txt",
							is_error: false,
						},
					],
				},
				parent_tool_use_id: "toolu_earlier",
				session_id: SESSION,
			}),
			assistantLine(
				"s2",
				[{ type: "text", text: "Found it." }],
				"toolu_earlier",
			),
			task("task_notification", {
				task_id: "agent-old",
				tool_use_id: "toolu_send",
				status: "completed",
				summary: "Found it.",
			}),
			result(),
		];
	}

	function played(): ClaudeAdapter {
		const adapter = inTurn();
		for (const line of lines()) adapter.received(line);
		return adapter;
	}

	it("draws that call where its subagent is first heard of, and the subagent's messages under it", () => {
		const adapter = played();
		const earlier = entry(adapter, "tool:toolu_earlier") as ToolEntry;
		expect(earlier).toMatchObject({
			parent: null,
			tool: "Agent",
			title: "Agent: A subagent started earlier in this session",
			status: "succeeded",
			spawns: {
				label: "A subagent started earlier in this session",
				state: "unknown",
			},
		});
		expect(
			childrenOf(adapter.transcript, entryId("tool:toolu_earlier")).map(
				(each) => each.id,
			),
		).toEqual(["assistant:s1:0", "tool:toolu_sub_bash", "assistant:s2:0"]);
		expect(entry(adapter, "tool:toolu_sub_bash")).toMatchObject({
			status: "succeeded",
		});
		expect(childrenOf(adapter.transcript, null).map((each) => each.id)).toEqual(
			["user:u-go", "tool:toolu_send", "tool:toolu_earlier", "turn:1"],
		);
		expect(conversationStatus(adapter.transcript)).not.toBe("broken");
	});

	it("reads the same in a replay", () => {
		const live = played();
		const replayed = played();
		expect(replayed.transcript).toEqual(live.transcript);
	});
});

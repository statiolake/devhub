/**
 * A tool call's title: the tool, and the one argument that says what this
 * call does.
 */

import { describe, expect, it } from "vitest";
import { toolTitle } from "./toolTitle.js";

describe("a tool call's title", () => {
	it.each([
		["Bash", { command: "npm test\n--watch" }, "Bash: npm test"],
		["Edit", { file_path: "src/x.ts", old_string: "a" }, "Edit: src/x.ts"],
		[
			"SendMessage",
			{ to: "researcher", message: "hi", summary: "status" },
			"SendMessage: researcher — status",
		],
		[
			"SendMessage",
			{ recipient: "lead", content: "done" },
			"SendMessage: lead",
		],
		[
			"Monitor",
			{ command: "tail -f log", description: "watch the log" },
			"Monitor: watch the log",
		],
		["TaskStop", { task_id: "b7" }, "TaskStop: b7"],
		[
			"ToolSearch",
			{ query: "select:Read", max_results: 1 },
			"ToolSearch: select:Read",
		],
		[
			"TaskCreate",
			{ subject: "Write the docs", description: "all of them" },
			"TaskCreate: Write the docs",
		],
		[
			"TaskUpdate",
			{ taskId: "3", status: "completed" },
			"TaskUpdate: 3 → completed",
		],
		["TaskOutput", { task_id: "b7", block: true }, "TaskOutput: b7"],
		[
			"AskUserQuestion",
			{ questions: [{ question: "Which one?" }] },
			"AskUserQuestion: Which one?",
		],
		["ListAgents", {}, "ListAgents"],
	])("names %s by what it does", (name, input, title) => {
		expect(toolTitle(name, input)).toBe(title);
	});

	it("names an MCP tool by its server and tool, and its most telling argument", () => {
		expect(
			toolTitle("mcp__claude-in-chrome__computer", {
				action: "screenshot",
				tabId: 3,
			}),
		).toBe("claude-in-chrome · computer: screenshot");
		expect(
			toolTitle("mcp__playwright__browser_navigate", {
				url: "https://example.com",
			}),
		).toBe("playwright · browser_navigate: https://example.com");
		expect(toolTitle("mcp__srv__ping", { tabId: 3 })).toBe("srv · ping");
	});

	it("falls back to the most telling argument of a tool it has no word for, else the first worded one", () => {
		expect(toolTitle("Frobnicate", { level: 3, path: "a/b" })).toBe(
			"Frobnicate: a/b",
		);
		expect(toolTitle("Frobnicate", { level: 3, flavour: "mint" })).toBe(
			"Frobnicate: mint",
		);
		expect(toolTitle("Frobnicate", { level: 3 })).toBe("Frobnicate");
	});
});

describe("a TodoWrite call's title", () => {
	it("says how far the plan has come", () => {
		expect(
			toolTitle("TodoWrite", {
				todos: [
					{ content: "a", status: "completed" },
					{ content: "b", status: "pending" },
				],
			}),
		).toBe("TodoWrite: 1 of 2 done");
	});
});

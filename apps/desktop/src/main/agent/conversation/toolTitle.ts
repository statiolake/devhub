/**
 * A tool call's title, `Tool: what it does`, for either CLI: the tool's
 * name, and the one argument that says what this call does.
 *
 * A well-known tool has its argument named here. An MCP tool
 * (`mcp__server__tool`) is named by its server and tool. Any other tool, and
 * an MCP tool, is titled by its most telling argument — the first of
 * `TELLING` it has, else its first argument in words — so a transcript of
 * calls to tools DevHub has never heard of still reads as what they did,
 * not as a wall of their names.
 */

import type { JsonValue } from "../../../model/conversation.js";

type JsonObject = { readonly [key: string]: JsonValue };

/** Each well-known tool's title, from its input; undefined when the input lacks the word. */
const TITLES: Readonly<
	Record<string, (input: JsonObject) => string | undefined>
> = {
	Bash: field("command"),
	Read: field("file_path"),
	Edit: field("file_path"),
	MultiEdit: field("file_path"),
	Write: field("file_path"),
	NotebookEdit: field("notebook_path"),
	Glob: field("pattern"),
	Grep: field("pattern"),
	WebFetch: field("url"),
	WebSearch: field("query"),
	Task: field("description"),
	Agent: field("description"),
	Skill: field("skill"),
	SendMessage: (input) => {
		const to = text(input.to) ?? text(input.recipient);
		const summary = text(input.summary);
		return to === undefined
			? undefined
			: summary === undefined
				? to
				: `${to} — ${summary}`;
	},
	Monitor: (input) => text(input.description) ?? text(input.command),
	TaskStop: (input) => text(input.task_id) ?? text(input.shell_id),
	TaskOutput: (input) => text(input.task_id),
	TaskGet: (input) => text(input.taskId),
	TaskCreate: (input) => text(input.subject) ?? text(input.description),
	TaskUpdate: (input) => {
		const id = text(input.taskId);
		const status = text(input.status);
		return id === undefined
			? undefined
			: status === undefined
				? id
				: `${id} → ${status}`;
	},
	ToolSearch: field("query"),
	AskUserQuestion: (input) =>
		Array.isArray(input.questions) &&
		typeof input.questions[0] === "object" &&
		input.questions[0] !== null &&
		!Array.isArray(input.questions[0])
			? text((input.questions[0] as JsonObject).question)
			: undefined,
	// Tools whose title is their name: they take nothing that says more.
	ListAgents: () => undefined,
	ExitPlanMode: () => undefined,
	TodoWrite: () => undefined,
};

/** The arguments that most often say what a call does, most telling first. */
const TELLING = [
	"description",
	"command",
	"file_path",
	"path",
	"url",
	"query",
	"action",
	"name",
	"subject",
	"pattern",
	"prompt",
	"text",
];

export function toolTitle(name: string, input: JsonObject): string {
	const mcp = /^mcp__(.+?)__(.+)$/u.exec(name);
	const shown = mcp === null ? name : `${mcp[1]} · ${mcp[2]}`;
	const known = mcp === null ? TITLES[name] : undefined;
	const what =
		known !== undefined
			? known(input)
			: (TELLING.map((key) => text(input[key])).find(
					(value) => value !== undefined,
				) ??
				Object.values(input)
					.map(text)
					.find((value) => value !== undefined));
	return what === undefined ? shown : `${shown}: ${what}`;
}

function field(key: string): (input: JsonObject) => string | undefined {
	return (input) => text(input[key]);
}

/** A value's first line, when it is words. */
function text(value: JsonValue | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const line = value.split("\n", 1)[0]!.trim();
	return line === "" ? undefined : line;
}

import { describe, expect, it } from "vitest";
import {
	DEFAULT_WAIT_SECONDS,
	TELL_USAGE,
	parseTellArguments,
	tellCommandFrom,
	type TellCommand,
} from "./command.js";

function told(...argv: string[]): TellCommand {
	const parsed = parseTellArguments(argv);
	if (parsed.kind !== "tell") throw new Error(parsed.message);
	return parsed.command;
}

function refusal(...argv: string[]): string {
	const parsed = parseTellArguments(argv);
	if (parsed.kind !== "invalid") throw new Error("parsed");
	return parsed.message;
}

describe("devhub --tell's arguments", () => {
	it("reads help, and nothing, as help", () => {
		expect(told()).toEqual({ verb: "help" });
		expect(told("help")).toEqual({ verb: "help" });
	});

	it("takes --json before the subcommand", () => {
		expect(parseTellArguments(["--json", "agents"])).toEqual({
			kind: "tell",
			command: { verb: "agents" },
			json: true,
		});
		expect(parseTellArguments(["agents"])).toMatchObject({ json: false });
	});

	it("reads the listings", () => {
		expect(told("workspaces")).toEqual({ verb: "workspaces" });
		expect(told("agents", "--workspace", "scratch")).toEqual({
			verb: "agents",
			workspace: "scratch",
		});
		expect(told("agents", "--workspace=~/src/app")).toEqual({
			verb: "agents",
			workspace: "~/src/app",
		});
		expect(told("commands")).toEqual({ verb: "commands" });
	});

	it("reads workspace open, with and without a worktree", () => {
		expect(told("workspace", "open", "~/src/app")).toEqual({
			verb: "workspace-open",
			path: "~/src/app",
		});
		expect(
			told("workspace", "open", ".", "--worktree", "12-fix-login"),
		).toEqual({ verb: "workspace-open", path: ".", worktree: "12-fix-login" });
		expect(refusal("workspace", "close", ".")).toContain("open");
		expect(refusal("workspace", "open")).toContain("<path>");
	});

	it("reads agent new without a workspace, for the asking pane's", () => {
		expect(told("agent", "new", "--profile", "claude")).toEqual({
			verb: "agent-new",
			profile: "claude",
		});
		expect(tellCommandFrom({ verb: "agent-new" })).toEqual({
			verb: "agent-new",
		});
	});

	it("reads agent new", () => {
		expect(
			told(
				"agent",
				"new",
				"--workspace",
				"w1",
				"--profile",
				"claude",
				"--name",
				"API fix",
				"--prompt",
				"fix it",
				"--gui",
			),
		).toEqual({
			verb: "agent-new",
			workspace: "w1",
			profile: "claude",
			name: "API fix",
			prompt: "fix it",
			presentation: "gui",
		});
		expect(
			refusal("agent", "new", "--workspace", "w", "--gui", "--tui"),
		).toContain("--gui");
	});

	it("reads issue assign with a branch of the caller's choosing", () => {
		expect(
			told(
				"issue",
				"assign",
				"https://github.com/o/r/issues/123",
				"--branch",
				"123-fix-login-timeout",
				"--prompt-extra",
				"keep it small",
			),
		).toEqual({
			verb: "issue-assign",
			url: "https://github.com/o/r/issues/123",
			branch: "123-fix-login-timeout",
			prompt: "keep it small",
			place: "worktree",
			editorOnly: false,
		});
		expect(
			told("issue", "assign", "u", "--root", "--editor-only", "--repo", "~/r"),
		).toEqual({
			verb: "issue-assign",
			url: "u",
			repo: "~/r",
			place: "root",
			editorOnly: true,
		});
		expect(refusal("issue", "assign", "u", "--root", "--worktree")).toContain(
			"--root",
		);
	});

	it("reads the per-agent subcommands", () => {
		expect(told("agent", "read", "a1", "--last", "5", "--since", "e9")).toEqual(
			{ verb: "agent-read", agent: "a1", last: 5, since: "e9" },
		);
		expect(told("agent", "send", "a1", "please", "--also", "this")).toEqual({
			verb: "agent-send",
			agent: "a1",
			text: "please --also this",
		});
		expect(told("agent", "send", "a1", "-")).toEqual({
			verb: "agent-send",
			agent: "a1",
			text: "-",
		});
		expect(told("agent", "interrupt", "a1")).toEqual({
			verb: "agent-interrupt",
			agent: "a1",
		});
		expect(told("agent", "requests", "a1")).toEqual({
			verb: "agent-requests",
			agent: "a1",
		});
		expect(told("agent", "wait", "a1")).toEqual({
			verb: "agent-wait",
			agent: "a1",
			until: "any",
			timeoutSeconds: DEFAULT_WAIT_SECONDS,
		});
		expect(
			told("agent", "wait", "a1", "--until", "idle", "--timeout", "30"),
		).toMatchObject({ until: "idle", timeoutSeconds: 30 });
		expect(refusal("agent", "wait", "a1", "--until", "soon")).toContain(
			"--until",
		);
		expect(refusal("agent", "wait", "a1", "--timeout", "9999")).toContain(
			"--timeout",
		);
		expect(refusal("agent", "read", "a1", "--last", "x")).toContain("--last");
	});

	it("reads an answer by option numbers or by words", () => {
		expect(
			told("agent", "answer", "a1", "r1", "--option", "2", "--option", "3"),
		).toEqual({
			verb: "agent-answer",
			agent: "a1",
			request: "r1",
			options: [2, 3],
		});
		expect(told("agent", "answer", "a1", "r1", "--text", "Postgres")).toEqual({
			verb: "agent-answer",
			agent: "a1",
			request: "r1",
			options: [],
			text: "Postgres",
		});
		expect(refusal("agent", "answer", "a1", "r1")).toContain("--option");
	});

	it("never takes a permission answer", () => {
		expect(refusal("agent", "answer", "a1", "r1", "--allow")).toContain(
			"permission",
		);
		expect(refusal("agent", "answer", "a1", "r1", "--deny")).toContain(
			"permission",
		);
	});

	it("refuses what it does not know, in a sentence", () => {
		expect(refusal("launch-missiles")).toContain("not a --tell subcommand");
		expect(refusal("agents", "--bogus")).toContain("--bogus");
		expect(refusal("agents", "extra")).toContain("extra");
		expect(refusal("agent", "dance")).toContain("agent takes");
	});

	it("reads run, focus and notify", () => {
		expect(told("run", "next_agent")).toEqual({
			verb: "run",
			command: "next_agent",
		});
		expect(told("focus", "a1")).toEqual({ verb: "focus", target: "a1" });
		expect(told("notify", "all", "done")).toEqual({
			verb: "notify",
			text: "all done",
		});
	});
});

describe("a tell command off the socket", () => {
	it("accepts what the parser produces", () => {
		const commands: TellCommand[] = [
			{ verb: "help" },
			{ verb: "workspaces" },
			{ verb: "workspace-open", path: "/src/app", worktree: "1-x" },
			{ verb: "agents", workspace: "w" },
			{ verb: "agent-new", workspace: "w", prompt: "p", presentation: "tui" },
			{
				verb: "issue-assign",
				url: "u",
				repo: "/r",
				branch: "b",
				place: "root",
				editorOnly: false,
			},
			{ verb: "agent-read", agent: "a", last: 3, since: "e" },
			{ verb: "agent-send", agent: "a", text: "t" },
			{ verb: "agent-interrupt", agent: "a" },
			{ verb: "agent-requests", agent: "a" },
			{
				verb: "agent-answer",
				agent: "a",
				request: "r",
				options: [1],
				text: "t",
			},
			{ verb: "agent-wait", agent: "a", until: "waiting", timeoutSeconds: 10 },
			{ verb: "commands" },
			{ verb: "run", command: "next_agent" },
			{ verb: "focus", target: "a" },
			{ verb: "notify", text: "n" },
		];
		for (const command of commands)
			expect(tellCommandFrom(JSON.parse(JSON.stringify(command)))).toEqual(
				command,
			);
	});

	it("refuses anything else", () => {
		expect(() => tellCommandFrom(null)).toThrow();
		expect(() => tellCommandFrom({ verb: "shell" })).toThrow(/unknown/);
		expect(() =>
			tellCommandFrom({ verb: "workspace-open", path: "relative" }),
		).toThrow(/absolute/);
		expect(() =>
			tellCommandFrom({
				verb: "agent-wait",
				agent: "a",
				until: "any",
				timeoutSeconds: 100000,
			}),
		).toThrow(/timeoutSeconds/);
		expect(() =>
			tellCommandFrom({
				verb: "agent-answer",
				agent: "a",
				request: "r",
				options: ["1"],
			}),
		).toThrow(/option/);
		expect(() =>
			tellCommandFrom({ verb: "agent-new", workspace: "w", presentation: "x" }),
		).toThrow(/presentation/);
	});
});

describe("devhub --tell terminal", () => {
	it("opens to the right by default, and takes every option", () => {
		expect(told("terminal", "open")).toEqual({
			verb: "terminal-open",
			split: "right",
			focus: false,
		});
		expect(
			told(
				"terminal",
				"open",
				"--split",
				"below",
				"--cwd",
				"api",
				"--command",
				"npm run dev",
				"--name",
				"Server",
				"--beside",
				"Tests",
				"--focus",
			),
		).toEqual({
			verb: "terminal-open",
			split: "below",
			cwd: "api",
			command: "npm run dev",
			name: "Server",
			beside: "Tests",
			focus: true,
		});
		expect(told("terminal", "open", "--below")).toMatchObject({
			split: "below",
		});
	});

	it("refuses a side it does not know, and two that disagree", () => {
		expect(refusal("terminal", "open", "--split", "diagonal")).toMatch(
			/right, below, left or above/,
		);
		expect(refusal("terminal", "open", "--split", "left", "--right")).toMatch(
			/disagree/,
		);
		expect(refusal("terminal", "spawn")).toMatch(/open, list, resolve, close/);
	});

	it("reads list, resolve and close", () => {
		expect(told("terminal", "list")).toEqual({ verb: "terminal-list" });
		expect(told("terminals")).toEqual({ verb: "terminal-list" });
		expect(told("terminal", "resolve", "right", "top")).toEqual({
			verb: "terminal-resolve",
			query: "right top",
		});
		expect(refusal("terminal", "resolve")).toMatch(/missing <side>/);
		expect(told("terminal", "close", "Tests")).toEqual({
			verb: "terminal-close",
			terminal: "Tests",
		});
	});

	it("takes back off the socket exactly what it parses", () => {
		for (const command of [
			told("terminal", "open", "--split", "above", "--name", "x"),
			told("terminal", "list"),
			told("terminal", "resolve", "below"),
			told("terminal", "close", "%3"),
		]) {
			expect(tellCommandFrom(JSON.parse(JSON.stringify(command)))).toEqual(
				command,
			);
		}
		expect(() =>
			tellCommandFrom({
				verb: "terminal-open",
				split: "right",
				focus: false,
				cwd: "relative",
			}),
		).toThrow(/absolute/);
		expect(() =>
			tellCommandFrom({ verb: "terminal-open", split: "up", focus: false }),
		).toThrow(/split/);
	});

	it("is in the help", () => {
		expect(TELL_USAGE).toContain(
			"terminal open [--split right|below|left|above]",
		);
		expect(TELL_USAGE).toContain("terminal resolve <side>");
	});
});

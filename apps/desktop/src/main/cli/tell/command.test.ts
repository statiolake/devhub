import { describe, expect, it } from "vitest";
import {
	DEFAULT_WAIT_SECONDS,
	TELL_USAGE,
	parseTellArguments,
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
		expect(refusal("workspace", "remove", ".")).toBe(
			"workspace takes: open, close, status, manage, unmanage.",
		);
		expect(refusal("workspace", "open")).toContain("<path>");
	});

	it("reads workspace close and status, and takes them back off the socket", () => {
		const close = told(
			"workspace",
			"close",
			"app",
			"--worktree=remove",
			"--agents",
			"stop",
			"--terminals",
			"close",
			"--discard-unsaved",
		);
		expect(close).toEqual({
			verb: "workspace-close",
			workspace: "app",
			worktree: "remove",
			agents: "stop",
			terminals: "close",
			discardUnsaved: true,
		});
		expect(told("workspace", "close", "w1")).toEqual({
			verb: "workspace-close",
			workspace: "w1",
			discardUnsaved: false,
		});
		expect(told("workspace", "status", "w1")).toEqual({
			verb: "workspace-status",
			workspace: "w1",
		});
		expect(refusal("workspace", "status")).toBe("missing <w>.");
		expect(told("workspace", "manage", "w1")).toEqual({
			verb: "workspace-manage",
			workspace: "w1",
			managed: true,
		});
		expect(told("workspace", "unmanage", "w1")).toEqual({
			verb: "workspace-manage",
			workspace: "w1",
			managed: false,
		});
		expect(refusal("workspace", "manage")).toBe("missing <w>.");
	});

	it("reads agent new without a workspace, for the asking pane's", () => {
		expect(told("agent", "new", "--profile", "claude")).toEqual({
			verb: "agent-new",
			profile: "claude",
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

	it("reads --managed / --unmanaged and agent manage / unmanage", () => {
		expect(told("agent", "new", "--managed")).toEqual({
			verb: "agent-new",
			managed: true,
		});
		expect(told("issue", "assign", "u", "--unmanaged")).toMatchObject({
			verb: "issue-assign",
			managed: false,
		});
		expect(refusal("agent", "new", "--managed", "--unmanaged")).toContain(
			"--managed and --unmanaged",
		);
		expect(told("agent", "manage", "A")).toEqual({
			verb: "agent-manage",
			agent: "A",
			managed: true,
		});
		expect(told("agent", "unmanage", "A")).toEqual({
			verb: "agent-manage",
			agent: "A",
			managed: false,
		});
	});

	it("reads agent keep with a note or --clear, never both or neither", () => {
		expect(told("agent", "keep", "A", "--note", " 他チームの依頼 ")).toEqual({
			verb: "agent-keep",
			agent: "A",
			note: "他チームの依頼",
		});
		expect(told("agent", "keep", "A", "--clear")).toEqual({
			verb: "agent-keep",
			agent: "A",
		});
		expect(refusal("agent", "keep", "A")).toContain("--note");
		expect(refusal("agent", "keep", "A", "--note", "x", "--clear")).toContain(
			"--clear",
		);
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

	it("reads issue assign's --name and --offline", () => {
		expect(
			told(
				"issue",
				"assign",
				"u",
				"--branch",
				"b",
				"--name",
				"login fix",
				"--offline",
			),
		).toEqual({
			verb: "issue-assign",
			url: "u",
			branch: "b",
			name: "login fix",
			offline: true,
			place: "worktree",
			editorOnly: false,
		});
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

describe("devhub --tell terminal", () => {
	it("opens your own terminal, with a command and the keyboard if asked", () => {
		expect(told("terminal", "open")).toEqual({
			verb: "terminal-open",
			focus: false,
		});
		expect(
			told("terminal", "open", "--command", "npm run dev", "--focus"),
		).toEqual({
			verb: "terminal-open",
			command: "npm run dev",
			focus: true,
		});
	});

	it("has no positions, names or folders any more: it is always yours", () => {
		for (const flag of ["--split", "--cwd", "--name", "--beside"]) {
			expect(refusal("terminal", "open", flag, "x"), flag).toBeDefined();
		}
		expect(refusal("terminal", "open", "--below")).toBeDefined();
		expect(refusal("terminal", "resolve", "right")).toMatch(
			/open, status \(or show\), close, panes, bring/,
		);
		expect(refusal("terminal", "list")).toMatch(/open, status/);
		expect(refusal("terminal", "close", "Tests")).toBeDefined();
	});

	it("reads status (and show) and close", () => {
		expect(told("terminal", "status")).toEqual({ verb: "terminal-status" });
		expect(told("terminal", "show")).toEqual({ verb: "terminal-status" });
		expect(told("terminal", "close")).toEqual({ verb: "terminal-close" });
	});

	it("lists the editor's panes and brings one by its tmux id", () => {
		expect(told("terminal", "panes")).toEqual({ verb: "terminal-panes" });
		expect(told("terminal", "bring", "%7")).toEqual({
			verb: "terminal-bring",
			pane: "%7",
			focus: false,
		});
		expect(told("terminal", "bring", "%7", "--focus")).toMatchObject({
			focus: true,
		});
		expect(refusal("terminal", "bring")).toMatch(/<pane>/);
		expect(refusal("terminal", "bring", "ws-1:0.1")).toMatch(/%7/);
	});

	it("is in the help", () => {
		expect(TELL_USAGE).toContain("terminal open [--command <cmd>] [--focus]");
		expect(TELL_USAGE).toContain("terminal status");
		expect(TELL_USAGE).toContain("terminal bring <pane> [--focus]");
		expect(TELL_USAGE).not.toContain("terminal resolve");
		expect(TELL_USAGE).not.toContain("--split");
	});
});

describe("devhub --tell's orchestration commands", () => {
	it("reads stop, restart and status of one agent", () => {
		expect(told("agent", "stop", "A1")).toEqual({
			verb: "agent-stop",
			agent: "A1",
		});
		expect(told("agent", "restart", "A1")).toEqual({
			verb: "agent-restart",
			agent: "A1",
		});
		expect(told("agent", "status", "A1")).toEqual({
			verb: "agent-status",
			agent: "A1",
		});
		expect(refusal("agent", "stop")).toMatch(/<agent>/);
		expect(refusal("agent", "stop", "A1", "B2")).toMatch(/unexpected/);
		// No sheet to answer and nothing to force: the command is the decision.
		expect(refusal("agent", "stop", "A1", "--force")).toMatch(/not an option/);
	});

	it("reads wait --any and --all over named agents, or all of a workspace", () => {
		expect(told("agent", "wait", "--any", "A1", "B2")).toEqual({
			verb: "agent-wait-many",
			mode: "any",
			agents: ["A1", "B2"],
			until: "any",
			timeoutSeconds: DEFAULT_WAIT_SECONDS,
		});
		expect(
			told(
				"agent",
				"wait",
				"--all",
				"--workspace",
				"scratch",
				"--until",
				"idle",
				"--timeout",
				"30",
			),
		).toEqual({
			verb: "agent-wait-many",
			mode: "all",
			agents: [],
			workspace: "scratch",
			until: "idle",
			timeoutSeconds: 30,
		});
		// One agent, as before.
		expect(told("agent", "wait", "A1")).toMatchObject({ verb: "agent-wait" });
		expect(refusal("agent", "wait", "--any", "--all")).toMatch(/different/);
		expect(refusal("agent", "wait", "A1", "--workspace", "w")).toMatch(
			/--any or --all/,
		);
		expect(refusal("agent", "wait", "--any", "--timeout", "601")).toMatch(
			/from 1 to 600/,
		);
	});

	it("reads sessions and agent resume", () => {
		expect(told("sessions")).toEqual({ verb: "sessions", limit: 20 });
		expect(
			told(
				"sessions",
				"--workspace",
				".",
				"--profile",
				"codex",
				"--limit",
				"5",
			),
		).toEqual({
			verb: "sessions",
			workspace: ".",
			profile: "codex",
			limit: 5,
		});
		expect(
			told("agent", "resume", "7f3a", "--workspace", "w1", "--name", "API"),
		).toEqual({
			verb: "agent-resume",
			session: "7f3a",
			workspace: "w1",
			name: "API",
		});
		expect(refusal("agent", "resume")).toMatch(/<session>/);
		expect(refusal("sessions", "--limit", "0")).toMatch(/from 1/);
	});

	it("is in the help", () => {
		for (const line of [
			"agent status <a>",
			"agent wait --any [<a>...]",
			"agent wait --all [<a>...]",
			"agent stop <a>",
			"agent restart <a>",
			"sessions [--workspace <w> | --folder <path> | --all] [--profile <p>]",
			"agent resume <session>",
		])
			expect(TELL_USAGE).toContain(line);
	});
});

describe("devhub --tell link", () => {
	it("reads what to link to, a file's line and column apart", () => {
		expect(told("link", "agent", "aaaa")).toEqual({
			verb: "link",
			kind: "agent",
			target: "aaaa",
		});
		expect(told("link", "escalation", "#12")).toEqual({
			verb: "link",
			kind: "escalation",
			target: "12",
		});
		expect(told("link", "orchestrator")).toEqual({
			verb: "link",
			kind: "orchestrator",
		});
		expect(told("link", "file", "/a/b.ts:12:3")).toEqual({
			verb: "link",
			kind: "file",
			target: "/a/b.ts",
			line: 12,
			column: 3,
		});
		expect(told("link", "file", "src/b.ts")).toEqual({
			verb: "link",
			kind: "file",
			target: "src/b.ts",
		});
		expect(refusal("link", "robot", "x")).toMatch(/agent, workspace, file/u);
		expect(refusal("link", "agent")).toMatch(/<agent>/u);
		expect(refusal("link", "file", "a.ts:0")).toMatch(/start at 1/u);
		expect(TELL_USAGE).toContain("link agent <a> | workspace <w> | file");
	});

	it("takes --link on escalation ask", () => {
		expect(
			told(
				"escalation",
				"ask",
				"3",
				"--body",
				"b",
				"--link",
				"devhub:orchestrator",
			),
		).toEqual({
			verb: "escalation-ask",
			id: 3,
			body: "b",
			options: [],
			links: ["devhub:orchestrator"],
		});
	});
});

describe("devhub --tell escalation link", () => {
	it("takes an agent, links, or both, after the escalation was raised", () => {
		expect(told("escalation", "link", "12", "--agent", "aaaa")).toEqual({
			verb: "escalation-link",
			id: 12,
			agent: "aaaa",
		});
		expect(
			told(
				"escalation",
				"link",
				"#12",
				"--link",
				"https://github.com/o/r/pull/3",
				"--link",
				"devhub:orchestrator",
			),
		).toEqual({
			verb: "escalation-link",
			id: 12,
			links: ["https://github.com/o/r/pull/3", "devhub:orchestrator"],
		});
		expect(refusal("escalation", "link", "12")).toContain(
			"--agent <a>, one or more --link <url>, or both",
		);
	});
});

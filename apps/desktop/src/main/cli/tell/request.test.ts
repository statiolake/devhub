import { describe, expect, it } from "vitest";
import { TELL_USAGE } from "./command.js";
import {
	expandWorkspacePath,
	tellFromWords,
	withStdinText,
} from "./request.js";

function command(argv: string[], cwd = "/work", stdin?: string) {
	const words = tellFromWords(argv, cwd, "/home/d", stdin);
	if (words.kind !== "tell") throw new Error(JSON.stringify(words));
	return words;
}

describe("devhub --tell's words, as the app reads them", () => {
	it("parses them as typed, --json and free text that looks like an option included", () => {
		expect(command(["--json", "agent", "send", "a1", "--force=yes"])).toEqual({
			kind: "tell",
			json: true,
			command: { verb: "agent-send", agent: "a1", text: "--force=yes" },
		});
	});

	it("refuses a command line in a sentence", () => {
		expect(
			tellFromWords(
				["agent", "answer", "a", "r", "--allow"],
				"/",
				"/h",
				undefined,
			),
		).toEqual({
			kind: "invalid",
			message:
				"permission prompts are answered in DevHub, by the person, and never from the command line.",
		});
	});

	it("answers help with the usage", () => {
		expect(tellFromWords(["help"], "/", "/h", undefined)).toEqual({
			kind: "help",
			usage: TELL_USAGE,
		});
		expect(tellFromWords([], "/", "/h", undefined).kind).toBe("help");
	});

	it("makes paths absolute where they were typed", () => {
		expect(command(["workspace", "open", "~/src/app"]).command).toEqual({
			verb: "workspace-open",
			path: "/home/d/src/app",
		});
		expect(
			command(["issue", "assign", "u", "--repo", "app"]).command,
		).toMatchObject({ repo: "/work/app" });
		expect(
			command(["sessions", "--folder", "../tools"], "/work/app").command,
		).toMatchObject({ verb: "sessions", folder: "/work/tools" });
		expect(
			command(["agent", "resume", "c1", "--folder", "~/x"]).command,
		).toMatchObject({ verb: "agent-resume", folder: "/home/d/x" });
		expect(
			command(["agent", "new", "--workspace", "."], "/srv/app").command,
		).toEqual({ verb: "agent-new", workspace: "/srv/app" });
		expect(command(["terminal", "open", "--focus"]).command).toMatchObject({
			verb: "terminal-open",
			focus: true,
		});
	});

	it("carries an outside caller's --as label", () => {
		expect(command(["--as", "claude-desktop", "skill"])).toEqual({
			kind: "tell",
			json: false,
			command: { verb: "skill" },
			as: "claude-desktop",
		});
	});

	it("asks for what is piped in when a '-' is text, and only then", () => {
		expect(
			tellFromWords(["agent", "send", "a", "-"], "/", "/h", undefined),
		).toEqual({ kind: "needs-stdin" });
		expect(
			command(["agent", "send", "a", "-"], "/", "long\nmessage\n").command,
		).toEqual({ verb: "agent-send", agent: "a", text: "long\nmessage" });
		expect(command(["agent", "send", "a", "hi"]).command).toEqual({
			verb: "agent-send",
			agent: "a",
			text: "hi",
		});
	});

	it("makes a workspace spelled as a relative path absolute, and nothing else", () => {
		expect(expandWorkspacePath(".", "/srv/app", "/home/d")).toBe("/srv/app");
		expect(expandWorkspacePath("../lib", "/srv/app", "/home/d")).toBe(
			"/srv/lib",
		);
		expect(expandWorkspacePath("~/x", "/srv/app", "/home/d")).toBe("/home/d/x");
		expect(expandWorkspacePath("scratch", "/srv", "/home/d")).toBe("scratch");
		expect(expandWorkspacePath("w1", "/srv", "/home/d")).toBe("w1");
		expect(expandWorkspacePath("/abs", "/srv", "/home/d")).toBe("/abs");
	});

	it("puts piped text where '-' stood", () => {
		expect(
			withStdinText({ verb: "agent-new", workspace: "w", prompt: "-" }, "p"),
		).toEqual({ verb: "agent-new", workspace: "w", prompt: "p" });
		expect(
			withStdinText({ verb: "agent-send", agent: "a", text: "hi" }, "ignored"),
		).toEqual({ verb: "agent-send", agent: "a", text: "hi" });
	});
});

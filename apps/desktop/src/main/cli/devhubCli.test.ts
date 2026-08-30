import { describe, expect, it } from "vitest";
import { parseArguments, requestFor, USAGE } from "./devhubCli.js";

describe("what the devhub command was asked to do", () => {
	it("takes a lone path as something to open", () => {
		expect(parseArguments(["src/main.ts"])).toEqual({
			kind: "open",
			path: "src/main.ts",
		});
	});

	it("takes an agent profile, with no arguments of its own", () => {
		expect(parseArguments(["--agent", "claude"])).toEqual({
			kind: "add-agent",
			profileId: "claude",
			args: [],
		});
	});

	it("gives everything after `--` to the agent, options included", () => {
		expect(
			parseArguments(["--agent", "claude", "--", "--help", "-p", "hi"]),
		).toEqual({
			kind: "add-agent",
			profileId: "claude",
			args: ["--help", "-p", "hi"],
		});
	});

	it("prints its usage on request, and on nonsense", () => {
		expect(parseArguments(["--help"])).toEqual({ kind: "usage", exitCode: 0 });
		expect(parseArguments([])).toEqual({ kind: "usage", exitCode: 2 });
		expect(parseArguments(["--agent"])).toEqual({ kind: "usage", exitCode: 2 });
		expect(parseArguments(["--agent", "--help"])).toEqual({
			kind: "usage",
			exitCode: 2,
		});
		// Agent arguments have to be behind `--`, so that a future DevHub option
		// cannot silently start meaning something to the agent instead.
		expect(parseArguments(["--agent", "claude", "--help"])).toEqual({
			kind: "usage",
			exitCode: 2,
		});
		expect(parseArguments(["a.txt", "b.txt"])).toEqual({
			kind: "usage",
			exitCode: 2,
		});
		expect(USAGE).toContain("devhub --agent");
	});

	it("sends an absolute path and the directory it was typed in", () => {
		expect(
			requestFor(parseArguments(["notes.md"]), "/work/a", "/home/d"),
		).toEqual({ kind: "open", path: "/work/a/notes.md", cwd: "/work/a" });
		expect(
			requestFor(parseArguments(["~/notes.md"]), "/work/a", "/home/d"),
		).toEqual({ kind: "open", path: "/home/d/notes.md", cwd: "/work/a" });
	});

	it("sends the current directory with an agent request, because that is what picks the workspace", () => {
		expect(
			requestFor(
				parseArguments(["--agent", "codex", "--", "-m", "gpt"]),
				"/work/a/sub",
				"/home/d",
			),
		).toEqual({
			kind: "add-agent",
			profileId: "codex",
			args: ["-m", "gpt"],
			cwd: "/work/a/sub",
		});
	});
});

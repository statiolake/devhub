import { describe, expect, it } from "vitest";
import { parseArguments, requestFor, USAGE } from "./devhubCli.js";

describe("what the devhub command was asked to do", () => {
	it("takes a lone path as something to open", () => {
		expect(parseArguments(["src/main.ts"])).toEqual({
			kind: "open",
			path: "src/main.ts",
			position: undefined,
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

	/**
	 * `devhub` with nothing after it is the smallest useful thing the command
	 * does: it brings the app you already have to the front. It is deliberately
	 * not the usage text — a bare command that prints a wall of help is a
	 * command that made you read instead of doing the obvious thing.
	 */
	it("takes no arguments at all as a request to come to the front", () => {
		expect(parseArguments([])).toEqual({ kind: "activate" });
		expect(requestFor(parseArguments([]), "/work", "/home/d")).toEqual({
			kind: "activate",
		});
		expect(USAGE).toContain("bring the running DevHub to the front");
	});

	/**
	 * A lone `-` is the pipe. It must not be read as an option nobody knows,
	 * and it must not be read as a file named `-`: both would report on
	 * something the person never asked about.
	 */
	it("takes a lone dash as the pipe, and only on its own", () => {
		expect(parseArguments(["-"])).toEqual({ kind: "open-stdin" });
		expect(parseArguments(["-", "notes.md"])).toEqual({
			kind: "invalid",
			message: "devhub does one of these things at a time.",
		});
		expect(parseArguments(["-", "--version"]).kind).toBe("invalid");
		expect(USAGE).toContain("devhub -  ");
	});

	/**
	 * There is no file yet when `-` is parsed — `main` spools stdin to one and
	 * carries on as an ordinary open of that file. A request built straight
	 * from `open-stdin` would have to invent a path, so it refuses instead.
	 */
	it("has no request to send for a pipe it has not read yet", () => {
		expect(() =>
			requestFor(parseArguments(["-"]), "/work", "/home/d"),
		).toThrowError(/spooled to a file/);
	});

	it("prints its usage on request", () => {
		expect(parseArguments(["--help"])).toEqual({ kind: "usage" });
		expect(parseArguments(["-h"])).toEqual({ kind: "usage" });
		expect(USAGE).toContain("devhub --agent");
		expect(USAGE).toContain("--install-extension");
		expect(USAGE).toContain("--list-extensions");
		expect(USAGE).toContain("--goto");
	});

	it("says what is wrong rather than printing the whole usage at nothing", () => {
		// `devhub` alone is a request, not a mistake — see the activate test.
		// Arguments that add up to no request still are one.
		expect(parseArguments(["--force"])).toEqual({
			kind: "invalid",
			message: "devhub was not asked to do anything.",
		});
		expect(parseArguments(["--agent"])).toEqual({
			kind: "invalid",
			message: "--agent needs the name of an agent profile.",
		});
		expect(parseArguments(["--agent", "--help"])).toEqual({
			kind: "invalid",
			message: "--agent needs the name of an agent profile.",
		});
		// Agent arguments have to be behind `--`, so that a future DevHub option
		// cannot silently start meaning something to the agent instead.
		expect(parseArguments(["--agent", "claude", "--help"]).kind).toBe(
			"invalid",
		);
		expect(parseArguments(["a.txt", "b.txt"])).toEqual({
			kind: "invalid",
			message: "devhub opens one path at a time.",
		});
	});

	/**
	 * The whole point of the refusal: an option nobody implemented must never
	 * become a path, because "no such file or directory: --isntall-extension"
	 * is a report about the wrong thing entirely.
	 */
	it("refuses an option it does not know, and never treats one as a path", () => {
		expect(parseArguments(["--isntall-extension", "a.b"])).toEqual({
			kind: "invalid",
			message: "devhub does not know the option '--isntall-extension'.",
		});
		expect(parseArguments(["-x"])).toEqual({
			kind: "invalid",
			message: "devhub does not know the option '-x'.",
		});
		expect(parseArguments(["--new-window", "/work"])).toEqual({
			kind: "invalid",
			message: "devhub does not know the option '--new-window'.",
		});
	});

	it("reads --goto in every form code reads it", () => {
		expect(parseArguments(["--goto", "src/a.ts:42:7"])).toEqual({
			kind: "open",
			path: "src/a.ts",
			position: { line: 42, column: 7 },
		});
		// A line without a column is the start of the line.
		expect(parseArguments(["-g", "src/a.ts:42"])).toEqual({
			kind: "open",
			path: "src/a.ts",
			position: { line: 42, column: 1 },
		});
		// No position at all is a plain open, as `code --goto file` is.
		expect(parseArguments(["--goto", "src/a.ts"])).toEqual({
			kind: "open",
			path: "src/a.ts",
			position: undefined,
		});
		// A colon can be part of a path; only trailing numbers are a position.
		expect(parseArguments(["--goto", "/w/a:b/c.ts:3"])).toEqual({
			kind: "open",
			path: "/w/a:b/c.ts",
			position: { line: 3, column: 1 },
		});
	});

	it("refuses a --goto that does not name a place in a file", () => {
		expect(parseArguments(["--goto"]).kind).toBe("invalid");
		expect(parseArguments(["--goto", "a.ts:0"]).kind).toBe("invalid");
		expect(parseArguments(["--goto", "a.ts:2.5"]).kind).toBe("invalid");
		expect(parseArguments(["--goto", "a.ts:"]).kind).toBe("invalid");
	});

	it("collects extensions to install, in any order, with --force", () => {
		expect(
			parseArguments([
				"--install-extension",
				"a.b",
				"--force",
				"--install-extension",
				"./c.vsix",
			]),
		).toEqual({
			kind: "install-extensions",
			targets: ["a.b", "./c.vsix"],
			force: true,
		});
		// `--option=value` means the same thing, as it does for `code`.
		expect(parseArguments(["--install-extension=a.b"])).toEqual({
			kind: "install-extensions",
			targets: ["a.b"],
			force: false,
		});
		expect(parseArguments(["--install-extension"]).kind).toBe("invalid");
	});

	it("collects extensions to uninstall, and lists them", () => {
		expect(
			parseArguments([
				"--uninstall-extension",
				"a.b",
				"--uninstall-extension",
				"c.d",
			]),
		).toEqual({
			kind: "uninstall-extensions",
			ids: ["a.b", "c.d"],
			force: false,
		});
		expect(parseArguments(["--list-extensions"])).toEqual({
			kind: "list-extensions",
			showVersions: false,
		});
		expect(parseArguments(["--list-extensions", "--show-versions"])).toEqual({
			kind: "list-extensions",
			showVersions: true,
		});
	});

	it("prints its versions", () => {
		expect(parseArguments(["--version"])).toEqual({ kind: "version" });
		expect(parseArguments(["-v"])).toEqual({ kind: "version" });
	});

	it("does one thing at a time", () => {
		expect(
			parseArguments(["--list-extensions", "--install-extension", "a.b"]),
		).toEqual({
			kind: "invalid",
			message: "devhub does one of these things at a time.",
		});
		expect(parseArguments(["--version", "/work"]).kind).toBe("invalid");
		expect(parseArguments(["--goto", "a.ts:2", "b.ts"]).kind).toBe("invalid");
	});

	it("sends an absolute path and the directory it was typed in", () => {
		expect(
			requestFor(parseArguments(["notes.md"]), "/work/a", "/home/d"),
		).toEqual({ kind: "open", path: "/work/a/notes.md", cwd: "/work/a" });
		expect(
			requestFor(parseArguments(["~/notes.md"]), "/work/a", "/home/d"),
		).toEqual({ kind: "open", path: "/home/d/notes.md", cwd: "/work/a" });
		expect(
			requestFor(parseArguments(["-g", "notes.md:9:2"]), "/work/a", "/home/d"),
		).toEqual({
			kind: "open",
			path: "/work/a/notes.md",
			cwd: "/work/a",
			position: { line: 9, column: 2 },
		});
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

	/**
	 * A `.vsix` may be a relative path and an id may not, and only VS Code's own
	 * rule knows which a target is. So the targets go over as they were typed,
	 * with the directory they were typed in, and the app decides.
	 */
	it("sends extension targets untouched, with the directory to resolve them against", () => {
		expect(
			requestFor(
				parseArguments(["--install-extension", "a.b", "--force"]),
				"/work/a",
				"/home/d",
			),
		).toEqual({
			kind: "install-extensions",
			targets: ["a.b"],
			force: true,
			cwd: "/work/a",
		});
		expect(
			requestFor(
				parseArguments(["--uninstall-extension", "a.b"]),
				"/work/a",
				"/home/d",
			),
		).toEqual({ kind: "uninstall-extensions", ids: ["a.b"], force: false });
		expect(
			requestFor(parseArguments(["--version"]), "/work/a", "/home/d"),
		).toEqual({ kind: "version" });
	});

	it("has nothing to send when there is nothing to do", () => {
		expect(
			requestFor(parseArguments(["--force"]), "/work", "/home/d"),
		).toBeUndefined();
		expect(
			requestFor(parseArguments(["--help"]), "/work", "/home/d"),
		).toBeUndefined();
	});
});

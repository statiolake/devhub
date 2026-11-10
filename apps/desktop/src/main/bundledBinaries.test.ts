/**
 * DevHub runs only the binaries it carries or delivers, never whatever
 * happens to be installed — not node, not bash, not tmux
 * (`docs/bundled-binaries.md`).
 *
 * A bundled or delivered program is always named by a path DevHub computed
 * (`bundledBash()`, `bundledNeovim()`, `Runtime.tmuxProgram()`, an installed
 * tool's `program`, `process.execPath`), never by a literal. So every literal
 * program name in a runtime spawn — an `argv`, a `file`, a `spawn`/`execFile`
 * call, an array that starts a `-c`, a script's `#!` — is something of the
 * system's or the person's, and each one has to be on the list below with
 * the reason it is not DevHub's to carry. A new one fails this test until it
 * is either replaced by a bundled binary or justified here and in the doc.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DESKTOP = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The programs DevHub may name by a literal, and why each is the system's or
 * the person's rather than DevHub's (category (c) in the doc).
 */
const SYSTEM_PROGRAMS: Readonly<Record<string, string>> = {
	// The POSIX bootstrap: always by its absolute path, never `sh` from a PATH.
	"/bin/sh":
		"the POSIX shell every macOS and Linux has at this path; it runs DevHub's POSIX scripts and execs DevHub's own binaries by path",
	// POSIX base utilities, run on whichever machine the runtime is (a host's
	// layout is not known, so they are named, not pathed): DevHub relies on
	// their POSIX behaviour only.
	rm: "POSIX base utility",
	mv: "POSIX base utility",
	test: "POSIX base utility",
	sleep: "POSIX base utility",
	ps: "POSIX base utility (process table: the Task Manager, an Agent pane's processes)",
	// This Mac's own, by absolute path (main's own readings, never a host's).
	"/bin/ps":
		"the process table the Task Manager reads, macOS's (and Linux's) own",
	"/usr/bin/open":
		"macOS's launcher: starts DevHub.app itself (the devhub launcher)",
	"/usr/sbin/sysctl": "macOS system memory reading (Task Manager)",
	"/usr/bin/vm_stat": "macOS system memory reading (Task Manager)",
	// The person's, with their credentials and configuration.
	git: "the person's git: their repositories, config, hooks and credentials",
	gh: "the person's GitHub CLI: their GitHub sign-in",
};

/** Never by a bare name or a `/usr/bin/env` lookup: these are DevHub's to carry. */
const DEVHUB_CARRIES = [
	"sh",
	"bash",
	"zsh",
	"node",
	"nodejs",
	"tmux",
	"nvim",
	"env",
	"python",
	"python3",
	"perl",
	"ruby",
];

/** Where a runtime spawn names its program. */
const PROGRAM_LITERALS: readonly RegExp[] = [
	/\bargv:\s*\[\s*"([^"]+)"/gu,
	/\b(?:spawn|spawnSync|execFile|execFileSync|nodeSpawn)\(\s*"([^"]+)"/gu,
	/\bfile:\s*"([a-z/][\w./-]*)"/gu,
	/\[\s*"((?:\/[^"]*\/)?(?:sh|bash|zsh|dash|ksh))",\s*"-c",/gu,
	/\brun\(\s*runtime,\s*\[\s*"([^"]+)"/gu,
	/\b(?:sources\.run|output)\(\s*"([^"]+)"/gu,
	/\)\(\s*"([^"]+)",\s*\[/gu,
	/\[\s*"(\/[^"]+)",\s*"-/gu,
	/#!(\/[^\s"`',\\]+)/gu,
];

function runtimeSources(): string[] {
	const found: string[] = [];
	const walk = (directory: string): void => {
		for (const name of readdirSync(directory)) {
			const path = join(directory, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (
				path.endsWith(".ts") &&
				!path.endsWith(".test.ts") &&
				// A CLI's screens, as data: what Codex prints, not what DevHub runs.
				!path.endsWith(".fixture.ts")
			) {
				found.push(path);
			}
		}
	};
	for (const root of ["src/main", "src/model", "src/ipc"]) {
		walk(join(DESKTOP, root));
	}
	return found;
}

/** The source without its comments' lines, so prose naming a program is not a spawn. */
function code(text: string): string {
	return text
		.split("\n")
		.filter((line) => !/^\s*(?:\*|\/\/|\/\*)/u.test(line))
		.join("\n");
}

function programsIn(text: string): string[] {
	const programs: string[] = [];
	for (const pattern of PROGRAM_LITERALS) {
		for (const match of text.matchAll(pattern)) {
			// `/path/to/…` is a placeholder in prose DevHub hands an Agent.
			if (match[1] !== undefined && !match[1].startsWith("/path/to/")) {
				programs.push(match[1]);
			}
		}
	}
	return programs;
}

describe("the programs DevHub runs", () => {
	const sources = runtimeSources().map((path) => ({
		path: relative(DESKTOP, path),
		text: code(readFileSync(path, "utf8")),
	}));

	it("names no program by a literal that is not bundled or justified", () => {
		const unjustified = sources.flatMap(({ path, text }) =>
			programsIn(text)
				.filter((program) => !(program in SYSTEM_PROGRAMS))
				.map((program) => `${path}: ${program}`),
		);
		expect(unjustified).toEqual([]);
	});

	it("never looks a program up with /usr/bin/env", () => {
		const lookups = sources
			.filter(({ text }) => text.includes("/usr/bin/env"))
			.map(({ path }) => path);
		expect(lookups).toEqual([]);
	});

	// `env -0` prints the login environment and runs nothing, so `env` alone
	// is not caught here; `/usr/bin/env` is, above.
	it("starts no bash, node, tmux or nvim by name from a script", () => {
		const carried = DEVHUB_CARRIES.filter((name) => name !== "env").join("|");
		const started = new RegExp(
			`(?:^|[\\s;|&({\`'"])(?:exec\\s+|command\\s+)?(?:${carried})\\s+-[A-Za-z0-9]`,
			"u",
		);
		const offenders = sources.flatMap(({ path, text }) =>
			text
				.split("\n")
				.filter((line) => started.test(line))
				.map((line) => `${path}: ${line.trim()}`),
		);
		expect(offenders).toEqual([]);
	});

	// What DevHub runs or delivers is in the app (`out/`, `out/host-tools`),
	// put there by the build (`scripts/fetch-binaries.mjs`): nothing is
	// fetched at runtime, for this Mac or for a host.
	it("downloads no binary at runtime", () => {
		const downloads = sources.flatMap(({ path, text }) =>
			text
				.split("\n")
				.filter((line) =>
					/releases\/download|nodejs\.org\/dist|DownloadUrl/u.test(line),
				)
				.map((line) => `${path}: ${line.trim()}`),
		);
		expect(downloads).toEqual([]);
	});

	it("is a list that names nothing DevHub carries", () => {
		for (const name of DEVHUB_CARRIES) {
			expect(Object.keys(SYSTEM_PROGRAMS)).not.toContain(name);
		}
	});

	// The scanner itself: each shape a spawn takes is seen.
	it("sees every shape a spawn takes", () => {
		expect(
			programsIn(
				[
					'argv: ["bash", "-c", x]',
					'spawn("node", [])',
					'{ file: "tmux", args }',
					'return ["sh", "-c", SCRIPT]',
					'run(runtime, ["nvim", "--version"])',
					'output("python3", [])',
					'outputOf(seen)("perl", ["-e"])',
					'["/usr/local/bin/zsh", "-l"]',
					"`#!/usr/bin/env bash\\n`",
				].join("\n"),
			),
		).toEqual(
			expect.arrayContaining([
				"bash",
				"node",
				"tmux",
				"sh",
				"nvim",
				"python3",
				"perl",
				"/usr/local/bin/zsh",
				"/usr/bin/env",
			]),
		);
	});
});

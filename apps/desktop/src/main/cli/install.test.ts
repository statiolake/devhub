import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeScratchDir, removeScratchDir } from "../../model/testScratch.js";
import { installLauncher, launcherScript, shellQuote } from "./install.js";

describe("installing the devhub launcher", () => {
	let scratch: string;
	let request: Parameters<typeof installLauncher>[0];

	beforeEach(() => {
		scratch = makeScratchDir("cli-install");
		request = {
			execPath: join(scratch, "Code - OSS"),
			cliScript: join(scratch, "out", "main", "cli", "devhubCli.js"),
			socketPath: join(scratch, "user-data", "devhub", "control.sock"),
			commandName: "devhub",
			profile: "default",
			launchCommand: ["/usr/bin/open", "-a", "/Applications/DevHub.app"],
			home: scratch,
			pathValue: "/usr/bin:/bin",
		};
	});

	afterEach(() => {
		removeScratchDir(scratch);
	});

	it("writes an executable launcher into the first writable candidate", () => {
		const first = join(scratch, "first");
		mkdirSync(first);
		const result = installLauncher({
			...request,
			candidates: [first, join(scratch, "second")],
		});
		expect(result.launcherPath).toBe(join(first, "devhub"));
		expect(statSync(result.launcherPath).mode & 0o777).toBe(0o755);
		expect(readFileSync(result.launcherPath, "utf8")).toContain(
			"ELECTRON_RUN_AS_NODE=1",
		);
	});

	/**
	 * The CLI cannot work out how to start DevHub — a checkout and a bundle are
	 * started in different ways, and only the app that wrote this script knows
	 * which it is. So the script carries the answer, and a shell can read it
	 * back exactly as it was written.
	 */
	it("records how to start DevHub, so the CLI does not have to guess", () => {
		const launcher = join(scratch, "bin");
		const result = installLauncher({
			...request,
			launchCommand: ["/usr/bin/open", "-a", "/Applications/My DevHub.app"],
			candidates: [launcher],
		});
		const script = readFileSync(result.launcherPath, "utf8");
		expect(script).toContain("DEVHUB_LAUNCH_COMMAND=");
		// The value the shell would set, read back through a shell rather than
		// by unquoting it here: a second unquoting rule is how the quoting and
		// the reading come to disagree about a path with a space in it.
		const value = execFileSync(
			"/bin/sh",
			["-c", `${launcherLine(script)}; printf %s "$DEVHUB_LAUNCH_COMMAND"`],
			{ encoding: "utf8" },
		);
		expect(JSON.parse(value)).toEqual([
			"/usr/bin/open",
			"-a",
			"/Applications/My DevHub.app",
		]);
	});

	it("falls back to the next candidate when one is not writable, and never uses sudo", () => {
		const missingSystemDirectory = "/definitely-not-writable-by-a-test";
		const fallback = join(scratch, ".local", "bin");
		const result = installLauncher({
			...request,
			candidates: [missingSystemDirectory, fallback],
		});
		expect(result.launcherPath).toBe(join(fallback, "devhub"));
		expect(result.message).toContain("does not use sudo");
		expect(result.message).not.toContain("sudo ");
	});

	it("names what to add to PATH when the directory it used is not on it", () => {
		const fallback = join(scratch, ".local", "bin");
		const result = installLauncher({ ...request, candidates: [fallback] });
		expect(result.message).toContain(`export PATH="${fallback}:$PATH"`);
	});

	it("says nothing about PATH when the directory is already on it", () => {
		const directory = join(scratch, "bin");
		mkdirSync(directory);
		const result = installLauncher({
			...request,
			candidates: [directory],
			pathValue: `/usr/bin:${directory}`,
		});
		expect(result.message).not.toContain("PATH");
	});

	it("refuses rather than reporting a success it did not achieve", () => {
		expect(() =>
			installLauncher({ ...request, candidates: ["/definitely-not-writable"] }),
		).toThrow(/would take the launcher/);
	});

	it("quotes every path it bakes in, so a space cannot split a word", () => {
		const script = launcherScript({
			...request,
			execPath: "/Apps/Code - OSS",
			socketPath: "/a b/control.sock",
		});
		expect(script).toContain("exec '/Apps/Code - OSS'");
		expect(script).toContain("DEVHUB_CONTROL_SOCKET='/a b/control.sock'");
		expect(shellQuote("it's")).toBe(`'it'\\''s'`);
	});

	it("installs a profile's own command, carrying the profile to the CLI", () => {
		const directory = join(scratch, "bin");
		mkdirSync(directory);
		const result = installLauncher({
			...request,
			commandName: "devhub-dev",
			profile: "dev",
			candidates: [directory],
		});
		expect(result.launcherPath).toBe(join(directory, "devhub-dev"));
		expect(readFileSync(result.launcherPath, "utf8")).toContain(
			"DEVHUB_PROFILE='dev'",
		);
	});
});

/** The `DEVHUB_LAUNCH_COMMAND=...` assignment out of the generated script. */
function launcherLine(script: string): string {
	const line = script
		.split("\n")
		.find((candidate) => candidate.startsWith("DEVHUB_LAUNCH_COMMAND="));
	if (line === undefined) throw new Error("the launcher records no command");
	return line.replace(/\\$/, "");
}

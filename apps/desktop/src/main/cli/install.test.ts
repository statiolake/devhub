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

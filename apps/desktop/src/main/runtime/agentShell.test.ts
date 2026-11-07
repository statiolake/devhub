/**
 * Which shell Claude Code gets on a machine: the decision, and the probe it
 * is made from.
 */

import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	agentShellProbe,
	claudeShellDecision,
	needsDeliveredBash,
	noShellRefusal,
	parseAgentShellProbe,
} from "./agentShell.js";

const DELIVERED = "/home/me/.devhub-server/bash/5.3.20/bin/bash";

describe("the shell a Claude Agent runs with", () => {
	// A Mac, a Debian box: Claude Code finds its own, and DevHub adds nothing.
	it("leaves a machine with bash as it is", () => {
		expect(needsDeliveredBash("/usr/bin/bash")).toBe(false);
		expect(claudeShellDecision("box", "/usr/bin/bash", undefined)).toEqual({
			kind: "host",
			shell: "/usr/bin/bash",
		});
	});

	it("leaves a machine with zsh as it is", () => {
		expect(claudeShellDecision("mac", "/bin/zsh", undefined)).toEqual({
			kind: "host",
			shell: "/bin/zsh",
		});
	});

	// What a delivery came to is not read when the machine has its own: a
	// failed one must not refuse a machine that never needed it.
	it("ignores a delivery when the machine has its own shell", () => {
		expect(
			claudeShellDecision("box", "/bin/bash", { kind: "failed", reason: "x" }),
		).toEqual({ kind: "host", shell: "/bin/bash" });
	});

	// The NAS: DevHub's bash, as both the variable Claude Code reads for it
	// and `SHELL` — for that process only, which is the caller's business.
	it("gives a machine with neither DevHub's bash", () => {
		expect(needsDeliveredBash(undefined)).toBe(true);
		expect(
			claudeShellDecision("nas", undefined, {
				kind: "installed",
				path: DELIVERED,
			}),
		).toEqual({
			kind: "delivered",
			environment: { CLAUDE_CODE_SHELL: DELIVERED, SHELL: DELIVERED },
		});
	});

	it("refuses, naming the machine, the reason and the fix, when the delivery failed", () => {
		const decision = claudeShellDecision("nas", undefined, {
			kind: "failed",
			reason:
				"DevHub could not get the bash 5.3.20 it installs on nas (linux-armv7l): 404",
		});
		expect(decision.kind).toBe("refused");
		const message = decision.kind === "refused" ? decision.message : "";
		expect(message).toContain("Claude Code needs bash or zsh on nas");
		expect(message).toContain("linux-armv7l");
		expect(message).toContain("404");
		expect(message).toContain("opkg install bash");
		expect(message).toBe(
			noShellRefusal(
				"nas",
				"DevHub could not get the bash 5.3.20 it installs on nas (linux-armv7l): 404",
			),
		);
	});

	it("calls a decision made without trying the delivery a bug", () => {
		expect(() => claudeShellDecision("nas", undefined, undefined)).toThrow(
			/a bug in DevHub/u,
		);
	});
});

/**
 * The probe, run by this machine's `/bin/sh` against a made-up machine: a
 * PATH and fixed directories of its own, with stand-ins for the shells.
 */
describe("asking a machine for the shell Claude Code would find", () => {
	let root: string;
	let path: string;
	let fixed: string;

	beforeEach(async () => {
		root = await mkdtemp("/tmp/devhub-agent-shell-");
		path = join(root, "path");
		fixed = join(root, "fixed");
		await mkdir(path);
		await mkdir(fixed);
		// `sh` itself, which every machine has and which is not enough.
		await shell(path, "sh");
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	async function shell(directory: string, name: string): Promise<string> {
		const file = join(directory, name);
		await writeFile(file, "#!/bin/sh\n");
		await chmod(file, 0o755);
		return file;
	}

	function probe(env: Record<string, string>): string | undefined {
		const run = spawnSync("/bin/sh", ["-c", agentShellProbe([fixed])], {
			env: { PATH: path, ...env },
			encoding: "utf8",
		});
		expect(run.status).toBe(0);
		return parseAgentShellProbe(run.stdout);
	}

	it("finds nothing on a busybox machine", () => {
		expect(probe({ SHELL: join(path, "sh") })).toBeUndefined();
	});

	it("takes $SHELL first when it is a bash or a zsh", async () => {
		await shell(path, "zsh");
		const bash = await shell(fixed, "bash");
		expect(probe({ SHELL: bash })).toBe(bash);
	});

	it("then zsh, then bash, on PATH", async () => {
		const bash = await shell(path, "bash");
		expect(probe({ SHELL: join(path, "sh") })).toBe(bash);
		const zsh = await shell(path, "zsh");
		expect(probe({ SHELL: join(path, "sh") })).toBe(zsh);
	});

	// Claude Code also looks in the usual directories, so a bash there is one
	// it would find by itself.
	it("then the usual directories", async () => {
		const bash = await shell(fixed, "bash");
		expect(probe({})).toBe(bash);
	});

	it("does not take a $SHELL that is not there", () => {
		expect(probe({ SHELL: join(root, "gone", "bash") })).toBeUndefined();
	});
});

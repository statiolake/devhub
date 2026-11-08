/**
 * The orphaned-process-group SIGHUP that closed DevHub, reproduced with real
 * processes and the real helper.
 *
 * A "DevHub main" here is a Node process started as a session and group
 * leader (`detached: true`, so `setsid`), the way launchd starts the app. It
 * stops one child of its own group with SIGSTOP — a frozen workbench — and
 * then a process that qualified its group exits, leaving a child behind in it.
 * The kernel then hangs the whole group up, the leader included: that is the
 * SIGHUP Electron took as "quit". The trigger is `devhub-pgrp-anchor` itself
 * ending — it is exactly such a process — so the same binary is both the way
 * the group gets orphaned and, a second copy holding on, the fix.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProcessGroupAnchor } from "./processGroupAnchor.js";

const SOURCE = fileURLToPath(
	new URL("../native/processGroupAnchor.c", import.meta.url),
);

function compiler(): string | undefined {
	for (const candidate of ["cc", "clang"]) {
		try {
			execFileSync(candidate, ["--version"], { stdio: "ignore" });
			return candidate;
		} catch {
			// Not this one.
		}
	}
	return undefined;
}

const cc = process.platform === "win32" ? undefined : compiler();

/** The "DevHub main": prints `hup` or `no-hup` and exits. */
const LEADER = `
import { spawn } from "node:child_process";
const [helper, mode] = process.argv.slice(2);
let hup = false;
process.on("SIGHUP", () => { hup = true; });
const anchored = (child) => new Promise((resolve, reject) => {
	let out = "";
	child.stdout.on("data", (d) => { out += d; if (/^anchored /m.test(out)) resolve(); });
	child.on("error", reject);
	child.on("exit", (code) => reject(new Error("helper exited " + code)));
});
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
// A frozen workbench: a stopped member of this process group.
const frozen = spawn("sleep", ["30"], { stdio: "ignore" });
await pause(100);
process.kill(frozen.pid, "SIGSTOP");
let guard;
if (mode === "anchored") {
	guard = spawn(helper, [], { stdio: ["pipe", "pipe", "inherit"] });
	await anchored(guard);
}
// Something that qualified the group ends, leaving a child in it.
const trigger = spawn(helper, [], { stdio: ["pipe", "pipe", "inherit"] });
await anchored(trigger);
trigger.stdin.end();
await new Promise((r) => trigger.on("close", r));
await pause(500);
try { process.kill(frozen.pid, "SIGKILL"); } catch {}
guard?.stdin.end();
console.log(hup ? "hup" : "no-hup");
process.exit(0);
`;

describe.skipIf(cc === undefined)("devhub-pgrp-anchor", () => {
	let directory = "";
	let helper = "";
	let leader = "";

	beforeAll(() => {
		directory = mkdtempSync(join(tmpdir(), "devhub-anchor-"));
		helper = join(directory, "devhub-pgrp-anchor");
		execFileSync(cc!, [
			"-O2",
			"-Wall",
			"-Wextra",
			"-Werror",
			"-o",
			helper,
			SOURCE,
		]);
		leader = join(directory, "leader.mjs");
		writeFileSync(leader, LEADER);
	});

	afterAll(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	function runLeader(mode: "bare" | "anchored"): Promise<string> {
		return new Promise((resolve, reject) => {
			const child = spawn(process.execPath, [leader, helper, mode], {
				// A session and group leader of its own, as DevHub's main is.
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
			});
			let out = "";
			let err = "";
			child.stdout.on("data", (d: Buffer) => (out += d.toString()));
			child.stderr.on("data", (d: Buffer) => (err += d.toString()));
			child.on("error", reject);
			child.on("close", (code, signal) => {
				if (code === 0) resolve(out.trim());
				else
					reject(new Error(`leader ended ${String(code ?? signal)}: ${err}`));
			});
		});
	}

	it("without it, a frozen member and one exit hang up the whole group, its leader too", async () => {
		expect(await runLeader("bare")).toBe("hup");
	});

	it("with it holding, the same exit hangs up nobody", async () => {
		expect(await runLeader("anchored")).toBe("no-hup");
	});

	// What it was started with stays open in it for as long as DevHub runs, so
	// it keeps none of it: a descriptor of main's that is not close-on-exec
	// (here 7, opened by the shell that execs the helper) is not among its
	// own, nor its keeper's.
	it.runIf(process.platform === "linux")(
		"holds nothing open but its stdio, nor does its keeper",
		async () => {
			const child = spawn(
				"/bin/sh",
				["-c", 'exec 7</dev/null; exec "$0"', helper],
				{ stdio: ["pipe", "pipe", "inherit"] },
			);
			try {
				const line = await new Promise<string>((resolve, reject) => {
					let out = "";
					child.stdout.on("data", (d: Buffer) => {
						out += d.toString();
						if (out.includes("\n")) resolve(out);
					});
					child.on("error", reject);
				});
				const [, anchorPid, keeperPid] =
					/^anchored (\d+) (\d+)/u.exec(line) ?? [];
				expect(anchorPid).toBe(String(child.pid));
				// Its stdio and the pipe to its keeper; the keeper, that pipe.
				const anchor = readdirSync(`/proc/${anchorPid!}/fd`).map(Number);
				expect(anchor.filter((fd) => fd > 2).length).toBeLessThanOrEqual(1);
				expect(anchor).not.toContain(7);
				const keeper = readdirSync(`/proc/${keeperPid!}/fd`).map(Number);
				expect(keeper.filter((fd) => fd > 2).length).toBeLessThanOrEqual(1);
				expect(keeper).not.toContain(7);
			} finally {
				child.stdin.end();
			}
		},
	);

	it("ProcessGroupAnchor says it holds once the helper has anchored, and lets go on stop", async () => {
		const lines: string[] = [];
		const anchor = new ProcessGroupAnchor({
			helper,
			exists: () => true,
			spawn: (file) => spawn(file, [], { stdio: ["pipe", "pipe", "pipe"] }),
			log: (line) => lines.push(line),
			schedule: () => undefined,
		});
		expect(anchor.anchored()).toBe(false);
		anchor.start();
		const end = Date.now() + 5_000;
		while (!anchor.anchored() && Date.now() < end) {
			await new Promise((r) => setTimeout(r, 20));
		}
		expect(anchor.anchored()).toBe(true);
		anchor.stop();
		expect(anchor.anchored()).toBe(false);
		expect(lines.join("\n")).toMatch(/holding/);
	});
});

describe("ProcessGroupAnchor without its helper", () => {
	it("never says it holds, and says once why", () => {
		const lines: string[] = [];
		const anchor = new ProcessGroupAnchor({
			helper: "/nowhere/devhub-pgrp-anchor",
			exists: () => false,
			spawn: () => {
				throw new Error("not to be started");
			},
			log: (line) => lines.push(line),
			schedule: () => undefined,
		});
		anchor.start();
		anchor.start();
		expect(anchor.anchored()).toBe(false);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/not be frozen/);
	});
});

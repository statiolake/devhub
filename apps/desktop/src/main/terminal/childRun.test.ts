/**
 * A child that does not read all of its input, run here.
 *
 * A mebibyte is far more than a pipe holds, so the write is certain to meet
 * a reader that has gone: the EPIPE always arrives, and what is checked is
 * which answer it becomes.
 */

import { describe, expect, it } from "vitest";

import { runChildHere, type ChildOutcome } from "./childRun.js";

function run(script: string): Promise<ChildOutcome> {
	return runChildHere({
		file: "/bin/sh",
		args: ["-c", script],
		cwd: undefined,
		env: { PATH: process.env.PATH },
		stdin: new Uint8Array(1024 * 1024),
		stdoutBytes: 4096,
		stderrBytes: 4096,
		overflow: "truncate",
		streamOutput: false,
	}).outcome;
}

describe("a child that leaves its input unread", () => {
	it("and refuses, answers with its own status and stderr", async () => {
		const outcome = await run("echo 'the host has ended' >&2; exit 4");
		expect(outcome).toMatchObject({ kind: "closed", code: 4, signal: null });
		expect(
			Buffer.from((outcome as { stderr: Uint8Array }).stderr).toString(),
		).toBe("the host has ended\n");
	});

	it("and calls it a success, is a failure to take its input", async () => {
		const outcome = await run("exit 0");
		expect(outcome).toMatchObject({
			kind: "stdin-error",
			error: { code: "EPIPE" },
		});
	});

	it("that reads it all is simply closed", async () => {
		const outcome = await run("cat >/dev/null");
		expect(outcome).toMatchObject({ kind: "closed", code: 0 });
	});
});

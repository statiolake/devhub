/**
 * What any `Runtime` must do, asked of every implementation there is.
 *
 * There is one today, so this reads as a test of `LocalRuntime`. It is not:
 * it is the definition of the interface, written as cases rather than as a
 * docstring, and the remote runtime will be run through the same function.
 * That is the only way the promise the seam makes — *a feature that works on
 * one machine works on the other* — can be checked rather than asserted, and
 * writing it now is what stops the remote arm from being built against
 * whatever the local one happens to do.
 */

import { Buffer } from "node:buffer";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OperationDeadline } from "../terminal/command.js";
import { CancellationToken, PortFailure } from "../terminal/ports.js";
import { LocalRuntime } from "./local.js";
import { RuntimeFileError, type ExecLimits, type Runtime } from "./runtime.js";

const TRUNCATING: ExecLimits = {
	stdoutBytes: 64 * 1024,
	stderrBytes: 8 * 1024,
	overflow: { kind: "truncate" },
};

function run(
	runtime: Runtime,
	argv: readonly string[],
	extra: Partial<{
		cwd: string;
		stdin: Uint8Array;
		limits: ExecLimits;
		timeoutMs: number;
		cancel: CancellationToken;
	}> = {},
) {
	return runtime.exec({
		argv,
		cwd: extra.cwd,
		env: { PATH: process.env["PATH"] },
		stdin: extra.stdin,
		deadline: OperationDeadline.in(extra.timeoutMs ?? 10_000),
		cancel: extra.cancel ?? new CancellationToken(),
		limits: extra.limits ?? TRUNCATING,
	});
}

/** Every case any runtime has to pass. */
export function describeRuntimeContract(
	name: string,
	make: () => Runtime,
): void {
	describe(`${name} runtime contract`, () => {
		let runtime: Runtime;
		let scratch: string;

		beforeEach(async () => {
			runtime = make();
			scratch = await mkdtemp(join(tmpdir(), "devhub-runtime-"));
		});
		afterEach(async () => {
			await rm(scratch, { recursive: true, force: true });
		});

		describe("exec", () => {
			it("answers with what the command wrote and how it ended", async () => {
				const result = await run(runtime, ["/bin/echo", "hello"]);
				expect(result.stdout.toString("utf8")).toBe("hello\n");
				expect(result.code).toBe(0);
				expect(result.signal).toBeNull();
			});

			it("carries a non-zero exit rather than throwing for it", async () => {
				const result = await run(runtime, ["/bin/sh", "-c", "exit 3"]);
				expect(result.code).toBe(3);
			});

			it("keeps stderr apart from stdout", async () => {
				const result = await run(runtime, [
					"/bin/sh",
					"-c",
					"echo out; echo err >&2",
				]);
				expect(result.stdout.toString("utf8")).toBe("out\n");
				expect(result.stderr.toString("utf8")).toBe("err\n");
			});

			it("passes each argument as one word, whatever is in it", async () => {
				// The property `exec` takes an argv for. A remote runtime gets it
				// back by quoting; a local one gets it from `spawn`; neither may
				// let a space, a quote or a `$` split or expand.
				const awkward = "one two 'three' $HOME\nfour";
				const result = await run(runtime, ["/bin/echo", "-n", awkward]);
				expect(result.stdout.toString("utf8")).toBe(awkward);
			});

			it("runs where it was told to", async () => {
				const result = await run(runtime, ["/bin/pwd"], { cwd: scratch });
				expect(result.stdout.toString("utf8").trim()).toBe(
					await runtime.realpath(scratch),
				);
			});

			it("puts the environment it was given on the command", async () => {
				const result = await runtime.exec({
					argv: ["/bin/sh", "-c", 'printf %s "$DEVHUB_CONTRACT"'],
					env: { DEVHUB_CONTRACT: "yes" },
					deadline: OperationDeadline.in(10_000),
					cancel: new CancellationToken(),
					limits: TRUNCATING,
				});
				expect(result.stdout.toString("utf8")).toBe("yes");
			});

			it("feeds stdin without putting it on the command line", async () => {
				const result = await run(runtime, ["/bin/cat"], {
					stdin: Buffer.from("a secret\n", "utf8"),
				});
				expect(result.stdout.toString("utf8")).toBe("a secret\n");
			});

			it("truncates an over-long answer when asked to", async () => {
				const result = await run(
					runtime,
					["/bin/sh", "-c", "printf 'xxxxxx'"],
					{
						limits: {
							stdoutBytes: 2,
							stderrBytes: 2,
							overflow: { kind: "truncate" },
						},
					},
				);
				expect(result.stdout.toString("utf8")).toBe("xx");
				expect(result.code).toBe(0);
			});

			it("refuses an over-long answer when asked to", async () => {
				await expect(
					run(runtime, ["/bin/sh", "-c", "printf 'xxxxxx'"], {
						limits: {
							stdoutBytes: 2,
							stderrBytes: 2,
							overflow: {
								kind: "fail",
								failure: () => new Error("too much"),
							},
						},
					}),
				).rejects.toThrow("too much");
			});

			it("gives up on silence at the deadline", async () => {
				await expect(
					run(runtime, ["/bin/sleep", "30"], { timeoutMs: 60 }),
				).rejects.toMatchObject({ code: "timed_out" });
			});

			it("stops when the operation is abandoned", async () => {
				const cancel = new CancellationToken();
				const running = run(runtime, ["/bin/sleep", "30"], { cancel });
				cancel.cancel();
				await expect(running).rejects.toBeInstanceOf(PortFailure);
			});

			it("says a program is unavailable rather than hanging", async () => {
				await expect(
					run(runtime, [join(scratch, "no-such-program")]),
				).rejects.toMatchObject({ code: "unavailable" });
			});
		});

		describe("probes", () => {
			it("tells a directory from a file from nothing there", async () => {
				await writeFile(join(scratch, "a-file"), "x");
				expect(await runtime.stat(scratch)).toBe("directory");
				expect(await runtime.stat(join(scratch, "a-file"))).toBe("file");
				expect(await runtime.stat(join(scratch, "nope"))).toBe("absent");
			});

			it("says nothing-there for a path under a file, not a failure", async () => {
				// `ENOTDIR`. It is the same answer as `ENOENT` and always has
				// been: there is nothing at that path.
				await writeFile(join(scratch, "a-file"), "x");
				expect(await runtime.stat(join(scratch, "a-file", "deeper"))).toBe(
					"absent",
				);
			});

			it("reads a file, bounded, and stops at the bound", async () => {
				await writeFile(join(scratch, "long"), "abcdefghij");
				expect(await runtime.readTextFile(join(scratch, "long"), 4)).toBe(
					"abcd",
				);
				expect(await runtime.readTextFile(join(scratch, "long"), 100)).toBe(
					"abcdefghij",
				);
			});

			it("names the path and the errno when it could not look", async () => {
				await expect(
					runtime.readTextFile(join(scratch, "absent"), 10),
				).rejects.toBeInstanceOf(RuntimeFileError);
			});

			it("writes a file and reads back what it wrote", async () => {
				await runtime.writeTextFile(join(scratch, "written"), "hi", 0o600);
				expect(await runtime.readTextFile(join(scratch, "written"), 64)).toBe(
					"hi",
				);
			});

			it("lists a directory, saying which entries are directories", async () => {
				await runtime.makeDirectory(join(scratch, "sub"));
				await writeFile(join(scratch, "leaf"), "x");
				const entries = [...(await runtime.readdir(scratch))].sort(
					(left, right) => left.name.localeCompare(right.name),
				);
				expect(entries).toEqual([
					{ name: "leaf", directory: false },
					{ name: "sub", directory: true },
				]);
			});

			it("removes a tree, and removing nothing is not a failure", async () => {
				await runtime.makeDirectory(join(scratch, "tree", "deep"));
				await writeFile(join(scratch, "tree", "deep", "leaf"), "x");
				await runtime.removeTree(join(scratch, "tree"));
				expect(await runtime.stat(join(scratch, "tree"))).toBe("absent");
				await runtime.removeTree(join(scratch, "tree"));
			});

			it("canonicalises a path", async () => {
				await runtime.makeDirectory(join(scratch, "real"));
				expect(await runtime.realpath(join(scratch, "real", ".."))).toBe(
					await runtime.realpath(scratch),
				);
			});

			it("answers with a home directory", async () => {
				expect(await runtime.home()).toMatch(/^\//u);
			});
		});

		describe("watchGitDirectory", () => {
			it("fires when the git directory is written to", async () => {
				await runtime.makeDirectory(join(scratch, "repo", ".git", "refs"));
				let fired = 0;
				const watcher = await runtime.watchGitDirectory(
					join(scratch, "repo"),
					() => {
						fired += 1;
					},
				);
				// Kept writing until it is seen: arming a watch is not
				// instantaneous on every platform, and a single write racing the
				// arm would make this a test of the scheduler.
				await vi.waitUntil(
					async () => {
						await writeFile(
							join(scratch, "repo", ".git", "HEAD"),
							`ref: x${String(fired)}\n`,
						);
						return fired > 0;
					},
					{ timeout: 5000, interval: 50 },
				);
				watcher.close();
			});

			it("follows a linked worktree's `.git` file to the real directory", async () => {
				await runtime.makeDirectory(
					join(scratch, "main", ".git", "worktrees", "w", "refs"),
				);
				await runtime.makeDirectory(join(scratch, "linked"));
				await writeFile(
					join(scratch, "linked", ".git"),
					`gitdir: ${join(scratch, "main", ".git", "worktrees", "w")}\n`,
				);
				let fired = 0;
				const watcher = await runtime.watchGitDirectory(
					join(scratch, "linked"),
					() => {
						fired += 1;
					},
				);
				await vi.waitUntil(
					async () => {
						await writeFile(
							join(scratch, "main", ".git", "worktrees", "w", "HEAD"),
							`ref: y${String(fired)}\n`,
						);
						return fired > 0;
					},
					{ timeout: 5000, interval: 50 },
				);
				watcher.close();
			});

			it("refuses a folder that is not a checkout at all", async () => {
				await runtime.makeDirectory(join(scratch, "plain"));
				await expect(
					runtime.watchGitDirectory(join(scratch, "plain"), () => {}),
				).rejects.toThrow();
			});
		});

		describe("reading", () => {
			it("names the machine and counts what has been run on it", async () => {
				// Reach the machine first. What a runtime asks a machine it has
				// not spoken to yet — its `$HOME`, its login environment — is
				// counted too, because those are round trips and a reading that
				// hid them would under-report what DevHub costs a host. They
				// happen once, so the count is taken after they have.
				await run(runtime, ["/bin/echo", "x"]);
				const before = runtime.reading();
				expect(before.id).toBe(runtime.id);
				await run(runtime, ["/bin/echo", "x"]);
				const after = runtime.reading();
				expect(after.execsLastMinute).toBe(before.execsLastMinute + 1);
				expect(after.reconcileIntervalMs).toBe(
					runtime.cadence.reconcileIntervalMs,
				);
			});
		});
	});
}

describeRuntimeContract("local", () => new LocalRuntime());

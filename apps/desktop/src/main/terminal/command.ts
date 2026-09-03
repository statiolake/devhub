/**
 * Running one bounded provider command.
 *
 * Ported from `run_bounded` and its readers in the Rust `terminal/mod.rs`.
 * Every tmux invocation goes through here, and every one of them is bounded in
 * three ways at once: an operation deadline that started at the caller's first
 * probe, a byte cap per stream, and cancellation. A provider that hangs, floods
 * or forks must not be able to hold an operation open.
 *
 * Node gives the concurrency the Rust needed threads for: the child's streams
 * are events, so there is no reader thread to join and no grace window to leak.
 * What is preserved exactly is the budget — the deadline covers the drain, not
 * only the exit — and which failure wins when several apply.
 */

import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import {
	CancellationToken,
	portFailure,
	type RuntimeLaunchContext,
} from "./ports.js";

export const MAX_OUTPUT_BYTES = 128 * 1024;
export const MAX_STDERR_BYTES = 16 * 1024;
export const MAX_LINES = 2048;
export const MAX_LINE_BYTES = 4096;
export const MAX_ROOT_METADATA_BYTES = 16 * 1024;

/**
 * How long an operation may go without an answer from the provider.
 *
 * It is a watchdog on *silence*, not a budget for the whole operation. The
 * distinction is the difference between a runtime that has stopped answering
 * and one that is merely being asked a lot: an attach runs a sequence of
 * commands, and on a cold start several attaches and the Agent reconciler all
 * do it at once. Every one of those commands answered in milliseconds and the
 * operation still ran past a fixed three-second budget — which reported "the
 * terminal runtime did not answer in time" about a tmux that had answered
 * every single time. Retrying it once the machine was quiet worked, which is
 * exactly the shape of a load problem wearing a failure's words.
 *
 * So the clock is reset by an answer, and only by an answer. A tmux that hangs
 * still trips the same watchdog in the same `timeoutMs`, and a sequence that
 * stalls halfway through trips it where it stalled. What can no longer happen
 * is an operation failing because it asked more questions than the budget had
 * room for.
 */
export class OperationDeadline {
	private expiresAt: number;

	private constructor(private readonly budgetMs: number) {
		this.expiresAt = Date.now() + budgetMs;
	}

	static in(milliseconds: number): OperationDeadline {
		return new OperationDeadline(milliseconds);
	}

	get remaining(): number {
		return this.expiresAt - Date.now();
	}

	/**
	 * The provider answered. Recorded by `runBounded` when a command completes
	 * — including one that failed, because a refusal is an answer too, and the
	 * caller that keeps going after it is not waiting on a silent runtime.
	 */
	answered(): void {
		this.expiresAt = Date.now() + this.budgetMs;
	}

	/** Cancellation wins over expiry: an abandoned operation is not a timeout. */
	check(cancel: CancellationToken): void {
		cancel.check();
		if (this.remaining <= 0) throw portFailure("timed_out");
	}
}

export interface CommandOutput {
	readonly success: boolean;
	readonly stdout: Buffer;
	/**
	 * Bounded, private, and used only to classify the exact no-server
	 * condition. It never reaches an error value or a log line.
	 */
	readonly stderr: Buffer;
}

export interface CommandSpec {
	readonly file: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * A validated executable.
 *
 * The path is canonical and was a regular executable file when it was
 * resolved; the runtime never re-derives it from a configured string later.
 */
export interface ResolvedExecutable {
	readonly path: string;
	readonly basename: string;
}

function inspectExecutable(path: string): ResolvedExecutable | undefined {
	try {
		if (!statSync(path).isFile()) return undefined;
		accessSync(path, constants.X_OK);
		const real = realpathSync(path);
		return { path: real, basename: real.slice(real.lastIndexOf("/") + 1) };
	} catch {
		// Not a swallow: "this candidate is not a usable executable" is the
		// answer this function exists to produce, and the caller acts on it.
		return undefined;
	}
}

/**
 * Resolve a configured executable: an absolute path, a leading-`~` path, or a
 * bare command name looked up in absolute PATH entries only.
 *
 * A relative path with a separator is refused rather than interpreted against
 * whatever directory this process happens to be in.
 */
export function resolveExecutable(
	context: RuntimeLaunchContext,
	configured: string,
): ResolvedExecutable | undefined {
	if (configured.length === 0 || configured.includes("\0")) return undefined;
	if (configured === "~" || configured.startsWith("~/")) {
		return inspectExecutable(join(context.home, configured.slice(1)));
	}
	if (configured.startsWith("/")) return inspectExecutable(configured);
	if (configured.includes("/")) return undefined;
	const path = context.environment.PATH;
	if (!path) return undefined;
	for (const entry of path.split(delimiter)) {
		if (entry.length === 0 || !isAbsolute(entry)) continue;
		const resolved = inspectExecutable(join(entry, configured));
		if (resolved) return resolved;
	}
	return undefined;
}

/**
 * Run one command to completion inside the operation's budget.
 *
 * The child is its own process group, so a provider that forks (tmux does)
 * can be terminated as a whole rather than leaving a descendant holding a pipe.
 */
export function runBounded(
	spec: CommandSpec,
	deadline: OperationDeadline,
	cancel: CancellationToken,
): Promise<CommandOutput> {
	// The deadline started at the caller's first probe, not when this child
	// happens to be spawned. Refuse a late spawn outright.
	deadline.check(cancel);
	return new Promise<CommandOutput>((resolve, reject) => {
		const child = spawn(spec.file, [...spec.args], {
			cwd: spec.cwd,
			env: spec.env as NodeJS.ProcessEnv,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let settled = false;

		const terminate = () => {
			try {
				if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
			} catch {
				// Not a swallow: the group is already gone, which is the state
				// this call exists to reach.
			}
			child.kill("SIGKILL");
		};
		const finish = (failure?: unknown, output?: CommandOutput) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearInterval(poll);
			if (failure) {
				terminate();
				reject(failure);
			} else {
				resolve(output as CommandOutput);
			}
		};

		child.on("error", (error: NodeJS.ErrnoException) => {
			finish(
				portFailure(
					error.code === "ENOENT" || error.code === "EACCES"
						? "unavailable"
						: "failed",
					{ cause: error },
				),
			);
		});
		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.byteLength;
			if (stdoutBytes > MAX_OUTPUT_BYTES) {
				finish(portFailure("failed"));
				return;
			}
			stdout.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderrBytes += chunk.byteLength;
			if (stderrBytes > MAX_STDERR_BYTES) {
				finish(portFailure("failed"));
				return;
			}
			stderr.push(chunk);
		});
		// `close` rather than `exit`: the drain is part of the same budget, so
		// a descendant holding a pipe open cannot be mistaken for completion.
		child.on("close", (code, signal) => {
			// The provider answered, so the operation's watchdog starts again:
			// the next command is waiting on a runtime that has just proven it
			// is alive, not extending a budget it already spent.
			deadline.answered();
			finish(undefined, {
				success: code === 0 && signal === null,
				stdout: Buffer.concat(stdout),
				stderr: Buffer.concat(stderr),
			});
		});

		const timer = setTimeout(
			() => finish(portFailure("timed_out")),
			Math.max(0, deadline.remaining),
		);
		// The token is a plain flag, so an abandoned operation is noticed on the
		// same interval the Rust's condition-variable waits used.
		const poll = setInterval(() => {
			if (cancel.isCancelled) finish(portFailure("cancelled"));
		}, 5);
	});
}

/**
 * Split provider output into records.
 *
 * A NUL byte, an over-long line or too many lines is malformed provider output,
 * not a partial answer to be used anyway.
 */
export function parseLines(output: Buffer): string[] {
	const text = decodeUtf8(output);
	if (text.includes("\0")) throw portFailure("failed");
	const lines: string[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (line.length === 0) continue;
		if (line.length > MAX_LINE_BYTES || lines.length === MAX_LINES) {
			throw portFailure("failed");
		}
		lines.push(line);
	}
	return lines;
}

/**
 * The two bytes a tmux `-F` format uses to delimit what it answers.
 *
 * Neither can arrive from the values themselves: they are C0 control
 * characters, and every field DevHub reads this way is either a tmux-generated
 * name or a marker DevHub wrote. If one ever did appear inside a value, the
 * record would fail to parse or fail to match, which is the fail-closed side.
 */
export const FIELD_SEPARATOR = "\u001f";
export const RECORD_SEPARATOR = "\u001e";

/**
 * Parse the answer of one `-F` listing into records of fixed width.
 *
 * The newline tmux appends after each expanded format is *not* the record
 * separator here — a marker value may contain newlines (a path legitimately
 * can), and splitting on them would tear one session's identity into two
 * half-read ones. The format itself ends with `RECORD_SEPARATOR`, so a record
 * ends where DevHub said it ends and tmux's newline is only the byte that
 * follows it.
 *
 * A record of the wrong width, a missing terminator or a NUL is malformed
 * provider output, not a partial answer to be used anyway.
 */
export function parseRecords(output: Buffer, fieldCount: number): string[][] {
	if (output.byteLength > MAX_OUTPUT_BYTES) throw portFailure("failed");
	const text = decodeUtf8(output);
	if (text.includes("\0")) throw portFailure("failed");
	if (text.length === 0) return [];
	const chunks = text.split(RECORD_SEPARATOR);
	// Every record is terminated, so what follows the last one is exactly the
	// newline tmux appended to it.
	if (chunks.pop() !== "\n") throw portFailure("failed");
	if (chunks.length > MAX_LINES) throw portFailure("failed");
	const records: string[][] = [];
	for (const [index, chunk] of chunks.entries()) {
		if (index > 0 && !chunk.startsWith("\n")) throw portFailure("failed");
		const fields = (index === 0 ? chunk : chunk.slice(1)).split(
			FIELD_SEPARATOR,
		);
		if (fields.length !== fieldCount) throw portFailure("failed");
		for (const field of fields) {
			if (field.length > MAX_ROOT_METADATA_BYTES) {
				throw portFailure("failed");
			}
		}
		records.push(fields);
	}
	return records;
}

/**
 * Parse one tmux option value without treating an embedded newline as a record
 * separator. tmux appends exactly one newline to `show-options`; a path may
 * itself contain newlines and those bytes remain part of identity.
 */
export function parseOptionValue(output: Buffer): string {
	if (output.byteLength > MAX_OUTPUT_BYTES) throw portFailure("failed");
	const text = decodeUtf8(output);
	if (text.includes("\0")) throw portFailure("failed");
	if (!text.endsWith("\n")) throw portFailure("failed");
	const value = text.slice(0, -1);
	if (value.length > MAX_ROOT_METADATA_BYTES) throw portFailure("failed");
	return value;
}

/**
 * A pane capture, as text.
 *
 * This is the one place provider output is read as *content* rather than as
 * identity, and the rules are different for it. It is bounded like everything
 * else and it must be valid UTF-8 — a pane mid-way through a multi-byte
 * sequence would otherwise reach the detector as replacement characters and
 * quietly stop matching — but it is not required to end in a newline and its
 * embedded newlines are the lines the rules read.
 */
export function parseCapture(output: Buffer): string {
	if (output.byteLength > MAX_OUTPUT_BYTES) throw portFailure("failed");
	return decodeUtf8(output);
}

function decodeUtf8(output: Buffer): string {
	const text = output.toString("utf8");
	// Buffer#toString replaces invalid sequences; comparing byte lengths is how
	// non-UTF-8 provider output is refused instead of silently mangled.
	if (Buffer.byteLength(text, "utf8") !== output.byteLength) {
		throw portFailure("failed");
	}
	return text;
}

/**
 * The one stderr classification the runtime makes: "there is no server".
 *
 * Everything it does not match is read as a *foreign* server, which is the
 * fail-closed answer — DevHub refuses a socket it cannot prove is its own. That
 * makes the exact set here load-bearing in both directions, and it has to cover
 * every way tmux says the server is gone, not only the ways it says so before
 * connecting:
 *
 * - "no server running on <socket>" — the socket is absent, or stale after a
 *   server was killed.
 * - "error connecting to <socket> (No such file or directory)" — no socket.
 * - "server exited unexpectedly" — the client *did* connect, and the server
 *   went away mid-exchange. This is the one that arrives while DevHub's own
 *   server is shutting down: killing the last session ends the server, and a
 *   command that overlaps that exit gets this instead of a value. A server that
 *   has exited is not somebody else's tmux, and reading it as one made DevHub
 *   declare its own socket foreign for as long as the race lasted.
 *
 * Calling any of them "absent" costs no safety: the caller bootstraps a server
 * and verifies the marker on it before using it.
 */
export function isNoServerError(stderr: Buffer): boolean {
	const text = stderr.toString("utf8").trim().toLowerCase();
	return (
		text.includes("no server running") ||
		text === "no server" ||
		text.includes("server exited unexpectedly") ||
		(text.startsWith("error connecting") &&
			text.includes("no such file or directory"))
	);
}

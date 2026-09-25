/**
 * DevHub's side of one GUI Agent's host: its journal, its input, its ending.
 *
 * Bytes and lines only. What a line *means* is the protocol adapter's
 * business, a layer up; this knows the state directory contract
 * (`hostScript.ts`) and the `Runtime` of the machine it is on, and nothing
 * about Claude or Codex.
 *
 * It holds nothing that a DevHub restart could lose. The host keeps running in
 * its tmux session whatever happens here, and a new `HostLink` on the same
 * directory — in the same DevHub or the next one — is attached by asking for
 * the journal from an offset. So "re-attach" is not an operation; it is
 * `lines(offset)` again.
 *
 * Every way this can fail is a `HostLinkFailure` with a code, and nothing is
 * caught and left there: a stream that stopped, a journal that shrank, a host
 * that is not there to write to, all reach the caller, which is the one place
 * that decides what a person sees.
 */

import { Buffer } from "node:buffer";
import { posix } from "node:path";
import { OperationDeadline } from "../../terminal/command.js";
import { CancellationToken } from "../../terminal/ports.js";
import type { ExecLimits, ExecResult, Runtime } from "../../runtime/runtime.js";
import {
	ENDING_SCRIPT,
	RESTART_SCRIPT,
	SENT_LOG_SCRIPT,
	STREAM_EXIT,
	STREAM_NAME,
	STREAM_SCRIPT,
	WRITE_EXIT,
	WRITE_SCRIPT,
} from "./hostScript.js";

/** Why the link to a host could not do what it was asked. */
export type HostLinkFailureCode =
	/** The host never wrote its `pid`, or ended before it did. */
	| "host_not_started"
	/** A write found no host running to take it. */
	| "host_gone"
	/** `ending()` was asked of a host that is still running. */
	| "host_running"
	/** The state directory, or a file the contract says is in it, is not there. */
	| "state_missing"
	/** The journal is shorter than what was already read from it. */
	| "journal_truncated"
	/** The stream following the journal stopped for another reason. */
	| "stream_lost"
	/** A write did not complete: refused, or not taken before its deadline. */
	| "write_failed"
	/** The host's files say something the contract does not allow. */
	| "unreadable";

/** The CLI a host is started again as: the whole of its argv. */
export interface RestartedCli {
	readonly file: string;
	readonly args: readonly string[];
}

export class HostLinkFailure extends Error {
	constructor(
		readonly code: HostLinkFailureCode,
		message: string,
		/**
		 * For a failure of `lines`: the offset to attach from again, which is
		 * everything that was delivered whole before it.
		 */
		readonly offset: number | undefined,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "HostLinkFailure";
	}
}

/** One line of the journal, without its newline. */
export interface JournalLine {
	readonly line: string;
	/**
	 * The byte offset just past this line's newline: the offset to pass to
	 * `lines` to continue after it, and the one to keep across a restart.
	 */
	readonly offset: number;
}

/** A line DevHub wrote to the host, and the journal offset it was written after. */
export interface SentRecord {
	readonly afterOffset: number;
	readonly line: string;
}

/** How a host that is no longer running ended. */
export type HostEnding =
	/** The CLI exited, and this is its status (128 + n for a signal). */
	| {
			readonly kind: "exited";
			readonly code: number;
			readonly stderrTail: string;
	  }
	/** The host could not start the CLI; the reason is in `stderrTail`. */
	| { readonly kind: "host_failed"; readonly stderrTail: string }
	/**
	 * Nothing was written down: tmux killed the session (DevHub's Stop, or a
	 * person's), or the machine went away under it.
	 */
	| { readonly kind: "vanished"; readonly stderrTail: string };

/** How long a write may take before the host is reported as not taking it. */
export const HOST_WRITE_TIMEOUT_MS = 10_000;
/** How long a read of the host's small files may take. */
const HOST_READ_TIMEOUT_MS = 20_000;
/**
 * The most of a journal (or of `in.log`) one read will take.
 *
 * A bound that fails rather than truncates: half a journal is not a shorter
 * conversation but a wrong one.
 */
const HOST_FILE_BYTES = 256 * 1024 * 1024;

function limits(what: string, path: string): ExecLimits {
	return {
		stdoutBytes: HOST_FILE_BYTES,
		stderrBytes: 8 * 1024,
		overflow: {
			kind: "fail",
			failure: () =>
				new HostLinkFailure(
					"unreadable",
					`${what} ${path} is larger than the ${String(HOST_FILE_BYTES)} bytes DevHub reads at once`,
					undefined,
				),
		},
	};
}

function lastLine(buffer: Buffer): string {
	const lines = buffer
		.toString("utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	return lines[lines.length - 1] ?? "";
}

function describe(failure: unknown): string {
	return failure instanceof Error ? failure.message : String(failure);
}

export class HostLink {
	readonly #runtime: Runtime;
	readonly #directory: string;
	readonly #writeTimeoutMs: number;
	/** The last write, so that the next one starts after it. */
	#writes: Promise<unknown> = Promise.resolve();

	constructor(
		runtime: Runtime,
		stateDirectory: string,
		options: { readonly writeTimeoutMs?: number } = {},
	) {
		this.#runtime = runtime;
		this.#directory = stateDirectory;
		this.#writeTimeoutMs = options.writeTimeoutMs ?? HOST_WRITE_TIMEOUT_MS;
	}

	get stateDirectory(): string {
		return this.#directory;
	}

	/**
	 * The journal, line by line, from `fromOffset` (a line boundary: 0, or an
	 * `offset` a previous line carried).
	 *
	 * It follows the journal as it grows, waiting for a host that has not
	 * started yet, and it ends in exactly two ways without a failure: `cancel`
	 * was cancelled, or the host is over and every byte of the journal has been
	 * delivered — including a last line with no newline, which a CLI killed in
	 * the middle of a write leaves behind and which is handed on as it is,
	 * because what it says is the next layer's to judge. Any other ending
	 * throws a `HostLinkFailure` carrying the offset to attach from again.
	 */
	async *lines(
		fromOffset: number,
		cancel: CancellationToken,
	): AsyncGenerator<JournalLine> {
		if (!Number.isSafeInteger(fromOffset) || fromOffset < 0) {
			throw new Error(`${String(fromOffset)} is not a journal offset`);
		}
		const stream = this.#runtime.spawnStream({
			argv: [
				"/bin/sh",
				"-c",
				STREAM_SCRIPT,
				STREAM_NAME,
				this.#directory,
				String(fromOffset),
			],
			cancel,
		});
		/** Everything before this was delivered as whole lines. */
		let delivered = fromOffset;
		let pending: Buffer = Buffer.alloc(0);
		try {
			for await (const chunk of stream.stdout) {
				pending =
					pending.byteLength === 0 ? chunk : Buffer.concat([pending, chunk]);
				for (;;) {
					const newline = pending.indexOf(0x0a);
					if (newline === -1) break;
					delivered += newline + 1;
					const line = pending.subarray(0, newline).toString("utf8");
					pending = pending.subarray(newline + 1);
					yield { line, offset: delivered };
				}
			}
		} catch (failure: unknown) {
			throw new HostLinkFailure(
				"stream_lost",
				`DevHub lost the journal of the Agent host in ${this.#directory}${this.#runtime.where}: ${describe(failure)}`,
				delivered,
				{ cause: failure },
			);
		} finally {
			// A consumer that stopped early lets go of the stream here; one that
			// read to the end finds it already over, and this does nothing.
			stream.kill();
		}
		let end;
		try {
			end = await stream.ended;
		} catch (failure: unknown) {
			if (cancel.isCancelled) return;
			throw new HostLinkFailure(
				"stream_lost",
				`DevHub lost the journal of the Agent host in ${this.#directory}${this.#runtime.where}: ${describe(failure)}`,
				delivered,
				{ cause: failure },
			);
		}
		if (cancel.isCancelled) return;
		if (end.code === STREAM_EXIT.hostOver && end.signal === null) {
			// The host is over, so the journal is final: whatever `tail` had not
			// passed on yet is read once, to the end, and the stream is done.
			const rest = await this.#readFrom(delivered + pending.byteLength);
			const tail = Buffer.concat([pending, rest]);
			let start = 0;
			for (;;) {
				const newline = tail.indexOf(0x0a, start);
				if (newline === -1) break;
				delivered += newline + 1 - start;
				yield {
					line: tail.subarray(start, newline).toString("utf8"),
					offset: delivered,
				};
				start = newline + 1;
			}
			if (start < tail.byteLength) {
				delivered += tail.byteLength - start;
				yield {
					line: tail.subarray(start).toString("utf8"),
					offset: delivered,
				};
			}
			return;
		}
		throw this.#streamFailure(end.code, end.signal, end.stderr, delivered);
	}

	/**
	 * One line into the CLI's stdin, and into `in.log` after `afterOffset`:
	 * the journal offset the caller had read when it wrote, which is what lets
	 * a replay put the line back where it was written.
	 *
	 * Writes run one at a time, in the order they were asked for: a line
	 * longer than `PIPE_BUF` is not written atomically, and two of them at
	 * once could interleave into two lines that are neither. The line must not
	 * contain a newline — that is the framing, and a caller that has one in a
	 * line has not encoded it.
	 */
	write(line: string, afterOffset: number): Promise<void> {
		if (line.includes("\n")) {
			throw new Error(
				"a line written to an Agent host must not contain a newline",
			);
		}
		if (!Number.isSafeInteger(afterOffset) || afterOffset < 0) {
			throw new Error(`${String(afterOffset)} is not a journal offset`);
		}
		const next = this.#writes.then(() =>
			this.#input(
				WRITE_SCRIPT,
				"devhub-agent-write",
				`${String(afterOffset)} ${line}\n`,
				"did not take a line",
			),
		);
		// Only the order is kept here; the failure itself is `next`'s, and it
		// goes to the caller that asked for this write.
		this.#writes = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	/**
	 * Have the host start its CLI again as `cli` — its whole argv, in place of
	 * the one the host was started with (its environment stays) — and the
	 * lines of `mark` in the journal between the two CLIs' output
	 * (`RESTART_SCRIPT`). Resolves once the old CLI has been told to
	 * stop; the mark in the journal is how the caller learns the new one
	 * started. In order with the writes, like one of them.
	 */
	restart(cli: RestartedCli, mark: readonly string[]): Promise<void> {
		if (mark.length === 0) throw new Error("a restart's mark has no line");
		const argv = [cli.file, ...cli.args];
		for (const each of [...mark, ...argv]) {
			if (each.includes("\n")) {
				throw new Error(
					"a restart's mark lines and arguments must not contain a newline",
				);
			}
		}
		const next = this.#writes.then(() =>
			this.#input(
				RESTART_SCRIPT,
				"devhub-agent-restart",
				[String(argv.length), ...argv, ...mark]
					.map((each) => `${each}\n`)
					.join(""),
				"did not start its CLI again",
			),
		);
		this.#writes = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	/** Run one of the host's input scripts with `stdin`; its refusals are `HostLinkFailure`s. */
	async #input(
		script: string,
		name: string,
		stdin: string,
		refused: string,
	): Promise<void> {
		let result: ExecResult;
		try {
			result = await this.#runtime.exec({
				argv: ["/bin/sh", "-c", script, name, this.#directory],
				stdin: Buffer.from(stdin, "utf8"),
				deadline: OperationDeadline.in(this.#writeTimeoutMs),
				cancel: new CancellationToken(),
				limits: limits("the write to", this.#directory),
			});
		} catch (failure: unknown) {
			throw new HostLinkFailure(
				"write_failed",
				`the Agent host in ${this.#directory}${this.#runtime.where} ${refused}: ${describe(failure)}`,
				undefined,
				{ cause: failure },
			);
		}
		if (result.code === 0) return;
		const said = `${lastLine(result.stderr)}${this.#runtime.where}`;
		if (result.code === WRITE_EXIT.hostGone) {
			throw new HostLinkFailure("host_gone", said, undefined);
		}
		if (result.code === WRITE_EXIT.stateMissing) {
			throw new HostLinkFailure("state_missing", said, undefined);
		}
		throw new HostLinkFailure(
			"write_failed",
			`the Agent host in ${this.#directory}${this.#runtime.where} ${refused} (exit ${String(result.code ?? result.signal)}): ${lastLine(result.stderr)}`,
			undefined,
		);
	}

	/** Every line DevHub has written to this host, in order, each with the offset it followed. */
	async sentLog(): Promise<readonly SentRecord[]> {
		const result = await this.#read(
			SENT_LOG_SCRIPT,
			[],
			limits("the input log in", this.#directory),
		);
		if (result.code === WRITE_EXIT.stateMissing) {
			throw new HostLinkFailure(
				"state_missing",
				`${lastLine(result.stderr)}${this.#runtime.where}`,
				undefined,
			);
		}
		this.#answered(result, "the input log");
		const text = result.stdout.toString("utf8");
		if (text.length === 0) return [];
		if (!text.endsWith("\n")) {
			throw new HostLinkFailure(
				"unreadable",
				`the input log of the Agent host in ${this.#directory}${this.#runtime.where} ends in the middle of a line`,
				undefined,
			);
		}
		return text
			.slice(0, -1)
			.split("\n")
			.map((entry, index) => {
				const match = /^(\d+) /u.exec(entry);
				if (match === null) {
					throw new HostLinkFailure(
						"unreadable",
						`line ${String(index + 1)} of the input log of the Agent host in ${this.#directory}${this.#runtime.where} carries no journal offset`,
						undefined,
					);
				}
				return {
					afterOffset: Number(match[1]),
					line: entry.slice(match[0].length),
				};
			});
	}

	/**
	 * How the host ended, for a host that is no longer running.
	 *
	 * Asked once, after its session is gone. A host that is still running
	 * when this is asked is a caller that got the order wrong, and it throws
	 * rather than guessing an ending that has not happened.
	 */
	async ending(): Promise<HostEnding> {
		const result = await this.#read(
			ENDING_SCRIPT,
			[],
			limits("the ending of", this.#directory),
		);
		this.#answered(result, "the ending");
		const text = result.stdout.toString("utf8");
		const newline = text.indexOf("\n");
		const verdict = newline === -1 ? text : text.slice(0, newline);
		const stderrTail = newline === -1 ? "" : text.slice(newline + 1);
		if (verdict === "missing") {
			throw new HostLinkFailure(
				"state_missing",
				`there is no host state at ${this.#directory}${this.#runtime.where}`,
				undefined,
			);
		}
		if (verdict === "running") {
			throw new HostLinkFailure(
				"host_running",
				`the Agent host in ${this.#directory}${this.#runtime.where} is still running, so it has no ending yet`,
				undefined,
			);
		}
		if (verdict === "vanished") return { kind: "vanished", stderrTail };
		const written = verdict.startsWith("exit ") ? verdict.slice(5) : undefined;
		if (written === "host") return { kind: "host_failed", stderrTail };
		if (written !== undefined && /^\d+$/u.test(written)) {
			return { kind: "exited", code: Number(written), stderrTail };
		}
		throw new HostLinkFailure(
			"unreadable",
			`the Agent host in ${this.#directory}${this.#runtime.where} wrote an ending DevHub cannot read: ${JSON.stringify(verdict)}`,
			undefined,
		);
	}

	/** The journal from a byte offset to its end, for a host that is over. */
	async #readFrom(offset: number): Promise<Buffer> {
		const result = await this.#read(
			'exec tail -c "+$2" -- "$1/out"',
			[String(offset + 1)],
			limits("the journal", posix.join(this.#directory, "out")),
		);
		this.#answered(result, "the journal");
		return result.stdout;
	}

	#read(
		script: string,
		extra: readonly string[],
		bounds: ExecLimits,
	): Promise<ExecResult> {
		return this.#runtime.exec({
			argv: [
				"/bin/sh",
				"-c",
				script,
				"devhub-agent-read",
				this.#directory,
				...extra,
			],
			deadline: OperationDeadline.in(HOST_READ_TIMEOUT_MS),
			cancel: new CancellationToken(),
			limits: bounds,
		});
	}

	/** A read that did not answer is a failure in the machine's own words. */
	#answered(result: ExecResult, what: string): void {
		if (result.code === 0) return;
		throw new HostLinkFailure(
			"unreadable",
			`DevHub could not read ${what} of the Agent host in ${this.#directory}${this.#runtime.where}: ${lastLine(result.stderr)}`,
			undefined,
		);
	}

	#streamFailure(
		code: number | null,
		signal: string | null,
		stderr: Buffer,
		offset: number,
	): HostLinkFailure {
		const said = lastLine(stderr);
		switch (code) {
			case STREAM_EXIT.truncated:
				return new HostLinkFailure(
					"journal_truncated",
					`${said}${this.#runtime.where}`,
					offset,
				);
			case STREAM_EXIT.notStarted:
				return new HostLinkFailure(
					"host_not_started",
					`${said}${this.#runtime.where}`,
					offset,
				);
			case STREAM_EXIT.stateMissing:
				return new HostLinkFailure(
					"state_missing",
					`${said}${this.#runtime.where}`,
					offset,
				);
			default:
				return new HostLinkFailure(
					"stream_lost",
					`the journal of the Agent host in ${this.#directory}${this.#runtime.where} stopped (${code === null ? `signal ${String(signal)}` : `exit ${String(code)}`})${said.length === 0 ? "" : `: ${said}`}`,
					offset,
				);
		}
	}
}

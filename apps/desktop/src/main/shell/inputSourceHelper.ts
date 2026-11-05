/**
 * The input source port, answered by `devhub-input-source`.
 *
 * The Text Input Sources API is Carbon's and Electron's main process has no way
 * to call it, so a small program does (`main/native/inputSource.c`, compiled by
 * the desktop build into `out/native`). It is started once, when the keyboard
 * is installed, and kept: a chord's switch is then one line on a pipe, which
 * costs hundredths of a millisecond, where a process per chord would cost more
 * than the switch itself. It ends when DevHub does, because its stdin closes.
 *
 * Its protocol is in the C file. Replies come back in the order the requests
 * went, so the requests waiting for one are a queue.
 *
 * A helper that cannot be started, or that stops, fails every request from
 * then on with the same `input_source_unavailable`; which of those reaches the
 * person, and how often, is `ChordInputSource`'s to decide.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { errorWireAt, NamedFailure, withDetail } from "../../model/wire.js";
import type { InputSourcePort } from "./chordInputSource.js";

export const INPUT_SOURCE_HELPER = "devhub-input-source";

/** Where the build puts it, under DevHub's own code. */
export function inputSourceHelperPath(appRoot: string): string {
	return join(appRoot, "out", "native", INPUT_SOURCE_HELPER);
}

function unavailable(detail: string): NamedFailure {
	return new NamedFailure(
		withDetail(errorWireAt("input_source_unavailable"), detail),
	);
}

interface Waiting {
	readonly resolve: (fields: readonly string[]) => void;
	readonly reject: (failure: unknown) => void;
}

export class InputSourceHelper implements InputSourcePort {
	private readonly child: ChildProcess;
	private readonly waiting: Waiting[] = [];
	private broken: NamedFailure | undefined;

	constructor(private readonly path: string) {
		this.child = spawn(path, [], { stdio: ["pipe", "pipe", "inherit"] });
		this.child.on("error", (error) => {
			this.fail(`${path} could not be started: ${error.message}`);
		});
		this.child.on("exit", (code, signal) => {
			this.fail(
				`${path} stopped (${signal === null ? `exit code ${String(code)}` : signal}).`,
			);
		});
		this.child.stdin?.on("error", (error) => {
			this.fail(`${path} stopped reading: ${error.message}`);
		});
		const stdout = this.child.stdout;
		if (stdout === null) throw new Error("spawned with a stdout pipe");
		createInterface({ input: stdout }).on("line", (line) => {
			this.answer(line);
		});
	}

	async selectAscii(): Promise<void> {
		const reply = await this.request("ascii");
		if (reply[0] === "unchanged" && reply.length === 2) return;
		if (reply[0] === "switched" && reply.length === 3) return;
		throw this.malformed("ascii", reply);
	}

	private request(line: string): Promise<readonly string[]> {
		if (this.broken) return Promise.reject(this.broken);
		return new Promise((resolve, reject) => {
			this.waiting.push({ resolve, reject });
			this.child.stdin?.write(`${line}\n`);
		});
	}

	private answer(line: string): void {
		const waiting = this.waiting.shift();
		if (waiting === undefined) {
			this.fail(`${this.path} said something nobody asked for: ${line}`);
			return;
		}
		const fields = line.split("\t");
		if (fields[0] === "error") {
			waiting.reject(unavailable(fields.slice(1).join(" ")));
			return;
		}
		waiting.resolve(fields);
	}

	/** DevHub's own helper answering outside its protocol: a broken build. */
	private malformed(request: string, reply: readonly string[]): Error {
		return new Error(
			`${this.path} answered "${request}" with "${reply.join("\t")}"`,
		);
	}

	private fail(detail: string): void {
		if (this.broken) return;
		this.broken = unavailable(detail);
		for (const waiting of this.waiting.splice(0)) waiting.reject(this.broken);
	}
}

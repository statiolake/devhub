/**
 * The machine of an Agent on another machine, as the conversation engine
 * reaches it: main's runtime of it, at one remove.
 *
 * The engine follows that Agent's journal itself, with the same `HostLink`
 * an Agent on this machine has; only what needs the machine is main's. A
 * stream (`spawnStream`) is started by main's runtime — the `ssh -T` it
 * composes, the session slot it holds, its refusals — in the process host,
 * and its bytes come here over a port of their own (`StreamRequest.to`), so
 * that main brokers the stream and never reads it. How it ended comes from
 * main, which is where the refusal is decided. A command (`exec`: the end of
 * the journal of a host that is over) is main's and answered as data.
 */

import { Buffer } from "node:buffer";

import type { AgentId } from "../../model/domain.js";
import type { HostRuntime } from "../agent/conversation/hostLink.js";
import type {
	ByteStream,
	ExecRequest,
	ExecResult,
	StreamEnd,
	StreamRequest,
} from "../runtime/runtime.js";
import type { EngineQuestion, ExecAnswer, FromEngine } from "./protocol.js";

/** The engine's end of a stream's port, as both Electron's `MessagePortMain` and a test's fake are. */
export interface StreamPort {
	on(event: "message", listener: (event: { data: unknown }) => void): unknown;
	on(event: "close", listener: () => void): unknown;
	start(): void;
	close(): void;
}

interface Flowing {
	readonly chunks: Buffer[];
	/** No more bytes: the port said so, or closed, or the stream failed. */
	over: boolean;
	wake: (() => void) | undefined;
	readonly settle: (end: StreamEnd) => void;
	readonly fail: (error: Error) => void;
}

function bufferOf(bytes: Uint8Array): Buffer {
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Every brokered stream of one engine, by the number it gave main. */
export class StreamBroker {
	readonly #post: (message: FromEngine) => void;
	readonly #streams = new Map<number, Flowing>();
	#next = 1;

	constructor(post: (message: FromEngine) => void) {
		this.#post = post;
	}

	/** A stream of `agentId`'s machine, started by main. */
	open(agentId: AgentId, request: StreamRequest): ByteStream {
		const stream = this.#next++;
		let settle: (end: StreamEnd) => void = () => undefined;
		let fail: (error: Error) => void = () => undefined;
		const ended = new Promise<StreamEnd>((resolve, reject) => {
			settle = resolve;
			fail = reject;
		});
		// Read a moment later by the caller, as `ByteStream` says.
		ended.then(
			() => undefined,
			() => undefined,
		);
		const flowing: Flowing = {
			chunks: [],
			over: false,
			wake: undefined,
			settle,
			fail,
		};
		this.#streams.set(stream, flowing);
		this.#post({
			type: "stream-open",
			stream,
			agentId,
			argv: request.argv,
			...(request.cwd === undefined ? {} : { cwd: request.cwd }),
			...(request.env === undefined ? {} : { env: request.env }),
		});
		let killed = false;
		const kill = () => {
			if (killed || !this.#streams.has(stream)) return;
			killed = true;
			this.#post({ type: "stream-cancel", stream });
		};
		request.cancel.onCancelled(kill);
		async function* read(): AsyncGenerator<Buffer> {
			for (;;) {
				const chunk = flowing.chunks.shift();
				if (chunk !== undefined) {
					yield chunk;
					continue;
				}
				if (flowing.over) return;
				await new Promise<void>((resolve) => {
					flowing.wake = resolve;
				});
			}
		}
		return { stdout: read(), ended, kill };
	}

	/** The port a stream's bytes come on, from main. */
	port(stream: number, port: StreamPort): void {
		const flowing = this.#streams.get(stream);
		if (flowing === undefined) {
			port.close();
			return;
		}
		port.on("message", ({ data }) => {
			if (data === null) {
				this.#over(flowing);
				port.close();
				return;
			}
			flowing.chunks.push(bufferOf(data as Uint8Array));
			this.#wake(flowing);
		});
		// A process host that ended takes its end of the port with it.
		port.on("close", () => this.#over(flowing));
		port.start();
	}

	/** How a stream ended, from main: its end, or why there was none. */
	ended(stream: number, outcome: StreamEnd | Error): void {
		const flowing = this.#streams.get(stream);
		if (flowing === undefined) return;
		this.#streams.delete(stream);
		if (outcome instanceof Error) {
			// No more bytes will come that mean anything: the reader is told why.
			this.#over(flowing);
			flowing.fail(outcome);
		} else {
			flowing.settle(outcome);
		}
	}

	#over(flowing: Flowing): void {
		flowing.over = true;
		this.#wake(flowing);
	}

	#wake(flowing: Flowing): void {
		const woken = flowing.wake;
		flowing.wake = undefined;
		woken?.();
	}
}

/** `agentId`'s machine, as main reaches it, for its `HostLink` here. */
export function brokeredRuntime(
	agentId: AgentId,
	where: string,
	streams: StreamBroker,
	ask: (question: EngineQuestion) => Promise<unknown>,
): HostRuntime {
	return {
		where,
		spawnStream: (request) => streams.open(agentId, request),
		async exec(request: ExecRequest): Promise<ExecResult> {
			const answer = (await ask({
				kind: "exec",
				argv: request.argv,
				...(request.cwd === undefined ? {} : { cwd: request.cwd }),
				...(request.env === undefined ? {} : { env: request.env }),
				...(request.stdin === undefined ? {} : { stdin: request.stdin }),
				timeoutMs: request.deadline.budgetMs,
				stdoutBytes: request.limits.stdoutBytes,
				stderrBytes: request.limits.stderrBytes,
				overflow: request.limits.overflow.kind,
			})) as ExecAnswer;
			if (answer.kind === "overflow") {
				const { overflow } = request.limits;
				throw overflow.kind === "fail"
					? overflow.failure()
					: new Error("a command main ran for the engine overflowed");
			}
			return {
				code: answer.code,
				signal: answer.signal,
				stdout: bufferOf(answer.stdout),
				stderr: bufferOf(answer.stderr),
			};
		},
	};
}

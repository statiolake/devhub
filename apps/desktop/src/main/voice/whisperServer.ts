/**
 * The recogniser kept loaded: whisper.cpp's `whisper-server`, as
 * `devhub-whisper-server` (`scripts/build_whisper.py`).
 *
 * Streaming dictation transcribes the window being spoken every half second
 * (`dictationStream.ts`). A program per transcription — what `whisper.ts`
 * does with the CLI — pays for a process, the model's ~550 MB into GPU
 * memory and Metal's pipelines every time, a second or more on its own, which
 * is the whole budget. So the server is started once and asked over HTTP.
 *
 * It listens on 127.0.0.1 only, on a port chosen free just before it starts,
 * and every route it has sits under a random path (`--request-path`), so the
 * path is the key: another program on the Mac that finds the port does not
 * find the routes, `/load` (which would make it read a file named in the
 * request) included. It is built without libcurl, so it can still fetch
 * nothing.
 *
 * It is started lazily — when the microphone is about to be used (`warm`) or
 * a transcription is asked for — and stopped after `idleMs` with nothing
 * asked, so the GPU memory is given back when dictation is not in use. A
 * server that exits or stops answering is started again by the next request.
 * Requests are one at a time: one GPU.
 */

import type { ChildProcess } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { availableParallelism } from "node:os";

import { VOICE_SAMPLE_RATE } from "../../ipc/voice.js";
import type { TranscribeOptions, Transcriber } from "./dictationStream.js";
import {
	cleanTranscript,
	transcriptionDeadlineMs,
	wavFile,
} from "./whisper.js";

export interface WhisperServerDeps {
	readonly spawn: (binary: string, args: readonly string[]) => ChildProcess;
	readonly fetch: typeof fetch;
	readonly freePort: () => Promise<number>;
	readonly secret: () => string;
	readonly sleep: (ms: number) => Promise<void>;
	readonly setTimer: (fn: () => void, ms: number) => { unref?(): void };
	readonly clearTimer: (timer: unknown) => void;
}

export function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => resolve(port));
		});
	});
}

export const NODE_DEPS: WhisperServerDeps = {
	spawn: (binary, args) =>
		nodeSpawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] }),
	fetch: (...args) => fetch(...args),
	freePort,
	secret: () => randomBytes(16).toString("hex"),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	setTimer: (fn, ms) => setTimeout(fn, ms),
	clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
};

/** The server's command line. */
export function serverArgs(options: {
	readonly model: string;
	readonly port: number;
	readonly path: string;
	readonly threads: number;
}): readonly string[] {
	return [
		"-m",
		options.model,
		"--host",
		"127.0.0.1",
		"--port",
		String(options.port),
		"--request-path",
		options.path,
		"-t",
		String(Math.max(1, Math.min(8, options.threads))),
		"-nt",
	];
}

interface Running {
	child: ChildProcess | undefined;
	base: string;
	ready: Promise<void>;
	exited: boolean;
}

export class WhisperServer implements Transcriber {
	readonly live = true;
	private running: Running | undefined;
	private queue: Promise<unknown> = Promise.resolve();
	private idle: unknown;
	private readonly onExit = () => this.stop();

	constructor(
		private readonly install: {
			readonly server: string;
			readonly model: string;
		},
		private readonly deps: WhisperServerDeps = NODE_DEPS,
		private readonly options: {
			readonly idleMs: number;
			readonly startupMs: number;
		} = { idleMs: 10 * 60_000, startupMs: 90_000 },
	) {}

	/** Start the server if it is not running; resolves when it answers. */
	warm(): Promise<void> {
		this.touch();
		return this.ensure().ready;
	}

	/** Whether a server process is running now. */
	get started(): boolean {
		return this.running !== undefined;
	}

	transcribe(pcm: Uint8Array, options: TranscribeOptions): Promise<string> {
		const run = this.queue.then(() => this.request(pcm, options));
		this.queue = run.catch(() => undefined);
		return run;
	}

	stop(): void {
		const running = this.running;
		this.running = undefined;
		if (this.idle !== undefined) this.deps.clearTimer(this.idle);
		this.idle = undefined;
		process.off("exit", this.onExit);
		if (running !== undefined && !running.exited)
			running.child?.kill("SIGTERM");
	}

	private touch(): void {
		if (this.idle !== undefined) this.deps.clearTimer(this.idle);
		const timer = this.deps.setTimer(() => {
			this.idle = undefined;
			this.stop();
		}, this.options.idleMs);
		timer.unref?.();
		this.idle = timer;
	}

	private ensure(): Running {
		if (this.running !== undefined && !this.running.exited) return this.running;
		const running: Running = {
			child: undefined,
			base: "",
			ready: Promise.resolve(),
			exited: false,
		};
		running.ready = this.start(running);
		// Nobody may be waiting yet (a warm-up); the failure is reported to the
		// request that does wait.
		running.ready.catch(() => undefined);
		this.running = running;
		process.on("exit", this.onExit);
		return running;
	}

	private async start(running: Running): Promise<void> {
		const path = `/${this.deps.secret()}`;
		let stderr = "";
		const port = await this.deps.freePort();
		// Stopped while a port was found: start nothing that nobody will stop.
		if (this.running !== running)
			throw new Error("The recogniser was stopped.");
		running.base = `http://127.0.0.1:${port}${path}`;
		const child = this.deps.spawn(
			this.install.server,
			serverArgs({
				model: this.install.model,
				port,
				path,
				threads: availableParallelism(),
			}),
		);
		running.child = child;
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-4000);
		});
		let gone: string | undefined;
		child.on("error", (error) => {
			running.exited = true;
			gone = `could not be started: ${error.message}`;
		});
		child.on("exit", (code, signal) => {
			running.exited = true;
			if (this.running === running) this.running = undefined;
			gone = `stopped (${signal ?? `exit code ${String(code)}`})`;
		});
		const deadline = Date.now() + this.options.startupMs;
		while (Date.now() < deadline && gone === undefined) {
			try {
				const response = await this.deps.fetch(`${running.base}/health`);
				if (response.ok) return;
			} catch {
				// Not listening yet.
			}
			await this.deps.sleep(100);
		}
		if (this.running === running) this.stop();
		const tail = stderr.trim().slice(-400);
		throw new Error(
			`The recogniser ${gone ?? `did not start within ${this.options.startupMs / 1000} seconds`}${tail ? `: ${tail}` : "."}`,
		);
	}

	private async request(
		pcm: Uint8Array,
		options: TranscribeOptions,
	): Promise<string> {
		this.touch();
		const running = this.ensure();
		await running.ready;
		const form = new FormData();
		form.set(
			"file",
			new Blob([wavFile(pcm) as Uint8Array<ArrayBuffer>], {
				type: "audio/wav",
			}),
			"audio.wav",
		);
		form.set("response_format", "text");
		form.set("no_timestamps", "true");
		form.set("temperature", "0");
		form.set("language", options.language);
		if (options.prompt !== undefined) form.set("prompt", options.prompt);
		const seconds = pcm.byteLength / 2 / VOICE_SAMPLE_RATE;
		const deadline = transcriptionDeadlineMs(seconds) - 50_000;
		let response: Response;
		try {
			response = await this.deps.fetch(`${running.base}/inference`, {
				method: "POST",
				body: form,
				signal: AbortSignal.timeout(deadline),
			});
		} catch (error: unknown) {
			// A server that does not answer is a server that is wedged.
			if (this.running === running) this.stop();
			throw new Error(
				`The recogniser did not answer: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const body = await response.text();
		if (!response.ok || body.trimStart().startsWith('{"error"'))
			throw new Error(`The recogniser failed: ${body.trim().slice(0, 400)}`);
		this.touch();
		return cleanTranscript(body);
	}
}

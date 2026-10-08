/**
 * The kept-loaded recogniser's process management (`whisperServer.ts`), with
 * a fake process and a fake HTTP: started once and reused, on 127.0.0.1 under
 * a secret path, waited for until healthy, started again after it dies,
 * stopped when idle, and a failure that says why.
 */

import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import {
	serverArgs,
	WhisperServer,
	type WhisperServerDeps,
} from "./whisperServer.js";

class FakeChild extends EventEmitter {
	readonly stderr = Object.assign(new EventEmitter(), {
		setEncoding: () => undefined,
	});
	killed: string | undefined;
	kill(signal: string) {
		this.killed = signal;
		queueMicrotask(() => this.emit("exit", null, signal));
		return true;
	}
}

function harness(
	options: {
		healthyAfter?: number;
		inference?: (url: string) => Response;
	} = {},
) {
	const children: FakeChild[] = [];
	const spawned: (readonly string[])[] = [];
	let healthChecks = 0;
	const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
	const fetch = vi.fn(
		async (url: string | URL | Request, init?: RequestInit) => {
			const href = String(url);
			if (href.endsWith("/health")) {
				healthChecks++;
				if (healthChecks <= (options.healthyAfter ?? 0))
					throw new Error("ECONNREFUSED");
				return new Response('{"status":"ok"}');
			}
			expect(init?.method).toBe("POST");
			return (
				options.inference?.(href) ??
				new Response(" Fix the bug.\n[BLANK_AUDIO]\n")
			);
		},
	);
	const deps: WhisperServerDeps = {
		spawn: (_binary, args) => {
			spawned.push(args);
			const child = new FakeChild();
			children.push(child);
			return child as unknown as ChildProcess;
		},
		fetch: fetch as unknown as typeof globalThis.fetch,
		freePort: () => Promise.resolve(40123),
		secret: () => "s3cret",
		sleep: () => new Promise((r) => setTimeout(r, 0)),
		setTimer: (fn, ms) => {
			const timer = {
				fn,
				ms,
				cleared: false,
				unref: () => undefined,
				cancel: () => {
					timer.cleared = true;
				},
			};
			timers.push(timer);
			return timer;
		},
	};
	const server = new WhisperServer(
		{ server: "/w/devhub-whisper-server", model: "/w/model.bin" },
		deps,
		{ idleMs: 1000, startupMs: 5000 },
	);
	return { server, children, spawned, fetch, timers };
}

const pcm = new Uint8Array(32_000);

describe("the kept-loaded recogniser", () => {
	it("listens on loopback only, under a secret path", () => {
		const args = serverArgs({
			model: "/m.bin",
			port: 4000,
			path: "/abc",
			threads: 32,
		});
		expect(args).toEqual([
			"-m",
			"/m.bin",
			"--host",
			"127.0.0.1",
			"--port",
			"4000",
			"--request-path",
			"/abc",
			"-t",
			"8",
			"-nt",
		]);
	});

	it("starts once, waits until healthy, and reuses the process", async () => {
		const { server, spawned, fetch } = harness({ healthyAfter: 3 });
		await expect(server.transcribe(pcm, { language: "en" })).resolves.toBe(
			"Fix the bug.",
		);
		await expect(
			server.transcribe(pcm, { language: "ja", prompt: "前" }),
		).resolves.toBe("Fix the bug.");
		expect(spawned).toHaveLength(1);
		const urls = fetch.mock.calls.map(([url]) => String(url));
		expect(urls.filter((u) => u.endsWith("/health"))).toHaveLength(4);
		expect(urls.filter((u) => u.endsWith("/inference"))).toEqual([
			"http://127.0.0.1:40123/s3cret/inference",
			"http://127.0.0.1:40123/s3cret/inference",
		]);
		const form = fetch.mock.calls.at(-1)![1]!.body as FormData;
		expect(form.get("language")).toBe("ja");
		expect(form.get("prompt")).toBe("前");
		expect(form.get("response_format")).toBe("text");
		expect((form.get("file") as Blob).size).toBe(44 + pcm.byteLength);
	});

	it("warming starts it ahead of the first request", async () => {
		const { server, spawned } = harness();
		await server.warm();
		expect(server.started).toBe(true);
		await server.transcribe(pcm, { language: "auto" });
		expect(spawned).toHaveLength(1);
	});

	it("starts again after the process dies", async () => {
		const { server, spawned, children } = harness();
		await server.transcribe(pcm, { language: "en" });
		children[0]!.emit("exit", 1, null);
		await server.transcribe(pcm, { language: "en" });
		expect(spawned).toHaveLength(2);
	});

	it("stops when idle", async () => {
		const { server, children, timers } = harness();
		await server.transcribe(pcm, { language: "en" });
		const live = timers.filter((t) => !t.cleared);
		expect(live).toHaveLength(1);
		expect(live[0]!.ms).toBe(1000);
		live[0]!.fn();
		expect(children[0]!.killed).toBe("SIGTERM");
		expect(server.started).toBe(false);
	});

	it("says why when it exits before it is ready", async () => {
		const { server, children } = harness({ healthyAfter: 1_000_000 });
		const result = server.transcribe(pcm, { language: "en" });
		await new Promise((r) => setTimeout(r, 0));
		children[0]!.stderr.emit("data", "failed to load model");
		children[0]!.emit("exit", 1, null);
		await expect(result).rejects.toThrow(
			/stopped \(exit code 1\): failed to load model/,
		);
	});

	it("turns the server's error answer into a failure", async () => {
		const { server } = harness({
			inference: () => new Response('{"error":"failed to process audio"}'),
		});
		await expect(server.transcribe(pcm, { language: "en" })).rejects.toThrow(
			/failed to process audio/,
		);
	});
});

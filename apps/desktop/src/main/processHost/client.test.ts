/**
 * The process host's client, against a host that is this process: the same
 * `entry.ts` loop, with its messages passed by hand instead of by Electron.
 * Its commands (`runBounded`) and its streams (`openByteStream`).
 */

import { afterEach, describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { openByteStream, setStreamRunner } from "../runtime/byteStream.js";
import { runChildHere, type ChildRun } from "../terminal/childRun.js";
import {
	runStreamHere,
	type StreamRun,
	type StreamSink,
} from "../terminal/streamRun.js";
import {
	OperationDeadline,
	runBounded,
	setChildRunner,
} from "../terminal/command.js";
import { CancellationToken } from "../terminal/ports.js";
import type { ExecLimits } from "../runtime/runtime.js";
import {
	processHostRunner,
	type HostProcess,
	type ProcessHostRunner,
} from "./client.js";
import type { FromHost, ToHost } from "./protocol.js";

/** A host in this process, which can be made to exit. */
function inProcessHost(): HostProcess & {
	readonly asked: ToHost[];
	exit(code: number): void;
} {
	let onMessage: (message: FromHost) => void = () => undefined;
	let onExit: (code: number) => void = () => undefined;
	const runs = new Map<number, ChildRun>();
	const streams = new Map<number, StreamRun>();
	const asked: ToHost[] = [];
	return {
		asked,
		postMessage(message, transfer) {
			asked.push(message);
			if (message.type === "kill") {
				runs.get(message.id)?.kill();
				return;
			}
			if (message.type === "stream-kill") {
				streams.get(message.id)?.kill();
				return;
			}
			if (message.type === "stream") {
				const { id } = message;
				const sink = transfer?.[0];
				const stream = runStreamHere(message.spawn, sink);
				streams.set(id, stream);
				if (sink === undefined) {
					void (async () => {
						for await (const chunk of stream.stdout)
							onMessage({ type: "stream-data", id, chunk });
					})();
				}
				void stream.exit.then((exit) =>
					onMessage({ type: "stream-ended", id, exit }),
				);
				return;
			}
			const { id, request } = message;
			const run = runChildHere(
				request,
				request.streamOutput
					? (chunk) => onMessage({ type: "output", id, chunk })
					: undefined,
			);
			runs.set(id, run);
			void run.outcome.then((outcome) =>
				onMessage({ type: "ended", id, outcome }),
			);
		},
		onMessage: (listener) => {
			onMessage = listener;
		},
		onExit: (listener) => {
			onExit = listener;
		},
		kill: () => undefined,
		exit: (code) => onExit(code),
	};
}

const LIMITS: ExecLimits = {
	stdoutBytes: 1024,
	stderrBytes: 1024,
	overflow: { kind: "truncate" },
};

function sh(script: string, limits: ExecLimits = LIMITS, stdin?: Uint8Array) {
	return runBounded(
		{ file: "/bin/sh", args: ["-c", script], cwd: undefined, env: process.env },
		OperationDeadline.in(5_000),
		new CancellationToken(),
		limits,
		stdin,
	);
}

let runner: ProcessHostRunner | undefined;
afterEach(() => {
	setChildRunner(undefined);
	setStreamRunner(undefined);
	runner?.dispose();
	runner = undefined;
});

describe("commands started by the process host", () => {
	it("answer as the ones started here do: output, exit code, input", async () => {
		const host = inProcessHost();
		runner = processHostRunner(() => host);
		setChildRunner(runner);
		const output = await sh(
			"cat; echo err >&2; exit 3",
			LIMITS,
			new TextEncoder().encode("hello"),
		);
		expect(output.stdout.toString()).toBe("hello");
		expect(output.stderr.toString()).toBe("err\n");
		expect(output.code).toBe(3);
		expect(output.success).toBe(false);
		expect(host.asked.map((each) => each.type)).toEqual(["run"]);
	});

	it("are handed to the host with a plain copy of their environment", async () => {
		const host = inProcessHost();
		runner = processHostRunner(() => host);
		setChildRunner(runner);
		await sh("true");
		const [asked] = host.asked;
		if (asked?.type !== "run") throw new Error("no run was asked for");
		// Main's `process.env` is a host object Electron cannot clone.
		expect(asked.request.env).not.toBe(process.env);
		expect(Object.getPrototypeOf(asked.request.env)).toBe(Object.prototype);
		expect(asked.request.env["PATH"]).toBe(process.env["PATH"]);
	});

	it("keep the caps, and an overflow that fails is the caller's failure", async () => {
		runner = processHostRunner(() => inProcessHost());
		setChildRunner(runner);
		const truncated = await sh("printf 0123456789", {
			...LIMITS,
			stdoutBytes: 4,
		});
		expect(truncated.stdout.toString()).toBe("0123");
		const refused = new Error("too much");
		await expect(
			sh("printf 0123456789", {
				...LIMITS,
				stdoutBytes: 4,
				overflow: { kind: "fail", failure: () => refused },
			}),
		).rejects.toBe(refused);
	});

	it("are ended by their deadline in main, which tells the host to kill them", async () => {
		const host = inProcessHost();
		runner = processHostRunner(() => host);
		setChildRunner(runner);
		await expect(
			runBounded(
				{ file: "/bin/sh", args: ["-c", "sleep 5"], cwd: undefined, env: {} },
				OperationDeadline.in(100),
				new CancellationToken(),
				LIMITS,
			),
		).rejects.toMatchObject({ code: "timed_out" });
		expect(host.asked.map((each) => each.type)).toEqual(["run", "kill"]);
	});

	it("that cannot be started are unavailable, as here", async () => {
		runner = processHostRunner(() => inProcessHost());
		setChildRunner(runner);
		await expect(
			runBounded(
				{ file: "/nonexistent/program", args: [], cwd: undefined, env: {} },
				OperationDeadline.in(5_000),
				new CancellationToken(),
				LIMITS,
			),
		).rejects.toMatchObject({ code: "unavailable" });
	});
});

function stream(
	script: string,
	cancel = new CancellationToken(),
	sink?: StreamSink,
) {
	return openByteStream(
		() =>
			Promise.resolve({
				file: "/bin/sh",
				args: ["-c", script],
				cwd: undefined,
				env: process.env,
			}),
		cancel,
		sink,
	);
}

async function readAll(stdout: AsyncIterable<Buffer>): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of stdout) chunks.push(chunk);
	return Buffer.concat(chunks).toString();
}

/** A port's sending end, keeping what was posted on it. */
function sinkKept() {
	const posted: (string | null)[] = [];
	let closed = false;
	return {
		posted,
		closed: () => closed,
		postMessage: (message: Uint8Array | null) => {
			posted.push(message === null ? null : Buffer.from(message).toString());
		},
		close: () => {
			closed = true;
		},
	};
}

describe("streams started by the process host", () => {
	it("send their bytes back to main and end as the ones started here do", async () => {
		const host = inProcessHost();
		runner = processHostRunner(() => host);
		setStreamRunner(runner);
		const running = stream("printf abc; printf def; printf why >&2; exit 4");
		expect(await readAll(running.stdout)).toBe("abcdef");
		const end = await running.ended;
		expect(end).toMatchObject({ code: 4, signal: null });
		expect(end.stderr.toString()).toBe("why");
		expect(host.asked.map((each) => each.type)).toEqual(["stream"]);
	});

	it("given a sink, send it the bytes and main none of them", async () => {
		runner = processHostRunner(() => inProcessHost());
		setStreamRunner(runner);
		const sink = sinkKept();
		const running = stream("printf abc", new CancellationToken(), sink);
		expect(await readAll(running.stdout)).toBe("");
		expect(await running.ended).toMatchObject({ code: 0 });
		expect(sink.posted.join("")).toBe("abc");
		expect(sink.posted.at(-1)).toBeNull();
		expect(sink.closed()).toBe(true);
	});

	it("are ended through the host when cancelled", async () => {
		const host = inProcessHost();
		runner = processHostRunner(() => host);
		setStreamRunner(runner);
		const cancel = new CancellationToken();
		const running = stream("exec sleep 5", cancel);
		await new Promise((resolve) => setTimeout(resolve, 100));
		cancel.cancel();
		expect(await running.ended).toMatchObject({ signal: "SIGTERM" });
		expect(host.asked.map((each) => each.type)).toEqual([
			"stream",
			"stream-kill",
		]);
	});

	it("that cannot be started are unavailable, as here", async () => {
		runner = processHostRunner(() => inProcessHost());
		setStreamRunner(runner);
		const running = openByteStream(
			() =>
				Promise.resolve({
					file: "/nonexistent/program",
					args: [],
					cwd: undefined,
					env: {},
				}),
			new CancellationToken(),
		);
		expect(await readAll(running.stdout)).toBe("");
		await expect(running.ended).rejects.toMatchObject({ code: "unavailable" });
	});
});

describe("a process host that ends", () => {
	it("fails the streams it held, which their readers open again on a new one", async () => {
		const hosts: ReturnType<typeof inProcessHost>[] = [];
		runner = processHostRunner(
			() => {
				const host = inProcessHost();
				hosts.push(host);
				return host;
			},
			() => undefined,
		);
		setStreamRunner(runner);
		const cancel = new CancellationToken();
		const held = stream("exec sleep 5", cancel);
		await new Promise((resolve) => setTimeout(resolve, 50));
		hosts[0]!.exit(9);
		await expect(held.ended).rejects.toMatchObject({ code: "failed" });
		const again = stream("printf again");
		expect(await readAll(again.stdout)).toBe("again");
		expect(hosts).toHaveLength(2);
		// The child of the host that "ended" here is still this process's.
		cancel.cancel();
	});

	it("fails what it held, and the next command starts a new one", async () => {
		const hosts: ReturnType<typeof inProcessHost>[] = [];
		const lines: string[] = [];
		runner = processHostRunner(
			() => {
				const host = inProcessHost();
				hosts.push(host);
				return host;
			},
			(line) => lines.push(line),
		);
		setChildRunner(runner);
		const held = sh("sleep 5");
		hosts[0]!.exit(9);
		await expect(held).rejects.toMatchObject({ code: "failed" });
		expect((await sh("echo again")).stdout.toString()).toBe("again\n");
		expect(hosts).toHaveLength(2);
		expect(lines).toEqual([
			"[devhub] process host ended with exit code 9; the next command starts it again",
		]);
	});

	it("is given up on after three exits in a minute: commands start in main", async () => {
		const hosts: ReturnType<typeof inProcessHost>[] = [];
		const lines: string[] = [];
		runner = processHostRunner(
			() => {
				const host = inProcessHost();
				hosts.push(host);
				return host;
			},
			(line) => lines.push(line),
			() => 1_000,
		);
		setChildRunner(runner);
		for (let round = 0; round < 3; round += 1) {
			await sh("true");
			hosts.at(-1)!.exit(1);
		}
		expect((await sh("echo here")).stdout.toString()).toBe("here\n");
		setStreamRunner(runner);
		expect(await readAll(stream("printf here").stdout)).toBe("here");
		expect(hosts).toHaveLength(3);
		expect(hosts.at(-1)!.asked.map((each) => each.type)).toEqual(["run"]);
		expect(lines.at(-1)).toBe(
			"[devhub] process host ended 3 times in a minute; commands and streams start in main from now on",
		);
	});
});

describe("the process host's entry", () => {
	it("is the compiled entry beside the app's other output, wherever main was bundled", async () => {
		const { PROCESS_HOST_ENTRY } = await import("./client.js");
		const { APP_ROOT } = await import("../shell/appRoot.js");
		expect(PROCESS_HOST_ENTRY).toBe(
			`${APP_ROOT}/out/main/processHost/entry.js`,
		);
	});
});

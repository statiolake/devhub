/**
 * The process host's client, against a host that is this process: the same
 * `entry.ts` loop, with its messages passed by hand instead of by Electron.
 */

import { afterEach, describe, expect, it } from "vitest";
import { runChildHere, type ChildRun } from "../terminal/childRun.js";
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
	const asked: ToHost[] = [];
	return {
		asked,
		postMessage(message) {
			asked.push(message);
			if (message.type === "kill") {
				runs.get(message.id)?.kill();
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

describe("a process host that ends", () => {
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
		expect(hosts).toHaveLength(3);
		expect(lines.at(-1)).toBe(
			"[devhub] process host ended 3 times in a minute; commands start in main from now on",
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

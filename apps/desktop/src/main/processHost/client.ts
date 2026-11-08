/**
 * Main's side of the process host (`entry.ts`): a `ChildRunner` whose
 * children are started in a utility process instead of on main's thread.
 *
 * `spawn` is synchronous, and on Linux it forks: measured from main, with
 * its few hundred megabytes mapped, one spawn held main's thread for about
 * 8 ms (2 ms from a small Node process), and main starts tmux, git and the
 * Agents' host scripts several times a second — the largest single item in
 * main's profile in every scenario docs/process-model.md measured. Here a
 * run costs main one message each way.
 *
 * Nothing about a run's meaning moves: `runBounded` keeps the deadline, the
 * cancellation and which failure wins, and ends a run with `kill`.
 *
 * **When the host is gone.** A host that exits fails the runs it held, the
 * way a child that died would (a `spawn-error`, so `runBounded` reports a
 * failed command), and the next run starts a new one. A host that keeps
 * dying is given up on: after `MAX_RESTARTS` exits within a minute, runs go
 * back to starting here, in main, and that is said once.
 */

import { join } from "node:path";
import { electron } from "../electron.js";
import { APP_ROOT } from "../shell/appRoot.js";
import {
	RUN_HERE,
	type ChildOutcome,
	type ChildRequest,
	type ChildRun,
	type ChildRunner,
} from "../terminal/childRun.js";
import type { FromHost, ToHost } from "./protocol.js";

const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;

/** What the client needs of a utility process; Electron's, in DevHub. */
export interface HostProcess {
	postMessage(message: ToHost): void;
	onMessage(listener: (message: FromHost) => void): void;
	onExit(listener: (code: number) => void): void;
	kill(): void;
}

export type HostLauncher = () => HostProcess;

/**
 * The host's entry, from the app's root rather than from this module: in a
 * packaged app this module is folded into one bundle elsewhere, and
 * `out/main/` ships beside it module by module (`shell/appRoot.ts`).
 */
export const PROCESS_HOST_ENTRY = join(
	APP_ROOT,
	"out",
	"main",
	"processHost",
	"entry.js",
);

/** The process host as an Electron utility process. */
export function electronHostLauncher(): HostProcess {
	const child = electron.utilityProcess.fork(PROCESS_HOST_ENTRY, [], {
		serviceName: "DevHub Process Host",
	});
	return {
		postMessage: (message) => child.postMessage(message),
		onMessage: (listener) =>
			child.on("message", (message: unknown) => listener(message as FromHost)),
		onExit: (listener) => child.on("exit", listener),
		kill: () => {
			child.kill();
		},
	};
}

interface Pending {
	readonly settle: (outcome: ChildOutcome) => void;
	readonly onOutput: ((chunk: Uint8Array) => void) | undefined;
}

export interface ProcessHostRunner extends ChildRunner {
	dispose(): void;
}

export function processHostRunner(
	launch: HostLauncher = electronHostLauncher,
	log: (line: string) => void = (line) => console.warn(line),
	now: () => number = Date.now,
): ProcessHostRunner {
	let host: HostProcess | undefined;
	let disposed = false;
	let gaveUp = false;
	const exits: number[] = [];
	const pending = new Map<number, Pending>();
	let nextId = 1;

	const failAll = (why: string) => {
		const held = [...pending.values()];
		pending.clear();
		for (const run of held) {
			run.settle({
				kind: "spawn-error",
				error: { message: why, code: undefined },
			});
		}
	};

	const hostNow = (): HostProcess => {
		if (host !== undefined) return host;
		const started = launch();
		started.onMessage((message) => {
			if (started !== host) return;
			const run = pending.get(message.id);
			if (run === undefined) return;
			switch (message.type) {
				case "output":
					run.onOutput?.(message.chunk);
					return;
				case "ended":
					pending.delete(message.id);
					run.settle(message.outcome);
					return;
				case "threw":
					pending.delete(message.id);
					run.settle({
						kind: "spawn-error",
						error: { message: message.message, code: undefined },
					});
					return;
			}
		});
		started.onExit((code) => {
			if (started !== host) return;
			host = undefined;
			failAll(`the process host ended (exit code ${String(code)})`);
			if (disposed) return;
			const at = now();
			exits.push(at);
			while (exits.length > 0 && at - (exits[0] ?? at) > RESTART_WINDOW_MS) {
				exits.shift();
			}
			log(
				`[devhub] process host ended with exit code ${String(code)}; the next command starts it again`,
			);
			if (exits.length >= MAX_RESTARTS) {
				gaveUp = true;
				log(
					`[devhub] process host ended ${String(exits.length)} times in a minute; commands start in main from now on`,
				);
			}
		});
		host = started;
		return started;
	};

	return {
		run(request: ChildRequest, onOutput): ChildRun {
			if (disposed || gaveUp) return RUN_HERE.run(request, onOutput);
			const id = nextId++;
			let settle: (outcome: ChildOutcome) => void = () => undefined;
			const outcome = new Promise<ChildOutcome>((resolve) => {
				settle = resolve;
			});
			pending.set(id, { settle, onOutput });
			const target = hostNow();
			target.postMessage({ type: "run", id, request });
			return {
				outcome,
				kill: () => {
					if (!pending.delete(id)) return;
					if (host === target) target.postMessage({ type: "kill", id });
				},
			};
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			const running = host;
			host = undefined;
			failAll("DevHub is quitting");
			running?.kill();
		},
	};
}

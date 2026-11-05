/**
 * Keep DevHub's process group from being orphaned while workbenches are
 * frozen.
 *
 * **What went wrong.** A frozen workbench is SIGSTOPped processes —
 * renderer, extension hosts, language servers — in the process group of
 * DevHub's main process. The POSIX orphaned-process-group rule says that when
 * a process group becomes orphaned while any member is stopped, the kernel
 * sends every member of the group SIGHUP and then SIGCONT. DevHub's main is a
 * session and group leader (launchd starts it that way; so does `dev.sh`
 * under `setsid`), so its group is orphaned from the start, and the kernel
 * re-checks whenever a process that qualified it exits: a tool that moved
 * itself into a group of its own and left a child behind in DevHub's is
 * enough. Every DevHub process then got SIGHUP at once: the extension hosts,
 * the pty host and the agent host exited with code 0, the main process took
 * SIGHUP as Electron's "quit gracefully", and DevHub closed itself with exit
 * status 0 and no crash report — on a person's Mac, a few seconds after the
 * second background workbench was frozen, on every launch.
 *
 * **What this does.** A group is not orphaned while one of its members has a
 * parent in another group of the same session. `devhub-pgrp-anchor`
 * (`native/processGroupAnchor.c`) makes such a member and holds it for the
 * life of DevHub: it forks a keeper that stays in DevHub's group, moves itself
 * into a group of its own, and waits for its stdin — a pipe this process holds
 * — to close. The freezer asks `anchored()` before it stops anything: a
 * workbench is only frozen while the anchor holds, because a freeze without
 * it is the condition that took DevHub down.
 *
 * The SIGHUP answer in `quitTrace.ts` is the floor under this: if the group is
 * hung up anyway, DevHub's main says so in the log and stays up.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

import { nativeHelperPath } from "./appRoot.js";

export const ANCHOR_HELPER = nativeHelperPath("devhub-pgrp-anchor");

/** A restart this soon after the last start is a helper that cannot hold. */
const RESTART_AFTER_MS = 1_000;
const MAX_RESTARTS = 5;

export interface AnchorDeps {
	readonly helper: string;
	exists(path: string): boolean;
	spawn(file: string): ChildProcess;
	log(line: string): void;
	schedule(run: () => void, ms: number): void;
}

const systemDeps: AnchorDeps = {
	helper: ANCHOR_HELPER,
	exists: existsSync,
	// Not detached: it has to start in DevHub's process group to anchor it.
	spawn: (file) => spawn(file, [], { stdio: ["pipe", "pipe", "pipe"] }),
	log: (line) => {
		console.log(line);
	},
	schedule: (run, ms) => {
		const timer = setTimeout(run, ms);
		(timer as unknown as { unref?: () => void }).unref?.();
	},
};

export class ProcessGroupAnchor {
	private child: ChildProcess | undefined;
	private holding = false;
	private stopped = false;
	private restarts = 0;
	private unavailable = false;

	constructor(private readonly deps: AnchorDeps = systemDeps) {}

	/** Whether DevHub's process group is anchored now. */
	anchored(): boolean {
		return this.holding;
	}

	start(): void {
		if (this.stopped || this.child !== undefined) return;
		if (!this.deps.exists(this.deps.helper)) {
			if (!this.unavailable) {
				this.unavailable = true;
				this.deps.log(
					`[devhub] process group anchor: ${this.deps.helper} is not built — workbenches will not be frozen (run 'pnpm --filter @devhub/desktop build:native')`,
				);
			}
			return;
		}
		const child = this.deps.spawn(this.deps.helper);
		this.child = child;
		let output = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
			const match = /^anchored (\d+) (\d+)$/m.exec(output);
			if (match && !this.holding && this.child === child) {
				this.holding = true;
				this.deps.log(
					`[devhub] process group anchor: holding (anchor ${match[1]}, keeper ${match[2]} in DevHub's group)`,
				);
			}
		});
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => {
			this.deps.log(
				`[devhub] process group anchor: could not start: ${error.message}`,
			);
		});
		child.on("close", (code, signal) => {
			if (this.child !== child) return;
			this.child = undefined;
			this.holding = false;
			if (this.stopped) return;
			this.deps.log(
				`[devhub] process group anchor: ended (code ${String(code)}, signal ${String(signal)})${stderr ? `: ${stderr.trim()}` : ""} — workbenches are not frozen until it holds again`,
			);
			if (this.restarts >= MAX_RESTARTS) {
				this.deps.log(
					"[devhub] process group anchor: given up after repeated failures",
				);
				return;
			}
			this.restarts += 1;
			this.deps.schedule(() => {
				this.start();
			}, RESTART_AFTER_MS);
		});
	}

	/** DevHub is going: let the anchor end (its stdin closes). */
	stop(): void {
		this.stopped = true;
		this.holding = false;
		this.child?.stdin?.end();
		this.child = undefined;
	}
}

let instance: ProcessGroupAnchor | undefined;

/** The one anchor of this process, started on first use. */
export function processGroupAnchor(): ProcessGroupAnchor {
	instance ??= new ProcessGroupAnchor();
	instance.start();
	return instance;
}

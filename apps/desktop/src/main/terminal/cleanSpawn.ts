/**
 * Start a child with none of this process's descriptors but its stdio.
 *
 * On Linux Node's `spawn` (libuv) forks and execs without closing what the
 * parent had open, so every descriptor of the parent's that is not
 * close-on-exec is inherited by the child and by its children. Electron's
 * processes have such descriptors: main's `--remote-debugging-port` listening
 * socket, Chromium's shared-memory and snapshot files, a utility process's own
 * channel. DevHub's tmux server is started by a short `tmux` command and
 * lives for days, so it held them all: the next DevHub could not bind the
 * debugging port while it lived (docs/process-model.md, finding 9).
 *
 * `devhub-exec-clean` (`native/execClean.c`) marks every descriptor above 2
 * close-on-exec and then execs the program in the same process, so the pid,
 * the process group, the pipes and the exit status are the program's own.
 * node-pty already does the same for the PTYs it opens.
 *
 * Only on Linux: on macOS libuv starts children with `posix_spawn` and
 * `POSIX_SPAWN_CLOEXEC_DEFAULT`, which inherits nothing but stdio already.
 * (The helper is built on macOS too, for `ownedSpawnArgs`.)
 * The program is looked up first, and a program that cannot be found is
 * started directly, so that `spawn` reports it the way it always has (an
 * `ENOENT` error event) rather than as an exit status of 127.
 */

import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

import { nativeHelperPath } from "../shell/appRoot.js";

let helper: string | undefined | null = null;

/** Where the helper is; `undefined` turns the wrapping off. For tests and bundles. */
export function setExecCleanHelper(path: string | undefined): void {
	helper = path;
}

function helperPath(): string | undefined {
	if (helper === null) {
		const built = nativeHelperPath("devhub-exec-clean");
		helper = existsSync(built) ? built : undefined;
	}
	return helper;
}

function executable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** What `execvp` would run for `file`, or `undefined` when it would find nothing. */
export function resolveProgram(
	file: string,
	cwd: string | undefined,
	env: Readonly<Record<string, string | undefined>>,
): string | undefined {
	if (file.includes("/")) {
		const path = isAbsolute(file) ? file : resolve(cwd ?? process.cwd(), file);
		return executable(path) ? path : undefined;
	}
	for (const directory of (env["PATH"] ?? "").split(delimiter)) {
		if (directory === "") continue;
		const path = join(
			isAbsolute(directory)
				? directory
				: resolve(cwd ?? process.cwd(), directory),
			file,
		);
		if (executable(path)) return path;
	}
	return undefined;
}

/**
 * The `file` and `args` to hand `spawn` for `file args…`: through the helper
 * where that is needed and possible, as they are otherwise.
 */
export function cleanSpawnArgs(
	file: string,
	args: readonly string[],
	cwd: string | undefined,
	env: Readonly<Record<string, string | undefined>>,
	platform: NodeJS.Platform = process.platform,
): { readonly file: string; readonly args: readonly string[] } {
	if (platform !== "linux") return { file, args };
	const wrapper = helperPath();
	if (wrapper === undefined) return { file, args };
	const program = resolveProgram(file, cwd, env);
	if (program === undefined) return { file, args };
	return { file: wrapper, args: [program, file, ...args] };
}

/**
 * The `file` and `args` to hand `spawn` for a child that must not outlive
 * `owner`, the process that spawns it (this one, by default): through the
 * helper with `--die-with`, which also starts it clean (as `cleanSpawnArgs`).
 *
 * This is for children whose own way of noticing their owner's end cannot be
 * relied on. A tmux control client (`tmux -C attach-session`) on pipes is
 * meant to exit when its stdin closes, but tmux reads that stdin only once
 * the attach is done, and a client the server still had output queued for
 * when its reader went is never let go: it stayed attached, at its size,
 * after the pty host that owned it had gone (`native/execClean.c`). With the
 * helper the kernel ends it with its owner — Linux's parent-death signal, a
 * kqueue watchdog on macOS — SIGKILL of the owner included.
 *
 * Linux and macOS; elsewhere, without a helper, or for a program that cannot
 * be found, the child is started directly, as before.
 */
export function ownedSpawnArgs(
	file: string,
	args: readonly string[],
	cwd: string | undefined,
	env: Readonly<Record<string, string | undefined>>,
	owner: number = process.pid,
	platform: NodeJS.Platform = process.platform,
): { readonly file: string; readonly args: readonly string[] } {
	if (platform !== "linux" && platform !== "darwin") return { file, args };
	const wrapper = helperPath();
	if (wrapper === undefined) return { file, args };
	const program = resolveProgram(file, cwd, env);
	if (program === undefined) return { file, args };
	return {
		file: wrapper,
		args: ["--die-with", String(owner), program, file, ...args],
	};
}

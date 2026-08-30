/**
 * The one place DevHub opens a pseudo-terminal.
 *
 * `node-pty` is a native module, and the binary that has to load it is VS
 * Code's own Electron (`vscode/.build/electron`). The submodule already ships a
 * `node-pty` compiled for exactly that ABI — it is what the integrated terminal
 * uses — so DevHub resolves *that* copy through `code-oss-dev/package.json`
 * instead of declaring a dependency of its own. A second copy would have to be
 * rebuilt against Electron's headers on every install and every submodule bump,
 * and a mismatch shows up as a load failure at runtime rather than at build
 * time. Resolving through the submodule makes the ABI question unaskable.
 *
 * Everything below this module speaks the narrow `Pty` interface, so the
 * attachment logic can be exercised with a fake and only this file needs the
 * native module present.
 */

import { createRequire } from "node:module";

/** The parts of node-pty's surface DevHub uses. */
interface NodePtyProcess {
	readonly pid: number;
	onData(listener: (data: string) => void): { dispose(): void };
	onExit(listener: (event: { exitCode: number; signal?: number }) => void): {
		dispose(): void;
	};
	write(data: string | Buffer): void;
	resize(
		columns: number,
		rows: number,
		pixelSize?: { width: number; height: number },
	): void;
	kill(signal?: string): void;
	pause(): void;
	resume(): void;
}

interface NodePtyModule {
	spawn(
		file: string,
		args: readonly string[],
		options: {
			name?: string;
			cwd?: string;
			cols?: number;
			rows?: number;
			env?: Record<string, string | undefined>;
			encoding?: string | null;
		},
	): NodePtyProcess;
}

let cached: NodePtyModule | undefined;

/**
 * The submodule's node-pty.
 *
 * A failure here is not recoverable and must not be turned into a terminal that
 * silently never starts: it means the submodule is not provisioned, and the
 * caller surfaces it.
 */
export function nodePty(): NodePtyModule {
	if (cached) return cached;
	const requireHere = createRequire(import.meta.url);
	// Resolve *from* the submodule's package.json, so node-pty's own
	// dependencies come from `vscode/node_modules` as well.
	const submodule = requireHere.resolve("code-oss-dev/package.json");
	const requireFromSubmodule = createRequire(submodule);
	cached = requireFromSubmodule("node-pty") as NodePtyModule;
	return cached;
}

export interface PtyLaunch {
	/** The absolute path of the program to run. Always the tmux client. */
	readonly file: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly cols: number;
	readonly rows: number;
	readonly pixelWidth: number;
	readonly pixelHeight: number;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** The narrow PTY the attachment logic owns. */
export interface Pty {
	readonly pid: number;
	onData(listener: (bytes: Uint8Array) => void): void;
	onExit(listener: () => void): void;
	write(bytes: Uint8Array): void;
	resize(size: {
		cols: number;
		rows: number;
		pixelWidth: number;
		pixelHeight: number;
	}): void;
	kill(): void;
	pause(): void;
	resume(): void;
}

export type PtyFactory = (launch: PtyLaunch) => Pty;

/**
 * The environment the tmux client starts with.
 *
 * The surface is xterm.js, so its capability set is deliberately stable across
 * launch environments: inheriting the host's `TERM` (`dumb`, or a Ghostty- or
 * WezTerm-specific value) can make tmux refuse the client outright, or describe
 * capabilities the page does not have. `TMUX`/`TMUX_PANE` are removed because a
 * DevHub launched from inside a tmux pane must not let its client believe it is
 * nesting inside that server.
 */
export function terminalEnvironment(
	base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...base };
	delete env.TMUX;
	delete env.TMUX_PANE;
	env.TERM = "xterm-256color";
	return env;
}

/**
 * Open a real PTY on the submodule's node-pty.
 *
 * node-pty is asked for UTF-8 text rather than raw bytes on purpose: the
 * `encoding` option is also what decides whether the tty is opened with
 * `IUTF8`, and without that flag the line discipline erases a multi-byte
 * character one byte at a time. The bytes the wire carries are re-encoded here,
 * so the frame contract stays binary either way.
 */
export const openPty: PtyFactory = (launch) => {
	const process_ = nodePty().spawn(launch.file, [...launch.args], {
		name: "xterm-256color",
		cwd: launch.cwd,
		cols: launch.cols,
		rows: launch.rows,
		env: launch.env,
	});
	return {
		get pid() {
			return process_.pid;
		},
		onData(listener) {
			process_.onData((data) => listener(Buffer.from(data, "utf8")));
		},
		onExit(listener) {
			process_.onExit(() => listener());
		},
		write(bytes) {
			process_.write(Buffer.from(bytes));
		},
		resize(size) {
			process_.resize(size.cols, size.rows, {
				width: size.pixelWidth,
				height: size.pixelHeight,
			});
		},
		kill() {
			process_.kill();
		},
		pause() {
			process_.pause();
		},
		resume() {
			process_.resume();
		},
	};
};

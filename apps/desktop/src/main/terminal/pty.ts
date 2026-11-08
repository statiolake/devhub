/**
 * The one place DevHub opens a pseudo-terminal.
 *
 * `node-pty` is `@devhub/desktop`'s own dependency, pinned exactly. It is an
 * N-API addon and ships prebuilt binaries for every platform DevHub runs on
 * (`node_modules/node-pty/prebuilds/<platform>-<arch>`), so the same file
 * loads in Electron and in plain Node, and nothing is compiled at install.
 * (It used to be the VS Code submodule's copy, built for VS Code's Electron;
 * see docs/without-vscode.md.) It is required rather than imported so that a
 * module that only names these types does not load the addon.
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
 * node-pty, resolved from wherever this module is: `apps/desktop/node_modules`
 * in a checkout, `Resources/app/node_modules` in the packaged app.
 *
 * A failure here is not recoverable and must not be turned into a terminal that
 * silently never starts: it means the install or the package is incomplete,
 * and the caller surfaces it.
 */
export function nodePty(): NodePtyModule {
	// Spelled `require("node-pty")` so that packaging's import scan
	// (scripts/package-nightly.py) sees the dependency.
	const require = createRequire(import.meta.url);
	cached ??= require("node-pty") as NodePtyModule;
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
	/**
	 * Run on plain pipes, not a terminal: a tmux control client, whose
	 * commands a terminal would echo and cut at its line length. A machine
	 * that wraps the launch (an SSH host) opens no terminal for it either.
	 */
	readonly pipes?: boolean;
}

/** The narrow PTY the attachment logic owns. */
export interface Pty {
	readonly pid: number;
	onData(listener: (bytes: Uint8Array) => void): void;
	/** `exitCode` is the program's, when the platform reported one. */
	onExit(listener: (exitCode?: number) => void): void;
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
 * What a machine would open on *this* machine for a PTY of its own, said
 * without opening it: the program and its environment as `openPty` takes them,
 * and what to give back once the PTY has ended (an SSH session slot).
 *
 * This is how a terminal client is started somewhere other than the process
 * that asked for it — the pty host (`main/ptyHost/`) — while the machine's own
 * rules for starting one stay the machine's (`Runtime.ptyPlan`).
 */
export interface PtyPlan {
	readonly launch: PtyLaunch;
	/** Called once, when the PTY has ended or was never opened. Idempotent. */
	ended(): void;
}

/**
 * The environment the tmux client starts with.
 *
 * The surface is xterm.js, so its capability set is deliberately stable across
 * launch environments: inheriting the host's `TERM` (`dumb`, or a Ghostty- or
 * WezTerm-specific value) can make tmux refuse the client outright, or describe
 * capabilities the page does not have. `TMUX`/`TMUX_PANE` are removed because a
 * DevHub launched from inside a tmux pane must not let its client believe it is
 * nesting inside that server.
 *
 * `TERM` stays `xterm-256color` and `COLORTERM` says `truecolor`, which is the
 * pair every modern terminal emulator sends and the pair every consumer of the
 * two already knows how to read. They are not in tension: `TERM` names a
 * terminfo entry that must exist on any machine (a `*-direct` entry does not),
 * and `COLORTERM` is the out-of-band channel invented precisely because
 * terminfo could not express 24-bit colour. tmux reads it from the attaching
 * client and adds the `RGB` feature for that client on its own; programs that
 * do not know tmux read it directly. xterm.js renders 24-bit already, so the
 * page needs nothing — the whole of the fix is telling the truth about it here.
 */
export function terminalEnvironment(
	base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...base };
	delete env.TMUX;
	delete env.TMUX_PANE;
	env.TERM = "xterm-256color";
	env.COLORTERM = "truecolor";
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
			process_.onExit((event) => listener(event.exitCode));
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

/**
 * The machine a Workspace's folder is on, as a value.
 *
 * Everything DevHub runs for a Workspace — `git`, tmux, the Agent pane's PTY,
 * the folder probes, the `HEAD` watcher — runs *somewhere*, and until now that
 * somewhere was "this Mac", spelled out forty times as a direct `spawn`, a
 * `node:fs/promises` call or an `fs.watch`. That is not a policy anything can
 * change; it is the absence of one.
 *
 * So the machine becomes a `Runtime`: one interface with every way DevHub
 * touches a Workspace's machine, obtained from a `WorkspaceLocation` by one
 * function (`runtimeFor`, in `registry.ts`). The rule that makes it worth
 * having is stated there and enforced by it — **`kind === "ssh"` appears in
 * exactly one place in `main/`** — and the rule that makes it honest is here:
 * every method on this interface must be answerable across a network, or it
 * does not belong on it. That is why there is a `watchGitDirectory` and not a
 * `watch`: `fs.watch` has no remote equivalent and no honest imitation, and a
 * seam that pretended otherwise would push the pretence into every caller.
 *
 * Nothing on a `Runtime` says which implementation it is. A caller that needs
 * to know is a caller that is about to grow the branch this file exists to
 * prevent; what it may read is `where`, which is a phrase for a sentence, and
 * `cadence`, which is a number for a loop.
 */

import type { Buffer } from "node:buffer";
import type { OperationDeadline } from "../terminal/command.js";
import type { CancellationToken } from "../terminal/ports.js";
import type { Pty, PtyLaunch } from "../terminal/pty.js";

/**
 * Which machine, as a key.
 *
 * `local`, or `ssh:<host>`. It is what a per-host cache is filed under and
 * what a metrics reading is named by, so it is a string rather than an object:
 * two runtimes with the same id are the same machine, and that has to be a
 * comparison rather than a convention.
 */
export type RuntimeId = "local" | `ssh:${string}`;

/**
 * What an answer bigger than its cap means.
 *
 * The two callers disagree, and they are both right, so the disagreement is a
 * parameter rather than a rule the seam picks for them. tmux's answers are
 * *identity* — a session list truncated halfway is not a shorter list of
 * sessions, it is a wrong one — so an over-long answer is a failure, in tmux's
 * own vocabulary, composed by the caller that owns that vocabulary. git's
 * answers are read as text and have always been truncated at four megabytes,
 * so truncating is what "no behaviour change" means for them.
 */
export type ExecOverflow =
	| { readonly kind: "truncate" }
	| { readonly kind: "fail"; readonly failure: () => Error };

/** How much of an answer DevHub will read, and what happens past it. */
export interface ExecLimits {
	readonly stdoutBytes: number;
	readonly stderrBytes: number;
	readonly overflow: ExecOverflow;
}

export interface ExecRequest {
	/**
	 * The program and its arguments — never a shell string.
	 *
	 * A shell string is the one shape that cannot survive the trip: locally
	 * `spawn` would have to be told to start a shell, and remotely the argv is
	 * quoted into one command line by `shellQuote` (`quote.ts`) precisely so
	 * that a branch name with a space, a quote or a `;` in it stays one word.
	 * Handing this a string would mean the caller had already quoted, or had
	 * already failed to.
	 */
	readonly argv: readonly string[];
	/** Absolute, on the runtime's machine. */
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	/**
	 * Anything secret, because argv is world-readable in `ps` — on this machine
	 * as much as on somebody's server.
	 */
	readonly stdin?: Uint8Array;
	readonly deadline: OperationDeadline;
	readonly cancel: CancellationToken;
	readonly limits: ExecLimits;
}

export interface ExecResult {
	readonly code: number | null;
	readonly signal: string | null;
	readonly stdout: Buffer;
	readonly stderr: Buffer;
}

/**
 * What to open a pseudo-terminal on.
 *
 * The same shape `node-pty` is handed locally (`PtyLaunch`), because the
 * remote arm wraps exactly this argv in an `ssh -tt` and hands *that* to the
 * same `node-pty`. Everything above the `Pty` interface — the attachment
 * logic, its acks, its resizes — neither knows nor needs to know which of the
 * two happened.
 */
export type PtyRequest = PtyLaunch;

/** What is at a path: the three answers a probe is allowed to give. */
export type FileKind = "directory" | "file" | "absent";

/**
 * A path DevHub could not find out about.
 *
 * Not-there is an answer (`"absent"`); could-not-look is this. The distinction
 * is the whole of `worktreeFolder.ts`'s top comment — a close that reads
 * `EACCES` as "already gone" deletes git's record of a worktree whose folder
 * is still sitting there with work in it — so the errno travels with it and
 * the caller quotes it.
 */
export class RuntimeFileError extends Error {
	constructor(
		readonly path: string,
		readonly code: string | undefined,
		options?: ErrorOptions,
	) {
		super(`${path} could not be read (${code ?? "unknown"})`, options);
		this.name = "RuntimeFileError";
	}
}

/** One entry of a directory listing. */
export interface DirEntry {
	readonly name: string;
	readonly directory: boolean;
}

/**
 * A `HEAD` watch, however it is implemented.
 *
 * Locally it is two `fs.watch`es; remotely it will be a poll. The caller gets
 * the same three words either way — it fires, or it does not, and it closes —
 * because the debounce, the failure map and the safety poll above it were
 * written against those three words and not against inotify.
 */
export interface Watcher {
	close(): void;
}

/**
 * What a loop over this machine is allowed to cost.
 *
 * A constant in the loop would be a constant for every machine, and the number
 * that is right for a fork on this Mac is an ssh flood on a host across an
 * ocean. So the loops read it from here.
 */
export interface RuntimeCadence {
	readonly reconcileIntervalMs: number;
	readonly repositoryPollMs: number;
	/** `undefined` means real filesystem events, not a poll. */
	readonly headWatchPollMs: number | undefined;
}

/**
 * What one machine is costing, for `devhub --metrics`.
 *
 * A remote DevHub's cost is invisible otherwise: the processes are not in
 * `getAppMetrics`, the round trips are not in any counter, and "why is this
 * slow" would need a packet capture to answer. It is here for the local
 * runtime too, and reads as it should — one machine, connected, no latency.
 */
export interface RuntimeReading {
	readonly id: RuntimeId;
	readonly connected: boolean;
	/** The ssh ControlMaster's pid, when there is one. */
	readonly masterPid: number | undefined;
	readonly medianRoundTripMs: number;
	readonly reconcileIntervalMs: number;
	readonly execsLastMinute: number;
	readonly lastFailure: string | undefined;
}

/**
 * What a machine needs in order to have a `devhub-terminal` on it.
 *
 * The integrated terminal of a workbench runs where the workbench's pty host
 * runs, and for an ssh window that is the far machine. So the launcher is not
 * one file on this Mac any more: it is one per machine, and this is everything
 * a machine that has none needs to be given in order to grow one — the script
 * DevHub already wrote for itself (which is the whole answer when the machine
 * *is* this one), the socket the answer comes back over, and the two facts a
 * far machine cannot discover: which files make up the asking program, and
 * which commit's REH is installed there to run them.
 */
export interface TerminalLauncherSpec {
	/** The launcher DevHub wrote at startup, for the machine it is running on. */
	readonly localLauncherPath: string;
	/** DevHub's control socket, on the machine DevHub is running on. */
	readonly controlSocketPath: string;
	/**
	 * The compiled `devhubTerminal.js`, and every compiled file it imports.
	 *
	 * A path relative to the module root, against the file's text. It is a
	 * closure and not one bundled file because there is no bundler in this
	 * build, and it is computed rather than listed because a list is a thing
	 * that rots the first time somebody adds an `import` — see
	 * `terminalEntryClosure`.
	 */
	readonly entryFiles: ReadonlyMap<string, string>;
	/** Which of those is the one to run. */
	readonly entryName: string;
	/** `product.json`'s `serverDataFolderName`: where the REH lives over there. */
	readonly serverDataFolderName: string;
	/**
	 * The commit this DevHub states, which is the directory its REH is under.
	 *
	 * `undefined` in a source checkout, which is also a DevHub that can open no
	 * remote workbench at all, so the refusal is the same fact said once.
	 */
	readonly serverCommit: string | undefined;
}

/** A machine's `devhub-terminal`, and whether it can reach DevHub. */
export interface TerminalLauncher {
	/** The path a workbench on that machine names as its terminal profile. */
	readonly path: string;
	/**
	 * `undefined` when the launcher can reach DevHub's control socket; the
	 * sentence saying why it cannot, otherwise.
	 *
	 * Not a throw, because a window that cannot have a DevHub terminal is still
	 * a window a person asked for, and not a silence either: the launcher run
	 * from that window says the same thing in the terminal tab, and this says it
	 * in the log and in `devhub --metrics`.
	 */
	readonly unreachable: string | undefined;
}

export interface Runtime {
	/** `local`, or `ssh:<host>`. The key a per-host cache is filed under. */
	readonly id: RuntimeId;
	/** For a sentence: `""` locally, `" on <host>"` remotely. */
	readonly where: string;
	/** `$HOME` on that machine; resolved once, at first use. */
	home(): Promise<string>;

	exec(request: ExecRequest): Promise<ExecResult>;
	spawnPty(request: PtyRequest): Pty;


	stat(path: string): Promise<FileKind>;
	readTextFile(path: string, maxBytes: number): Promise<string>;
	writeTextFile(path: string, text: string, mode: number): Promise<void>;
	readdir(path: string): Promise<readonly DirEntry[]>;
	removeTree(path: string): Promise<void>;
	makeDirectory(path: string): Promise<void>;
	realpath(path: string): Promise<string>;

	/** The honest replacement for `fs.watch`. */
	watchGitDirectory(worktree: string, onChange: () => void): Promise<Watcher>;

	/**
	 * The `devhub-terminal` a workbench on this machine runs, installed if need
	 * be. Idempotent: one install per machine per DevHub start.
	 */
	terminalLauncher(spec: TerminalLauncherSpec): Promise<TerminalLauncher>;

	readonly cadence: RuntimeCadence;
	reading(): RuntimeReading;
}

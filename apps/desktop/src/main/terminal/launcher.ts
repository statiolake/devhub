/**
 * The executable VS Code spawns for a DevHub terminal.
 *
 * DevHub's terminals live in a tmux server DevHub owns, and the argv that
 * attaches to one is DevHub's to compute — the session name, the socket and
 * the marker protocol belong to the terminal runtime and must not be spelled
 * anywhere else. So the integrated terminal does not run a shell: it runs this
 * launcher, which asks DevHub over the control socket (the `terminal-profile`
 * request) and `exec`s the answer.
 *
 * `exec` is the whole of how a tmux client's lifetime is tied to its terminal.
 * VS Code hangs up the pty when the terminal goes away, and a hangup reaches
 * the process the pty is holding — so that process must be tmux itself. The
 * asking runs as a child that has already exited by then (see
 * `devhubTerminal.ts`), leaving nothing between the pty and the client. Anything
 * left in between would make "the client dies with its terminal" depend on that
 * process passing a signal along, and a client that survives its terminal is one
 * nobody can see, close, or count.
 *
 * Why a file on disk rather than an extension-contributed profile. A
 * contributed profile is only a profile once the extension host has registered
 * the manifest *and* `TerminalProfileService` has refreshed its contributed
 * list — a throttled refresh that does a pty-host round trip first. A terminal
 * created on window load (the panel is visible, there are no persistent
 * sessions to restore, so `TerminalViewPane` creates one immediately) happens
 * before all of that and silently gets the OS shell: a plain zsh outside tmux.
 * A profile whose `path` is a real executable has no such window: it is a path
 * VS Code can spawn the moment it is asked.
 *
 * Why the script is *generated* on every startup, like the `devhub` CLI's
 * launcher in `../cli/install.ts`: it records the two absolute facts a launcher
 * cannot discover on its own — which binary runs it as Node (the app's own
 * Electron, since a system Node is exactly the thing in doubt) and which
 * control socket this DevHub is listening on. Regenerating means a moved or
 * updated app is never running yesterday's paths, and a second DevHub on
 * another profile never talks to the first one's socket.
 *
 * The socket is written *into* the script rather than read from the
 * environment because `DEVHUB_*` is a family a terminal is not supposed to
 * inherit — see `../shell/loginEnvironment.ts`. The machine the launcher was
 * written for is in there for the same reason, and for one more: a launcher on
 * another machine is another launcher, and a directory without a machine names
 * a different folder on every one of them.
 *
 * There is one of these per machine, not one per DevHub. A workbench's terminal
 * runs where its pty host runs, so an ssh window's launcher is a file on the
 * host, written there by `Runtime.terminalLauncher` from this same text with
 * that host's paths in it — the REH's `node`, its copy of the asking program,
 * and DevHub's control socket reverse-forwarded onto it. See
 * `docs/remote-ssh.md`.
 *
 * Who names this file to VS Code is the other half, and it is not a setting.
 * It was one — `terminal.integrated.profiles.osx` and the default that named
 * it, written into `User/settings.json` — and a settings file is the person's:
 * a dotfiles tool rewrote it wholesale, the keys went with it, and the next
 * reload was a plain zsh again. So the path goes into DevHub's own environment
 * as `DEVHUB_TERMINAL` (`exportTerminalLauncher`), and the patched
 * `TerminalProfileService` reads it and *is* the default, reading no terminal
 * setting at all. See `patches/vscode/0003-devhub-terminal-is-the-terminal.
 * patch`; `terminal.integrated.enablePersistentSessions` is forced off in the
 * same patch and for the same reason — a tmux session outlives the window
 * already, so a restored tab is a second, empty client for a session that is
 * still running.
 *
 * Only the tasks and automation shells are left alone: they ask for a shell to
 * run one command in and throw away, which is `terminal.integrated.
 * automationProfile.osx` and is nothing this launcher answers.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import type { RuntimeId } from "../runtime/runtime.js";
import { shellQuote, shellQuoteArgv } from "../runtime/quote.js";

/** The launcher's file name, next to the control socket it talks to. */
export const TERMINAL_LAUNCHER_NAME = "devhub-terminal";

/**
 * The name of the variable the launcher tells the asking program which machine
 * it is on with.
 *
 * The same reason the socket is written into the script rather than read from
 * the environment: it is a fact about *this* launcher, and a launcher on
 * another machine is another launcher. See `enclosingRoot` for what the answer
 * turns on — two machines with the same `/srv/app` are one root to a matcher
 * that is not told which machine is asking.
 */
export const DEVHUB_TERMINAL_MACHINE = "DEVHUB_TERMINAL_MACHINE";

export interface TerminalLauncherRequest {
	/** The binary the launcher execs — the app's own Electron, or a REH's node. */
	readonly execPath: string;
	/** The compiled entry point that binary runs as Node. */
	readonly entryScript: string;
	/** The control socket of the DevHub this launcher belongs to. */
	readonly socketPath: string;
	/** The machine this launcher is written for: `local`, or `ssh:<host>`. */
	readonly machine: RuntimeId;
}

export function terminalLauncherScript(
	request: TerminalLauncherRequest,
): string {
	return [
		"#!/bin/sh",
		"# Generated by DevHub on startup — do not edit, and do not copy.",
		"#",
		"# The three paths below name one running DevHub. They are rewritten every",
		"# time it starts, which is why moving or updating the app needs nothing",
		"# done to this file, and why a copy of it is a launcher for a DevHub that",
		"# may no longer be there.",
		"#",
		"# Ask DevHub for the argv, then *become* it. The asking is a child, so",
		"# that Node exits before tmux starts, and what VS Code's pty holds is the",
		"# tmux client itself — the process a hangup has to reach. A tmux client",
		"# that ran as a grandchild would outlive the pty whenever the process in",
		"# between failed to pass the hangup on, and a client that outlives the",
		"# terminal showing it is a client nobody can see or close.",
		// The binary is named absolutely and is not on any PATH, so a missing
		// one is `exec: not found` from `/bin/sh` — a sentence about a shell,
		// about a path nobody typed. On a remote machine it is the likeliest
		// failure of the three (the REH is installed by the connection, and a
		// launcher can be written before one has been), so it says which file.
		`if [ ! -x ${shellQuote(request.execPath)} ]; then`,
		`\techo ${shellQuote(`devhub-terminal: ${request.execPath} is not there to run, so this window has no terminal session to attach to.`)} >&2`,
		"\texit 1",
		"fi",
		`devhub_argv=$(DEVHUB_CONTROL_SOCKET=${shellQuote(request.socketPath)} \\`,
		`${DEVHUB_TERMINAL_MACHINE}=${shellQuote(request.machine)} \\`,
		"ELECTRON_RUN_AS_NODE=1 \\",
		`${shellQuote(request.execPath)} ${shellQuote(request.entryScript)} "$@") || exit $?`,
		"# An empty answer with a zero status is not an answer. Without this the",
		"# `exec` below would have no arguments, and a shell that execs nothing",
		"# carries on reading its input — which is a bare shell on the pty, the",
		"# one outcome this launcher exists to make impossible.",
		'if [ -z "$devhub_argv" ]; then',
		'\techo "devhub-terminal: DevHub answered without a command line." >&2',
		"\texit 1",
		"fi",
		'eval "exec $devhub_argv"',
		"",
	].join("\n");
}

/**
 * One shell word per argument, for the launcher to `exec`.
 *
 * The quoting is the launcher's own — `shellQuote` is what wrote the paths
 * into the script above — so the argv crosses the one gap between DevHub and
 * `/bin/sh` in the language the receiving side actually parses. Nothing here
 * ever sees a word split on a space in a path.
 */
export function terminalCommandLine(command: {
	readonly file: string;
	readonly args: readonly string[];
}): string {
	return shellQuoteArgv([command.file, ...command.args]);
}

/**
 * Write the launcher and return its path, for the profile that names it.
 *
 * Nothing is caught: a DevHub that cannot write its own launcher has no
 * terminals, and starting anyway would leave every terminal falling back to
 * whatever VS Code picks — which is the silent failure this file exists to end.
 */
export function installTerminalLauncher(
	launcherPath: string,
	request: TerminalLauncherRequest,
): string {
	mkdirSync(dirname(launcherPath), { recursive: true });
	writeFileSync(launcherPath, terminalLauncherScript(request), { mode: 0o755 });
	return launcherPath;
}

/** Where the launcher lives, given the user-data directory. */
export function terminalLauncherPath(userDataPath: string): string {
	return join(userDataPath, "devhub", TERMINAL_LAUNCHER_NAME);
}

/**
 * The directory DevHub owns on a machine that is not the one it runs on.
 *
 * Under `dataFolderName` because that is already DevHub's on any machine, and
 * in a subdirectory of it because the rest of that folder belongs to VS Code's
 * own remote CLI and extensions and is rewritten by them.
 */
export const REMOTE_DEVHUB_DIRECTORY = ".devhub/terminal";

/** Where the asking program's files go on such a machine. */
export const REMOTE_ENTRY_DIRECTORY = "js";

/**
 * The compiled entry point and every compiled file it imports, as text.
 *
 * There is no bundler in this build, so the program that asks DevHub for an
 * argv is several `.js` files with relative imports between them, and a machine
 * that is to run it needs all of them. Listing them by hand is the version of
 * this that rots: the list would still be four names on the day somebody adds a
 * fifth import, and the failure would be a terminal on one machine and not the
 * other. So the closure is *read*, from the same compiled output DevHub is
 * itself running, by following the relative specifiers.
 *
 * Only relative specifiers are followed. `node:*` is on every machine that has
 * a Node at all, and a bare specifier would be a dependency this program does
 * not have — one appearing here is a failure, not a file to copy, because
 * `node_modules` is not something DevHub is going to ship over ssh.
 *
 * Keys are relative to `root`, with `/` separators, so the same map describes
 * the same tree on a machine whose paths are spelled differently.
 */
export function terminalEntryClosure(
	root: string,
	entryPath: string,
): ReadonlyMap<string, string> {
	const files = new Map<string, string>();
	const pending = [entryPath];
	while (pending.length > 0) {
		const path = pending.pop();
		if (path === undefined) continue;
		const name = relative(root, path).split(/[\\/]/u).join("/");
		if (files.has(name)) continue;
		const text = readFileSync(path, "utf8");
		files.set(name, text);
		for (const specifier of importSpecifiers(text)) {
			if (specifier.startsWith("node:")) continue;
			if (!specifier.startsWith(".")) {
				throw new Error(
					`${path} imports ${specifier}, which is not a file DevHub can ship: the terminal launcher's program must depend on nothing but Node and itself`,
				);
			}
			pending.push(join(dirname(path), specifier));
		}
	}
	return files;
}

/** Every `from "…"` in a compiled module, static and dynamic alike. */
function importSpecifiers(text: string): readonly string[] {
	const found: string[] = [];
	const pattern =
		/\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/gu;
	for (const match of text.matchAll(pattern)) {
		const specifier = match[1] ?? match[2];
		if (specifier !== undefined) found.push(specifier);
	}
	return found;
}

/**
 * What the far machine's copy of the program is filed under.
 *
 * Named after the socket rather than after the host, because what must not
 * collide is two DevHubs — two profiles on this Mac, reaching one host — and
 * the socket path is the one thing that already distinguishes them. A digest
 * and not the path itself: the path is this Mac's business and long, and the
 * far machine only needs it to be different.
 */
export function remoteProfileTag(controlSocketPath: string): string {
	return createHash("sha256")
		.update(controlSocketPath)
		.digest("hex")
		.slice(0, 12);
}

/** Every path DevHub writes on a machine it is not running on. */
export interface RemoteTerminalPaths {
	/** `~/.devhub` — the one directory DevHub owns there. */
	readonly directory: string;
	/** The launcher script a workbench's terminal profile names. */
	readonly launcher: string;
	/** The root of the asking program's files. */
	readonly entryRoot: string;
	/** The one of them to run. */
	readonly entry: string;
	/** Where DevHub's control socket is forwarded to. */
	readonly socket: string;
	/** The REH's bundled `node`, which is the Node that is certainly there. */
	readonly node: string;
}

/**
 * Where all of it goes on the far machine, from its `$HOME` and two facts.
 *
 * `~/.devhub-server/<bin>/<commit>/node` is the REH tarball's own layout
 * (`docs/remote-ssh.md`, `scripts/build_reh.py`) and the commit is the one this
 * DevHub states — the same directory the connection installed the server into,
 * so the Node that runs the asking program is the Node the workbench is already
 * running on. Anything else would be a second Node to be right about.
 */
export function remoteTerminalPaths(request: {
	readonly home: string;
	readonly serverDataFolderName: string;
	readonly serverCommit: string;
	readonly controlSocketPath: string;
	readonly entryName: string;
}): RemoteTerminalPaths {
	const directory = posix.join(request.home, REMOTE_DEVHUB_DIRECTORY);
	const entryRoot = posix.join(directory, REMOTE_ENTRY_DIRECTORY);
	const tag = remoteProfileTag(request.controlSocketPath);
	return {
		directory,
		launcher: posix.join(directory, `${TERMINAL_LAUNCHER_NAME}-${tag}`),
		entryRoot,
		entry: posix.join(entryRoot, request.entryName),
		socket: posix.join(directory, `control-${tag}.sock`),
		node: posix.join(
			request.home,
			request.serverDataFolderName,
			"bin",
			request.serverCommit,
			"node",
		),
	};
}

/**
 * The directory a terminal belongs to, from what the launcher was started in.
 *
 * The profile carries no arguments and nothing is resolved into it. VS Code
 * spawns the terminal in the cwd it computed for it — the workspace folder when
 * the window has one, the user's home when it does not
 * (`terminalEnvironment.ts#getCwd`) — so the launcher simply asks where it is,
 * and DevHub answers which of its sessions that directory is in.
 *
 * A cwd is always absolute; anything that is not is a runtime that could not
 * say where it was, and `null` — the Scratch context — is the honest answer to
 * that rather than a guess.
 */
export function terminalRoot(directory: string | undefined): string | null {
	if (directory === undefined || !directory.startsWith("/")) return null;
	return directory;
}

/**
 * Which of these workspace roots contains `directory`, if any.
 *
 * One rule, and the same one for every window: a terminal belongs to the
 * workspace its directory is in, and to Scratch when no workspace contains it.
 * The folderless window is not a case of its own — VS Code starts its terminal
 * in the user's home, no workspace is rooted there, and Scratch is what falls
 * out of the rule.
 *
 * The longest match wins, so a workspace nested inside another one gets its own
 * terminals rather than its parent's. Matching is on whole path segments: a
 * root of `/work/app` does not contain `/work/app-old`.
 */
export function enclosingRoot(
	roots: readonly string[],
	directory: string | null,
): string | null {
	if (directory === null) return null;
	let best: string | null = null;
	for (const root of roots) {
		if (directory !== root && !directory.startsWith(`${root}/`)) continue;
		if (best === null || root.length > best.length) best = root;
	}
	return best;
}

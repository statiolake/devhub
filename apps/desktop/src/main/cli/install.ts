/**
 * Putting `devhub` on the PATH.
 *
 * VS Code installs `code` by dropping a small shell script into a directory
 * that is already on the PATH; this does the same thing for the same reason.
 * The script is *generated* rather than symlinked because it is the one place
 * the absolute facts a CLI cannot discover on its own are recorded: which
 * `devhub` binary is this app's (`out/cli/<os>-<arch>/devhub`, built from
 * `cli/` by the app build — `docs/devhub-cli.md`), which socket the app it
 * belongs to is listening on, and how to start that app when nothing is
 * listening there. A symlink would make the CLI guess the last two, and a
 * guess that is usually right is the worst kind.
 *
 * It is run as DevHub's own palette command, "DevHub: Install 'devhub'
 * command in PATH" (`install_cli`, `Cmd+Q :`), which `AppController` answers
 * by calling `installLauncher` — DevHub's and not a workbench's, because the
 * launcher belongs to DevHub and a Workspace whose editor is Neovim has no
 * workbench to run a command in.
 *
 * Consequence, and it is stated in the script itself: moving or reinstalling
 * DevHub invalidates the launcher, and the command has to be run again.
 *
 * `sudo` is never used, and never offered. If `/usr/local/bin` is not writable
 * the launcher goes to `~/.local/bin` and the person is told, in the same
 * sentence, what to add to their PATH if it is not there already. Silently
 * escalating to root to write a file into a system directory is not something
 * a menu command gets to do.
 */

import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	writeFileSync,
} from "node:fs";
import { delimiter, join, resolve as resolvePath } from "node:path";
import { shellQuote } from "../runtime/quote.js";

/**
 * The launcher script's record of how to start the DevHub it belongs to,
 * which the `devhub` command runs when nothing answers on the socket.
 */
export const LAUNCH_COMMAND_ENVIRONMENT_VARIABLE = "DEVHUB_LAUNCH_COMMAND";

/**
 * What writes the launcher, as every sentence that sends a person to it says
 * it: DevHub's own palette command (`install_cli` in `model/commands.ts`), on
 * `Cmd+Q :` whichever editor a Workspace has. The Go command says the same
 * words (`cli/launch.go`).
 */
export const INSTALL_COMMAND_HINT =
	"\"DevHub: Install 'devhub' command in PATH\" from DevHub's command palette (Cmd+Q :)";

/**
 * How this DevHub is started when the `devhub` command finds it is not
 * running. Recorded by the app that installs the launcher, because the app is
 * the only thing that knows how it was itself started:
 *
 *   - a DevHub run from a checkout: `apps/desktop/scripts/dev.sh`, which is
 *     how such a DevHub is started and the only way it can be; the profile
 *     rides along in the environment, which is where `dev.sh` reads it from;
 *   - a packaged DevHub: `open -a <the .app that is running> --background`.
 *     The path rather than the bundle identifier, because a DevHub never
 *     launched from the Finder is not known to Launch Services and `open -b`
 *     would call it not installed; `--background` because the request that
 *     follows decides whether DevHub comes forward.
 *
 * Told apart by what is on disk: `dev.sh` is there or it is not.
 */
export function launchCommandFor(
	appRoot: string,
	exists: (path: string) => boolean = existsSync,
): readonly string[] {
	const devScript = join(appRoot, "scripts", "dev.sh");
	if (exists(devScript)) return [devScript];
	const bundle = resolvePath(appRoot, "..", "..", "..");
	return ["/usr/bin/open", "-a", bundle, "--background"];
}

/**
 * The `devhub` binary the app build left for one platform, `<os>-<arch>` as
 * DevHub names one (`darwin-arm64`, `linux-x64`, `linux-arm64`): the key of
 * every per-platform pin in `product.json` too. This machine's by default.
 */
export function cliBinaryPath(
	appRoot: string,
	platform = `${process.platform}-${process.arch}`,
): string {
	return join(appRoot, "out", "cli", platform, "devhub");
}

export interface InstallRequest {
	/** The `devhub` binary the launcher execs: this app's, for this machine. */
	readonly cliBinary: string;
	/** The control socket of the app doing the installing. */
	readonly socketPath: string;
	/**
	 * What the launcher is called, and which DevHub it belongs to.
	 *
	 * A profile installs its own command — `devhub` for the default one,
	 * `devhub-dev` for a development profile — so a second DevHub does not
	 * quietly take the first one's name in the PATH. The profile travels in the
	 * script as well, because everything the CLI spawns — `dev.sh` above all —
	 * has to land on the same DevHub the socket belongs to.
	 */
	readonly commandName: string;
	readonly profile: string;
	/**
	 * How to start this DevHub when nothing is listening on the socket.
	 *
	 * Recorded rather than worked out by the CLI, because only the running app
	 * knows how it was itself started — from a bundle the Finder can open, or
	 * from a checkout by a script. See `launchCommandFor` in `launch.ts`.
	 */
	readonly launchCommand: readonly string[];
	readonly home: string;
	/** The PATH the installing process sees, for the "add this" advice. */
	readonly pathValue: string;
	/** Overridden by the tests; production uses the two real candidates. */
	readonly candidates?: readonly string[];
}

export interface InstallResult {
	readonly launcherPath: string;
	readonly message: string;
}

/** In order of preference: the shared one first, then the per-user one. */
export function defaultCandidates(home: string): readonly string[] {
	return ["/usr/local/bin", join(home, ".local", "bin")];
}

/**
 * Quote a path for a POSIX shell, whatever is in it.
 *
 * Re-exported rather than written twice: the rule now belongs to the runtime
 * module, because a runtime that runs commands on another machine has to
 * compose a shell command line and there must not be a second answer to how.
 */
export { shellQuote };

export function launcherScript(request: InstallRequest): string {
	return [
		"#!/bin/sh",
		"# Generated by DevHub — do not edit.",
		"#",
		`# Run ${INSTALL_COMMAND_HINT}`,
		"# again after moving or reinstalling DevHub: the paths below are",
		"# absolute, and name the 'devhub' binary inside this DevHub.",
		`DEVHUB_CONTROL_SOCKET=${shellQuote(request.socketPath)} \\`,
		`DEVHUB_PROFILE=${shellQuote(request.profile)} \\`,
		`${LAUNCH_COMMAND_ENVIRONMENT_VARIABLE}=${shellQuote(
			JSON.stringify(request.launchCommand),
		)} \\`,
		`exec ${shellQuote(request.cliBinary)} "$@"`,
		"",
	].join("\n");
}

function isWritableDirectory(path: string): boolean {
	try {
		accessSync(path, constants.W_OK | constants.X_OK);
		return true;
	} catch {
		// Not a fallback that hides a failure: this is the question being
		// asked. An unwritable /usr/local/bin is the ordinary case on a Mac
		// with no Homebrew, and the answer is the next candidate.
		return false;
	}
}

function onPath(directory: string, pathValue: string): boolean {
	return pathValue.split(delimiter).includes(directory);
}

/**
 * Write the launcher into the first candidate directory that will take it.
 *
 * Throws if none will. A command that reported success while having installed
 * nothing is exactly the silent lie this codebase does not permit.
 */
export function installLauncher(request: InstallRequest): InstallResult {
	const candidates = request.candidates ?? defaultCandidates(request.home);
	const refused: string[] = [];
	for (const directory of candidates) {
		if (!isWritableDirectory(directory)) {
			// The per-user directory is ours to create; a system one is not.
			if (directory.startsWith(`${request.home}/`)) {
				mkdirSync(directory, { recursive: true, mode: 0o755 });
			} else {
				refused.push(directory);
				continue;
			}
		}
		const launcherPath = join(directory, request.commandName);
		writeFileSync(launcherPath, launcherScript(request), { mode: 0o755 });
		return {
			launcherPath,
			message: installMessage(directory, launcherPath, refused, request),
		};
	}
	throw new Error(
		`none of these directories would take the launcher: ${candidates.join(", ")}`,
	);
}

function installMessage(
	directory: string,
	launcherPath: string,
	refused: readonly string[],
	request: InstallRequest,
): string {
	const parts = [
		`Installed the '${request.commandName}' command at ${launcherPath}.`,
	];
	if (refused.length > 0) {
		parts.push(
			`${refused.join(" and ")} ${refused.length === 1 ? "is" : "are"} not writable, so it was not used — DevHub does not use sudo.`,
		);
	}
	if (!onPath(directory, request.pathValue)) {
		parts.push(
			`${directory} is not on your PATH. Add it, for example with: export PATH="${directory}:$PATH"`,
		);
	}
	return parts.join(" ");
}

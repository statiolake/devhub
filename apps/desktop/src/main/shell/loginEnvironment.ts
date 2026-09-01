/**
 * The user's login-shell environment, resolved once at startup.
 *
 * A DevHub launched from Finder, the Dock or `open` is a child of `launchd`,
 * and `launchd` hands it a PATH of `/usr/bin:/bin:/usr/sbin:/sbin` and nothing
 * else. Everything a developer actually installed — Homebrew's `/opt/homebrew/
 * bin`, a version manager's shims, `~/.local/bin` — lives only in the
 * environment their login shell builds, and the app never sees it. A run
 * started from a terminal inherits that environment for free, which is exactly
 * why the gap is invisible in development and total in a packaged build.
 *
 * So DevHub asks the login shell what its environment is, the way VS Code does
 * (`vscode/src/vs/platform/shell/node/shellEnv.ts`): spawn the shell as a login
 * shell running one command, have that command print `process.env` as JSON
 * between a random marker, and parse what comes back. Electron's own binary is
 * the printer — `ELECTRON_RUN_AS_NODE=1` makes it a Node — so there is no
 * dependency on a `node` being installed, which is the very thing in doubt.
 *
 * Two deliberate differences from upstream:
 *
 *  - VS Code skips the import when it was launched from its CLI. DevHub does
 *    not. Whether to import is the user's setting (`import_login_environment`),
 *    and one rule that does not change with how the app was started is the only
 *    way a developer run reproduces what a packaged run does.
 *  - A failure is a *value*, not a silent empty result. "Your terminals have no
 *    Homebrew on PATH because your shell profile errors out" is a sentence
 *    somebody must be able to read; see `LoginEnvironment`.
 *
 * The answer lands in `process.env` (`adoptLoginEnvironment`) rather than in a
 * value passed around. DevHub spawns some of its children itself — terminals,
 * Agents, `git` — but most of them are VS Code's: the workbench windows, the
 * extension host, the pty host, the shared process. Those descend from
 * `process.env` and nothing DevHub hands out reaches them, which is how a
 * Finder launch came to run the git extension's `gpg` on launchd's four-entry
 * PATH while a DevHub terminal beside it had the user's whole toolchain. One
 * import, into the one environment they all descend from, is what makes the
 * two agree. Upstream's own resolution is turned off for the same reason —
 * see `--force-disable-user-env` in `codeMain.ts`.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";

/** How long the login shell gets before DevHub stops waiting for it. */
export const LOGIN_ENVIRONMENT_TIMEOUT_MS = 10_000;

/**
 * What became of the import, kept so it can be shown rather than guessed at.
 *
 * `failed` is the case that matters: DevHub carries on with the environment it
 * was started with, which is a working app with a crippled PATH, and the only
 * thing standing between that and an unexplainable bug report is that this
 * state is recorded and displayed.
 */
export type LoginEnvironment =
	| {
			readonly kind: "imported";
			/** The login shell that produced it, for the status line. */
			readonly shell: string;
			readonly variables: Readonly<Record<string, string>>;
	  }
	| { readonly kind: "disabled" }
	/** Windows has no login shell to ask; the process environment is the truth. */
	| { readonly kind: "unsupported" }
	| {
			readonly kind: "failed";
			readonly shell: string;
			readonly reason: string;
	  };

export interface LoginEnvironmentOptions {
	/** The `[general] import_login_environment` setting. */
	readonly enabled: boolean;
	/** Overridden only by tests. */
	readonly processEnvironment?: Readonly<Record<string, string | undefined>>;
	readonly platform?: NodeJS.Platform;
	readonly execPath?: string;
	readonly timeoutMs?: number;
}

/**
 * The variables that describe *DevHub's own process*, never the user's session.
 *
 * DevHub is a VS Code build running inside VS Code's Electron, and it is
 * started by a script that tells that build what it is: `VSCODE_DEV=1`,
 * `VSCODE_CLI=1`, `NODE_ENV=development`, `ELECTRON_ENABLE_LOGGING=1`. Electron
 * and Chromium add more of their own (`ELECTRON_RUN_AS_NODE` on a child that
 * was a Node printer, `CHROME_DESKTOP`), and DevHub itself exports `DEVHUB_*`
 * to reach its own helpers.
 *
 * Every one of those is a *true statement about this process* and a *false
 * statement about the shell the user is about to type into*. A `.zshrc` that
 * sees `VSCODE_DEV` reasonably concludes it is running inside VS Code's
 * integrated terminal and behaves accordingly — invoking the real `code` CLI,
 * changing its prompt, skipping its own setup. The user's shell is not wrong to
 * believe what the environment tells it; the environment is wrong.
 *
 * So they are removed by prefix rather than by name. A list of names is a list
 * of the variables that happened to break something once, and the next
 * `VSCODE_`-something to appear would have to break something again before
 * anybody added it. The families are the rule, stated once:
 *
 *  - `VSCODE_*` — the editor build's own bootstrap and IPC hooks.
 *  - `ELECTRON_*` — the runtime's, including `ELECTRON_RUN_AS_NODE`, which
 *    would make every shell DevHub starts believe it is a Node process.
 *  - `CHROME_*` — Chromium's, which Electron sets on the app's behalf.
 *  - `DEVHUB_*` — DevHub's own, the control socket among them.
 *  - `NODE_ENV` — `development` is a fact about this build, not about the
 *    user's tools, several of which change behaviour on it.
 *
 * The packaged app sets fewer of these than `dev.sh` does. That is not a
 * separate case: the rule removes whatever is present, so a packaged run and a
 * source run hand a terminal the same environment, which is the only way a
 * developer run reproduces what a user gets.
 */
const DEVHUB_RUNTIME_PREFIXES = [
	"VSCODE_",
	"ELECTRON_",
	"CHROME_",
	"DEVHUB_",
] as const;

const DEVHUB_RUNTIME_NAMES = new Set(["NODE_ENV"]);

function isDevHubRuntimeVariable(name: string): boolean {
	return (
		DEVHUB_RUNTIME_NAMES.has(name) ||
		DEVHUB_RUNTIME_PREFIXES.some((prefix) => name.startsWith(prefix))
	);
}

/**
 * The process environment with DevHub's own runtime taken out of it.
 *
 * Asking the shell and launching a child both go through here, and they must:
 * the login shell is a *child of DevHub*, so asking it for its environment from
 * DevHub's own environment gets DevHub's own environment back. A profile does not delete
 * `VSCODE_DEV`; it inherits it, reacts to it, and prints it out again — which
 * is how a strip applied only to the merge came to be undone by the merge's
 * other half, with the user's `.zshrc` running the real VS Code CLI in the
 * middle of DevHub's startup to prove it.
 *
 * Asked from a clean environment, the shell answers the question that was
 * actually meant: what does this user's login shell build? Whatever comes back
 * is then genuinely theirs, including a `VSCODE_`-something they set on
 * purpose, and needs no second rule to protect it.
 */
export function withoutDevHubRuntime(
	environment: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
	const clean: Record<string, string | undefined> = {};
	for (const [name, value] of Object.entries(environment)) {
		if (isDevHubRuntimeVariable(name)) continue;
		clean[name] = value;
	}
	return clean;
}

/**
 * Put the login shell's environment into DevHub's own process.
 *
 * This is the import, and it happens once: `process.env` is what every process
 * DevHub does not spawn itself descends from, so writing it here is what gets
 * the user's PATH to the extension host and to the `git` an extension runs.
 * Everything else in this file reads the result rather than the login value —
 * `launchEnvironment` included.
 *
 * DevHub's own runtime layer is never written over. `VSCODE_IPC_HOOK`,
 * `VSCODE_PORTABLE`, `NODE_ENV` and their families are true statements about
 * *this running process*, and a profile that exports one of them is describing
 * some other VS Code; letting the import win there would move the user-data
 * directory or flip a source build into production halfway through startup.
 * That is the same rule `launchEnvironment` applies from the other side, and
 * the only one either of them has: the families in `DEVHUB_RUNTIME_PREFIXES`
 * belong to DevHub's runtime and to nothing else — in this process they stay
 * as they are, in a child they go.
 */
export function adoptLoginEnvironment(
	target: Record<string, string | undefined>,
	login: LoginEnvironment,
): void {
	if (login.kind !== "imported") return;
	for (const [name, value] of Object.entries(login.variables)) {
		if (isDevHubRuntimeVariable(name)) continue;
		target[name] = value;
	}
}

/**
 * The environment the children DevHub spawns itself are launched with.
 *
 * The login shell's values are not laid over anything here: they are already
 * *in* the process environment, put there by `adoptLoginEnvironment`, which is
 * the whole point of importing into the process rather than into a value only
 * some callers hold. A terminal, an Agent and the extension host read one
 * environment, so what DevHub can find and what a shell inside it can find
 * cannot disagree.
 *
 * What is left to do is the one thing a child must not inherit: the variables
 * that describe DevHub's own process. A `.zshrc` that sees `VSCODE_DEV`
 * reasonably concludes it is running inside VS Code's integrated terminal and
 * behaves accordingly. A variable only the launch context has — the user-data
 * dir, `XDG_CONFIG_HOME` — survives, because the rule is about the families,
 * not about where a value came from.
 */
export function launchEnvironment(
	processEnvironment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
	return Object.freeze(withoutDevHubRuntime(processEnvironment));
}

/**
 * What became of the import, in a sentence.
 *
 * Shown as the status line under the Settings option, and — when the import
 * failed — folded into the message a runtime lookup fails with, because a
 * short PATH and an import that did not happen are the same fact twice. So it
 * has to read in both places, which is why it names the consequence rather
 * than the setting.
 */
export function loginEnvironmentSummary(login: LoginEnvironment): string {
	switch (login.kind) {
		case "imported":
			return `Imported from ${login.shell}.`;
		case "disabled":
			return "Not imported. Everything DevHub runs, including the editor and its extensions, uses the environment DevHub was started with.";
		case "unsupported":
			return "Not imported: this platform has no login shell to read.";
		case "failed":
			return `DevHub could not read the environment from ${login.shell}: ${login.reason} Everything DevHub runs, including the editor and its extensions, falls back to the environment DevHub was started with, which may not have your tools on PATH.`;
	}
}

/**
 * The login shell to ask. `SHELL` is what the user's account is configured
 * with; there is no second guess, because a wrong guess would import somebody
 * else's environment and be worse than importing none.
 */
function loginShell(
	environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
	const shell = environment["SHELL"];
	return shell !== undefined && shell.length > 0 ? shell : undefined;
}

/**
 * The command line that prints the environment, per shell family. Taken from
 * VS Code's `doResolveUnixShellEnv`, which is where the non-POSIX cases were
 * learned the hard way.
 */
function printerCommand(
	shell: string,
	execPath: string,
	mark: string,
): { readonly command: string; readonly args: readonly string[] } {
	const name = basename(shell);
	if (/^(?:pwsh|powershell)(?:-preview)?$/.test(name)) {
		return {
			command: `& '${execPath}' -p '''${mark}'' + JSON.stringify(process.env) + ''${mark}'''`,
			args: ["-Login", "-Command"],
		};
	}
	if (name === "nu") {
		return {
			command: `^'${execPath}' -p '"${mark}" + JSON.stringify(process.env) + "${mark}"'`,
			args: ["-i", "-l", "-c"],
		};
	}
	if (name === "xonsh") {
		return {
			command: `import os, json; print("${mark}", json.dumps(dict(os.environ)), "${mark}")`,
			args: ["-i", "-l", "-c"],
		};
	}
	return {
		command: `'${execPath}' -p '"${mark}" + JSON.stringify(process.env) + "${mark}"'`,
		// csh and tcsh have no `-l -c`; `-ic` is the whole of what they accept.
		args: name === "tcsh" || name === "csh" ? ["-ic"] : ["-i", "-l", "-c"],
	};
}

export async function resolveLoginEnvironment(
	options: LoginEnvironmentOptions,
): Promise<LoginEnvironment> {
	const processEnvironment = options.processEnvironment ?? process.env;
	const platform = options.platform ?? process.platform;
	if (!options.enabled) return { kind: "disabled" };
	if (platform === "win32") return { kind: "unsupported" };
	const shell = loginShell(processEnvironment);
	if (shell === undefined) {
		return {
			kind: "failed",
			shell: "your login shell",
			reason: "SHELL is not set in the environment DevHub was started with.",
		};
	}
	return await readShellEnvironment(
		shell,
		options.execPath ?? process.execPath,
		options.timeoutMs ?? LOGIN_ENVIRONMENT_TIMEOUT_MS,
		processEnvironment,
	);
}

function readShellEnvironment(
	shell: string,
	execPath: string,
	timeoutMs: number,
	processEnvironment: Readonly<Record<string, string | undefined>>,
): Promise<LoginEnvironment> {
	const mark = randomUUID().replaceAll("-", "").slice(0, 12);
	const { command, args } = printerCommand(shell, execPath, mark);
	// Clean first, then the three the printer itself needs. `variablesOf` drops
	// those three again on the way back, so the shell is asked from — and
	// answers about — an environment with nothing of DevHub's in it.
	const environment = {
		...withoutDevHubRuntime(processEnvironment),
		ELECTRON_RUN_AS_NODE: "1",
		ELECTRON_NO_ATTACH_CONSOLE: "1",
		DEVHUB_RESOLVING_ENVIRONMENT: "1",
	};
	return new Promise<LoginEnvironment>((resolve) => {
		const failed = (reason: string): void => {
			resolve({ kind: "failed", shell, reason });
		};
		let child;
		try {
			child = spawn(shell, [...args, command], {
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: environment,
			});
		} catch (error) {
			// The shell named by SHELL is not something this machine can run.
			// There is no second shell to try: see `loginShell`.
			failed(`${shell} could not be started (${errorText(error)}).`);
			return;
		}
		let settled = false;
		const finish = (value: LoginEnvironment): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => {
			child.kill();
			finish({
				kind: "failed",
				shell,
				reason: `it did not answer within ${Math.round(timeoutMs / 1000)} seconds. Check your shell profile for a prompt or a slow command.`,
			});
		}, timeoutMs);
		const chunks: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		// stderr is drained rather than read: a profile that prints warnings is
		// normal, and its text is the user's, not a diagnostic DevHub may keep.
		child.stderr.resume();
		child.on("error", (error) => {
			finish({
				kind: "failed",
				shell,
				reason: `${shell} could not be started (${errorText(error)}).`,
			});
		});
		child.on("close", (code, signal) => {
			if (code || signal) {
				finish({
					kind: "failed",
					shell,
					reason: `it exited with code ${String(code)}${signal === null ? "" : ` on ${signal}`}.`,
				});
				return;
			}
			const raw = Buffer.concat(chunks).toString("utf8");
			const match = new RegExp(`${mark}({.*})${mark}`, "s").exec(raw);
			if (match === null) {
				finish({
					kind: "failed",
					shell,
					reason:
						"it printed no environment. Check your shell profile for a command that exits or replaces the shell.",
				});
				return;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(match[1] ?? "");
			} catch (error) {
				finish({
					kind: "failed",
					shell,
					reason: `its environment could not be read (${errorText(error)}).`,
				});
				return;
			}
			finish({ kind: "imported", shell, variables: variablesOf(parsed) });
		});
	});
}

/**
 * The variables DevHub keeps. The three the printer itself set are dropped:
 * they describe how the environment was read, and passing them to a terminal
 * would make every shell DevHub starts believe it is a Node process.
 */
function variablesOf(parsed: unknown): Readonly<Record<string, string>> {
	const variables: Record<string, string> = {};
	if (typeof parsed !== "object" || parsed === null) return variables;
	for (const [name, value] of Object.entries(parsed)) {
		if (typeof value !== "string") continue;
		if (
			name === "ELECTRON_RUN_AS_NODE" ||
			name === "ELECTRON_NO_ATTACH_CONSOLE" ||
			name === "DEVHUB_RESOLVING_ENVIRONMENT"
		) {
			continue;
		}
		variables[name] = value;
	}
	return variables;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

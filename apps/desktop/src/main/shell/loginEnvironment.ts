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
 * The environment DevHub's children are launched with.
 *
 * The process environment first, the login shell's values over it: a variable
 * the user's profile sets is the one they meant, and a variable only the launch
 * context has (Electron's own, the user-data dir) survives because the shell
 * never mentions it.
 */
export function launchEnvironment(
	processEnvironment: Readonly<Record<string, string | undefined>>,
	login: LoginEnvironment,
): Readonly<Record<string, string | undefined>> {
	const merged: Record<string, string | undefined> = { ...processEnvironment };
	if (login.kind === "imported") {
		for (const [name, value] of Object.entries(login.variables)) {
			merged[name] = value;
		}
	}
	return Object.freeze(merged);
}

/** The status line the Settings window shows under the option. */
export function loginEnvironmentSummary(login: LoginEnvironment): string {
	switch (login.kind) {
		case "imported":
			return `Imported from ${login.shell}.`;
		case "disabled":
			return "Not imported. DevHub launches terminals and agents with the environment it was started with.";
		case "unsupported":
			return "Not imported: this platform has no login shell to read.";
		case "failed":
			return `DevHub could not read the environment from ${login.shell}: ${login.reason} Terminals and agents run with the environment DevHub was started with, which may not have your tools on PATH.`;
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
	const environment = {
		...processEnvironment,
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

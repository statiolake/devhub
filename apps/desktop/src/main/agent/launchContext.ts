/**
 * The startup-frozen launch environment this adapter spawns Herdr with.
 *
 * A narrow port of the Tauri app's `src-tauri/src/runtime/mod.rs`
 * (`RuntimeLaunchContext`, `ResolvedExecutable`) covering exactly what the
 * agent runtime uses: an immutable environment, executable resolution that
 * never trusts a relative path, and a shell-free child command. The full
 * runtime module — login-shell import, child-group cleanup, the other
 * adapters' probes — belongs to workstream A; when A lands it, this file is
 * deleted and its two callers import A's instead.
 *
 * The Herdr executable is always *resolved*, never hard-coded: an absolute or
 * `~`-prefixed configured path, otherwise a lookup through absolute PATH
 * entries only.
 */

import {
	spawn,
	type ChildProcess,
	type SpawnOptions,
} from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { runtimeUnavailableMessage } from "../../ipc/settings.js";

export enum RuntimeErrorCode {
	InvalidHome = "invalidHome",
	InvalidExecutable = "invalidExecutable",
	MissingPath = "missingPath",
	MissingExecutable = "missingExecutable",
	NotExecutable = "notExecutable",
	NotRegularFile = "notRegularFile",
}

export class RuntimeError extends Error {
	readonly code: RuntimeErrorCode;
	/**
	 * The sentence naming what was looked for and where, when the failure was a
	 * lookup. It is composed by `runtimeUnavailableMessage`, the same function
	 * the Settings window renders, so the two never word this differently.
	 */
	readonly detail: string | undefined;

	constructor(code: RuntimeErrorCode, detail?: string) {
		super(detail ?? code);
		this.name = "RuntimeError";
		this.code = code;
		this.detail = detail;
		this.stack = `RuntimeError: ${detail ?? code}`;
	}
}

export enum ResolutionMode {
	ExplicitPath = "explicitPath",
	PathLookup = "pathLookup",
}

/**
 * A validated executable selected by a `RuntimeLaunchContext`. The path is
 * private on purpose: callers use it only by asking the owning context for a
 * preconfigured command.
 */
export class ResolvedExecutable {
	readonly #path: string;
	readonly mode: ResolutionMode;

	constructor(path: string, mode: ResolutionMode) {
		this.#path = path;
		this.mode = mode;
	}

	get path(): string {
		return this.#path;
	}

	toString(): string {
		return "<redacted>";
	}
}

export class RuntimeLaunchContext {
	readonly #home: string;
	readonly #environment: ReadonlyMap<string, string>;

	private constructor(home: string, environment: ReadonlyMap<string, string>) {
		this.#home = home;
		this.#environment = environment;
	}

	static create(
		home: string,
		environment: Readonly<Record<string, string | undefined>>,
	): RuntimeLaunchContext {
		if (!isAbsolute(home) || !isDirectory(home)) {
			throw new RuntimeError(RuntimeErrorCode.InvalidHome);
		}
		const frozen = new Map<string, string>();
		for (const [key, value] of Object.entries(environment)) {
			if (value !== undefined && !key.includes("\0") && !value.includes("\0")) {
				frozen.set(key, value);
			}
		}
		return new RuntimeLaunchContext(home, frozen);
	}

	get home(): string {
		return this.#home;
	}

	environmentValue(name: string): string | undefined {
		return this.#environment.get(name);
	}

	/**
	 * Resolves an absolute path, a leading-`~` path, or a command name.
	 * Relative paths containing a separator are never interpreted relative to
	 * the current process. Command names are searched only in absolute PATH
	 * entries; empty and relative entries are ignored.
	 */
	resolve(configured: string): ResolvedExecutable {
		if (configured.length === 0 || configured.includes("\0")) {
			throw new RuntimeError(RuntimeErrorCode.InvalidExecutable);
		}
		if (configured === "~" || configured.startsWith("~/")) {
			return this.#explicit(configured, join(this.#home, configured.slice(1)));
		}
		if (configured.startsWith("/")) {
			return this.#explicit(configured, configured);
		}
		if (configured.includes("/")) {
			throw new RuntimeError(RuntimeErrorCode.InvalidExecutable);
		}
		const path = this.#environment.get("PATH");
		if (path === undefined) {
			throw new RuntimeError(
				RuntimeErrorCode.MissingPath,
				lookupMessage(configured, []),
			);
		}
		const directories = path
			.split(delimiter)
			.filter((entry) => entry.length > 0 && isAbsolute(entry));
		let sawNonExecutable = false;
		let sawNonRegular = false;
		for (const entry of directories) {
			try {
				return this.#inspect(
					join(entry, configured),
					ResolutionMode.PathLookup,
				);
			} catch (error) {
				const code = (error as RuntimeError).code;
				if (code === RuntimeErrorCode.NotExecutable) {
					sawNonExecutable = true;
				} else if (code === RuntimeErrorCode.NotRegularFile) {
					sawNonRegular = true;
				} else if (code !== RuntimeErrorCode.MissingExecutable) {
					throw error;
				}
			}
		}
		const message = lookupMessage(configured, directories);
		if (sawNonExecutable) {
			throw new RuntimeError(RuntimeErrorCode.NotExecutable, message);
		}
		if (sawNonRegular) {
			throw new RuntimeError(RuntimeErrorCode.NotRegularFile, message);
		}
		throw new RuntimeError(RuntimeErrorCode.MissingExecutable, message);
	}

	/**
	 * A configured path names its own single location, so its failure says so
	 * rather than listing a search that never happened.
	 */
	#explicit(configured: string, path: string): ResolvedExecutable {
		try {
			return this.#inspect(path, ResolutionMode.ExplicitPath);
		} catch (error) {
			throw new RuntimeError(
				(error as RuntimeError).code,
				runtimeUnavailableMessage({
					kind: "unavailable",
					configured,
					lookup: { kind: "explicit", path },
				}),
			);
		}
	}

	#inspect(path: string, mode: ResolutionMode): ResolvedExecutable {
		let stats;
		try {
			stats = statSync(path);
		} catch {
			throw new RuntimeError(RuntimeErrorCode.MissingExecutable);
		}
		if (!stats.isFile()) {
			throw new RuntimeError(RuntimeErrorCode.NotRegularFile);
		}
		try {
			accessSync(path, fsConstants.X_OK);
		} catch {
			throw new RuntimeError(RuntimeErrorCode.NotExecutable);
		}
		return new ResolvedExecutable(path, mode);
	}

	/**
	 * Spawns a direct, shell-free child with the launch environment applied.
	 * No configured value is ever interpolated into a command string.
	 */
	spawn(
		executable: ResolvedExecutable,
		args: readonly string[],
		options: SpawnOptions = {},
	): ChildProcess {
		return spawn(executable.path, [...args], {
			...options,
			cwd: this.#home,
			env: Object.fromEntries(this.#environment),
			shell: false,
			detached: process.platform !== "win32",
		});
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function lookupMessage(
	configured: string,
	directories: readonly string[],
): string | undefined {
	return runtimeUnavailableMessage({
		kind: "unavailable",
		configured,
		lookup: { kind: "path", directories },
	});
}

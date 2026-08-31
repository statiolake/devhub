/**
 * What the configured runtime names actually resolve to on this machine.
 *
 * The Settings window shows three columns for each runtime — configured,
 * resolved, effective — because they are three different facts and conflating
 * them is how "I set it and nothing happened" becomes unexplainable. This file
 * produces the middle one: it looks the configured value up the way a shell
 * would, and says `unavailable` when it is not there rather than assuming it is.
 */

import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { RuntimeConfig } from "../../model/config.js";
import type {
	SettingsResolvedRuntimeConfigWire,
	SettingsResolvedRuntimeWire,
	SettingsRuntimeHealthWire,
} from "../../ipc/settings.js";

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

async function isExecutableFile(path: string): Promise<boolean> {
	try {
		if (!(await stat(path)).isFile()) return false;
		await access(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function resolveOne(
	value: string,
	searchPath: string,
): Promise<SettingsResolvedRuntimeWire> {
	const expanded = expandHome(value);
	if (isAbsolute(expanded)) {
		return (await isExecutableFile(expanded))
			? { kind: "absolute_path", value: expanded }
			: {
					kind: "unavailable",
					configured: value,
					lookup: { kind: "explicit", path: expanded },
				};
	}
	// The directories are kept whether the lookup succeeds or not: on failure
	// they are the whole diagnostic, and a search nobody can see is a search
	// nobody can correct.
	const directories = searchPath
		.split(delimiter)
		.filter((directory) => directory.length > 0);
	for (const directory of directories) {
		const candidate = join(directory, expanded);
		if (await isExecutableFile(candidate)) {
			return { kind: "absolute_path", value: candidate };
		}
	}
	return {
		kind: "unavailable",
		configured: value,
		lookup: { kind: "path", directories },
	};
}

/**
 * Look every configured runtime up in `searchPath`.
 *
 * `searchPath` is not defaulted to `process.env.PATH`. A DevHub launched from
 * Finder has `launchd`'s four-entry PATH and nothing a developer installed, so
 * a default that quietly used it would make this resolution depend on how the
 * app happened to be started — the exact bug this signature exists to prevent.
 * The caller passes the PATH from the launch environment (see
 * `loginEnvironment.ts`), which is the same PATH the terminals and agents get.
 */
export async function resolveRuntimes(
	runtimes: RuntimeConfig,
	searchPath: string,
): Promise<SettingsResolvedRuntimeConfigWire> {
	const [shell, git, tmux, herdr] = await Promise.all([
		resolveOne(runtimes.shell, searchPath),
		resolveOne(runtimes.git, searchPath),
		resolveOne(runtimes.tmux, searchPath),
		resolveOne(runtimes.herdr, searchPath),
	]);
	return { shell, git, tmux, herdr };
}

export function runtimeHealth(
	resolved: SettingsResolvedRuntimeConfigWire,
): SettingsRuntimeHealthWire {
	const health = (value: SettingsResolvedRuntimeWire) =>
		value.kind === "unavailable"
			? ("unavailable" as const)
			: ("healthy" as const);
	return {
		shell: health(resolved.shell),
		git: health(resolved.git),
		tmux: health(resolved.tmux),
		herdr: health(resolved.herdr),
		inspectionAvailable: true,
	};
}

/**
 * Claude Code's defaults for new sessions, read and changed on the Agent's
 * machine (`model/claudeDefaults.ts` says what decides them).
 *
 * The settings files are the CLI's: the user's under its config directory
 * (`CLAUDE_CONFIG_DIR`, else `~/.claude`), the project's and the local ones
 * under the Workspace's root, and the managed file where Claude Code looks
 * for it on macOS and on Linux. A file that is not there, or that does not
 * parse, sets nothing — the CLI would not take a value from it either.
 *
 * A change is written to the user settings only, and atomically: the new
 * text goes to a file beside it under a name nobody else holds, which is then
 * renamed over it, so the CLI never reads half a file and a failed write
 * leaves the old one whole.
 */

import { randomUUID } from "node:crypto";
import {
	CLAUDE_SETTINGS_LAYERS,
	claudeDefaults,
	withUserDefault,
	type ClaudeSettingsLayer,
	type CliDefaults,
} from "../../../../model/claudeDefaults.js";
import { OperationDeadline } from "../../../terminal/command.js";
import { CancellationToken } from "../../../terminal/ports.js";
import { RuntimeFileError, type Runtime } from "../../../runtime/runtime.js";
import { claudeConfigDirectory, type SessionProfile } from "../resume.js";

/** Larger than any settings file a person writes by hand. */
const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;

/** Where Claude Code looks for managed settings: macOS's place, then Linux's. */
const MANAGED_SETTINGS = [
	"/Library/Application Support/ClaudeCode/managed-settings.json",
	"/etc/claude-code/managed-settings.json",
];

/** A file's text, or undefined when it is not there. */
async function textOf(
	runtime: Runtime,
	path: string,
): Promise<string | undefined> {
	try {
		return await runtime.readTextFile(path, MAX_SETTINGS_BYTES);
	} catch (failure: unknown) {
		if (
			failure instanceof RuntimeFileError &&
			(failure.code === "ENOENT" || failure.code === "ENOTDIR")
		)
			return undefined;
		throw failure;
	}
}

function parsed(text: string | undefined): unknown {
	if (text === undefined) return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

async function userSettingsPath(
	runtime: Runtime,
	profile: SessionProfile,
): Promise<string> {
	return `${await claudeConfigDirectory(runtime, profile)}/settings.json`;
}

/**
 * The defaults a new session of `profile` in `root` starts on; the effort
 * for `model` (its full name), when it is known.
 */
export async function readClaudeDefaults(
	runtime: Runtime,
	profile: SessionProfile,
	root: string,
	model: string | undefined,
): Promise<CliDefaults> {
	const paths: Readonly<Record<ClaudeSettingsLayer, readonly string[]>> = {
		managed: MANAGED_SETTINGS,
		local: [`${root}/.claude/settings.local.json`],
		project: [`${root}/.claude/settings.json`],
		user: [await userSettingsPath(runtime, profile)],
	};
	const settings: Partial<Record<ClaudeSettingsLayer, unknown>> = {};
	for (const layer of CLAUDE_SETTINGS_LAYERS) {
		for (const path of paths[layer]) {
			const value = parsed(await textOf(runtime, path));
			if (value !== undefined) {
				settings[layer] = value;
				break;
			}
		}
	}
	const env = {
		...(await runtime.environment()),
		...Object.fromEntries(profile.env),
	};
	return claudeDefaults({ settings, env, args: profile.args }, model);
}

/**
 * Make `value` the default `which` of new sessions of `profile`'s CLI, in
 * its user settings; an effort is saved for `model` when it is named.
 */
export async function writeClaudeDefault(
	runtime: Runtime,
	profile: SessionProfile,
	which: "model" | "effort",
	value: string,
	model: string | undefined,
): Promise<void> {
	const directory = await claudeConfigDirectory(runtime, profile);
	const path = `${directory}/settings.json`;
	const text = withUserDefault(
		await textOf(runtime, path),
		which,
		value,
		model,
	);
	await runtime.makeDirectory(directory);
	const temporary = `${path}.devhub-${randomUUID()}`;
	if (!(await runtime.writeNewTextFile(temporary, text, 0o600)))
		throw new Error(`${temporary} is taken${runtime.where}`);
	const moved = await runtime.exec({
		argv: ["mv", "-f", temporary, path],
		deadline: OperationDeadline.in(10_000),
		cancel: new CancellationToken(),
		limits: {
			stdoutBytes: 16 * 1024,
			stderrBytes: 16 * 1024,
			overflow: { kind: "truncate" },
		},
	});
	if (moved.code !== 0) {
		await runtime.removeTree(temporary).catch(() => undefined);
		throw new Error(
			`DevHub could not save Claude Code's settings ${path}${runtime.where}: ${moved.stderr.toString("utf8").trim() || `exit ${String(moved.code ?? moved.signal)}`}`,
		);
	}
}

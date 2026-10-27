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
 * A change is written to the user settings only (`cliSettingsFile.ts`).
 */

import {
	CLAUDE_SETTINGS_LAYERS,
	claudeDefaults,
	withUserDefault,
	type ClaudeSettingsLayer,
} from "../../../../model/claudeDefaults.js";
import type { CliDefaults } from "../../../../model/cliDefaults.js";
import type { Runtime } from "../../../runtime/runtime.js";
import {
	homeRelative,
	replaceSettingsFile,
	settingsText,
} from "../cliSettingsFile.js";
import { claudeConfigDirectory, type SessionProfile } from "../resume.js";

/** Where Claude Code looks for managed settings: macOS's place, then Linux's. */
const MANAGED_SETTINGS = [
	"/Library/Application Support/ClaudeCode/managed-settings.json",
	"/etc/claude-code/managed-settings.json",
];

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
	const user = await userSettingsPath(runtime, profile);
	const paths: Readonly<Record<ClaudeSettingsLayer, readonly string[]>> = {
		managed: MANAGED_SETTINGS,
		local: [`${root}/.claude/settings.local.json`],
		project: [`${root}/.claude/settings.json`],
		user: [user],
	};
	const settings: Partial<Record<ClaudeSettingsLayer, unknown>> = {};
	for (const layer of CLAUDE_SETTINGS_LAYERS) {
		for (const path of paths[layer]) {
			const value = parsed(await settingsText(runtime, path));
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
	return {
		cli: "claude",
		savedIn: await homeRelative(runtime, user),
		...claudeDefaults({ settings, env, args: profile.args }, model),
	};
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
	const text = withUserDefault(
		await settingsText(runtime, `${directory}/settings.json`),
		which,
		value,
		model,
	);
	await replaceSettingsFile(
		runtime,
		directory,
		"settings.json",
		text,
		"Claude Code's settings",
	);
}

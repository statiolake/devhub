/**
 * Codex's defaults for new threads, read and changed on the Agent's machine
 * (`model/codexDefaults.ts` says what decides them).
 *
 * The configuration is the CLI's: `config.toml` under `CODEX_HOME` (the
 * profile's, else the machine's, else `~/.codex`). A file that is not there,
 * or that does not parse, sets nothing; a change to one that does not parse
 * is refused rather than written over it. A change goes to the table Codex
 * reads for the selected configuration profile, as Codex's own picker saves
 * it (`cliSettingsFile.ts` writes it).
 */

import type { CliDefaults } from "../../../../model/cliDefaults.js";
import {
	codexDefaults,
	selectedProfile,
	withCodexUserDefault,
	type CodexDefaultInputs,
} from "../../../../model/codexDefaults.js";
import { parseTomlValue } from "../../../../model/tomlDocument.js";
import type { Runtime } from "../../../runtime/runtime.js";
import {
	homeRelative,
	replaceSettingsFile,
	settingsText,
} from "../cliSettingsFile.js";
import { codexHome, type SessionProfile } from "../resume.js";

const CONFIG_FILE = "config.toml";

function parsed(
	text: string | undefined,
): Readonly<Record<string, unknown>> | undefined {
	if (text === undefined) return undefined;
	try {
		return parseTomlValue(text);
	} catch {
		return undefined;
	}
}

async function inputsOf(
	runtime: Runtime,
	profile: SessionProfile,
): Promise<{
	readonly directory: string;
	readonly text: string | undefined;
	readonly inputs: CodexDefaultInputs;
}> {
	const directory = await codexHome(runtime, profile);
	const text = await settingsText(runtime, `${directory}/${CONFIG_FILE}`);
	return {
		directory,
		text,
		inputs: { config: parsed(text), args: profile.args },
	};
}

/** The defaults a new thread of `profile`'s Codex starts on. */
export async function readCodexDefaults(
	runtime: Runtime,
	profile: SessionProfile,
): Promise<CliDefaults> {
	const { directory, inputs } = await inputsOf(runtime, profile);
	const file = await homeRelative(runtime, `${directory}/${CONFIG_FILE}`);
	const selected = selectedProfile(inputs);
	return {
		cli: "codex",
		savedIn:
			selected === undefined ? file : `[profiles.${selected}] in ${file}`,
		...codexDefaults(inputs),
	};
}

/**
 * Make `value` the default `which` of new threads of `profile`'s Codex, in
 * its `config.toml`: the selected configuration profile's table when one is
 * selected, else the top level.
 */
export async function writeCodexDefault(
	runtime: Runtime,
	profile: SessionProfile,
	which: "model" | "effort",
	value: string,
): Promise<void> {
	const { directory, text, inputs } = await inputsOf(runtime, profile);
	await replaceSettingsFile(
		runtime,
		directory,
		CONFIG_FILE,
		withCodexUserDefault(text, which, value, selectedProfile(inputs)),
		"Codex's configuration",
	);
}

/**
 * The settings DevHub runs on, from a file that may be wrong.
 *
 * A file DevHub cannot use is one notice — naming the file, the key and the
 * reason, and what DevHub runs on instead — and nothing else: `config` is
 * always a `Config`, the defaults until a file has been accepted and the last
 * accepted settings after.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppErrorWire } from "../../ipc/appShell.js";
import {
	CONFIG_SCHEMA_VERSION,
	ConfigError,
	ConfigStore,
	defaultConfig,
	type Config,
} from "../../model/config.js";
import { DEFAULT_PROFILE, profileLocations } from "../../model/profile.js";
import { makeScratchDir, removeScratchDir } from "../../model/testScratch.js";
import { failureText, NamedFailure } from "../../model/wire.js";
import { RunningSettings } from "./runningSettings.js";

const VERSION = `version = ${String(CONFIG_SCHEMA_VERSION)}`;
const GOOD = `${VERSION}\n[appearance]\nterminal_font_size = 15\n`;
const BROKEN = `${VERSION}\n[appearance]\nmode = "dusk"\n`;

let directory: string;
let file: string;

beforeEach(() => {
	directory = makeScratchDir("running-settings");
	file = join(directory, "settings.toml");
});

afterEach(() => {
	removeScratchDir(directory);
});

function write(text: string): void {
	writeFileSync(file, text, "utf8");
}

async function opened(): Promise<RunningSettings> {
	return RunningSettings.load(
		new ConfigStore({ file }),
		profileLocations(DEFAULT_PROFILE, directory),
	);
}

/** What a subscriber is told, in order. */
function heard(settings: RunningSettings): {
	readonly accepted: { config: Config; from: string }[];
	readonly refused: AppErrorWire[];
} {
	const accepted: { config: Config; from: string }[] = [];
	const refused: AppErrorWire[] = [];
	settings.subscribe({
		accepted: (config, from) => accepted.push({ config, from }),
		refused: (notice) => refused.push(notice),
	});
	return { accepted, refused };
}

describe("a settings file DevHub cannot use at launch", () => {
	it("is the defaults and one notice naming the file, the key and the reason", async () => {
		write(BROKEN);
		const settings = await opened();
		expect(settings.config).toEqual(defaultConfig());
		const notice = settings.launchRefusal;
		expect(notice?.code).toBe("settings_refused");
		expect(notice?.summary).toBe("DevHub could not use its settings file.");
		expect(notice?.detail).toMatch(
			new RegExp(
				`^${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: appearance was refused: invalid_appearance.*DevHub is running on its defaults until the file is fixed\\.$`,
			),
		);
		expect(notice?.actions).toEqual(["open_settings"]);
	});

	it("is said once while it stays broken, and is over once the file is fixed", async () => {
		write(BROKEN);
		const settings = await opened();
		const { accepted, refused } = heard(settings);
		await settings.check();
		await settings.check();
		// The launch already said it.
		expect(refused).toEqual([]);

		write(GOOD);
		await settings.check();
		expect(accepted.map(({ from }) => from)).toEqual(["file"]);
		expect(settings.config.appearance.terminalFontSize).toBe(15);
		expect(settings.launchRefusal).toBeDefined();
	});

	it("leaves the Settings window the store's diagnostic rather than a second read", async () => {
		write(BROKEN);
		const settings = await opened();
		expect(() => settings.editing()).toThrow(ConfigError);
		expect(settings.diagnostic()?.path).toBe("appearance");
	});

	it("names the file when the load failed for a reason the store did not name", async () => {
		// A directory where the file should be: not a ConfigError of the
		// store's own making.
		const settings = await RunningSettings.load(
			new ConfigStore({ file: directory }),
			profileLocations(DEFAULT_PROFILE, directory),
		);
		expect(settings.config).toEqual(defaultConfig());
		expect(settings.launchRefusal?.detail).toBe(
			`${directory}: the file was refused: io. DevHub is running on its defaults until the file is fixed.`,
		);
	});
});

describe("a settings file edited into one DevHub cannot use", () => {
	it("keeps the last accepted settings and is said once, as the last accepted settings", async () => {
		write(GOOD);
		const settings = await opened();
		expect(settings.launchRefusal).toBeUndefined();
		const { accepted, refused } = heard(settings);

		write(BROKEN);
		await settings.check();
		await settings.check();
		expect(accepted).toEqual([]);
		expect(refused).toHaveLength(1);
		expect(refused[0]?.detail).toMatch(
			/appearance was refused: invalid_appearance.*DevHub is still running on the last settings it accepted\.$/,
		);
		expect(settings.config.appearance.terminalFontSize).toBe(15);

		// Fixed, then broken the same way again: said again.
		write(GOOD.replace("15", "16"));
		await settings.check();
		write(BROKEN);
		await settings.check();
		expect(refused).toHaveLength(2);
		expect(settings.config.appearance.terminalFontSize).toBe(16);
	});

	it("keeps the file and the key when it ends as text, as the devhub command prints it", async () => {
		write(BROKEN);
		const notice = (await opened()).launchRefusal!;
		expect(failureText(new NamedFailure(notice))).toBe(
			`DevHub could not use its settings file. ${notice.detail ?? ""}`,
		);
	});
});

describe("settings the Settings window writes", () => {
	it("are what DevHub runs on from then on, and every subscriber is told", async () => {
		write(GOOD);
		const settings = await opened();
		const { accepted } = heard(settings);
		const loaded = settings.editing();
		await settings.save(loaded.revision, {
			...loaded.config,
			appearance: { ...loaded.config.appearance, terminalFontSize: 18 },
		});
		expect(accepted.map(({ from }) => from)).toEqual(["settings"]);
		expect(settings.config.appearance.terminalFontSize).toBe(18);
		// The watcher's next read is the file it just wrote: nothing new.
		await settings.check();
		expect(accepted).toHaveLength(1);
	});

	it("tells every subscriber even when one of them throws", async () => {
		write(GOOD);
		const settings = await opened();
		settings.subscribe({
			accepted: () => {
				throw new Error("a subscriber's own bug");
			},
		});
		const { accepted } = heard(settings);
		write(GOOD.replace("15", "17"));
		await expect(settings.check()).rejects.toThrow("a subscriber's own bug");
		expect(accepted).toHaveLength(1);
		expect(settings.config.appearance.terminalFontSize).toBe(17);
	});
});

import { describe, expect, it } from "vitest";
import { ConfigError } from "../../model/config.js";
import { TypedFailure } from "../../model/wire.js";
import { SettingsRefusal } from "./settingsRefusal.js";

const FILE = "/scratch-test/devhub/settings.toml";

/** A notice without the moment it was raised, which is all that differs. */
function said(notice: { readonly timestampMs: number }): object {
	return { ...notice, timestampMs: 0 };
}

describe("a settings file DevHub could not use", () => {
	it("is one notice, naming the file, the key and the reason, at launch and to anything that needs settings", () => {
		const refusal = new SettingsRefusal(FILE);
		const launch = refusal.atLaunch(
			new ConfigError({
				code: "unsupported_version",
				path: "version",
				location: { line: 1, column: 1 },
			}),
		);
		expect(launch.code).toBe("settings_refused");
		expect(launch.summary).toBe("DevHub could not use its settings file.");
		expect(launch.detail).toBe(
			`${FILE}: version was refused (line 1, column 1): unsupported_version. DevHub is running on its defaults until the file is fixed.`,
		);
		expect(launch.actions).toEqual(["open_settings"]);
		// `requireConfig` answers with the very same notice, not a derived
		// "the native app shell is unavailable".
		expect(refusal.required()).toBe(launch);
	});

	it("is the same notice when the watcher sees the file refused before any was accepted", () => {
		const atLaunch = new SettingsRefusal(FILE).atLaunch(
			new ConfigError({ code: "unknown_key", path: "bogus" }),
		);
		const refusal = new SettingsRefusal(FILE);
		const reload = refusal.onReload(
			{ code: "unknown_key", path: "bogus" },
			false,
		);
		expect(said(reload)).toEqual(said(atLaunch));
		expect(refusal.required()).toBe(reload);
	});

	it("says the last accepted settings stay in effect when the file is refused later", () => {
		const refusal = new SettingsRefusal(FILE);
		const reload = refusal.onReload(
			{ code: "unknown_key", path: "bogus" },
			true,
		);
		expect(reload.code).toBe("settings_refused");
		expect(reload.detail).toBe(
			`${FILE}: bogus was refused: unknown_key. DevHub is still running on the last settings it accepted.`,
		);
	});

	it("names the file when the load failed for a reason the store did not name", () => {
		const launch = new SettingsRefusal(FILE).atLaunch(new Error("EACCES"));
		expect(launch.detail).toBe(
			`${FILE}: the file was refused: io. DevHub is running on its defaults until the file is fixed.`,
		);
	});

	it("is over once settings are accepted", () => {
		const refusal = new SettingsRefusal(FILE);
		refusal.atLaunch(new ConfigError({ code: "unknown_key", path: "bogus" }));
		refusal.accepted();
		expect(() => refusal.required()).toThrow(/no refusal/);
	});

	it("keeps the file and the key when it ends as text, as the devhub command prints it", () => {
		const launch = new SettingsRefusal(FILE).atLaunch(
			new ConfigError({ code: "unknown_key", path: "bogus" }),
		);
		expect(new TypedFailure(launch).message).toBe(
			`DevHub could not use its settings file. ${launch.detail ?? ""}`,
		);
	});
});

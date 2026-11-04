/**
 * `settings.toml` has one reader: `RunningSettings` (`runningSettings.ts`).
 *
 * Everything else asks it or subscribes to it. Each reader of its own was a
 * second answer to "what are the settings", with its own idea of what a file
 * DevHub cannot use means — and one of those ideas was to throw, which stopped
 * every GUI Agent's conversation and every terminal pane over a typo in the
 * file. This walks the app's sources and fails on any way back to that: a
 * `ConfigStore` made or held anywhere else, the file's path or name worked out
 * anywhere else, or its text parsed anywhere but the model that defines it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every source file of the app, tests aside, as `path relative to src`. */
function sources(): readonly {
	readonly path: string;
	readonly code: string;
}[] {
	const found: { path: string; code: string }[] = [];
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				walk(path);
				continue;
			}
			if (!/\.(ts|tsx|mts)$/.test(entry.name)) continue;
			if (/\.test\.tsx?$/.test(entry.name)) continue;
			found.push({
				path: relative(SRC, path).split(sep).join("/"),
				code: withoutComments(readFileSync(path, "utf8")),
			});
		}
	};
	walk(SRC);
	return found;
}

/** The code without its comments, which may name anything they like. */
function withoutComments(text: string): string {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** The files `pattern` occurs in, outside `allowed`. */
function offenders(pattern: RegExp, allowed: readonly string[]): string[] {
	return sources()
		.filter(({ path, code }) => !allowed.includes(path) && pattern.test(code))
		.map(({ path }) => path);
}

const OWNER = "main/shell/runningSettings.ts";
const MODEL = "model/config.ts";

describe("the settings file", () => {
	it("is found by the sources", () => {
		// A walk that found nothing would pass every rule below.
		const paths = sources().map(({ path }) => path);
		expect(paths).toContain(OWNER);
		expect(paths).toContain(MODEL);
		expect(paths).toContain("main/shell/appController.ts");
	});

	it("is opened by RunningSettings alone", () => {
		expect(offenders(/\bConfigStore\b/, [OWNER, MODEL])).toEqual([]);
		expect(offenders(/\bdefaultConfigPaths\b/, [OWNER, MODEL])).toEqual([]);
		// A new profile's file is copied in on the way to being opened.
		expect(
			offenders(/\bseedProfileSettings\b/, [OWNER, "main/profileSeed.ts"]),
		).toEqual([]);
	});

	it("is parsed and validated by the model that defines it, for RunningSettings", () => {
		expect(
			offenders(/\b(parseConfigText|parseConfig|interpretConfig)\s*\(/, [
				MODEL,
			]),
		).toEqual([]);
	});

	it("is named nowhere else", () => {
		// The file's name, as code: a path built from it is a second reader in
		// the making. The Settings page says the name, and never reads it.
		expect(
			offenders(
				/\b(CONFIG_FILE_NAME|LOCAL_CONFIG_FILE_NAME|LEGACY_CONFIG_FILE_NAME)\b/,
				[MODEL, "main/profileSeed.ts"],
			),
		).toEqual([]);
		expect(
			offenders(/["'`]settings(\.local)?\.toml["'`]/, [
				MODEL,
				"ipc/settings.ts",
			]),
		).toEqual([]);
	});

	it("is not read before it is loaded, from its text", () => {
		// The window used to be made from a forgiving second read of the file
		// (`titleBarModeIn`, `colorThemesIn`, `appearanceModeIn`), which gave
		// a file DevHub refused a theme and a title bar the rest of the app
		// did not have.
		expect(
			offenders(/\b(titleBarModeIn|colorThemesIn|appearanceModeIn)\b/, []),
		).toEqual([]);
	});

	it("has no consumer that can find the settings missing", () => {
		// `config` is always a `Config` (`RunningSettings.config`). A consumer
		// that asks for "no settings" has a way to fail that the file's owner
		// already answered.
		expect(offenders(/\brequireConfig\b|\bcurrentConfig\b/, [])).toEqual([]);
		expect(offenders(/:\s*Config\s*\|\s*undefined/, [])).toEqual([]);
	});

	it("is planned on as soon as it is accepted", () => {
		// `general.workbench_discard_minutes` is read by a workbench plan, and
		// the discard deadline is set by one. Accepted settings that plan
		// nothing left a frozen workbench on the old deadline — an hour, by
		// default — until something else happened to plan.
		const controller = sources().find(
			({ path }) => path === "main/shell/appController.ts",
		);
		const body = controller?.code.match(
			/\n\tprivate settingsAccepted\(config: Config\): void \{\n([\s\S]*?)\n\t\}\n/,
		)?.[1];
		expect(body).toBeDefined();
		expect(body).toMatch(/\bthis\.reconcileWorkbenches\(\)/);
	});
});

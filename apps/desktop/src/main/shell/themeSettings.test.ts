import { describe, expect, it } from "vitest";
import type { ColorThemeDefinition } from "../../model/colorTheme.js";
import { ShellTheme } from "./shellTheme.js";
import { OpenVsxClient } from "./openVsx.js";
import { ThemeLibrary } from "./themeLibrary.js";
import { themeSettings } from "./themeSettings.js";

const THEMES: Record<string, ColorThemeDefinition> = {
	"Dark 2026": {
		settingsId: "Dark 2026",
		label: "Dark 2026",
		type: "dark",
		colors: {},
	},
	"Light 2026": {
		settingsId: "Light 2026",
		label: "Light 2026",
		type: "light",
		colors: {},
	},
	Nord: { settingsId: "Nord", label: "Nord", type: "dark", colors: {} },
};

function host(fetch: ConstructorParameters<typeof OpenVsxClient>[0]) {
	const theme = new ShellTheme(
		() => (name) => THEMES[name],
		() => true,
	);
	const settings = themeSettings({
		theme: () => theme,
		library: new ThemeLibrary("/nonexistent/devhub-themes", "/nonexistent"),
		openVsx: new OpenVsxClient(fetch),
		workbench: () => Promise.resolve(undefined),
		preview: () => undefined,
	});
	return { theme, settings };
}

describe("the colour themes behind Settings", () => {
	it("answers a failed search and a failed install with a sentence, never a throw", async () => {
		const { settings } = host(() =>
			Promise.reject(new TypeError("fetch failed")),
		);
		expect(await settings.search("nord")).toEqual({
			kind: "failed",
			problem: "DevHub could not reach Open VSX: fetch failed",
		});
		const outcome = await settings.install({
			namespace: "a",
			name: "b",
			version: "1.0.0",
			displayName: "B",
			description: "",
			downloadCount: 0,
			download: "https://open-vsx.org/x.vsix",
		});
		expect(outcome.problem).toBe(
			"a.b was not installed. DevHub could not reach Open VSX: fetch failed",
		);
		expect(outcome.themes.library).toEqual([]);
	});

	it("puts the configured theme back on Reload, and says what is temporary until then", async () => {
		const { theme, settings } = host(() => Promise.reject(new Error("unused")));
		theme.wearTemporarily("Nord", "session");
		expect((await settings.themes()).temporary).toBe("Nord");
		settings.revertTemporary();
		expect(theme.temporaryTheme()).toBeUndefined();
		expect(theme.wornName()).toBe("Dark 2026");
		expect((await settings.themes()).temporary).toBeUndefined();
	});
});

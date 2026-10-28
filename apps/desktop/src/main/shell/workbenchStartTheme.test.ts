import { describe, expect, it } from "vitest";
import {
	ResolvedColorTheme,
	type ColorThemeDefinition,
} from "../../model/colorTheme.js";
import {
	splashForWorkbench,
	stampSplash,
	withWorkbenchStart,
	workbenchStartOf,
	type StoredSplash,
} from "./workbenchStartTheme.js";

const MONOKAI: ColorThemeDefinition = {
	settingsId: "Monokai",
	label: "Monokai",
	type: "dark",
	colors: { "editor.background": "#272822", "sideBar.background": "#1e1f1c" },
};

const LIGHT: ColorThemeDefinition = {
	settingsId: "Light 2026",
	label: "Light 2026",
	type: "light",
	colors: { "editor.background": "#ffffff" },
};

function startIn(definition: ColorThemeDefinition) {
	return workbenchStartOf(new ResolvedColorTheme(definition), {
		dark: "Monokai",
		light: "Light 2026",
		current: definition.settingsId,
	});
}

describe("a window configuration", () => {
	it("carries the settings and the theme's colours to the renderer", () => {
		const configuration = { windowId: 3, colorScheme: { dark: true } };
		expect(withWorkbenchStart(configuration, startIn(MONOKAI))).toEqual({
			windowId: 3,
			colorScheme: { dark: true },
			devhubManagedSettings: {
				"window.autoDetectColorScheme": true,
				"workbench.preferredDarkColorTheme": "Monokai",
				"workbench.preferredLightColorTheme": "Light 2026",
				"workbench.colorTheme": "Monokai",
			},
			devhubInitialColorTheme: { themeType: "dark", colors: MONOKAI.colors },
			autoDetectColorScheme: false,
		});
	});

	it("is a copy: the configuration the window keeps is untouched", () => {
		const configuration = { windowId: 3 };
		withWorkbenchStart(configuration, startIn(MONOKAI));
		expect(configuration).toEqual({ windowId: 3 });
	});

	it("is the only object touched", () => {
		const start = startIn(MONOKAI);
		const other = { something: "else" };
		expect(withWorkbenchStart(other, start)).toBe(other);
		expect(withWorkbenchStart(undefined, start)).toBeUndefined();
	});
});

describe("the window splash", () => {
	const stored = (extra: Partial<StoredSplash> = {}): StoredSplash => ({
		baseTheme: "vs-dark",
		colorInfo: { background: "#272822" },
		layoutInfo: { sideBarWidth: 300 },
		...extra,
	});

	it("is the stored one when it was saved in the theme being worn", () => {
		const start = startIn(MONOKAI);
		const saved = stampSplash(stored(), start);
		expect(splashForWorkbench(saved, start)).toBe(saved);
	});

	it("is the worn theme's when the stored one was saved in another", () => {
		const saved = stampSplash(stored({ zoomLevel: 1 }), startIn(MONOKAI));
		const light = startIn(LIGHT);
		expect(splashForWorkbench(saved, light)).toEqual({
			...light.splash,
			zoomLevel: 1,
		});
		expect(light.splash).toMatchObject({
			baseTheme: "vs",
			colorInfo: { background: "#ffffff", editorBackground: "#ffffff" },
		});
	});

	it("is the worn theme's when the stored one was never stamped, or there is none", () => {
		const start = startIn(MONOKAI);
		expect(splashForWorkbench(stored(), start)).toBe(start.splash);
		expect(splashForWorkbench(undefined, start)).toBe(start.splash);
	});

	it("moves with the theme's colours, not only its name", () => {
		const edited = startIn({
			...MONOKAI,
			colors: { "editor.background": "#000000" },
		});
		const saved = stampSplash(stored(), startIn(MONOKAI));
		expect(splashForWorkbench(saved, edited)).toBe(edited.splash);
	});

	it("is upstream's, untouched, without a theme", () => {
		const saved = stored();
		expect(stampSplash(saved, undefined)).toBe(saved);
		expect(splashForWorkbench(saved, undefined)).toBe(saved);
	});
});

import { describe, expect, it } from "vitest";
import type { ColorThemeDefinition } from "../../model/colorTheme.js";
import { ColorThemeUnreadable } from "./colorThemeCatalog.js";
import { ShellTheme, type ColorThemeLoader } from "./shellTheme.js";

const THEMES: Record<string, ColorThemeDefinition> = {
	"Dark 2026": {
		settingsId: "Dark 2026",
		label: "Dark 2026",
		type: "dark",
		colors: { "editor.background": "#121314", "sideBar.background": "#191a1b" },
	},
	"Light 2026": {
		settingsId: "Light 2026",
		label: "Light 2026",
		type: "light",
		colors: { "editor.background": "#ffffff" },
	},
	Monokai: {
		settingsId: "Monokai",
		label: "Monokai",
		type: "dark",
		colors: { "editor.background": "#272822", "terminal.ansiRed": "#c4265e" },
	},
};

function harness(
	options: {
		readonly themes?: Record<string, ColorThemeDefinition>;
		readonly broken?: string;
	} = {},
) {
	let dark = true;
	let listings = 0;
	const themes = options.themes ?? THEMES;
	const loader = (): ColorThemeLoader => {
		listings += 1;
		return (name) => {
			if (name === options.broken) {
				throw new ColorThemeUnreadable(`${name}.json is not a JSON theme.`);
			}
			return themes[name];
		};
	};
	const theme = new ShellTheme(loader, () => dark);
	let changes = 0;
	theme.onDidChange(() => {
		changes += 1;
	});
	return {
		theme,
		setDark(next: boolean) {
			dark = next;
			theme.appearanceChanged();
		},
		changes: () => changes,
		listings: () => listings,
	};
}

describe("the theme DevHub wears", () => {
	it("is VS Code's default for the appearance the process is in", () => {
		const h = harness();
		expect(h.theme.palette().surface).toBe("#121314");
		expect(h.theme.palette().base).toBe("dark");
		expect(h.theme.workbenchThemes()).toEqual({
			dark: "Dark 2026",
			light: "Light 2026",
			current: "Dark 2026",
		});
		h.setDark(false);
		expect(h.theme.palette().surface).toBe("#ffffff");
		expect(h.theme.palette().base).toBe("light");
		expect(h.theme.workbenchThemes().current).toBe("Light 2026");
		expect(h.changes()).toBe(1);
	});

	it("is the one the settings name, terminal colours included", () => {
		const h = harness();
		h.theme.configure({ dark: "Monokai", light: "Light 2026" });
		expect(h.changes()).toBe(1);
		expect(h.theme.palette().surface).toBe("#272822");
		expect(h.theme.terminalPalette().ansi[1]).toBe("#c4265e");
		expect(h.theme.terminalPalette().background).toBe("#272822");
		expect(h.theme.workbenchThemes()).toEqual({
			dark: "Monokai",
			light: "Light 2026",
			current: "Monokai",
		});
		// The same names again change nothing, and say nothing.
		h.theme.configure({ dark: "Monokai", light: "Light 2026" });
		expect(h.changes()).toBe(1);
	});

	it("reads the installed themes once per reading of the names", () => {
		const h = harness();
		const before = h.listings();
		h.theme.configure({ dark: "Monokai", light: "Light 2026" });
		expect(h.listings()).toBe(before + 1);
	});

	it("falls back to VS Code's default for a name nothing has, and says so once", () => {
		const h = harness();
		h.theme.takeProblems();
		h.theme.configure({ dark: "Nope", light: "Light 2026" });
		expect(h.theme.workbenchThemes().dark).toBe("Dark 2026");
		expect(h.theme.takeProblems()).toEqual([
			"No installed colour theme is called 'Nope' (appearance.theme_dark).",
		]);
		h.theme.configure({ dark: "Nope", light: "Light 2026" });
		expect(h.theme.takeProblems()).toEqual([]);
	});

	it("says why a theme that is there could not be read", () => {
		const h = harness({ broken: "Monokai" });
		h.theme.configure({ dark: "Monokai", light: "Light 2026" });
		expect(h.theme.takeProblems()).toEqual([
			"Monokai.json is not a JSON theme.",
		]);
		expect(h.theme.workbenchThemes().dark).toBe("Dark 2026");
	});

	it("is still VS Code's colours with no theme installed at all", () => {
		const h = harness({ themes: {} });
		const palette = h.theme.palette();
		// The registry's dark defaults: editor and side bar.
		expect(palette.surface).toBe("#1e1e1e");
		expect(palette.chrome).toBe("#252526");
		expect(h.theme.workbenchThemes().dark).toBe("Dark 2026");
		expect(h.theme.takeProblems()).toEqual([
			"No installed colour theme is called 'Dark 2026' (appearance.theme_dark).",
			"No installed colour theme is called 'Light 2026' (appearance.theme_light).",
		]);
	});
});

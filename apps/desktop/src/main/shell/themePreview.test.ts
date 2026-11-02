import { describe, expect, it } from "vitest";
import type { ColorThemeDefinition } from "../../model/colorTheme.js";
import type { ThemePreviewRowWire } from "../../ipc/contract.js";
import { ShellTheme, type AvailableColorTheme } from "./shellTheme.js";
import { ThemePreview, themePreviewRows } from "./themePreview.js";

const THEMES: Record<string, ColorThemeDefinition> = {
	"Dark 2026": {
		settingsId: "Dark 2026",
		label: "Dark 2026",
		type: "dark",
		colors: { "editor.background": "#121314" },
	},
	"Light 2026": {
		settingsId: "Light 2026",
		label: "Light 2026",
		type: "light",
		colors: { "editor.background": "#ffffff" },
	},
	Nord: {
		settingsId: "Nord",
		label: "Nord",
		type: "dark",
		colors: { "editor.background": "#2e3440" },
	},
};

const AVAILABLE: AvailableColorTheme[] = [
	{
		name: "Dark 2026",
		label: "Dark 2026",
		type: "dark",
		extension: "vscode.theme-defaults",
		source: "builtin",
	},
	{
		name: "Light 2026",
		label: "Light 2026",
		type: "light",
		extension: "vscode.theme-defaults",
		source: "builtin",
	},
	{
		name: "Nord",
		label: "Nord",
		type: "dark",
		extension: "arcticicestudio.nord",
		source: "devhub",
	},
	{
		name: "Nord",
		label: "Nord",
		type: "dark",
		extension: "arcticicestudio.nord",
		source: "extension",
	},
];

function harness() {
	const theme = new ShellTheme(
		() => (name) => THEMES[name],
		() => true,
		{ dark: "Dark 2026", light: "Light 2026" },
		() => AVAILABLE,
	);
	const surfaces: string[] = [];
	theme.onDidChange(() => {
		surfaces.push(theme.palette().surface);
	});
	let answer: (index: number) => void = () => undefined;
	let shown:
		| { rows: readonly ThemePreviewRowWire[]; current: number }
		| undefined;
	const problems: string[] = [];
	const preview = new ThemePreview({
		theme: () => theme,
		choose: (rows, current) => {
			shown = { rows, current };
			return new Promise((resolve) => {
				answer = resolve;
			});
		},
		report: (problem) => problems.push(problem),
	});
	return {
		theme,
		preview,
		surfaces,
		problems,
		shown: () => shown,
		answer: (index: number) => answer(index),
	};
}

describe("Theme: Preview…", () => {
	it("lists every theme once, the one worn first", async () => {
		const h = harness();
		const opening = h.preview.open();
		expect(h.shown()?.rows.map((row) => row.name)).toEqual([
			"Dark 2026",
			"Light 2026",
			"Nord",
		]);
		expect(h.shown()?.current).toBe(0);
		expect(h.shown()?.rows[2]?.detail).toBe(
			"Dark · DevHub library · arcticicestudio.nord",
		);
		h.answer(-1);
		await opening;
	});

	it("wears the row under the cursor, and Escape puts back what was worn", async () => {
		const h = harness();
		const opening = h.preview.open();
		h.preview.preview("Nord");
		expect(h.theme.palette().surface).toBe("#2e3440");
		expect(h.theme.temporaryTheme()).toEqual({ name: "Nord", kind: "preview" });
		expect(h.theme.workbenchThemes()).toEqual({
			dark: "Nord",
			light: "Nord",
			current: "Nord",
		});
		h.answer(-1);
		await opening;
		expect(h.theme.palette().surface).toBe("#121314");
		expect(h.theme.temporaryTheme()).toBeUndefined();
		expect(h.theme.workbenchThemes().current).toBe("Dark 2026");
	});

	it("keeps the one chosen for the session, and is not open to previews after", async () => {
		const h = harness();
		const opening = h.preview.open();
		h.preview.preview("Light 2026");
		h.answer(2);
		await opening;
		expect(h.theme.wornName()).toBe("Nord");
		expect(h.theme.temporaryTheme()).toEqual({ name: "Nord", kind: "session" });
		h.preview.preview("Light 2026");
		expect(h.theme.wornName()).toBe("Nord");
		// The settings still name what they named.
		expect(h.theme.configuredName()).toBe("Dark 2026");
	});

	it("is gone when the settings are applied again — a save, a reload, a restart", async () => {
		const h = harness();
		const opening = h.preview.open();
		h.answer(2);
		await opening;
		h.theme.configure({ dark: "Dark 2026", light: "Light 2026" });
		expect(h.theme.temporaryTheme()).toBeUndefined();
		expect(h.theme.wornName()).toBe("Dark 2026");
		// A restart is a new ShellTheme, which only ever reads the settings.
		expect(harness().theme.wornName()).toBe("Dark 2026");
	});

	it("puts back a session theme on Escape, not the settings'", async () => {
		const h = harness();
		h.theme.wearTemporarily("Nord", "session");
		const opening = h.preview.open();
		expect(h.shown()?.current).toBe(2);
		h.preview.preview("Light 2026");
		h.answer(-1);
		await opening;
		expect(h.theme.temporaryTheme()).toEqual({ name: "Nord", kind: "session" });
	});

	it("says a theme that cannot be worn, and wears what it wore", async () => {
		const h = harness();
		const opening = h.preview.open();
		h.preview.preview("Gone");
		expect(h.problems).toEqual(["No installed colour theme is called 'Gone'."]);
		expect(h.theme.wornName()).toBe("Dark 2026");
		h.answer(-1);
		await opening;
	});

	it("rows are deduplicated by name", () => {
		expect(themePreviewRows(AVAILABLE)).toHaveLength(3);
	});
});

import { describe, expect, it } from "vitest";
import { completeTheme } from "../../model/themes/theme.js";
import { ShellTheme } from "./shellTheme.js";

const MINE = completeTheme({
	name: "Mine",
	background: "#101010",
	foreground: "#e0e0e0",
	palette: Array.from({ length: 16 }, () => "#808080"),
});

function harness() {
	let dark = true;
	const theme = new ShellTheme(() => dark);
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
	};
}

describe("the theme DevHub wears", () => {
	it("is DevHub's own pair by default, the half the appearance picks", () => {
		const h = harness();
		expect(h.theme.wornName()).toBe("DevHub Dark");
		expect(h.theme.palette().surface).toBe("#121314");
		expect(h.theme.palette().base).toBe("dark");
		h.setDark(false);
		expect(h.theme.wornName()).toBe("DevHub Light");
		expect(h.theme.palette().base).toBe("light");
		expect(h.theme.terminalPalette().background).toBe("#ffffff");
		expect(h.changes()).toBe(1);
	});

	it("is one theme for both appearances when the setting names one", () => {
		const h = harness();
		h.theme.configure({ light: "Nord", dark: "Nord" }, []);
		expect(h.theme.wornName()).toBe("Nord");
		h.setDark(false);
		expect(h.theme.wornName()).toBe("Nord");
		expect(h.theme.palette().base).toBe("dark");
	});

	it("finds the file's own themes, which win over a built-in of the same name", () => {
		const h = harness();
		h.theme.configure({ light: "Mine", dark: "Mine" }, [MINE]);
		expect(h.theme.palette().surface).toBe("#101010");
		h.theme.configure({ light: "Nord", dark: "Nord" }, [
			{ ...MINE, name: "Nord" },
		]);
		expect(h.theme.terminalPalette().background).toBe("#101010");
		expect(h.theme.available()[0]).toEqual({
			name: "Nord",
			kind: "dark",
			origin: "custom",
		});
	});

	it("falls back to DevHub's own for a name nobody has, and says so once", () => {
		const h = harness();
		h.theme.configure({ light: "Nope", dark: "Nope" }, []);
		expect(h.theme.wornName()).toBe("DevHub Dark");
		const problems = h.theme.takeProblems();
		expect(problems).toHaveLength(2);
		expect(problems[0]).toMatch(/No colour theme is called 'Nope'/);
		h.theme.configure({ light: "Nope", dark: "Nope" }, []);
		expect(h.theme.takeProblems()).toEqual([]);
	});

	it("matches a name without regard to case", () => {
		const h = harness();
		h.theme.configure({ light: "nord", dark: "catppuccin mocha" }, []);
		expect(h.theme.wornName()).toBe("Catppuccin Mocha");
	});

	it("wears a theme for the session until the settings are applied again", () => {
		const h = harness();
		h.theme.wearTemporarily("Gruvbox Dark", "session");
		expect(h.theme.wornName()).toBe("Gruvbox Dark");
		expect(h.theme.configuredName()).toBe("DevHub Dark");
		expect(h.theme.temporaryTheme()).toEqual({
			name: "Gruvbox Dark",
			kind: "session",
		});
		expect(() => {
			h.theme.wearTemporarily("Nope", "preview");
		}).toThrow(/No colour theme/);
		h.theme.configure({ light: "DevHub Light", dark: "DevHub Dark" }, []);
		expect(h.theme.wornName()).toBe("DevHub Dark");
		expect(h.theme.temporaryTheme()).toBeUndefined();
	});

	it("announces only a change of what is worn", () => {
		const h = harness();
		h.theme.configure({ light: "DevHub Light", dark: "DevHub Dark" }, []);
		expect(h.changes()).toBe(0);
		h.theme.configure({ light: "DevHub Light", dark: "Nord" }, []);
		expect(h.changes()).toBe(1);
	});
});

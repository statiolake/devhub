import { describe, expect, it } from "vitest";
import type { ThemePreviewRowWire } from "../../ipc/contract.js";
import { ShellTheme } from "./shellTheme.js";
import { ThemePreview, themePreviewRows } from "./themePreview.js";

function harness() {
	const theme = new ShellTheme(() => true);
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
	const index = (name: string): number =>
		shown?.rows.findIndex((row) => row.name === name) ?? -1;
	return {
		theme,
		preview,
		surfaces,
		problems,
		shown: () => shown,
		answer: (at: number) => answer(at),
		index,
	};
}

describe("Theme: Preview…", () => {
	it("lists every theme, and opens on the one worn", async () => {
		const h = harness();
		const opening = h.preview.open();
		const rows = h.shown()?.rows ?? [];
		expect(rows.length).toBeGreaterThan(200);
		expect(rows[h.shown()?.current ?? -1]?.name).toBe("DevHub Dark");
		expect(rows[h.index("Nord")]?.detail).toBe("Dark · Built in");
		expect(rows[h.index("DevHub Light")]?.detail).toBe("Light · DevHub");
		h.answer(-1);
		await opening;
	});

	it("wears the row under the cursor, and Escape puts back what was worn", async () => {
		const h = harness();
		const opening = h.preview.open();
		h.preview.preview("Nord");
		expect(h.theme.palette().surface).toBe("#2e3440");
		expect(h.theme.temporaryTheme()).toEqual({ name: "Nord", kind: "preview" });
		h.answer(-1);
		await opening;
		expect(h.theme.palette().surface).toBe("#121314");
		expect(h.theme.temporaryTheme()).toBeUndefined();
	});

	it("keeps the one chosen for the session, and is not open to previews after", async () => {
		const h = harness();
		const opening = h.preview.open();
		h.preview.preview("DevHub Light");
		h.answer(h.index("Nord"));
		await opening;
		expect(h.theme.wornName()).toBe("Nord");
		expect(h.theme.temporaryTheme()).toEqual({ name: "Nord", kind: "session" });
		h.preview.preview("DevHub Light");
		expect(h.theme.wornName()).toBe("Nord");
		// The settings still name what they named.
		expect(h.theme.configuredName()).toBe("DevHub Dark");
	});

	it("is gone when the settings are applied again — a save, a reload, a restart", async () => {
		const h = harness();
		const opening = h.preview.open();
		h.answer(h.index("Nord"));
		await opening;
		h.theme.configure({ dark: "DevHub Dark", light: "DevHub Light" }, []);
		expect(h.theme.temporaryTheme()).toBeUndefined();
		expect(h.theme.wornName()).toBe("DevHub Dark");
		// A restart is a new ShellTheme, which only ever reads the settings.
		expect(harness().theme.wornName()).toBe("DevHub Dark");
	});

	it("puts back a session theme on Escape, not the settings'", async () => {
		const h = harness();
		h.theme.wearTemporarily("Nord", "session");
		const opening = h.preview.open();
		expect(h.shown()?.current).toBe(h.index("Nord"));
		h.preview.preview("DevHub Light");
		h.answer(-1);
		await opening;
		expect(h.theme.temporaryTheme()).toEqual({ name: "Nord", kind: "session" });
	});

	it("says a theme that cannot be worn, and wears what it wore", async () => {
		const h = harness();
		const opening = h.preview.open();
		h.preview.preview("Gone");
		expect(h.problems).toEqual(["No colour theme is called 'Gone'."]);
		expect(h.theme.wornName()).toBe("DevHub Dark");
		h.answer(-1);
		await opening;
	});

	it("names each row's kind and where it comes from", () => {
		expect(
			themePreviewRows([{ name: "Mine", kind: "light", origin: "custom" }]),
		).toEqual([{ name: "Mine", label: "Mine", detail: "Light · Yours" }]);
	});
});

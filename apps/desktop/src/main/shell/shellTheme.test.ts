import { describe, expect, it, vi } from "vitest";
import type { IPartsSplash } from "code-oss-dev/out/vs/platform/theme/common/themeService.js";
import { paletteOf, ShellTheme } from "./shellTheme.js";

function splash(
	overrides: Partial<IPartsSplash["colorInfo"]> & { baseTheme?: string } = {},
): IPartsSplash {
	const { baseTheme = "vs-dark", ...colors } = overrides;
	return {
		zoomLevel: undefined,
		baseTheme,
		colorInfo: {
			background: "#1f1f1f",
			foreground: "#cccccc",
			editorBackground: "#1f1f1f",
			titleBarBackground: "#181818",
			titleBarBorder: undefined,
			activityBarBackground: "#181818",
			activityBarBorder: undefined,
			sideBarBackground: "#181818",
			sideBarBorder: undefined,
			statusBarBackground: "#181818",
			statusBarBorder: undefined,
			statusBarNoFolderBackground: "#1f1f1f",
			windowBorder: undefined,
			...colors,
		},
		layoutInfo: undefined,
	} as IPartsSplash;
}

describe("paletteOf", () => {
	it("takes the surface from the editor and the chrome from the side bar", () => {
		expect(paletteOf(splash())).toEqual({
			base: "dark",
			surface: "#1f1f1f",
			chrome: "#181818",
			canvas: "#181818",
			ink: "#cccccc",
		});
	});

	it("reads the base theme as which half of light-dark() applies", () => {
		expect(paletteOf(splash({ baseTheme: "vs" }))?.base).toBe("light");
		expect(paletteOf(splash({ baseTheme: "hc-light" }))?.base).toBe("light");
		expect(paletteOf(splash({ baseTheme: "hc-black" }))?.base).toBe("dark");
	});

	it("falls back to the splash background when a part has no colour", () => {
		const palette = paletteOf(
			splash({ editorBackground: undefined, sideBarBackground: undefined }),
		);
		expect(palette?.surface).toBe("#1f1f1f");
		expect(palette?.chrome).toBe("#181818");
	});

	it("refuses a splash whose colours are not colours", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(paletteOf(splash({ foreground: "red; --x: url(evil)" }))).toBe(
			undefined,
		);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe("ShellTheme", () => {
	it("starts in the palette the last session stored", () => {
		const theme = new ShellTheme();
		expect(theme.restore(splash(), () => undefined)?.chrome).toBe("#181818");
	});

	it("has no palette at all on a profile that never ran a workbench", () => {
		const theme = new ShellTheme();
		expect(theme.restore(undefined, () => undefined)).toBe(undefined);
		expect(theme.palette()).toBe(undefined);
	});

	it("wears the selected workbench's theme when two disagree", () => {
		const theme = new ShellTheme();
		let selected: number | undefined = 1;
		theme.restore(undefined, () => selected);

		theme.reportSplash(1, splash({ sideBarBackground: "#111111" }));
		theme.reportSplash(2, splash({ sideBarBackground: "#222222" }));
		expect(theme.palette()?.chrome).toBe("#111111");

		selected = 2;
		expect(theme.palette()?.chrome).toBe("#222222");
	});

	it("keeps the stored palette until the selected workbench reports", () => {
		const theme = new ShellTheme();
		theme.restore(splash({ sideBarBackground: "#999999" }), () => 7);
		expect(theme.palette()?.chrome).toBe("#999999");
		theme.reportSplash(7, splash({ sideBarBackground: "#111111" }));
		expect(theme.palette()?.chrome).toBe("#111111");
	});

	it("announces a changed answer once, and an unchanged one never", () => {
		const theme = new ShellTheme();
		const changed = vi.fn();
		theme.restore(splash(), () => 1);
		theme.onDidChange(changed);

		theme.reportSplash(1, splash());
		expect(changed).not.toHaveBeenCalled();

		theme.reportSplash(1, splash({ sideBarBackground: "#111111" }));
		expect(changed).toHaveBeenCalledTimes(1);
		expect(changed.mock.calls[0][0].chrome).toBe("#111111");
	});

	it("forgets a workbench that went away", () => {
		const theme = new ShellTheme();
		theme.restore(undefined, () => 1);
		theme.reportSplash(1, splash({ sideBarBackground: "#111111" }));
		theme.reportSplash(2, splash({ sideBarBackground: "#222222" }));
		theme.forgetWindow(1);
		// The stored palette is the most recent report from any workbench, which
		// is what a window with nothing selected shows.
		expect(theme.palette()?.chrome).toBe("#222222");
	});
});

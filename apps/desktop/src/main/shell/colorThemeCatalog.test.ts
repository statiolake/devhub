import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeScratchDir, removeScratchDir } from "../../model/testScratch.js";
import {
	ResolvedColorTheme,
	shellPaletteOfTheme,
	terminalPaletteOfTheme,
} from "../../model/colorTheme.js";
import { isPaletteColor } from "../../ipc/palette.js";
import { terminalPaletteIsValid } from "../../model/wire.js";
import {
	ColorThemeUnreadable,
	findColorTheme,
	listColorThemes,
	loadColorTheme,
	parseJsonc,
} from "./colorThemeCatalog.js";

let root: string;

beforeEach(() => {
	root = makeScratchDir("color-themes");
});

afterEach(() => {
	removeScratchDir(root);
});

function write(path: string, content: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		typeof content === "string" ? content : JSON.stringify(content),
	);
}

/** An extension contributing `themes`, each `[label, uiTheme, file, json]`. */
function extension(
	directory: string,
	themes: readonly {
		readonly id?: string;
		readonly label: string;
		readonly uiTheme: string;
		readonly path: string;
	}[],
	nls?: Record<string, string>,
): void {
	write(join(directory, "package.json"), {
		name: directory.replace(/^.*[\\/]/, "").replace(/-\d.*$/, ""),
		publisher: "test",
		contributes: { themes },
	});
	if (nls) write(join(directory, "package.nls.json"), nls);
}

describe("JSON with comments", () => {
	it("reads comments and trailing commas, and leaves strings alone", () => {
		expect(
			parseJsonc(`{
				// a comment
				"a": "http://x//y", /* another */
				"b": [1, 2,],
			}`),
		).toEqual({ a: "http://x//y", b: [1, 2] });
		expect(parseJsonc('{"a": "q\\"//"}')).toEqual({ a: 'q"//' });
		expect(parseJsonc("{ nope")).toBeUndefined();
	});
});

describe("finding a theme", () => {
	it("finds built-in and installed themes, by id, by localized label, ignoring case", () => {
		const builtin = join(root, "builtin");
		extension(
			join(builtin, "theme-defaults"),
			[
				{
					id: "Visual Studio Dark",
					label: "%dark%",
					uiTheme: "vs-dark",
					path: "./themes/dark.json",
				},
			],
			{ dark: "Dark (Visual Studio)" },
		);
		const user = join(root, "user");
		extension(join(user, "test.mine-1.0.0"), [
			{ label: "Mine", uiTheme: "vs", path: "./mine.json" },
		]);
		const themes = listColorThemes({ builtin, user });
		expect(themes.map((theme) => theme.settingsId)).toEqual([
			"Visual Studio Dark",
			"Mine",
		]);
		expect(findColorTheme(themes, "Visual Studio Dark")?.label).toBe(
			"Dark (Visual Studio)",
		);
		expect(findColorTheme(themes, "Dark (Visual Studio)")?.settingsId).toBe(
			"Visual Studio Dark",
		);
		expect(findColorTheme(themes, "mine")?.settingsId).toBe("Mine");
		expect(findColorTheme(themes, "Nothing")).toBeUndefined();
	});

	it("takes the newest version of an installed extension, and skips removed ones", () => {
		const user = join(root, "user");
		extension(join(user, "test.mine-1.9.0"), [
			{ label: "Old", uiTheme: "vs", path: "./t.json" },
		]);
		extension(join(user, "test.mine-1.10.0"), [
			{ label: "New", uiTheme: "vs", path: "./t.json" },
		]);
		extension(join(user, "test.gone-1.0.0"), [
			{ label: "Gone", uiTheme: "vs", path: "./t.json" },
		]);
		write(join(user, ".obsolete"), { "test.gone-1.0.0": true });
		expect(
			listColorThemes({ builtin: undefined, user }).map((theme) => theme.label),
		).toEqual(["New"]);
	});

	it("is nothing at all where there are no extensions", () => {
		expect(
			listColorThemes({
				builtin: join(root, "absent"),
				user: undefined,
			}),
		).toEqual([]);
	});
});

describe("reading a theme", () => {
	function entry(path: string, uiTheme = "vs-dark") {
		return {
			settingsId: "T",
			label: "T",
			id: undefined,
			uiTheme,
			path,
			extension: "test.t",
		};
	}

	it("folds in an include chain, the including file's colours winning", () => {
		write(join(root, "base.json"), {
			colors: { "editor.background": "#000000", foreground: "#111111" },
		});
		write(join(root, "middle.json"), {
			include: "./base.json",
			colors: { foreground: "#222222", "sideBar.background": "#333333" },
		});
		write(
			join(root, "top.json"),
			`{
				// VS Code's own themes are JSON with comments
				"include": "./middle.json",
				"colors": {
					"sideBar.background": "default",
					"terminal.ansiRed": "#ff0000",
				},
			}`,
		);
		const theme = loadColorTheme(entry(join(root, "top.json"), "vs"));
		expect(theme.type).toBe("light");
		expect(theme.colors).toEqual({
			"editor.background": "#000000",
			foreground: "#222222",
			"terminal.ansiRed": "#ff0000",
		});
	});

	it("says which file it could not read", () => {
		write(join(root, "loop.json"), { include: "./loop.json" });
		expect(() => loadColorTheme(entry(join(root, "loop.json")))).toThrow(
			ColorThemeUnreadable,
		);
		expect(() => loadColorTheme(entry(join(root, "absent.json")))).toThrow(
			/absent\.json could not be read/,
		);
		write(join(root, "broken.json"), "{ nope");
		expect(() => loadColorTheme(entry(join(root, "broken.json")))).toThrow(
			/is not a JSON theme/,
		);
	});

	it("takes a TextMate theme as its type alone", () => {
		write(join(root, "old.tmTheme"), "<plist/>");
		expect(loadColorTheme(entry(join(root, "old.tmTheme"), "vs"))).toEqual({
			settingsId: "T",
			label: "T",
			type: "light",
			colors: {},
		});
	});
});

// VS Code's own themes, where the submodule is checked out: every built-in
// theme resolves to a whole palette, and the defaults are the ones named.
const BUILTIN = join(
	fileURLToPath(new URL("../../../../..", import.meta.url)),
	"vscode",
	"extensions",
);

describe.skipIf(!existsSync(join(BUILTIN, "theme-defaults")))(
	"VS Code's built-in themes",
	() => {
		it("all read, and every one is a whole palette", () => {
			const themes = listColorThemes({ builtin: BUILTIN, user: undefined });
			expect(findColorTheme(themes, "Dark 2026")).toBeDefined();
			expect(findColorTheme(themes, "Light 2026")).toBeDefined();
			for (const entry of themes) {
				const resolved = new ResolvedColorTheme(loadColorTheme(entry));
				const palette = shellPaletteOfTheme(resolved);
				expect(
					[palette.surface, palette.chrome, palette.canvas, palette.ink].every(
						isPaletteColor,
					),
					entry.settingsId,
				).toBe(true);
				expect(
					terminalPaletteIsValid(terminalPaletteOfTheme(resolved)),
					entry.settingsId,
				).toBe(true);
			}
		});
	},
);

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TerminalPaletteWire } from "../../ipc/appShell.js";
import { makeScratchDir, removeScratchDir } from "../../model/testScratch.js";
import { NamedFailure, terminalThemeWire } from "../../model/wire.js";
import {
	defaultTerminalPalettes,
	TERMINAL_THEME_VSCODE,
} from "../../model/terminalPalettes.js";
import {
	loadTerminalColors,
	READ_THEME_VARIABLES_SCRIPT,
	readThemeVariables,
	saveTerminalColors,
	TERMINAL_COLOR_VARIABLES,
	TerminalColors,
	type TerminalColorsBinding,
	terminalPaletteOf,
	type ThemeVariables,
} from "./terminalColors.js";

const ANSI = [
	"#000000",
	"#cd3131",
	"#0dbc79",
	"#e5e510",
	"#2472c8",
	"#bc3fbc",
	"#11a8cd",
	"#e5e5e5",
	"#666666",
	"#f14c4c",
	"#23d18b",
	"#f5f543",
	"#3b8eea",
	"#d670d6",
	"#29b8db",
	"#e5e5e5",
];

/** What Dark Modern's workbench computes: every property the theme sets. */
function darkModern(overrides: Record<string, string> = {}): ThemeVariables {
	const names = TERMINAL_COLOR_VARIABLES;
	return {
		[names.background]: "#181818",
		[names.foreground]: "#cccccc",
		[names.cursor]: "",
		[names.cursorText]: "",
		[names.selectionBackground]: "#264f78",
		[names.selectionForeground]: "",
		[names.editorBackground]: "#1f1f1f",
		...Object.fromEntries(names.ansi.map((name, index) => [name, ANSI[index]])),
		...overrides,
	};
}

describe("the palette, from the workbench's variables", () => {
	it("names the properties VS Code's registry writes", () => {
		expect(TERMINAL_COLOR_VARIABLES.background).toBe(
			"--vscode-terminal-background",
		);
		expect(TERMINAL_COLOR_VARIABLES.cursor).toBe(
			"--vscode-terminalCursor-foreground",
		);
		expect(TERMINAL_COLOR_VARIABLES.cursorText).toBe(
			"--vscode-terminalCursor-background",
		);
		expect(TERMINAL_COLOR_VARIABLES.ansi[0]).toBe(
			"--vscode-terminal-ansiBlack",
		);
		expect(TERMINAL_COLOR_VARIABLES.ansi[15]).toBe(
			"--vscode-terminal-ansiBrightWhite",
		);
		expect(TERMINAL_COLOR_VARIABLES.ansi).toHaveLength(16);
		// The script reads every one of them.
		for (const name of TERMINAL_COLOR_VARIABLES.ansi) {
			expect(READ_THEME_VARIABLES_SCRIPT).toContain(name);
		}
	});

	it("maps each property onto the pane's palette, and falls back as VS Code does", () => {
		expect(terminalPaletteOf(darkModern())).toEqual({
			background: "#181818",
			foreground: "#cccccc",
			// No cursor colours: the cursor is the foreground, the character
			// under it the background.
			cursor: "#cccccc",
			cursorText: "#181818",
			selectionBackground: "#264f78",
			// No selection foreground: a selected cell keeps its own colour.
			selectionForeground: undefined,
			ansi: ANSI,
		});
	});

	it("takes the editor's background when the theme gives the terminal none", () => {
		const palette = terminalPaletteOf(
			darkModern({ [TERMINAL_COLOR_VARIABLES.background]: "" }),
		);
		expect(palette.background).toBe("#1f1f1f");
		expect(palette.cursorText).toBe("#1f1f1f");
	});

	it("keeps colours a theme does set, translucent ones included", () => {
		const palette = terminalPaletteOf(
			darkModern({
				[TERMINAL_COLOR_VARIABLES.cursor]: "#aeafad",
				[TERMINAL_COLOR_VARIABLES.cursorText]: "#000000",
				[TERMINAL_COLOR_VARIABLES.selectionBackground]:
					"rgba(38, 79, 120, 0.5)",
				[TERMINAL_COLOR_VARIABLES.selectionForeground]: "#ffffff",
			}),
		);
		expect(palette.cursor).toBe("#aeafad");
		expect(palette.cursorText).toBe("#000000");
		expect(palette.selectionBackground).toBe("rgba(38, 79, 120, 0.5)");
		expect(palette.selectionForeground).toBe("#ffffff");
	});

	it("refuses a theme with a colour missing or not a colour, whole", () => {
		for (const broken of [
			darkModern({ [TERMINAL_COLOR_VARIABLES.ansi[3] ?? ""]: "" }),
			darkModern({ [TERMINAL_COLOR_VARIABLES.foreground]: "red; x: y" }),
			darkModern({
				[TERMINAL_COLOR_VARIABLES.background]: "",
				[TERMINAL_COLOR_VARIABLES.editorBackground]: "",
			}),
		]) {
			let thrown: unknown;
			try {
				terminalPaletteOf(broken);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(NamedFailure);
			expect((thrown as NamedFailure).wire.code).toBe(
				"terminal_colors_unreadable",
			);
		}
	});
});

describe("reading a workbench", () => {
	it("hands back what the page computed", async () => {
		const variables = darkModern();
		await expect(
			readThemeVariables({
				isDestroyed: () => false,
				executeJavaScript: (code) => {
					expect(code).toBe(READ_THEME_VARIABLES_SCRIPT);
					return Promise.resolve(variables);
				},
			}),
		).resolves.toEqual(variables);
	});

	it("is a named failure when there is nothing to read", async () => {
		const cases = [
			undefined,
			{
				isDestroyed: () => true,
				executeJavaScript: () => Promise.resolve({}),
			},
			{
				isDestroyed: () => false,
				executeJavaScript: () => Promise.resolve(null),
			},
			{
				isDestroyed: () => false,
				executeJavaScript: () => Promise.reject(new Error("navigated away")),
			},
		];
		for (const contents of cases) {
			await expect(readThemeVariables(contents)).rejects.toBeInstanceOf(
				NamedFailure,
			);
		}
	});
});

/** A reader with a Scratch at view 7, and a record of what it was told. */
function harness(initial: TerminalPaletteWire | undefined) {
	const saved: TerminalPaletteWire[] = [];
	const failures: NamedFailure[] = [];
	let changes = 0;
	let answer: () => Promise<ThemeVariables> = () =>
		Promise.resolve(darkModern());
	const reads: number[] = [];
	const colors = new TerminalColors(initial, (palette) => saved.push(palette));
	const binding: TerminalColorsBinding = {
		followed: () => 7,
		read: (windowId) => {
			reads.push(windowId);
			return answer();
		},
		changed: () => {
			changes += 1;
		},
		failed: (failure) => failures.push(failure),
	};
	colors.bind(binding);
	return {
		colors,
		saved,
		failures,
		reads,
		changes: () => changes,
		answer: (next: () => Promise<ThemeVariables>) => {
			answer = next;
		},
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("following Scratch's theme", () => {
	it("starts in the colours kept at the last quit, and the built-ins before any", () => {
		const kept = terminalPaletteOf(darkModern());
		expect(harness(kept).colors.palette()).toEqual(kept);
		expect(harness(undefined).colors.palette()).toBeUndefined();
		// What a pane is sent, either way.
		expect(terminalThemeWire(TERMINAL_THEME_VSCODE, kept)).toEqual({
			light: kept,
			dark: kept,
		});
		expect(terminalThemeWire(TERMINAL_THEME_VSCODE, undefined)).toEqual(
			defaultTerminalPalettes(),
		);
	});

	it("wears palettes the settings name, whatever the theme said", () => {
		const own = defaultTerminalPalettes();
		expect(terminalThemeWire(own, terminalPaletteOf(darkModern()))).toEqual(
			own,
		);
	});

	it("reads Scratch again when it reports a splash, and tells every pane once", async () => {
		const h = harness(undefined);
		h.colors.splashReported(7);
		await settle();
		expect(h.reads).toEqual([7]);
		expect(h.colors.palette()).toEqual(terminalPaletteOf(darkModern()));
		expect(h.changes()).toBe(1);
		expect(h.saved).toEqual([terminalPaletteOf(darkModern())]);

		// The same theme again — a layout, not a theme change — says nothing.
		h.colors.splashReported(7);
		await settle();
		expect(h.changes()).toBe(1);
		expect(h.saved).toHaveLength(1);

		// A theme change is pushed as soon as it is read.
		const light = darkModern({
			[TERMINAL_COLOR_VARIABLES.background]: "#ffffff",
			[TERMINAL_COLOR_VARIABLES.foreground]: "#3b3b3b",
		});
		h.answer(() => Promise.resolve(light));
		h.colors.splashReported(7);
		await settle();
		expect(h.colors.palette()?.background).toBe("#ffffff");
		expect(h.changes()).toBe(2);
		expect(h.saved).toHaveLength(2);
	});

	it("does not read a workbench that is not Scratch's", async () => {
		const h = harness(undefined);
		h.colors.splashReported(8);
		h.colors.splashReported(undefined);
		await settle();
		expect(h.reads).toEqual([]);
		expect(h.changes()).toBe(0);
	});

	it("keeps the newest read when two cross", async () => {
		const h = harness(undefined);
		let finishFirst: (value: ThemeVariables) => void = () => undefined;
		h.answer(
			() =>
				new Promise((resolve) => {
					finishFirst = resolve;
				}),
		);
		h.colors.splashReported(7);
		const newer = darkModern({
			[TERMINAL_COLOR_VARIABLES.background]: "#101010",
		});
		h.answer(() => Promise.resolve(newer));
		h.colors.splashReported(7);
		await settle();
		finishFirst(darkModern());
		await settle();
		expect(h.colors.palette()?.background).toBe("#101010");
		expect(h.changes()).toBe(1);
	});

	it("says a failure once, keeps the colours it had, and says the next one after a success", async () => {
		const kept = terminalPaletteOf(darkModern());
		const h = harness(kept);
		h.answer(() =>
			Promise.resolve(
				darkModern({ [TERMINAL_COLOR_VARIABLES.foreground]: "" }),
			),
		);
		h.colors.splashReported(7);
		await settle();
		h.colors.splashReported(7);
		await settle();
		expect(h.failures).toHaveLength(1);
		expect(h.failures[0]?.wire.code).toBe("terminal_colors_unreadable");
		expect(h.colors.palette()).toEqual(kept);
		expect(h.changes()).toBe(0);

		h.answer(() => Promise.resolve(darkModern()));
		h.colors.splashReported(7);
		await settle();
		h.answer(() => Promise.reject(new NamedFailure(h.failures[0]!.wire)));
		h.colors.splashReported(7);
		await settle();
		expect(h.failures).toHaveLength(2);
	});

	it("refuses a splash before it is bound", () => {
		const colors = new TerminalColors(undefined, () => undefined);
		expect(() => {
			colors.splashReported(7);
		}).toThrow(/before the terminal colours were bound/);
	});
});

describe("the colours kept between runs", () => {
	let directory: string;
	beforeEach(() => {
		directory = makeScratchDir("terminal-colors");
	});
	afterEach(() => {
		removeScratchDir(directory);
	});

	it("comes back as it was saved, an absent selection foreground included", () => {
		const path = join(directory, "devhub", "terminal-colors.json");
		expect(loadTerminalColors(path)).toEqual({
			palette: undefined,
			refused: undefined,
		});
		const palette = terminalPaletteOf(darkModern());
		saveTerminalColors(path, palette);
		expect(loadTerminalColors(path)).toEqual({ palette, refused: undefined });
	});

	it("moves a file that is not a palette aside and says so", () => {
		const path = join(directory, "terminal-colors.json");
		writeFileSync(path, '{"version":1,"palette":{"background":"red; x"}}');
		const loaded = loadTerminalColors(path);
		expect(loaded.palette).toBeUndefined();
		expect(loaded.refused).toContain("terminal-colors.json.corrupt");
		expect(existsSync(path)).toBe(false);
		expect(readFileSync(`${path}.corrupt`, "utf8")).toContain("red; x");
	});
});

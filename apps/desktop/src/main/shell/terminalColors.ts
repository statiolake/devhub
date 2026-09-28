/**
 * The VS Code theme's terminal colours, as an Agent pane wears them.
 *
 * With `[appearance] terminal_theme = "vscode"` (the default) a pane is
 * painted in the colours VS Code's own integrated terminal would have under
 * the theme on screen. Those colours are not in the window splash the shell
 * follows (`shellTheme.ts`) — the splash carries the editor, side bar and
 * title bar and nothing about a terminal — so they are read where the theme
 * service writes them: the `--vscode-*` custom properties on the workbench
 * root, which already hold every colour the registry resolved, defaults
 * included (`colorThemeCss.ts`).
 *
 * One workbench is read, and it is Scratch's: it is open in every run, and it
 * is the workbench with no folder settings of its own to pick a different
 * theme. Its splash is the signal to read. VS Code saves the splash on every
 * theme change — a theme picked, a theme edited, the OS switching light and
 * dark under `window.autoDetectColorScheme` — after the theme service has
 * already rewritten the variables, so there is nothing to poll and nothing to
 * observe from inside the page: the report that recolours the shell is the
 * report that re-reads the terminal colours.
 *
 * The last colours read are kept on disk beside `state.json`, so a pane that
 * starts before Scratch's workbench is up starts in the theme it had at the
 * last quit. A profile that has never read any wears the built-in palettes
 * (`terminalThemeWire`) until the first read lands.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { TerminalPaletteWire } from "../../ipc/appShell.js";
import { InvariantViolation } from "../../model/invariant.js";
import {
	errorWireAt,
	NamedFailure,
	terminalPaletteIsValid,
	withDetail,
} from "../../model/wire.js";

/**
 * The ANSI colours, in the terminal's own order — the registry's
 * `ansiColorMap` (`terminalColorRegistry.ts`), `terminal.ansiBlack` at 0
 * through `terminal.ansiBrightWhite` at 15.
 */
const ANSI_NAMES = [
	"Black",
	"Red",
	"Green",
	"Yellow",
	"Blue",
	"Magenta",
	"Cyan",
	"White",
	"BrightBlack",
	"BrightRed",
	"BrightGreen",
	"BrightYellow",
	"BrightBlue",
	"BrightMagenta",
	"BrightCyan",
	"BrightWhite",
] as const;

/**
 * Every custom property a palette is made from.
 *
 * The names are `asCssVariableName` of the registry's ids: `--vscode-` and
 * the id with its dots turned into dashes.
 */
export const TERMINAL_COLOR_VARIABLES = {
	background: "--vscode-terminal-background",
	foreground: "--vscode-terminal-foreground",
	cursor: "--vscode-terminalCursor-foreground",
	cursorText: "--vscode-terminalCursor-background",
	selectionBackground: "--vscode-terminal-selectionBackground",
	selectionForeground: "--vscode-terminal-selectionForeground",
	editorBackground: "--vscode-editor-background",
	ansi: ANSI_NAMES.map((name) => `--vscode-terminal-ansi${name}`),
} as const;

const VARIABLE_NAMES: readonly string[] = [
	TERMINAL_COLOR_VARIABLES.background,
	TERMINAL_COLOR_VARIABLES.foreground,
	TERMINAL_COLOR_VARIABLES.cursor,
	TERMINAL_COLOR_VARIABLES.cursorText,
	TERMINAL_COLOR_VARIABLES.selectionBackground,
	TERMINAL_COLOR_VARIABLES.selectionForeground,
	TERMINAL_COLOR_VARIABLES.editorBackground,
	...TERMINAL_COLOR_VARIABLES.ansi,
];

/**
 * The properties as the workbench page computes them: each name to its
 * value, the empty string for a property the theme leaves unset.
 */
export type ThemeVariables = Readonly<Record<string, string>>;

/**
 * What runs in the workbench page to read them.
 *
 * `null` when there is no workbench root yet, which is a workbench that has
 * reported a splash without a DOM — not a state a loaded page is ever in.
 */
export const READ_THEME_VARIABLES_SCRIPT = `(() => {
	const root = document.querySelector(".monaco-workbench");
	if (!root) return null;
	const style = getComputedStyle(root);
	const names = ${JSON.stringify(VARIABLE_NAMES)};
	return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name).trim()]));
})()`;

/**
 * The pane's palette from the workbench's variables, resolved the way VS
 * Code's own terminal resolves the same theme (`XtermTerminal.getXtermTheme`
 * and `TerminalInstanceColorProvider`).
 *
 * The registry gives most of these a default, and a default is already in the
 * variable. Four have none, and VS Code falls back for them in code rather
 * than in the registry, so the same fallbacks are made here:
 *
 * - `terminal.background` is the background of wherever the terminal sits. An
 *   Agent pane sits where an editor does, so it is the editor's — the rule
 *   VS Code has for a terminal in the editor area.
 * - `terminalCursor.foreground` is the terminal's foreground.
 * - `terminalCursor.background`, the character under a block cursor, is the
 *   terminal's background.
 * - `terminal.selectionForeground` stays unset: a selected cell keeps its own
 *   colour.
 *
 * Anything else missing, or anything that is not a colour, is a theme DevHub
 * cannot follow, and it is refused whole rather than half-applied.
 */
export function terminalPaletteOf(
	variables: ThemeVariables,
): TerminalPaletteWire {
	const value = (name: string): string | undefined => {
		const raw = variables[name];
		return raw === undefined || raw === "" ? undefined : raw;
	};
	const names = TERMINAL_COLOR_VARIABLES;
	const background =
		value(names.background) ?? value(names.editorBackground) ?? "";
	const foreground = value(names.foreground) ?? "";
	const palette: TerminalPaletteWire = {
		background,
		foreground,
		cursor: value(names.cursor) ?? foreground,
		cursorText: value(names.cursorText) ?? background,
		selectionBackground: value(names.selectionBackground) ?? "",
		selectionForeground: value(names.selectionForeground),
		ansi: names.ansi.map((name) => value(name) ?? ""),
	};
	if (!terminalPaletteIsValid(palette)) {
		throw terminalColorsFailure(
			`The theme's terminal colours are not all colours: ${VARIABLE_NAMES.map(
				(name) => `${name}: ${variables[name] ?? "(absent)"}`,
			).join("; ")}.`,
		);
	}
	return palette;
}

/** A read that did not produce a palette, said as the failure it is. */
export function terminalColorsFailure(detail: string): NamedFailure {
	return new NamedFailure(
		withDetail(errorWireAt("terminal_colors_unreadable"), detail),
	);
}

/** What the reader is told once there is a controller to tell it. */
export interface TerminalColorsBinding {
	/** The view id of Scratch's workbench, when it has one. */
	readonly followed: () => number | undefined;
	/** The variables of the workbench with that view id. */
	readonly read: (windowId: number) => Promise<ThemeVariables>;
	/** The palette moved: every open pane is to be told. */
	readonly changed: () => void;
	/** A read failed after the last one succeeded. */
	readonly failed: (failure: NamedFailure) => void;
}

export class TerminalColors {
	private binding: TerminalColorsBinding | undefined;
	private requested = 0;
	/**
	 * Whether the last read failed. A theme that cannot be followed fails on
	 * every splash, and a splash comes with every layout of the editor, so
	 * only the first failure after a success is said.
	 */
	private failing = false;

	/**
	 * @param current The palette kept at the last quit (`loadTerminalColors`).
	 * @param save Keeps a palette for the next run.
	 */
	constructor(
		private current: TerminalPaletteWire | undefined,
		private readonly save: (palette: TerminalPaletteWire) => void,
	) {}

	/**
	 * The VS Code theme's terminal colours as last read, or nothing when this
	 * profile has never read them.
	 */
	palette(): TerminalPaletteWire | undefined {
		return this.current;
	}

	bind(binding: TerminalColorsBinding): void {
		if (this.binding) {
			throw new InvariantViolation("the terminal colours are already bound");
		}
		this.binding = binding;
	}

	/**
	 * A workbench saved its splash. Scratch's is read again; any other
	 * workbench's is not the one followed.
	 */
	splashReported(windowId: number | undefined): void {
		const binding = this.binding;
		if (!binding) {
			// A workbench exists only once the controller does, and the
			// controller binds this before it opens one.
			throw new InvariantViolation(
				"a workbench reported a splash before the terminal colours were bound",
			);
		}
		if (windowId === undefined || windowId !== binding.followed()) return;
		const request = ++this.requested;
		void binding
			.read(windowId)
			.then(terminalPaletteOf)
			.then(
				(palette) => {
					// A newer splash has asked again; its answer is the one that
					// stands, whichever finishes first.
					if (request !== this.requested) return;
					this.failing = false;
					this.adopt(palette, binding);
				},
				(error: unknown) => {
					if (!(error instanceof NamedFailure)) throw error;
					if (request !== this.requested || this.failing) return;
					this.failing = true;
					binding.failed(error);
				},
			);
	}

	private adopt(
		palette: TerminalPaletteWire,
		binding: TerminalColorsBinding,
	): void {
		if (JSON.stringify(palette) === JSON.stringify(this.current)) return;
		this.current = palette;
		this.save(palette);
		binding.changed();
	}
}

/**
 * Read a workbench's variables through its contents.
 *
 * Contents that are gone, a script that throws, and a page with no workbench
 * root are one failure: this workbench did not say what its theme is.
 */
export async function readThemeVariables(
	contents:
		| {
				isDestroyed(): boolean;
				executeJavaScript(code: string): Promise<unknown>;
		  }
		| undefined,
): Promise<ThemeVariables> {
	if (!contents || contents.isDestroyed()) {
		throw terminalColorsFailure(
			"Scratch's editor went away before it could be read.",
		);
	}
	let result: unknown;
	try {
		result = await contents.executeJavaScript(READ_THEME_VARIABLES_SCRIPT);
	} catch (error) {
		// Recovered by the caller: the panes keep their colours, and this is
		// said once.
		throw terminalColorsFailure(
			`Scratch's editor could not be read: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (
		typeof result !== "object" ||
		result === null ||
		!Object.values(result).every((value) => typeof value === "string")
	) {
		throw terminalColorsFailure(
			"Scratch's editor has no workbench to read the theme from.",
		);
	}
	return result as ThemeVariables;
}

const FILE_VERSION = 1;

/**
 * The palette kept in `terminal-colors.json` beside `state.json`, if any.
 *
 * A file that is not a palette is moved aside to `.corrupt` and the built-in
 * palettes stand in until the next read; `refused` says so, for the caller to
 * tell the person.
 */
export function loadTerminalColors(path: string): {
	readonly palette: TerminalPaletteWire | undefined;
	readonly refused: string | undefined;
} {
	if (!existsSync(path)) return { palette: undefined, refused: undefined };
	const palette = decodePalette(readFileSync(path, "utf8"));
	if (palette) return { palette, refused: undefined };
	const aside = `${path}.corrupt`;
	renameSync(path, aside);
	return {
		palette: undefined,
		refused: `${path} did not hold terminal colours and was moved to ${aside}.`,
	};
}

/**
 * Keep a palette for the next run. Written whole (a temporary file renamed
 * over it) and synchronously, like the drafts: it changes only when the theme
 * does.
 */
export function saveTerminalColors(
	path: string,
	palette: TerminalPaletteWire,
): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp`;
	writeFileSync(
		temporary,
		`${JSON.stringify({ version: FILE_VERSION, palette }, null, 2)}\n`,
	);
	renameSync(temporary, path);
}

function decodePalette(text: string): TerminalPaletteWire | undefined {
	let document: unknown;
	try {
		document = JSON.parse(text);
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
	if (typeof document !== "object" || document === null) return undefined;
	const { version, palette } = document as Record<string, unknown>;
	if (version !== FILE_VERSION || typeof palette !== "object" || !palette) {
		return undefined;
	}
	const candidate = palette as Record<string, unknown>;
	const strings = [
		"background",
		"foreground",
		"cursor",
		"cursorText",
		"selectionBackground",
	].every((key) => typeof candidate[key] === "string");
	const selection = candidate["selectionForeground"];
	const ansi = candidate["ansi"];
	if (
		!strings ||
		(selection !== undefined && typeof selection !== "string") ||
		!Array.isArray(ansi) ||
		!ansi.every((color) => typeof color === "string")
	) {
		return undefined;
	}
	const decoded: TerminalPaletteWire = {
		background: candidate["background"] as string,
		foreground: candidate["foreground"] as string,
		cursor: candidate["cursor"] as string,
		cursorText: candidate["cursorText"] as string,
		selectionBackground: candidate["selectionBackground"] as string,
		selectionForeground: selection,
		ansi: ansi as string[],
	};
	return terminalPaletteIsValid(decoded) ? decoded : undefined;
}

let current: TerminalColors | undefined;

/** Made once, in `bootstrapShell`, before the shell window exists. */
export function installTerminalColors(colors: TerminalColors): void {
	if (current) {
		throw new InvariantViolation("the terminal colours are already installed");
	}
	current = colors;
}

export function terminalColors(): TerminalColors {
	if (!current) {
		throw new InvariantViolation("the terminal colours are not installed");
	}
	return current;
}

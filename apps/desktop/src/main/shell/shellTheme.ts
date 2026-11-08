/**
 * The colour theme DevHub wears, and everything painted from it.
 *
 * `[appearance] theme` selects a theme for each appearance — one name for
 * both, or `light:<name>,dark:<name>` — among the built-in ones and the
 * file's own `[themes.<name>]` (`model/themes/theme.ts`); the appearance the
 * process is in (`appearance.mode`, `appearanceMode.ts`) picks the half.
 * From that one theme:
 *
 * - the shell's palette (`palette()`): the window, every DevHub page, the
 *   questions' dim;
 * - DevHub's terminals (`terminalPalette()`): the theme's own colours;
 * - the published theme (`themePublication.ts`) and with it the Neovims
 *   DevHub draws (`model/themes/neovimColorscheme.ts`).
 *
 * A VS Code workbench is not told anything: with `editor = "vscode"` it
 * keeps the theme its own settings name.
 */

import type { TerminalPaletteWire } from "../../ipc/appShell.js";
import type { ShellPalette } from "../../ipc/palette.js";
import {
	DEFAULT_DARK_THEME,
	DEFAULT_LIGHT_THEME,
	shellPaletteOfTheme,
	terminalPaletteOfTheme,
	ThemeCatalog,
	themeKindOf,
	type CatalogTheme,
	type Theme,
	type ThemeKind,
	type ThemeOrigin,
	type ThemeSelection,
} from "../../model/themes/theme.js";
import { InvariantViolation } from "../../model/invariant.js";

/** One theme that can be worn, for a list to choose from. */
export interface AvailableTheme {
	readonly name: string;
	readonly kind: ThemeKind;
	readonly origin: ThemeOrigin;
}

interface Worn {
	readonly theme: CatalogTheme;
	readonly palette: ShellPalette;
	readonly terminal: TerminalPaletteWire;
}

function worn(theme: CatalogTheme): Worn {
	return {
		theme,
		palette: shellPaletteOfTheme(theme),
		terminal: terminalPaletteOfTheme(theme),
	};
}

/**
 * A theme worn for this session only, over what the settings name: the one
 * being looked at while the Theme: Preview… picker moves (`preview`), or the
 * one it chose (`session`). Neither is written anywhere; the next time the
 * settings are applied — a save, a reload, a restart — it is gone.
 */
export type TemporaryThemeKind = "preview" | "session";

interface Temporary {
	readonly worn: Worn;
	readonly kind: TemporaryThemeKind;
}

const DEFAULT_SELECTION: ThemeSelection = {
	light: DEFAULT_LIGHT_THEME,
	dark: DEFAULT_DARK_THEME,
};

export class ShellTheme {
	private catalog: ThemeCatalog;
	private dark: Worn;
	private light: Worn;
	private temporary: Temporary | undefined;
	private changed: (() => void) | undefined;
	private announced: string;
	/** Problems not yet said, and every one already said (said once each). */
	private readonly pending: string[] = [];
	private readonly said = new Set<string>();

	/** @param prefersDark Whether the process is in the dark appearance. */
	constructor(
		private readonly prefersDark: () => boolean,
		selection: ThemeSelection = DEFAULT_SELECTION,
		custom: readonly Theme[] = [],
	) {
		this.catalog = new ThemeCatalog(custom);
		this.dark = this.read(selection.dark, DEFAULT_DARK_THEME, "dark");
		this.light = this.read(selection.light, DEFAULT_LIGHT_THEME, "light");
		this.announced = this.key();
	}

	/** The settings, read again — at startup, and every time they are saved. */
	configure(selection: ThemeSelection, custom: readonly Theme[]): void {
		this.catalog = new ThemeCatalog(custom);
		this.dark = this.read(selection.dark, DEFAULT_DARK_THEME, "dark");
		this.light = this.read(selection.light, DEFAULT_LIGHT_THEME, "light");
		// The settings are the answer again: a theme worn for the session
		// only lasts until they are next applied.
		this.temporary = undefined;
		this.announce();
	}

	/**
	 * Wear `name` for this session only, whatever the appearance, without
	 * touching the settings — or, with `undefined`, go back to what they
	 * name. Throws, with a sentence for the person, when no theme is called
	 * that; what is worn then is unchanged.
	 */
	wearTemporarily(name: string | undefined, kind: TemporaryThemeKind): void {
		if (name === undefined) {
			this.temporary = undefined;
		} else {
			const theme = this.catalog.find(name);
			if (!theme) throw new Error(`No colour theme is called '${name}'.`);
			this.temporary = { worn: worn(theme), kind };
		}
		this.announce();
	}

	/** Every theme that can be worn now. */
	available(): readonly AvailableTheme[] {
		return this.catalog.list().map((theme) => ({
			name: theme.name,
			kind: themeKindOf(theme),
			origin: theme.origin,
		}));
	}

	/** What the settings name for the appearance the process is in now. */
	configuredName(): string {
		return (this.prefersDark() ? this.dark : this.light).theme.name;
	}

	/** What is worn for the session only, if anything, and how. */
	temporaryTheme():
		| { readonly name: string; readonly kind: TemporaryThemeKind }
		| undefined {
		const temporary = this.temporary;
		return (
			temporary && { name: temporary.worn.theme.name, kind: temporary.kind }
		);
	}

	/** The name of the theme worn now: the temporary one, else the settings'. */
	wornName(): string {
		return this.current().theme.name;
	}

	/** The theme worn now, itself. */
	wornTheme(): CatalogTheme {
		return this.current().theme;
	}

	/** The OS appearance (or `appearance.mode`) changed. */
	appearanceChanged(): void {
		this.announce();
	}

	/** The palette the window and every DevHub page wear. */
	palette(): ShellPalette {
		return this.current().palette;
	}

	/** DevHub's terminals' colours under the theme worn now. */
	terminalPalette(): TerminalPaletteWire {
		return this.current().terminal;
	}

	/** Who to tell when any of the above changed. */
	onDidChange(listener: () => void): void {
		if (this.changed) {
			throw new InvariantViolation("the shell theme already has a listener");
		}
		this.changed = listener;
	}

	/** What could not be worn since the last call, each said once. */
	takeProblems(): readonly string[] {
		return this.pending.splice(0);
	}

	private current(): Worn {
		if (this.temporary) return this.temporary.worn;
		return this.prefersDark() ? this.dark : this.light;
	}

	private read(name: string, fallback: string, half: "dark" | "light"): Worn {
		const named = this.catalog.find(name);
		if (named) return worn(named);
		this.problem(
			`No colour theme is called '${name}' (the ${half} half of appearance.theme); DevHub wears '${fallback}' instead.`,
		);
		const instead = this.catalog.find(fallback);
		if (!instead) {
			throw new InvariantViolation(`the built-in theme ${fallback} is missing`);
		}
		return worn(instead);
	}

	private problem(detail: string): void {
		if (this.said.has(detail)) return;
		this.said.add(detail);
		this.pending.push(detail);
	}

	private key(): string {
		return JSON.stringify([this.current().theme, this.palette()]);
	}

	private announce(): void {
		const next = this.key();
		if (next === this.announced) return;
		this.announced = next;
		this.changed?.();
	}
}

let current: ShellTheme | undefined;

/** Made once, in `bootstrapShell`, before the shell window exists. */
export function installShellTheme(theme: ShellTheme): void {
	if (current) {
		throw new InvariantViolation("the shell theme is already installed");
	}
	current = theme;
}

export function shellTheme(): ShellTheme {
	if (!current) {
		throw new InvariantViolation("the shell theme is not installed");
	}
	return current;
}

/** Whether there is one yet: tests build a window without a theme. */
export function shellThemeIfInstalled(): ShellTheme | undefined {
	return current;
}

/**
 * Where DevHub's colours come from: the colour theme DevHub's own settings
 * name.
 *
 * `[appearance] theme_dark` and `theme_light` name a VS Code colour theme each
 * (VS Code's defaults unless the person says otherwise), and the appearance
 * the process is in (`appearance.mode`, `appearanceMode.ts`) picks one.
 * DevHub reads that theme itself — `colorThemeCatalog.ts` finds it among the
 * built-in and installed extensions and reads its file, and
 * `model/colorTheme.ts` fills in what it leaves unset from VS Code's own
 * registered defaults — and paints from it:
 *
 * - the shell's palette (`palette()`): the window, every DevHub page, the
 *   questions' dim;
 * - the Agent panes' terminal colours (`terminalPalette()`), with
 *   `[appearance] terminal_theme = "vscode"`;
 * - and every workbench (`workbenchThemes()`), which is told to wear the same
 *   theme (`workbenchColorTheme.ts`), so the editor and the frame around it
 *   cannot disagree.
 *
 * It used to be the other way round: the shell followed the window splash
 * each workbench reported, and the panes read `--vscode-terminal-*` out of a
 * workbench's page and cached the answer on disk for when none was awake. The
 * theme is now known before any workbench exists and while every one is
 * asleep, so neither the splash nor the cache is needed.
 */

import type { TerminalPaletteWire } from "../../ipc/appShell.js";
import type { ShellPalette } from "../../ipc/palette.js";
import {
	ResolvedColorTheme,
	shellPaletteOfTheme,
	terminalPaletteOfTheme,
	type ColorThemeDefinition,
	type ColorThemeType,
} from "../../model/colorTheme.js";
import { DEFAULT_THEME_DARK, DEFAULT_THEME_LIGHT } from "../../model/config.js";
import { InvariantViolation } from "../../model/invariant.js";

/** The two names, as the settings say them. */
export interface ColorThemeNames {
	readonly dark: string;
	readonly light: string;
}

/** What a workbench is told to wear, as `workbench.colorTheme` spells it. */
export interface WorkbenchColorThemes {
	readonly dark: string;
	readonly light: string;
	/** The one for the appearance the process is in now. */
	readonly current: string;
}

/**
 * Reading a theme by name: its definition, or `undefined` when no installed
 * extension contributes one by that name. A theme that is there and cannot be
 * read throws, with a sentence for the person.
 */
export type ColorThemeLoader = (
	name: string,
) => ColorThemeDefinition | undefined;

interface Worn {
	readonly theme: ResolvedColorTheme;
	readonly palette: ShellPalette;
	readonly terminal: TerminalPaletteWire;
}

function worn(definition: ColorThemeDefinition): Worn {
	const theme = new ResolvedColorTheme(definition);
	return {
		theme,
		palette: shellPaletteOfTheme(theme),
		terminal: terminalPaletteOfTheme(theme),
	};
}

export class ShellTheme {
	private dark: Worn;
	private light: Worn;
	private changed: (() => void) | undefined;
	private announced: string;
	/** Problems not yet said, and every one already said (said once each). */
	private readonly pending: string[] = [];
	private readonly said = new Set<string>();

	/**
	 * @param loader A reader of the themes installed now — asked for afresh
	 *   each time the names are read, so one listing serves both names.
	 * @param prefersDark Whether the process is in the dark appearance.
	 */
	constructor(
		private readonly loader: () => ColorThemeLoader,
		private readonly prefersDark: () => boolean,
		names: ColorThemeNames = {
			dark: DEFAULT_THEME_DARK,
			light: DEFAULT_THEME_LIGHT,
		},
	) {
		const load = loader();
		this.dark = this.read(load, names.dark, DEFAULT_THEME_DARK, "dark");
		this.light = this.read(load, names.light, DEFAULT_THEME_LIGHT, "light");
		this.announced = this.key();
	}

	/**
	 * The names the settings give, read again — at startup, and every time the
	 * settings are saved. The files are read again too, so a theme installed
	 * since is found by saving the setting that names it.
	 */
	configure(names: ColorThemeNames): void {
		const load = this.loader();
		this.dark = this.read(load, names.dark, DEFAULT_THEME_DARK, "dark");
		this.light = this.read(load, names.light, DEFAULT_THEME_LIGHT, "light");
		this.announce();
	}

	/** The OS appearance (or `appearance.mode`) changed. */
	appearanceChanged(): void {
		this.announce();
	}

	/** The palette the window and every DevHub page wear. */
	palette(): ShellPalette {
		return this.current().palette;
	}

	/** The Agent panes' colours under the theme worn now. */
	terminalPalette(): TerminalPaletteWire {
		return this.current().terminal;
	}

	/** What every workbench is told to wear. */
	workbenchThemes(): WorkbenchColorThemes {
		const dark = this.dark.theme.definition.settingsId;
		const light = this.light.theme.definition.settingsId;
		return { dark, light, current: this.prefersDark() ? dark : light };
	}

	/** Who to tell when any of the above changed. */
	onDidChange(listener: () => void): void {
		if (this.changed) {
			throw new InvariantViolation("the shell theme already has a listener");
		}
		this.changed = listener;
	}

	/**
	 * What could not be worn since the last call, each said once: a name no
	 * installed theme has, or a theme file that would not read.
	 */
	takeProblems(): readonly string[] {
		return this.pending.splice(0);
	}

	private current(): Worn {
		return this.prefersDark() ? this.dark : this.light;
	}

	private read(
		load: ColorThemeLoader,
		name: string,
		fallback: string,
		half: "dark" | "light",
	): Worn {
		const attempt = (candidate: string): ColorThemeDefinition | undefined => {
			try {
				const definition = load(candidate);
				if (!definition) {
					this.problem(
						`No installed colour theme is called '${candidate}' (appearance.theme_${half}).`,
					);
				}
				return definition;
			} catch (error) {
				if (!(error instanceof Error)) throw error;
				this.problem(error.message);
				return undefined;
			}
		};
		const named = attempt(name);
		if (named) return worn(named);
		if (name !== fallback) {
			const instead = attempt(fallback);
			if (instead) return worn(instead);
		}
		// Not even VS Code's own default is there — a checkout without its
		// built-in extensions, say. The registry's defaults for that half are
		// still VS Code's colours, so they are what is worn.
		const type: ColorThemeType = half;
		return worn({ settingsId: fallback, label: fallback, type, colors: {} });
	}

	private problem(detail: string): void {
		if (this.said.has(detail)) return;
		this.said.add(detail);
		this.pending.push(detail);
	}

	private key(): string {
		return JSON.stringify([
			this.palette(),
			this.terminalPalette(),
			this.workbenchThemes(),
		]);
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

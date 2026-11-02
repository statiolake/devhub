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

/** One theme that can be worn, for a list to choose from. */
export interface AvailableColorTheme {
	/** What the settings name it by. */
	readonly name: string;
	readonly label: string;
	readonly type: ColorThemeType;
	/** `publisher.name` of the extension that contributes it. */
	readonly extension: string;
	/** Where it was found: VS Code's own, DevHub's library, or installed. */
	readonly source: "builtin" | "devhub" | "extension";
}

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

export class ShellTheme {
	private dark: Worn;
	private light: Worn;
	private temporary: Temporary | undefined;
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
		private readonly catalog: () => readonly AvailableColorTheme[] = () => [],
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
		// The settings are the answer again: a theme worn for the session
		// only lasts until they are next applied.
		this.temporary = undefined;
		this.announce();
	}

	/**
	 * Wear `name` for this session only, whatever the appearance, without
	 * touching the settings — or, with `undefined`, go back to what they
	 * name. Throws, with a sentence for the person, when no installed theme
	 * is called that or its file will not read; what is worn then is
	 * unchanged.
	 */
	wearTemporarily(name: string | undefined, kind: TemporaryThemeKind): void {
		if (name === undefined) {
			this.temporary = undefined;
		} else {
			const definition = this.loader()(name);
			if (!definition) {
				throw new Error(`No installed colour theme is called '${name}'.`);
			}
			this.temporary = { worn: worn(definition), kind };
		}
		this.announce();
	}

	/** Every theme that can be worn now, read afresh. */
	available(): readonly AvailableColorTheme[] {
		return this.catalog();
	}

	/** What the settings name for the appearance the process is in now. */
	configuredName(): string {
		return (this.prefersDark() ? this.dark : this.light).theme.definition
			.settingsId;
	}

	/** What is worn for the session only, if anything, and how. */
	temporaryTheme():
		| { readonly name: string; readonly kind: TemporaryThemeKind }
		| undefined {
		const temporary = this.temporary;
		return (
			temporary && {
				name: temporary.worn.theme.definition.settingsId,
				kind: temporary.kind,
			}
		);
	}

	/** The name of the theme worn now: the temporary one, else the settings'. */
	wornName(): string {
		return this.current().theme.definition.settingsId;
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
		if (this.temporary) {
			// One theme, both halves: the workbench's own appearance switch
			// must not take it out of the theme being looked at.
			const only = this.temporary.worn.theme.definition.settingsId;
			return { dark: only, light: only, current: only };
		}
		const dark = this.dark.theme.definition.settingsId;
		const light = this.light.theme.definition.settingsId;
		return { dark, light, current: this.prefersDark() ? dark : light };
	}

	/**
	 * The theme a workbench wears now, resolved: what one that is starting is
	 * handed, so that its first frame is already in it
	 * (`workbenchStartTheme.ts`).
	 */
	workbenchColorTheme(): ResolvedColorTheme {
		return this.current().theme;
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
		if (this.temporary) return this.temporary.worn;
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

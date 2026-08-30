/**
 * Where the shell's colours come from.
 *
 * DevHub's chrome follows the Workbench's colour theme, and the Workbench tells
 * the main process what that theme looks like all by itself: on every theme
 * change VS Code's `PartsSplash` contribution sends the window splash — the
 * editor, title bar, activity bar, side bar and status bar backgrounds, plus
 * the foreground — to `IThemeMainService`, which stores it so the *next* launch
 * can paint a window before the workbench in it has loaded. DevHub reads the
 * same record for the same reason, one layer out.
 *
 * So there is nothing to scrape and nothing to ask a view for. This class is
 * only the join: it takes the splashes as they are reported, decides which one
 * the shell is wearing, and says when that answer changed.
 */

import type { IPartsSplash } from "code-oss-dev/out/vs/platform/theme/common/themeService.js";
import {
	isPaletteColor,
	type ShellPalette,
	type ShellPaletteBase,
} from "../../ipc/palette.js";

/**
 * Several workbenches, one shell: the selected workbench's theme wins.
 *
 * They share one user profile, so in the ordinary case they agree and the rule
 * never has to decide anything. It still has to exist, because a folder can
 * set `workbench.colorTheme` in its own `.vscode/settings.json` and then they
 * genuinely disagree — and at that point the only defensible answer is the one
 * the person is looking at. A workbench nobody has on screen cannot recolour
 * the window around it.
 *
 * Until the selected workbench has reported a splash of its own — the first
 * seconds of its life, and every workbench that has never been opened — the
 * shell wears the palette VS Code stored at the last quit. That is the whole
 * of what keeps the window from changing colour while it starts.
 */
export class ShellTheme {
	private readonly reported = new Map<number, ShellPalette>();
	private stored: ShellPalette | undefined;
	private selected: () => number | undefined = () => undefined;
	private changed: ((palette: ShellPalette) => void) | undefined;
	private announced: string | undefined;

	/**
	 * The palette the pages and the window are wearing right now.
	 *
	 * `undefined` is a real answer and means exactly one thing: this profile has
	 * never run a workbench, so there is no theme to follow yet. The tokens keep
	 * their own light/dark defaults until one does.
	 */
	palette(): ShellPalette | undefined {
		const selected = this.selected();
		const fromSelected =
			selected === undefined ? undefined : this.reported.get(selected);
		return fromSelected ?? this.stored;
	}

	/**
	 * The palette VS Code stored at the last quit, and the selection to follow.
	 *
	 * Called once, before the shell window exists, because the window is created
	 * with this palette's background and the page is served with its variables
	 * already in the `<head>`.
	 */
	restore(
		stored: IPartsSplash | undefined,
		selected: () => number | undefined,
	): ShellPalette | undefined {
		this.stored = stored ? paletteOf(stored) : undefined;
		this.selected = selected;
		this.announced = key(this.palette());
		return this.palette();
	}

	/** Who to tell when the answer changes. */
	onDidChange(listener: (palette: ShellPalette) => void): void {
		if (this.changed) {
			throw new Error("the shell theme already has a listener");
		}
		this.changed = listener;
	}

	/** A workbench said what it looks like. */
	reportSplash(windowId: number | undefined, splash: IPartsSplash): void {
		const palette = paletteOf(splash);
		if (!palette) return;
		// The stored palette follows every report, not only the selected one:
		// it is the answer for "no workbench has said anything yet", and the
		// most recent theme any workbench wore is a better guess than an older
		// one from a workbench that may never open again.
		this.stored = palette;
		if (windowId !== undefined) {
			this.reported.set(windowId, palette);
		}
		this.announce();
	}

	/** A workbench went away; its palette goes with it. */
	forgetWindow(windowId: number): void {
		if (this.reported.delete(windowId)) {
			this.announce();
		}
	}

	/** The workbench on screen changed, so the answer may have changed with it. */
	selectionChanged(): void {
		this.announce();
	}

	private announce(): void {
		const palette = this.palette();
		if (!palette) return;
		const next = key(palette);
		if (next === this.announced) return;
		this.announced = next;
		this.changed?.(palette);
	}
}

/**
 * The splash, as the four colours DevHub actually draws with.
 *
 * A theme extension writes these, so each one is checked before it can reach a
 * stylesheet; a splash carrying anything that is not a colour is refused whole
 * rather than half-applied, and the shell keeps the palette it had.
 */
export function paletteOf(splash: IPartsSplash): ShellPalette | undefined {
	const colors = splash.colorInfo;
	const base = baseOf(splash.baseTheme);
	const palette: ShellPalette = {
		base,
		surface: colors.editorBackground ?? colors.background,
		chrome:
			colors.sideBarBackground ??
			colors.titleBarBackground ??
			colors.background,
		canvas:
			colors.titleBarBackground ??
			colors.sideBarBackground ??
			colors.background,
		ink: colors.foreground ?? (base === "dark" ? "#cccccc" : "#3b3b3b"),
	};
	const bad = [
		palette.surface,
		palette.chrome,
		palette.canvas,
		palette.ink,
	].filter((color) => !isPaletteColor(color));
	if (bad.length > 0) {
		// Not a state to work around and not a reason to stop: the theme is
		// wrong, the shell says so and keeps the last palette it trusted.
		console.warn(
			`[devhub] theme: ignoring a window splash with unusable colours: ${bad.join(", ")}`,
		);
		return undefined;
	}
	return palette;
}

/**
 * `ThemeTypeSelector` is `vs` | `vs-dark` | `hc-black` | `hc-light`; the shell
 * only needs to know which half of every `light-dark()` token applies.
 */
function baseOf(baseTheme: string): ShellPaletteBase {
	return baseTheme === "vs" || baseTheme === "hc-light" ? "light" : "dark";
}

function key(palette: ShellPalette | undefined): string | undefined {
	return palette && JSON.stringify(palette);
}

let current: ShellTheme | undefined;

export function shellTheme(): ShellTheme {
	current ??= new ShellTheme();
	return current;
}

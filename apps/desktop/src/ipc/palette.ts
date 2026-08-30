/**
 * The shell's palette: the active VS Code colour theme, expressed as tokens.
 *
 * DevHub's chrome is not a second application beside the Workbench, it is the
 * frame around it, so it takes its colours from whatever theme the Workbench is
 * wearing. The colours come from VS Code's own record of that theme — the
 * window splash it writes to main-process state (`IPartsSplash`) — and never
 * from reading CSS out of a view.
 *
 * Only four colours cross the wire. Everything else DevHub draws is derived
 * from them here, in one place, so that main (which writes the palette into the
 * page's HTML before the first paint) and the page (which updates it when the
 * theme changes) can never disagree about what a palette means.
 */

/** Which half of every `light-dark()` token in `tokens.css` applies. */
export type ShellPaletteBase = "light" | "dark";

export interface ShellPalette {
	readonly base: ShellPaletteBase;
	/** The Workbench's editor background: the ground content is drawn on. */
	readonly surface: string;
	/** The Workbench's side bar: DevHub's Sidebar and titlebar band. */
	readonly chrome: string;
	/** The Workbench's title bar: the window ground behind everything. */
	readonly canvas: string;
	/** The Workbench's foreground: every ink and hairline is derived from it. */
	readonly ink: string;
}

/**
 * A colour DevHub is willing to put into a stylesheet.
 *
 * The values originate in a theme extension, which is not DevHub's code, and
 * they are written into CSS text before the first paint. Anything that is not
 * plainly a colour is refused rather than escaped: there is no legitimate theme
 * colour this rejects, and no string this accepts can end a declaration.
 */
const COLOR = /^(#[0-9a-fA-F]{3,8}|rgba?\([0-9.,%\s/]+\))$/;

export function isPaletteColor(value: string): boolean {
	return COLOR.test(value);
}

/**
 * The custom properties one palette sets, as CSS declarations.
 *
 * Five, and no more. `tokens.css` already derives every hairline, wash and
 * secondary ink from `--primary`, and `--raised`/`--sunken` from `--surface`,
 * because those relationships are the same on any material — so a theme only
 * has to say where the four anchors are and the derivation is untouched. That
 * is also what keeps Increase Contrast working: it adjusts the strengths, in
 * the one place they are written, and a palette never overrides it.
 *
 * `color-scheme` is the fifth and the most load-bearing: it decides which half
 * of every remaining `light-dark()` token applies — the accent, the status
 * colours, the shadows, the ink strengths — so a theme that only flips light to
 * dark is already right after this line alone.
 */
export function paletteVariables(
	palette: ShellPalette,
): ReadonlyArray<readonly [string, string]> {
	return [
		["color-scheme", palette.base],
		["--canvas", palette.canvas],
		["--chrome", palette.chrome],
		["--surface", palette.surface],
		["--primary", palette.ink],
	];
}

/**
 * The palette as a stylesheet, for a page that has not run any script yet.
 *
 * Main puts this in the page's `<head>` as it serves it, which is what makes
 * the window come up in the theme it quit in instead of flashing a default and
 * correcting itself once the first snapshot arrives.
 */
export function paletteStyleSheet(palette: ShellPalette): string {
	const declarations = paletteVariables(palette)
		.map(([name, value]) => `${name}: ${value};`)
		.join("\n  ");
	return `:root {\n  ${declarations}\n}`;
}

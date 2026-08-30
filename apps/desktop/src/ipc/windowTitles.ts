/**
 * What each of DevHub's windows is called.
 *
 * Two processes need this and they need it at different moments, which is why
 * it is stated here rather than in either of them. Main sets the title when it
 * creates the window, so the window has a name before its page exists; the page
 * sets `document.title` when it loads, because Electron applies a page's title
 * to its window and would otherwise overwrite whatever main chose. Both windows
 * are served from the same `index.html`, so without this the Settings window
 * inherited the shell's title and called itself "DevHub".
 *
 * These are the names macOS shows in Mission Control, in the Window menu and in
 * the window switcher. They are *not* the application's name: that comes from
 * the running bundle, and in development the bundle is VS Code's own.
 * `app.setName` in `main.ts` says what can be done about it.
 */

/** The `?window=` value each surface is served with; the shell has none. */
export type ShellWindowKind = "shell" | "settings" | "overlay";

export const WINDOW_TITLES: Readonly<Record<ShellWindowKind, string>> = {
	shell: "DevHub",
	settings: "DevHub Settings",
	// The overlay is a view inside the shell window rather than a window of its
	// own, so nothing displays this. It is here so the page can set a title
	// unconditionally instead of branching on which surface may have one.
	overlay: "DevHub",
};

/** Which surface a page URL asks for. Anything unrecognised is the shell. */
export function windowKindOf(search: string): ShellWindowKind {
	const which = new URLSearchParams(search).get("window");
	return which === "settings" || which === "overlay" ? which : "shell";
}

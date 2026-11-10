/**
 * The menu bar of a DevHub window, where the window carries its own.
 *
 * On macOS the menu is the system's, at the top of the screen, and a window
 * has none. On Linux Electron draws it as a bar in every window, painted by
 * the GTK theme — not by DevHub's, and not by `nativeTheme.themeSource`
 * either: with the appearance set to Dark the window went dark under a white
 * bar. So the bar is hidden until Alt is pressed, which is GTK's own way to
 * reach it from the keyboard: nothing in the menu is lost, and every command
 * in it is also in the command palette and on its chord.
 *
 * (`GTK_THEME=<theme>:dark` at launch would paint the bar dark instead, but
 * only as it was when DevHub started, never following a change.)
 */
export function menuBarOptions(
	platform: NodeJS.Platform = process.platform,
): Pick<Electron.BrowserWindowConstructorOptions, "autoHideMenuBar"> {
	return platform === "linux" ? { autoHideMenuBar: true } : {};
}

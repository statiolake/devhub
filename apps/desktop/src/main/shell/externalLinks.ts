/**
 * Where a URL that is not DevHub's own page goes: the system browser.
 *
 * DevHub draws exactly one kind of page — its own bundle, served from
 * `devhub-app:`. Everything else a page can reach is somebody else's document,
 * and the app has no chrome for one: no address bar, no back button, no
 * reload. Electron's defaults do not know that. A bare `window.open` from a
 * renderer makes a `BrowserWindow` out of nothing, with DevHub's preload and
 * DevHub's title, and drops a stranger's page into it — which is exactly the
 * small broken DevHub window a terminal hyperlink used to produce.
 *
 * So the rule is stated once, for every contents DevHub itself owns: a
 * navigation or a window request whose URL is not the shell's own scheme
 * leaves the app through `shell.openExternal`, and no window is ever minted.
 * It is deliberately not per-caller — a page choosing its own policy is how
 * one path ends up opening links correctly and another one silently does not.
 *
 * This is the backstop. The surfaces that *know* they are showing someone
 * else's link — a terminal's OSC 8 hyperlink — send it out over the
 * `openExternalUrl` channel themselves, so that a refusal is reported to the
 * person instead of disappearing into a handler nobody is awaiting.
 */

import { electron } from "../electron.js";
import { SHELL_SCHEME } from "./shellPageProtocol.js";

/**
 * Whether this URL is something to hand to the browser.
 *
 * Two things are not. DevHub's own page, on the scheme it owns, is the one
 * document these contents are allowed to be showing. And `about:blank` is not a
 * link at all — it is what a bare `window.open()` asks for, a blank window to
 * write into later, which is a request DevHub has no answer to; asking the
 * operating system to open it would be nonsense reaching the person as a
 * flickering browser tab.
 */
function leavesTheApp(url: string): boolean {
	return !url.startsWith(`${SHELL_SCHEME}:`) && !url.startsWith("about:");
}

/**
 * Make one of DevHub's own web contents send links to the browser.
 *
 * Called for the App Shell page and for the modal overlay — the two contents
 * whose documents DevHub wrote. Workbench views are VS Code's and keep VS
 * Code's own handling.
 */
export function sendLinksToTheBrowser(contents: Electron.WebContents): void {
	contents.setWindowOpenHandler(({ url }) => {
		if (leavesTheApp(url)) void electron.shell.openExternal(url);
		// Never `allow`. There is no second DevHub window, and a window with
		// somebody else's page in it wearing DevHub's preload is worse than no
		// window at all.
		return { action: "deny" };
	});
	contents.on("will-navigate", (event, url) => {
		if (!leavesTheApp(url)) return;
		// The page replacing itself with a stranger's document would take the
		// sidebar, the surfaces and every live attachment with it.
		event.preventDefault();
		void electron.shell.openExternal(url);
	});
}

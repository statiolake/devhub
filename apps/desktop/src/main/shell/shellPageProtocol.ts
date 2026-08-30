/**
 * The App Shell page has a scheme of its own.
 *
 * `file:` is refused outright by VS Code's protocol service, and `vscode-file:`
 * is served only to frames belonging to a window VS Code knows about — a rule
 * about VS Code's own resources that DevHub's page has no business borrowing.
 * So DevHub serves its page from `devhub-app:`, a scheme it owns, registered as
 * privileged in the bootstrap and answered here out of one directory and
 * nowhere else. The bytes are read directly rather than fetched through
 * `file:`, which VS Code has already intercepted and blocked.
 */

import { readFile } from "node:fs/promises";
import { extname, normalize, sep } from "node:path";
import { electron } from "../electron.js";
import { paletteStyleSheet, type ShellPalette } from "../../ipc/palette.js";

export const SHELL_SCHEME = "devhub-app";
export const SHELL_ORIGIN = `${SHELL_SCHEME}://shell`;

/** The page is a Vite bundle: HTML, one script, one stylesheet, maybe fonts. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".woff2": "font/woff2",
};

/**
 * Serve the page, already wearing the current theme.
 *
 * The palette is written into the HTML rather than fetched by the page once it
 * runs, because the point of persisting it is that the window never shows a
 * colour it is about to change: a page that asks for its palette has already
 * painted by the time the answer arrives. Every page this scheme serves gets
 * it — the App Shell, the modal overlay and the Settings window are one bundle
 * under three query strings, and all three are DevHub chrome.
 */
export function registerShellPageProtocol(
	root: string,
	palette: () => ShellPalette | undefined,
): void {
	const base = normalize(root).replace(new RegExp(`${sep}$`), "");

	electron.protocol.handle(SHELL_SCHEME, async (request) => {
		const url = new URL(request.url);
		const path = normalize(`${base}${decodeURIComponent(url.pathname)}`);
		if (path !== base && !path.startsWith(base + sep)) {
			// Not a mistake to route around: something asked this scheme for a
			// file outside the page's own directory.
			throw new Error(
				`${SHELL_SCHEME}: refused ${request.url} — outside the App Shell page directory`,
			);
		}

		const contentType = CONTENT_TYPES[extname(path).toLowerCase()];
		if (!contentType) {
			throw new Error(`${SHELL_SCHEME}: no content type for ${request.url}`);
		}

		const bytes = await readFile(path);
		const body =
			contentType === CONTENT_TYPES[".html"]
				? themed(bytes.toString("utf8"), palette())
				: bytes;

		return new Response(body, {
			headers: { "content-type": contentType },
		});
	});
}

/**
 * The page with the palette in it, or the page unchanged when there is none.
 *
 * No palette means this profile has never run a workbench, and the tokens'
 * own light/dark defaults are the honest answer until one does.
 *
 * `data-window-material` is the switch `tokens.css` and `shell.css` already
 * carry: the shell's Sidebar and titlebar are transparent so the window's
 * NSVisualEffectView shows through them, and a material follows the *system*
 * appearance, which a themed shell must not. So a themed window has no
 * material and the same chrome is painted from `--chrome` instead — which is
 * what those rules were written for.
 */
function themed(html: string, palette: ShellPalette | undefined): string {
	if (!palette) return html;

	const root = "<html ";
	const head = "</head>";
	if (!html.includes(root) || !html.includes(head)) {
		// The page is built by Vite from one `index.html` in this repo. If it
		// no longer has a root element or a head, the build changed and this
		// injection is silently doing nothing — which would show up as a window
		// that flashes the wrong colour and nowhere else.
		throw new Error(
			`${SHELL_SCHEME}: the App Shell page has no <html> or </head> to theme`,
		);
	}

	return html
		.replace(root, `${root}data-window-material="none" `)
		.replace(
			head,
			`  <style id="devhub-palette">\n${paletteStyleSheet(palette)}\n  </style>\n  ${head}`,
		);
}

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

export function registerShellPageProtocol(root: string): void {
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

		return new Response(await readFile(path), {
			headers: { "content-type": contentType },
		});
	});
}

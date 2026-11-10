/**
 * The tmux inside DevHub: tmux at the version `product.json` pins
 * (`tmuxVersion`), built by `scripts/build_tmux.py` for DevHub's tools
 * release — this machine's build of the one a Linux host is given — and
 * unpacked into `out/tmux` by `scripts/fetch-binaries.mjs` at build time:
 * `apps/desktop/out/tmux` in a checkout, `Contents/Resources/app/out/tmux` in
 * the packaged app, where packaging signs it (`scripts/package-nightly.py`).
 *
 * Every tmux DevHub runs on this machine is this one, never the PATH's: the
 * server and every command it is sent, the control clients, and the `tmux` a
 * DevHub pane, a popup or a binding's `run-shell` runs (the pane shim,
 * `terminalNeovimShim.ts`'s `tmuxShimScript`). One version on every machine,
 * as on a host (`Runtime.tmuxProgram`, `docs/terminal-mode.md`).
 */

import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { APP_ROOT } from "../shell/appRoot.js";

/** The directory the tarball is unpacked into: `bin/`, `terminfo/`, `licenses/`. */
export function bundledTmuxDirectory(appRoot = APP_ROOT): string {
	return join(appRoot, "out", "tmux");
}

/** `out/tmux/bin/tmux`, whether or not this build has one. */
export function bundledTmuxPath(appRoot = APP_ROOT): string {
	return join(bundledTmuxDirectory(appRoot), "bin", "tmux");
}

/** The bundled `tmux` when it is there and executable; `undefined` when not. */
export function bundledTmux(appRoot = APP_ROOT): string | undefined {
	const path = bundledTmuxPath(appRoot);
	try {
		accessSync(path, constants.X_OK);
		return path;
	} catch {
		return undefined;
	}
}

/** What a build without one is told. */
export function bundledTmuxMissing(appRoot = APP_ROOT): string {
	return (
		`This build of DevHub has no tmux (${bundledTmuxPath(appRoot)} is missing). ` +
		"A packaged DevHub carries one; in a checkout, `pnpm --filter @devhub/desktop build:binaries` fetches it."
	);
}

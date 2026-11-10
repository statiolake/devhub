/**
 * The Neovim inside DevHub: Neovim's own release archive for this platform,
 * at the version `product.json` pins (`nvimVersion`), unpacked into
 * `out/nvim` by `scripts/fetch-binaries.mjs` at build time — `apps/desktop/out/nvim`
 * in a checkout, `Contents/Resources/app/out/nvim` in the packaged app, where
 * packaging signs it (`scripts/package-nightly.py`).
 *
 * Every Neovim DevHub starts on this Mac is this one: the `devhub-nvim`
 * window's keeper, and the `nvim` a DevHub pane runs (the shim). It finds its
 * runtime beside itself (`share/nvim/runtime`), so `$VIMRUNTIME` is the
 * bundle's; the shim and the keeper unset an inherited one first.
 */

import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { APP_ROOT } from "../shell/appRoot.js";

/** The directory the archive is unpacked into: `bin/`, `lib/`, `share/`. */
export function bundledNeovimDirectory(appRoot = APP_ROOT): string {
	return join(appRoot, "out", "nvim");
}

/** `out/nvim/bin/nvim`, whether or not this build has one. */
export function bundledNeovimPath(appRoot = APP_ROOT): string {
	return join(bundledNeovimDirectory(appRoot), "bin", "nvim");
}

/** The bundled `nvim` when it is there and executable; `undefined` when not. */
export function bundledNeovim(appRoot = APP_ROOT): string | undefined {
	const path = bundledNeovimPath(appRoot);
	try {
		accessSync(path, constants.X_OK);
		return path;
	} catch {
		return undefined;
	}
}

/** What a build without one is told. */
export function bundledNeovimMissing(appRoot = APP_ROOT): string {
	return (
		`This build of DevHub has no Neovim (${bundledNeovimPath(appRoot)} is missing). ` +
		"A packaged DevHub carries one; in a checkout, `pnpm --filter @devhub/desktop build:binaries` fetches it."
	);
}

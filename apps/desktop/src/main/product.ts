/**
 * What DevHub says about itself: its names, where it keeps its tools on a
 * host, and the tmux and bash releases it installs there.
 *
 * One file, `product.json` beside `out/` — `apps/desktop/product.json` in a
 * checkout, `Contents/Resources/app/product.json` in the packaged app, where
 * scripts/package-nightly.py adds `version` and `commit`. Read once, at first
 * use, from `APP_ROOT`, so both layouts are the same read.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_ROOT } from "./shell/appRoot.js";

export interface DevhubProduct {
	readonly nameShort: string;
	readonly nameLong: string;
	readonly applicationName: string;
	/** The directory under a host's home DevHub installs its tools in. */
	readonly serverDataFolderName: string;
	readonly darwinBundleIdentifier: string;
	readonly tmuxVersion?: string;
	readonly tmuxDownloadUrlTemplate?: string;
	readonly tmuxDownloadSha256?: Readonly<Record<string, string>>;
	/** The bash a host with neither bash nor zsh gets, for Claude Code. */
	readonly bashVersion?: string;
	readonly bashDownloadUrlTemplate?: string;
	readonly bashDownloadSha256?: Readonly<Record<string, string>>;
	/** Where `docker` and `devcontainer` are, when they are not on `PATH`. */
	readonly dockerPath?: string;
	readonly devcontainerPath?: string;
	/** Only in a packaged app: the commit it was built from. */
	readonly commit?: string;
	/** Only in a packaged app: DevHub's version, with the build's date. */
	readonly version?: string;
}

let read: DevhubProduct | undefined;

export function devhubProduct(): DevhubProduct {
	read ??= JSON.parse(
		readFileSync(join(APP_ROOT, "product.json"), "utf8"),
	) as DevhubProduct;
	return read;
}

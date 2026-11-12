/**
 * What DevHub says about itself: its names, where it keeps its tools on a
 * host, and the versions of the binaries it bundles.
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
	/**
	 * The binaries the app build bundles (`scripts/fetch-binaries.mjs`,
	 * `docs/bundled-binaries.md`): each `<tool>Version`, and per `<os>-<arch>`
	 * its asset's URL and sha256. The app reads only the versions at runtime;
	 * what it runs and delivers is in `out/`, and nothing is downloaded.
	 *
	 * `tools` is DevHub's own release (`scripts/build_tools.py`) holding tmux
	 * and bash; `nvim`, `node`, `rg` and `fd` are upstream's.
	 */
	readonly toolsVersion?: string;
	readonly tmuxVersion?: string;
	/** The bash Claude Code runs in: delivered to hosts, and in the app here (`out/bash`). */
	readonly bashVersion?: string;
	readonly nvimVersion?: string;
	readonly nodeVersion?: string;
	readonly rgVersion?: string;
	readonly fdVersion?: string;
	/** Where `docker` and `devcontainer` are, when they are not on `PATH`. */
	readonly dockerPath?: string;
	readonly devcontainerPath?: string;
	/**
	 * The speech models voice input may download once the person turns it
	 * on, by id: label, file, URL, hash and size (`main/voice/voiceModels.ts`).
	 * The one thing DevHub downloads at runtime, and only on that yes.
	 */
	readonly whisperModels?: unknown;
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

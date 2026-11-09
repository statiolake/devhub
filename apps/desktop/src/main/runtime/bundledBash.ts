/**
 * The bash inside DevHub, unpacked into `out/bash` by
 * `scripts/fetch-bash.mjs` at build time — `apps/desktop/out/bash` in a
 * checkout, `Contents/Resources/app/out/bash` in the packaged app, where
 * packaging signs it (`scripts/package-nightly.py`).
 *
 * Every bash DevHub runs on this machine is this one, never one found on the
 * PATH (`docs/bundled-binaries.md`): today that is the shell Claude Code is
 * given (`CLAUDE_CODE_SHELL`, `LocalRuntime.claudeShell`). On an SSH host the
 * same bash is delivered (`toolDelivery.ts`).
 */

import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { APP_ROOT } from "../shell/appRoot.js";

/** `out/bash/bin/bash`, whether or not this build has one. */
export function bundledBashPath(appRoot = APP_ROOT): string {
	return join(appRoot, "out", "bash", "bin", "bash");
}

/** The bundled `bash` when it is there and executable; `undefined` when not. */
export function bundledBash(appRoot = APP_ROOT): string | undefined {
	const path = bundledBashPath(appRoot);
	try {
		accessSync(path, constants.X_OK);
		return path;
	} catch {
		return undefined;
	}
}

/** What a build without one is told. */
export function bundledBashMissing(appRoot = APP_ROOT): string {
	return (
		`This build of DevHub has no bash (${bundledBashPath(appRoot)} is missing), ` +
		"and Claude Code is given DevHub's own bash, never one from the PATH. " +
		"A packaged DevHub carries one; in a checkout, `pnpm --filter @devhub/desktop build:bash` fetches it."
	);
}

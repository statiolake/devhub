/**
 * The directory the running DevHub was built into: `apps/desktop` in a
 * checkout, `Contents/Resources/app` in a packaged app.
 *
 * Both layouts put the running main-process module three directories below
 * it — `apps/desktop/out/main/shell/*.js` in a checkout, and the bundle at
 * `Contents/Resources/app/node_modules/code-oss-dev/out/main.js` in a packaged
 * app (see `bundle_main_process` in scripts/package-nightly.py) — so three
 * `..` from here is right in both. Every path into the build output hangs off
 * this one value: a module that counts its own way from `import.meta.url`
 * finds the checkout's file and misses the packaged one.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ROOT = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
);

/** A helper `apps/desktop/scripts/build-native.mjs` built into `out/native`. */
export function nativeHelperPath(name: string): string {
	return join(APP_ROOT, "out", "native", name);
}

/**
 * The `devhub` command the tests that need the real one run: the app build's
 * (`out/cli/<this platform>/devhub`, built by `build:devhub-cli`, which `pnpm
 * test` runs first). Where it is missing the tests skip, except on CI (`CI`
 * set, as `scripts/test-local.sh` sets it too), where that fails.
 */

import { existsSync } from "node:fs";
import { APP_ROOT } from "../shell/appRoot.js";
import { cliBinaryPath } from "./install.js";

function testDevhub(): string | undefined {
	const path = cliBinaryPath(APP_ROOT);
	if (existsSync(path)) return path;
	if ((process.env.CI ?? "") !== "") {
		throw new Error(
			`This build has no devhub command (${path}): \`pnpm --filter @devhub/desktop build:devhub-cli\` builds it.`,
		);
	}
	return undefined;
}

export const TEST_DEVHUB = testDevhub();

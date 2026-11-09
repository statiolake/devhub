/**
 * The Neovim the tests that need a real one run: DevHub's own (`out/nvim`,
 * fetched by `build:nvim`, which `pnpm test` runs first), never the PATH's —
 * it is the one DevHub runs. Where it is missing the tests skip, except on CI
 * (`CI` set, as `scripts/test-local.sh` sets it too), where that fails.
 */

import { bundledNeovim, bundledNeovimMissing } from "./bundledNeovim.js";

function testNeovim(): string | undefined {
	const nvim = bundledNeovim();
	if (nvim === undefined && (process.env.CI ?? "") !== "") {
		throw new Error(bundledNeovimMissing());
	}
	return nvim;
}

export const TEST_NVIM = testNeovim();

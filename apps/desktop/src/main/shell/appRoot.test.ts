import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { APP_ROOT, nativeHelperPath } from "./appRoot.js";
import { ANCHOR_HELPER } from "./processGroupAnchor.js";

describe("APP_ROOT", () => {
	it("is apps/desktop in a checkout", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		expect(resolve(APP_ROOT)).toBe(resolve(here, "..", "..", ".."));
		expect(resolve(APP_ROOT).endsWith(join("apps", "desktop"))).toBe(true);
	});

	it("is where every native helper is looked for, the anchor included", () => {
		// The anchor once counted its own way to out/native and found the
		// checkout's helper but not the packaged app's, whose main process is
		// bundled into node_modules/code-oss-dev/out/main.js.
		expect(ANCHOR_HELPER).toBe(nativeHelperPath("devhub-pgrp-anchor"));
		expect(nativeHelperPath("devhub-pgrp-anchor")).toBe(
			join(APP_ROOT, "out", "native", "devhub-pgrp-anchor"),
		);
	});
});

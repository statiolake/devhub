import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { APP_ROOT, nativeHelperPath } from "./appRoot.js";

describe("APP_ROOT", () => {
	it("is apps/desktop in a checkout", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		expect(resolve(APP_ROOT)).toBe(resolve(here, "..", "..", ".."));
		expect(resolve(APP_ROOT).endsWith(join("apps", "desktop"))).toBe(true);
	});

	it("is where every native helper is looked for", () => {
		expect(nativeHelperPath("devhub-footprint")).toBe(
			join(APP_ROOT, "out", "native", "devhub-footprint"),
		);
	});
});

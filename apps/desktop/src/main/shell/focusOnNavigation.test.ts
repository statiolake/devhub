/**
 * No DevHub page takes the keyboard by loading: Electron focuses a view on
 * every navigation unless told not to, and that bypasses `focusSurface`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const here = import.meta.dirname;

describe("every WebContentsView DevHub makes", () => {
	for (const file of ["chromeView.ts", "layerView.ts"]) {
		it(`${file} turns off focusOnNavigation`, () => {
			const source = readFileSync(join(here, file), "utf8");
			expect(source).toMatch(/focusOnNavigation:\s*false/u);
		});
	}
});

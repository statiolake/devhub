import { describe, expect, it } from "vitest";
import { neovimOpenOf } from "./neovimOpen.js";

describe("an open, for the Neovim editor", () => {
	it("is the path, the cursor at a selection's start, and the wait marker", () => {
		const file = { path: "/src/a b.ts", exists: true, isDirectory: false };
		expect(neovimOpenOf(file, undefined, undefined)).toEqual({
			path: "/src/a b.ts",
		});
		expect(
			neovimOpenOf(
				file,
				{ line: 3, column: 7, end: { line: 9, column: 1 } },
				"/tmp/wait-1",
			),
		).toEqual({
			path: "/src/a b.ts",
			line: 3,
			column: 7,
			waitMarkerPath: "/tmp/wait-1",
		});
	});
});

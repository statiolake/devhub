import { describe, expect, it } from "vitest";
import { editorForOpen, neovimOpenOf } from "./neovimOpen.js";

describe("an open, for the Neovim editor", () => {
	it("goes to Neovim only when the setting says so", () => {
		expect(editorForOpen("neovim")).toBe("neovim");
		expect(editorForOpen("vscode")).toBe("workbench");
	});

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

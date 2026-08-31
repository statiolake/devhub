import { describe, expect, it } from "vitest";
import { parseFileAndPosition } from "./goto.js";

describe("FILE:LINE:COLUMN", () => {
	it("reads a file, a line and a column", () => {
		expect(parseFileAndPosition("src/main.ts:42:7")).toEqual({
			path: "src/main.ts",
			position: { line: 42, column: 7 },
		});
	});

	it("puts the cursor at the start of the line when no column is given", () => {
		expect(parseFileAndPosition("src/main.ts:42")).toEqual({
			path: "src/main.ts",
			position: { line: 42, column: 1 },
		});
	});

	it("leaves the cursor alone when no line is given", () => {
		expect(parseFileAndPosition("src/main.ts")).toEqual({
			path: "src/main.ts",
			position: undefined,
		});
	});

	/** A colon is a legal character in a path, so only numbers end the path. */
	it("keeps colons that are part of the path", () => {
		expect(parseFileAndPosition("/w/odd:name/a.ts")).toEqual({
			path: "/w/odd:name/a.ts",
			position: undefined,
		});
		expect(parseFileAndPosition("/w/odd:name/a.ts:3:4")).toEqual({
			path: "/w/odd:name/a.ts",
			position: { line: 3, column: 4 },
		});
	});

	/**
	 * Upstream's own parser accepts these and hands the editor a position that
	 * does not exist. Refusing them here is the difference between a report
	 * about a typo and a file that opens with the cursor mysteriously at the
	 * top.
	 */
	it("refuses a position that is not a place in a file", () => {
		expect(() => parseFileAndPosition("a.ts:")).toThrow(/FILE:LINE/);
		expect(() => parseFileAndPosition("a.ts:0")).toThrow(/FILE:LINE/);
		expect(() => parseFileAndPosition("a.ts:-3")).toThrow(/FILE:LINE/);
		expect(() => parseFileAndPosition("a.ts:2.5")).toThrow(/FILE:LINE/);
		expect(() => parseFileAndPosition("a.ts:3:0")).toThrow(/FILE:LINE/);
		expect(() => parseFileAndPosition("12")).toThrow(/FILE:LINE/);
	});
});

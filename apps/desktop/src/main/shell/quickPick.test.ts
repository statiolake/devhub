import { describe, expect, it } from "vitest";
import { quickPickRequestOf } from "./quickPick.js";

describe("quickPickRequestOf", () => {
	it("reads a select", () => {
		expect(
			quickPickRequestOf({
				title: "Neovim",
				question: "Pick one",
				rows: [{ label: "a" }, { label: "b", detail: "the second" }],
			}),
		).toEqual({
			title: "Neovim",
			question: "Pick one",
			rows: [{ label: "a" }, { label: "b", detail: "the second" }],
		});
	});

	it("reads an input, rows or not", () => {
		expect(
			quickPickRequestOf({ question: "Name?", input: { default: "x" } }),
		).toEqual({
			title: "Neovim",
			question: "Name?",
			rows: [],
			input: { default: "x" },
		});
	});

	it("is no question when the shape is wrong", () => {
		expect(quickPickRequestOf(undefined)).toBeUndefined();
		expect(quickPickRequestOf({ rows: [] })).toBeUndefined();
		expect(quickPickRequestOf({ rows: [{ label: 3 }] })).toBeUndefined();
	});
});

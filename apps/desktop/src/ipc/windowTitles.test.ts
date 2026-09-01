import { describe, expect, it } from "vitest";
import { shellWindowTitle } from "./windowTitles.js";

describe("the shell window's name", () => {
	it("names the element, the workspace and DevHub, in that order", () => {
		expect(
			shellWindowTitle({ element: "reconciler.ts", workspace: "devhub" }),
		).toBe("reconciler.ts — devhub — DevHub");
	});

	it("drops to the workspace and DevHub when nothing else is being shown", () => {
		expect(shellWindowTitle({ element: undefined, workspace: "devhub" })).toBe(
			"devhub — DevHub",
		);
	});

	it("keeps DevHub and the workspace whatever the element is", () => {
		for (const element of [undefined, "", "   ", "a file", "Scratch"]) {
			const title = shellWindowTitle({ element, workspace: "devhub" });
			expect(title).toContain("DevHub");
			expect(title).toContain("devhub");
		}
	});

	it("treats an element of nothing but space as no element at all", () => {
		expect(shellWindowTitle({ element: "   ", workspace: "Scratch" })).toBe(
			"Scratch — DevHub",
		);
	});

	it("refuses a title with no workspace to name", () => {
		expect(() =>
			shellWindowTitle({ element: "a file", workspace: "" }),
		).toThrow(/workspace/);
	});
});

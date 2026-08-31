import { describe, expect, it } from "vitest";
import {
	WORKBENCH_DEFAULTS,
	missingWorkbenchDefaults,
} from "./workbenchDefaults.js";

describe("the workbench defaults DevHub writes itself", () => {
	it("owes every default to a settings file that has none of them", () => {
		expect(Object.fromEntries(missingWorkbenchDefaults({}))).toEqual(
			WORKBENCH_DEFAULTS,
		);
	});

	it("owes nothing once the person has answered, whatever they answered", () => {
		const theirs = Object.fromEntries(
			Object.keys(WORKBENCH_DEFAULTS).map((key) => [key, "prompt"]),
		);
		expect(missingWorkbenchDefaults(theirs)).toEqual([]);
	});

	it("does not put a folder the person opened in DevHub into Restricted Mode", () => {
		// The workbench's terminal is DevHub's tmux session now, and Restricted
		// Mode refuses to start a terminal process at all.
		expect(WORKBENCH_DEFAULTS["security.workspace.trust.enabled"]).toBe(false);
	});

	it("lets a loose file into the Scratch workbench without a trust question", () => {
		// An empty window is a trusted workspace, so upstream asks before it will
		// open a file from anywhere else — and the answer to a file DevHub was
		// told to open is always the same one.
		expect(WORKBENCH_DEFAULTS["security.workspace.trust.untrustedFiles"]).toBe(
			"open",
		);
	});

	it("leaves a person who wants to be asked being asked", () => {
		expect(
			missingWorkbenchDefaults({
				"security.workspace.trust.untrustedFiles": "prompt",
			}).map(([key]) => key),
		).not.toContain("security.workspace.trust.untrustedFiles");
	});
});

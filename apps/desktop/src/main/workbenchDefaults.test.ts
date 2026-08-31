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

	it("leaves Workspace Trust itself alone, so a folder is still asked about", () => {
		// Untrusted *files* is the one trust-related default DevHub sets. Whether
		// the authors of a folder are trusted is upstream's question to ask, once
		// per folder, and DevHub does not answer it for anybody.
		expect(WORKBENCH_DEFAULTS).not.toHaveProperty(
			"security.workspace.trust.enabled",
		);
		expect(
			Object.keys(WORKBENCH_DEFAULTS).filter((key) =>
				key.startsWith("security.workspace.trust."),
			),
		).toEqual(["security.workspace.trust.untrustedFiles"]);
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

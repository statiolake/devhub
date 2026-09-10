import { describe, expect, it } from "vitest";
import {
	missingWorkbenchDefaults,
	workbenchDefaults,
	workbenchSettingsPlan,
} from "./workbenchDefaults.js";

const DEFAULTS = workbenchDefaults();

describe("the workbench defaults DevHub writes itself", () => {
	it("owes every default to a settings file that has none of them", () => {
		expect(Object.fromEntries(missingWorkbenchDefaults({}))).toEqual(DEFAULTS);
	});

	it("owes nothing once the person has answered, whatever they answered", () => {
		const theirs = Object.fromEntries(
			Object.keys(DEFAULTS).map((key) => [key, "prompt"]),
		);
		expect(missingWorkbenchDefaults(theirs)).toEqual([]);
	});

	it("leaves Workspace Trust itself alone, so a folder is still asked about", () => {
		// Untrusted *files* is the one trust-related default DevHub sets. Whether
		// the authors of a folder are trusted is upstream's question to ask, once
		// per folder, and DevHub does not answer it for anybody.
		expect(DEFAULTS).not.toHaveProperty("security.workspace.trust.enabled");
		expect(
			Object.keys(DEFAULTS).filter((key) =>
				key.startsWith("security.workspace.trust."),
			),
		).toEqual(["security.workspace.trust.untrustedFiles"]);
	});

	it("lets a loose file into the Scratch workbench without a trust question", () => {
		// An empty window is a trusted workspace, so upstream asks before it will
		// open a file from anywhere else — and the answer to a file DevHub was
		// told to open is always the same one.
		expect(DEFAULTS["security.workspace.trust.untrustedFiles"]).toBe("open");
	});

	it("leaves a person who wants to be asked being asked", () => {
		expect(
			missingWorkbenchDefaults({
				"security.workspace.trust.untrustedFiles": "prompt",
			}).map(([key]) => key),
		).not.toContain("security.workspace.trust.untrustedFiles");
	});

	// The terminal is not written here, and must never be again. A key in this
	// file is a suggestion a person — or their dotfiles tool, wholesale — can
	// unwrite, and that is exactly how the DevHub profile disappeared and a
	// reload produced a plain zsh. It is told to VS Code in code instead; see
	// patches/vscode/0003-devhub-terminal-is-the-terminal.patch.
	it("writes no terminal setting at all", () => {
		expect(
			Object.keys(DEFAULTS).filter((key) =>
				key.startsWith("terminal.integrated."),
			),
		).toEqual([]);
	});
});

describe("the settings file DevHub writes them into", () => {
	// The file is the person's: their dotfiles tool rewrites it, they edit it
	// by hand, and it is JSONC. What DevHub owes it is one write and no
	// surprises — and, when it cannot read it, no write at all.
	it("creates a file for somebody who has none", () => {
		const plan = workbenchSettingsPlan(undefined);
		if (plan.kind !== "write") throw new Error(plan.kind);
		expect(JSON.parse(plan.text)).toEqual(DEFAULTS);
		expect(plan.text.endsWith("\n")).toBe(true);
	});

	it("treats an empty file as an empty settings object", () => {
		const plan = workbenchSettingsPlan("\n\n");
		if (plan.kind !== "write") throw new Error(plan.kind);
		expect(JSON.parse(plan.text)).toEqual(DEFAULTS);
	});

	it("adds to valid JSON without disturbing what is there", () => {
		const plan = workbenchSettingsPlan('{\n\t"editor.fontSize": 15\n}\n');
		if (plan.kind !== "write") throw new Error(plan.kind);
		expect(JSON.parse(plan.text)).toEqual({
			"editor.fontSize": 15,
			...DEFAULTS,
		});
		expect(plan.keys).toEqual(Object.keys(DEFAULTS));
	});

	// VS Code reads this file with comments and trailing commas in it, so a
	// DevHub that called either one broken would be inventing a fault the
	// workbench does not have — and a DevHub that reserialised the object
	// would answer the person's comment by deleting it.
	it("reads JSONC, and keeps the comments it read", () => {
		const before = '{\n\t// mine, and it stays\n\t"editor.fontSize": 15,\n}\n';
		const plan = workbenchSettingsPlan(before);
		if (plan.kind !== "write") throw new Error(plan.kind);
		expect(plan.text).toContain("// mine, and it stays");
		expect(plan.text).toContain('"extensions.verifySignature"');
	});

	it("writes nothing when every default is already answered", () => {
		const answered = JSON.stringify(DEFAULTS);
		expect(workbenchSettingsPlan(answered).kind).toBe("answered");
	});

	// The two things DevHub must not do about a broken file are the two that
	// are easy to do by accident: overwrite it, and refuse to start.
	it("says where a truncated file broke, and leaves it alone", () => {
		// A brace that is never closed is only known to be missing at the end
		// of the file, so that is where the reader is sent — which is both
		// what the parser knows and what every editor says about it.
		const broken = '{\n\t"editor.fontSize": 15,\n\t"a": {';
		const plan = workbenchSettingsPlan(broken);
		if (plan.kind !== "unreadable") throw new Error(plan.kind);
		expect(plan.problem).toEqual({ line: 3, column: 8 });
	});

	it("points at the line a stray token is on", () => {
		const broken = '{\n\t"editor.fontSize": 15\n\t"a": 1\n}\n';
		const plan = workbenchSettingsPlan(broken);
		if (plan.kind !== "unreadable") throw new Error(plan.kind);
		expect(plan.problem.line).toBe(3);
	});

	it("refuses a file that parses but is not a settings object", () => {
		expect(workbenchSettingsPlan("[1, 2]").kind).toBe("unreadable");
	});
});

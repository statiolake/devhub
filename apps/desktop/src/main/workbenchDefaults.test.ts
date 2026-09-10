import { describe, expect, it } from "vitest";
import {
	missingWorkbenchDefaults,
	workbenchDefaults,
	workbenchSettingsPlan,
} from "./workbenchDefaults.js";

const LAUNCHER = "/data/devhub/devhub-terminal";
const DEFAULTS = workbenchDefaults(LAUNCHER);

describe("the workbench defaults DevHub writes itself", () => {
	it("owes every default to a settings file that has none of them", () => {
		expect(Object.fromEntries(missingWorkbenchDefaults({}, LAUNCHER))).toEqual(
			DEFAULTS,
		);
	});

	it("owes nothing once the person has answered, whatever they answered", () => {
		const theirs = Object.fromEntries(
			Object.keys(DEFAULTS).map((key) => [key, "prompt"]),
		);
		expect(missingWorkbenchDefaults(theirs, LAUNCHER)).toEqual([]);
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
			missingWorkbenchDefaults(
				{ "security.workspace.trust.untrustedFiles": "prompt" },
				LAUNCHER,
			).map(([key]) => key),
		).not.toContain("security.workspace.trust.untrustedFiles");
	});

	// The terminal a window opens on load must be a DevHub terminal, and the
	// only way to be sure of that before any extension host exists is a profile
	// whose path is a real executable, named by the default profile.
	it("makes the DevHub launcher the default terminal profile", () => {
		expect(DEFAULTS["terminal.integrated.profiles.osx"]).toEqual({
			DevHub: {
				path: LAUNCHER,
				args: ["${workspaceFolder}"],
				icon: "terminal-tmux",
			},
		});
		expect(DEFAULTS["terminal.integrated.defaultProfile.osx"]).toBe("DevHub");
	});

	// Tasks and automation run one command and throw the shell away; that is
	// upstream's throwaway shell and DevHub does not move it into tmux.
	it("leaves the automation shell to VS Code", () => {
		expect(DEFAULTS).not.toHaveProperty(
			"terminal.integrated.automationProfile.osx",
		);
	});

	it("does not restore tabs for sessions tmux already kept", () => {
		expect(DEFAULTS["terminal.integrated.enablePersistentSessions"]).toBe(
			false,
		);
	});
});

describe("the settings file DevHub writes them into", () => {
	// The file is the person's: their dotfiles tool rewrites it, they edit it
	// by hand, and it is JSONC. What DevHub owes it is one write and no
	// surprises — and, when it cannot read it, no write at all.
	it("creates a file for somebody who has none", () => {
		const plan = workbenchSettingsPlan(undefined, LAUNCHER);
		if (plan.kind !== "write") throw new Error(plan.kind);
		expect(JSON.parse(plan.text)).toEqual(DEFAULTS);
		expect(plan.text.endsWith("\n")).toBe(true);
	});

	it("treats an empty file as an empty settings object", () => {
		const plan = workbenchSettingsPlan("\n\n", LAUNCHER);
		if (plan.kind !== "write") throw new Error(plan.kind);
		expect(JSON.parse(plan.text)).toEqual(DEFAULTS);
	});

	it("adds to valid JSON without disturbing what is there", () => {
		const plan = workbenchSettingsPlan(
			'{\n\t"editor.fontSize": 15\n}\n',
			LAUNCHER,
		);
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
		const plan = workbenchSettingsPlan(before, LAUNCHER);
		if (plan.kind !== "write") throw new Error(plan.kind);
		expect(plan.text).toContain("// mine, and it stays");
		expect(plan.text).toContain('"terminal.integrated.defaultProfile.osx"');
	});

	it("writes nothing when every default is already answered", () => {
		const answered = JSON.stringify(DEFAULTS);
		expect(workbenchSettingsPlan(answered, LAUNCHER).kind).toBe("answered");
	});

	// The two things DevHub must not do about a broken file are the two that
	// are easy to do by accident: overwrite it, and refuse to start.
	it("says where a truncated file broke, and leaves it alone", () => {
		// A brace that is never closed is only known to be missing at the end
		// of the file, so that is where the reader is sent — which is both
		// what the parser knows and what every editor says about it.
		const broken = '{\n\t"editor.fontSize": 15,\n\t"a": {';
		const plan = workbenchSettingsPlan(broken, LAUNCHER);
		if (plan.kind !== "unreadable") throw new Error(plan.kind);
		expect(plan.problem).toEqual({ line: 3, column: 8 });
	});

	it("points at the line a stray token is on", () => {
		const broken = '{\n\t"editor.fontSize": 15\n\t"a": 1\n}\n';
		const plan = workbenchSettingsPlan(broken, LAUNCHER);
		if (plan.kind !== "unreadable") throw new Error(plan.kind);
		expect(plan.problem.line).toBe(3);
	});

	it("refuses a file that parses but is not a settings object", () => {
		expect(workbenchSettingsPlan("[1, 2]", LAUNCHER).kind).toBe("unreadable");
	});
});

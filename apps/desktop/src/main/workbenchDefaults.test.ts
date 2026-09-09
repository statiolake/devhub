import { describe, expect, it } from "vitest";
import {
	missingWorkbenchDefaults,
	workbenchDefaults,
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

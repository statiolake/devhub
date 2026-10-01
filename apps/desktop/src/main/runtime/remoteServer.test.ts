import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	rehCommit,
	remoteServerPaths,
	sourceBuildRefusal,
	startServerScript,
} from "./remoteServer.js";

const REPO_ROOT = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"..",
	"..",
);

const PATHS = remoteServerPaths({
	home: "/home/vscode",
	dataFolderName: ".devhub-server",
	applicationName: "devhub-server",
	commit: "abc",
});

describe("starting the remote extension host", () => {
	it("leaves its PATH alone when nothing is to be put in front", () => {
		expect(startServerScript(PATHS)).not.toMatch(/PATH=/u);
	});

	it("puts DevHub's devhub command in front of its PATH in a dev container", () => {
		// There is no DevHub tmux in a container to put it on a pane's PATH, so
		// the server carries it to the terminals and tasks it starts.
		const script = startServerScript(
			PATHS,
			"/home/vscode/.devhub-server/bin/x y",
		);
		expect(script).toContain(
			`PATH='/home/vscode/.devhub-server/bin/x y':"$PATH" nohup `,
		);
	});
});

describe("which remote extension host a build connects to", () => {
	const COMMIT = "a44adf7f53e00964ab890f9f8758a334f1fc15bc";

	it("is the packaged build's commit", () => {
		expect(rehCommit({ commit: COMMIT, serverCommit: COMMIT })).toBe(COMMIT);
	});

	it("is the serverCommit a source run states, which has no commit", () => {
		// A source run's dev container window used to be refused here: the
		// window opened, its resolver said "states no commit", and Open
		// Settings — the remote settings file — failed with the same sentence.
		expect(rehCommit({ commit: undefined, serverCommit: COMMIT })).toBe(COMMIT);
	});

	it("is nothing when the build states neither", () => {
		expect(rehCommit({})).toBeUndefined();
	});

	it("is accepted by the server when the client states no commit", () => {
		// What lets a commit-less source run talk to the published server of
		// the VS Code it is built from: the server checks the client's commit
		// only when the client states one. If the pinned VS Code ever makes
		// that check unconditional, `serverCommit` stops being enough.
		const server = readFileSync(
			join(
				REPO_ROOT,
				"vscode",
				"src",
				"vs",
				"server",
				"node",
				"remoteExtensionHostAgentServer.ts",
			),
			"utf8",
		);
		expect(server).toMatch(/if \(rendererCommit && myCommit\)/u);
	});

	it("refuses without naming one kind of machine", () => {
		const sentence = sourceBuildRefusal(
			"the dev container for /Users/me/project",
		);
		expect(sentence).toContain("states no commit");
		expect(sentence).toContain("apps/desktop/scripts/dev.sh");
		expect(sentence).not.toMatch(/SSH workspaces/u);
	});
});

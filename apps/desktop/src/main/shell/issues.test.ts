/**
 * What "which clone?" means once worktrees are in the picture.
 *
 * A worktree is the same repository checked out somewhere else, so the flow's
 * first question is about *repositories* and the second is about places within
 * one. These pin the fold: directories the search reached are grouped by the
 * identity git gives them, and each repository's places come from
 * `git worktree list` rather than from whatever the search happened to see.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, type Config } from "../../model/config.js";
import { makeScratchDir, removeScratchDir } from "../../model/testScratch.js";
import { localRuntime } from "../runtime/registry.js";
import { runGit, type GitCommand } from "./git.js";
import { findClones } from "./issues.js";

const GIT: GitCommand = {
	runtime: localRuntime(),
	git: "/usr/bin/git",
	environment: process.env,
};
const ISSUE = { owner: "example", repository: "widget", number: 128 };

let root: string;

async function git(cwd: string, ...args: string[]): Promise<void> {
	await runGit(GIT, args, { cwd });
}

/** A repository with `origin` pointing at the Issue's repository. */
async function repository(name: string): Promise<string> {
	const path = join(root, name);
	mkdirSync(path, { recursive: true });
	await git(path, "init", "-q", ".");
	await git(path, "config", "user.email", "a@b.c");
	await git(path, "config", "user.name", "t");
	await git(path, "commit", "-q", "--allow-empty", "-m", "init");
	await git(
		path,
		"remote",
		"add",
		"origin",
		"https://github.com/example/widget.git",
	);
	return path;
}

function configWith(): Config {
	return {
		...defaultConfig(),
		workspaceSources: [
			{
				type: "filesystem",
				id: "scratch",
				path: root,
				min_depth: 1,
				max_depth: 1,
				kinds: ["directory"],
				include_hidden: false,
				exclude_names: [],
			},
		],
	};
}

beforeEach(() => {
	root = makeScratchDir("issues");
});

afterEach(() => {
	removeScratchDir(root);
});

describe("finding the clones of an Issue's repository", () => {
	it("folds a repository and its worktrees into one repository", async () => {
		const main = await repository("widget");
		await git(
			main,
			"worktree",
			"add",
			"-q",
			"-b",
			"feature/9-old",
			join(root, "widget_feature_9-old"),
		);

		const found = await findClones(
			configWith(),
			() => Promise.resolve(GIT),
			ISSUE,
			[],
		);

		// One repository, not two directories.
		expect(found).toHaveLength(1);
		expect(found[0]?.place.path).toBe(main);
		expect(found[0]?.worktrees.map((w) => w.branch)).toEqual([
			expect.anything(),
			"feature/9-old",
		]);
		// The repository itself leads, and says so.
		expect(found[0]?.worktrees[0]?.isMainWorktree).toBe(true);
		expect(found[0]?.worktrees[1]?.isMainWorktree).toBe(false);
	});

	it("lists a worktree no source can see", async () => {
		// git knows every worktree there is; the search only knows the ones a
		// source reaches and whose name follows the convention.
		const main = await repository("widget");
		const hidden = makeScratchDir("elsewhere");
		try {
			await git(
				main,
				"worktree",
				"add",
				"-q",
				"-b",
				"feature/9-hidden",
				join(hidden, "somewhere"),
			);

			const found = await findClones(
				configWith(),
				() => Promise.resolve(GIT),
				ISSUE,
				[],
			);

			expect(found[0]?.worktrees.map((w) => w.branch)).toContain(
				"feature/9-hidden",
			);
		} finally {
			removeScratchDir(hidden);
		}
	});

	it("keeps two independent clones apart", async () => {
		const first = await repository("widget");
		const second = await repository("widget_two");
		// Named so the search reaches it; what makes them separate is that git
		// gives each its own main worktree.
		const found = await findClones(
			configWith(),
			() => Promise.resolve(GIT),
			ISSUE,
			[],
		);
		expect(found.map((entry) => entry.place.path).toSorted()).toEqual(
			[first, second].toSorted(),
		);
	});
});

/**
 * A clone that is not on this machine.
 *
 * The search walks this Mac's disk, so everything it finds is here. What can
 * be anywhere is a Workspace that is already open, and it arrives with the
 * machine it is on — because a path is not an identity: two hosts can both
 * have `/srv/app`, and a candidate read with the wrong machine's git is
 * answered "not a repository" and silently dropped.
 *
 * These use a real directory under two host labels, because what is being
 * pinned is which place each git was resolved from and which place ends up on
 * the answer. Whether a host is reachable is `SshRuntime`'s to say, and it
 * says it in its own tests.
 */
describe("a clone on another machine", () => {
	it("is inspected with the git of the machine it names", async () => {
		const here = await repository("widget");
		const asked: string[] = [];
		const found = await findClones(
			configWith(),
			(place) => {
				asked.push(
					place.kind === "ssh" ? `${place.host}:${place.path}` : place.path,
				);
				return Promise.resolve(GIT);
			},
			ISSUE,
			[{ kind: "ssh", host: "build.example.com", path: here }],
		);
		// The candidate was resolved from its own place, not from a path with
		// the machine dropped off it.
		expect(asked).toContain(`build.example.com:${here}`);
		// And the place travels onto the answer, so the worktree the flow makes
		// next lands on the machine the repository is on.
		expect(found.map((entry) => entry.place)).toContainEqual({
			kind: "ssh",
			host: "build.example.com",
			path: here,
		});
	});

	it("keeps two hosts with the same path apart", async () => {
		// The whole reason a place and not a path. Folded by path alone these
		// would be one repository, and choosing it would open a folder on
		// whichever of the two machines happened to be inspected first.
		const here = await repository("widget");
		const found = await findClones(
			configWith(),
			() => Promise.resolve(GIT),
			ISSUE,
			[
				{ kind: "ssh", host: "one.example.com", path: here },
				{ kind: "ssh", host: "two.example.com", path: here },
			],
		);
		expect(
			found
				.flatMap((entry) =>
					entry.place.kind === "ssh" ? [entry.place.host] : [],
				)
				.toSorted(),
		).toEqual(["one.example.com", "two.example.com"]);
	});
});

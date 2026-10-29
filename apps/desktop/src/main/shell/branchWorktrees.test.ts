/**
 * Branches as places to work, against a real repository: the workspace
 * picker's branch rows (`listBranchCandidates`, `ensureWorktree` with a
 * branch as the work) and a session resumed in the worktree it ran in
 * (`sessionWorktree.ts`), made again when it has been removed.
 *
 * Like `git.test.ts`, each test makes a repository in a temporary directory:
 * the rules being tested are git's.
 */

import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localRuntime } from "../runtime/registry.js";
import {
	branchCandidates,
	ensureWorktree,
	listBranchCandidates,
	parseWorktrees,
	runGit,
	type GitCommand,
} from "./git.js";
import { repositoryWorktrees, resumeFolder } from "./sessionWorktree.js";

const command: GitCommand = {
	runtime: localRuntime(),
	git: "git",
	environment: {
		...process.env,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_AUTHOR_NAME: "DevHub Test",
		GIT_AUTHOR_EMAIL: "test@example.com",
		GIT_COMMITTER_NAME: "DevHub Test",
		GIT_COMMITTER_EMAIL: "test@example.com",
	},
};

const BRANCH = { kind: "branch" } as const;

let parent: string;
let repository: string;

/** A commit on `branch` (made from `main`), dated `seconds` after the epoch. */
async function commitOn(branch: string, seconds: number): Promise<void> {
	await runGit(command, ["branch", branch, "main"], { cwd: repository });
	await runGit(command, ["worktree", "add", join(parent, "tmp"), branch], {
		cwd: repository,
	});
	await writeFile(join(parent, "tmp", branch.replace(/\//gu, "-")), "x\n");
	await runGit(command, ["add", "."], { cwd: join(parent, "tmp") });
	const date = `@${String(seconds)} +0000`;
	// The committer date is what `--sort=-committerdate` reads.
	const dated: GitCommand = {
		...command,
		environment: { ...command.environment, GIT_COMMITTER_DATE: date },
	};
	await runGit(dated, ["commit", "-m", branch, "--date", date], {
		cwd: join(parent, "tmp"),
	});
	await runGit(command, ["worktree", "remove", join(parent, "tmp")], {
		cwd: repository,
	});
}

/** A bare `origin` this clone fetched, with `branch` on it and not here. */
async function originWith(branch: string): Promise<void> {
	const origin = join(parent, "origin.git");
	await runGit(command, ["init", "--bare", "-b", "main", origin]);
	await runGit(command, ["remote", "add", "origin", origin], {
		cwd: repository,
	});
	await runGit(command, ["push", "origin", "main", `main:${branch}`], {
		cwd: repository,
	});
	await runGit(command, ["fetch", "origin"], { cwd: repository });
}

beforeEach(async () => {
	parent = await realpath(await mkdtemp(join(tmpdir(), "devhub-branches-")));
	repository = join(parent, "widget");
	await mkdir(repository);
	await runGit(command, ["init", "-b", "main", repository]);
	await writeFile(join(repository, "README"), "widget\n");
	await runGit(command, ["add", "README"], { cwd: repository });
	await runGit(command, ["commit", "-m", "first"], { cwd: repository });
});

afterEach(async () => {
	await rm(parent, { recursive: true, force: true });
});

describe("the branches the workspace picker offers", () => {
	it("are local and remote-only ones, newest commit first, each once, with where each is checked out", async () => {
		await originWith("alice/review");
		await commitOn("old-work", 1_000_000_000);
		await commitOn("feature/128-new", 2_000_000_000);
		const worktree = await ensureWorktree(
			command,
			repository,
			BRANCH,
			"feature/128-new",
		);

		const branches = await listBranchCandidates(command, repository);
		const names = branches.map((branch) => branch.name);
		expect(names[0]).toBe("feature/128-new");
		expect(names.at(-1)).toBe("old-work");
		// `origin/main` is `main`, which is local: offered once.
		expect(names.filter((name) => name === "main")).toHaveLength(1);
		expect(branches.find((each) => each.name === "main")).toMatchObject({
			worktree: repository,
		});
		expect(branches.find((each) => each.name === "feature/128-new")).toEqual({
			name: "feature/128-new",
			committedAt: 2_000_000_000,
			worktree,
		});
		expect(branches.find((each) => each.name === "alice/review")).toMatchObject(
			{ remote: "origin" },
		);
		expect(names).not.toContain("HEAD");
	});

	it("reads a remote whose name has a slash in it, and prefers origin's copy of a branch two remotes have", () => {
		const refs = [
			"30\trefs/remotes/my/fork/topic",
			"20\trefs/remotes/upstream/shared",
			"10\trefs/remotes/origin/shared",
			"5\trefs/remotes/origin/HEAD",
			"1\trefs/heads/main",
		].join("\n");
		expect(
			branchCandidates(
				refs,
				parseWorktrees("worktree /w\nHEAD abc\nbranch refs/heads/main\n"),
				["origin", "upstream", "my/fork", "my"],
			),
		).toEqual([
			{ name: "topic", remote: "my/fork", committedAt: 30 },
			{ name: "shared", remote: "origin", committedAt: 10 },
			{ name: "main", committedAt: 1, worktree: "/w" },
		]);
	});
});

describe("a worktree for a branch picked by name", () => {
	it("is the folder it is checked out in already", async () => {
		expect(await ensureWorktree(command, repository, BRANCH, "main")).toBe(
			repository,
		);
	});

	it("goes beside the repository, named for the branch, or for the Issue it carries", async () => {
		await commitOn("release/2.0", 1_000_000_000);
		await commitOn("feature/128-x", 1_000_000_000);
		expect(
			await ensureWorktree(command, repository, BRANCH, "release/2.0"),
		).toBe(join(parent, "widget_release-2.0"));
		expect(
			await ensureWorktree(command, repository, BRANCH, "feature/128-x"),
		).toBe(join(parent, "widget_128"));
	});

	it("checks a remote-only branch out as a local branch that tracks it", async () => {
		await originWith("alice/review");
		const path = await ensureWorktree(
			command,
			repository,
			BRANCH,
			"alice/review",
		);
		expect(path).toBe(join(parent, "widget_alice-review"));
		expect(
			(
				await runGit(
					command,
					["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
					{ cwd: path },
				)
			).trim(),
		).toBe("origin/alice/review");
	});

	it("is refused for a branch that is nowhere, rather than starting one", async () => {
		await expect(
			ensureWorktree(command, repository, BRANCH, "never-was"),
		).rejects.toThrow(/never-was is on neither this machine nor any remote/u);
	});
});

describe("a session of another worktree, gone on with there", () => {
	it("knows the repository's checkouts and where DevHub's worktrees of it go", async () => {
		await commitOn("topic", 1_000_000_000);
		const topic = await ensureWorktree(command, repository, BRANCH, "topic");
		expect(await repositoryWorktrees(command, topic)).toEqual({
			worktrees: [
				{ path: repository, branch: "main" },
				{ path: topic, branch: "topic" },
			],
			siblingPrefix: join(parent, "widget_"),
		});
		const plain = join(parent, "plain");
		await mkdir(plain);
		expect(await repositoryWorktrees(command, plain)).toBeUndefined();
	});

	it("is its own folder while that is there", async () => {
		await commitOn("topic", 1_000_000_000);
		const topic = await ensureWorktree(command, repository, BRANCH, "topic");
		expect(
			await resumeFolder(command, repository, { root: topic, branch: "topic" }),
		).toBe(topic);
	});

	it("makes a removed worktree again at the folder it ran in", async () => {
		await commitOn("topic", 1_000_000_000);
		const ran = join(parent, "widget_my-old-name");
		await runGit(command, ["worktree", "add", ran, "topic"], {
			cwd: repository,
		});
		await runGit(command, ["worktree", "remove", ran], { cwd: repository });

		expect(
			await resumeFolder(command, repository, { root: ran, branch: "topic" }),
		).toBe(ran);
		expect(
			(
				await runGit(command, ["rev-parse", "--abbrev-ref", "HEAD"], {
					cwd: ran,
				})
			).trim(),
		).toBe("topic");
	});

	it("makes it at the usual name when something else holds that folder now, or goes where the branch is checked out", async () => {
		await commitOn("topic", 1_000_000_000);
		await commitOn("other", 1_000_000_000);
		const ran = join(parent, "widget_taken");
		await runGit(command, ["worktree", "add", ran, "other"], {
			cwd: repository,
		});
		expect(
			await resumeFolder(command, repository, {
				root: join(parent, "widget_gone"),
				branch: "other",
			}),
		).toBe(ran);
		await mkdir(join(parent, "widget_gone"));
		await rm(join(parent, "widget_gone"), { recursive: true });
		await writeFile(join(parent, "widget_gone"), "a file in the way\n");
		expect(
			await resumeFolder(command, repository, {
				root: join(parent, "widget_gone"),
				branch: "topic",
			}),
		).toBe(join(parent, "widget_topic"));
	});

	it("says so when the folder is gone and the session recorded no branch", async () => {
		await expect(
			resumeFolder(command, repository, { root: join(parent, "widget_x") }),
		).rejects.toThrow(/did not record which branch/u);
	});
});

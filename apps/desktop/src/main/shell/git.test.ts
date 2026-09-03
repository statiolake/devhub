/**
 * The git DevHub runs, against a real repository.
 *
 * Worktree creation is the one operation here that cannot be judged by reading
 * it: the rules are `git`'s, the failure modes are the filesystem's, and a mock
 * of either would only prove that this file agrees with itself. So each test
 * makes a repository in a temporary directory and asks for the same things the
 * Issue flow asks for.
 */

import {
	mkdtemp,
	mkdir,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TypedFailure } from "../../model/wire.js";
import {
	ensureWorktree,
	listBranches,
	parseWorktrees,
	readRepository,
	runGit,
	type GitCommand,
} from "./git.js";

const command: GitCommand = {
	git: "git",
	environment: {
		...process.env,
		// A repository made in a test belongs to nobody, so it must not read the
		// machine's own identity or hooks.
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_AUTHOR_NAME: "DevHub Test",
		GIT_AUTHOR_EMAIL: "test@example.com",
		GIT_COMMITTER_NAME: "DevHub Test",
		GIT_COMMITTER_EMAIL: "test@example.com",
	},
};

let parent: string;
let repository: string;

beforeEach(async () => {
	// git answers with real paths, so the test measures from one too: on a
	// Mac `/tmp` is a symlink, and a fixture that kept the link would compare a
	// path against the same path spelled differently.
	parent = await realpath(await mkdtemp(join(tmpdir(), "devhub-git-")));
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

describe("reading a repository", () => {
	it("answers with the main worktree and the branch checked out", async () => {
		const facts = await readRepository(command, repository);
		expect(facts?.mainWorktree).toBe(repository);
		expect(facts?.branch).toBe("main");
	});

	it("says nothing at all about a plain folder", async () => {
		// Most of DevHub works on folders, so this is an ordinary answer and not a
		// failure — but only for *this* reason. Any other way git can fail still
		// throws, because a broken repository is not a boring fact.
		const plain = join(parent, "plain");
		await mkdir(plain);
		expect(await readRepository(command, plain)).toBeUndefined();
	});

	it("normalises the remote so an HTTPS and an SSH clone compare equal", async () => {
		await runGit(
			command,
			["remote", "add", "origin", "git@github.com:Example/Widget.git"],
			{ cwd: repository },
		);
		expect((await readRepository(command, repository))?.remote).toBe(
			"github.com/example/widget",
		);
	});
});

describe("the worktree for a branch", () => {
	it("is a sibling of the repository, named for the repository and the branch", async () => {
		const path = await ensureWorktree(command, repository, "feature/128-tidy");
		expect(path).toBe(join(parent, "widget_feature_128-tidy"));
		expect((await stat(path)).isDirectory()).toBe(true);
	});

	it("checks out a branch that already exists rather than forking a new one", async () => {
		await runGit(command, ["branch", "release"], { cwd: repository });
		const path = await ensureWorktree(command, repository, "release");
		const branch = await runGit(
			command,
			["rev-parse", "--abbrev-ref", "HEAD"],
			{
				cwd: path,
			},
		);
		expect(branch.trim()).toBe("release");
	});

	it("switches to the worktree a branch already has", async () => {
		const first = await ensureWorktree(command, repository, "feature/128-tidy");
		const again = await ensureWorktree(command, repository, "feature/128-tidy");
		expect(again).toBe(first);
	});

	it("finds the same place when asked from inside another worktree", async () => {
		// The parent is the *main* worktree's parent, always. Measuring from the
		// current one would nest, and where a branch lives would depend on where
		// the person happened to be standing.
		const first = await ensureWorktree(command, repository, "feature/128-tidy");
		const second = await ensureWorktree(command, first, "fix/9-crash");
		expect(second).toBe(join(parent, "widget_fix_9-crash"));
	});

	it("starts a new branch from the remote's default branch, not from HEAD", async () => {
		// Work on an Issue starts where everyone else starts. A worktree made while
		// standing on somebody's half-finished branch would inherit it silently,
		// which is the kind of mistake only review finds.
		const origin = join(parent, "origin.git");
		await runGit(command, ["init", "--bare", "-b", "main", origin]);
		await runGit(command, ["remote", "add", "origin", origin], {
			cwd: repository,
		});
		await runGit(command, ["push", "-u", "origin", "main"], {
			cwd: repository,
		});
		await runGit(command, ["checkout", "-b", "side"], { cwd: repository });
		await writeFile(join(repository, "SIDE"), "side\n");
		await runGit(command, ["add", "SIDE"], { cwd: repository });
		await runGit(command, ["commit", "-m", "side"], { cwd: repository });

		const path = await ensureWorktree(command, repository, "feature/128-tidy");

		const made = await runGit(command, ["rev-parse", "HEAD"], { cwd: path });
		const wanted = await runGit(command, ["rev-parse", "origin/main"], {
			cwd: repository,
		});
		expect(made.trim()).toBe(wanted.trim());
	});

	it("starts from the branch checked out when there is no remote at all", async () => {
		const path = await ensureWorktree(command, repository, "feature/9-solo");
		const made = await runGit(command, ["rev-parse", "HEAD"], { cwd: path });
		const wanted = await runGit(command, ["rev-parse", "main"], {
			cwd: repository,
		});
		expect(made.trim()).toBe(wanted.trim());
	});

	it("stops rather than branch from a stale copy when the fetch fails", async () => {
		// Every new branch fetches first, and a fetch that fails is not worked
		// around quietly: `origin` on disk may be days old, and starting there is a
		// decision with consequences that belongs to the person.
		await runGit(
			command,
			["remote", "add", "origin", join(parent, "gone.git")],
			{
				cwd: repository,
			},
		);
		await expect(
			ensureWorktree(command, repository, "feature/128-tidy"),
		).rejects.toThrow(/could not be fetched/u);
	});

	it("branches from the copy on disk once it has been allowed to", async () => {
		const origin = join(parent, "origin.git");
		await runGit(command, ["init", "--bare", "-b", "main", origin]);
		await runGit(command, ["remote", "add", "origin", origin], {
			cwd: repository,
		});
		await runGit(command, ["push", "-u", "origin", "main"], {
			cwd: repository,
		});
		const wanted = await runGit(command, ["rev-parse", "origin/main"], {
			cwd: repository,
		});
		// The remote goes away; what was fetched from it stays.
		await rm(origin, { recursive: true, force: true });

		const path = await ensureWorktree(command, repository, "feature/128-tidy", {
			allowStaleBase: true,
		});

		const made = await runGit(command, ["rev-parse", "HEAD"], { cwd: path });
		expect(made.trim()).toBe(wanted.trim());
	});

	it("refuses a directory that is in the way and is not a worktree", async () => {
		const occupied = join(parent, "widget_feature_128-tidy");
		await mkdir(occupied);
		await expect(
			ensureWorktree(command, repository, "feature/128-tidy"),
		).rejects.toBeInstanceOf(TypedFailure);
	});

	it("refuses a branch name that is only whitespace", async () => {
		await expect(ensureWorktree(command, repository, "   ")).rejects.toThrow(
			/Enter a branch name/u,
		);
	});
});

describe("the branches on offer", () => {
	it("names each one once, with no remote prefix and no HEAD", async () => {
		await runGit(command, ["branch", "release"], { cwd: repository });
		expect([...(await listBranches(command, repository))].sort()).toEqual([
			"main",
			"release",
		]);
	});
});

describe("git worktree list", () => {
	it("is read as a record per worktree, detached ones included", () => {
		expect(
			parseWorktrees(
				[
					"worktree /projects/widget",
					"HEAD abc",
					"branch refs/heads/main",
					"",
					"worktree /projects/widget_detached",
					"HEAD def",
					"detached",
					"",
				].join("\n"),
			),
		).toEqual([
			{ path: "/projects/widget", branch: "main" },
			{ path: "/projects/widget_detached", branch: undefined },
		]);
	});
});

describe("a git that fails", () => {
	it("throws git's own last line, not a sentence DevHub made up", async () => {
		await expect(
			runGit(command, ["checkout", "no-such-branch"], { cwd: repository }),
		).rejects.toThrow(/no-such-branch/u);
	});
});

describe("the name a branch has on the remote", () => {
	/** A bare repository to push to, added under a name. */
	async function addRemote(name: string): Promise<string> {
		const path = join(parent, `${name.replace(/\//gu, "_")}.git`);
		await runGit(command, ["init", "--bare", "-b", "main", path]);
		await runGit(command, ["remote", "add", name, path], { cwd: repository });
		return path;
	}

	it("is the push destination when the branch has one", async () => {
		await addRemote("origin");
		await runGit(command, ["push", "-u", "origin", "main"], {
			cwd: repository,
		});
		expect((await readRepository(command, repository))?.pushBranch).toBe(
			"main",
		);
	});

	it("is the upstream when `push.default=simple` refuses to answer", async () => {
		// The default `push.default` declines to push a branch whose remote name
		// differs from its local one, so `%(push)` is empty for exactly the
		// branches whose remote name has to be looked up. The upstream still says
		// it.
		await addRemote("origin");
		await runGit(command, ["config", "push.default", "simple"], {
			cwd: repository,
		});
		await runGit(command, ["push", "origin", "main:release-2"], {
			cwd: repository,
		});
		await runGit(command, ["checkout", "-b", "foo/baz"], { cwd: repository });
		await runGit(
			command,
			["branch", "--set-upstream-to=origin/release-2", "foo/baz"],
			{ cwd: repository },
		);
		expect((await readRepository(command, repository))?.pushBranch).toBe(
			"release-2",
		);
	});

	it("is the push destination and not the upstream in a fork", async () => {
		// A fork tracks `upstream/main` and pushes to `origin/<branch>`. Reading
		// the upstream first would answer `main` here — somebody else's trunk —
		// for every branch in every fork.
		await addRemote("origin");
		const source = await addRemote("upstream");
		await runGit(command, ["push", "upstream", "main"], { cwd: repository });
		await runGit(command, ["fetch", "upstream"], { cwd: repository });
		await runGit(command, ["checkout", "-b", "feature/128-tidy"], {
			cwd: repository,
		});
		await runGit(
			command,
			["branch", "--set-upstream-to=upstream/main", "feature/128-tidy"],
			{ cwd: repository },
		);
		await runGit(command, ["config", "push.default", "current"], {
			cwd: repository,
		});
		await runGit(
			command,
			["config", "branch.feature/128-tidy.pushRemote", "origin"],
			{ cwd: repository },
		);
		expect(source).toContain("upstream");
		expect((await readRepository(command, repository))?.pushBranch).toBe(
			"feature/128-tidy",
		);
	});

	it("keeps the whole branch name when the remote's own name has a slash", async () => {
		// `refs/remotes/my/fork/release-2` has one more leading component than
		// `refs/remotes/origin/release-2`, so a fixed strip count answers
		// `fork/release-2` — a branch nobody has.
		await addRemote("my/fork");
		await runGit(command, ["push", "my/fork", "main:release-2"], {
			cwd: repository,
		});
		await runGit(command, ["checkout", "-b", "local-name"], {
			cwd: repository,
		});
		await runGit(
			command,
			["branch", "--set-upstream-to=my/fork/release-2", "local-name"],
			{ cwd: repository },
		);
		expect((await readRepository(command, repository))?.pushBranch).toBe(
			"release-2",
		);
	});

	it("is nothing at all when the branch has neither", async () => {
		expect(
			(await readRepository(command, repository))?.pushBranch,
		).toBeUndefined();
	});
});

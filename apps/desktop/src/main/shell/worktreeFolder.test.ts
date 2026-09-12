/**
 * What a folder says about itself, and what a disposal does about it.
 *
 * Against a real repository and a real filesystem, because every fact under
 * test belongs to one of those two: what `git worktree remove` refuses, what
 * `stat` reports when a parent's permission bit changes, and what git leaves
 * behind when it half-succeeds. A mock of either would only prove that this
 * file agrees with itself.
 */

import {
	chmod,
	mkdir,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TypedFailure } from "../../model/wire.js";
import { localRuntime } from "../runtime/registry.js";
import { runGit, type GitCommand } from "./git.js";
import {
	disposeWorktreeFolder,
	folderIsDirectory,
	folderUnreadableReason,
	readWorktreeFolder,
} from "./worktreeFolder.js";

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

let parent: string;
let repository: string;
/** Set by a test that locks a directory, so teardown can unlock it first. */
let locked: string | undefined;

/** The paths `git worktree list` currently admits to. */
async function listedWorktrees(): Promise<readonly string[]> {
	const listing = await runGit(command, ["worktree", "list", "--porcelain"], {
		cwd: repository,
	});
	return listing
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length));
}

async function addWorktree(name: string): Promise<string> {
	const path = join(parent, name);
	await runGit(command, ["worktree", "add", "-b", name, path], {
		cwd: repository,
	});
	return path;
}

beforeEach(async () => {
	// git answers with real paths, so the test measures from one too.
	parent = await realpath(await mkdtemp(join(tmpdir(), "devhub-worktree-")));
	repository = join(parent, "widget");
	await mkdir(repository);
	await runGit(command, ["init", "-b", "main", repository]);
	await writeFile(join(repository, "README.md"), "widget\n");
	await runGit(command, ["add", "."], { cwd: repository });
	await runGit(command, ["commit", "-m", "first"], { cwd: repository });
	locked = undefined;
});

afterEach(async () => {
	if (locked !== undefined) await chmod(locked, 0o755);
	await rm(parent, { recursive: true, force: true });
});

describe("what a folder says about itself", () => {
	it("reads a linked worktree's repository off its `.git` file", async () => {
		const path = await addWorktree("feature");
		expect(await readWorktreeFolder(localRuntime(), path)).toEqual({
			root: path,
			mainWorktree: repository,
			gitdir: join(repository, ".git", "worktrees", "feature"),
		});
	});

	it("says nothing about the repository itself, whose `.git` is a directory", async () => {
		expect(
			await readWorktreeFolder(localRuntime(), repository),
		).toBeUndefined();
	});

	it("says nothing about a plain folder", async () => {
		const plain = join(parent, "plain");
		await mkdir(plain);
		expect(await readWorktreeFolder(localRuntime(), plain)).toBeUndefined();
	});

	it("still recognises a worktree git has forgotten", async () => {
		// The state a half-finished `git worktree remove` leaves: the record is
		// gone, the folder is not. git's list no longer mentions it; the folder
		// does, which is the whole reason the folder is what DevHub reads.
		const path = await addWorktree("feature");
		await rm(join(repository, ".git", "worktrees"), {
			recursive: true,
			force: true,
		});
		expect(await listedWorktrees()).not.toContain(path);
		expect(await readWorktreeFolder(localRuntime(), path)).toEqual({
			root: path,
			mainWorktree: repository,
			gitdir: join(repository, ".git", "worktrees", "feature"),
		});
	});
});

describe("a folder that cannot be read", () => {
	it("is not reported as a folder that is gone", async () => {
		const path = await addWorktree("feature");
		locked = parent;
		await chmod(parent, 0o000);
		await expect(
			folderIsDirectory(localRuntime(), path),
		).rejects.toBeInstanceOf(TypedFailure);
		await expect(folderIsDirectory(localRuntime(), path)).rejects.toMatchObject(
			{
				wire: { summary: expect.stringContaining("EACCES") },
			},
		);
	});

	it("names the path it could not read", async () => {
		const path = await addWorktree("feature");
		locked = parent;
		await chmod(parent, 0o000);
		await expect(folderIsDirectory(localRuntime(), path)).rejects.toMatchObject(
			{
				wire: { summary: expect.stringContaining(path) },
			},
		);
	});

	it("is `root_inaccessible` to a workbench open, not `root_missing`", async () => {
		const path = await addWorktree("feature");
		locked = parent;
		await chmod(parent, 0o000);
		expect(await folderUnreadableReason(localRuntime(), path)).toBe(
			"root_inaccessible",
		);
	});

	it("is `root_missing` when it really is not there", async () => {
		expect(
			await folderUnreadableReason(localRuntime(), join(parent, "nowhere")),
		).toBe("root_missing");
	});
});

describe("disposing of a worktree", () => {
	it("removes the folder and git's record of it", async () => {
		const path = await addWorktree("feature");
		await disposeWorktreeFolder(command, repository, path, false);
		await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await listedWorktrees()).not.toContain(path);
	});

	it("prunes the record when the folder is already gone", async () => {
		const path = await addWorktree("feature");
		await rm(path, { recursive: true, force: true });
		await disposeWorktreeFolder(command, repository, path, false);
		expect(await listedWorktrees()).not.toContain(path);
	});

	it("lets git refuse a worktree with work in it", async () => {
		const path = await addWorktree("feature");
		await writeFile(join(path, "scratch.txt"), "unsaved\n");
		await expect(
			disposeWorktreeFolder(command, repository, path, false),
		).rejects.toBeInstanceOf(TypedFailure);
		// Nothing has happened: the refusal is the last check standing between
		// somebody and work they cannot get back.
		expect(await stat(join(path, "scratch.txt"))).toBeTruthy();
		expect(await listedWorktrees()).toContain(path);
	});

	it("removes a worktree with work in it once the person has been asked", async () => {
		const path = await addWorktree("feature");
		await writeFile(join(path, "scratch.txt"), "unsaved\n");
		await disposeWorktreeFolder(command, repository, path, true);
		await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await listedWorktrees()).not.toContain(path);
	});

	it("fails, and deletes nothing, when the folder cannot be read", async () => {
		// The bug this exists for: `stat` failing with EACCES used to read as
		// "the folder is already gone", so the disposal pruned git's record and
		// reported success, leaving a folder full of work that nothing in git
		// remembered.
		const path = await addWorktree("feature");
		await writeFile(join(path, "scratch.txt"), "unsaved\n");
		locked = parent;
		await chmod(parent, 0o000);
		await expect(
			disposeWorktreeFolder(command, repository, path, true),
		).rejects.toMatchObject({
			wire: { summary: expect.stringContaining("EACCES") },
		});
		await chmod(parent, 0o755);
		locked = undefined;
		expect(await listedWorktrees()).toContain(path);
		expect(await readFile(join(path, "scratch.txt"), "utf8")).toBe("unsaved\n");
	});

	it("finishes the job when git removed its record and left the folder", async () => {
		const path = await addWorktree("feature");
		await writeFile(join(path, "scratch.txt"), "unsaved\n");
		await rm(join(repository, ".git", "worktrees"), {
			recursive: true,
			force: true,
		});
		// git now refuses — it has no record to remove — and without the folder's
		// own claim the folder would stay there for ever.
		await disposeWorktreeFolder(command, repository, path, true);
		await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("never deletes a folder that does not name this repository", async () => {
		// The fallback has none of `git worktree remove`'s protection, so this is
		// where it gets it: a folder that is not this repository's worktree is a
		// folder DevHub does not delete, whatever the close was asked to do.
		const stranger = join(parent, "stranger");
		await mkdir(stranger);
		await writeFile(join(stranger, "keep.txt"), "mine\n");
		await expect(
			disposeWorktreeFolder(command, repository, stranger, true),
		).rejects.toBeInstanceOf(TypedFailure);
		expect(await readFile(join(stranger, "keep.txt"), "utf8")).toBe("mine\n");
	});

	it("still disposes of the worktree on a retry after a failure", async () => {
		const path = await addWorktree("feature");
		await writeFile(join(path, "scratch.txt"), "unsaved\n");
		locked = parent;
		await chmod(parent, 0o000);
		await expect(
			disposeWorktreeFolder(command, repository, path, true),
		).rejects.toBeTruthy();
		await chmod(parent, 0o755);
		locked = undefined;
		await disposeWorktreeFolder(command, repository, path, true);
		await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await listedWorktrees()).not.toContain(path);
	});
});

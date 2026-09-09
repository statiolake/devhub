/**
 * The watcher, against real repositories.
 *
 * Nothing here can be learned from a stand-in: what is being pinned is that
 * git's own writes reach `fs.watch` on this platform, in an ordinary clone and
 * in a linked worktree, and that a directory with no `.git` at all is reported
 * rather than silently unwatched. Every case gets its own temporary repository
 * and closes its watchers afterwards.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	gitDirectoryOf,
	HEAD_DEBOUNCE_CEILING_MS,
	HeadWatcher,
} from "./headWatcher.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

function git(directory: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd: directory,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
	});
}

/** A repository with one commit on `main`, removed when the case ends. */
function repository(): string {
	const root = mkdtempSync(join(tmpdir(), "devhub-head-"));
	cleanups.push(() => {
		rmSync(root, { recursive: true, force: true });
	});
	git(root, "init", "-q", "-b", "main", ".");
	writeFileSync(join(root, "file.txt"), "one\n");
	git(root, "add", "file.txt");
	git(root, "commit", "-qm", "first");
	return root;
}

/** A watcher that records how many times it was told something moved. */
function watching(): { watcher: HeadWatcher; changes: () => number } {
	let changes = 0;
	const watcher = new HeadWatcher(() => {
		changes += 1;
	});
	cleanups.push(() => {
		watcher.stop();
	});
	return { watcher, changes: () => changes };
}

/** Wait for a condition the filesystem will reach, or say it never did. */
async function until(
	what: string,
	condition: () => boolean,
	budgetMs = HEAD_DEBOUNCE_CEILING_MS * 5,
): Promise<void> {
	const deadline = Date.now() + budgetMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`${what} did not happen within ${String(budgetMs)}ms`);
}

describe("watching for a checkout", () => {
	it("notices `git checkout -b` in an ordinary clone", async () => {
		const root = repository();
		const { watcher, changes } = watching();
		await watcher.arm([{ key: "w-1", worktree: root }]);
		expect(watcher.failures()).toEqual([]);
		expect(watcher.armedCount).toBe(1);

		git(root, "checkout", "-q", "-b", "spike/rework");
		await until("the checkout was noticed", () => changes() > 0);
	});

	it("notices a checkout in a linked worktree, not the main one's", async () => {
		const root = repository();
		const linked = join(root, "..", `${root.split("/").pop() ?? ""}-wt`);
		cleanups.push(() => {
			rmSync(linked, { recursive: true, force: true });
		});
		git(root, "worktree", "add", "-q", "-b", "side", linked);

		const { watcher, changes } = watching();
		await watcher.arm([{ key: "w-1", worktree: linked }]);
		expect(watcher.failures()).toEqual([]);

		// The linked worktree's `HEAD` lives under the main repository's
		// `.git/worktrees/<name>`, which is what `gitDirectoryOf` resolves and
		// the only place this checkout is written.
		expect(await gitDirectoryOf(linked)).toContain("worktrees");
		git(linked, "checkout", "-q", "-b", "side-two");
		await until("the worktree's checkout was noticed", () => changes() > 0);
	});

	it("stays quiet while nothing happens", async () => {
		const root = repository();
		const { watcher, changes } = watching();
		await watcher.arm([{ key: "w-1", worktree: root }]);

		await new Promise((resolve) =>
			setTimeout(resolve, HEAD_DEBOUNCE_CEILING_MS),
		);
		expect(changes()).toBe(0);
	});

	it("says which checkout it could not watch, rather than going quiet", async () => {
		const plain = mkdtempSync(join(tmpdir(), "devhub-plain-"));
		cleanups.push(() => {
			rmSync(plain, { recursive: true, force: true });
		});
		const { watcher } = watching();
		await watcher.arm([{ key: "w-1", worktree: plain }]);

		expect(watcher.armedCount).toBe(0);
		const failure = watcher.failures()[0];
		expect(failure?.key).toBe("w-1");
		expect(failure?.worktree).toBe(plain);
		expect(failure?.reason).toContain(".git");
	});

	it("keeps a watcher a re-arm asked for again, and drops the rest", async () => {
		const first = repository();
		const second = repository();
		const { watcher, changes } = watching();
		await watcher.arm([
			{ key: "w-1", worktree: first },
			{ key: "w-2", worktree: second },
		]);
		expect(watcher.armedCount).toBe(2);

		await watcher.arm([{ key: "w-1", worktree: first }]);
		expect(watcher.armedCount).toBe(1);

		// The one that was dropped is silent; the one that was kept is not.
		git(second, "checkout", "-q", "-b", "gone");
		await new Promise((resolve) =>
			setTimeout(resolve, HEAD_DEBOUNCE_CEILING_MS),
		);
		expect(changes()).toBe(0);

		git(first, "checkout", "-q", "-b", "kept");
		await until("the kept checkout was noticed", () => changes() > 0);
	});
});

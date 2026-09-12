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
import { gitDirectoryOf } from "../runtime/gitDirectory.js";
import { localRuntime } from "../runtime/registry.js";
import { HEAD_DEBOUNCE_CEILING_MS, HeadWatcher } from "./headWatcher.js";

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

/**
 * A count of the changes this case caused, and nothing else.
 *
 * A repository made moments ago is still delivering its own creation events —
 * macOS hands them over a few hundred milliseconds late — and they reach a
 * watcher armed on it exactly as a checkout would. So every case waits out the
 * ceiling once the watcher is armed and takes whatever has arrived by then as
 * its zero.
 *
 * Every case, not only the ones asserting silence. A case asserting silence
 * fails on somebody else's event, which is the loud way to get this wrong; a
 * case asserting that a checkout was noticed *passes* on somebody else's event,
 * which is the quiet way, and leaves a watcher that notices nothing looking
 * fine. One rule for both: after the settle, a change is a change this case
 * caused.
 */
async function settled(changes: () => number): Promise<() => number> {
	await new Promise((resolve) => setTimeout(resolve, HEAD_DEBOUNCE_CEILING_MS));
	const before = changes();
	return () => changes() - before;
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

/**
 * How long one case may take.
 *
 * A case is a settle, a handful of `git` runs, and then up to `until`'s budget
 * of waiting — and vitest's default is five seconds, which is `until`'s budget
 * exactly. That arrangement can only fail one way: vitest gives up first, and
 * the sentence naming what did not happen is never printed. So the ceiling
 * here is the budget with room around it.
 *
 * Measured under four spinning CPUs: the git setup of the heaviest case (a
 * clone plus a linked worktree) took 60–130 ms, and the checkout was noticed
 * 330–390 ms after the case began. The room is for a machine slower than this
 * one, not for this one.
 */
const CASE_TIMEOUT_MS = HEAD_DEBOUNCE_CEILING_MS * 10;

describe("watching for a checkout", () => {
	it(
		"notices `git checkout -b` in an ordinary clone",
		async () => {
			const root = repository();
			const { watcher, changes } = watching();
			await watcher.arm([
				{ key: "w-1", worktree: root, runtime: localRuntime() },
			]);
			expect(watcher.failures()).toEqual([]);
			expect(watcher.armedCount).toBe(1);
			const since = await settled(changes);

			git(root, "checkout", "-q", "-b", "spike/rework");
			await until("the checkout was noticed", () => since() > 0);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"notices a checkout in a linked worktree, not the main one's",
		async () => {
			const root = repository();
			const linked = join(root, "..", `${root.split("/").pop() ?? ""}-wt`);
			cleanups.push(() => {
				rmSync(linked, { recursive: true, force: true });
			});
			git(root, "worktree", "add", "-q", "-b", "side", linked);

			const { watcher, changes } = watching();
			await watcher.arm([
				{ key: "w-1", worktree: linked, runtime: localRuntime() },
			]);
			expect(watcher.failures()).toEqual([]);
			const since = await settled(changes);

			// The linked worktree's `HEAD` lives under the main repository's
			// `.git/worktrees/<name>`, which is what `gitDirectoryOf` resolves and
			// the only place this checkout is written.
			expect(await gitDirectoryOf(localRuntime(), linked)).toContain(
				"worktrees",
			);
			git(linked, "checkout", "-q", "-b", "side-two");
			await until("the worktree's checkout was noticed", () => since() > 0);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"stays quiet while nothing happens",
		async () => {
			const root = repository();
			const { watcher, changes } = watching();
			await watcher.arm([
				{ key: "w-1", worktree: root, runtime: localRuntime() },
			]);
			const since = await settled(changes);

			// The claim is about a window in which nothing happens, so the window
			// is the whole of the case after the settle.
			await new Promise((resolve) =>
				setTimeout(resolve, HEAD_DEBOUNCE_CEILING_MS),
			);
			expect(since()).toBe(0);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"says which checkout it could not watch, rather than going quiet",
		async () => {
			const plain = mkdtempSync(join(tmpdir(), "devhub-plain-"));
			cleanups.push(() => {
				rmSync(plain, { recursive: true, force: true });
			});
			const { watcher } = watching();
			await watcher.arm([
				{ key: "w-1", worktree: plain, runtime: localRuntime() },
			]);

			expect(watcher.armedCount).toBe(0);
			const failure = watcher.failures()[0];
			expect(failure?.key).toBe("w-1");
			expect(failure?.worktree).toBe(plain);
			expect(failure?.reason).toContain(".git");
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"keeps a watcher a re-arm asked for again, and drops the rest",
		async () => {
			const first = repository();
			const second = repository();
			const { watcher, changes } = watching();
			await watcher.arm([
				{ key: "w-1", worktree: first, runtime: localRuntime() },
				{ key: "w-2", worktree: second, runtime: localRuntime() },
			]);
			expect(watcher.armedCount).toBe(2);

			await watcher.arm([
				{ key: "w-1", worktree: first, runtime: localRuntime() },
			]);
			expect(watcher.armedCount).toBe(1);
			const since = await settled(changes);

			// The one that was dropped is silent; the one that was kept is not.
			git(second, "checkout", "-q", "-b", "gone");
			await new Promise((resolve) =>
				setTimeout(resolve, HEAD_DEBOUNCE_CEILING_MS),
			);
			expect(since()).toBe(0);

			git(first, "checkout", "-q", "-b", "kept");
			await until("the kept checkout was noticed", () => since() > 0);
		},
		CASE_TIMEOUT_MS,
	);
});

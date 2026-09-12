/**
 * Where a checkout keeps `HEAD`.
 *
 * `.git` is a directory in an ordinary clone and a file holding `gitdir: …` in
 * a linked worktree, where the real one is `<main>/.git/worktrees/<name>` — and
 * that is the directory whose `HEAD` a checkout in *that* worktree rewrites.
 * Reading the file rather than running `git rev-parse --git-dir` keeps this off
 * the process budget the watcher exists to cut.
 *
 * It lives in the runtime module rather than beside the watcher because
 * `Runtime.watchGitDirectory` takes a worktree and every implementation of it
 * has to answer this question first — locally to know what to hand `fs.watch`,
 * remotely to know what to poll. Two copies of the `gitdir:` rule would be two
 * chances to disagree about a linked worktree.
 */

import { isAbsolute, join, resolve } from "node:path";
import type { Runtime } from "./runtime.js";

/** A `.git` file naming a gitdir is a line, not a document. */
const MAX_MARKER_BYTES = 4096;

export async function gitDirectoryOf(
	runtime: Runtime,
	worktree: string,
): Promise<string> {
	const dotGit = join(worktree, ".git");
	const kind = await runtime.stat(dotGit);
	if (kind === "directory") return dotGit;
	if (kind === "absent") throw new Error(`${dotGit} does not exist`);
	const text = await runtime.readTextFile(dotGit, MAX_MARKER_BYTES);
	const line = text.split("\n")[0]?.trim() ?? "";
	if (!line.startsWith("gitdir:")) {
		throw new Error(`${dotGit} is not a directory and does not name one`);
	}
	const target = line.slice("gitdir:".length).trim();
	if (target.length === 0) {
		throw new Error(`${dotGit} names an empty gitdir`);
	}
	return isAbsolute(target) ? target : resolve(worktree, target);
}

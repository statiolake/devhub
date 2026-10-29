/**
 * Earlier sessions across a repository's worktrees: which checkouts a
 * listing reads, and where a session of another one is gone on with.
 *
 * A session is its checkout's work, on its branch, so the resume lists of a
 * Workspace offer the sessions of every worktree of its repository — each
 * labelled with its branch — and choosing one goes back to *that* checkout
 * rather than resuming somebody's feature branch conversation in `main`:
 *
 * - **The worktree is there.** Its folder is the place: its Workspace is
 *   opened, or focused when it is open already, and the Agent starts there.
 * - **The worktree was removed.** It is made again on the branch the session
 *   was on, at the folder it was in when that path is free (`ensureWorktree`'s
 *   `preferredDirectory`) — which is where the CLIs look for it — and at
 *   DevHub's usual name for a branch's worktree otherwise. A branch that is
 *   checked out somewhere already is gone on with in that worktree instead,
 *   because git gives a branch one folder. A session that recorded no branch
 *   has nothing to make again, and says so.
 *
 * Where the CLI then finds the session is the CLI's own question, answered by
 * the caller: Claude keeps a session under the directory it ran in, so one
 * whose folder moved is copied under the new one (`carryClaudeSession`);
 * Codex's `thread/resume` takes the directory it is resumed in, and its TUI
 * asks itself when that is not the one the thread ran in.
 */

import { worktreeSiblingPrefix } from "../../model/worktrees.js";
import type { RepositoryWorktrees } from "../agent/conversation/resume.js";
import {
	ensureWorktree,
	parseWorktrees,
	runGit,
	workspaceFailure,
	type GitCommand,
} from "./git.js";

/**
 * The checkouts of the repository `root` is in, by their real paths, or
 * nothing when it is in none (or git cannot say): the listing then reads the
 * folder's own sessions, as it always has.
 */
export async function repositoryWorktrees(
	command: GitCommand,
	root: string,
): Promise<RepositoryWorktrees | undefined> {
	let output: string;
	try {
		output = await runGit(command, ["worktree", "list", "--porcelain"], {
			cwd: root,
		});
	} catch {
		// Not a repository, or no git there: a folder of its own sessions.
		return undefined;
	}
	const records = parseWorktrees(output);
	const main = records[0];
	if (main === undefined) return undefined;
	const real = async (path: string) =>
		command.runtime.realpath(path).catch(() => path);
	const worktrees = await Promise.all(
		records.map(async (record) => ({
			path: await real(record.path),
			...(record.branch === undefined ? {} : { branch: record.branch }),
		})),
	);
	return {
		worktrees,
		siblingPrefix: worktreeSiblingPrefix(worktrees[0]!.path),
	};
}

/** The worktree a listed session ran in, as `PastSession.worktree` says it. */
export interface SessionWorktreeTarget {
	readonly root: string;
	readonly branch?: string;
}

/**
 * The folder a session of another worktree is gone on with in: its own when
 * it is still there, or its worktree made again (see the top of this file).
 * `repository` is a folder of the repository git is run in — the Workspace
 * the list was asked for.
 */
export async function resumeFolder(
	command: GitCommand,
	repository: string,
	worktree: SessionWorktreeTarget,
): Promise<string> {
	if ((await command.runtime.stat(worktree.root)) === "directory") {
		return worktree.root;
	}
	if (worktree.branch === undefined) {
		throw workspaceFailure(
			`${worktree.root} is gone, and the session did not record which branch it was on, so there is no worktree to make again for it.`,
		);
	}
	return ensureWorktree(
		command,
		repository,
		{ kind: "branch" },
		worktree.branch,
		{ preferredDirectory: worktree.root },
	);
}

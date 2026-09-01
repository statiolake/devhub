/**
 * Finding the clone an Issue belongs to.
 *
 * The question the flow asks is "do I already have this repository?", and the
 * answer has to come from the same places the workspace picker looks — the
 * sources in `config.toml` plus whatever is already open — or DevHub would
 * know about repositories in one dialog and not in another.
 *
 * So the picker's own search is what runs, for the repository's name, and this
 * only decides which of its answers are really that repository: a directory
 * whose name is the repository's (or one of its worktrees, `{repo}_{branch}`)
 * and whose `origin` normalises to the same identity. The name narrows it
 * cheaply; the remote is what makes it true, because two people's `widget` are
 * not the same widget.
 */

import type { Config } from "../../model/config.js";
import { remoteIdentity, type RemoteIdentity } from "../../model/domain.js";
import type { IssueReference } from "../../model/github.js";
import { baseName } from "../../model/worktrees.js";
import type { WorkspacePickerEvent } from "../../ipc/contract.js";
import { readRepository, type GitCommand } from "./git.js";
import { startWorkspacePicker } from "./workspacePicker.js";

/** One clone of the repository an Issue lives in. */
export interface CloneCandidate {
	readonly path: string;
	/** What is checked out there, so the person can tell two worktrees apart. */
	readonly branch: string | undefined;
	/** This is the repository itself rather than one of its worktrees. */
	readonly isMainWorktree: boolean;
}

/** How many named-alike directories are worth asking git about. */
const MAX_INSPECTED = 64;

/** The remote identity an Issue's repository is reached at. */
export function remoteForIssue(issue: IssueReference): RemoteIdentity {
	return remoteIdentity(
		`https://github.com/${issue.owner}/${issue.repository}.git`,
	);
}

/**
 * Every clone of the Issue's repository DevHub can see, the repository itself
 * first.
 *
 * `openRoots` are the workspaces already open, which the sources need not know
 * about: a folder opened with "Other…" is somewhere no source looks, and it is
 * still the clone the person means.
 */
export async function findClones(
	config: Config,
	command: GitCommand,
	issue: IssueReference,
	openRoots: readonly string[],
): Promise<readonly CloneCandidate[]> {
	const wanted = remoteForIssue(issue);
	const named = [
		...new Set([
			...openRoots,
			...(await searchSources(config, issue.repository)),
		]),
	].filter((path) => namesRepository(path, issue.repository));

	const found: CloneCandidate[] = [];
	for (const path of named.slice(0, MAX_INSPECTED)) {
		const facts = await readRepository(command, path);
		if (!facts || facts.remote !== wanted) continue;
		found.push({
			path,
			branch: facts.branch,
			isMainWorktree: facts.mainWorktree === path,
		});
	}
	// The repository itself is the answer most of the time; its worktrees are
	// the ones the person has to think about, so they come after it.
	return found.sort(
		(left, right) => Number(right.isMainWorktree) - Number(left.isMainWorktree),
	);
}

/**
 * `widget`, or a worktree of it: `widget_feature_128-tidy`. Anything else with
 * `widget` somewhere in its path is a directory the fuzzy search reached, not a
 * clone of this repository.
 */
function namesRepository(path: string, repository: string): boolean {
	const name = baseName(path);
	return name === repository || name.startsWith(`${repository}_`);
}

/** One run of the workspace picker's search, collected rather than streamed. */
function searchSources(
	config: Config,
	query: string,
): Promise<readonly string[]> {
	return new Promise<readonly string[]>((resolve) => {
		const paths: string[] = [];
		const cancel = startWorkspacePicker(
			config,
			query,
			"issue-clone-search",
			(event: WorkspacePickerEvent) => {
				if (event.kind === "candidate") paths.push(event.path);
				else if (event.kind === "completed" || event.kind === "cancelled") {
					cancel();
					resolve(paths);
				}
			},
		);
	});
}

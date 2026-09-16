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
import type {
	WorkspacePickerEvent,
	WorkspacePlaceWire,
} from "../../ipc/contract.js";
import { CancellationToken } from "../terminal/ports.js";
import {
	parseWorktrees,
	readRepository,
	runGit,
	type GitCommand,
} from "./git.js";
import { startWorkspacePicker } from "./workspacePicker.js";

/** One place work can happen: a repository itself, or one of its worktrees. */
export interface WorktreeCandidate {
	readonly place: WorkspacePlaceWire;
	/** What is checked out there, so the person can tell two worktrees apart. */
	readonly branch: string | undefined;
	/** This is the repository itself rather than one of its worktrees. */
	readonly isMainWorktree: boolean;
}

/** One clone of the Issue's repository, with everywhere it is checked out. */
export interface RepositoryCandidate {
	/** The main worktree, and the machine it is on. */
	readonly place: WorkspacePlaceWire;
	readonly worktrees: readonly WorktreeCandidate[];
}

/** What makes two places the same place: the machine as well as the path. */
function placeKey(place: WorkspacePlaceWire): string {
	return place.kind === "ssh" ? `ssh://${place.host}${place.path}` : place.path;
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
 * Every clone of the Issue's repository DevHub can see, each with everywhere it
 * is checked out.
 *
 * `openRoots` are the workspaces already open, which the sources need not know
 * about: a folder opened with "Other…" is somewhere no source looks, and it is
 * still the clone the person means.
 *
 * Two steps, and the second is why this is not simply a list of directories.
 * The search finds *directories*; several of them are usually one repository,
 * because a worktree is a second place the same repository is checked out. They
 * are folded together by their main worktree, which is the identity git itself
 * answers with — so two directories are the same repository exactly when git
 * says they are, and never because their names look alike.
 *
 * Then each repository's worktrees are read from `git worktree list`, not from
 * what the search happened to reach. The search only finds directories a source
 * can see and whose name follows the convention; git knows every worktree there
 * is, including the one somebody made by hand in a folder no source looks at.
 * Asking git is both more complete and more truthful, and it costs one command
 * per repository rather than one per candidate.
 */
export async function findClones(
	config: Config,
	gitFor: (place: WorkspacePlaceWire) => Promise<GitCommand>,
	issue: IssueReference,
	openPlaces: readonly WorkspacePlaceWire[],
	/**
	 * The token that abandons this lookup.
	 *
	 * A lookup is somebody watching a spinner, and this is what stops it being
	 * unbounded: the search walk ends, the `git` in flight is killed, and the
	 * loop below stops before it starts the next one. Defaulted so that the
	 * callers which genuinely cannot be abandoned — a test, a background
	 * refresh — read the same as they did.
	 */
	cancel: CancellationToken = new CancellationToken(),
): Promise<readonly RepositoryCandidate[]> {
	const wanted = remoteForIssue(issue);
	// The sources walk *this* machine's disk, so what they find is on it. A
	// Workspace that is already open may be anywhere, and it arrives with the
	// machine it is on — which is what makes the git below the right git, and
	// what stops a path from a host being handed to this Mac's git and coming
	// back "not a repository".
	const candidates = new Map<string, WorkspacePlaceWire>();
	for (const place of [
		...openPlaces,
		...(await searchSources(config, issue.repository, cancel)).map(
			(path): WorkspacePlaceWire => ({ kind: "local", path }),
		),
	]) {
		if (!namesRepository(place.path, issue.repository)) continue;
		candidates.set(placeKey(place), place);
	}

	const repositories = new Map<string, WorkspacePlaceWire>();
	for (const place of [...candidates.values()].slice(0, MAX_INSPECTED)) {
		// Sixty-four directories is sixty-four gits, and the person is watching a
		// spinner for all of them. This is the seam where an abandoned lookup
		// stops costing anything: the one in flight was killed by the token, and
		// the next one is never started.
		cancel.check();
		const command = await gitFor(place);
		// One directory git will not answer about is one candidate lost, not the
		// question. These are *candidates* — whatever the fuzzy search reached
		// with a matching name — so a broken checkout, a stale mount or a folder
		// that stopped being a repository between the walk and now is an ordinary
		// thing to meet here, and losing the other sixty-three clones over it is
		// not. Cancellation is not one of these: it is the caller saying stop,
		// and it goes on up.
		let facts;
		try {
			facts = await readRepository(command, place.path, cancel);
		} catch {
			cancel.check();
			continue;
		}
		if (!facts || facts.remote !== wanted) continue;
		// A repository's main worktree is on the same machine as the checkout
		// git read it from; there is nowhere else it could be.
		const main = { ...place, path: facts.mainWorktree };
		repositories.set(placeKey(main), main);
	}

	const found: RepositoryCandidate[] = [];
	for (const place of repositories.values()) {
		cancel.check();
		found.push({
			place,
			worktrees: await worktreesOf(await gitFor(place), place, cancel),
		});
	}
	// A cancelled lookup never *answers*. Every step above stops early when the
	// token fires, so the honest result of stopping early is a short list — and
	// a short list is indistinguishable from the real one. "Nobody is waiting
	// any more" and "this machine has no clone of it" would then arrive as the
	// same value, and the second one sends a person off to clone a repository
	// they already have.
	cancel.check();
	return found;
}

/**
 * Everywhere one repository is checked out, the repository itself first.
 *
 * The repository is the answer most of the time; its worktrees are the ones the
 * person has to think about, so they come after it. A repository git will not
 * answer about is still offered as itself — the directory is there and can be
 * worked in, and a repository that vanished from a list because one command
 * failed is worse than one listed with nothing under it.
 */
async function worktreesOf(
	command: GitCommand,
	main: WorkspacePlaceWire,
	cancel?: CancellationToken,
): Promise<readonly WorktreeCandidate[]> {
	const itself: WorktreeCandidate = {
		place: main,
		branch: undefined,
		isMainWorktree: true,
	};
	const output = await runGit(command, ["worktree", "list", "--porcelain"], {
		cwd: main.path,
		cancel,
	}).catch(() => undefined);
	if (output === undefined) return [itself];
	const records = parseWorktrees(output);
	return records
		.map((record) => ({
			// git lists paths on the machine it ran on, which is this repository's.
			place: { ...main, path: record.path },
			branch: record.branch,
			isMainWorktree: record.path === main.path,
		}))
		.sort(
			(left, right) =>
				Number(right.isMainWorktree) - Number(left.isMainWorktree),
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

/**
 * One run of the workspace picker's search, collected rather than streamed.
 *
 * The token ends the walk where it has got to and answers with what it found so
 * far. A search nobody is waiting for is not worth finishing, and the paths it
 * already has cost nothing to hand back — the caller checks the token again
 * before it does anything with them.
 */
function searchSources(
	config: Config,
	query: string,
	cancel: CancellationToken,
): Promise<readonly string[]> {
	return new Promise<readonly string[]>((resolve) => {
		const paths: string[] = [];
		const stop = startWorkspacePicker(
			config,
			query,
			"issue-clone-search",
			(event: WorkspacePickerEvent) => {
				if (event.kind === "candidate") paths.push(event.path);
				else if (event.kind === "completed" || event.kind === "cancelled") {
					stop();
					resolve(paths);
				}
			},
		);
		cancel.onCancelled(stop);
	});
}

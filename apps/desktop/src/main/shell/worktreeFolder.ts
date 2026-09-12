/**
 * What a folder says about itself, before git is asked anything.
 *
 * Two facts live here, and they are here together because they are the same
 * kind of fact: read off the filesystem, about one path, with no repository
 * poll behind them.
 *
 * **Is it there.** A probe failing is not one answer. `ENOENT` and `ENOTDIR`
 * mean the folder is not there, which for a close is the state it was trying
 * to reach. Every *other* errno — `EACCES` on a parent whose permissions
 * changed, `EIO` on a failing disk, a dead network mount — means DevHub could
 * not find out, and a close that reads "could not find out" as "already gone"
 * deletes git's record of a worktree whose folder is still sitting there with
 * work in it, and reports success. So not-there is one answer and could-not-
 * look is a failure, and the errno and the path travel with it. That split is
 * the runtime's now (`Runtime.stat` answers `"absent"` or throws), which is
 * what lets the same rule hold for a folder on another machine.
 *
 * **Is it a worktree.** git's own list is not the authority, because the case
 * that matters is exactly the case where git's list is wrong: `git worktree
 * remove` can delete the administrative record and then fail to delete the
 * folder, after which git no longer lists a worktree and the folder is still
 * there for ever. The folder itself still says what it is — a linked worktree
 * has a `.git` *file* whose `gitdir:` points inside some repository's
 * `.git/worktrees/` — and that survives the record, which is why it is what
 * DevHub reads.
 */

import { join } from "node:path";
import { RuntimeFileError, type Runtime } from "../runtime/runtime.js";
import {
	pruneWorktrees,
	removeWorktree,
	workspaceFailure,
	type GitCommand,
} from "./git.js";

/** A `.git` file naming a gitdir is a line, not a document. */
const MAX_MARKER_BYTES = 4096;

/** The segment that makes a `gitdir:` an *administrative record for a linked worktree*. */
const WORKTREES_SEGMENT = "/.git/worktrees/";

/**
 * The errno as a sentence, so a failure can quote the system rather than invent.
 *
 * The runtime has already made the distinction this file is built on: not-there
 * is an answer (`"absent"`), and could-not-look is a `RuntimeFileError` with
 * the errno on it. Anything else that reaches here is not about the path.
 */
function unreadable(path: string, error: unknown): Error {
	if (error instanceof RuntimeFileError) {
		return workspaceFailure(`${path} could not be read (${error.code}).`);
	}
	return workspaceFailure(
		`${path} could not be read (${error instanceof Error ? error.message : String(error)}).`,
	);
}

/**
 * Whether a workbench could be opened in `folder`: it exists, and is a folder.
 *
 * `false` means *not there*. Anything else throws, because the caller's next
 * move for "it is gone" is destructive or tells the person their folder has
 * vanished, and neither is the right answer to a permission bit.
 */
export async function folderIsDirectory(
	runtime: Runtime,
	folder: string,
): Promise<boolean> {
	try {
		return (await runtime.stat(folder)) === "directory";
	} catch (error: unknown) {
		throw unreadable(folder, error);
	}
}

/** A folder that is a linked worktree, and the repository it belongs to. */
export interface WorktreeFolder {
	/** The worktree's own root — the folder holding the `.git` file. */
	readonly root: string;
	/** The repository whose `.git/worktrees/` holds this worktree's record. */
	readonly mainWorktree: string;
	/** The administrative record this worktree points at, there or not. */
	readonly gitdir: string;
}

/**
 * Read the folder's own claim to be a worktree, or `undefined` if it makes none.
 *
 * `undefined` covers every ordinary shape: no `.git` at all, a `.git`
 * *directory* (an ordinary repository, not a linked worktree), a `.git` file
 * pointing somewhere that is not a worktree record. Only a folder that cannot
 * be read throws — see the note at the top of this file.
 */
export async function readWorktreeFolder(
	runtime: Runtime,
	folder: string,
): Promise<WorktreeFolder | undefined> {
	const marker = join(folder, ".git");
	let contents: string;
	try {
		const kind = await runtime.stat(marker);
		if (kind === "absent") return undefined;
		// A repository has a `.git` directory. Only a linked worktree has a file.
		if (kind === "directory") return undefined;
		contents = await runtime.readTextFile(marker, MAX_MARKER_BYTES);
	} catch (error: unknown) {
		throw unreadable(marker, error);
	}
	const gitdir = /^gitdir:\s*(.+?)\s*$/mu.exec(contents)?.[1];
	if (gitdir === undefined) return undefined;
	const cut = gitdir.indexOf(WORKTREES_SEGMENT);
	if (cut <= 0) return undefined;
	return { root: folder, mainWorktree: gitdir.slice(0, cut), gitdir };
}

/**
 * Whether this folder is a worktree of *this* repository.
 *
 * The question asked before DevHub ever deletes a folder itself. `git worktree
 * remove` refuses to touch anything that is not git's own; the fallback path
 * has no such protection, so it gets the same guarantee from here: the folder
 * has to name the repository DevHub thinks it is closing, and an arbitrary
 * directory somebody pointed a workspace at names nobody.
 */
export function isWorktreeOf(
	folder: WorktreeFolder | undefined,
	mainWorktree: string,
): folder is WorktreeFolder {
	return folder !== undefined && folder.mainWorktree === mainWorktree;
}

/**
 * Why a workbench cannot be opened in `folder`, or `undefined` if it can.
 *
 * The same errno rule as `folderIsDirectory`, answering in the vocabulary the
 * workspace's `unavailable` state uses, because the caller's job is to put the
 * reason into the model rather than to fail. `root_missing` offers Locate…;
 * `root_inaccessible` does not, because the folder is exactly where it was.
 */
export async function folderUnreadableReason(
	runtime: Runtime,
	folder: string,
): Promise<"root_missing" | "root_inaccessible" | undefined> {
	try {
		return (await runtime.stat(folder)) === "directory"
			? undefined
			: "root_missing";
	} catch {
		// Not a swallow: every failure the runtime raises for a path is
		// "DevHub could not look", and that is one of the two answers this
		// function exists to give. Which errno it was does not change the
		// offer — `root_inaccessible` deliberately does not offer Locate…,
		// because the folder is exactly where it was.
		return "root_inaccessible";
	}
}

/**
 * Get rid of a worktree folder and git's record of it, in that order of care.
 *
 * The whole disposal, in one place, because its three cases are one rule and
 * splitting them is how they drift:
 *
 *   - **The folder is gone.** The state this was trying to reach. There is
 *     nothing to remove and everything still to tidy, because git keeps a
 *     record per worktree and leaving it behind is what makes the *next*
 *     `worktree add` on that path refuse. So: prune.
 *   - **The folder is there.** `git worktree remove`, forcing only if the
 *     person was asked about what would be destroyed. git is the authority on
 *     whether there is work in it; DevHub's idea of "clean" is a poll up to a
 *     minute old.
 *   - **git removed its record and then failed.** Now nothing in `git worktree
 *     list` remembers this folder was a worktree, so no retry would ever touch
 *     it and it stays for ever. The folder still says what it is, so DevHub
 *     finishes what git started — prune the record, delete the folder — but
 *     only for a folder whose `.git` file names *this* repository, and only
 *     because the answer was to delete.
 *
 * A folder that cannot be *read* is none of these. It throws, with the errno,
 * so the close stops at this step and says so.
 */
export async function disposeWorktreeFolder(
	command: GitCommand,
	mainWorktree: string,
	root: string,
	force: boolean,
): Promise<void> {
	// Read first, and from the folder: this is the claim that survives a
	// half-finished `git worktree remove`, and it is the only thing that
	// authorises the fallback to delete anything.
	const folder = await readWorktreeFolder(command.runtime, root);
	if (!(await folderIsDirectory(command.runtime, root))) {
		await pruneWorktrees(command, mainWorktree);
		return;
	}
	try {
		await removeWorktree(command, mainWorktree, root, force);
		return;
	} catch (error: unknown) {
		// Only one refusal is DevHub's to overrule, and it is the one that is
		// not about the work: git has no record left to remove. Every other
		// refusal — "contains modified or untracked files" above all — is git
		// standing between somebody and work they cannot get back, and taking
		// the folder anyway would make `--force` mean nothing.
		if (!isWorktreeOf(folder, mainWorktree)) throw error;
		if (await folderIsDirectory(command.runtime, folder.gitdir)) throw error;
		await pruneWorktrees(command, mainWorktree);
		await command.runtime.removeTree(root);
	}
}

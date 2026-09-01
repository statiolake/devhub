/**
 * The `git` DevHub runs, and what it is asked.
 *
 * One runner, so that every git DevHub starts is the same git — the one the
 * runtimes were resolved to, in the environment the terminals and Agents get —
 * and every refusal reads the way the clone sheet's already did: git's own last
 * line, thrown with words the person can act on. A second spawn site would be a
 * second `git` and a second way of failing.
 *
 * The knowledge about *where* things go is not here; it is in
 * `model/worktrees.ts`, because the page has to show the person the same answer
 * before anything is run.
 */

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import {
	remoteIdentity,
	type RemoteIdentity,
	DomainError,
} from "../../model/domain.js";
import {
	errorWireAt,
	TypedFailure,
	withDetail,
	withSummary,
} from "../../model/wire.js";
import { baseName, worktreeDirectory } from "../../model/worktrees.js";

/**
 * A refusal in the words it should be read in.
 *
 * "That folder already exists", "Repository not found", "fatal: 'x' is already
 * checked out" — the whole value of these failing is that a person can act on
 * each one. Thrown as a plain `Error` they arrive at the page as "the native
 * app shell is unavailable" with the real sentence buried in a detail nothing
 * draws, which is the same as not saying it.
 */
export function workspaceFailure(summary: string): TypedFailure {
	return new TypedFailure(
		withSummary(errorWireAt("workspace_unavailable"), summary),
	);
}

/**
 * The fetch before a new branch did not work.
 *
 * Its own failure, and its own code, because it is the only one here that has a
 * second answer: `origin` as of the last successful fetch is still on disk, and
 * whether to start a branch from a copy that may be days old is the person's
 * call. The reason travels as the detail so the question can quote it.
 */
export function fetchFailure(reason: string): TypedFailure {
	return new TypedFailure(
		withDetail(
			withSummary(
				errorWireAt("git_fetch_failed"),
				`The latest changes could not be fetched: ${reason}`,
			),
			reason,
		),
	);
}

/** The git binary DevHub resolved, and the environment it runs in. */
export interface GitCommand {
	readonly git: string;
	readonly environment: Readonly<Record<string, string | undefined>>;
}

export interface GitRunOptions {
	readonly cwd?: string;
	readonly timeoutMs?: number;
}

/** How long a git that talks to a network gets before DevHub stops waiting. */
export const NETWORK_TIMEOUT_MS = 10 * 60 * 1000;
/** How long a git that only reads the local repository gets. */
export const LOCAL_TIMEOUT_MS = 30 * 1000;
/** Enough of git's complaint to act on, and not a whole console of it. */
const MAX_STDERR_BYTES = 8 * 1024;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;

/**
 * Run git and answer with what it wrote, or throw what it complained about.
 *
 * Arguments are passed as a list and never through a shell, so a branch name
 * with a space, a quote or a semicolon in it is a branch name.
 */
export function runGit(
	command: GitCommand,
	args: readonly string[],
	options: GitRunOptions = {},
): Promise<string> {
	const timeoutMs = options.timeoutMs ?? LOCAL_TIMEOUT_MS;
	return new Promise<string>((resolve, reject) => {
		const child = spawn(command.git, args, {
			cwd: options.cwd,
			env: command.environment as NodeJS.ProcessEnv,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			if (stdout.length < MAX_STDOUT_BYTES) stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString("utf8");
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
		}, timeoutMs);
		child.once("error", (failure: Error) => {
			clearTimeout(timer);
			reject(workspaceFailure(failure.message));
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			if (code === 0) {
				resolve(stdout);
				return;
			}
			// git says why on stderr and DevHub has nothing to add: passing its own
			// last line through is the difference between "it failed" and
			// "Repository not found", and only one of those can be acted on.
			const said = stderr.trim().split("\n").at(-1)?.trim();
			reject(
				workspaceFailure(
					said && said.length > 0
						? said
						: signal
							? `git ${args[0] ?? ""} was stopped (${signal}).`
							: `git ${args[0] ?? ""} failed (exit ${String(code ?? "unknown")}).`,
				),
			);
		});
	});
}

/**
 * A question about a directory that may not be a repository at all.
 *
 * Not being one is an ordinary answer here — the workspace picker's candidates
 * are folders, and most of DevHub works on folders — so it comes back as
 * `undefined` rather than as a failure. Every *other* way git can fail still
 * throws, because "the repository is broken" and "this is not a repository"
 * are different facts and only one of them is boring.
 */
async function ask(
	command: GitCommand,
	args: readonly string[],
	cwd: string,
): Promise<string | undefined> {
	try {
		return (await runGit(command, args, { cwd })).trim();
	} catch (error: unknown) {
		if (!(error instanceof TypedFailure)) throw error;
		const summary = error.wire.summary;
		return /not a git repository|does not exist|No such file/iu.test(summary)
			? undefined
			: Promise.reject(error);
	}
}

/** What DevHub knows about the repository a workspace sits in. */
export interface RepositoryFacts {
	/** The main worktree, whichever worktree was asked. */
	readonly mainWorktree: string;
	/** The branch checked out here, or nothing when the head is detached. */
	readonly branch: string | undefined;
	/** `origin`, normalised so an HTTPS and an SSH clone compare equal. */
	readonly remote: RemoteIdentity | undefined;
}

/**
 * Read the repository a directory belongs to, or nothing when it is a plain
 * folder.
 */
export async function readRepository(
	command: GitCommand,
	directory: string,
): Promise<RepositoryFacts | undefined> {
	const worktrees = await ask(
		command,
		["worktree", "list", "--porcelain"],
		directory,
	);
	if (worktrees === undefined) return undefined;
	// The first record is always the main worktree, which is the one every
	// worktree path in DevHub is measured from.
	const mainWorktree = parseWorktrees(worktrees)[0]?.path;
	if (mainWorktree === undefined) return undefined;

	const branch = await ask(
		command,
		["rev-parse", "--abbrev-ref", "HEAD"],
		directory,
	);
	const remote = await originIdentity(command, directory);
	return {
		mainWorktree,
		branch: branch === undefined || branch === "HEAD" ? undefined : branch,
		remote,
	};
}

async function originIdentity(
	command: GitCommand,
	directory: string,
): Promise<RemoteIdentity | undefined> {
	const url = await ask(
		command,
		["remote", "get-url", "origin"],
		directory,
	).catch(() => undefined);
	if (url === undefined || url.length === 0) return undefined;
	try {
		return remoteIdentity(url);
	} catch (error: unknown) {
		// A remote DevHub cannot normalise is a remote it cannot match against
		// anything — which is the same answer as having none, and is not a reason
		// to refuse to open the folder.
		if (error instanceof DomainError) return undefined;
		throw error;
	}
}

export interface WorktreeRecord {
	readonly path: string;
	/** The branch checked out in it, short form, or nothing when detached. */
	readonly branch: string | undefined;
}

/** `git worktree list --porcelain`, as records. */
export function parseWorktrees(output: string): readonly WorktreeRecord[] {
	const records: WorktreeRecord[] = [];
	let path: string | undefined;
	let branch: string | undefined;
	const flush = () => {
		if (path !== undefined) records.push({ path, branch });
		path = undefined;
		branch = undefined;
	};
	for (const line of output.split("\n")) {
		if (line.startsWith("worktree ")) {
			flush();
			path = line.slice("worktree ".length).trim();
		} else if (line.startsWith("branch ")) {
			branch = line
				.slice("branch ".length)
				.trim()
				.replace(/^refs\/heads\//u, "");
		}
	}
	flush();
	return records;
}

/**
 * Every branch a person could pick: local ones and whatever `origin` has that
 * is not local yet, each named once.
 */
export async function listBranches(
	command: GitCommand,
	directory: string,
): Promise<readonly string[]> {
	const output = await runGit(
		command,
		["branch", "-a", "--format=%(refname:short)"],
		{ cwd: directory },
	);
	const names = output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.endsWith("HEAD"))
		.map((line) => line.replace(/^origin\//u, ""));
	return [...new Set(names)];
}

/**
 * The worktree for a branch, made if it is not there yet.
 *
 * The three cases are the ones `gwt co` has always had, and they are answered
 * the same way: an existing worktree for the branch is switched to rather than
 * duplicated, a directory in the way that is not a worktree is refused rather
 * than written into, and a branch that exists locally or on `origin` is checked
 * out rather than forked. A branch that does not exist yet starts from the
 * remote's default branch — see `baseRef`, which is where the one exception to
 * `gwt co` lives.
 */
export interface WorktreeOptions {
	/**
	 * Go ahead from the `origin` already on disk when the fetch fails.
	 *
	 * Absent means no: a fetch that fails stops the worktree and is reported,
	 * and this is set only when the person has been shown the reason and said
	 * to carry on anyway.
	 */
	readonly allowStaleBase?: boolean;
}

export async function ensureWorktree(
	command: GitCommand,
	directory: string,
	branch: string,
	options: WorktreeOptions = {},
): Promise<string> {
	const name = branch.trim();
	if (name.length === 0) {
		throw workspaceFailure("Enter a branch name.");
	}
	const repository = await readRepository(command, directory);
	if (!repository) {
		throw workspaceFailure(`${directory} is not a Git repository.`);
	}

	const existing = parseWorktrees(
		await runGit(command, ["worktree", "list", "--porcelain"], {
			cwd: directory,
		}),
	).find((record) => record.branch === name);
	if (existing) return existing.path;

	const target = worktreeDirectory(repository.mainWorktree, name);
	if (await exists(target)) {
		throw workspaceFailure(
			`${target} already exists and is not a worktree for ${name}.`,
		);
	}

	const args = (await branchExists(command, directory, name))
		? ["worktree", "add", target, name]
		: [
				"worktree",
				"add",
				"-b",
				name,
				target,
				await baseRef(command, directory, options),
			];
	await runGit(command, args, {
		cwd: directory,
		// Checking out a branch that only exists on `origin` fetches it.
		timeoutMs: NETWORK_TIMEOUT_MS,
	});
	return target;
}

/**
 * Where a new branch starts: the remote's default branch, brought up to date.
 *
 * Not the branch that happens to be checked out. Work on an Issue starts from
 * what everyone else is starting from, and a worktree made while standing on
 * somebody's half-finished branch would inherit it silently — which is the
 * kind of mistake that is only discovered in review.
 *
 * `origin/HEAD` is what "the default branch" means locally; it is refreshed
 * first, so a branch made today starts from what `origin` has today. A clone
 * with no `origin` has no such answer, and the branch checked out in the main
 * worktree is the closest thing the repository itself can say. When even that
 * is missing — a repository with no commits, or a detached head — DevHub says
 * so rather than picking something.
 *
 * The fetch happens every time, and a fetch that fails is not worked around
 * quietly. It stops the worktree and is reported with git's own reason, and the
 * step that asked for the branch offers the second answer: start from the
 * `origin` already on disk anyway. That is a decision with consequences — work
 * based on a copy that may be days old — so it is the person's to make, once,
 * where they can read why they are being asked.
 */
async function baseRef(
	command: GitCommand,
	directory: string,
	options: WorktreeOptions,
): Promise<string> {
	const hasOrigin =
		(await ask(command, ["remote", "get-url", "origin"], directory).catch(
			() => undefined,
		)) !== undefined;
	if (hasOrigin) {
		const fetched = await runGit(command, ["fetch", "origin"], {
			cwd: directory,
			timeoutMs: NETWORK_TIMEOUT_MS,
		}).then(
			() => true,
			(error: unknown) => {
				// Not swallowed: without leave to go on, this is the answer, and the
				// person is told what git said and asked what to do about it.
				if (!options.allowStaleBase) {
					throw fetchFailure(
						error instanceof Error ? error.message : String(error),
					);
				}
				return false;
			},
		);
		const head = await runGit(
			command,
			["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
			{ cwd: directory },
		).then(
			(value) => value.trim(),
			() => "",
		);
		if (head.length > 0) return head;
		// A clone made with `--single-branch`, or one whose `origin/HEAD` was
		// never set, has to be asked directly. This is the only place DevHub
		// talks to the remote for an answer rather than for objects — so it is
		// not attempted at all when the network has just been shown not to work.
		if (fetched) {
			const shown = await runGit(command, ["remote", "show", "origin"], {
				cwd: directory,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			const named = /^\s*HEAD branch:\s*(\S+)\s*$/mu.exec(shown)?.[1];
			if (named && named !== "(unknown)") return `origin/${named}`;
		}
	}
	const local = await readRepository(command, directory);
	if (local?.branch) return local.branch;
	throw workspaceFailure(
		"DevHub could not tell which branch a new branch should start from: this repository has no origin and no branch checked out.",
	);
}

async function branchExists(
	command: GitCommand,
	directory: string,
	branch: string,
): Promise<boolean> {
	for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
		const found = await runGit(
			command,
			["show-ref", "--verify", "--quiet", ref],
			{ cwd: directory },
		).then(
			() => true,
			() => false,
		);
		if (found) return true;
	}
	return false;
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** The name a repository's directory carries, for a label or a search. */
export function repositoryName(root: string): string {
	return baseName(root);
}

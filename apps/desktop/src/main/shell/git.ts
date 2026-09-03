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
	/**
	 * The root of the checkout the directory is *in*.
	 *
	 * The same as `mainWorktree` for the repository itself, and a different path
	 * for one of its worktrees — so the two together are what says which of the
	 * two a directory belongs to.
	 *
	 * Read separately from the asked-for directory, because that directory is
	 * often neither: a workspace opened at `repo/packages/app` is a subdirectory,
	 * and comparing *it* to `mainWorktree` says "not the main worktree", which is
	 * true and is not the question. That comparison is what made a plain
	 * subdirectory read as a worktree, and offered to remove it as one.
	 */
	readonly worktree: string;
	/** The branch checked out here, or nothing when the head is detached. */
	readonly branch: string | undefined;
	/**
	 * What this branch is called on the remote it is pushed to.
	 *
	 * Not always the local name. `git push origin HEAD:release-2` and a
	 * `branch.<name>.merge` written by hand both leave a branch whose local and
	 * remote names differ, and a pull request's head is the *remote* one — so
	 * searching for pull requests by the local name finds nothing at all for
	 * exactly the people who set this up deliberately.
	 *
	 * `%(push)` is git's own answer to "where does this branch push to", so it
	 * follows `push.default`, `remote.pushDefault` and
	 * `branch.<name>.pushRemote` without any of them being read here — but it is
	 * empty under the default `push.default=simple` for exactly the branches
	 * this field exists for, because `simple` refuses to push a branch whose
	 * remote name differs from its local one. So `%(upstream)` answers when
	 * `%(push)` does not: the branch is tracking `origin/release-2`, and
	 * `release-2` is what a pull request from it is headed by.
	 *
	 * Push first and upstream second, never the other way round: in the fork
	 * layout `gh repo fork` sets up, the upstream is `upstream/main` and the
	 * push destination is `origin/feature`. Reading upstream first would answer
	 * `main` — the trunk of somebody else's repository — for every branch in
	 * every fork.
	 *
	 * Absent when the branch has neither — nobody has pushed it and it tracks
	 * nothing — and the caller falls back to the local name, which is what the
	 * branch will be called the first time somebody pushes it.
	 */
	readonly pushBranch: string | undefined;
	/** `origin`, normalised so an HTTPS and an SSH clone compare equal. */
	readonly remote: RemoteIdentity | undefined;
	/**
	 * What `origin` says its default branch is, when the clone knows.
	 *
	 * `refs/remotes/origin/HEAD`, which a normal clone sets and a repository
	 * somebody built up by hand may not have. Absent is *not knowing*, and the
	 * one thing that reads it treats not knowing as a reason to stay quiet: it
	 * decides whether this branch is the trunk, and offering to open a pull
	 * request from the trunk is a button that cannot do anything useful.
	 */
	readonly defaultBranch: string | undefined;
	/**
	 * `upstream`, when the clone has one — the repository this one was forked
	 * from, by the name `gh repo fork` gives it.
	 *
	 * Read because Issues and pull requests do not live where the branch does in
	 * a fork. `origin` is the person's own fork: its Issues are either turned off
	 * or independently numbered, so `#128` in a branch name means an Issue in
	 * `upstream` and asking `origin` about it answers about the wrong repository
	 * or about nothing at all.
	 */
	readonly upstream: RemoteIdentity | undefined;
}

/**
 * Read the repository a directory belongs to, or nothing when it is a plain
 * folder.
 */
/**
 * Just the branch, in one command.
 *
 * The cheap half of `readRepository`, split out because it is the half that
 * *changes*: somebody runs `git switch` and the Sidebar should say so at once,
 * while the remote and the main worktree are the same as they were an hour ago.
 * Asking every couple of seconds is affordable exactly because it is one
 * command and not three.
 *
 * `undefined` means the same thing it means there: no branch to report, either
 * because this is not a repository or because the head is detached.
 */
export async function readBranch(
	command: GitCommand,
	directory: string,
): Promise<string | undefined> {
	const branch = await ask(
		command,
		["rev-parse", "--abbrev-ref", "HEAD"],
		directory,
	);
	return branch === undefined || branch.length === 0 || branch === "HEAD"
		? undefined
		: branch;
}

/**
 * Is there work here that removing this folder would destroy?
 *
 * `git status --porcelain` with untracked files included, because an untracked
 * file is work too: it is the thing somebody has written and not yet added, and
 * a folder deleted out from under it is the one way to lose it with no reflog
 * to go back to.
 *
 * `undefined` means DevHub could not tell — git would not answer — which is
 * deliberately different from "clean". Nothing destructive is offered on a
 * maybe.
 */
export async function readDirty(
	command: GitCommand,
	directory: string,
): Promise<boolean | undefined> {
	const status = await ask(command, ["status", "--porcelain"], directory).catch(
		() => undefined,
	);
	return status === undefined ? undefined : status.length > 0;
}

/**
 * How many commits are here that the branch's upstream does not have.
 *
 * `0` for a branch that is level with what it tracks, and `undefined` for a
 * branch with nothing to compare against — one nobody has pushed yet, or a
 * repository with no remotes. Those two are one answer here because they are
 * one answer to the question being asked: *is there anything to push?* is
 * unanswerable without an upstream, and a number invented for that case would
 * be a button offered for work that has nowhere to go.
 *
 * `@{u}` is git's own name for "whatever this branch tracks", so the comparison
 * follows a branch that was pushed somewhere other than `origin` and a fork
 * whose upstream is the fork. Reading it fails loudly for a repository git
 * cannot run in and quietly for a branch with no upstream, which is the same
 * split `ask` makes everywhere else.
 */
export async function readAhead(
	command: GitCommand,
	directory: string,
): Promise<number | undefined> {
	const count = await ask(
		command,
		["rev-list", "--count", "@{u}..HEAD"],
		directory,
	).catch(() => undefined);
	if (count === undefined) return undefined;
	const ahead = Number.parseInt(count, 10);
	return Number.isNaN(ahead) ? undefined : ahead;
}

/**
 * Remove a worktree. Let git refuse, unless the person has already been asked.
 *
 * Without `force`, git declines to remove a worktree with changes in it, and
 * that refusal is the last check standing between somebody and work they cannot
 * get back — DevHub's own idea of "clean" is a poll up to a minute old, so it is
 * never the authority. This is the path a removal takes when DevHub believes the
 * worktree is clean: nothing is confirmed, because there is nothing to lose, and
 * if the poll was stale git says so and nothing has happened.
 *
 * `force` is the other path, and it is only ever reached through the question
 * that names what will be destroyed. It exists because git's refusal is a dead
 * end otherwise: a worktree with uncommitted changes could not be removed from
 * DevHub at all, however sure the person was.
 *
 * The branch is not touched either way: see `removeWorktree` in the controller.
 */
export async function removeWorktree(
	command: GitCommand,
	mainWorktree: string,
	worktree: string,
	force: boolean,
): Promise<void> {
	await runGit(
		command,
		["worktree", "remove", ...(force ? ["--force"] : []), worktree],
		{ cwd: mainWorktree },
	);
}

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

	// Where this checkout starts, which is not where DevHub was asked to look:
	// the workspace may be any directory inside it.
	const worktree = await ask(
		command,
		["rev-parse", "--show-toplevel"],
		directory,
	);
	if (worktree === undefined) return undefined;

	const branch = await ask(
		command,
		["rev-parse", "--abbrev-ref", "HEAD"],
		directory,
	);
	const pushBranch =
		branch === undefined || branch === "HEAD"
			? undefined
			: await remoteBranchOf(command, directory, branch);
	const remote = await remoteNamed(command, directory, "origin");
	const upstream = await remoteNamed(command, directory, "upstream");
	// `origin/main`, trimmed to `main`. A clone that has never been told what
	// `origin`'s HEAD is answers nothing, which is not the same as `main`.
	const head = await ask(
		command,
		["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
		directory,
	).catch(() => undefined);
	const defaultBranch = head?.startsWith("origin/")
		? head.slice("origin/".length)
		: undefined;
	return {
		defaultBranch,
		mainWorktree,
		worktree,
		pushBranch,
		upstream,
		branch: branch === undefined || branch === "HEAD" ? undefined : branch,
		remote,
	};
}

/**
 * What a branch is called on the remote, or nothing when it has no remote at
 * all.
 *
 * Asks git for both destinations at once and takes the push destination when
 * there is one — see `pushBranch` for why that order and not the reverse.
 *
 * The remote's own name comes back alongside the ref so the prefix can be taken
 * off as a string. A remote may be called `my/fork`, and then
 * `refs/remotes/my/fork/release-2` has four leading components rather than
 * three: any fixed `strip` count answers `fork/release-2` for it, which is not
 * a branch anybody has.
 */
async function remoteBranchOf(
	command: GitCommand,
	directory: string,
	branch: string,
): Promise<string | undefined> {
	const line = await ask(
		command,
		[
			"for-each-ref",
			"--format=%(push:remotename)%09%(push)%09%(upstream:remotename)%09%(upstream)",
			`refs/heads/${branch}`,
		],
		directory,
	).catch(() => undefined);
	if (line === undefined) return undefined;
	const [pushRemote, push, upstreamRemote, upstream] = line.split("\t");
	return trimRemote(pushRemote, push) ?? trimRemote(upstreamRemote, upstream);
}

/** `refs/remotes/origin/release-2` under `origin`, as `release-2`. */
function trimRemote(
	remote: string | undefined,
	ref: string | undefined,
): string | undefined {
	if (!remote || !ref) return undefined;
	const prefix = `refs/remotes/${remote}/`;
	// A ref that does not start with its own remote is git telling us something
	// we do not understand, and answering the tail of it anyway would put a name
	// nobody has into a pull request search.
	if (!ref.startsWith(prefix)) return undefined;
	const name = ref.slice(prefix.length);
	return name.length > 0 ? name : undefined;
}

/**
 * One named remote, normalised, or nothing when the clone has no such remote.
 *
 * By name rather than by position, because the two names DevHub reads mean
 * different things: `origin` is where the branch is pushed and `upstream` is
 * where the work is discussed. A clone with neither is answered `undefined`
 * twice, which is what a repository with no remotes is.
 */
async function remoteNamed(
	command: GitCommand,
	directory: string,
	name: string,
): Promise<RemoteIdentity | undefined> {
	const url = await ask(command, ["remote", "get-url", name], directory).catch(
		() => undefined,
	);
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
	/**
	 * The branch is work that already exists somewhere else — a pull request's
	 * head — rather than a new one to start.
	 *
	 * It changes two things. The remote is fetched *before* the branch is looked
	 * for, because a pull request opened since the last fetch is a branch this
	 * clone has never heard of; and a name that is still nowhere afterwards is a
	 * failure rather than a branch to create, because creating it would hand
	 * somebody an empty branch under the name of the work they asked to review.
	 */
	readonly branchExistsAlready?: boolean;
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

	// Somebody else's branch: bring it here before asking whether it is here.
	// `branchExists` reads `refs/remotes/origin/…`, which is only as current as
	// the last fetch, so without this a pull request opened five minutes ago
	// looks like a branch that does not exist and would be created empty.
	if (options.branchExistsAlready)
		await fetchOrigin(command, directory, options);

	const target = worktreeDirectory(repository.mainWorktree, name);
	if (await exists(target)) {
		throw workspaceFailure(
			`${target} already exists and is not a worktree for ${name}.`,
		);
	}

	const here = await branchExists(command, directory, name);
	if (options.branchExistsAlready && !here) {
		throw workspaceFailure(
			`${name} is on neither this machine nor origin. A pull request from a fork has its branch on the fork, which this clone cannot see.`,
		);
	}
	const args = here
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
		const fetched = await fetchOrigin(command, directory, options);
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

/**
 * Bring `origin` up to date, or say why not.
 *
 * One implementation for the two reasons DevHub fetches — to start a branch
 * from what everyone else is starting from, and to find a branch somebody else
 * pushed — because they want the same thing from a failure: without leave to go
 * on it stops the worktree and is reported in git's own words, and with leave
 * it answers that the copy on disk is what there is.
 *
 * A repository with no `origin` has nothing to fetch and nothing to report.
 */
async function fetchOrigin(
	command: GitCommand,
	directory: string,
	options: WorktreeOptions,
): Promise<boolean> {
	const hasOrigin =
		(await ask(command, ["remote", "get-url", "origin"], directory).catch(
			() => undefined,
		)) !== undefined;
	if (!hasOrigin) return false;
	return runGit(command, ["fetch", "origin"], {
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

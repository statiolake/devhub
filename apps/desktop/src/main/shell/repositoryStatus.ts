/**
 * What each workspace is working on, kept up to date.
 *
 * Two questions, on one clock. The local one is free and always answerable:
 * which branch is checked out. The remote one costs a round trip to GitHub and
 * is asked for any workspace whose `origin` is a GitHub repository — *what is
 * this branch about?*, which is one question with two halves: the pull request
 * out from the branch, and the Issue the branch names when it names one. A
 * minute is the interval; nothing here reacts to a filesystem event, because a
 * poll that is late is a stale branch name and a watcher that is wrong is a
 * wrong one.
 *
 * **The branch is the unit, and that is a deliberate change.** DevHub used to
 * ask about an Issue, and could therefore only ask on behalf of a branch that
 * named one — a workspace on `spike/rework` with a pull request open had
 * nothing to show, because nothing had an Issue number to key it by. Everything
 * remote is now keyed by `owner/repo@branch`, which every workspace in a GitHub
 * repository has.
 *
 * **A failed look never blanks the display.** What was last known stays on
 * screen and the reason travels beside it, until a later look succeeds and
 * replaces both. The alternative — clearing on failure — makes a flaky network
 * look like an Issue that was closed.
 */

import type { RemoteIdentity } from "../../model/domain.js";
import { issueNumberFromBranch } from "../../model/github.js";
import type {
	RepositoryStatusWire,
	WorkspaceRepositoryWire,
} from "../../ipc/contract.js";
import {
	readAhead,
	readBranch,
	readDirty,
	readRepository,
	type GitCommand,
} from "./git.js";
import { TypedFailure } from "../../model/wire.js";
import {
	GitHubUnavailable,
	readBranchStatus,
	readGitHubToken,
	type BranchReference,
	type BranchStatus,
} from "./github.js";

/** One open workspace, as the watcher needs to see it. */
export interface WatchedWorkspace {
	readonly id: string;
	readonly root: string;
}

export interface RepositoryStatusDeps {
	readonly gitCommand: () => Promise<GitCommand>;
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly workspaces: () => readonly WatchedWorkspace[];
	readonly publish: (status: RepositoryStatusWire) => void;
}

/** How often the branch and the Issue are looked at again. */
export const POLL_INTERVAL_MS = 60 * 1000;
/** How often the branch alone is re-read. One local command per workspace. */
export const BRANCH_POLL_INTERVAL_MS = 2 * 1000;
/** How many branches one round is allowed to ask GitHub about. */
const MAX_BRANCHES_PER_ROUND = 16;

/**
 * The page a remote's repository is at, when DevHub can name one.
 *
 * `github.com/owner/repo` is the only shape it knows, so anything else — a
 * self-hosted remote, a host with a different URL scheme — gets nothing rather
 * than a link that goes somewhere wrong.
 */
function repositoryUrl(remote: string | undefined): string | undefined {
	if (!remote) return undefined;
	return /^github\.com\/[^/]+\/[^/]+$/u.test(remote)
		? `https://${remote}`
		: undefined;
}

/**
 * What identifies one remote question.
 *
 * The branch, not the Issue. Two workspaces on the same branch of the same
 * repository are asking the same question and are answered once; the Issue is
 * part of the answer rather than part of the key, because a branch names at
 * most one and most branches name none.
 */
function branchKey(reference: BranchReference): string {
	// Keyed by the name on the remote, because that is the question being
	// asked: two workspaces whose local branches are called different things
	// but push to the same remote branch are asking about the same pull
	// request, and one whose local name matches another's but pushes elsewhere
	// is not.
	return `${reference.owner}/${reference.repository}@${reference.headOwner}:${reference.remoteBranch}`;
}

/**
 * What this workspace's checked-out branch gives GitHub to answer about.
 *
 * Three answers, because there are three situations and only one of them is
 * "nothing to show". A workspace whose `origin` is not a GitHub repository has
 * nothing to ask, and that is a fact, not a failure. A branch that *names an
 * Issue* but whose remote cannot be turned into a GitHub repository is a
 * failure, and it used to be drawn exactly like the fact — which is how a
 * person on `feature/128-tidy` with a working `gh` was left with a blank line
 * and nothing to read.
 */
type BranchReading =
	| { readonly kind: "none" }
	| { readonly kind: "branch"; readonly reference: BranchReference }
	| {
			readonly kind: "unresolved";
			readonly number: number;
			readonly reason: string;
	  };

/**
 * What a workspace is working on: whatever its checked-out branch is about.
 *
 * The branch is the only link, for the Issue and for the pull request alike.
 * DevHub used to prefer a record written when the person assigned an Issue, and
 * fall back to the branch name — but a record cannot follow a checkout, so a
 * workspace assigned Issue 128 and then switched to `master` kept claiming 128.
 * The branch is read every round, so switching branches moves both the Issue
 * and the pull request with it, and a workspace sitting on `master` is linked
 * to whatever `master` itself has, which is the true answer.
 *
 * Only against a GitHub remote: a branch name means nothing without knowing
 * whose repository it is in, and the branch cannot say. That is why the remote
 * is still read from git rather than derived alongside it.
 *
 * **An alias is not resolved here, and deliberately.** `remoteIdentity` already
 * normalises a remote as far as it can be normalised without leaving the
 * machine — credentials, scheme, trailing `.git` — and what is left is a host
 * that is either `github.com` or is not. A `~/.ssh/config` alias (`git@gh:me/x`)
 * and a non-default port both survive that as something this pattern rejects.
 * Reading the SSH config to fold them in was considered and refused: the
 * identity is what `Repository.matchesRemote` compares clones by, so a second
 * rule that only this call site applies would make two remotes equal here and
 * unequal there — one fact with two answers, which is the shape of bug this
 * whole file exists to avoid. So the alias stays unresolved and says so, and if
 * folding aliases is ever wanted it belongs in `remoteIdentity`, once, for
 * every caller at the same time.
 */
/** `github.com/owner/repo`, split, or nothing when it is any other shape. */
function gitHubRepository(
	remote: string | undefined,
): { readonly owner: string; readonly repository: string } | undefined {
	const match =
		remote === undefined
			? undefined
			: /^github\.com\/([^/]+)\/([^/]+)$/u.exec(remote);
	const owner = match?.[1];
	const repository = match?.[2];
	return owner && repository ? { owner, repository } : undefined;
}

function branchFromLocal(
	remote: string | undefined,
	upstream: string | undefined,
	branch: string | undefined,
	pushBranch: string | undefined,
): BranchReading {
	if (branch === undefined) return { kind: "none" };
	const number = issueNumberFromBranch(branch);
	const head = gitHubRepository(remote);
	if (!head) {
		// Nothing to ask, and whether that is worth saying depends entirely on
		// whether the branch was making a claim. `spike/rework` on a self-hosted
		// remote is a workspace with nothing to show and no problem;
		// `feature/128-tidy` on the same remote is a branch that says it is about
		// Issue 128 and a row that cannot say whose.
		if (number === undefined) return { kind: "none" };
		return {
			kind: "unresolved",
			number,
			reason:
				remote === undefined
					? "this branch names an issue, but the workspace has no `origin` remote to say whose."
					: `\`origin\` is \`${remote}\`, which DevHub cannot read as a github.com repository, so it cannot tell whose issue this is.`,
		};
	}
	// Where the numbers live. In a fork the branch is in `origin` and the Issue
	// it names is in `upstream`: a fork's own Issues are either turned off or
	// numbered independently, so asking `origin` about `#128` answers about a
	// different Issue or about none. `upstream` is the name `gh repo fork`
	// gives it, which is what makes this a rule rather than a guess.
	//
	// An `upstream` DevHub cannot read as a github.com repository is ignored
	// rather than reported: it is a remote the person added for their own
	// reasons, and `origin` is still a perfectly good answer.
	const item = gitHubRepository(upstream) ?? head;
	return {
		kind: "branch",
		reference: {
			owner: item.owner,
			repository: item.repository,
			headOwner: head.owner,
			branch,
			// The name on the remote when git knows one, and the local name when
			// it does not. One rule, and the fallback is not a guess: a branch
			// with no push destination has not been pushed, and the name it will
			// have the first time somebody pushes it is the one it has here.
			remoteBranch: pushBranch ?? branch,
			...(number === undefined ? {} : { issueNumber: number }),
		},
	};
}

/** One workspace, as far as the local half of the round could get. */
interface LocalReading {
	readonly workspace: WatchedWorkspace;
	readonly branch?: string;
	/** The repository this workspace is a checkout of, as git identifies it. */
	readonly mainWorktree?: string;
	/** The root of the checkout it sits in, which may be neither of the above. */
	readonly worktree?: string;
	/** `origin`, kept so the fast clock can re-key a new branch without git. */
	readonly remote?: RemoteIdentity;
	/** `upstream`, kept for the same reason: it decides where to ask. */
	readonly upstream?: RemoteIdentity;
	/** Work here that removing the folder would destroy, as of the last look. */
	readonly dirty?: boolean;
	/** Commits the branch's upstream does not have, as of the last look. */
	readonly ahead?: number;
	/** What the branch is called on the remote, when git knows a push target. */
	readonly pushBranch?: string;
	/** What `origin` calls its default branch, when the clone knows. */
	readonly defaultBranch?: string;
	/** The repository's page, when `origin` is one DevHub can name a page for. */
	readonly repositoryUrl?: string;
	/** What GitHub is asked about, when there is a GitHub repository to ask. */
	readonly reference?: BranchReference;
	/** The Issue the branch named, when it named one nothing could be read for. */
	readonly number?: number;
	/** Why this row cannot answer yet, when the local half already knows. */
	readonly reason?: string;
}

/**
 * git's own last line, for a person to read.
 *
 * A `TypedFailure` is already a sentence written to be shown — it is what the
 * clone sheet puts in front of people — so it is used as it stands rather than
 * re-worded here. Anything else is an unexpected shape and says what it says.
 */
function gitReason(error: unknown): string {
	if (error instanceof TypedFailure) return error.wire.summary;
	return error instanceof Error ? error.message : String(error);
}

export class RepositoryStatusWatcher {
	private timer: ReturnType<typeof setInterval> | undefined;
	private running = false;
	private sequence = 0;
	/** What was being watched when the last look was started. */
	private watching: string | undefined;
	/** The last answer for each branch, kept so a failed round shows something. */
	private readonly known = new Map<string, BranchStatus>();
	/** The fast clock: what is checked out, which changes while you watch. */
	private branchTimer: ReturnType<typeof setInterval> | undefined;
	/** The last full local reading, one entry per workspace, in row order. */
	private local: LocalReading[] = [];
	/** Why each branch could not be read, by branch. Rebuilt each slow round. */
	private readonly unreadable = new Map<string, string>();
	/** The last round's note for the foot of the Sidebar. */
	private lastDiagnostic: string | undefined;
	/** git, as the last round resolved it, so the fast clock need not re-look. */
	private command: GitCommand | undefined;

	constructor(private readonly deps: RepositoryStatusDeps) {}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.refresh();
		}, POLL_INTERVAL_MS);
		// The fast clock, and the whole reason there are two. Which branch is
		// checked out changes while somebody watches — they run `git switch` and
		// look at the Sidebar — and it costs one local command to answer. What
		// GitHub says about an Issue costs a round trip and changes when somebody
		// on another continent clicks a button. Putting both on the slow clock
		// meant a branch you had just changed took up to a minute to appear.
		this.branchTimer = setInterval(() => {
			void this.refreshBranches();
		}, BRANCH_POLL_INTERVAL_MS);
		// Not `unref`'d: this is a projection the window is drawing, and the
		// interval is the only thing keeping it true.
		void this.refresh();
	}

	stop(): void {
		if (this.branchTimer) {
			clearInterval(this.branchTimer);
			this.branchTimer = undefined;
		}
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	/**
	 * The set of workspaces may have moved: look again if it actually did.
	 *
	 * Called whenever the projection changes, which is far more often than
	 * anything here can have changed — a selection, a resize, an agent's status.
	 * Comparing what is being watched is what keeps a poll a poll rather than
	 * something that runs git on every keystroke.
	 */
	observe(): void {
		const signature = this.deps
			.workspaces()
			.map((workspace) => workspace.id)
			.join("\n");
		if (signature === this.watching) return;
		this.watching = signature;
		void this.refresh();
	}

	/**
	 * Look now, because somebody asked.
	 *
	 * The same round the slow clock runs, not a second path: what a person means
	 * by "refresh" is "do the poll you were going to do anyway, now" — and a
	 * refresh that read something the poll does not would make the sidebar say
	 * two different things depending on how it was last updated. A round already
	 * in flight is left to finish (`refresh` refuses to overlap), which is the
	 * honest answer to asking for a look while one is happening.
	 */
	look(): void {
		void this.refresh();
	}

	/**
	 * One round.
	 *
	 * Rounds never overlap: a slow GitHub would otherwise stack requests every
	 * minute, and two rounds finishing out of order would publish an older
	 * answer over a newer one.
	 */
	private async refresh(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			this.deps.publish(await this.read());
		} finally {
			this.running = false;
		}
	}

	/**
	 * What is checked out, re-read and published at once.
	 *
	 * One command per workspace and nothing else: the remote and the main
	 * worktree are read on the slow clock because they are the same as they were
	 * an hour ago, and the Issue is asked about on the slow clock because that
	 * is a round trip. So a branch a person has just switched appears within a
	 * couple of seconds, and what the new branch is *about* fills in behind it.
	 *
	 * A branch that names an Issue nobody has asked about yet does not wait for
	 * the minute to be up: the slow round is asked for immediately, and until it
	 * answers the row says it is asking.
	 */
	private async refreshBranches(): Promise<void> {
		const command = this.command;
		if (!command || this.running || this.local.length === 0) return;
		let moved = false;
		let wantsLook = false;
		const next = await Promise.all(
			this.local.map(async (entry): Promise<LocalReading> => {
				// A row that could not be read at all is the slow round's problem:
				// re-running one command against a repository git refused would only
				// produce the same refusal, without the reason it collected.
				if (entry.reason !== undefined && entry.branch === undefined) {
					return entry;
				}
				const branch = await readBranch(command, entry.workspace.root).catch(
					() => entry.branch,
				);
				if (branch === entry.branch) return entry;
				moved = true;
				// The push name belongs to the branch that has just been left, so it
				// is dropped rather than carried onto the new one. Until the slow
				// round reads it again the new branch is asked about under its
				// local name — the same fallback a branch nobody has pushed gets
				// — and the round is asked for immediately below.
				const reading = branchFromLocal(
					entry.remote,
					entry.upstream,
					branch,
					undefined,
				);
				if (
					reading.kind === "branch" &&
					!this.known.has(branchKey(reading.reference))
				) {
					wantsLook = true;
				}
				return {
					workspace: entry.workspace,
					branch,
					mainWorktree: entry.mainWorktree,
					worktree: entry.worktree,
					remote: entry.remote,
					upstream: entry.upstream,
					pushBranch: undefined,
					repositoryUrl: entry.repositoryUrl,
					// The fast clock asks one question and this is not it; what the
					// slow clock last saw stands until it looks again.
					dirty: entry.dirty,
					ahead: entry.ahead,
					defaultBranch: entry.defaultBranch,
					...(reading.kind === "branch"
						? { reference: reading.reference }
						: {}),
					...(reading.kind === "unresolved"
						? { number: reading.number, reason: reading.reason }
						: {}),
				};
			}),
		);
		if (!moved) return;
		this.local = next;
		this.deps.publish(this.project());
		// The branch is on screen; what it is about is now worth asking for
		// rather than waiting the rest of the minute out.
		if (wantsLook) void this.refresh();
	}

	private async read(): Promise<RepositoryStatusWire> {
		const workspaces = this.deps.workspaces();
		let diagnostic: string | undefined;

		const command = await this.deps.gitCommand().catch((error: unknown) => {
			diagnostic = error instanceof Error ? error.message : String(error);
			return undefined;
		});
		this.command = command;

		const local = await Promise.all(
			workspaces.map(async (workspace): Promise<LocalReading> => {
				// No git at all: every row is blocked by the one thing, and says so.
				// The Sidebar's note carries it too, exactly as it always has.
				if (!command) {
					return { workspace, reason: diagnostic };
				}
				let facts;
				try {
					facts = await readRepository(command, workspace.root);
				} catch (error: unknown) {
					// `readRepository` answers `undefined` for the one case that is not
					// a failure — a plain folder that is not a repository — so anything
					// thrown here is git refusing: a timeout, a permission, a broken
					// index, a repository owned by somebody else. This used to be
					// swallowed whole, which left the row blank with no branch and no
					// reason, indistinguishable from a workspace nobody had started
					// work in. It is the failure this file is least able to guess at
					// and the one most worth reading, so it is git's own last line.
					const reason = `DevHub could not read this repository: ${gitReason(error)}`;
					// It belongs in the Sidebar's note as well: one workspace whose git
					// is broken is usually every workspace, and the note is where a
					// person looks when the whole list has gone quiet.
					diagnostic ??= reason;
					return { workspace, reason };
				}
				const reading = branchFromLocal(
					facts?.remote,
					facts?.upstream,
					facts?.branch,
					facts?.pushBranch,
				);
				// Only where it can mean something. A workspace that is not a
				// repository has nothing to be dirty about, and asking anyway would
				// be one more command per row per minute for an answer nobody reads.
				const dirty = facts
					? await readDirty(command, workspace.root)
					: undefined;
				const ahead = facts
					? await readAhead(command, workspace.root)
					: undefined;
				return {
					workspace,
					branch: facts?.branch,
					dirty,
					ahead,
					defaultBranch: facts?.defaultBranch,
					mainWorktree: facts?.mainWorktree,
					worktree: facts?.worktree,
					remote: facts?.remote,
					upstream: facts?.upstream,
					pushBranch: facts?.pushBranch,
					repositoryUrl: repositoryUrl(facts?.remote),
					...(reading.kind === "branch"
						? { reference: reading.reference }
						: {}),
					...(reading.kind === "unresolved"
						? { number: reading.number, reason: reading.reason }
						: {}),
				};
			}),
		);

		this.local = local;
		this.lastDiagnostic = diagnostic;
		// The local half is done and costs nothing to show, so it is shown now
		// rather than after a round trip to GitHub. Branches, and the reasons a
		// row cannot name one, are on screen while the Issues are still being
		// asked about; the rows that are waiting say so.
		this.deps.publish(this.project());

		const wanted = new Map<string, BranchReference>();
		for (const entry of local) {
			if (entry.reference)
				wanted.set(branchKey(entry.reference), entry.reference);
		}

		/**
		 * Why each branch could not be read this round, for the rows that are on
		 * them.
		 *
		 * The same reasons the Sidebar's foot has said all along, kept against
		 * the branch they belong to instead of only in one line that names none of
		 * them. A round that succeeds for one branch and fails for another now
		 * says which was which.
		 */
		// Not cleared: a reason from the last round is what was last known about
		// that branch, and blanking it for the length of a round trip would make a
		// persistent failure flicker between its reason and a spinner every
		// minute. Entries are replaced when a look fails again, dropped when one
		// succeeds, and pruned below once the round knows what is still wanted.
		const unreadable = this.unreadable;
		if (wanted.size > 0) {
			const credentials = await readGitHubToken(this.deps.environment);
			if (credentials.kind !== "token") {
				// Two problems with two fixes. Telling somebody who has no `gh` to
				// run `gh auth login` is advice that cannot work, given for a reason
				// that was never the reason — so each says what happened and what
				// would change it.
				diagnostic =
					credentials.kind === "unrunnable"
						? `DevHub could not run \`gh\` to get GitHub credentials: ${credentials.reason}. Install the GitHub CLI, or point DevHub's PATH at it, to show issue and pull request status.`
						: "DevHub has no GitHub credentials. Run `gh auth login` to show issue and pull request status.";
				// Not one branch's problem: none of them were asked about, so every
				// row that was expecting an answer says so.
				for (const key of wanted.keys()) unreadable.set(key, diagnostic);
			} else {
				const token = credentials.token;
				const asking = [...wanted.values()];
				for (const [index, reference] of asking.entries()) {
					const key = branchKey(reference);
					if (index >= MAX_BRANCHES_PER_ROUND) {
						// Over the round's budget. A row left blank because DevHub ran
						// out of requests is indistinguishable from one that failed,
						// unless it says which it is.
						unreadable.set(
							key,
							`DevHub asks GitHub about ${String(MAX_BRANCHES_PER_ROUND)} branches a round; this one is in the next.`,
						);
						continue;
					}
					try {
						this.known.set(key, await readBranchStatus(reference, token));
						unreadable.delete(key);
					} catch (error: unknown) {
						// Only GitHub's own refusals are reported this way. Anything
						// else is a bug in DevHub, and it goes to the root handler
						// rather than being drawn as a status line.
						if (!(error instanceof GitHubUnavailable)) throw error;
						diagnostic = error.message;
						unreadable.set(key, error.message);
					}
				}
			}
		}

		// Reasons for branches nothing is on any more: the rows that carried
		// them have gone or moved to another branch.
		for (const key of [...unreadable.keys()]) {
			if (!wanted.has(key)) unreadable.delete(key);
		}
		this.lastDiagnostic = diagnostic;
		return this.project();
	}

	/**
	 * The rows, from everything currently known.
	 *
	 * Built from state rather than from one round's locals, because two clocks
	 * publish it: the fast one that has just re-read a branch, and the slow one
	 * that has just heard back from GitHub. One projection means the two cannot
	 * draw a row differently.
	 */
	private project(): RepositoryStatusWire {
		const projected: WorkspaceRepositoryWire[] = this.local.map((entry) => {
			const key = entry.reference ? branchKey(entry.reference) : undefined;
			const status = key === undefined ? undefined : this.known.get(key);
			const issueNumber = entry.reference?.issueNumber;
			// What was last known outranks a look that failed — the same rule the
			// Sidebar's own note follows, so a network that dropped never reads as
			// an Issue that closed. The reason is drawn on the row only when there
			// is nothing known to draw instead.
			//
			// A reason the local half already found outranks anything GitHub could
			// have said, because when it is set GitHub was never asked: there was no
			// repository to read, or no remote to say whose branch this is. That one
			// is always the row's own — git refused for *this* workspace, and no
			// other row's reason explains it.
			//
			// GitHub's is drawn only where the row was expecting an answer a person
			// can name: a branch that names an Issue. Every branch in a GitHub
			// repository is now asked about, including the ones that will never have
			// a pull request, so drawing that failure on all of them would put a red
			// line on every row in the window whenever the network drops — saying
			// once per row exactly what the Sidebar's foot already says once.
			const remoteReason =
				key === undefined || issueNumber === undefined
					? undefined
					: this.unreadable.get(key);
			const reason = status ? undefined : (entry.reason ?? remoteReason);
			const number = issueNumber ?? entry.number;
			return {
				workspaceId: entry.workspace.id,
				branch: entry.branch,
				mainWorktree: entry.mainWorktree,
				worktree: entry.worktree,
				repositoryUrl: entry.repositoryUrl,
				dirty: entry.dirty,
				ahead: entry.ahead,
				defaultBranch: entry.defaultBranch,
				issue: status?.issue,
				pullRequest: status?.pullRequest,
				// Known which Issue, no answer yet, nothing wrong: the row says it
				// is asking rather than showing the blank that means "about
				// nothing". Only ever one of the three.
				//
				// Only for a branch that names an Issue, for the same reason the
				// failure above is: a branch that names none is being asked a
				// question whose ordinary answer is "there is no pull request", and a
				// spinner on every row in the window every minute would be that
				// answer drawn as suspense.
				pending:
					status === undefined &&
					reason === undefined &&
					issueNumber !== undefined
						? { number: issueNumber }
						: undefined,
				unavailable:
					reason === undefined
						? undefined
						: number === undefined
							? { reason }
							: { number, reason },
			};
		});

		this.sequence += 1;
		return {
			sequence: this.sequence,
			workspaces: projected,
			// The note carries only what no row carried.
			//
			// It used to carry everything, so the ordinary failure — GitHub would
			// not answer about this branch's Issue — was written twice: in red on
			// the row it belongs to, and again in grey at the foot of the list,
			// where it named no row at all. Two places saying one thing is worse
			// than either alone: the second is read as a second problem, and the
			// one that is easier to write drifts.
			//
			// It is not deleted, because a reason can still be collected that no
			// row is able to show — `gh` missing on a machine whose workspaces are
			// all on branches that name no Issue is the real one. That failure has
			// nowhere else to go, and a failure with nowhere to go is the thing
			// this whole file is written to avoid. So the rule is not "never show
			// it" but "show it exactly once", and the note is where once means
			// when no row can.
			diagnostic:
				this.lastDiagnostic !== undefined &&
				projected.some((row) => row.unavailable?.reason === this.lastDiagnostic)
					? undefined
					: this.lastDiagnostic,
		};
	}
}

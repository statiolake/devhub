/**
 * What each workspace is working on, kept up to date.
 *
 * Two questions. The first is cheap and always answerable: which branch is
 * checked out, asked of the machine the checkout is on. The second costs a
 * round trip to GitHub and is asked for any workspace whose `origin` is a
 * GitHub repository — *what is this branch about?*, which is one question with
 * two halves: the pull request out from the branch, and the Issue the branch
 * names when it names one. GitHub is always asked from *this* machine, whatever
 * machine the checkout is on: the credentials and the network are here, and all
 * that has to come from the far end is the remote and the branch.
 *
 * **A clock per machine, not a clock.** A poll interval is a fact about a link
 * — the number that is a fork on this Mac is a flood on a host across an ocean
 * — so each machine with an open Workspace on it gets its own pair of clocks at
 * its own `cadence.repositoryPollMs`, and a slow host cannot hold this Mac's
 * rows up. There is still exactly one projection, published by all of them, so
 * no row can be drawn two ways.
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
import { activityCounters, COUNTER } from "../diagnostics/counters.js";
import { issueNumberFromBranch } from "../../model/github.js";
import { HeadWatcher } from "./headWatcher.js";
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
import type { Runtime, RuntimeId } from "../runtime/runtime.js";
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
	/**
	 * The machine its folder is on.
	 *
	 * On the workspace and not on the watcher, because that is where the fact
	 * lives: two open Workspaces can sit on two machines, the git that reads
	 * one of them means nothing on the other, and what a poll may cost is a
	 * property of the link and not of this class.
	 */
	readonly runtime: Runtime;
}

export interface RepositoryStatusDeps {
	/** The git for one machine, resolved on it. */
	readonly gitCommand: (runtime: Runtime) => Promise<GitCommand>;
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly workspaces: () => readonly WatchedWorkspace[];
	readonly publish: (status: RepositoryStatusWire) => void;
}

/**
 * How often the branch and the Issue are looked at again, and how often the
 * branch is re-read when nothing said it had changed.
 *
 * Both are `cadence.repositoryPollMs`, read from the runtime each Workspace's
 * folder is on, because both are the same question about the same link: what a
 * poll of *that* machine may cost. They used to be two constants that happened
 * to be a minute each, and a third copy of the number sat in `local.ts`
 * claiming to be the source.
 *
 * The fast one used to be every two seconds, which was thirty-eight `git`
 * processes a minute per workspace to learn thirty-eight times that nothing
 * moved. A checkout writes `HEAD`, so `headWatcher.ts` notices one instead,
 * and what is left is the safety net under a watcher rather than the way the
 * branch is normally learned. A missed event costs one interval of staleness
 * rather than a branch name that is wrong until somebody restarts DevHub.
 */
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

/**
 * The two clocks one machine's checkouts are polled on.
 *
 * Per machine and not per watcher, because a poll interval is a fact about a
 * link: the number that is a fork on this Mac is a flood on a host across an
 * ocean, and one pair of clocks covering both would have to pick one of them.
 */
interface Clocks {
	readonly runtime: Runtime;
	readonly slow: ReturnType<typeof setInterval>;
	readonly fast: ReturnType<typeof setInterval>;
}

export class RepositoryStatusWatcher {
	/** One pair of clocks per machine that has an open Workspace on it. */
	private readonly clocks = new Map<RuntimeId, Clocks>();
	/** The machines with a round in flight, so a slow link never stacks them. */
	private readonly inFlight = new Set<RuntimeId>();
	private sequence = 0;
	/** What was being watched when the last look was started. */
	private watching: string | undefined;
	/** The last answer for each branch, kept so a failed round shows something. */
	private readonly known = new Map<string, BranchStatus>();
	/** The last local reading for each workspace, by workspace id. */
	private readonly readings = new Map<string, LocalReading>();
	/** Why each branch could not be read, by branch. Rebuilt each slow round. */
	private readonly unreadable = new Map<string, string>();
	/**
	 * The last round's note, per machine.
	 *
	 * Per machine because that is what these notes are about — no `git` here, a
	 * host that would not answer, no GitHub credentials — and a single slot
	 * would let one machine's round erase the other's reason a minute at a time.
	 */
	private readonly diagnostics = new Map<RuntimeId, string | undefined>();
	/** git, as each machine's last round resolved it, by machine. */
	private readonly commands = new Map<RuntimeId, GitCommand>();
	/** `HEAD`, watched, so a checkout is noticed rather than polled for. */
	private readonly heads = new HeadWatcher(() => {
		void this.refreshBranches();
	});
	private stopped = false;

	constructor(private readonly deps: RepositoryStatusDeps) {}

	start(): void {
		this.stopped = false;
		this.follow();
	}

	stop(): void {
		this.stopped = true;
		this.heads.stop();
		for (const id of [...this.clocks.keys()]) this.unfollow(id);
	}

	/**
	 * Run a pair of clocks for exactly the machines that have Workspaces on them.
	 *
	 * The only place a clock is started or stopped, for the reason the Agent
	 * reconciler has one: "which loops exist" has to have one answer. A machine
	 * that has just gained its first Workspace is polled at once rather than
	 * waiting the interval out, and one that has lost its last stops costing
	 * anything — an ssh runtime with nothing open on it must not go on paying a
	 * round trip a minute to be told so.
	 */
	private follow(): void {
		if (this.stopped) return;
		const wanted = new Map<RuntimeId, Runtime>();
		for (const workspace of this.deps.workspaces()) {
			wanted.set(workspace.runtime.id, workspace.runtime);
		}
		for (const id of [...this.clocks.keys()]) {
			if (!wanted.has(id)) this.unfollow(id);
		}
		for (const [id, runtime] of wanted) {
			if (this.clocks.has(id)) continue;
			// Not `unref`'d: this is a projection the window is drawing, and the
			// interval is the only thing keeping it true.
			this.clocks.set(id, {
				runtime,
				slow: setInterval(() => {
					activityCounters.record(COUNTER.repositoryStatusRound);
					void this.refresh(runtime);
				}, runtime.cadence.repositoryPollMs),
				// The fast clock, and the whole reason there are two. Which branch
				// is checked out changes while somebody watches — they run
				// `git switch` and look at the Sidebar — and it costs one command
				// to answer. What GitHub says about an Issue costs a round trip and
				// changes when somebody on another continent clicks a button.
				// Putting both on the slow clock meant a branch you had just
				// changed took up to a minute to appear.
				//
				// The safety net, not the mechanism. `heads` is what makes a
				// checkout appear at once; this is what keeps a branch from staying
				// wrong forever if an event is ever missed or a checkout could not
				// be watched at all.
				fast: setInterval(() => {
					activityCounters.record(COUNTER.repositoryBranchRound);
					void this.refreshBranches();
				}, runtime.cadence.repositoryPollMs),
			});
			void this.refresh(runtime);
		}
	}

	private unfollow(id: RuntimeId): void {
		const clocks = this.clocks.get(id);
		if (!clocks) return;
		clearInterval(clocks.slow);
		clearInterval(clocks.fast);
		this.clocks.delete(id);
		this.commands.delete(id);
		this.diagnostics.delete(id);
	}

	/**
	 * The set of workspaces may have moved: look again if it actually did.
	 *
	 * Called whenever the projection changes, which is far more often than
	 * anything here can have changed — a selection, a resize, an agent's status.
	 * Comparing what is being watched is what keeps a poll a poll rather than
	 * something that runs git on every keystroke. The machine is part of the
	 * comparison, because a Workspace relocated to another host is the same id
	 * asking a different machine.
	 */
	observe(): void {
		const signature = this.deps
			.workspaces()
			.map((workspace) => `${workspace.id} ${workspace.runtime.id}`)
			.join("\n");
		if (signature === this.watching) return;
		this.watching = signature;
		// `follow` polls a machine that has just appeared; the ones that were
		// already there are asked again because their set of Workspaces moved.
		const existing = [...this.clocks.values()].map((clocks) => clocks.runtime);
		this.follow();
		for (const runtime of existing) void this.refresh(runtime);
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
		for (const clocks of this.clocks.values())
			void this.refresh(clocks.runtime);
	}

	/**
	 * One round, against one machine.
	 *
	 * Rounds never overlap *per machine*: a slow GitHub would otherwise stack
	 * requests every minute, and two rounds finishing out of order would publish
	 * an older answer over a newer one. Two machines do overlap, and must — that
	 * is the whole reason a cadence belongs to a link rather than to this class.
	 */
	private async refresh(runtime: Runtime): Promise<void> {
		if (this.inFlight.has(runtime.id)) return;
		this.inFlight.add(runtime.id);
		try {
			this.deps.publish(await this.read(runtime));
		} finally {
			this.inFlight.delete(runtime.id);
		}
	}

	/** The Workspaces whose folder is on one machine, in row order. */
	private on(runtime: Runtime): readonly WatchedWorkspace[] {
		return this.deps
			.workspaces()
			.filter((workspace) => workspace.runtime.id === runtime.id);
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
	 *
	 * Every machine at once, and each row against the git its own machine
	 * resolved. There is no per-machine version of this: what it costs is one
	 * cheap command per open Workspace either way, and splitting it would be a
	 * second answer to "what is checked out" for no saving.
	 */
	private async refreshBranches(): Promise<void> {
		let moved = false;
		const wantsLook = new Set<RuntimeId>();
		await Promise.all(
			this.deps.workspaces().map(async (workspace) => {
				const command = this.commands.get(workspace.runtime.id);
				const entry = this.readings.get(workspace.id);
				if (!command || !entry || this.inFlight.has(workspace.runtime.id)) {
					return;
				}
				// A row that could not be read at all is the slow round's problem:
				// re-running one command against a repository git refused would only
				// produce the same refusal, without the reason it collected.
				if (entry.reason !== undefined && entry.branch === undefined) return;
				const branch = await readBranch(command, entry.workspace.root).catch(
					() => entry.branch,
				);
				if (branch === entry.branch) return;
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
					wantsLook.add(workspace.runtime.id);
				}
				this.readings.set(workspace.id, {
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
				});
			}),
		);
		if (!moved) return;
		this.deps.publish(this.project());
		// The branch is on screen; what it is about is now worth asking for
		// rather than waiting the rest of the minute out.
		for (const id of wantsLook) {
			const clocks = this.clocks.get(id);
			if (clocks) void this.refresh(clocks.runtime);
		}
	}

	private async read(runtime: Runtime): Promise<RepositoryStatusWire> {
		const workspaces = this.on(runtime);
		let diagnostic: string | undefined;

		const command = await this.deps
			.gitCommand(runtime)
			.catch((error: unknown) => {
				diagnostic = error instanceof Error ? error.message : String(error);
				return undefined;
			});
		if (command) this.commands.set(runtime.id, command);
		else this.commands.delete(runtime.id);

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
					// index, a repository owned by somebody else, a host that would not
					// answer. This used to be swallowed whole, which left the row blank
					// with no branch and no reason, indistinguishable from a workspace
					// nobody had started work in. It is the failure this file is least
					// able to guess at and the one most worth reading, so it is git's
					// own last line.
					const reason = `DevHub could not read this repository: ${gitReason(error)}`;
					// It belongs in the Sidebar's note as well: one workspace whose git
					// is broken is usually every workspace on that machine, and the
					// note is where a person looks when the list has gone quiet.
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

		for (const entry of local) this.readings.set(entry.workspace.id, entry);
		// Awaited, so a checkout that could not be watched is already known when
		// this round decides what the Sidebar's note says. Re-arming here and
		// nowhere else is what makes a worktree created or removed since the last
		// round pick up, or lose, its watcher.
		await this.armHeads();
		diagnostic ??= this.watchDiagnostic();
		this.diagnostics.set(runtime.id, diagnostic);
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
			// GitHub is asked from *this* machine, whichever machine the checkout
			// is on. The token and the network are here; the host the repository
			// sits on may have neither, and would be a second set of credentials
			// to keep if it did. All that came from the far end is the key — the
			// remote, and the branch — which is what `read` has just collected.
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
		// them have gone or moved to another branch. Every row, not this
		// machine's — the branch is the key, and two machines can be on one.
		const live = new Set<string>();
		for (const entry of this.readings.values()) {
			if (entry.reference) live.add(branchKey(entry.reference));
		}
		for (const key of [...unreadable.keys()]) {
			if (!live.has(key)) unreadable.delete(key);
		}
		this.diagnostics.set(runtime.id, diagnostic);
		return this.project();
	}

	/**
	 * The rows, from everything currently known.
	 *
	 * Built from state rather than from one round's locals, because three things
	 * publish it: the fast clock that has just re-read a branch, and one slow
	 * clock per machine that has just heard back from GitHub. One projection
	 * means none of them can draw a row differently.
	 */
	/**
	 * Watch every checkout that is open, and nothing else.
	 *
	 * Keyed by workspace, rooted at the checkout git reported rather than at the
	 * folder the workspace was opened at: a workspace opened three directories
	 * inside a repository has no `.git` of its own, and a linked worktree's
	 * `HEAD` is not the main one's.
	 *
	 * Every machine's checkouts at once, because the watcher is asked for the
	 * set it should be watching and a set with one machine's rows missing is a
	 * set that closes the other machine's watchers.
	 */
	private async armHeads(): Promise<void> {
		await this.heads.arm(
			[...this.readings.values()].flatMap((entry) => {
				const command = this.commands.get(entry.workspace.runtime.id);
				// No git means no checkout was read on that machine, so there is
				// nothing whose git directory is known.
				if (entry.worktree === undefined || command === undefined) return [];
				return [
					{
						key: entry.workspace.id,
						worktree: entry.worktree,
						// The machine the checkout is on is the machine its git ran
						// on. There is not a second answer to ask for, and asking one
						// would be how the two drift.
						runtime: command.runtime,
					},
				];
			}),
		);
	}

	/**
	 * What to say when a checkout is only being polled.
	 *
	 * The fallback is safe — the branch is still re-read every minute — and
	 * saying nothing about it is what would make it dangerous: a row a minute
	 * behind everything else looks exactly like DevHub working. So it is a
	 * sentence, and `repository.head.watch.failed` counts it for `--metrics`.
	 */
	private watchDiagnostic(): string | undefined {
		const failures = this.heads.failures();
		const first = failures[0];
		if (!first) return undefined;
		const rest =
			failures.length > 1 ? ` (and ${String(failures.length - 1)} more)` : "";
		return `DevHub could not watch ${first.worktree} for branch changes${rest}: ${first.reason}. The branch there is re-read once a minute instead.`;
	}

	private project(): RepositoryStatusWire {
		const open = this.deps.workspaces();
		// A Workspace that has closed keeps no reading: the row it belonged to is
		// gone, and a reading nothing draws is a reading that goes stale unseen.
		const ids = new Set(open.map((workspace) => workspace.id));
		for (const id of [...this.readings.keys()]) {
			if (!ids.has(id)) this.readings.delete(id);
		}
		// In the model's order, and only the Workspaces a round has read: one
		// that opened a moment ago has no branch to draw yet and its machine's
		// round is already on its way.
		const entries = open.flatMap((workspace) => {
			const entry = this.readings.get(workspace.id);
			return entry ? [entry] : [];
		});
		const projected: WorkspaceRepositoryWire[] = entries.map((entry) => {
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
		//
		// One note for however many machines are being polled: the foot of the
		// Sidebar is one line, and the first reason collected is the one it
		// carries. Which machine it came from is in the sentence itself, because
		// it is git's or the runtime's own words about a path on that machine.
		const note = [...this.diagnostics.values()].find(
			(reason) => reason !== undefined,
		);
		return {
			sequence: this.sequence,
			workspaces: projected,
			diagnostic:
				note !== undefined &&
				projected.some((row) => row.unavailable?.reason === note)
					? undefined
					: note,
		};
	}
}

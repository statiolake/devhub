/**
 * What GitHub is asked, and how DevHub is allowed to ask it.
 *
 * One GraphQL query per branch DevHub is watching, built here rather than
 * shelled out to `gh`: the CLI's own queries fetch far more than a title and a
 * pull request's state, and this runs every minute.
 *
 * The token is read from `gh auth token` and used. It is never written to a
 * config file, never logged, and never put in an error message — a failure says
 * that authentication was refused, not what was refused with.
 */

import { spawn } from "node:child_process";
import { activityCounters, COUNTER } from "../diagnostics/counters.js";
import type { IssueReference } from "../../model/github.js";
import { errorWireAt, NamedFailure, withDetail } from "../../model/wire.js";

/**
 * A workspace's checked-out branch, as GitHub names the things it is about.
 *
 * The branch is the subject and the Issue is optional, which is the opposite of
 * how this used to read. A branch always has a pull request question to ask —
 * *is there one out from here?* — and only some branches name an Issue.
 *
 * Two repositories, because in a fork they are two. The Issue and the pull
 * request live in `owner/repository` — `upstream`, where the work is discussed
 * — and the branch lives in `headOwner`'s copy of it, which is the person's own
 * fork. They are the same for everybody not working in a fork, and nothing
 * downstream of here branches on which case it is.
 */
export interface BranchReference {
	/** Where Issues and pull requests are numbered: `upstream`, or `origin`. */
	readonly owner: string;
	readonly repository: string;
	/** Who owns the branch — the fork, when the work is being done in one. */
	readonly headOwner: string;
	/** The short name, as git reports it: `feature/128-wip`, not a `refs/` path. */
	readonly branch: string;
	/**
	 * What that branch is called on the remote, which is what a pull request's
	 * head actually is.
	 *
	 * Usually the same string as `branch`, and the two are separate because
	 * "usually" is not "always": a branch pushed with `HEAD:release-2`, or one
	 * whose `branch.<name>.merge` was written by hand, has a different name at
	 * each end. Searching by the local name finds nothing for exactly the people
	 * who arranged that on purpose. It falls back to the local name for a branch
	 * with no push destination, which is what that branch will be called the
	 * first time anybody pushes it.
	 */
	readonly remoteBranch: string;
	/** The Issue the branch names, by DevHub's convention, when it names one. */
	readonly issueNumber?: number;
}

/** What GitHub says a branch is about. Either half may be absent. */
export interface BranchStatus {
	readonly issue?: IssueStatus;
	readonly pullRequest?: PullRequestStatus;
}

export interface IssueStatus {
	readonly number: number;
	readonly title: string;
	readonly state: "open" | "closed";
	readonly url: string;
}

/**
 * The pull request out from this branch.
 *
 * All four states, because all four are now reachable. DevHub used to find a
 * pull request by parsing closing keywords out of the bodies of a repository's
 * *open* pull requests, so `open` and `draft` were the whole of what could
 * arrive; asking the branch directly answers about the merged and closed ones
 * too, and "this branch has already landed" is the single most useful thing a
 * workspace row can say about a branch nobody has deleted yet.
 */
export interface PullRequestStatus {
	readonly number: number;
	readonly url: string;
	readonly title: string;
	readonly state: "open" | "draft" | "closed" | "merged";
	readonly conversations: ConversationCount;
	/** Its head commit's CI, or absent when nothing has reported on that commit. */
	readonly checks?: CheckSummary;
}

/**
 * What a pull request's CI says about its head commit.
 *
 * `state` is GitHub's own rollup over every check run and commit status,
 * folded into the three verdicts a person acts on: something failed
 * (`FAILURE`, `ERROR`), something has not finished or not started (`PENDING`,
 * `EXPECTED`), or everything that reported passed (`SUCCESS`). It is GitHub's
 * verdict and not one recomputed here from the counts, because the rollup is
 * what the pull request page and branch protection go by.
 *
 * The counts are how many checks are in each of the two verdicts that ask
 * something of you, out of `total`, so the words can say "3 of 12". A check run
 * that was cancelled, timed out, could not start or wants an action is failing,
 * as GitHub's own rollup counts it; one queued, in progress or waiting is
 * pending, as is a commit status that is expected and has not reported yet.
 */
export interface CheckSummary {
	readonly state: "passing" | "failing" | "pending";
	readonly total: number;
	readonly failing: number;
	readonly pending: number;
}

/**
 * A pull request's review conversations nobody has resolved yet.
 *
 * Counted from the first `MAX_REVIEW_THREADS` of them, which GitHub lists
 * oldest first, and `uncounted` says how many were past that and not looked
 * at. Nearly always nought: a pull request with more than a hundred review
 * threads is rare, and paging through the rest would be a second request per
 * branch per minute for it. Carried rather than dropped so that a count that is
 * a lower bound is never said as the whole of it.
 */
export interface ConversationCount {
	readonly unresolved: number;
	readonly uncounted: number;
}

/**
 * A failure with words, never carrying the token: GitHub's own, or DevHub's
 * about what GitHub answered. Drawn under its own title with those words as
 * the detail, and read as that title and those words wherever it is text.
 */
export class GitHubUnavailable extends NamedFailure {
	constructor(reason: string) {
		super(withDetail(errorWireAt("github_unavailable"), reason));
		this.name = "GitHubUnavailable";
	}
}

const ENDPOINT = "https://api.github.com/graphql";
const GH_TIMEOUT_MS = 10 * 1000;
const REQUEST_TIMEOUT_MS = 20 * 1000;
/**
 * How many of a branch's pull requests are read.
 *
 * Only ever a handful: these are the pull requests whose *head* is this one
 * branch, and the ordinary answer is nought or one. A few are asked for so the
 * rule below has something to choose between when a branch has been reopened
 * onto a second pull request, and no more, because the query runs every minute.
 */
const MAX_PULL_REQUESTS = 10;
/**
 * How many of a pull request's review threads are read to count the unresolved
 * ones. GitHub's own ceiling for one page; see `ConversationCount`.
 */
const MAX_REVIEW_THREADS = 100;

/**
 * What a branch is about, in one round trip.
 *
 * The pull request is asked for by the branch's *name*, against the repository
 * pull requests are numbered in, and then narrowed to the ones whose head is the
 * branch's own owner. That is not the obvious spelling — `ref(qualifiedName:)`
 * has an `associatedPullRequests` that reads better — but the obvious spelling
 * cannot answer for a fork: the ref would have to be looked up in `upstream`,
 * where the branch does not exist, because a pull request out of a fork is
 * attached to a ref in the fork. `headRefName` matches across repositories, and
 * `headRepositoryOwner` is what makes the match exact rather than a match on
 * everybody who happened to call their branch `patch-1`.
 *
 * The name searched for is the branch's name *on the remote*. `headRefName` is
 * a fact about the pull request's head ref, which lives on GitHub, so a branch
 * whose local and remote names differ is found only by the second of the two.
 *
 * One query for both cases rather than one each. Somebody working in a fork and
 * somebody working directly in a repository are asking the same question, and a
 * second query shape would be a second thing to keep true.
 *
 * Either way it beats what this replaced: reading the bodies of a repository's
 * open pull requests for a closing keyword, which could only see pull requests
 * still open, only in repositories small enough to page through, and only where
 * somebody had written `Closes #128` at all.
 *
 * Its review threads are on the same query, for the same reason: whether
 * anybody is still waiting on an answer in the pull request is part of what the
 * row says about it, and a second request per branch per minute would be a
 * second cadence to keep in step with this one. Only `isResolved` is read, and
 * `totalCount` beside it is what says whether the page held all of them.
 *
 * Its CI is on the same query too, and for the same reason: the head commit's
 * `statusCheckRollup`, which is GitHub's own verdict over every check run and
 * commit status on it, and the counts by state beside it so the row can say how
 * many of how many without a page of check runs being read. The counts come as
 * totals GitHub keeps, so they cost nothing that grows with the number of
 * checks. `commits(last:1)` is the head commit; a rollup of null is a commit
 * nothing has reported on.
 *
 * The Issue is on the same query and skipped when the branch does not name one,
 * so a branch is one request whether or not it is about an Issue. `$number` is
 * still declared and still sent when skipped, because GraphQL validates a
 * variable's type whether or not the field that uses it is included.
 */
const QUERY = `query($owner:String!,$name:String!,$branch:String!,$number:Int!,$wantIssue:Boolean!,$prs:Int!,$threads:Int!){
  repository(owner:$owner,name:$name){
    pullRequests(headRefName:$branch, first:$prs, orderBy:{field:UPDATED_AT,direction:DESC}){
      nodes{
        number url title state isDraft headRepositoryOwner{ login }
        reviewThreads(first:$threads){ totalCount nodes{ isResolved } }
        commits(last:1){ nodes{ commit{ statusCheckRollup{
          state
          contexts{ totalCount checkRunCountsByState{ state count } statusContextCountsByState{ state count } }
        } } } }
      }
    }
    issue(number:$number) @include(if:$wantIssue){ number title state url }
  }
}`;

/**
 * What came of running `gh`.
 *
 * Three outcomes, not two. "There is no answer" used to cover both a `gh` that
 * is not installed and a `gh` that is installed and logged out, and the one
 * sentence a caller could write for them told a person with no `gh` at all to
 * run `gh auth login` — advice that cannot work, given for a reason that was
 * never the reason. They are different problems with different fixes, so they
 * are different answers.
 *
 * `unrunnable` is every way DevHub failed to get an answer out of the binary —
 * missing from PATH, not executable, too slow — and it carries git's own kind
 * of detail: what was tried and what happened, in words the caller can put in
 * front of a person.
 */
type GhResult =
	| { readonly kind: "output"; readonly text: string }
	| { readonly kind: "unrunnable"; readonly reason: string }
	| { readonly kind: "refused" };

/**
 * Run `gh` and read what it said on stdout.
 *
 * The one place in DevHub that starts the GitHub CLI. Everything DevHub asks
 * `gh` — the token, who is signed in — is a short command whose whole answer is
 * one line of stdout, and each having its own spawn meant each having its own
 * timeout, its own idea of what a non-zero exit meant, and its own chance to
 * get the environment wrong.
 */
function runGh(
	args: readonly string[],
	environment: Readonly<Record<string, string | undefined>>,
): Promise<GhResult> {
	activityCounters.record(COUNTER.process("gh"));
	return new Promise<GhResult>((resolve) => {
		const child = spawn("gh", [...args], {
			env: environment as NodeJS.ProcessEnv,
			stdio: ["ignore", "pipe", "ignore"],
		});
		let stdout = "";
		let timedOut = false;
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, GH_TIMEOUT_MS);
		// The binary could not be run at all. `ENOENT` is the common one and the
		// only one worth its own sentence: there is no `gh` on the PATH DevHub
		// was given, which is a different thing from a `gh` that refused.
		child.once("error", (error: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			resolve({
				kind: "unrunnable",
				reason:
					error.code === "ENOENT"
						? "there is no `gh` on DevHub's PATH"
						: error.message,
			});
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (timedOut) {
				resolve({
					kind: "unrunnable",
					reason: `\`gh ${args.join(" ")}\` did not answer within ${String(GH_TIMEOUT_MS / 1000)} seconds`,
				});
				return;
			}
			const text = stdout.trim();
			// `gh` ran and declined. It exits non-zero when it cannot answer, and
			// an empty answer with a zero exit means the same thing.
			resolve(
				code === 0 && text.length > 0
					? { kind: "output", text }
					: { kind: "refused" },
			);
		});
	});
}

/** The token, or why DevHub does not have one. */
export type GitHubTokenResult =
	| { readonly kind: "token"; readonly token: string }
	| { readonly kind: "unrunnable"; readonly reason: string }
	| { readonly kind: "unauthenticated" };

/**
 * The token `gh` is holding, or why DevHub does not have one.
 *
 * Read on every poll rather than kept: a token that was revoked, refreshed or
 * logged out of should stop working when it stops being valid, and a copy in
 * this process is a copy that outlives the person's decision to end it.
 */
export async function readGitHubToken(
	environment: Readonly<Record<string, string | undefined>>,
): Promise<GitHubTokenResult> {
	const result = await runGh(["auth", "token"], environment);
	switch (result.kind) {
		case "output":
			return { kind: "token", token: result.text };
		case "unrunnable":
			return { kind: "unrunnable", reason: result.reason };
		case "refused":
			return { kind: "unauthenticated" };
	}
}

/**
 * Which GitHub account this machine is signed in as, or why that is not known.
 *
 * Asked so that a repository typed as a bare name means the same thing here as
 * it does to `gh repo clone`. There is no third answer and no default: a page
 * that guessed an owner would clone somebody else's repository under a name the
 * person did recognise, which is the worst way to be wrong.
 */
export type GitHubLoginResult =
	| { readonly kind: "login"; readonly login: string }
	| { readonly kind: "unknown"; readonly reason: string };

export async function readGitHubLogin(
	environment: Readonly<Record<string, string | undefined>>,
): Promise<GitHubLoginResult> {
	// `--jq` rather than parsing `gh auth status`, whose sentence is written for
	// a person and has been reworded between releases. This asks for the one
	// field and gets the one field.
	const result = await runGh(["api", "user", "--jq", ".login"], environment);
	switch (result.kind) {
		case "output":
			return { kind: "login", login: result.text };
		case "unrunnable":
			return { kind: "unknown", reason: result.reason };
		case "refused":
			return {
				kind: "unknown",
				reason: "`gh` is not signed in to GitHub — run `gh auth login`",
			};
	}
}

interface GraphQlIssue {
	readonly number: number;
	readonly title: string;
	readonly state: string;
	readonly url: string;
}

interface GraphQlPullRequest {
	readonly number: number;
	readonly url: string;
	readonly title: string;
	/** GitHub's own enum: `OPEN`, `CLOSED` or `MERGED`. */
	readonly state: string;
	readonly isDraft: boolean;
	/** Whose copy of the repository the branch is in. Null once a fork is gone. */
	readonly headRepositoryOwner: { readonly login: string } | null;
	/** Absent only when GitHub did not answer the field it was asked for. */
	readonly reviewThreads?: {
		readonly totalCount: number;
		readonly nodes: readonly ({ readonly isResolved: boolean } | null)[];
	} | null;
	/** The head commit, alone. Absent only when GitHub did not answer it. */
	readonly commits?: {
		readonly nodes: readonly ({
			readonly commit: {
				readonly statusCheckRollup: GraphQlCheckRollup | null;
			} | null;
		} | null)[];
	} | null;
}

interface GraphQlStateCount {
	readonly state: string;
	readonly count: number;
}

interface GraphQlCheckRollup {
	/** GitHub's `StatusState`: `SUCCESS`, `FAILURE`, `ERROR`, `PENDING` or `EXPECTED`. */
	readonly state: string;
	readonly contexts: {
		readonly totalCount: number;
		readonly checkRunCountsByState: readonly GraphQlStateCount[] | null;
		readonly statusContextCountsByState: readonly GraphQlStateCount[] | null;
	};
}

/**
 * A pull request's head, as somewhere a branch can be fetched from.
 *
 * The branch and the repository it is in, always both. For most pull requests
 * the repository is the one the pull request is in and saying so twice is
 * harmless; for one out of a fork it is the whole of the difference between a
 * branch this clone can reach and one it cannot, and a caller handed only the
 * name would have to go and ask a second question to find out which case it
 * has.
 */
export interface PullRequestHead {
	readonly branch: string;
	readonly owner: string;
	readonly repository: string;
}

/**
 * What GitHub answers, as the union of every field this file asks for.
 *
 * One shape rather than one per query, because each reader takes only the
 * fields its own query named and a second shape would be a second place to keep
 * the endpoint's spelling right.
 */
interface GraphQlAnswer {
	readonly data?: {
		readonly repository?: {
			readonly issue?:
				| (GraphQlIssue & {
						readonly linkedBranches?: {
							readonly nodes?:
								| readonly ({
										readonly ref?: { readonly name?: string | null } | null;
								  } | null)[]
								| null;
						} | null;
				  })
				| null;
			readonly pullRequest?: {
				readonly headRefName?: string | null;
				readonly headRepository?: {
					readonly name: string;
					readonly owner: { readonly login: string };
				} | null;
			} | null;
			readonly pullRequests?: {
				readonly nodes?: readonly (GraphQlPullRequest | null)[] | null;
			} | null;
		} | null;
	} | null;
	readonly errors?: readonly { readonly message?: string }[] | null;
}

/**
 * Which of a branch's pull requests the row is about.
 *
 * A branch usually has nought or one, and then there is nothing to decide. It
 * has more when one was closed and another opened from the same head — a
 * rebase somebody gave up on, a pull request retargeted by closing and
 * reopening — and the rule is: **a live pull request outranks a finished one,
 * and among equals the most recently updated wins.**
 *
 * Live first because that is the one a person can still act on: a branch with
 * an abandoned pull request from March and an open one from this morning is a
 * branch with an open pull request, and saying "closed" because the closed one
 * was touched last would report the row as finished work that is still in
 * review. `orderBy: UPDATED_AT DESC` is what makes "among equals" decidable
 * without a second sort here, so the first match in either pass is the answer.
 */
function chosenPullRequest(
	nodes: readonly (GraphQlPullRequest | null)[],
	headOwner: string,
): GraphQlPullRequest | undefined {
	// The query matched on the branch's *name*, which is not an identity: an
	// open-source repository has a dozen pull requests from a dozen forks whose
	// branch is called `patch-1`, and only the one out of this workspace's own
	// remote is this row's. A fork that has since been deleted has no owner to
	// compare, and is nobody's.
	const present = nodes.filter(
		(node): node is GraphQlPullRequest =>
			!!node &&
			node.headRepositoryOwner?.login.toLowerCase() === headOwner.toLowerCase(),
	);
	return (
		present.find((node) => node.state.toUpperCase() === "OPEN") ?? present[0]
	);
}

/**
 * What a pull request's two GitHub fields mean together.
 *
 * `isDraft` is only a distinction while it is open — GitHub keeps the flag set
 * on a draft that was closed without ever being marked ready, and a row that
 * called that one "draft" would report work nobody is going to finish as work
 * in progress.
 */
function pullRequestState(
	node: GraphQlPullRequest,
): PullRequestStatus["state"] {
	switch (node.state.toUpperCase()) {
		case "MERGED":
			return "merged";
		case "CLOSED":
			return "closed";
		default:
			return node.isDraft ? "draft" : "open";
	}
}

/**
 * How many of a pull request's review threads are still open, from the page of
 * them the query read.
 *
 * A pull request GitHub answered without the threads it was asked for is a
 * failure and not a zero: nought is a claim that nobody is waiting, and the
 * answer did not say that.
 */
function conversationCount(
	node: GraphQlPullRequest,
	reference: BranchReference,
): ConversationCount {
	const threads = node.reviewThreads;
	if (!threads) {
		throw new GitHubUnavailable(
			`GitHub did not list the review conversations of ${reference.owner}/${reference.repository}#${String(node.number)}.`,
		);
	}
	// A null in the page is a thread GitHub would not show this token, which
	// is a thread not counted rather than one counted as resolved.
	const read = threads.nodes.filter(
		(thread): thread is { readonly isResolved: boolean } => thread !== null,
	);
	return {
		unresolved: read.filter((thread) => !thread.isResolved).length,
		uncounted: Math.max(0, threads.totalCount - read.length),
	};
}

/** The rollup's own verdict, as one of the three `CheckSummary` says. */
const CHECK_VERDICT: Readonly<Record<string, CheckSummary["state"]>> = {
	SUCCESS: "passing",
	FAILURE: "failing",
	ERROR: "failing",
	PENDING: "pending",
	EXPECTED: "pending",
};

/**
 * Which verdict each state a check run or a commit status can be in counts
 * toward. The two enums share some names (`FAILURE`, `PENDING`) and mean the
 * same by them, so one table reads both. A state not listed — passed, skipped,
 * neutral, stale — asks nothing of anybody and is counted only in the total.
 */
const CHECK_COUNTED_AS: Readonly<
	Record<string, "failing" | "pending" | undefined>
> = {
	FAILURE: "failing",
	ERROR: "failing",
	CANCELLED: "failing",
	TIMED_OUT: "failing",
	STARTUP_FAILURE: "failing",
	ACTION_REQUIRED: "failing",
	PENDING: "pending",
	EXPECTED: "pending",
	QUEUED: "pending",
	IN_PROGRESS: "pending",
	WAITING: "pending",
};

/**
 * What the pull request's CI says, from the rollup on its head commit.
 *
 * A pull request answered without its commits is a failure, as one without its
 * threads is: "no checks" is a claim, and the answer did not make it. A rollup
 * GitHub answered with a verdict this does not know is a failure too — a
 * verdict drawn as some other verdict would be a badge that lies.
 */
function checkSummary(
	node: GraphQlPullRequest,
	reference: BranchReference,
): CheckSummary | undefined {
	const where = `${reference.owner}/${reference.repository}#${String(node.number)}`;
	if (!node.commits) {
		throw new GitHubUnavailable(
			`GitHub did not list the head commit of ${where}.`,
		);
	}
	const rollup = node.commits.nodes[0]?.commit?.statusCheckRollup;
	if (!rollup) return undefined;
	const state = CHECK_VERDICT[rollup.state.toUpperCase()];
	if (!state) {
		throw new GitHubUnavailable(
			`GitHub said the CI of ${where} is ${rollup.state}, which DevHub does not know.`,
		);
	}
	const counts = [
		...(rollup.contexts.checkRunCountsByState ?? []),
		...(rollup.contexts.statusContextCountsByState ?? []),
	];
	const counted = (verdict: "failing" | "pending") =>
		counts
			.filter(
				(count) => CHECK_COUNTED_AS[count.state.toUpperCase()] === verdict,
			)
			.reduce((sum, count) => sum + count.count, 0);
	return {
		state,
		total: rollup.contexts.totalCount,
		failing: counted("failing"),
		pending: counted("pending"),
	};
}

/**
 * Read what a branch is about: the pull request out from it, and the Issue it
 * names, if it names one.
 */
export async function readBranchStatus(
	reference: BranchReference,
	token: string,
): Promise<BranchStatus> {
	const wantIssue = reference.issueNumber !== undefined;
	const answer = await post(
		{
			query: QUERY,
			variables: {
				owner: reference.owner,
				name: reference.repository,
				branch: reference.remoteBranch,
				// Sent whether or not it is used: the field is skipped, the variable
				// is still type-checked. Zero is never a real Issue number.
				number: reference.issueNumber ?? 0,
				wantIssue,
				prs: MAX_PULL_REQUESTS,
				threads: MAX_REVIEW_THREADS,
			},
		},
		token,
	);
	const complaint = answer.errors?.[0]?.message;
	if (complaint) throw new GitHubUnavailable(complaint);
	const repository = answer.data?.repository;
	if (!repository) {
		throw new GitHubUnavailable(
			`GitHub has no repository ${reference.owner}/${reference.repository}.`,
		);
	}
	// No match is a fact and not a failure: it is what every branch looks like
	// before anybody opens a pull request from it.
	const chosen = chosenPullRequest(
		repository.pullRequests?.nodes ?? [],
		reference.headOwner,
	);
	const issue = repository.issue;
	if (wantIssue && !issue) {
		throw new GitHubUnavailable(
			`GitHub has no issue ${reference.owner}/${reference.repository}#${String(reference.issueNumber)}.`,
		);
	}
	return {
		issue: issue
			? {
					number: issue.number,
					title: issue.title,
					state: issue.state.toUpperCase() === "CLOSED" ? "closed" : "open",
					url: issue.url,
				}
			: undefined,
		pullRequest: chosen
			? {
					number: chosen.number,
					url: chosen.url,
					title: chosen.title,
					state: pullRequestState(chosen),
					conversations: conversationCount(chosen, reference),
					checks: checkSummary(chosen, reference),
				}
			: undefined,
	};
}

/**
 * The branch a pull request is asking to merge.
 *
 * Asked once, when somebody assigns a pull request and wants a worktree for it
 * — not polled. The watcher's questions are about what changed since last time;
 * this one has a single answer that was fixed when the pull request was opened,
 * so it is its own small query rather than a field bolted onto a query that
 * runs every minute for every workspace.
 *
 * `headRefName` is the branch's name on whichever repository it lives in. For a
 * pull request from a fork that name is not on `origin` at all, and the failure
 * to check it out is git's to report: DevHub asking for a branch that is not
 * there says so, where inventing an empty branch of the same name would not.
 */
export async function readPullRequestHead(
	pullRequest: IssueReference,
	token: string,
): Promise<PullRequestHead> {
	const answer = await post(
		{
			query: `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){ pullRequest(number:$number){
    headRefName
    headRepository{ name owner{ login } }
  } }
}`,
			variables: {
				owner: pullRequest.owner,
				name: pullRequest.repository,
				number: pullRequest.number,
			},
		},
		token,
	);
	const failed = answer.errors?.[0]?.message;
	if (failed !== undefined) throw new GitHubUnavailable(failed);
	const head = answer.data?.repository?.pullRequest ?? undefined;
	const branch = head?.headRefName ?? undefined;
	if (branch === undefined || branch.length === 0) {
		throw new GitHubUnavailable(
			`GitHub did not say which branch ${pullRequest.owner}/${pullRequest.repository}#${String(pullRequest.number)} is from.`,
		);
	}
	// A head repository GitHub cannot name is a fork that has been deleted since
	// the pull request was opened. The pull request's own repository is the only
	// remaining candidate, and it is the one that is right for every pull request
	// that was not from a fork — which is nearly all of them.
	return {
		branch,
		owner: head?.headRepository?.owner.login ?? pullRequest.owner,
		repository: head?.headRepository?.name ?? pullRequest.repository,
	};
}

/**
 * The branch GitHub says an Issue is being worked on.
 *
 * GitHub's own "linked branches" — what its Create a branch button records, and
 * what the Issue page shows in the development panel. It is a *record* somebody
 * made, which is why it is asked before any guessing at names: a branch linked
 * to the Issue is the branch for the Issue, whatever it is called.
 *
 * More than one is possible and the first is taken. GitHub lists them in the
 * order they were linked, and an Issue with two linked branches is one somebody
 * restarted; the newer one is not distinguishable here and the choice is
 * offered to the person anyway, as a row they can decline.
 *
 * Nothing is a perfectly ordinary answer: most Issues have no branch, which is
 * what the wizard's `feature/128-wip` exists for.
 */
export async function readIssueLinkedBranch(
	issue: IssueReference,
	token: string,
): Promise<string | undefined> {
	const answer = await post(
		{
			query: `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){ issue(number:$number){
    linkedBranches(first:10){ nodes{ ref{ name } } }
  } }
}`,
			variables: {
				owner: issue.owner,
				name: issue.repository,
				number: issue.number,
			},
		},
		token,
	);
	const failed = answer.errors?.[0]?.message;
	if (failed !== undefined) throw new GitHubUnavailable(failed);
	const nodes = answer.data?.repository?.issue?.linkedBranches?.nodes ?? [];
	for (const node of nodes) {
		const name = node?.ref?.name ?? undefined;
		if (name !== undefined && name.length > 0) return name;
	}
	return undefined;
}

async function post(body: unknown, token: string): Promise<GraphQlAnswer> {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort();
	}, REQUEST_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(ENDPOINT, {
			method: "POST",
			headers: {
				authorization: `bearer ${token}`,
				"content-type": "application/json",
				// GitHub asks for one, and a request without it is answered less
				// helpfully when something goes wrong.
				"user-agent": "DevHub",
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
	} catch (error: unknown) {
		// The reason is the network's, and it is said as it came: "fetch failed",
		// a DNS name, a timeout. What must not appear is the request, which
		// carries the token.
		throw new GitHubUnavailable(
			error instanceof Error ? error.message : "GitHub could not be reached.",
		);
	} finally {
		clearTimeout(timer);
	}
	if (response.status === 401 || response.status === 403) {
		throw new GitHubUnavailable(
			"GitHub refused DevHub's credentials. Run `gh auth login` and try again.",
		);
	}
	if (!response.ok) {
		throw new GitHubUnavailable(`GitHub answered ${String(response.status)}.`);
	}
	return (await response.json()) as GraphQlAnswer;
}

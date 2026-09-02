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
import type { IssueReference } from "../../model/github.js";

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
}

/** A failure with words: shown as itself, and never carrying the token. */
export class GitHubUnavailable extends Error {
	constructor(summary: string) {
		super(summary);
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
 * One query for both cases rather than one each. Somebody working in a fork and
 * somebody working directly in a repository are asking the same question, and a
 * second query shape would be a second thing to keep true.
 *
 * Either way it beats what this replaced: reading the bodies of a repository's
 * open pull requests for a closing keyword, which could only see pull requests
 * still open, only in repositories small enough to page through, and only where
 * somebody had written `Closes #128` at all.
 *
 * The Issue is on the same query and skipped when the branch does not name one,
 * so a branch is one request whether or not it is about an Issue. `$number` is
 * still declared and still sent when skipped, because GraphQL validates a
 * variable's type whether or not the field that uses it is included.
 */
const QUERY = `query($owner:String!,$name:String!,$branch:String!,$number:Int!,$wantIssue:Boolean!,$prs:Int!){
  repository(owner:$owner,name:$name){
    pullRequests(headRefName:$branch, first:$prs, orderBy:{field:UPDATED_AT,direction:DESC}){
      nodes{ number url title state isDraft headRepositoryOwner{ login } }
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
}

interface GraphQlAnswer {
	readonly data?: {
		readonly repository?: {
			readonly issue?: GraphQlIssue | null;
			readonly pullRequest?: { readonly headRefName?: string | null } | null;
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
				branch: reference.branch,
				// Sent whether or not it is used: the field is skipped, the variable
				// is still type-checked. Zero is never a real Issue number.
				number: reference.issueNumber ?? 0,
				wantIssue,
				prs: MAX_PULL_REQUESTS,
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
): Promise<string> {
	const answer = await post(
		{
			query: `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){ pullRequest(number:$number){ headRefName } }
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
	const branch = answer.data?.repository?.pullRequest?.headRefName ?? undefined;
	if (branch === undefined || branch.length === 0) {
		throw new GitHubUnavailable(
			`GitHub did not say which branch ${pullRequest.owner}/${pullRequest.repository}#${String(pullRequest.number)} is from.`,
		);
	}
	return branch;
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

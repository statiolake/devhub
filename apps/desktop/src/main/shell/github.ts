/**
 * What GitHub is asked, and how DevHub is allowed to ask it.
 *
 * One GraphQL query per Issue DevHub is watching, built here rather than
 * shelled out to `gh`: the CLI's own queries fetch far more than a title and a
 * handful of pull request bodies, and this runs every minute.
 *
 * The token is read from `gh auth token` and used. It is never written to a
 * config file, never logged, and never put in an error message — a failure says
 * that authentication was refused, not what was refused with.
 */

import { spawn } from "node:child_process";
import { bodyClosesIssue, type IssueReference } from "../../model/github.js";

/** What DevHub shows about an Issue and whatever pull request is closing it. */
export interface IssueStatus {
	readonly issue: IssueReference;
	readonly title: string;
	readonly state: "open" | "closed";
	readonly url: string;
	readonly pullRequest?: PullRequestStatus;
}

export interface PullRequestStatus {
	readonly number: number;
	readonly url: string;
	readonly state: "open" | "draft";
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
 * How many open pull requests are read per Issue.
 *
 * Only their bodies are wanted, and only to find the one that says it closes
 * this Issue. A repository with more open pull requests than this has a
 * different problem than DevHub can solve, and the query has to stay small
 * enough to run every minute.
 */
const MAX_PULL_REQUESTS = 50;

const QUERY = `query($owner:String!,$name:String!,$number:Int!,$prs:Int!){
  repository(owner:$owner,name:$name){
    issue(number:$number){ number title state url }
    pullRequests(states:OPEN, first:$prs, orderBy:{field:UPDATED_AT,direction:DESC}){
      nodes{ number url isDraft body }
    }
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
	readonly isDraft: boolean;
	readonly body: string | null;
}

interface GraphQlAnswer {
	readonly data?: {
		readonly repository?: {
			readonly issue?: GraphQlIssue | null;
			readonly pullRequests?: {
				readonly nodes?: readonly (GraphQlPullRequest | null)[] | null;
			} | null;
		} | null;
	} | null;
	readonly errors?: readonly { readonly message?: string }[] | null;
}

/**
 * Read one Issue, and whichever open pull request says it closes it.
 *
 * "Says it closes it" is read from the body, not from GitHub's own
 * `closingIssuesReferences`: that field answers what would close on a merge
 * into the *default* branch, so work that lands on a release branch — or in a
 * repository whose default branch is not where work lands — would read as
 * having no pull request at all.
 */
export async function readIssueStatus(
	issue: IssueReference,
	token: string,
): Promise<IssueStatus> {
	const answer = await post(
		{
			query: QUERY,
			variables: {
				owner: issue.owner,
				name: issue.repository,
				number: issue.number,
				prs: MAX_PULL_REQUESTS,
			},
		},
		token,
	);
	const complaint = answer.errors?.[0]?.message;
	if (complaint) throw new GitHubUnavailable(complaint);
	const found = answer.data?.repository?.issue;
	if (!found) {
		throw new GitHubUnavailable(
			`GitHub has no issue ${issue.owner}/${issue.repository}#${String(issue.number)}.`,
		);
	}
	const closing = (answer.data?.repository?.pullRequests?.nodes ?? []).find(
		(node) => node && bodyClosesIssue(node.body ?? "", issue.number),
	);
	return {
		issue,
		title: found.title,
		state: found.state.toUpperCase() === "CLOSED" ? "closed" : "open",
		url: found.url,
		pullRequest: closing
			? {
					number: closing.number,
					url: closing.url,
					state: closing.isDraft ? "draft" : "open",
				}
			: undefined,
	};
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

/**
 * What DevHub asks GitHub, and what the answers can come to.
 *
 * Two subjects, because there are two ways this file talks to GitHub and they
 * fail differently. Asking `gh` for a token is a process that may not exist;
 * asking the API what a branch is about is a round trip that may be refused.
 *
 * The `gh` tests run a real `gh` off a real PATH rather than a mock, because
 * the whole distinction lives in how the process fails: a spawn that never
 * starts and a process that starts and exits non-zero are different events, and
 * a stub that resolves a value tests neither.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	readBranchStatus,
	readGitHubLogin,
	readGitHubToken,
} from "./github.js";

let directory: string;

/** A `gh` on PATH that behaves however this test needs it to. */
async function fakeGh(script: string): Promise<void> {
	const path = join(directory, "gh");
	await writeFile(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
}

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "devhub-gh-"));
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
	vi.unstubAllGlobals();
});

/**
 * "There is no token" used to cover both a `gh` that is not installed and a
 * `gh` that is installed and logged out. One answer meant one sentence, and the
 * sentence told a person with no GitHub CLI at all to run `gh auth login` —
 * advice that cannot work, for a reason that was never the reason.
 */
describe("reading the GitHub token", () => {
	it("is the token when `gh` is holding one", async () => {
		await fakeGh('echo "gho_example"');
		const result = await readGitHubToken({ PATH: directory });
		expect(result).toEqual({ kind: "token", token: "gho_example" });
	});

	it("is `unauthenticated` when `gh` runs and declines", async () => {
		// The logged-out case: `gh` is installed and exits non-zero. The fix is
		// `gh auth login`, and this is the only outcome for which that is true.
		await fakeGh("exit 1");
		const result = await readGitHubToken({ PATH: directory });
		expect(result).toEqual({ kind: "unauthenticated" });
	});

	it("is `unauthenticated` when `gh` succeeds but says nothing", async () => {
		await fakeGh("exit 0");
		const result = await readGitHubToken({ PATH: directory });
		expect(result).toEqual({ kind: "unauthenticated" });
	});

	it("is `unrunnable`, naming PATH, when there is no `gh` to run", async () => {
		// Not a logged-out `gh`: no `gh`. Telling this person to log in is the bug
		// this outcome exists to prevent.
		const result = await readGitHubToken({ PATH: directory });
		expect(result).toEqual({
			kind: "unrunnable",
			reason: "there is no `gh` on DevHub's PATH",
		});
	});
});

/**
 * Who `gh` says this machine is.
 *
 * Two answers here rather than three: a page that wanted an owner and did not
 * get one has the same thing to do — say so, and ask for `owner/name` — whether
 * `gh` is missing or logged out. The *reason* still differs, because the reason
 * is what a person acts on, so it is carried rather than collapsed.
 */
describe("reading who GitHub says this machine is", () => {
	it("is the login when `gh` answers with one", async () => {
		await fakeGh('echo "octocat"');
		const result = await readGitHubLogin({ PATH: directory });
		expect(result).toEqual({ kind: "login", login: "octocat" });
	});

	it("says to log in when `gh` runs and declines", async () => {
		await fakeGh("exit 1");
		const result = await readGitHubLogin({ PATH: directory });
		expect(result).toEqual({
			kind: "unknown",
			reason: "`gh` is not signed in to GitHub — run `gh auth login`",
		});
	});

	it("names PATH, not the login, when there is no `gh` to run", async () => {
		const result = await readGitHubLogin({ PATH: directory });
		expect(result).toEqual({
			kind: "unknown",
			reason: "there is no `gh` on DevHub's PATH",
		});
	});
});

const REFERENCE = {
	owner: "example",
	repository: "widget",
	headOwner: "example",
	branch: "feature/128-tidy",
	issueNumber: 128,
};

/** The same workspace, done in a fork: the branch is mine, the Issue is theirs. */
const FORKED = {
	owner: "example",
	repository: "widget",
	headOwner: "contributor",
	branch: "feature/128-tidy",
	issueNumber: 128,
};

/** GitHub's answer, as the one round trip returns it. */
function answers(body: unknown) {
	const fetchMock = vi.fn().mockResolvedValue({
		ok: true,
		status: 200,
		json: () => Promise.resolve(body),
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

/** The pull requests a branch has, newest first, as the query orders them. */
function withPullRequests(
	nodes: readonly unknown[],
	issue: unknown = { number: 128, title: "Tidy", state: "OPEN", url: "i" },
) {
	return answers({
		data: { repository: { issue, pullRequests: { nodes } } },
	});
}

function pullRequest(over: Record<string, unknown>) {
	return {
		number: 1,
		url: "p",
		title: "Tidy the picker",
		state: "OPEN",
		isDraft: false,
		headRepositoryOwner: { login: "example" },
		...over,
	};
}

/**
 * The query asks the branch what is out from it —
 * `ref(...).associatedPullRequests` — rather than asking a repository for its
 * open pull requests and reading their bodies for a closing keyword. That is
 * what makes a merged pull request, a closed one, and a pull request on a
 * branch that names no Issue all visible; these are the small decisions that
 * answer leaves open.
 */
describe("the pull request a branch is about", () => {
	it("is the one out from the branch, whatever its body says", async () => {
		// The whole point of the change: nothing is parsed. A pull request that
		// never wrote `Closes #128` is still this branch's pull request.
		withPullRequests([pullRequest({ number: 7 })]);
		const status = await readBranchStatus(REFERENCE, "token");
		expect(status.pullRequest).toEqual({
			number: 7,
			url: "p",
			title: "Tidy the picker",
			state: "open",
		});
	});

	it("asks the repository the numbers live in, by branch name", async () => {
		const fetchMock = withPullRequests([]);
		await readBranchStatus(REFERENCE, "token");
		const sent = JSON.parse(
			(fetchMock.mock.calls[0]?.[1] as { body: string }).body,
		) as { variables: Record<string, unknown> };
		expect(sent.variables.owner).toBe("example");
		expect(sent.variables.branch).toBe("feature/128-tidy");
		expect(sent.variables.wantIssue).toBe(true);
	});

	it("is nothing at all when nobody has opened one", async () => {
		// A fact rather than a failure: it is what every branch looks like before
		// somebody opens a pull request from it.
		withPullRequests([]);
		const status = await readBranchStatus(REFERENCE, "token");
		expect(status.pullRequest).toBeUndefined();
		expect(status.issue?.number).toBe(128);
	});

	it("ignores a pull request from somebody else's branch of the same name", async () => {
		// The query matches on the branch's *name*, which is not an identity: an
		// open-source repository has a dozen `patch-1` pull requests from a dozen
		// forks. Only the one out of this workspace's own remote is this row's.
		withPullRequests([
			pullRequest({
				number: 99,
				headRepositoryOwner: { login: "somebody-else" },
			}),
		]);
		expect(
			(await readBranchStatus(REFERENCE, "token")).pullRequest,
		).toBeUndefined();
	});

	it("ignores a pull request whose fork has been deleted", async () => {
		withPullRequests([pullRequest({ headRepositoryOwner: null })]);
		expect(
			(await readBranchStatus(REFERENCE, "token")).pullRequest,
		).toBeUndefined();
	});

	it("reports a merged pull request as merged", async () => {
		withPullRequests([pullRequest({ state: "MERGED" })]);
		expect(
			(await readBranchStatus(REFERENCE, "token")).pullRequest?.state,
		).toBe("merged");
	});

	it("reports a closed pull request as closed", async () => {
		withPullRequests([pullRequest({ state: "CLOSED" })]);
		expect(
			(await readBranchStatus(REFERENCE, "token")).pullRequest?.state,
		).toBe("closed");
	});

	it("reports an open draft as a draft", async () => {
		withPullRequests([pullRequest({ state: "OPEN", isDraft: true })]);
		expect(
			(await readBranchStatus(REFERENCE, "token")).pullRequest?.state,
		).toBe("draft");
	});

	it("does not call a closed draft a draft", async () => {
		// GitHub keeps `isDraft` set on a draft that was closed without ever being
		// marked ready. Reading the flag first would report work nobody is going
		// to finish as work in progress.
		withPullRequests([pullRequest({ state: "CLOSED", isDraft: true })]);
		expect(
			(await readBranchStatus(REFERENCE, "token")).pullRequest?.state,
		).toBe("closed");
	});

	it("prefers a live pull request to a more recently touched dead one", async () => {
		// A branch has more than one when somebody closed a pull request and
		// opened another from the same head. The nodes arrive most-recently-updated
		// first, so taking the first would report the row as finished work while a
		// pull request from it is still in review.
		withPullRequests([
			pullRequest({ number: 4, state: "CLOSED" }),
			pullRequest({ number: 5, state: "OPEN" }),
		]);
		const status = await readBranchStatus(REFERENCE, "token");
		expect(status.pullRequest?.number).toBe(5);
		expect(status.pullRequest?.state).toBe("open");
	});

	it("takes the most recently updated when none of them are live", async () => {
		// Nothing to prefer, so the ordering the query asked for decides.
		withPullRequests([
			pullRequest({ number: 4, state: "MERGED" }),
			pullRequest({ number: 3, state: "CLOSED" }),
		]);
		expect(
			(await readBranchStatus(REFERENCE, "token")).pullRequest?.number,
		).toBe(4);
	});
});

/**
 * Working in a fork: the branch is in one repository and everything it is about
 * is in another.
 */
describe("a branch in a fork", () => {
	it("asks upstream, and takes the pull request out of the fork", async () => {
		// The pull request is attached to a ref in the fork and numbered in
		// upstream. Looking the ref up in upstream — which is what the obvious
		// query shape does — asks for a branch that is not there.
		const fetchMock = withPullRequests([
			pullRequest({
				number: 12,
				headRepositoryOwner: { login: "contributor" },
			}),
		]);
		const status = await readBranchStatus(FORKED, "token");
		const sent = JSON.parse(
			(fetchMock.mock.calls[0]?.[1] as { body: string }).body,
		) as { variables: Record<string, unknown> };
		// Asked of upstream, not of the fork.
		expect(sent.variables.owner).toBe("example");
		expect(status.pullRequest?.number).toBe(12);
		// And the Issue is upstream's, which is the whole reason to ask there.
		expect(status.issue?.number).toBe(128);
	});

	it("does not take a pull request from a different fork of the same branch", async () => {
		withPullRequests([
			pullRequest({ number: 5, headRepositoryOwner: { login: "example" } }),
		]);
		expect(
			(await readBranchStatus(FORKED, "token")).pullRequest,
		).toBeUndefined();
	});
});

describe("the Issue a branch names", () => {
	it("is not asked for when the branch names none", async () => {
		// One request per branch either way: the field is skipped rather than the
		// query being a second round trip.
		const fetchMock = withPullRequests([], null);
		await readBranchStatus(
			{
				owner: "example",
				repository: "widget",
				headOwner: "example",
				branch: "spike/rework",
			},
			"token",
		);
		const sent = JSON.parse(
			(fetchMock.mock.calls[0]?.[1] as { body: string }).body,
		) as { variables: Record<string, unknown> };
		expect(sent.variables.wantIssue).toBe(false);
	});

	it("is a failure when the branch names one GitHub does not have", async () => {
		// The branch is making a claim the row cannot back up, and a person who
		// mistyped a number needs to be told rather than shown a blank.
		withPullRequests([], null);
		await expect(readBranchStatus(REFERENCE, "token")).rejects.toThrow(
			/no issue example\/widget#128/u,
		);
	});
});

describe("a refusal", () => {
	it("is reported as GitHub's own words", async () => {
		answers({ errors: [{ message: "API rate limit exceeded." }] });
		await expect(readBranchStatus(REFERENCE, "token")).rejects.toThrow(
			"API rate limit exceeded.",
		);
	});

	it("never carries the token", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => ({}) }),
		);
		await expect(readBranchStatus(REFERENCE, "secret-token")).rejects.toThrow(
			/^GitHub answered 500\.$/u,
		);
	});
});

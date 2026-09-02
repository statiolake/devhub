/**
 * What a workspace is working on, and what makes it change.
 *
 * The whole of the link is the branch that is checked out. DevHub used to
 * prefer a record written when the person assigned an Issue and fall back to
 * the branch name — but a record cannot follow a checkout, so a workspace
 * assigned Issue 128 and then switched to `master` went on claiming 128. These
 * pin the replacement: the branch decides, every round.
 *
 * And the branch is now the whole of the *remote* question too. GitHub is asked
 * what is out from this branch, rather than being asked about an Issue and then
 * searched for a pull request whose body mentions it — so a workspace on a
 * branch that names no Issue can still have a pull request, and a pull request
 * that has been merged or closed is still something the row can say.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryStatusWire } from "../../ipc/contract.js";

const readRepository = vi.fn();
const readBranch = vi.fn();
const readDirty = vi.fn();
const readBranchStatus = vi.fn();
const readGitHubToken = vi.fn();

vi.mock("./git.js", () => ({
	readRepository: (...args: unknown[]) => readRepository(...args),
	readBranch: (...args: unknown[]) => readBranch(...args),
	readDirty: (...args: unknown[]) => readDirty(...args),
}));
vi.mock("./github.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	readGitHubToken: (...args: unknown[]) => readGitHubToken(...args),
	readBranchStatus: (...args: unknown[]) => readBranchStatus(...args),
}));

const { BRANCH_POLL_INTERVAL_MS, RepositoryStatusWatcher } = await import(
	"./repositoryStatus.js"
);

const WORKSPACE = { id: "w-1", root: "/projects/widget" };

/** What git says is checked out here. */
function checkedOut(branch: string | undefined) {
	readRepository.mockResolvedValue({
		mainWorktree: "/projects/widget",
		worktree: "/projects/widget",
		branch,
		remote: "github.com/example/widget",
	});
	// The fast clock asks the cheap question; it must agree with the slow one
	// until a test says otherwise.
	readBranch.mockResolvedValue(branch);
	readDirty.mockResolvedValue(false);
}

function watcher(published: RepositoryStatusWire[]) {
	return new RepositoryStatusWatcher({
		gitCommand: () => Promise.resolve({} as never),
		environment: {},
		workspaces: () => [WORKSPACE],
		publish: (status) => published.push(status),
	});
}

/** One round, run and waited for. */
async function round(): Promise<RepositoryStatusWire> {
	const published: RepositoryStatusWire[] = [];
	const running = watcher(published);
	running.start();
	await vi.waitFor(() => {
		expect(published.length).toBeGreaterThan(0);
	});
	running.stop();
	return published[published.length - 1] as RepositoryStatusWire;
}

beforeEach(() => {
	readGitHubToken.mockResolvedValue({ kind: "token", token: "token" });
	readBranchStatus.mockImplementation(
		(reference: {
			owner: string;
			repository: string;
			branch: string;
			issueNumber?: number;
		}) => ({
			issue:
				reference.issueNumber === undefined
					? undefined
					: {
							number: reference.issueNumber,
							title: `Issue ${String(reference.issueNumber)}`,
							state: "open",
							url: `https://github.com/${reference.owner}/${reference.repository}/issues/${String(reference.issueNumber)}`,
						},
		}),
	);
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("what a workspace is about", () => {
	it("is the Issue its checked-out branch names", async () => {
		checkedOut("feature/128-tidy-the-picker");
		const status = await round();
		expect(status.workspaces[0]?.branch).toBe("feature/128-tidy-the-picker");
		expect(status.workspaces[0]?.issue?.number).toBe(128);
	});

	it("follows a checkout, because nothing was written down", async () => {
		// The report this replaced: assigned 128, switched to master, still
		// claimed 128. The second round is a second checkout and nothing else.
		checkedOut("feature/128-tidy-the-picker");
		expect((await round()).workspaces[0]?.issue?.number).toBe(128);

		checkedOut("master");
		const after = await round();
		expect(after.workspaces[0]?.branch).toBe("master");
		expect(after.workspaces[0]?.issue).toBeUndefined();

		// And back again, to a different Issue.
		checkedOut("alice/fix/#9-crash");
		expect((await round()).workspaces[0]?.issue?.number).toBe(9);
	});

	it("reads a deep prefix with the number written as an Issue", async () => {
		// The name from the report. Every step of the chain handles it: git
		// reports it, the convention reads 1234 out of it, and the reference goes
		// to GitHub — so a workspace on this branch that shows no Issue is a
		// workspace whose *lookup* failed, not one that was never linked.
		checkedOut("step/feature/#1234-issue-body");
		const status = await round();
		expect(status.workspaces[0]?.issue?.number).toBe(1234);
		expect(readBranchStatus).toHaveBeenCalledWith(
			{
				owner: "example",
				repository: "widget",
				headOwner: "example",
				branch: "step/feature/#1234-issue-body",
				issueNumber: 1234,
			},
			"token",
		);
	});

	it("says on the row which Issue it is about when the look failed", async () => {
		// The reason used to be one line at the foot of the whole Sidebar, so a
		// row whose Issue could not be read looked exactly like a row about no
		// Issue at all. Both facts are now on the row that has them.
		const { GitHubUnavailable } = await import("./github.js");
		checkedOut("feature/128-tidy");
		readBranchStatus.mockRejectedValue(
			new GitHubUnavailable("GitHub has no issue example/widget#128."),
		);

		const status = await round();
		const row = status.workspaces[0];
		expect(row?.issue).toBeUndefined();
		expect(row?.unavailable).toEqual({
			number: 128,
			reason: "GitHub has no issue example/widget#128.",
		});
		// And the Sidebar's own note still carries it, as it always did.
		expect(status.diagnostic).toBe("GitHub has no issue example/widget#128.");
	});

	it("says so on every row when `gh` is there and holds no token", async () => {
		checkedOut("feature/128-tidy");
		readGitHubToken.mockResolvedValue({ kind: "unauthenticated" });

		const status = await round();
		expect(status.workspaces[0]?.unavailable?.reason).toMatch(/gh auth login/u);
		expect(readBranchStatus).not.toHaveBeenCalled();
	});

	it("tells somebody with no `gh` to install it, not to log in", async () => {
		// The two used to be one answer, and the one sentence it produced told a
		// person with no GitHub CLI to run `gh auth login` — advice that cannot
		// work, for a reason that was never the reason.
		checkedOut("feature/128-tidy");
		readGitHubToken.mockResolvedValue({
			kind: "unrunnable",
			reason: "there is no `gh` on DevHub's PATH",
		});

		const status = await round();
		const reason = status.workspaces[0]?.unavailable?.reason ?? "";
		expect(reason).toMatch(/no `gh` on DevHub's PATH/u);
		expect(reason).toMatch(/Install the GitHub CLI/u);
		expect(reason).not.toMatch(/gh auth login/u);
		expect(status.diagnostic).toBe(reason);
	});

	it("keeps what it last knew rather than the reason it could not refresh it", async () => {
		// The rule the Sidebar's note already followed: a network that dropped
		// must not read as an Issue that closed. So a row that has an answer
		// keeps showing it, and the reason travels beside it rather than on it.
		//
		// One watcher across both rounds, because what is being tested is the
		// answer it remembers — a second watcher would start knowing nothing.
		const { GitHubUnavailable } = await import("./github.js");
		checkedOut("feature/128-tidy");
		const published: RepositoryStatusWire[] = [];
		let watched: readonly { id: string; root: string }[] = [WORKSPACE];
		const running = new RepositoryStatusWatcher({
			gitCommand: () => Promise.resolve({} as never),
			environment: {},
			workspaces: () => watched,
			publish: (status) => published.push(status),
		});
		running.start();
		await vi.waitFor(() => {
			expect(published.length).toBeGreaterThanOrEqual(2);
		});
		expect(published.at(-1)?.workspaces[0]?.issue?.number).toBe(128);

		// A second look, asked for the way a projection change asks for one.
		readBranchStatus.mockRejectedValue(
			new GitHubUnavailable("GitHub answered 502."),
		);
		watched = [WORKSPACE, { id: "w-2", root: "/projects/other" }];
		const before = published.length;
		running.observe();
		await vi.waitFor(() => {
			expect(published.length).toBeGreaterThanOrEqual(before + 2);
		});
		running.stop();

		const after = published.at(-1)?.workspaces[0];
		expect(after?.issue?.number).toBe(128);
		expect(after?.unavailable).toBeUndefined();
		expect(published.at(-1)?.diagnostic).toBe("GitHub answered 502.");
	});

	it("shows a branch it has just switched to without waiting for GitHub", async () => {
		// Two clocks, and this is why: the branch is one local command and
		// changes while somebody watches; what GitHub says is a round trip and
		// changes when somebody on another continent clicks a button. On one
		// clock a branch you had just changed took up to a minute to appear.
		vi.useFakeTimers();
		try {
			checkedOut("feature/128-tidy");
			const published: RepositoryStatusWire[] = [];
			const running = watcher(published);
			running.start();
			await vi.waitFor(() => {
				expect(published.length).toBeGreaterThan(0);
			});
			expect(published.at(-1)?.workspaces[0]?.branch).toBe("feature/128-tidy");

			// Somebody runs `git switch`, and GitHub stops answering at the same
			// moment. The branch must still appear: it is a local command, and
			// nothing about it waits on the round trip.
			readBranchStatus.mockImplementation(() => new Promise(() => undefined));
			readBranch.mockResolvedValue("master");
			readRepository.mockResolvedValue({
				mainWorktree: "/projects/widget",
				branch: "master",
				remote: "github.com/example/widget",
			});
			const before = published.length;
			await vi.advanceTimersByTimeAsync(BRANCH_POLL_INTERVAL_MS);

			// The very next publish is the fast clock's own, made out of one local
			// command while GitHub is still being waited on.
			expect(published[before]?.workspaces[0]?.branch).toBe("master");
			running.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not re-read the repository while the branch stays put", async () => {
		// What makes the fast clock cheap: one local command per workspace, and
		// nothing else unless the answer actually changed. Without this it would
		// be a full round every two seconds, which is the poll this file is
		// written to avoid.
		vi.useFakeTimers();
		try {
			checkedOut("feature/128-tidy");
			const published: RepositoryStatusWire[] = [];
			const running = watcher(published);
			running.start();
			await vi.waitFor(() => {
				expect(published.length).toBeGreaterThan(0);
			});

			await vi.advanceTimersByTimeAsync(BRANCH_POLL_INTERVAL_MS * 3);
			expect(readRepository).toHaveBeenCalledTimes(1);
			running.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("says it is asking while it has a number and no answer", async () => {
		// The gap the fast clock created: the branch is on screen a second or
		// two before GitHub answers, and a blank there would look exactly like a
		// branch that is about no Issue.
		checkedOut("feature/128-tidy");
		let answer: (value: unknown) => void = () => undefined;
		readBranchStatus.mockImplementation(
			() =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		);
		const published: RepositoryStatusWire[] = [];
		const running = watcher(published);
		running.start();
		// The local half, published before GitHub has been heard from at all.
		await vi.waitFor(() => {
			expect(published.length).toBeGreaterThan(0);
		});
		running.stop();
		answer({ issue: { number: 128, title: "Tidy", state: "open", url: "u" } });

		const row = published.at(-1)?.workspaces[0];
		expect(row?.pending).toEqual({ number: 128 });
		expect(row?.issue).toBeUndefined();
		expect(row?.unavailable).toBeUndefined();
	});

	it("says which remote it could not read as a GitHub repository", async () => {
		// The branch carries a number and the remote is what says whose. A remote
		// that normalises perfectly well but is not github.com — an SSH alias out
		// of `~/.ssh/config`, a host on a non-default port, an Enterprise install
		// — used to fail this test silently, so a person with a working `gh` and
		// a branch named exactly right got a blank line and nothing to read.
		readRepository.mockResolvedValue({
			mainWorktree: "/projects/widget",
			branch: "feature/128-tidy",
			remote: "github-alt/example/widget",
		});
		const status = await round();
		const row = status.workspaces[0];
		expect(row?.branch).toBe("feature/128-tidy");
		expect(row?.issue).toBeUndefined();
		expect(row?.unavailable?.number).toBe(128);
		expect(row?.unavailable?.reason).toMatch(/github-alt\/example\/widget/u);
		expect(readBranchStatus).not.toHaveBeenCalled();
	});

	it("says so when the branch names an Issue and there is no remote at all", async () => {
		readRepository.mockResolvedValue({
			mainWorktree: "/projects/widget",
			branch: "feature/128-tidy",
			remote: undefined,
		});
		const status = await round();
		expect(status.workspaces[0]?.unavailable?.number).toBe(128);
		expect(status.workspaces[0]?.unavailable?.reason).toMatch(/`origin`/u);
	});

	it("says nothing at all when a branch that names no Issue has nothing out from it", async () => {
		// The one blank that is a fact rather than a failure, and it has to stay
		// blank: a reason on every `master` would be noise on most of the list.
		checkedOut("master");
		const status = await round();
		expect(status.workspaces[0]?.issue).toBeUndefined();
		expect(status.workspaces[0]?.pullRequest).toBeUndefined();
		expect(status.workspaces[0]?.pending).toBeUndefined();
		expect(status.workspaces[0]?.unavailable).toBeUndefined();
		expect(status.diagnostic).toBeUndefined();
	});

	it("says nothing at all when the workspace is not a repository", async () => {
		// `readRepository` answers `undefined` for a plain folder, and that is the
		// only `undefined` that means "nothing is wrong".
		readRepository.mockResolvedValue(undefined);
		const status = await round();
		expect(status.workspaces[0]?.branch).toBeUndefined();
		expect(status.workspaces[0]?.unavailable).toBeUndefined();
		expect(status.diagnostic).toBeUndefined();
		expect(readBranchStatus).not.toHaveBeenCalled();
	});

	it("says on the row when git refused to read the repository", async () => {
		// This was swallowed whole by a `.catch(() => undefined)`: a timeout, a
		// permission, a broken index or a repository owned by somebody else all
		// left the row with no branch, no Issue and no reason — identical to a
		// workspace nobody had started work in. It is the failure DevHub can
		// guess at least and the one most worth reading.
		const { TypedFailure } = await import("../../model/wire.js");
		const { errorWireAt, withSummary } = await import("../../model/wire.js");
		readRepository.mockRejectedValue(
			new TypedFailure(
				withSummary(
					errorWireAt("workspace_unavailable"),
					"fatal: detected dubious ownership in repository at '/projects/widget'",
				),
			),
		);

		const status = await round();
		const row = status.workspaces[0];
		expect(row?.unavailable?.reason).toMatch(/dubious ownership/u);
		expect(row?.unavailable?.number).toBeUndefined();
		// And the Sidebar's note carries it too: one workspace whose git is broken
		// is usually every workspace.
		expect(status.diagnostic).toMatch(/dubious ownership/u);
		expect(readBranchStatus).not.toHaveBeenCalled();
	});
});

/**
 * The pull request, which is now a question about the branch rather than a
 * search of the repository.
 *
 * The old way asked GitHub for an Issue, pulled down the bodies of up to fifty
 * open pull requests, and looked for one that said `Closes #128`. That could
 * only find a pull request that was still open, only in a repository small
 * enough to page through, and only where somebody had written the keyword. The
 * branch knows what is out from it regardless.
 */
describe("the pull request out from a branch", () => {
	it("is asked for on a branch that names no Issue at all", async () => {
		// The case the old design could not express: there was no Issue to key the
		// question by, so a workspace on `spike/rework` with a pull request open
		// had nothing to show.
		checkedOut("spike/rework");
		readBranchStatus.mockResolvedValue({
			pullRequest: {
				number: 7,
				url: "https://github.com/example/widget/pull/7",
				title: "Rework the picker",
				state: "open",
			},
		});

		const status = await round();
		expect(readBranchStatus).toHaveBeenCalledWith(
			{
				owner: "example",
				repository: "widget",
				headOwner: "example",
				branch: "spike/rework",
			},
			"token",
		);
		const row = status.workspaces[0];
		expect(row?.issue).toBeUndefined();
		expect(row?.pullRequest).toEqual({
			number: 7,
			url: "https://github.com/example/widget/pull/7",
			title: "Rework the picker",
			state: "open",
		});
	});

	it("is still there after it is merged", async () => {
		// The other thing the old design could not express: it only ever looked at
		// open pull requests, so the moment work landed the row went blank — at
		// exactly the moment "this has landed" is the most useful thing it could
		// say about a branch nobody has deleted yet.
		checkedOut("feature/128-tidy");
		readBranchStatus.mockResolvedValue({
			issue: { number: 128, title: "Tidy", state: "closed", url: "u" },
			pullRequest: {
				number: 9,
				url: "p",
				title: "Tidy the picker",
				state: "merged",
			},
		});

		const row = (await round()).workspaces[0];
		expect(row?.pullRequest?.state).toBe("merged");
		expect(row?.issue?.state).toBe("closed");
	});

	it("does not put a reason on a row that was never expecting an answer", async () => {
		// Every branch in a GitHub repository is asked about now, including the
		// ones that will never have a pull request. Surfacing GitHub's failure on
		// all of them would put a red line on every row in the window whenever the
		// network drops, to say once per row what the Sidebar's foot says once.
		// A branch that *names* an Issue is making a claim the row cannot back up,
		// and that one still says so — the test above pins it.
		const { GitHubUnavailable } = await import("./github.js");
		checkedOut("master");
		readBranchStatus.mockRejectedValue(
			new GitHubUnavailable("GitHub answered 502."),
		);

		const status = await round();
		expect(status.workspaces[0]?.unavailable).toBeUndefined();
		// Not swallowed: it is at the foot of the Sidebar, where one network
		// failure is said once.
		expect(status.diagnostic).toBe("GitHub answered 502.");
	});

	it("asks upstream about a fork's branch, and keeps the branch as the fork's", async () => {
		// The rule for a fork: the numbers live in `upstream`, the branch lives in
		// `origin`. Asking `origin` about `#128` answers about a different Issue
		// or about none, because a fork's Issues are turned off or numbered on
		// their own.
		readRepository.mockResolvedValue({
			mainWorktree: "/projects/widget",
			worktree: "/projects/widget",
			branch: "feature/128-tidy",
			remote: "github.com/contributor/widget",
			upstream: "github.com/example/widget",
		});
		readBranch.mockResolvedValue("feature/128-tidy");
		readDirty.mockResolvedValue(false);

		await round();
		expect(readBranchStatus).toHaveBeenCalledWith(
			{
				owner: "example",
				repository: "widget",
				headOwner: "contributor",
				branch: "feature/128-tidy",
				issueNumber: 128,
			},
			"token",
		);
	});

	it("stays on origin when there is no upstream to prefer", async () => {
		checkedOut("feature/128-tidy");
		await round();
		expect(readBranchStatus).toHaveBeenCalledWith(
			expect.objectContaining({ owner: "example", headOwner: "example" }),
			"token",
		);
	});

	it("does not say it is asking on a branch that names no Issue", async () => {
		// A spinner is suspense, and there is nothing to be in suspense about: the
		// ordinary answer for `master` is "there is no pull request", and drawing
		// that as a pending row on every workspace every minute would be noise on
		// most of the list.
		checkedOut("master");
		readBranchStatus.mockImplementation(() => new Promise(() => undefined));
		const published: RepositoryStatusWire[] = [];
		const running = watcher(published);
		running.start();
		await vi.waitFor(() => {
			expect(published.length).toBeGreaterThan(0);
		});
		running.stop();

		expect(published.at(-1)?.workspaces[0]?.pending).toBeUndefined();
	});
});

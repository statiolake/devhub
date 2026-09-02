/**
 * Which Issue a workspace is about, and what makes it change.
 *
 * The whole of the link is the branch that is checked out. DevHub used to
 * prefer a record written when the person assigned an Issue and fall back to
 * the branch name — but a record cannot follow a checkout, so a workspace
 * assigned Issue 128 and then switched to `master` went on claiming 128. These
 * pin the replacement: the branch decides, every round, and a workspace on a
 * branch that says nothing about an Issue is about no Issue.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryStatusWire } from "../../ipc/contract.js";

const readRepository = vi.fn();
const readBranch = vi.fn();
const readIssueStatus = vi.fn();
const readGitHubToken = vi.fn();

vi.mock("./git.js", () => ({
	readRepository: (...args: unknown[]) => readRepository(...args),
	readBranch: (...args: unknown[]) => readBranch(...args),
}));
vi.mock("./github.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	readGitHubToken: (...args: unknown[]) => readGitHubToken(...args),
	readIssueStatus: (...args: unknown[]) => readIssueStatus(...args),
}));

const { BRANCH_POLL_INTERVAL_MS, RepositoryStatusWatcher } = await import(
	"./repositoryStatus.js"
);

const WORKSPACE = { id: "w-1", root: "/projects/widget" };

/** What git says is checked out here. */
function checkedOut(branch: string | undefined) {
	readRepository.mockResolvedValue({
		mainWorktree: "/projects/widget",
		branch,
		remote: "github.com/example/widget",
	});
	// The fast clock asks the cheap question; it must agree with the slow one
	// until a test says otherwise.
	readBranch.mockResolvedValue(branch);
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
	readIssueStatus.mockImplementation(
		(issue: { owner: string; repository: string; number: number }) => ({
			issue,
			title: `Issue ${String(issue.number)}`,
			state: "open",
			url: `https://github.com/${issue.owner}/${issue.repository}/issues/${String(issue.number)}`,
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
		expect(readIssueStatus).toHaveBeenCalledWith(
			{ owner: "example", repository: "widget", number: 1234 },
			"token",
		);
	});

	it("says on the row which Issue it is about when the look failed", async () => {
		// The reason used to be one line at the foot of the whole Sidebar, so a
		// row whose Issue could not be read looked exactly like a row about no
		// Issue at all. Both facts are now on the row that has them.
		const { GitHubUnavailable } = await import("./github.js");
		checkedOut("feature/128-tidy");
		readIssueStatus.mockRejectedValue(
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
		expect(readIssueStatus).not.toHaveBeenCalled();
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
		readIssueStatus.mockRejectedValue(
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

			// Somebody runs `git switch`. Only the cheap question is re-asked.
			readBranch.mockResolvedValue("master");
			await vi.advanceTimersByTimeAsync(BRANCH_POLL_INTERVAL_MS);

			expect(published.at(-1)?.workspaces[0]?.branch).toBe("master");
			// And the whole repository was not re-read to find that out.
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
		readIssueStatus.mockImplementation(
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
		answer({
			issue: { owner: "example", repository: "widget", number: 128 },
			title: "Tidy",
			state: "open",
			url: "u",
		});

		const row = published.at(-1)?.workspaces[0];
		expect(row?.pending).toEqual({ number: 128 });
		expect(row?.issue).toBeUndefined();
		expect(row?.unavailable).toBeUndefined();
	});

	it("asks GitHub about nothing when the branch names no Issue", async () => {
		checkedOut("master");
		await round();
		expect(readIssueStatus).not.toHaveBeenCalled();
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
		expect(readIssueStatus).not.toHaveBeenCalled();
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

	it("says nothing at all when the branch names no Issue", async () => {
		// The one blank that is a fact rather than a failure, and it has to stay
		// blank: a reason on every `master` would be noise on most of the list.
		checkedOut("master");
		const status = await round();
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
		expect(readIssueStatus).not.toHaveBeenCalled();
	});
});

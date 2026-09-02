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
const readIssueStatus = vi.fn();
const readGitHubToken = vi.fn();

vi.mock("./git.js", () => ({
	readRepository: (...args: unknown[]) => readRepository(...args),
}));
vi.mock("./github.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	readGitHubToken: (...args: unknown[]) => readGitHubToken(...args),
	readIssueStatus: (...args: unknown[]) => readIssueStatus(...args),
}));

const { RepositoryStatusWatcher } = await import("./repositoryStatus.js");

const WORKSPACE = { id: "w-1", root: "/projects/widget" };

/** What git says is checked out here. */
function checkedOut(branch: string | undefined) {
	readRepository.mockResolvedValue({
		mainWorktree: "/projects/widget",
		branch,
		remote: "github.com/example/widget",
	});
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
	readGitHubToken.mockResolvedValue("token");
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
		expect(row?.issueUnavailable).toEqual({
			number: 128,
			reason: "GitHub has no issue example/widget#128.",
		});
		// And the Sidebar's own note still carries it, as it always did.
		expect(status.diagnostic).toBe("GitHub has no issue example/widget#128.");
	});

	it("says so on every row when there are no credentials at all", async () => {
		checkedOut("feature/128-tidy");
		readGitHubToken.mockResolvedValue(undefined);

		const status = await round();
		expect(status.workspaces[0]?.issueUnavailable?.reason).toMatch(
			/gh auth login/u,
		);
		expect(readIssueStatus).not.toHaveBeenCalled();
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
			expect(published).toHaveLength(1);
		});
		expect(published[0]?.workspaces[0]?.issue?.number).toBe(128);

		// A second look, asked for the way a projection change asks for one.
		readIssueStatus.mockRejectedValue(
			new GitHubUnavailable("GitHub answered 502."),
		);
		watched = [WORKSPACE, { id: "w-2", root: "/projects/other" }];
		running.observe();
		await vi.waitFor(() => {
			expect(published).toHaveLength(2);
		});
		running.stop();

		const after = published[1]?.workspaces[0];
		expect(after?.issue?.number).toBe(128);
		expect(after?.issueUnavailable).toBeUndefined();
		expect(published[1]?.diagnostic).toBe("GitHub answered 502.");
	});

	it("asks GitHub about nothing when the branch names no Issue", async () => {
		checkedOut("master");
		await round();
		expect(readIssueStatus).not.toHaveBeenCalled();
	});

	it("says nothing about an Issue when the remote is not GitHub", async () => {
		// The branch carries a number and the remote is what says whose. Without
		// one there is no Issue to name, only a branch.
		readRepository.mockResolvedValue({
			mainWorktree: "/projects/widget",
			branch: "feature/128-tidy",
			remote: undefined,
		});
		const status = await round();
		expect(status.workspaces[0]?.branch).toBe("feature/128-tidy");
		expect(status.workspaces[0]?.issue).toBeUndefined();
	});
});

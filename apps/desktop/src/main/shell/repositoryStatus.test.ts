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

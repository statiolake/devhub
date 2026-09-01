/**
 * What each workspace is working on, kept up to date.
 *
 * Two questions, on one clock. The local one is free and always answerable:
 * which branch is checked out. The remote one costs a round trip to GitHub and
 * is only asked for a workspace that is about an Issue — one the person
 * assigned, or one whose branch name follows the convention DevHub would have
 * used. A minute is the interval; nothing here reacts to a filesystem event,
 * because a poll that is late is a stale branch name and a watcher that is
 * wrong is a wrong one.
 *
 * **A failed look never blanks the display.** What was last known stays on
 * screen and the reason travels beside it, until a later look succeeds and
 * replaces both. The alternative — clearing on failure — makes a flaky network
 * look like an Issue that was closed.
 */

import type { IssueReference } from "../../model/github.js";
import { issueNumberFromBranch } from "../../model/github.js";
import type {
	RepositoryStatusWire,
	WorkspaceRepositoryWire,
} from "../../ipc/contract.js";
import { readRepository, type GitCommand } from "./git.js";
import {
	GitHubUnavailable,
	readGitHubToken,
	readIssueStatus,
	type IssueStatus,
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
/** How many Issues one round is allowed to ask GitHub about. */
const MAX_ISSUES_PER_ROUND = 16;

function issueKey(issue: IssueReference): string {
	return `${issue.owner}/${issue.repository}#${String(issue.number)}`;
}

/**
 * The Issue a workspace is about: the one its checked-out branch names.
 *
 * The only way a workspace is linked to an Issue. DevHub used to prefer a
 * record written when the person assigned one, and fall back to this — but a
 * record cannot follow a checkout, so a workspace assigned Issue 128 and then
 * switched to `master` kept claiming 128. The branch is read every round, so
 * switching branches moves the Issue with it, and a workspace sitting on
 * `master` is linked to nothing, which is the true answer.
 *
 * Only against a GitHub remote: the number in `feature/128-tidy` means nothing
 * without knowing whose 128 it is, and the branch cannot say. That is why the
 * remote is still read from git rather than derived alongside it.
 */
function issueFromConvention(
	remote: string | undefined,
	branch: string | undefined,
): IssueReference | undefined {
	if (!remote || !branch) return undefined;
	const number = issueNumberFromBranch(branch);
	if (number === undefined) return undefined;
	const match = /^github\.com\/([^/]+)\/([^/]+)$/u.exec(remote);
	const owner = match?.[1];
	const repository = match?.[2];
	if (!owner || !repository) return undefined;
	return { owner, repository, number };
}

export class RepositoryStatusWatcher {
	private timer: ReturnType<typeof setInterval> | undefined;
	private running = false;
	private sequence = 0;
	/** What was being watched when the last look was started. */
	private watching: string | undefined;
	/** The last answer for each Issue, kept so a failed round shows something. */
	private readonly known = new Map<string, IssueStatus>();

	constructor(private readonly deps: RepositoryStatusDeps) {}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.refresh();
		}, POLL_INTERVAL_MS);
		// Not `unref`'d: this is a projection the window is drawing, and the
		// interval is the only thing keeping it true.
		void this.refresh();
	}

	stop(): void {
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

	private async read(): Promise<RepositoryStatusWire> {
		const workspaces = this.deps.workspaces();
		let diagnostic: string | undefined;

		const command = await this.deps.gitCommand().catch((error: unknown) => {
			diagnostic = error instanceof Error ? error.message : String(error);
			return undefined;
		});

		const local = await Promise.all(
			workspaces.map(async (workspace) => {
				const facts = command
					? await readRepository(command, workspace.root).catch(() => undefined)
					: undefined;
				return {
					workspace,
					branch: facts?.branch,
					issue: issueFromConvention(facts?.remote, facts?.branch),
				};
			}),
		);

		const wanted = new Map<string, IssueReference>();
		for (const entry of local) {
			if (entry.issue) wanted.set(issueKey(entry.issue), entry.issue);
		}

		if (wanted.size > 0) {
			const token = await readGitHubToken(this.deps.environment);
			if (!token) {
				diagnostic =
					"DevHub has no GitHub credentials. Run `gh auth login` to show issue and pull request status.";
			} else {
				for (const issue of [...wanted.values()].slice(
					0,
					MAX_ISSUES_PER_ROUND,
				)) {
					try {
						this.known.set(
							issueKey(issue),
							await readIssueStatus(issue, token),
						);
					} catch (error: unknown) {
						// Only GitHub's own refusals are reported this way. Anything
						// else is a bug in DevHub, and it goes to the root handler
						// rather than being drawn as a status line.
						if (!(error instanceof GitHubUnavailable)) throw error;
						diagnostic = error.message;
					}
				}
			}
		}

		const projected: WorkspaceRepositoryWire[] = local.map((entry) => {
			const status = entry.issue
				? this.known.get(issueKey(entry.issue))
				: undefined;
			return {
				workspaceId: entry.workspace.id,
				branch: entry.branch,
				issue: status
					? {
							url: status.url,
							number: status.issue.number,
							title: status.title,
							state: status.state,
						}
					: undefined,
				pullRequest: status?.pullRequest,
			};
		});

		this.sequence += 1;
		return {
			sequence: this.sequence,
			workspaces: projected,
			diagnostic,
		};
	}
}

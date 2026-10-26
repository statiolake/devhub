// Port of `RepositoryStatusWire` and `WorkspaceRepositoryWire` from
// apps/desktop/src/ipc/contract.ts: what the repository status poller
// publishes, and what the Sidebar's rows and the Smart Buttons read.

import Foundation

/// What every open Workspace is working on, as last read.
public struct RepositoryStatusWire: Equatable, Sendable, Codable {
    public var sequence: Int
    public var workspaces: [WorkspaceRepositoryWire]
    /// Why the last look was incomplete, if it was — and only when no row
    /// already says so. It travels *beside* what is still known rather than
    /// replacing it: a network that dropped must not read as an Issue that
    /// closed.
    public var diagnostic: String?

    public init(sequence: Int = 0, workspaces: [WorkspaceRepositoryWire] = [], diagnostic: String? = nil) {
        self.sequence = sequence
        self.workspaces = workspaces
        self.diagnostic = diagnostic
    }

    /// The row for one Workspace, when a round has read it.
    public func workspace(_ id: String) -> WorkspaceRepositoryWire? {
        workspaces.first { $0.workspaceId == id }
    }
}

public struct IssueRepositoryName: Equatable, Hashable, Sendable, Codable {
    public var owner: String
    public var repository: String

    public init(owner: String, repository: String) {
        self.owner = owner
        self.repository = repository
    }
}

/// One Workspace's row. Every field is optional because every one of them
/// may be unknown, and unknown is never drawn as a value (absent `dirty` is
/// not clean; absent `ahead` is not zero).
public struct WorkspaceRepositoryWire: Equatable, Sendable, Codable {
    public var workspaceId: String
    /// What is checked out, or nothing when the workspace is not a repository.
    public var branch: String?
    /// The branch is checked out but nothing has been committed to it yet.
    public var unborn: Bool?
    /// The repository this workspace belongs to: its main worktree's path.
    public var mainWorktree: String?
    /// The root of the checkout this workspace sits in.
    public var worktree: String?
    /// The repository's page, for a workspace whose `origin` is on GitHub.
    public var repositoryUrl: String?
    /// Where this workspace's Issues and pull requests are numbered:
    /// `upstream` in a fork, else `origin`. What a bare `#128` links to.
    public var issueRepository: IssueRepositoryName?
    /// Work here that removing the folder would destroy, as of the last look.
    public var dirty: Bool?
    /// Commits here that the branch's upstream does not have.
    public var ahead: Int?
    /// What `origin` calls its default branch, when the clone knows.
    public var defaultBranch: String?
    public var issue: IssueStatus?
    /// The pull request out from the checked-out branch.
    public var pullRequest: PullRequestStatus?
    /// DevHub knows which Issue this is and has not heard back yet.
    public var pending: Pending?
    /// Why this row cannot say what the workspace is working on.
    public var unavailable: Unavailable?

    public struct Pending: Equatable, Sendable, Codable {
        public var number: Int
        public init(number: Int) { self.number = number }
    }

    public struct Unavailable: Equatable, Sendable, Codable {
        /// The Issue the branch named, when the branch got far enough to name one.
        public var number: Int?
        /// GitHub's own words, git's own words, or DevHub's about not having asked.
        public var reason: String

        public init(number: Int? = nil, reason: String) {
            self.number = number
            self.reason = reason
        }
    }

    public init(
        workspaceId: String,
        branch: String? = nil,
        unborn: Bool? = nil,
        mainWorktree: String? = nil,
        worktree: String? = nil,
        repositoryUrl: String? = nil,
        issueRepository: IssueRepositoryName? = nil,
        dirty: Bool? = nil,
        ahead: Int? = nil,
        defaultBranch: String? = nil,
        issue: IssueStatus? = nil,
        pullRequest: PullRequestStatus? = nil,
        pending: Pending? = nil,
        unavailable: Unavailable? = nil
    ) {
        self.workspaceId = workspaceId
        self.branch = branch
        self.unborn = unborn
        self.mainWorktree = mainWorktree
        self.worktree = worktree
        self.repositoryUrl = repositoryUrl
        self.issueRepository = issueRepository
        self.dirty = dirty
        self.ahead = ahead
        self.defaultBranch = defaultBranch
        self.issue = issue
        self.pullRequest = pullRequest
        self.pending = pending
        self.unavailable = unavailable
    }

    /// Whether closing this row deletes its folder (`closingDeletesWorktree`).
    public func closingDeletesWorktree(root: String) -> Bool {
        Worktrees.closingDeletesWorktree(mainWorktree: mainWorktree, worktree: worktree, root: root)
    }
}

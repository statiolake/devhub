// Port of apps/desktop/src/main/shell/issues.ts.
//
// Finding the clone an Issue belongs to.
//
// The question the flow asks is "do I already have this repository?", and the
// answer has to come from the same places the workspace picker looks — the
// sources in `settings.toml` plus whatever is already open — or DevHub would
// know about repositories in one dialog and not in another.
//
// So the picker's own search is what runs, for the repository's name, and this
// only decides which of its answers are really that repository: a directory
// whose name is the repository's (or one of its worktrees, `{repo}_{…}`) and
// whose `origin` normalises to the same identity. The name narrows it cheaply;
// the remote is what makes it true, because two people's `widget` are not the
// same widget.
//
// The search itself is the Workspace picker's (WP11's
// `main/shell/workspacePicker.ts`), handed in as `searchSources`; a cancelled
// lookup (the task running it is cancelled) ends that search and the `git` in
// flight, and never answers.

import Foundation

/// A folder, and the machine it is on (`WorkspacePlaceWire`).
public enum WorkspacePlace: Hashable, Sendable, Codable {
    case local(path: String)
    case ssh(host: String, path: String)

    public var path: String {
        switch self {
        case .local(let path), .ssh(_, let path): return path
        }
    }

    /// The same machine, another path on it.
    public func with(path: String) -> WorkspacePlace {
        switch self {
        case .local: return .local(path: path)
        case .ssh(let host, _): return .ssh(host: host, path: path)
        }
    }

    /// A place as a person reads it: `host:path` when the machine is not this
    /// one (`placeLabel`).
    public var label: String {
        switch self {
        case .local(let path): return path
        case .ssh(let host, let path): return "\(host):\(path)"
        }
    }

    /// What makes two places the same place: the machine as well as the path.
    var key: String {
        switch self {
        case .local(let path): return path
        case .ssh(let host, let path): return "ssh://\(host)\(path)"
        }
    }
}

/// One place work can happen: a repository itself, or one of its worktrees.
public struct WorktreeCandidate: Equatable, Sendable {
    public var place: WorkspacePlace
    /// What is checked out there, so the person can tell two worktrees apart.
    public var branch: String?
    /// This is the repository itself rather than one of its worktrees.
    public var isMainWorktree: Bool

    public init(place: WorkspacePlace, branch: String?, isMainWorktree: Bool) {
        self.place = place
        self.branch = branch
        self.isMainWorktree = isMainWorktree
    }
}

/// One clone of the Issue's repository, with everywhere it is checked out.
public struct RepositoryCandidate: Equatable, Sendable {
    /// The main worktree, and the machine it is on.
    public var place: WorkspacePlace
    public var worktrees: [WorktreeCandidate]

    public init(place: WorkspacePlace, worktrees: [WorktreeCandidate]) {
        self.place = place
        self.worktrees = worktrees
    }
}

public enum IssueClones {
    /// How many named-alike directories are worth asking git about.
    static let maxInspected = 64

    /// The remote identity an Issue's repository is reached at.
    public static func remote(for issue: IssueReference) -> RemoteIdentity? {
        RemoteIdentity.normalize("https://github.com/\(issue.owner)/\(issue.repository).git")
    }

    /// Every clone of the Issue's repository DevHub can see, each with
    /// everywhere it is checked out.
    ///
    /// `openPlaces` are the workspaces already open, which the sources need not
    /// know about. Directories the search found are folded together by their
    /// main worktree — the identity git itself answers with — and each
    /// repository's worktrees are read from `git worktree list`, not from what
    /// the search happened to reach.
    ///
    /// - Parameters:
    ///   - searchSources: the Workspace picker's search of this machine's
    ///     sources for a query, collected; it should stop when the task is
    ///     cancelled.
    ///   - gitFor: the git of the machine a place is on.
    public static func find(
        issue: IssueReference,
        openPlaces: [WorkspacePlace],
        searchSources: @Sendable (String) async -> [String],
        gitFor: @Sendable (WorkspacePlace) async throws -> GitCommand
    ) async throws -> [RepositoryCandidate] {
        let wanted = remote(for: issue)
        // The sources walk *this* machine's disk, so what they find is on it.
        // A Workspace that is already open arrives with the machine it is on.
        var candidates: [String: WorkspacePlace] = [:]
        var order: [String] = []
        let found = await searchSources(issue.repository)
        for place in openPlaces + found.map({ WorkspacePlace.local(path: $0) }) {
            guard namesRepository(place.path, issue.repository) else { continue }
            if candidates[place.key] == nil { order.append(place.key) }
            candidates[place.key] = place
        }

        var repositories: [String: WorkspacePlace] = [:]
        var repositoryOrder: [String] = []
        for key in order.prefix(maxInspected) {
            guard let place = candidates[key] else { continue }
            // The seam where an abandoned lookup stops costing anything.
            try Task.checkCancellation()
            let command = try await gitFor(place)
            // One directory git will not answer about is one candidate lost,
            // not the question. Cancellation is not one of these.
            let facts: RepositoryFacts?
            do {
                facts = try await command.readRepository(place.path)
            } catch {
                try Task.checkCancellation()
                continue
            }
            guard let facts, facts.remote == wanted, wanted != nil else { continue }
            // A repository's main worktree is on the same machine as the
            // checkout git read it from.
            let main = place.with(path: facts.mainWorktree)
            if repositories[main.key] == nil { repositoryOrder.append(main.key) }
            repositories[main.key] = main
        }

        var result: [RepositoryCandidate] = []
        for key in repositoryOrder {
            guard let place = repositories[key] else { continue }
            try Task.checkCancellation()
            result.append(RepositoryCandidate(place: place, worktrees: try await worktrees(of: place, command: try await gitFor(place))))
        }
        // A cancelled lookup never *answers*: a short list is
        // indistinguishable from the real one.
        try Task.checkCancellation()
        return result
    }

    /// Everywhere one repository is checked out, the repository itself first.
    /// A repository git will not answer about is still offered as itself.
    static func worktrees(of main: WorkspacePlace, command: GitCommand) async throws -> [WorktreeCandidate] {
        let itself = WorktreeCandidate(place: main, branch: nil, isMainWorktree: true)
        let output: String
        do {
            output = try await command.run(["worktree", "list", "--porcelain"], cwd: main.path)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            return [itself]
        }
        let records = GitParsing.worktrees(output).map { record in
            WorktreeCandidate(place: main.with(path: record.path), branch: record.branch, isMainWorktree: record.path == main.path)
        }
        // A stable sort: the repository itself first, the rest in git's order.
        return records.filter(\.isMainWorktree) + records.filter { !$0.isMainWorktree }
    }

    /// `widget`, or a worktree of it: `widget_128`, or `widget_feature_128-tidy`
    /// as earlier versions named them.
    static func namesRepository(_ path: String, _ repository: String) -> Bool {
        let name = Worktrees.baseName(path)
        return name == repository || name.hasPrefix("\(repository)_")
    }
}

// MARK: - The branch question and the folder (main/shell/appController.ts)

/// The branch this Issue or pull request already has, and what this clone
/// can do with it (`AssignmentBranchWire`).
public struct AssignmentBranch: Equatable, Sendable {
    /// The branch that exists for it: a pull request's head, an Issue's link.
    public var branch: String?
    /// Where the branch lives, when that is not the repository being worked in
    /// — `alice/widget` for a pull request out of a fork. Present *and*
    /// `reachable` false is the case worth saying out loud.
    public var fork: String?
    /// The branch is here, or on a remote this clone has, so it can be had.
    public var reachable: Bool
    /// Where it is already checked out, when it is. Opening that is the offer.
    public var checkedOutAt: String?
    /// A pull request's state, when GitHub said: a merged or closed one whose
    /// head is gone is stopped before the branch question with that reason.
    public var pullRequestState: PullRequestHead.State?

    public init(branch: String? = nil, fork: String? = nil, reachable: Bool, checkedOutAt: String? = nil, pullRequestState: PullRequestHead.State? = nil) {
        self.branch = branch
        self.fork = fork
        self.reachable = reachable
        self.checkedOutAt = checkedOutAt
        self.pullRequestState = pullRequestState
    }

    /// `issueBranchPlan`: an Issue's branch that is neither reachable nor
    /// checked out is dropped, so the Issue reads as not started.
    public var offeredForAnIssue: AssignmentBranch {
        reachable || checkedOutAt != nil ? self : AssignmentBranch(reachable: false)
    }
}

/// The folder half of Assign Issue (`IssueFolderRequest`).
public struct IssueFolderRequest: Equatable, Sendable {
    public var issueUrl: String
    /// The clone to work in, and the machine it is on.
    public var place: WorkspacePlace
    /// The branch whose worktree to open, made if it is not there yet. Absent
    /// means the clone's own folder, on whatever branch it is on.
    public var branch: String?
    /// Check `branch` out in the clone's own folder instead of a worktree.
    public var inRoot: Bool
    /// Start the branch from the `origin` already on disk, the fetch having
    /// failed and the person having said to go on.
    public var allowStaleBase: Bool

    public init(issueUrl: String, place: WorkspacePlace, branch: String? = nil, inRoot: Bool = false, allowStaleBase: Bool = false) {
        self.issueUrl = issueUrl
        self.place = place
        self.branch = branch
        self.inRoot = inRoot
        self.allowStaleBase = allowStaleBase
    }
}

public enum IssueAssignmentFlow {
    static let notAnItem = "That is not a GitHub Issue or pull request URL."

    /// The branch this Issue or pull request already has, and what this clone
    /// can do with it.
    ///
    /// GitHub is asked what the branch *is* — a pull request's head, an Issue's
    /// linked branch — and git is asked whether this checkout can have it.
    /// Everything is best effort except the asking: GitHub refusing to talk at
    /// all is not softened, because then the flow is offering choices about
    /// something it never read.
    public static func branch(
        url: String,
        place: WorkspacePlace,
        environment: [String: String],
        git: GitCommand,
        readToken: @Sendable ([String: String]) async -> GitHubTokenResult = { await GitHubCLI.readToken(environment: $0) },
        client: GitHubClient = GitHubClient()
    ) async throws -> AssignmentBranch {
        let directory = place.path
        guard let item = GitHubItem.parse(url: url) else { throw CodedFailure.workspace(notAnItem) }
        let token: String
        switch await readToken(environment) {
        case .token(let value): token = value
        case .unauthenticated:
            throw CodedFailure.workspace("DevHub is not signed in to GitHub. Run `gh auth login` and try again.")
        case .unrunnable(let reason):
            throw CodedFailure.workspace("DevHub could not ask GitHub about \(item.owner)/\(item.repository)#\(item.number): \(reason).")
        }
        if item.kind == .pull {
            let head = try await client.readPullRequestHead(item.reference, token: token)
            // A branch in somebody else's copy is reachable only through a
            // remote that is already there. DevHub does not add one.
            let sameRepository = head.owner.lowercased() == item.owner.lowercased()
                && head.repository.lowercased() == item.repository.lowercased()
            let remote = sameRepository
                ? "origin"
                : try await git.remoteForRepository(owner: head.owner, repository: head.repository, in: directory)
            if let remote { try await git.fetchBranch(from: remote, branch: head.branch, in: directory) }
            var found = try await whereabouts(git, directory, head.branch, fork: sameRepository ? nil : "\(head.owner)/\(head.repository)")
            found.pullRequestState = head.state
            return found
        }
        // GitHub's own record first, and only then the convention, which is a
        // guess about a name.
        let linked = try await client.readIssueLinkedBranch(item.reference, token: token)
        // Fetched before either answer is looked for: a branch GitHub's button
        // made a minute ago is on `origin` and not yet in this clone's refs.
        try await git.refreshOrigin(directory)
        var branch = linked
        if branch == nil { branch = try await branchNamed(for: item, git: git, directory: directory) }
        guard let branch else { return AssignmentBranch(reachable: false) }
        return try await whereabouts(git, directory, branch, fork: nil).offeredForAnIssue
    }

    /// A branch on this machine or on `origin` that names the Issue — the same
    /// rule the Sidebar reads a branch by.
    static func branchNamed(for item: GitHubItem, git: GitCommand, directory: String) async throws -> String? {
        try await git.listBranches(directory).first { GitHubBranchNaming.issueNumber(fromBranch: $0) == item.number }
    }

    /// The same three git questions, whichever kind the branch came from.
    static func whereabouts(_ git: GitCommand, _ directory: String, _ branch: String, fork: String?) async throws -> AssignmentBranch {
        let found = try await git.findBranch(branch, in: directory)
        let checkedOutAt = try await git.worktreeForBranch(branch, in: directory)
        return AssignmentBranch(branch: branch, fork: fork, reachable: found != nil, checkedOutAt: checkedOutAt)
    }

    /// Make the worktree, or switch the clone's own folder, or take the clone
    /// as it stands, and answer with that folder — on the machine the flow was
    /// working on, because git made it beside the repository there.
    public static func prepareFolder(_ request: IssueFolderRequest, git: GitCommand) async throws -> WorkspacePlace {
        guard let item = GitHubItem.parse(url: request.issueUrl) else { throw CodedFailure.workspace(notAnItem) }
        guard let branch = request.branch, !branch.isEmpty else { return request.place }
        let work = WorkItem(kind: item.kind, number: item.number)
        let options = WorktreeOptions(allowStaleBase: request.allowStaleBase)
        let target = request.inRoot
            ? try await git.switchRootBranch(request.place.path, work: work, branch: branch, options: options)
            : try await git.ensureWorktree(request.place.path, work: work, branch: branch, options: options)
        return request.place.with(path: target)
    }

    /// `--tell issue assign`'s choice of branch when none was given: the one
    /// the sheet would offer, else the Issue's `feature/<n>-wip`; a pull
    /// request whose head cannot be reached has none.
    public static func defaultBranch(for item: GitHubItem, existing: AssignmentBranch) -> String? {
        if existing.reachable, let branch = existing.branch { return branch }
        return item.kind == .pull ? nil : GitHubBranchNaming.wipBranch(forIssue: item.number)
    }
}

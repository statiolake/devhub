// Port of apps/desktop/src/main/shell/repositoryStatus.ts.
//
// What each workspace is working on, kept up to date.
//
// Two questions. The first is cheap and always answerable: which branch is
// checked out, asked of the machine the checkout is on. The second costs a
// round trip to GitHub and is asked for any workspace whose `origin` is a
// GitHub repository — *what is this branch about?*, which is one question with
// two halves: the pull request out from the branch, and the Issue the branch
// names when it names one. GitHub is always asked from *this* machine,
// whatever machine the checkout is on.
//
// **A clock per machine, not a clock.** A poll interval is a fact about a link,
// so each machine with an open Workspace on it gets its own pair of clocks at
// its own `cadence.repositoryPollMs`, and a slow host cannot hold this Mac's
// rows up. There is still exactly one projection, published by all of them, so
// no row can be drawn two ways.
//
// **The branch is the unit.** Everything remote is keyed by
// `owner/repo@branch`, which every workspace in a GitHub repository has.
//
// **A failed look never blanks the display.** What was last known stays on
// screen and the reason travels beside it, until a later look succeeds and
// replaces both.
//
// **What makes a row change, and how late it can be.** Four triggers, reported
// per Workspace by `devhub --metrics`. A *full round* is `read` — every local
// fact for every Workspace on one machine, then GitHub for every branch among
// them. A *branch round* is `refreshBranches` — one `git` per Workspace and
// nothing else.
//
// | trigger  | what fires it                        | what it runs               |
// | -------- | ------------------------------------ | -------------------------- |
// | `poll`   | a clock at `cadence.repositoryPollMs`| a full round (and, on a second clock, a branch round) |
// | `head`   | `HEAD`/`refs/`/`packed-refs` written | a branch round, then a full round for each machine whose branch moved |
// | `focus`  | the window coming to the front       | a full round per machine, at most one per `cadence.repositoryFocusRefreshMinIntervalMs` |
// | `manual` | the refresh chord (`Cmd+Q R`)        | a full round per machine   |
//
// The one fact with no event behind it is *dirty*. A watcher on the working
// tree would give it one, and it is deliberately not here: a repository being
// built writes thousands of files a second. A focus round is the cheap answer
// to the case that actually bites, which is coming back from a terminal where
// you just edited something.

import Foundation

/// One open workspace, as the watcher needs to see it.
public struct WatchedWorkspace: Sendable {
    public var id: String
    public var root: String
    /// The machine its folder is on.
    public var runtime: RepositoryRuntime

    public init(id: String, root: String, runtime: RepositoryRuntime) {
        self.id = id
        self.root = root
        self.runtime = runtime
    }
}

/// What fired a full round (`diagnostics/rounds.ts`).
public enum RepositoryRoundTrigger: String, Sendable, Codable {
    case poll, head, focus, manual
}

/// Each Workspace's last full round, for `devhub --metrics`.
public struct WorkspaceRepositoryRound: Equatable, Sendable, Codable {
    public struct Round: Equatable, Sendable, Codable {
        /// ISO 8601, as `Date.prototype.toISOString` writes it.
        public var at: String
        public var trigger: RepositoryRoundTrigger
    }
    public var workspaceId: String
    public var lastRepositoryRound: Round
}

/// The git questions a round asks, so a test can answer them.
public protocol RepositoryReading: Sendable {
    func readRepository(_ command: GitCommand, _ root: String) async throws -> RepositoryFacts?
    func readBranch(_ command: GitCommand, _ root: String) async throws -> String?
    func readDirty(_ command: GitCommand, _ root: String) async throws -> Bool?
    func readAhead(_ command: GitCommand, _ root: String) async throws -> Int?
}

/// The GitHub questions a round asks, so a test can answer them.
public protocol GitHubAsking: Sendable {
    func readToken(environment: [String: String]) async -> GitHubTokenResult
    func readBranchStatus(_ reference: BranchReference, token: String) async throws -> BranchStatus
}

/// The real git.
public struct GitRepositoryReading: RepositoryReading {
    public init() {}
    public func readRepository(_ command: GitCommand, _ root: String) async throws -> RepositoryFacts? { try await command.readRepository(root) }
    public func readBranch(_ command: GitCommand, _ root: String) async throws -> String? { try await command.readBranch(root) }
    public func readDirty(_ command: GitCommand, _ root: String) async throws -> Bool? { try await command.readDirty(root) }
    public func readAhead(_ command: GitCommand, _ root: String) async throws -> Int? { try await command.readAhead(root) }
}

/// The real GitHub.
public struct LiveGitHubAsking: GitHubAsking {
    public var client: GitHubClient
    public init(client: GitHubClient = GitHubClient()) { self.client = client }
    public func readToken(environment: [String: String]) async -> GitHubTokenResult { await GitHubCLI.readToken(environment: environment) }
    public func readBranchStatus(_ reference: BranchReference, token: String) async throws -> BranchStatus {
        try await client.readBranchStatus(reference, token: token)
    }
}

/// Time, for the clocks: the system's, or a test's.
public protocol RepositoryClock: Sendable {
    /// Milliseconds since the epoch.
    func now() -> Double
    /// Throws `CancellationError` when the sleeping task is cancelled.
    func sleep(milliseconds: Int) async throws
}

public struct SystemRepositoryClock: RepositoryClock {
    public init() {}
    public func now() -> Double { Date().timeIntervalSince1970 * 1000 }
    public func sleep(milliseconds: Int) async throws {
        try await Task.sleep(nanoseconds: UInt64(max(0, milliseconds)) * 1_000_000)
    }
}

public struct RepositoryStatusDeps: Sendable {
    /// The git for one machine, resolved on it.
    public var gitCommand: @Sendable (RepositoryRuntime) async throws -> GitCommand
    public var environment: [String: String]
    public var workspaces: @Sendable () -> [WatchedWorkspace]
    public var publish: @Sendable (RepositoryStatusWire) -> Void
    public var git: RepositoryReading
    public var gitHub: GitHubAsking
    public var makeHeadWatcher: @Sendable (@escaping @Sendable () -> Void) -> HeadWatching
    public var clock: RepositoryClock

    public init(
        gitCommand: @escaping @Sendable (RepositoryRuntime) async throws -> GitCommand,
        environment: [String: String],
        workspaces: @escaping @Sendable () -> [WatchedWorkspace],
        publish: @escaping @Sendable (RepositoryStatusWire) -> Void,
        git: RepositoryReading = GitRepositoryReading(),
        gitHub: GitHubAsking = LiveGitHubAsking(),
        makeHeadWatcher: @escaping @Sendable (@escaping @Sendable () -> Void) -> HeadWatching = { HeadWatcher(onChange: $0) },
        clock: RepositoryClock = SystemRepositoryClock()
    ) {
        self.gitCommand = gitCommand
        self.environment = environment
        self.workspaces = workspaces
        self.publish = publish
        self.git = git
        self.gitHub = gitHub
        self.makeHeadWatcher = makeHeadWatcher
        self.clock = clock
    }
}

/// The repository rules of the poller, as strings.
public enum RepositoryStatusRules {
    /// How many branches one round is allowed to ask GitHub about.
    public static let maxBranchesPerRound = 16

    /// The page a remote's repository is at, when DevHub can name one:
    /// `github.com/owner/repo` is the only shape it knows.
    public static func repositoryUrl(_ remote: RemoteIdentity?) -> String? {
        guard let remote, TextPattern("^github\\.com/[^/]+/[^/]+$").matches(remote.rawValue) else { return nil }
        return "https://\(remote.rawValue)"
    }

    /// What identifies one remote question: the name on the remote, and the
    /// Issue the branch names — two branches that push to the same remote name
    /// but name different Issues are two questions.
    public static func branchKey(_ reference: BranchReference) -> String {
        "\(reference.owner)/\(reference.repository)@\(reference.headOwner):\(reference.remoteBranch)#\(reference.issueNumber.map(String.init) ?? "")"
    }

    /// `github.com/owner/repo`, split, or nothing when it is any other shape.
    ///
    /// **An alias is not resolved here, and deliberately.** A `~/.ssh/config`
    /// alias (`git@gh:me/x`) and a non-default port both survive
    /// `RemoteIdentity` as something this pattern rejects; folding them would
    /// make two remotes equal here and unequal everywhere else.
    public static func gitHubRepository(_ remote: RemoteIdentity?) -> IssueRepositoryName? {
        guard let remote, let match = TextPattern("^github\\.com/([^/]+)/([^/]+)$").firstMatch(in: remote.rawValue),
              let owner = match[1], let repository = match[2], !owner.isEmpty, !repository.isEmpty
        else { return nil }
        return IssueRepositoryName(owner: owner, repository: repository)
    }

    /// Where a checkout's Issues and pull requests are numbered: `upstream` in
    /// a fork, else `origin`, and nothing when `origin` is not a github.com
    /// repository. An `upstream` DevHub cannot read is ignored.
    public static func issueRepository(remote: RemoteIdentity?, upstream: RemoteIdentity?) -> IssueRepositoryName? {
        guard let head = gitHubRepository(remote) else { return nil }
        return gitHubRepository(upstream) ?? head
    }

    /// What this workspace's checked-out branch gives GitHub to answer about.
    ///
    /// Three answers, because there are three situations and only one of them
    /// is "nothing to show". A workspace whose `origin` is not a GitHub
    /// repository has nothing to ask. A branch that *names an Issue* but whose
    /// remote cannot be turned into a GitHub repository is a failure, and says
    /// so.
    public enum BranchReading: Equatable, Sendable {
        case none
        case branch(BranchReference)
        case unresolved(number: Int, reason: String)
    }

    public static func branchFromLocal(remote: RemoteIdentity?, upstream: RemoteIdentity?, branch: String?, pushBranch: String?) -> BranchReading {
        guard let branch else { return .none }
        let number = GitHubBranchNaming.issueNumber(fromBranch: branch)
        guard let head = gitHubRepository(remote), let item = issueRepository(remote: remote, upstream: upstream) else {
            guard let number else { return .none }
            return .unresolved(
                number: number,
                reason: remote == nil
                    ? "this branch names an issue, but the workspace has no `origin` remote to say whose."
                    : "`origin` is `\(remote!.rawValue)`, which DevHub cannot read as a github.com repository, so it cannot tell whose issue this is."
            )
        }
        return .branch(BranchReference(
            owner: item.owner,
            repository: item.repository,
            headOwner: head.owner,
            branch: branch,
            // The name on the remote when git knows one, and the local name
            // when it does not: what it will be called the first time somebody
            // pushes it.
            remoteBranch: pushBranch ?? branch,
            issueNumber: number
        ))
    }
}

/// Every open Workspace's repository, watched and published.
public actor RepositoryStatusWatcher {
    /// One workspace, as far as the local half of the round could get.
    struct LocalReading: Sendable {
        var workspace: WatchedWorkspace
        var branch: String?
        var unborn: Bool?
        var mainWorktree: String?
        var worktree: String?
        /// `origin`, kept so the fast clock can re-key a new branch without git.
        var remote: RemoteIdentity?
        var upstream: RemoteIdentity?
        var dirty: Bool?
        var ahead: Int?
        var pushBranch: String?
        var defaultBranch: String?
        var repositoryUrl: String?
        /// What GitHub is asked about, when there is a GitHub repository to ask.
        var reference: BranchReference?
        /// The Issue the branch named, when it named one nothing could be read for.
        var number: Int?
        /// Why this row cannot answer yet, when the local half already knows.
        var reason: String?

        init(workspace: WatchedWorkspace) { self.workspace = workspace }

        mutating func apply(_ reading: RepositoryStatusRules.BranchReading) {
            reference = nil
            number = nil
            switch reading {
            case .none: break
            case .branch(let found): reference = found
            case .unresolved(let issue, let why):
                number = issue
                reason = why
            }
        }
    }

    /// The two clocks one machine's checkouts are polled on.
    struct Clocks {
        let runtime: RepositoryRuntime
        let slow: Task<Void, Never>
        let fast: Task<Void, Never>
    }

    private let deps: RepositoryStatusDeps
    private var clocks: [String: Clocks] = [:]
    /// The machines with a round in flight, so a slow link never stacks them.
    private var inFlight: Set<String> = []
    private var sequence = 0
    /// What was being watched when the last look was started.
    private var watching: String?
    /// The last answer for each branch, kept so a failed round shows something.
    private var known: [String: BranchStatus] = [:]
    /// The last local reading for each workspace, by workspace id.
    private var readings: [String: LocalReading] = [:]
    /// Why each branch could not be read, by branch.
    private var unreadable: [String: String] = [:]
    /// The last round's note, per machine, in the order machines first spoke.
    private var diagnostics: [String: String?] = [:]
    private var diagnosticOrder: [String] = []
    /// git, as each machine's last round resolved it, by machine.
    private var commands: [String: GitCommand] = [:]
    /// When each machine's last full round finished.
    private var lastRoundAt: [String: Double] = [:]
    /// Each Workspace's last full round, by workspace id, for `--metrics`.
    private var lastRound: [String: (at: Double, trigger: RepositoryRoundTrigger)] = [:]
    private var lastRoundOrder: [String] = []
    private var heads: HeadWatching?
    private var stopped = false

    public init(deps: RepositoryStatusDeps) {
        self.deps = deps
    }

    private func headWatcher() -> HeadWatching {
        if let heads { return heads }
        let made = deps.makeHeadWatcher { [weak self] in
            guard let self else { return }
            Task { await self.refreshBranches() }
        }
        heads = made
        return made
    }

    public func start() {
        stopped = false
        _ = headWatcher()
        follow()
    }

    public func stop() {
        stopped = true
        heads?.stop()
        for id in Array(clocks.keys) { unfollow(id) }
    }

    /// Run a pair of clocks for exactly the machines that have Workspaces on
    /// them — the only place a clock is started or stopped. A machine that has
    /// just gained its first Workspace is polled at once.
    private func follow() {
        if stopped { return }
        var wanted: [String: RepositoryRuntime] = [:]
        var order: [String] = []
        for workspace in deps.workspaces() {
            if wanted[workspace.runtime.id] == nil { order.append(workspace.runtime.id) }
            wanted[workspace.runtime.id] = workspace.runtime
        }
        for id in Array(clocks.keys) where wanted[id] == nil { unfollow(id) }
        for id in order {
            guard let runtime = wanted[id], clocks[id] == nil else { continue }
            let interval = runtime.cadence.repositoryPollMs
            let clock = deps.clock
            let slow = Task { [weak self] in
                while !Task.isCancelled {
                    do { try await clock.sleep(milliseconds: interval) } catch { return }
                    guard let self else { return }
                    await self.spawnRefresh(runtime, .poll)
                }
            }
            // The fast clock: which branch is checked out changes while
            // somebody watches. The safety net, not the mechanism — `heads` is
            // what makes a checkout appear at once.
            let fast = Task { [weak self] in
                while !Task.isCancelled {
                    do { try await clock.sleep(milliseconds: interval) } catch { return }
                    guard let self else { return }
                    await self.spawnBranchRound()
                }
            }
            clocks[id] = Clocks(runtime: runtime, slow: slow, fast: fast)
            spawnRefresh(runtime, .poll)
        }
    }

    private func unfollow(_ id: String) {
        guard let pair = clocks[id] else { return }
        pair.slow.cancel()
        pair.fast.cancel()
        clocks[id] = nil
        commands[id] = nil
        diagnostics[id] = nil
        diagnosticOrder.removeAll { $0 == id }
        // A machine nothing is open on any more has no round to have been
        // recent.
        lastRoundAt[id] = nil
    }

    private func spawnRefresh(_ runtime: RepositoryRuntime, _ trigger: RepositoryRoundTrigger) {
        Task { await self.refresh(runtime, trigger) }
    }

    private func spawnBranchRound() {
        Task { await self.refreshBranches() }
    }

    /// The set of workspaces may have moved: look again if it actually did.
    /// Comparing what is being watched is what keeps a poll a poll rather than
    /// something that runs git on every keystroke.
    public func observe() {
        let signature = deps.workspaces().map { "\($0.id)\u{0}\($0.runtime.id)" }.joined(separator: "\n")
        if signature == watching { return }
        watching = signature
        let existing = clocks.values.map(\.runtime)
        follow()
        for runtime in existing { spawnRefresh(runtime, .poll) }
    }

    /// Look now, because somebody asked: the same round the slow clock runs.
    public func look() {
        for pair in clocks.values { spawnRefresh(pair.runtime, .manual) }
    }

    /// The window has come back to the front: look, unless one just looked.
    /// Rate-limited per machine, because focus is not a request; a host that
    /// is not answering is left to its poll.
    public func focused() {
        let now = deps.clock.now()
        for pair in clocks.values {
            let runtime = pair.runtime
            if !runtime.isConnected { continue }
            if let last = lastRoundAt[runtime.id], now - last < Double(runtime.cadence.repositoryFocusRefreshMinIntervalMs) { continue }
            spawnRefresh(runtime, .focus)
        }
    }

    /// Each Workspace's last full round, for `devhub --metrics`.
    public func rounds() -> [WorkspaceRepositoryRound] {
        lastRoundOrder.compactMap { id in
            guard let round = lastRound[id] else { return nil }
            return WorkspaceRepositoryRound(
                workspaceId: id,
                lastRepositoryRound: .init(at: Self.isoTime(round.at), trigger: round.trigger)
            )
        }
    }

    static func isoTime(_ ms: Double) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter.string(from: Date(timeIntervalSince1970: ms / 1000))
    }

    /// The Workspaces whose folder is on one machine, in row order.
    private func on(_ runtime: RepositoryRuntime) -> [WatchedWorkspace] {
        deps.workspaces().filter { $0.runtime.id == runtime.id }
    }

    /// One round, against one machine. Rounds never overlap *per machine*.
    func refresh(_ runtime: RepositoryRuntime, _ trigger: RepositoryRoundTrigger) async {
        if inFlight.contains(runtime.id) { return }
        inFlight.insert(runtime.id)
        defer { inFlight.remove(runtime.id) }
        let status = await read(runtime)
        deps.publish(status)
        // Stamped on the way out: what the focus rule means by "a round" is a
        // round that *answered*.
        let at = deps.clock.now()
        lastRoundAt[runtime.id] = at
        for workspace in on(runtime) {
            if lastRound[workspace.id] == nil { lastRoundOrder.append(workspace.id) }
            lastRound[workspace.id] = (at, trigger)
        }
    }

    /// What is checked out, re-read and published at once: one command per
    /// workspace and nothing else. Every branch that moved asks its machine
    /// for a full round, so a checkout drags the pull request, the Issue,
    /// dirty and ahead along with it.
    func refreshBranches() async {
        var moved = false
        var wantsLook: [String] = []
        await withTaskGroup(of: (String, String?, Bool)?.self) { group in
            for workspace in deps.workspaces() {
                guard let command = commands[workspace.runtime.id],
                      let entry = readings[workspace.id],
                      !inFlight.contains(workspace.runtime.id)
                else { continue }
                // A row that could not be read at all is the slow round's problem.
                if entry.reason != nil && entry.branch == nil { continue }
                let git = deps.git
                let root = entry.workspace.root
                let previous = entry.branch
                group.addTask {
                    let branch: String?
                    do { branch = try await git.readBranch(command, root) } catch { branch = previous }
                    return (workspace.id, branch, branch != previous)
                }
            }
            for await result in group {
                guard let (id, branch, changed) = result, changed, var entry = readings[id] else { continue }
                moved = true
                // The push name belongs to the branch that has just been left,
                // so it is dropped rather than carried onto the new one.
                let reading = RepositoryStatusRules.branchFromLocal(remote: entry.remote, upstream: entry.upstream, branch: branch, pushBranch: nil)
                if !wantsLook.contains(entry.workspace.runtime.id) { wantsLook.append(entry.workspace.runtime.id) }
                entry.branch = branch
                entry.pushBranch = nil
                entry.unborn = nil
                entry.reason = nil
                entry.apply(reading)
                readings[id] = entry
            }
        }
        if !moved { return }
        deps.publish(project())
        for id in wantsLook {
            if let pair = clocks[id] { spawnRefresh(pair.runtime, .head) }
        }
    }

    private func read(_ runtime: RepositoryRuntime) async -> RepositoryStatusWire {
        let workspaces = on(runtime)
        var diagnostic: String?

        var command: GitCommand?
        do {
            command = try await deps.gitCommand(runtime)
        } catch {
            diagnostic = CodedFailure.text(of: error)
        }
        if let command { commands[runtime.id] = command } else { commands[runtime.id] = nil }

        let resolved = command
        var local: [LocalReading] = []
        await withTaskGroup(of: (Int, LocalReading, String?).self) { group in
            for (index, workspace) in workspaces.enumerated() {
                let git = deps.git
                let blocked = diagnostic
                group.addTask {
                    var entry = LocalReading(workspace: workspace)
                    // No git at all: every row is blocked by the one thing.
                    guard let command = resolved else {
                        entry.reason = blocked
                        return (index, entry, nil)
                    }
                    let facts: RepositoryFacts?
                    do {
                        facts = try await git.readRepository(command, workspace.root)
                    } catch {
                        // `nil` is the one case that is not a failure; anything
                        // thrown is git refusing, and it is git's own last line.
                        let reason = "DevHub could not read this repository: \(CodedFailure.text(of: error))"
                        entry.reason = reason
                        return (index, entry, reason)
                    }
                    let reading = RepositoryStatusRules.branchFromLocal(remote: facts?.remote, upstream: facts?.upstream, branch: facts?.branch, pushBranch: facts?.pushBranch)
                    // Only where it can mean something.
                    if facts != nil {
                        entry.dirty = (try? await git.readDirty(command, workspace.root)) ?? nil
                        entry.ahead = (try? await git.readAhead(command, workspace.root)) ?? nil
                    }
                    entry.branch = facts?.branch
                    entry.unborn = facts?.unborn
                    entry.defaultBranch = facts?.defaultBranch
                    entry.mainWorktree = facts?.mainWorktree
                    entry.worktree = facts?.worktree
                    entry.remote = facts?.remote
                    entry.upstream = facts?.upstream
                    entry.pushBranch = facts?.pushBranch
                    entry.repositoryUrl = RepositoryStatusRules.repositoryUrl(facts?.remote)
                    entry.apply(reading)
                    return (index, entry, nil)
                }
            }
            var collected: [(Int, LocalReading, String?)] = []
            for await result in group { collected.append(result) }
            collected.sort { $0.0 < $1.0 }
            for (_, entry, reason) in collected {
                local.append(entry)
                // One workspace whose git is broken is usually every workspace
                // on that machine, and the note is where a person looks.
                if let reason, diagnostic == nil { diagnostic = reason }
            }
        }

        for entry in local { readings[entry.workspace.id] = entry }
        await armHeads()
        if diagnostic == nil { diagnostic = watchDiagnostic() }
        setDiagnostic(runtime.id, diagnostic)
        // The local half is done and costs nothing to show, so it is shown now
        // rather than after a round trip to GitHub.
        deps.publish(project())

        var wanted: [(String, BranchReference)] = []
        for entry in local {
            guard let reference = entry.reference else { continue }
            let key = RepositoryStatusRules.branchKey(reference)
            if let at = wanted.firstIndex(where: { $0.0 == key }) { wanted[at].1 = reference } else { wanted.append((key, reference)) }
        }

        if !wanted.isEmpty {
            // GitHub is asked from *this* machine, whichever machine the
            // checkout is on.
            let credentials = await deps.gitHub.readToken(environment: deps.environment)
            switch credentials {
            case .unrunnable(let reason):
                diagnostic = "DevHub could not run `gh` to get GitHub credentials: \(reason). Install the GitHub CLI, or point DevHub's PATH at it, to show issue and pull request status."
                for (key, _) in wanted { unreadable[key] = diagnostic }
            case .unauthenticated:
                diagnostic = "DevHub has no GitHub credentials. Run `gh auth login` to show issue and pull request status."
                for (key, _) in wanted { unreadable[key] = diagnostic }
            case .token(let token):
                for (index, (key, reference)) in wanted.enumerated() {
                    if index >= RepositoryStatusRules.maxBranchesPerRound {
                        unreadable[key] = "DevHub asks GitHub about \(RepositoryStatusRules.maxBranchesPerRound) branches a round; this one is in the next."
                        continue
                    }
                    do {
                        known[key] = try await deps.gitHub.readBranchStatus(reference, token: token)
                        unreadable[key] = nil
                    } catch let failure as CodedFailure where failure.isGitHubUnavailable {
                        diagnostic = failure.text
                        unreadable[key] = failure.text
                    } catch {
                        // Anything else is a bug in DevHub, said as itself
                        // rather than drawn as a status line.
                        diagnostic = CodedFailure.text(of: error)
                        unreadable[key] = CodedFailure.text(of: error)
                    }
                }
            }
        }

        // Reasons for branches nothing is on any more.
        let live = Set(readings.values.compactMap { $0.reference.map(RepositoryStatusRules.branchKey) })
        for key in Array(unreadable.keys) where !live.contains(key) { unreadable[key] = nil }
        setDiagnostic(runtime.id, diagnostic)
        return project()
    }

    private func setDiagnostic(_ id: String, _ value: String?) {
        if diagnostics.index(forKey: id) == nil { diagnosticOrder.append(id) }
        diagnostics[id] = .some(value)
    }

    /// Watch every checkout that is open, and nothing else: rooted at the
    /// checkout git reported rather than at the folder the workspace was opened
    /// at, on the machine its git ran on.
    private func armHeads() async {
        var repositories: [WatchedRepository] = []
        for workspace in deps.workspaces() {
            guard let entry = readings[workspace.id], let worktree = entry.worktree,
                  let command = commands[entry.workspace.runtime.id]
            else { continue }
            repositories.append(WatchedRepository(key: workspace.id, worktree: worktree, runtime: command.runtime))
        }
        await headWatcher().arm(repositories)
    }

    /// What to say when a checkout is only being polled: the fallback is safe,
    /// and saying nothing about it is what would make it dangerous.
    private func watchDiagnostic() -> String? {
        let failures = headWatcher().failures()
        guard let first = failures.first else { return nil }
        let rest = failures.count > 1 ? " (and \(failures.count - 1) more)" : ""
        return "DevHub could not watch \(first.worktree) for branch changes\(rest): \(first.reason). The branch there is re-read once a minute instead."
    }

    /// The rows, from everything currently known — one projection, whichever
    /// clock published it.
    private func project() -> RepositoryStatusWire {
        let open = deps.workspaces()
        let ids = Set(open.map(\.id))
        for id in Array(readings.keys) where !ids.contains(id) { readings[id] = nil }
        for id in Array(lastRound.keys) where !ids.contains(id) {
            lastRound[id] = nil
            lastRoundOrder.removeAll { $0 == id }
        }
        let projected: [WorkspaceRepositoryWire] = open.compactMap { workspace in
            guard let entry = readings[workspace.id] else { return nil }
            let key = entry.reference.map(RepositoryStatusRules.branchKey)
            let status = key.flatMap { known[$0] }
            let issueNumber = entry.reference?.issueNumber
            // What was last known outranks a look that failed. A reason the
            // local half found outranks anything GitHub could have said.
            // GitHub's is drawn only where the row was expecting an answer a
            // person can name: a branch that names an Issue.
            let remoteReason = key == nil || issueNumber == nil ? nil : unreadable[key!]
            let reason = status != nil ? nil : (entry.reason ?? remoteReason)
            let number = issueNumber ?? entry.number
            return WorkspaceRepositoryWire(
                workspaceId: entry.workspace.id,
                branch: entry.branch,
                unborn: entry.unborn,
                mainWorktree: entry.mainWorktree,
                worktree: entry.worktree,
                repositoryUrl: entry.repositoryUrl,
                issueRepository: RepositoryStatusRules.issueRepository(remote: entry.remote, upstream: entry.upstream),
                dirty: entry.dirty,
                ahead: entry.ahead,
                defaultBranch: entry.defaultBranch,
                // Only the Issue the branch names, never one that came with
                // some other answer.
                issue: status?.issue.flatMap { $0.number == issueNumber ? $0 : nil },
                pullRequest: status?.pullRequest,
                // Known which Issue, no answer yet, nothing wrong — only for a
                // branch that names an Issue.
                pending: status == nil && reason == nil && issueNumber != nil ? .init(number: issueNumber!) : nil,
                unavailable: reason.map { .init(number: number, reason: $0) }
            )
        }
        sequence += 1
        // The note carries only what no row carried, exactly once.
        let note = diagnosticOrder.compactMap { diagnostics[$0] ?? nil }.first
        let shownOnARow = note.map { text in projected.contains { $0.unavailable?.reason == text } } ?? false
        return RepositoryStatusWire(sequence: sequence, workspaces: projected, diagnostic: shownOnARow ? nil : note)
    }
}

// Port of apps/desktop/src/main/shell/git.ts.
//
// The `git` DevHub runs, and what it is asked.
//
// One runner, so that every git DevHub starts is the same git — the one the
// runtimes were resolved to, in the environment the terminals and Agents get —
// and every refusal reads the way the clone sheet's already did: git's own last
// line, thrown with words the person can act on. A second spawn site would be a
// second `git` and a second way of failing.
//
// The knowledge about *where* things go is not here; it is in `Worktrees`,
// because the sheet has to show the person the same answer before anything is
// run.
//
// Cancellation: where the TS passes a `CancellationToken`, Swift cancels the
// task. A cancelled git is killed and `CancellationError` travels as itself, so
// whoever abandoned the git is the one that says what happened, once.

import Foundation

/// The git binary DevHub resolved, where it runs, and what it runs in.
public struct GitCommand: Sendable {
    /// The machine the repository is on. Part of the command rather than a
    /// parameter of every call, because it is the same fact as *which* `git`.
    public var runtime: RepositoryRuntime
    /// An absolute path, or a name looked up on `environment["PATH"]`.
    public var git: String
    public var environment: [String: String]

    public init(runtime: RepositoryRuntime, git: String, environment: [String: String]) {
        self.runtime = runtime
        self.git = git
        self.environment = environment
    }

    /// How long a git that talks to a network gets before DevHub stops waiting.
    public static let networkTimeoutMs = 10 * 60 * 1000
    /// How long a git that only reads the local repository gets.
    public static let localTimeoutMs = 30 * 1000

    /// How much of git's answer DevHub reads, and what a longer one is:
    /// truncation, not a refusal — the callers here read prefixes.
    static let limits = ExecLimits(stdoutBytes: 4 * 1024 * 1024, stderrBytes: 8 * 1024)

    /// Why DevHub locks the worktrees it creates.
    public static let worktreeLockReason = "devhub: keeps git worktree prune in a dev container from forgetting it"

    // MARK: Running

    /// Run git and answer with what it wrote, or throw what it complained
    /// about. Arguments are passed as a list and never through a shell, so a
    /// branch name with a space, a quote or a semicolon in it is a branch name.
    @discardableResult
    public func run(_ args: [String], cwd: String? = nil, timeoutMs: Int? = nil) async throws -> String {
        let timeout = timeoutMs ?? Self.localTimeoutMs
        let answer: ExecAnswer
        do {
            answer = try await runtime.exec(
                argv: [git] + args,
                cwd: cwd,
                environment: environment,
                timeoutMs: timeout,
                limits: Self.limits
            )
        } catch let failure as ExecFailure {
            throw Self.didNotAnswer(failure, args: args, timeoutMs: timeout)
        }
        if answer.code == 0 { return answer.stdoutText }
        // git says why on stderr and DevHub has nothing to add: passing its own
        // last line through is the difference between "it failed" and
        // "Repository not found", and only one of those can be acted on.
        let said = answer.stderrText.jsTrimmed.split(separator: "\n", omittingEmptySubsequences: false).last.map { String($0).jsTrimmed }
        if let said, !said.isEmpty { throw CodedFailure.workspace(said) }
        if let signal = answer.signal {
            throw CodedFailure.workspace("git \(args.first ?? "") was stopped (\(signal)).")
        }
        throw CodedFailure.workspace("git \(args.first ?? "") failed (exit \(answer.code.map(String.init) ?? "unknown")).")
    }

    /// git did not get as far as an answer, in words that say which way.
    static func didNotAnswer(_ failure: ExecFailure, args: [String], timeoutMs: Int) -> CodedFailure {
        switch failure {
        case .timedOut:
            return .workspace("git \(args.first ?? "") did not answer in \(Int((Double(timeoutMs) / 1000).rounded()))s.")
        case .unavailable(let reason):
            // The system's own complaint — "spawn git ENOENT" — which is
            // exactly what names the fix.
            return .workspace(reason)
        }
    }

    private static let notARepository = TextPattern("not a git repository|does not exist|No such file", options: [.caseInsensitive])

    /// A question about a directory that may not be a repository at all.
    ///
    /// Not being one is an ordinary answer here — the workspace picker's
    /// candidates are folders — so it comes back as `nil` rather than as a
    /// failure. Every *other* way git can fail still throws, because "the
    /// repository is broken" and "this is not a repository" are different
    /// facts and only one of them is boring.
    func ask(_ args: [String], in directory: String) async throws -> String? {
        do {
            return try await run(args, cwd: directory).jsTrimmed
        } catch let failure as CodedFailure {
            if Self.notARepository.matches(failure.text) { return nil }
            throw failure
        }
    }

    /// `ask`, with every failure but cancellation read as no answer.
    func quietly(_ args: [String], in directory: String) async throws -> String? {
        do {
            return try await ask(args, in: directory)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            return nil
        }
    }

    // MARK: Small questions

    /// Just the branch, in one command: the cheap half of `readRepository`,
    /// split out because it is the half that *changes*.
    ///
    /// `branch --show-current` and not `rev-parse --abbrev-ref HEAD`, because
    /// the two disagree on exactly the checkout this is asked about most often
    /// after a clone: one with no commits yet. `nil` means no branch to report,
    /// either because this is not a repository or because the head is detached.
    public func readBranch(_ directory: String) async throws -> String? {
        let branch = try await ask(["branch", "--show-current"], in: directory)
        guard let branch, !branch.isEmpty else { return nil }
        return branch
    }

    /// Is there work here that removing this folder would destroy?
    ///
    /// Untracked files included, because an untracked file is work too. `nil`
    /// means DevHub could not tell — git would not answer — which is
    /// deliberately different from "clean". Nothing destructive is offered on
    /// a maybe.
    public func readDirty(_ directory: String) async throws -> Bool? {
        guard let status = try await quietly(["status", "--porcelain"], in: directory) else { return nil }
        return !status.isEmpty
    }

    /// How many commits are here that the branch's upstream does not have:
    /// `0` for a branch level with what it tracks, `nil` for a branch with
    /// nothing to compare against.
    public func readAhead(_ directory: String) async throws -> Int? {
        guard let count = try await quietly(["rev-list", "--count", "@{u}..HEAD"], in: directory) else { return nil }
        return Self.parseLeadingInt(count)
    }

    /// `Number.parseInt(text, 10)`: leading digits, or `nil`.
    static func parseLeadingInt(_ text: String) -> Int? {
        let trimmed = text.jsTrimmed
        var digits = ""
        var rest = Substring(trimmed)
        var sign = ""
        if let first = rest.first, first == "-" || first == "+" { sign = first == "-" ? "-" : ""; rest = rest.dropFirst() }
        for character in rest {
            guard character.isASCII, character.isNumber else { break }
            digits.append(character)
        }
        return digits.isEmpty ? nil : Int(sign + digits)
    }

    // MARK: Worktree records

    /// Remove a worktree. Let git refuse, unless the person has already been
    /// asked (`force`). git's refusal is the last check standing between
    /// somebody and work they cannot get back.
    public func removeWorktree(mainWorktree: String, worktree: String, force: Bool) async throws {
        try await run(["worktree", "remove"] + (force ? ["--force"] : []) + [worktree], cwd: mainWorktree)
    }

    /// Unlock a worktree DevHub locked, before it is removed or pruned. Never a
    /// failure: a worktree that is not locked (or not there) is what is wanted.
    public func unlockWorktree(mainWorktree: String, worktree: String) async throws {
        do {
            try await run(["worktree", "unlock", worktree], cwd: mainWorktree)
        } catch is CancellationError {
            throw CancellationError()
        } catch {}
    }

    /// Forget worktrees whose folders are not there any more: the idempotent
    /// half of removing one.
    public func pruneWorktrees(mainWorktree: String) async throws {
        try await run(["worktree", "prune"], cwd: mainWorktree)
    }

    // MARK: The repository

    /// Read the repository a directory belongs to, or nothing when it is a
    /// plain folder.
    public func readRepository(_ directory: String) async throws -> RepositoryFacts? {
        guard let worktrees = try await ask(["worktree", "list", "--porcelain"], in: directory) else { return nil }
        // The first record is always the main worktree, which is the one every
        // worktree path in DevHub is measured from.
        let records = GitParsing.worktrees(worktrees)
        guard let mainWorktree = records.first?.path else { return nil }
        // Which record describes the directory that was asked about — whether
        // *that* checkout has a commit is the question.
        let here = records.first(where: { $0.path == directory }) ?? records.first
        let unborn = here?.unborn ?? false

        // Where this checkout starts, which is not where DevHub was asked to
        // look: the workspace may be any directory inside it.
        guard let worktree = try await ask(["rev-parse", "--show-toplevel"], in: directory) else { return nil }

        // `rev-parse HEAD` is a question about a commit, and a checkout with no
        // commits answers it with a fatal. `git worktree list` already named
        // the branch that is checked out there.
        let branch: String? = unborn
            ? here?.branch
            : try await ask(["rev-parse", "--abbrev-ref", "HEAD"], in: directory)
        let remote = try await remoteNamed("origin", in: directory)
        let upstream = try await remoteNamed("upstream", in: directory)
        // `origin/main`, trimmed to `main`. A clone that has never been told
        // what `origin`'s HEAD is answers nothing, which is not the same as
        // `main`.
        let head = try await quietly(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], in: directory)
        let defaultBranch = head.flatMap { $0.hasPrefix("origin/") ? String($0.dropFirst("origin/".count)) : nil }
        let checkedOut = branch == nil || branch == "HEAD" ? nil : branch
        var pushBranch: String?
        if let checkedOut {
            pushBranch = try await remoteBranchOf(checkedOut, trunk: defaultBranch, in: directory)
        }
        return RepositoryFacts(
            mainWorktree: mainWorktree,
            worktree: worktree,
            branch: checkedOut,
            unborn: unborn,
            pushBranch: pushBranch,
            remote: remote,
            defaultBranch: defaultBranch,
            upstream: upstream
        )
    }

    /// What a branch is called on the remote, or nothing when it has no remote
    /// at all: the push destination when there is one, else an upstream that
    /// can be the branch's own head. See `RepositoryFacts.pushBranch`.
    func remoteBranchOf(_ branch: String, trunk: String?, in directory: String) async throws -> String? {
        guard let line = try await quietly(
            [
                "for-each-ref",
                "--format=%(push:remotename)%09%(push)%09%(upstream:remotename)%09%(upstream)",
                "refs/heads/\(branch)",
            ],
            in: directory
        ) else { return nil }
        let fields = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
        func field(_ index: Int) -> String? { index < fields.count ? fields[index] : nil }
        if let pushed = GitParsing.trimRemote(field(0), field(1)) {
            return GitParsing.ownHead(branch: branch, remoteName: pushed, trunk: trunk)
        }
        // The upstream stands in for the push destination only where it can be
        // the branch's own head: a branch of `origin` that is not `origin`'s
        // trunk. A branch started from `origin/main` tracks the trunk it came
        // from, and reading the upstream answered `main` for it.
        let tracked = GitParsing.trimRemote(field(2), field(3))
        guard field(2) == "origin", let tracked else { return nil }
        return GitParsing.ownHead(branch: branch, remoteName: tracked, trunk: trunk)
    }

    /// One named remote, normalised, or nothing when the clone has no such
    /// remote — or one DevHub cannot normalise, which it cannot match against
    /// anything either.
    func remoteNamed(_ name: String, in directory: String) async throws -> RemoteIdentity? {
        guard let url = try await quietly(["remote", "get-url", name], in: directory), !url.isEmpty else { return nil }
        return RemoteIdentity.normalize(url)
    }

    // MARK: Branches

    /// Every branch a person could pick: local ones and whatever `origin` has
    /// that is not local yet, each named once.
    public func listBranches(_ directory: String) async throws -> [String] {
        let output = try await run(["branch", "-a", "--format=%(refname:short)"], cwd: directory)
        var seen = Set<String>()
        return output.split(separator: "\n", omittingEmptySubsequences: false)
            .map { String($0).jsTrimmed }
            .filter { !$0.isEmpty && !$0.hasSuffix("HEAD") }
            .map { $0.hasPrefix("origin/") ? String($0.dropFirst("origin/".count)) : $0 }
            .filter { seen.insert($0).inserted }
    }

    /// Where this clone can see the branch, or nothing when it cannot see it at
    /// all. Every remote is looked at rather than `origin` alone: a pull request
    /// from a fork has its branch on the fork.
    public func findBranch(_ branch: String, in directory: String) async throws -> BranchWhereabouts? {
        let local = "refs/heads/\(branch)"
        let refs = Set(
            try await run(["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"], cwd: directory)
                .split(separator: "\n", omittingEmptySubsequences: false)
                .map { String($0).jsTrimmed }
                .filter { !$0.isEmpty }
        )
        if refs.contains(local) { return BranchWhereabouts(kind: .local, ref: local) }
        for remote in try await remoteNames(directory) {
            let ref = "refs/remotes/\(remote)/\(branch)"
            if refs.contains(ref) { return BranchWhereabouts(kind: .remote, ref: ref) }
        }
        return nil
    }

    /// The remotes this clone has, in git's order.
    func remoteNames(_ directory: String) async throws -> [String] {
        let output = try await quietly(["remote"], in: directory)
        return (output ?? "").split(separator: "\n", omittingEmptySubsequences: false)
            .map { String($0).jsTrimmed }
            .filter { !$0.isEmpty }
    }

    /// The remote that is one owner's copy of the repository, if the clone has
    /// one. Nothing is added here — a flow that assigns work is not the place
    /// to change somebody's remotes.
    public func remoteForRepository(owner: String, repository: String, in directory: String) async throws -> String? {
        let wanted = RemoteIdentity.normalize("https://github.com/\(owner)/\(repository).git")
        for name in try await remoteNames(directory) {
            if let found = try await remoteNamed(name, in: directory), found == wanted { return name }
        }
        return nil
    }

    /// Where a branch is already checked out, when it is. The repository root
    /// counts: git gives one branch one folder.
    public func worktreeForBranch(_ branch: String, in directory: String) async throws -> String? {
        let records = GitParsing.worktrees(try await run(["worktree", "list", "--porcelain"], cwd: directory))
        return records.first(where: { $0.branch == branch })?.path
    }

    /// Bring one branch here from a remote, for a question rather than for
    /// work. Best effort: a network that is down is not an answer to "which
    /// branch?".
    public func fetchBranch(from remote: String, branch: String, in directory: String) async throws {
        do {
            try await run(["fetch", remote, branch], cwd: directory, timeoutMs: Self.networkTimeoutMs)
        } catch is CancellationError {
            throw CancellationError()
        } catch {}
    }

    /// Bring `origin` up to date, for a question rather than for work.
    public func refreshOrigin(_ directory: String) async throws {
        _ = try await fetchOrigin(directory, options: WorktreeOptions(allowStaleBase: true))
    }

    // MARK: Worktrees for work

    /// The worktree for a piece of work's branch, made if it is not there yet.
    ///
    /// Where the branch already is decides first: git's record of which
    /// worktree holds which branch is the answer to "is this work checked out",
    /// whatever the folder is called. Only a branch that is checked out nowhere
    /// gets a new worktree, and that one goes where `Worktrees.directory` says.
    ///
    /// A directory already at that name is never written into. A branch that
    /// exists locally or on a remote is checked out rather than forked; one that
    /// does not exist yet starts from the remote's default branch (`baseRef`).
    public func ensureWorktree(_ directory: String, work: WorkItem, branch: String, options: WorktreeOptions = WorktreeOptions()) async throws -> String {
        // A pull request's branch is work that exists already: the remote is
        // fetched *before* the branch is looked for, and a name that is still
        // nowhere afterwards is a failure rather than a branch to create.
        let branchExistsAlready = work.kind == .pull
        let name = branch.jsTrimmed
        if name.isEmpty { throw CodedFailure.workspace("Enter a branch name.") }
        guard let repository = try await readRepository(directory) else {
            throw CodedFailure.workspace("\(directory) is not a Git repository.")
        }
        // A worktree is a second checkout of a commit, and this repository has
        // no commit to check out.
        if repository.unborn {
            throw CodedFailure.workspace("\(Self.repositoryName(repository.mainWorktree)) has no commits yet, so there is nothing for a worktree to check out. Make the first commit and push it, then try again.")
        }

        let worktrees = GitParsing.worktrees(try await run(["worktree", "list", "--porcelain"], cwd: directory))
        if let existing = worktrees.first(where: { $0.branch == name }) { return existing.path }

        // Somebody else's branch: bring it here before asking whether it is
        // here.
        if branchExistsAlready { _ = try await fetchOrigin(directory, options: options) }

        let target = Worktrees.directory(mainWorktree: repository.mainWorktree, work: work, branch: name)
        if let occupant = worktrees.first(where: { $0.path == target }) {
            throw CodedFailure.workspace("\(target) is already the worktree of \(occupant.branch ?? "a detached HEAD"), not of \(name). Remove that worktree, or check \(name) out in it yourself, then try again.")
        }
        if try runtime.stat(target) != .absent {
            throw CodedFailure.workspace("\(target) already exists and is not a worktree for \(name).")
        }

        let here = try await findBranch(name, in: directory)
        if branchExistsAlready && here == nil {
            throw CodedFailure.workspace("\(name) is on neither this machine nor any remote this clone has. A pull request from a fork has its branch on the fork.")
        }
        let add = try await worktreeAddArguments()
        let args: [String]
        if let here {
            // Started from the remote-tracking ref by name: a branch of the same
            // name on a second remote must not be able to decide this.
            args = here.kind == .local ? add + [target, name] : add + ["-b", name, target, here.ref]
        } else {
            // A new branch does not track the trunk it starts from: that is
            // where it came from, not where it goes.
            args = add + ["--no-track", "-b", name, target, try await baseRef(directory, options: options)]
        }
        // Checking out a branch that only exists on `origin` fetches it.
        try await run(args, cwd: directory, timeoutMs: Self.networkTimeoutMs)
        // Locked, so a `git worktree prune` run inside its dev container cannot
        // forget it. A git that cannot lock leaves it unlocked, as before.
        do {
            try await run(["worktree", "lock", "--reason", Self.worktreeLockReason, target], cwd: directory)
        } catch is CancellationError {
            throw CancellationError()
        } catch {}
        return target
    }

    /// Check a branch out in the repository's own folder rather than in a
    /// worktree, starting it from the remote's default branch when it does not
    /// exist yet. A root with uncommitted changes is refused; so is a branch
    /// already checked out in another worktree.
    public func switchRootBranch(_ directory: String, work: WorkItem, branch: String, options: WorktreeOptions = WorktreeOptions()) async throws -> String {
        let name = branch.jsTrimmed
        if name.isEmpty { throw CodedFailure.workspace("Enter a branch name.") }
        guard let repository = try await readRepository(directory) else {
            throw CodedFailure.workspace("\(directory) is not a Git repository.")
        }
        if repository.unborn {
            throw CodedFailure.workspace("\(Self.repositoryName(repository.mainWorktree)) has no commits yet. Make the first commit and push it, then try again.")
        }
        let root = repository.mainWorktree
        let current = try await run(["branch", "--show-current"], cwd: root).jsTrimmed
        if current == name { return root }
        if let holder = try await worktreeForBranch(name, in: root) {
            throw CodedFailure.workspace("\(name) is already checked out in \(holder). Open that folder instead.")
        }
        if try await readDirty(root) != false {
            throw CodedFailure.workspace("\(Self.repositoryName(root)) has uncommitted changes. Commit or stash them, or open the branch as a worktree instead.")
        }
        let pull = work.kind == .pull
        if pull { _ = try await fetchOrigin(root, options: options) }
        let here = try await findBranch(name, in: root)
        if pull && here == nil {
            throw CodedFailure.workspace("\(name) is on neither this machine nor any remote this clone has. A pull request from a fork has its branch on the fork.")
        }
        let args: [String]
        if let here {
            args = here.kind == .local ? ["switch", name] : ["switch", "-c", name, here.ref]
        } else {
            args = ["switch", "--no-track", "-c", name, try await baseRef(root, options: options)]
        }
        try await run(args, cwd: root, timeoutMs: Self.networkTimeoutMs)
        return root
    }

    /// `git worktree add`, with `--relative-paths` when this git understands
    /// it (git >= 2.48), so the worktree's `.git` and the record's back-pointer
    /// keep working wherever the two folders are mounted side by side.
    func worktreeAddArguments() async throws -> [String] {
        try await supportsRelativeWorktrees() ? ["worktree", "add", "--relative-paths"] : ["worktree", "add"]
    }

    /// Whether `git worktree add --relative-paths` exists here (git >= 2.48).
    public func supportsRelativeWorktrees() async throws -> Bool {
        let version: String
        do {
            version = try await run(["--version"])
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            version = ""
        }
        return GitParsing.versionAtLeast(version, major: 2, minor: 48)
    }

    /// Where a new branch starts: the remote's default branch, brought up to
    /// date. Not the branch that happens to be checked out — work on an Issue
    /// starts from what everyone else is starting from.
    ///
    /// The fetch happens every time, and a fetch that fails is not worked
    /// around quietly: it stops the worktree and is reported with git's own
    /// reason, unless the person has said to go on from the copy on disk.
    func baseRef(_ directory: String, options: WorktreeOptions) async throws -> String {
        let hasOrigin = try await quietly(["remote", "get-url", "origin"], in: directory) != nil
        if hasOrigin {
            let fetched = try await fetchOrigin(directory, options: options)
            var head = ""
            do {
                head = try await run(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd: directory).jsTrimmed
            } catch is CancellationError {
                throw CancellationError()
            } catch {}
            if !head.isEmpty { return head }
            // A clone made with `--single-branch`, or one whose `origin/HEAD`
            // was never set, has to be asked directly — not attempted at all
            // when the network has just been shown not to work.
            if fetched {
                let shown = try await run(["remote", "show", "origin"], cwd: directory, timeoutMs: Self.networkTimeoutMs)
                let named = TextPattern("^\\s*HEAD branch:\\s*(\\S+)\\s*$", options: [.anchorsMatchLines]).firstMatch(in: shown)?[1]
                if let named, named != "(unknown)" { return "origin/\(named)" }
            }
        }
        if let local = try await readRepository(directory), let branch = local.branch { return branch }
        throw CodedFailure.workspace("DevHub could not tell which branch a new branch should start from: this repository has no origin and no branch checked out.")
    }

    /// Bring `origin` up to date, or say why not. A repository with no
    /// `origin` has nothing to fetch and nothing to report (`false`).
    func fetchOrigin(_ directory: String, options: WorktreeOptions) async throws -> Bool {
        let hasOrigin = try await quietly(["remote", "get-url", "origin"], in: directory) != nil
        if !hasOrigin { return false }
        do {
            try await run(["fetch", "origin"], cwd: directory, timeoutMs: Self.networkTimeoutMs)
            return true
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            // Not swallowed: without leave to go on, this is the answer, and
            // the person is told what git said and asked what to do about it.
            if !options.allowStaleBase { throw CodedFailure.fetch(failureText(error)) }
            return false
        }
    }

    /// The name a repository's directory carries, for a label or a search.
    public static func repositoryName(_ root: String) -> String { Worktrees.baseName(root) }
}

/// What DevHub knows about the repository a workspace sits in.
public struct RepositoryFacts: Equatable, Sendable {
    /// The main worktree, whichever worktree was asked.
    public var mainWorktree: String
    /// The root of the checkout the directory is *in*: the same as
    /// `mainWorktree` for the repository itself, a different path for one of
    /// its worktrees, and neither the asked-for directory when that is a
    /// subdirectory.
    public var worktree: String
    /// The branch checked out here, or nothing when the head is detached.
    public var branch: String?
    /// The checkout has no commits yet (a clone of an empty repository).
    public var unborn: Bool
    /// What this branch is called on the remote it is pushed to: `%(push)`
    /// first, then an `origin` upstream that is not the trunk, and only when
    /// it can be this branch's own head (`GitParsing.ownHead`).
    public var pushBranch: String?
    /// `origin`, normalised so an HTTPS and an SSH clone compare equal.
    public var remote: RemoteIdentity?
    /// What `origin` says its default branch is, when the clone knows.
    public var defaultBranch: String?
    /// `upstream`, when the clone has one — the repository this one was forked
    /// from, where Issues and pull requests are numbered in a fork.
    public var upstream: RemoteIdentity?

    public init(
        mainWorktree: String,
        worktree: String,
        branch: String?,
        unborn: Bool = false,
        pushBranch: String? = nil,
        remote: RemoteIdentity? = nil,
        defaultBranch: String? = nil,
        upstream: RemoteIdentity? = nil
    ) {
        self.mainWorktree = mainWorktree
        self.worktree = worktree
        self.branch = branch
        self.unborn = unborn
        self.pushBranch = pushBranch
        self.remote = remote
        self.defaultBranch = defaultBranch
        self.upstream = upstream
    }
}

public struct WorktreeRecord: Equatable, Sendable {
    public var path: String
    /// The branch checked out in it, short form, or nothing when detached.
    public var branch: String?
    /// The branch is checked out but has no commit yet: git lists the worktree
    /// with an all-zero `HEAD` and names the branch anyway.
    public var unborn: Bool

    public init(path: String, branch: String?, unborn: Bool) {
        self.path = path
        self.branch = branch
        self.unborn = unborn
    }
}

/// Where a branch is, in the one form a `worktree add` can be given.
public struct BranchWhereabouts: Equatable, Sendable {
    public enum Kind: String, Sendable { case local, remote }
    public var kind: Kind
    /// `refs/heads/x`, or `refs/remotes/fork/x`.
    public var ref: String

    public init(kind: Kind, ref: String) {
        self.kind = kind
        self.ref = ref
    }
}

public struct WorktreeOptions: Equatable, Sendable {
    /// Go ahead from the `origin` already on disk when the fetch fails. Set
    /// only when the person has been shown the reason and said to carry on.
    public var allowStaleBase: Bool

    public init(allowStaleBase: Bool = false) { self.allowStaleBase = allowStaleBase }
}

/// What an Issue's branch question offers, given where its branch was found.
public struct IssueBranchPlan: Equatable, Sendable {
    public var branch: String?
    public var reachable: Bool
    public var checkedOutAt: String?

    public init(branch: String? = nil, reachable: Bool, checkedOutAt: String? = nil) {
        self.branch = branch
        self.reachable = reachable
        self.checkedOutAt = checkedOutAt
    }

    /// A branch that is neither here, on a remote, nor checked out is dropped,
    /// so the Issue reads as not started and its new branch is made from the
    /// default branch (`issueBranchPlan`).
    public var offered: IssueBranchPlan {
        reachable || checkedOutAt != nil ? self : IssueBranchPlan(reachable: false)
    }
}

/// The parsers and string rules of git.ts.
public enum GitParsing {
    /// git's stand-in for "no commit", which is what an unborn HEAD lists as.
    static let noCommit = String(repeating: "0", count: 40)

    /// `git worktree list --porcelain`, as records.
    public static func worktrees(_ output: String) -> [WorktreeRecord] {
        var records: [WorktreeRecord] = []
        var path: String?
        var branch: String?
        var unborn = false
        func flush() {
            if let path { records.append(WorktreeRecord(path: path, branch: branch, unborn: unborn)) }
            path = nil
            branch = nil
            unborn = false
        }
        for line in output.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            if line.hasPrefix("worktree ") {
                flush()
                path = String(line.dropFirst("worktree ".count)).jsTrimmed
            } else if line.hasPrefix("HEAD ") {
                unborn = String(line.dropFirst("HEAD ".count)).jsTrimmed == noCommit
            } else if line.hasPrefix("branch ") {
                var name = String(line.dropFirst("branch ".count)).jsTrimmed
                if name.hasPrefix("refs/heads/") { name.removeFirst("refs/heads/".count) }
                branch = name
            }
        }
        flush()
        return records
    }

    /// `refs/remotes/origin/release-2` under `origin`, as `release-2`. A ref
    /// that does not start with its own remote is git telling us something we
    /// do not understand.
    static func trimRemote(_ remote: String?, _ ref: String?) -> String? {
        guard let remote, !remote.isEmpty, let ref, !ref.isEmpty else { return nil }
        let prefix = "refs/remotes/\(remote)/"
        guard ref.hasPrefix(prefix) else { return nil }
        let name = String(ref.dropFirst(prefix.count))
        return name.isEmpty ? nil : name
    }

    /// A remote name, kept only when it can be this branch's own head: not the
    /// trunk (for a branch that is not the trunk), and not a branch that names
    /// a different Issue. Either way the local name stands in.
    static func ownHead(branch: String, remoteName: String, trunk: String?) -> String? {
        if remoteName == branch { return remoteName }
        if remoteName == trunk { return nil }
        let mine = GitHubBranchNaming.issueNumber(fromBranch: branch)
        if let theirs = GitHubBranchNaming.issueNumber(fromBranch: remoteName), theirs != mine { return nil }
        return remoteName
    }

    /// Whether `git --version`'s answer is at least `major.minor`, read
    /// loosely because vendors decorate it; an unreadable answer is too old.
    public static func versionAtLeast(_ answer: String, major: Int, minor: Int) -> Bool {
        guard let found = TextPattern("([0-9]+)\\.([0-9]+)").firstMatch(in: answer),
              let have = found[1].flatMap({ Int($0) }), let haveMinor = found[2].flatMap({ Int($0) })
        else { return false }
        return have > major || (have == major && haveMinor >= minor)
    }
}

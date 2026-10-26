// Port of apps/desktop/src/main/shell/repositoryStatus.test.ts.
//
// The whole of the link is the branch that is checked out, every round. And
// the branch is the whole of the *remote* question too: GitHub is asked what is
// out from this branch, so a workspace on a branch that names no Issue can
// still have a pull request, and a merged or closed one is still something the
// row can say.
//
// git, GitHub and the HEAD watcher are stand-ins here (their own tests run the
// real things); the clocks run on a manual clock where a case is about time.

import Foundation
import XCTest
@testable import DevHubCore

// MARK: - Stand-ins

/// Time a test moves by hand, the way vitest's fake timers do.
final class ManualRepositoryClock: RepositoryClock, @unchecked Sendable {
    private struct Sleeper {
        let id: Int
        let deadline: Double
        let continuation: CheckedContinuation<Void, Error>
    }

    private let lock = NSLock()
    private var current: Double
    private var sleepers: [Sleeper] = []
    private var nextId = 0

    init(start: Double = 1_790_000_000_000) { current = start }

    func now() -> Double { lock.lock(); defer { lock.unlock() }; return current }

    func sleep(milliseconds: Int) async throws {
        let id = allocate()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                lock.lock()
                if Task.isCancelled {
                    lock.unlock()
                    continuation.resume(throwing: CancellationError())
                    return
                }
                sleepers.append(Sleeper(id: id, deadline: current + Double(milliseconds), continuation: continuation))
                lock.unlock()
            }
        } onCancel: {
            lock.lock()
            let found = sleepers.firstIndex { $0.id == id }.map { sleepers.remove(at: $0) }
            lock.unlock()
            found?.continuation.resume(throwing: CancellationError())
        }
    }

    private func allocate() -> Int {
        lock.lock(); defer { lock.unlock() }
        nextId += 1
        return nextId
    }

    /// `vi.advanceTimersByTimeAsync(ms)`: every timer due on the way fires, in
    /// order, with the work it starts settled in between.
    func advance(by milliseconds: Double) async {
        await settle()
        let target = now() + milliseconds
        while let firing = takeDue(before: target) {
            for sleeper in firing { sleeper.continuation.resume() }
            await settle()
        }
        setNow(target)
        await settle()
    }

    /// The sleepers due first, with the clock moved to their deadline.
    private func takeDue(before target: Double) -> [Sleeper]? {
        lock.lock(); defer { lock.unlock() }
        guard let deadline = sleepers.filter({ $0.deadline <= target }).map(\.deadline).min() else { return nil }
        current = deadline
        let firing = sleepers.filter { $0.deadline == deadline }
        sleepers.removeAll { $0.deadline == deadline }
        return firing
    }

    private func setNow(_ value: Double) { lock.lock(); current = value; lock.unlock() }

    /// Long enough for every task the last step started to have run.
    func settle() async {
        for _ in 0..<25 {
            await Task.yield()
            try? await Task.sleep(nanoseconds: 400_000)
        }
    }

    func cancelAll() {
        lock.lock()
        let all = sleepers
        sleepers = []
        lock.unlock()
        for sleeper in all { sleeper.continuation.resume(throwing: CancellationError()) }
    }
}

/// A machine, as the watcher reads one: an id, a cadence, and whether it is
/// answering.
struct FakeMachine: RepositoryRuntime {
    var id: String
    var cadence: RepositoryCadence
    var isConnected: Bool

    init(_ id: String, repositoryPollMs: Int = RepositoryCadence.local.repositoryPollMs, connected: Bool = true) {
        self.id = id
        var cadence = RepositoryCadence.local
        cadence.repositoryPollMs = repositoryPollMs
        self.cadence = cadence
        self.isConnected = connected
    }

    struct NotHere: Error {}
    func exec(argv: [String], cwd: String?, environment: [String: String], timeoutMs: Int, limits: ExecLimits) async throws -> ExecAnswer { throw NotHere() }
    func stat(_ path: String) throws -> RuntimeFileKind { .absent }
    func readTextFile(_ path: String, maxBytes: Int) throws -> String { throw NotHere() }
    func makeDirectory(_ path: String) throws { throw NotHere() }
    func removeTree(_ path: String) throws { throw NotHere() }
    func watchGitDirectory(worktree: String, onChange: @escaping @Sendable () -> Void) async throws -> GitDirectoryWatch { throw NotHere() }
}

/// Answers that may hang until the case is over.
final class Hangs: @unchecked Sendable {
    private let lock = NSLock()
    private var waiting: [CheckedContinuation<Void, Never>] = []

    func hang() async {
        await withCheckedContinuation { continuation in
            lock.lock(); waiting.append(continuation); lock.unlock()
        }
    }

    func release() {
        lock.lock(); let all = waiting; waiting = []; lock.unlock()
        for continuation in all { continuation.resume() }
    }
}

/// git, answering what the case says is checked out.
final class ScriptedGit: RepositoryReading, @unchecked Sendable {
    private let lock = NSLock()
    var repository: @Sendable (GitCommand, String) async throws -> RepositoryFacts? = { _, _ in nil }
    var branch: @Sendable (GitCommand, String) async throws -> String? = { _, _ in nil }
    var dirty: @Sendable (GitCommand, String) async throws -> Bool? = { _, _ in false }
    var ahead: @Sendable (GitCommand, String) async throws -> Int? = { _, _ in 0 }
    private(set) var repositoryCalls: [(runtime: String, root: String)] = []
    private(set) var branchCalls = 0

    private func record(_ body: () -> Void) { lock.lock(); body(); lock.unlock() }

    func readRepository(_ command: GitCommand, _ root: String) async throws -> RepositoryFacts? {
        record { repositoryCalls.append((command.runtime.id, root)) }
        let answer = locked { repository }
        return try await answer(command, root)
    }

    func readBranch(_ command: GitCommand, _ root: String) async throws -> String? {
        record { branchCalls += 1 }
        let answer = locked { branch }
        return try await answer(command, root)
    }

    func readDirty(_ command: GitCommand, _ root: String) async throws -> Bool? {
        let answer = locked { dirty }
        return try await answer(command, root)
    }

    func readAhead(_ command: GitCommand, _ root: String) async throws -> Int? {
        let answer = locked { ahead }
        return try await answer(command, root)
    }

    func locked<T>(_ body: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return body() }

    var repositoryCallCount: Int { locked { repositoryCalls.count } }
    var branchCallCount: Int { locked { branchCalls } }

    /// What git says is checked out here.
    func checkedOut(_ name: String?, root: String = "/projects/widget") {
        let facts = RepositoryFacts(
            mainWorktree: "/projects/widget",
            worktree: "/projects/widget",
            branch: name,
            pushBranch: name,
            remote: RemoteIdentity(normalized: "github.com/example/widget")
        )
        lock.lock()
        repository = { _, _ in facts }
        branch = { _, _ in name }
        dirty = { _, _ in false }
        ahead = { _, _ in 0 }
        lock.unlock()
    }

    func answer(_ facts: RepositoryFacts?) {
        lock.lock()
        repository = { _, _ in facts }
        let name = facts?.branch
        branch = { _, _ in name }
        lock.unlock()
    }
}

/// GitHub, answering as the case says.
final class ScriptedGitHubAsking: GitHubAsking, @unchecked Sendable {
    private let lock = NSLock()
    var token: GitHubTokenResult = .token("token")
    var status: @Sendable (BranchReference) async throws -> BranchStatus = { reference in
        BranchStatus(issue: reference.issueNumber.map {
            IssueStatus(number: $0, title: "Issue \($0)", state: .open, url: "https://github.com/\(reference.owner)/\(reference.repository)/issues/\($0)")
        })
    }
    private(set) var asked: [BranchReference] = []
    private(set) var tokenReads = 0

    func locked<T>(_ body: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return body() }

    func readToken(environment: [String: String]) async -> GitHubTokenResult {
        locked { tokenReads += 1; return token }
    }

    func readBranchStatus(_ reference: BranchReference, token: String) async throws -> BranchStatus {
        let answer = locked { asked.append(reference); return status }
        return try await answer(reference)
    }

    var askedReferences: [BranchReference] { locked { asked } }
    func clear() { locked { asked = [] } }
}

final class FakeHeadWatcher: HeadWatching, @unchecked Sendable {
    let onChange: @Sendable () -> Void
    init(_ onChange: @escaping @Sendable () -> Void) { self.onChange = onChange }
    func arm(_ repositories: [WatchedRepository]) async {}
    func failures() -> [WatchFailure] { [] }
    func stop() {}
}

final class Published: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [RepositoryStatusWire] = []
    func append(_ status: RepositoryStatusWire) { lock.lock(); items.append(status); lock.unlock() }
    var all: [RepositoryStatusWire] { lock.lock(); defer { lock.unlock() }; return items }
    var count: Int { all.count }
    var last: RepositoryStatusWire? { all.last }
}

final class Box<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value
    init(_ value: Value) { stored = value }
    var value: Value {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); stored = newValue; lock.unlock() }
    }
}

// MARK: - The cases

final class RepositoryStatusTests: XCTestCase {
    private let here = FakeMachine("local")
    private let pollMs = Double(RepositoryCadence.local.repositoryPollMs)
    private let focusMinMs = Double(RepositoryCadence.local.repositoryFocusRefreshMinIntervalMs)
    private var git = ScriptedGit()
    private var gitHub = ScriptedGitHubAsking()
    private var hangs = Hangs()
    private var headChanged: Box<(@Sendable () -> Void)?> = Box(nil)
    private var running: [RepositoryStatusWatcher] = []
    private var clocks: [ManualRepositoryClock] = []

    private var workspace: WatchedWorkspace { WatchedWorkspace(id: "w-1", root: "/projects/widget", runtime: here) }

    override func setUp() {
        git = ScriptedGit()
        gitHub = ScriptedGitHubAsking()
        hangs = Hangs()
        headChanged = Box(nil)
    }

    override func tearDown() async throws {
        for watcher in running { await watcher.stop() }
        for clock in clocks { clock.cancelAll() }
        hangs.release()
        running = []
        clocks = []
    }

    private func watcher(
        _ published: Published,
        workspaces: @escaping @Sendable () -> [WatchedWorkspace],
        gitCommand: (@Sendable (RepositoryRuntime) async throws -> GitCommand)? = nil,
        clock: RepositoryClock = SystemRepositoryClock()
    ) -> RepositoryStatusWatcher {
        let changed = headChanged
        let made = RepositoryStatusWatcher(deps: RepositoryStatusDeps(
            gitCommand: gitCommand ?? { runtime in GitCommand(runtime: runtime, git: "git", environment: [:]) },
            environment: [:],
            workspaces: workspaces,
            publish: { published.append($0) },
            git: git,
            gitHub: gitHub,
            makeHeadWatcher: { onChange in
                changed.value = onChange
                return FakeHeadWatcher(onChange)
            },
            clock: clock
        ))
        running.append(made)
        return made
    }

    private func manualClock() -> ManualRepositoryClock {
        let clock = ManualRepositoryClock()
        clocks.append(clock)
        return clock
    }

    private func waitFor(_ what: String = "the condition", timeout: Double = 5, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("\(what) did not happen")
    }

    /// One round, run and waited for.
    private func round() async -> RepositoryStatusWire {
        let published = Published()
        let one = workspace
        let running = watcher(published, workspaces: { [one] })
        await running.start()
        await waitFor { published.count > 1 }
        await running.stop()
        return published.last ?? RepositoryStatusWire()
    }

    // MARK: what a workspace is about

    func testIsTheIssueItsCheckedOutBranchNames() async {
        git.checkedOut("feature/128-tidy-the-picker")
        let status = await round()
        XCTAssertEqual(status.workspaces.first?.branch, "feature/128-tidy-the-picker")
        XCTAssertEqual(status.workspaces.first?.issue?.number, 128)
    }

    func testFollowsACheckoutBecauseNothingWasWrittenDown() async {
        git.checkedOut("feature/128-tidy-the-picker")
        let first = await round()
        XCTAssertEqual(first.workspaces.first?.issue?.number, 128)
        git.checkedOut("master")
        let after = await round()
        XCTAssertEqual(after.workspaces.first?.branch, "master")
        XCTAssertNil(after.workspaces.first?.issue)
        git.checkedOut("alice/fix/#9-crash")
        let again = await round()
        XCTAssertEqual(again.workspaces.first?.issue?.number, 9)
    }

    func testReadsADeepPrefixWithTheNumberWrittenAsAnIssue() async {
        git.checkedOut("step/feature/#1234-issue-body")
        let status = await round()
        XCTAssertEqual(status.workspaces.first?.issue?.number, 1234)
        XCTAssertEqual(gitHub.askedReferences.first, BranchReference(
            owner: "example", repository: "widget", headOwner: "example",
            branch: "step/feature/#1234-issue-body", remoteBranch: "step/feature/#1234-issue-body", issueNumber: 1234
        ))
    }

    func testSaysOnTheRowWhichIssueItIsAboutWhenTheLookFailed() async {
        git.checkedOut("feature/128-tidy")
        gitHub.status = { _ in throw CodedFailure.gitHub("GitHub has no issue example/widget#128.") }
        let status = await round()
        let row = status.workspaces.first
        XCTAssertNil(row?.issue)
        XCTAssertEqual(row?.unavailable, .init(number: 128, reason: "DevHub could not get this from GitHub. GitHub has no issue example/widget#128."))
        XCTAssertNil(status.diagnostic)
    }

    func testSaysSoOnEveryRowWhenGhIsThereAndHoldsNoToken() async {
        git.checkedOut("feature/128-tidy")
        gitHub.token = .unauthenticated
        let status = await round()
        XCTAssertTrue(status.workspaces.first?.unavailable?.reason.contains("gh auth login") ?? false)
        XCTAssertTrue(gitHub.askedReferences.isEmpty)
    }

    func testTellsSomebodyWithNoGhToInstallItNotToLogIn() async {
        git.checkedOut("feature/128-tidy")
        gitHub.token = .unrunnable(reason: "there is no `gh` on DevHub's PATH")
        let status = await round()
        let reason = status.workspaces.first?.unavailable?.reason ?? ""
        XCTAssertTrue(reason.contains("no `gh` on DevHub's PATH"))
        XCTAssertTrue(reason.contains("Install the GitHub CLI"))
        XCTAssertFalse(reason.contains("gh auth login"))
        XCTAssertNil(status.diagnostic)
    }

    func testKeepsWhatItLastKnewRatherThanTheReasonItCouldNotRefreshIt() async {
        git.checkedOut("feature/128-tidy")
        let published = Published()
        let one = workspace
        let watched = Box([one])
        let running = watcher(published, workspaces: { watched.value })
        await running.start()
        await waitFor { published.count >= 2 }
        XCTAssertEqual(published.last?.workspaces.first?.issue?.number, 128)

        gitHub.status = { _ in throw CodedFailure.gitHub("GitHub answered 502.") }
        watched.value = [one, WatchedWorkspace(id: "w-2", root: "/projects/other", runtime: here)]
        let before = published.count
        await running.observe()
        await waitFor { published.count >= before + 2 }
        await running.stop()

        let after = published.last?.workspaces.first
        XCTAssertEqual(after?.issue?.number, 128)
        XCTAssertNil(after?.unavailable)
        XCTAssertEqual(published.last?.diagnostic, "DevHub could not get this from GitHub. GitHub answered 502.")
    }

    func testShowsABranchItHasJustSwitchedToWithoutWaitingForGitHub() async {
        let clock = manualClock()
        git.checkedOut("feature/128-tidy")
        let published = Published()
        let one = workspace
        let running = watcher(published, workspaces: { [one] }, clock: clock)
        await running.start()
        await clock.settle()
        XCTAssertEqual(published.last?.workspaces.first?.branch, "feature/128-tidy")

        // Somebody runs `git switch`, and GitHub stops answering at the same
        // moment. The branch must still appear: it is a local command.
        let hangs = self.hangs
        gitHub.status = { _ in await hangs.hang(); return BranchStatus() }
        git.answer(RepositoryFacts(mainWorktree: "/projects/widget", worktree: "/projects/widget", branch: "master", remote: RemoteIdentity(normalized: "github.com/example/widget")))
        let before = published.count
        await clock.advance(by: pollMs)
        let shown = published.all.dropFirst(before).map { $0.workspaces.first?.branch }
        XCTAssertTrue(shown.contains("master"), "\(shown)")
        await running.stop()
    }

    func testRunsNoGitAtAllWhileNothingHasHappened() async {
        let clock = manualClock()
        git.checkedOut("feature/128-tidy")
        let published = Published()
        let one = workspace
        let running = watcher(published, workspaces: { [one] }, clock: clock)
        await running.start()
        await clock.advance(by: 10)
        XCTAssertGreaterThan(published.count, 0)
        let rounds = git.repositoryCallCount
        let branches = git.branchCallCount
        await clock.advance(by: pollMs - 20)
        XCTAssertEqual(git.repositoryCallCount, rounds)
        XCTAssertEqual(git.branchCallCount, branches)
        await running.stop()
    }

    func testSaysItIsAskingWhileItHasANumberAndNoAnswer() async {
        git.checkedOut("feature/128-tidy")
        let hangs = self.hangs
        gitHub.status = { _ in await hangs.hang(); return BranchStatus() }
        let published = Published()
        let one = workspace
        let running = watcher(published, workspaces: { [one] })
        await running.start()
        await waitFor { published.count > 0 }
        await running.stop()
        let row = published.last?.workspaces.first
        XCTAssertEqual(row?.pending, .init(number: 128))
        XCTAssertNil(row?.issue)
        XCTAssertNil(row?.unavailable)
    }

    func testSaysWhichRemoteItCouldNotReadAsAGitHubRepository() async {
        git.answer(RepositoryFacts(mainWorktree: "/projects/widget", worktree: "/projects/widget", branch: "feature/128-tidy", remote: RemoteIdentity(normalized: "github-alt/example/widget")))
        let status = await round()
        let row = status.workspaces.first
        XCTAssertEqual(row?.branch, "feature/128-tidy")
        XCTAssertNil(row?.issue)
        XCTAssertEqual(row?.unavailable?.number, 128)
        XCTAssertTrue(row?.unavailable?.reason.contains("github-alt/example/widget") ?? false)
        XCTAssertNil(row?.issueRepository)
        XCTAssertTrue(gitHub.askedReferences.isEmpty)
    }

    func testSaysSoWhenTheBranchNamesAnIssueAndThereIsNoRemoteAtAll() async {
        git.answer(RepositoryFacts(mainWorktree: "/projects/widget", worktree: "/projects/widget", branch: "feature/128-tidy"))
        let status = await round()
        XCTAssertEqual(status.workspaces.first?.unavailable?.number, 128)
        XCTAssertTrue(status.workspaces.first?.unavailable?.reason.contains("`origin`") ?? false)
    }

    func testSaysNothingAtAllWhenABranchThatNamesNoIssueHasNothingOutFromIt() async {
        git.checkedOut("master")
        let status = await round()
        let row = status.workspaces.first
        XCTAssertNil(row?.issue)
        XCTAssertNil(row?.pullRequest)
        XCTAssertNil(row?.pending)
        XCTAssertNil(row?.unavailable)
        XCTAssertNil(status.diagnostic)
    }

    func testSaysNothingAtAllWhenTheWorkspaceIsNotARepository() async {
        git.answer(nil)
        let status = await round()
        XCTAssertNil(status.workspaces.first?.branch)
        XCTAssertNil(status.workspaces.first?.unavailable)
        XCTAssertNil(status.diagnostic)
        XCTAssertTrue(gitHub.askedReferences.isEmpty)
    }

    func testSaysOnTheRowWhenGitRefusedToReadTheRepository() async {
        git.repository = { _, _ in throw CodedFailure.workspace("fatal: detected dubious ownership in repository at '/projects/widget'") }
        let status = await round()
        let row = status.workspaces.first
        XCTAssertTrue(row?.unavailable?.reason.contains("dubious ownership") ?? false)
        XCTAssertNil(row?.unavailable?.number)
        XCTAssertNil(status.diagnostic)
        XCTAssertTrue(gitHub.askedReferences.isEmpty)
    }

    // MARK: the pull request out from a branch

    func testIsAskedForOnABranchThatNamesNoIssueAtAll() async {
        git.checkedOut("spike/rework")
        let pull = PullRequestStatus(number: 7, url: "https://github.com/example/widget/pull/7", title: "Rework the picker", state: .open, conversations: .init(unresolved: 0, uncounted: 0))
        gitHub.status = { _ in BranchStatus(pullRequest: pull) }
        let status = await round()
        XCTAssertEqual(gitHub.askedReferences.first, BranchReference(owner: "example", repository: "widget", headOwner: "example", branch: "spike/rework", remoteBranch: "spike/rework"))
        XCTAssertNil(status.workspaces.first?.issue)
        XCTAssertEqual(status.workspaces.first?.pullRequest, pull)
    }

    func testIsStillThereAfterItIsMerged() async {
        git.checkedOut("feature/128-tidy")
        gitHub.status = { _ in
            BranchStatus(
                issue: IssueStatus(number: 128, title: "Tidy", state: .closed, url: "u"),
                pullRequest: PullRequestStatus(number: 9, url: "p", title: "Tidy the picker", state: .merged, conversations: .init(unresolved: 0, uncounted: 0))
            )
        }
        let row = await round().workspaces.first
        XCTAssertEqual(row?.pullRequest?.state, .merged)
        XCTAssertEqual(row?.issue?.state, .closed)
    }

    func testDoesNotPutAReasonOnARowThatWasNeverExpectingAnAnswer() async {
        git.checkedOut("master")
        gitHub.status = { _ in throw CodedFailure.gitHub("GitHub answered 502.") }
        let status = await round()
        XCTAssertNil(status.workspaces.first?.unavailable)
        XCTAssertEqual(status.diagnostic, "DevHub could not get this from GitHub. GitHub answered 502.")
    }

    func testAsksUpstreamAboutAForksBranchAndKeepsTheBranchAsTheForks() async {
        git.answer(RepositoryFacts(
            mainWorktree: "/projects/widget", worktree: "/projects/widget", branch: "feature/128-tidy", pushBranch: "feature/128-tidy",
            remote: RemoteIdentity(normalized: "github.com/contributor/widget"), upstream: RemoteIdentity(normalized: "github.com/example/widget")
        ))
        let status = await round()
        XCTAssertEqual(status.workspaces.first?.issueRepository, IssueRepositoryName(owner: "example", repository: "widget"))
        XCTAssertEqual(gitHub.askedReferences.first, BranchReference(owner: "example", repository: "widget", headOwner: "contributor", branch: "feature/128-tidy", remoteBranch: "feature/128-tidy", issueNumber: 128))
    }

    func testAsksAboutTheBranchsNameOnTheRemoteNotItsNameHere() async {
        git.answer(RepositoryFacts(mainWorktree: "/projects/widget", worktree: "/projects/widget", branch: "feature/128-tidy", pushBranch: "release-2", remote: RemoteIdentity(normalized: "github.com/example/widget")))
        _ = await round()
        XCTAssertEqual(gitHub.askedReferences.first?.branch, "feature/128-tidy")
        XCTAssertEqual(gitHub.askedReferences.first?.remoteBranch, "release-2")
    }

    func testShowsTheIssueTheBranchNamesNeverOneFromAnotherAnswer() async {
        let second = WatchedWorkspace(id: "w-2", root: "/projects/widget-2", runtime: here)
        let branches = ["/projects/widget": "feature/128-tidy", "/projects/widget-2": "feature/130-other"]
        git.repository = { _, root in
            RepositoryFacts(mainWorktree: "/projects/widget", worktree: root, branch: branches[root], pushBranch: "feature/128-tidy", remote: RemoteIdentity(normalized: "github.com/example/widget"))
        }
        git.branch = { _, root in branches[root] }
        let published = Published()
        let first = workspace
        let running = watcher(published, workspaces: { [first, second] })
        await running.start()
        await waitFor {
            guard let last = published.last else { return false }
            return last.workspaces.count == 2 && last.workspaces.allSatisfy { $0.issue != nil }
        }
        await running.stop()
        let rows = published.last?.workspaces ?? []
        XCTAssertEqual(rows.first { $0.workspaceId == "w-1" }?.issue?.number, 128)
        XCTAssertEqual(rows.first { $0.workspaceId == "w-2" }?.issue?.number, 130)
    }

    func testFallsBackToTheLocalNameForABranchNobodyHasPushed() async {
        git.answer(RepositoryFacts(mainWorktree: "/projects/widget", worktree: "/projects/widget", branch: "spike/rework", remote: RemoteIdentity(normalized: "github.com/example/widget")))
        _ = await round()
        XCTAssertEqual(gitHub.askedReferences.first?.remoteBranch, "spike/rework")
    }

    func testStaysOnOriginWhenThereIsNoUpstreamToPrefer() async {
        git.checkedOut("feature/128-tidy")
        let status = await round()
        XCTAssertEqual(status.workspaces.first?.issueRepository, IssueRepositoryName(owner: "example", repository: "widget"))
        XCTAssertEqual(gitHub.askedReferences.first?.owner, "example")
        XCTAssertEqual(gitHub.askedReferences.first?.headOwner, "example")
    }

    func testPutsAFailureNoRowCanShowAtTheFootOfTheList() async {
        git.checkedOut("master")
        gitHub.token = .unrunnable(reason: "there is no `gh` on DevHub's PATH")
        let status = await round()
        XCTAssertNil(status.workspaces.first?.unavailable)
        XCTAssertTrue(status.diagnostic?.contains("Install the GitHub CLI") ?? false)
    }

    func testDoesNotSayItIsAskingOnABranchThatNamesNoIssue() async {
        git.checkedOut("master")
        let hangs = self.hangs
        gitHub.status = { _ in await hangs.hang(); return BranchStatus() }
        let published = Published()
        let one = workspace
        let running = watcher(published, workspaces: { [one] })
        await running.start()
        await waitFor { published.count > 0 }
        await running.stop()
        XCTAssertNil(published.last?.workspaces.first?.pending)
    }

    func testCarriesDirtyAheadAndTheRepositoryPage() async {
        git.checkedOut("main")
        git.dirty = { _, _ in true }
        git.ahead = { _, _ in 3 }
        let row = await round().workspaces.first
        XCTAssertEqual(row?.dirty, true)
        XCTAssertEqual(row?.ahead, 3)
        XCTAssertEqual(row?.repositoryUrl, "https://github.com/example/widget")
        XCTAssertEqual(row?.mainWorktree, "/projects/widget")
        XCTAssertEqual(row?.closingDeletesWorktree(root: "/projects/widget"), false)
    }

    // MARK: checkouts on more than one machine

    private let there = FakeMachine("ssh:build.example.com")

    func testReadsEachRowWithTheGitItsOwnMachineResolved() async {
        git.checkedOut("main")
        let asked = Box<[String]>([])
        let published = Published()
        let one = workspace
        let remote = WatchedWorkspace(id: "w-2", root: "/srv/api", runtime: there)
        let running = watcher(published, workspaces: { [one, remote] }, gitCommand: { runtime in
            asked.value.append(runtime.id)
            return GitCommand(runtime: runtime, git: "git", environment: [:])
        })
        await running.start()
        await waitFor { published.last?.workspaces.count == 2 }
        await running.stop()
        XCTAssertEqual(Set(asked.value), ["local", "ssh:build.example.com"])
        for call in git.locked({ git.repositoryCalls }) {
            XCTAssertEqual(call.runtime, call.root == "/srv/api" ? there.id : here.id)
        }
    }

    func testGivesTheRemoteRowTheSameBranchIssueAndPullRequest() async {
        git.checkedOut("feature/128-tidy")
        let published = Published()
        let remote = WatchedWorkspace(id: "w-2", root: "/srv/api", runtime: there)
        let running = watcher(published, workspaces: { [remote] })
        await running.start()
        await waitFor { published.last?.workspaces.first?.issue?.number == 128 }
        await running.stop()
        XCTAssertEqual(published.last?.workspaces.first?.branch, "feature/128-tidy")
    }

    func testPollsEachMachineOnItsOwnClock() async {
        let clock = manualClock()
        git.checkedOut("main")
        let slow = FakeMachine("ssh:slow.example.com", repositoryPollMs: RepositoryCadence.local.repositoryPollMs * 10)
        let rounds = Box<[String]>([])
        let one = workspace
        let running = watcher(Published(), workspaces: { [one, WatchedWorkspace(id: "w-3", root: "/srv/slow", runtime: slow)] }, gitCommand: { runtime in
            rounds.value.append(runtime.id)
            return GitCommand(runtime: runtime, git: "git", environment: [:])
        }, clock: clock)
        await running.start()
        await clock.advance(by: 0)
        let first = rounds.value.count
        await clock.advance(by: pollMs)
        await running.stop()
        let after = rounds.value.dropFirst(first)
        XCTAssertTrue(after.contains("local"))
        XCTAssertFalse(after.contains("ssh:slow.example.com"))
    }

    func testStopsPollingAMachineOnceNothingIsOpenOnIt() async {
        let clock = manualClock()
        git.checkedOut("main")
        let one = workspace
        let remote = WatchedWorkspace(id: "w-2", root: "/srv/api", runtime: there)
        let watched = Box([one, remote])
        let rounds = Box<[String]>([])
        let running = watcher(Published(), workspaces: { watched.value }, gitCommand: { runtime in
            rounds.value.append(runtime.id)
            return GitCommand(runtime: runtime, git: "git", environment: [:])
        }, clock: clock)
        await running.start()
        await clock.advance(by: 0)
        watched.value = [one]
        await running.observe()
        await clock.advance(by: 0)
        let from = rounds.value.count
        await clock.advance(by: pollMs * 2)
        await running.stop()
        XCTAssertFalse(rounds.value.dropFirst(from).contains(there.id))
    }

    // MARK: coming back to the window

    private func counting(_ workspaces: [WatchedWorkspace], clock: ManualRepositoryClock) -> (Box<[String]>, RepositoryStatusWatcher) {
        let rounds = Box<[String]>([])
        let running = watcher(Published(), workspaces: { workspaces }, gitCommand: { runtime in
            rounds.value.append(runtime.id)
            return GitCommand(runtime: runtime, git: "git", environment: [:])
        }, clock: clock)
        return (rounds, running)
    }

    func testRunsOneRoundForEveryMachineAWorkspaceIsOpenOn() async {
        let clock = manualClock()
        git.checkedOut("main")
        let (rounds, running) = counting([workspace, WatchedWorkspace(id: "w-2", root: "/srv/api", runtime: there)], clock: clock)
        await running.start()
        await clock.advance(by: 0)
        let from = rounds.value.count
        await clock.advance(by: focusMinMs)
        await running.focused()
        await clock.advance(by: 0)
        await running.stop()
        XCTAssertEqual(rounds.value.dropFirst(from).sorted(), ["local", "ssh:build.example.com"])
    }

    func testSkipsASecondFocusInsideTheMachinesOwnMinimum() async {
        let clock = manualClock()
        git.checkedOut("main")
        let (rounds, running) = counting([workspace], clock: clock)
        await running.start()
        await clock.advance(by: 0)
        await clock.advance(by: focusMinMs)
        await running.focused()
        await clock.advance(by: 0)
        let from = rounds.value.count

        await clock.advance(by: focusMinMs / 2)
        await running.focused()
        await running.focused()
        await clock.advance(by: 0)
        XCTAssertEqual(Array(rounds.value.dropFirst(from)), [])

        await clock.advance(by: focusMinMs)
        await running.focused()
        await clock.advance(by: 0)
        await running.stop()
        XCTAssertEqual(Array(rounds.value.dropFirst(from)), ["local"])
    }

    func testDoesNotDoubleARoundThatIsAlreadyInFlight() async {
        let clock = manualClock()
        git.checkedOut("main")
        let hangs = self.hangs
        gitHub.status = { _ in await hangs.hang(); return BranchStatus() }
        let (rounds, running) = counting([workspace], clock: clock)
        await running.start()
        await clock.advance(by: 0)
        XCTAssertEqual(rounds.value, ["local"])
        await clock.advance(by: focusMinMs * 2)
        await running.focused()
        await running.focused()
        await clock.advance(by: 0)
        XCTAssertEqual(rounds.value, ["local"])
        hangs.release()
        await clock.advance(by: 0)
        await running.stop()
    }

    func testLeavesAMachineThatIsNotAnsweringAlone() async {
        let clock = manualClock()
        git.checkedOut("main")
        let gone = FakeMachine("ssh:gone.example.com", connected: false)
        let (rounds, running) = counting([WatchedWorkspace(id: "w-4", root: "/srv/gone", runtime: gone)], clock: clock)
        await running.start()
        await clock.advance(by: 0)
        let from = rounds.value.count
        await clock.advance(by: focusMinMs)
        await running.focused()
        await clock.advance(by: 0)
        await running.stop()
        XCTAssertEqual(Array(rounds.value.dropFirst(from)), [])
    }

    // MARK: a checkout somebody has just made

    func testAsksGitHubAboutTheNewBranchNotOnlyAboutANewOne() async {
        let clock = manualClock()
        git.checkedOut("main")
        let published = Published()
        let one = workspace
        let running = watcher(published, workspaces: { [one] }, clock: clock)
        await running.start()
        await clock.advance(by: 0)

        git.checkedOut("feature/128-tidy")
        headChanged.value?()
        await clock.advance(by: 0)
        git.checkedOut("main")
        gitHub.clear()

        headChanged.value?()
        await clock.advance(by: 0)
        await running.stop()
        XCTAssertTrue(gitHub.askedReferences.map(\.branch).contains("main"))
    }

    // MARK: what `devhub --metrics` says fired

    func testNamesTheTriggerOfEachWorkspacesLastRound() async {
        let clock = manualClock()
        git.checkedOut("main")
        let one = workspace
        let running = watcher(Published(), workspaces: { [one] }, clock: clock)
        await running.start()
        await clock.advance(by: 0)
        func last() async -> WorkspaceRepositoryRound.Round? { await running.rounds().first?.lastRepositoryRound }
        let first = await last()
        XCTAssertEqual(first?.trigger, .poll)
        XCTAssertNotNil(first?.at.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T", options: .regularExpression))

        await running.look()
        await clock.advance(by: 0)
        let manual = await last()
        XCTAssertEqual(manual?.trigger, .manual)

        await clock.advance(by: focusMinMs)
        await running.focused()
        await clock.advance(by: 0)
        let focus = await last()
        XCTAssertEqual(focus?.trigger, .focus)

        git.checkedOut("release-2")
        headChanged.value?()
        await clock.advance(by: 0)
        let head = await last()
        XCTAssertEqual(head?.trigger, .head)

        await clock.advance(by: pollMs)
        await running.stop()
        let poll = await last()
        XCTAssertEqual(poll?.trigger, .poll)
    }

    // MARK: the rules, as strings

    func testKeysARemoteQuestionByTheRemoteNameAndTheIssue() {
        let reference = BranchReference(owner: "example", repository: "widget", headOwner: "me", branch: "local", remoteBranch: "feature/128-x", issueNumber: 128)
        XCTAssertEqual(RepositoryStatusRules.branchKey(reference), "example/widget@me:feature/128-x#128")
        var other = reference
        other.issueNumber = nil
        XCTAssertEqual(RepositoryStatusRules.branchKey(other), "example/widget@me:feature/128-x#")
        XCTAssertNil(RepositoryStatusRules.repositoryUrl(RemoteIdentity(normalized: "gitlab.com/example/widget")))
        XCTAssertNil(RepositoryStatusRules.repositoryUrl(RemoteIdentity(normalized: "github.com/example/widget/extra")))
    }
}

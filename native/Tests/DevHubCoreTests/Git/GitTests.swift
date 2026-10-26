// Port of apps/desktop/src/main/shell/git.test.ts.
//
// The git DevHub runs, against a real repository. Worktree creation is the one
// operation here that cannot be judged by reading it: the rules are `git`'s,
// the failure modes are the filesystem's, and a mock of either would only
// prove that this file agrees with itself.

import Foundation
import XCTest
@testable import DevHubCore

final class GitTests: XCTestCase {
    private let command = GitTestSupport.command
    private let issue128 = WorkItem.issue(128)
    /// A pull request whose branch names no Issue: named by its own number.
    private let pullRequest = WorkItem.pull(130)
    private var parent = ""
    private var repository = ""

    override func setUp() async throws {
        try XCTSkipUnless(GitTestSupport.hasGit, "git is not installed")
        parent = try GitTestSupport.temporaryDirectory("devhub-git-")
        repository = Path.join(parent, "widget")
        try GitTestSupport.mkdir(repository)
        try await git(["init", "-b", "main", repository])
        try GitTestSupport.write(Path.join(repository, "README"), "widget\n")
        try await git(["add", "README"], in: repository)
        try await git(["commit", "-m", "first"], in: repository)
    }

    override func tearDown() async throws {
        if !parent.isEmpty { GitTestSupport.remove(parent) }
    }

    @discardableResult
    private func git(_ args: [String], in cwd: String? = nil) async throws -> String {
        try await command.run(args, cwd: cwd)
    }

    // MARK: reading a repository

    func testAnswersWithTheMainWorktreeAndTheBranchCheckedOut() async throws {
        let facts = try await command.readRepository(repository)
        XCTAssertEqual(facts?.mainWorktree, repository)
        XCTAssertEqual(facts?.branch, "main")
    }

    func testSaysNothingAtAllAboutAPlainFolder() async throws {
        let plain = Path.join(parent, "plain")
        try GitTestSupport.mkdir(plain)
        let facts = try await command.readRepository(plain)
        XCTAssertNil(facts)
    }

    func testNormalisesTheRemoteSoAnHTTPSAndAnSSHCloneCompareEqual() async throws {
        try await git(["remote", "add", "origin", "git@github.com:Example/Widget.git"], in: repository)
        let facts = try await command.readRepository(repository)
        XCTAssertEqual(facts?.remote?.rawValue, "github.com/example/widget")
    }

    // MARK: the worktree for a branch

    func testIsASiblingOfTheRepositoryNamedForTheRepositoryAndTheIssue() async throws {
        let path = try await command.ensureWorktree(repository, work: issue128, branch: "feature/128-tidy")
        XCTAssertEqual(path, Path.join(parent, "widget_128"))
        XCTAssertTrue(GitTestSupport.isDirectory(path))
    }

    func testLinksToItsRepositoryByARelativePathWhenThisGitCan() async throws {
        let path = try await command.ensureWorktree(repository, work: issue128, branch: "feature/128-tidy")
        let link = try GitTestSupport.read(Path.join(path, ".git")).trimmingCharacters(in: .whitespacesAndNewlines)
        if try await command.supportsRelativeWorktrees() {
            XCTAssertEqual(link, "gitdir: ../widget/.git/worktrees/widget_128")
        } else {
            XCTAssertEqual(link, "gitdir: \(repository)/.git/worktrees/widget_128")
        }
    }

    func testReadsGitsVersionHoweverAVendorDecoratesIt() {
        XCTAssertTrue(GitParsing.versionAtLeast("git version 2.48.0", major: 2, minor: 48))
        XCTAssertTrue(GitParsing.versionAtLeast("git version 3.0.1", major: 2, minor: 48))
        XCTAssertFalse(GitParsing.versionAtLeast("git version 2.39.5 (Apple Git-154)", major: 2, minor: 48))
        XCTAssertFalse(GitParsing.versionAtLeast("", major: 2, minor: 48))
    }

    func testIsFoundWhereGitSaysTheBranchIsWhateverTheFolderIsCalled() async throws {
        let earlier = Path.join(parent, "widget_feature_128-wip")
        try await git(["worktree", "add", "-b", "feature/128-wip", earlier], in: repository)
        let path = try await command.ensureWorktree(repository, work: issue128, branch: "feature/128-wip")
        XCTAssertEqual(path, earlier)
        XCTAssertFalse(GitTestSupport.exists(Path.join(parent, "widget_128")))
    }

    func testRefusesTheIssuesFolderWhenItHoldsADifferentBranch() async throws {
        _ = try await command.ensureWorktree(repository, work: issue128, branch: "feature/128-wip")
        await GitTestSupport.assertRejects(
            try await command.ensureWorktree(repository, work: issue128, branch: "feature/128-short-name"),
            matching: "widget_128 is already the worktree of feature/128-wip, not of feature/128-short-name"
        )
        let made = try await command.worktreeForBranch("feature/128-short-name", in: repository)
        XCTAssertNil(made)
    }

    func testChecksOutABranchThatAlreadyExistsRatherThanForkingANewOne() async throws {
        try await git(["branch", "release"], in: repository)
        let path = try await command.ensureWorktree(repository, work: issue128, branch: "release")
        let branch = try await git(["rev-parse", "--abbrev-ref", "HEAD"], in: path)
        XCTAssertEqual(branch.trimmingCharacters(in: .whitespacesAndNewlines), "release")
    }

    func testSwitchesToTheWorktreeABranchAlreadyHas() async throws {
        let first = try await command.ensureWorktree(repository, work: issue128, branch: "feature/128-tidy")
        let again = try await command.ensureWorktree(repository, work: issue128, branch: "feature/128-tidy")
        XCTAssertEqual(again, first)
    }

    func testFindsTheSamePlaceWhenAskedFromInsideAnotherWorktree() async throws {
        let first = try await command.ensureWorktree(repository, work: issue128, branch: "feature/128-tidy")
        let second = try await command.ensureWorktree(first, work: .issue(9), branch: "fix/9-crash")
        XCTAssertEqual(second, Path.join(parent, "widget_9"))
    }

    func testStartsANewBranchFromTheRemotesDefaultBranchNotFromHEAD() async throws {
        let origin = Path.join(parent, "origin.git")
        try await git(["init", "--bare", "-b", "main", origin])
        try await git(["remote", "add", "origin", origin], in: repository)
        try await git(["push", "-u", "origin", "main"], in: repository)
        try await git(["checkout", "-b", "side"], in: repository)
        try GitTestSupport.write(Path.join(repository, "SIDE"), "side\n")
        try await git(["add", "SIDE"], in: repository)
        try await git(["commit", "-m", "side"], in: repository)

        let path = try await command.ensureWorktree(repository, work: issue128, branch: "feature/128-tidy")
        let made = try await git(["rev-parse", "HEAD"], in: path)
        let wanted = try await git(["rev-parse", "origin/main"], in: repository)
        XCTAssertEqual(made.trimmed, wanted.trimmed)
    }

    func testStartsFromTheBranchCheckedOutWhenThereIsNoRemoteAtAll() async throws {
        let path = try await command.ensureWorktree(repository, work: issue128, branch: "feature/9-solo")
        let made = try await git(["rev-parse", "HEAD"], in: path)
        let wanted = try await git(["rev-parse", "main"], in: repository)
        XCTAssertEqual(made.trimmed, wanted.trimmed)
    }

    func testStopsRatherThanBranchFromAStaleCopyWhenTheFetchFails() async throws {
        try await git(["remote", "add", "origin", Path.join(parent, "gone.git")], in: repository)
        await GitTestSupport.assertRejects(
            try await command.ensureWorktree(repository, work: issue128, branch: "feature/128-tidy"),
            matching: "could not be fetched"
        ) { error in
            XCTAssertEqual((error as? CodedFailure)?.code, "git_fetch_failed")
        }
    }

    func testBranchesFromTheCopyOnDiskOnceItHasBeenAllowedTo() async throws {
        let origin = Path.join(parent, "origin.git")
        try await git(["init", "--bare", "-b", "main", origin])
        try await git(["remote", "add", "origin", origin], in: repository)
        try await git(["push", "-u", "origin", "main"], in: repository)
        let wanted = try await git(["rev-parse", "origin/main"], in: repository)
        GitTestSupport.remove(origin)

        let path = try await command.ensureWorktree(
            repository, work: issue128, branch: "feature/128-tidy", options: WorktreeOptions(allowStaleBase: true)
        )
        let made = try await git(["rev-parse", "HEAD"], in: path)
        XCTAssertEqual(made.trimmed, wanted.trimmed)
    }

    func testRefusesADirectoryThatIsInTheWayAndIsNotAWorktree() async throws {
        try GitTestSupport.mkdir(Path.join(parent, "widget_128"))
        await GitTestSupport.assertRejects(
            try await command.ensureWorktree(repository, work: issue128, branch: "feature/128-tidy")
        ) { error in
            XCTAssertTrue(error is CodedFailure)
        }
    }

    func testRefusesABranchNameThatIsOnlyWhitespace() async throws {
        await GitTestSupport.assertRejects(
            try await command.ensureWorktree(repository, work: issue128, branch: "   "),
            matching: "Enter a branch name"
        )
    }

    // MARK: a branch that already exists somewhere

    /// A bare `origin` with one branch on it that this clone does not have.
    @discardableResult
    private func originWith(_ branch: String) async throws -> String {
        let origin = Path.join(parent, "origin.git")
        try await git(["init", "--bare", "-b", "main", origin])
        try await git(["remote", "add", "origin", origin], in: repository)
        try await git(["push", "origin", "main:\(branch)"], in: repository)
        try await git(["fetch", "origin"], in: repository)
        return origin
    }

    func testIsCheckedOutIntoAWorktreeRatherThanStartedAgain() async throws {
        try await originWith("alice/fix-the-crash")
        let wanted = try await git(["rev-parse", "main"], in: repository)
        let path = try await command.ensureWorktree(repository, work: pullRequest, branch: "alice/fix-the-crash")
        let head = try await git(["rev-parse", "--abbrev-ref", "HEAD"], in: path)
        XCTAssertEqual(head.trimmed, "alice/fix-the-crash")
        let commit = try await git(["rev-parse", "HEAD"], in: path)
        XCTAssertEqual(commit.trimmed, wanted.trimmed)
        XCTAssertEqual(path, Path.join(parent, "widget_130"))
    }

    func testGoesInTheFolderOfTheIssueItsBranchIsFor() async throws {
        try await originWith("feature/128-short-name")
        let path = try await command.ensureWorktree(repository, work: pullRequest, branch: "feature/128-short-name")
        XCTAssertEqual(path, Path.join(parent, "widget_128"))
    }

    func testIsFoundOnTheRemoteItIsActuallyOnWhateverThatRemoteIsCalled() async throws {
        let fork = Path.join(parent, "fork.git")
        try await git(["init", "--bare", "-b", "main", fork])
        try await git(["remote", "add", "alice", fork], in: repository)
        try await git(["push", "alice", "main:patch-1"], in: repository)
        try await git(["fetch", "alice"], in: repository)

        let found = try await command.findBranch("patch-1", in: repository)
        XCTAssertEqual(found, BranchWhereabouts(kind: .remote, ref: "refs/remotes/alice/patch-1"))
        let path = try await command.ensureWorktree(repository, work: pullRequest, branch: "patch-1")
        let head = try await git(["rev-parse", "--abbrev-ref", "HEAD"], in: path)
        XCTAssertEqual(head.trimmed, "patch-1")
    }

    func testIsNowhereAtAllWhenItIsOnAForkThisCloneHasNoRemoteFor() async throws {
        try await originWith("release")
        let found = try await command.findBranch("patch-1", in: repository)
        XCTAssertNil(found)
        await GitTestSupport.assertRejects(
            try await command.ensureWorktree(repository, work: pullRequest, branch: "patch-1"),
            matching: "on neither this machine nor any remote"
        )
    }

    func testSaysWhichWorktreeAlreadyHasItSoNoSecondOneIsAskedFor() async throws {
        let path = try await command.ensureWorktree(repository, work: issue128, branch: "feature/128-tidy")
        let tidy = try await command.worktreeForBranch("feature/128-tidy", in: repository)
        XCTAssertEqual(tidy, path)
        let main = try await command.worktreeForBranch("main", in: repository)
        XCTAssertEqual(main, repository)
        let never = try await command.worktreeForBranch("never-made", in: repository)
        XCTAssertNil(never)
    }

    func testNamesTheRemoteThatIsOneOwnersCopyOfTheRepository() async throws {
        try await git(["remote", "add", "alice", "git@github.com:Alice/Widget.git"], in: repository)
        let alice = try await command.remoteForRepository(owner: "alice", repository: "widget", in: repository)
        XCTAssertEqual(alice, "alice")
        let bob = try await command.remoteForRepository(owner: "bob", repository: "widget", in: repository)
        XCTAssertNil(bob)
    }

    // MARK: the branches on offer

    func testNamesEachOneOnceWithNoRemotePrefixAndNoHEAD() async throws {
        try await git(["branch", "release"], in: repository)
        let branches = try await command.listBranches(repository)
        XCTAssertEqual(branches.sorted(), ["main", "release"])
    }

    // MARK: git worktree list

    func testIsReadAsARecordPerWorktreeDetachedOnesIncluded() {
        XCTAssertEqual(
            GitParsing.worktrees([
                "worktree /projects/widget",
                "HEAD abc",
                "branch refs/heads/main",
                "",
                "worktree /projects/widget_detached",
                "HEAD def",
                "detached",
                "",
            ].joined(separator: "\n")),
            [
                WorktreeRecord(path: "/projects/widget", branch: "main", unborn: false),
                WorktreeRecord(path: "/projects/widget_detached", branch: nil, unborn: false),
            ]
        )
    }

    func testReadsTheAllZeroHeadOfACheckoutWithNoCommitsAsUnborn() {
        XCTAssertEqual(
            GitParsing.worktrees([
                "worktree /projects/fresh",
                "HEAD \(String(repeating: "0", count: 40))",
                "branch refs/heads/main",
                "",
            ].joined(separator: "\n")),
            [WorktreeRecord(path: "/projects/fresh", branch: "main", unborn: true)]
        )
    }

    // MARK: a clone of an empty repository

    private func emptyClone() async throws -> String {
        let origin = Path.join(parent, "empty-origin.git")
        try await git(["init", "--bare", "-q", origin], in: parent)
        let empty = Path.join(parent, "empty")
        try await git(["clone", "--", origin, empty], in: parent)
        return empty
    }

    func testIsReadAsARepositoryWithTheBranchThatHasNoCommitsYet() async throws {
        let empty = try await emptyClone()
        let facts = try await command.readRepository(empty)
        XCTAssertNotNil(facts)
        XCTAssertEqual(facts?.mainWorktree, empty)
        XCTAssertEqual(facts?.unborn, true)
        XCTAssertNotNil(facts?.branch)
        XCTAssertNil(facts?.defaultBranch)
    }

    func testRefusesAWorktreeBecauseThereIsNoCommitToCheckOneOutAt() async throws {
        let empty = try await emptyClone()
        await GitTestSupport.assertRejects(
            try await command.ensureWorktree(empty, work: issue128, branch: "feature/1-start"),
            matching: "no commits yet"
        )
    }

    func testIsNotMistakenForAFolderThatIsNotARepository() async throws {
        _ = try await emptyClone()
        let plain = Path.join(parent, "not-a-repository")
        try GitTestSupport.mkdir(plain)
        let facts = try await command.readRepository(plain)
        XCTAssertNil(facts)
    }

    // MARK: a git that fails

    func testThrowsGitsOwnLastLineNotASentenceDevHubMadeUp() async throws {
        await GitTestSupport.assertRejects(try await git(["checkout", "no-such-branch"], in: repository), matching: "no-such-branch")
    }

    func testSaysWhichGitCouldNotBeStarted() async throws {
        let missing = GitCommand(runtime: LocalRepositoryRuntime(), git: "/nonexistent/git", environment: [:])
        await GitTestSupport.assertRejects(try await missing.run(["status"], cwd: repository), matching: "/nonexistent/git")
    }

    func testAbandonedGitIsKilledAndSaysItWasCancelled() async throws {
        let slow = GitCommand(runtime: LocalRepositoryRuntime(), git: "/bin/sh", environment: GitTestSupport.environment)
        let task = Task { try await slow.run(["-c", "sleep 30"]) }
        try await Task.sleep(nanoseconds: 100_000_000)
        task.cancel()
        let started = Date()
        do {
            _ = try await task.value
            XCTFail("a cancelled git answered")
        } catch {
            XCTAssertTrue(error is CancellationError, "\(error)")
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
    }

    func testAGitPastItsDeadlineSaysHowLongItWasGiven() async throws {
        let slow = GitCommand(runtime: LocalRepositoryRuntime(), git: "/bin/sh", environment: GitTestSupport.environment)
        await GitTestSupport.assertRejects(try await slow.run(["-c", "sleep 30"], timeoutMs: 200), matching: "^git -c did not answer in 0s\\.$")
    }

    // MARK: the name a branch has on the remote

    @discardableResult
    private func addRemote(_ name: String) async throws -> String {
        let path = Path.join(parent, "\(name.replacingOccurrences(of: "/", with: "_")).git")
        try await git(["init", "--bare", "-b", "main", path])
        try await git(["remote", "add", name, path], in: repository)
        return path
    }

    private func pushBranch(_ directory: String? = nil) async throws -> String? {
        try await command.readRepository(directory ?? repository)?.pushBranch
    }

    func testIsThePushDestinationWhenTheBranchHasOne() async throws {
        try await addRemote("origin")
        try await git(["push", "-u", "origin", "main"], in: repository)
        let name = try await pushBranch()
        XCTAssertEqual(name, "main")
    }

    func testIsTheUpstreamWhenPushDefaultSimpleRefusesToAnswer() async throws {
        try await addRemote("origin")
        try await git(["config", "push.default", "simple"], in: repository)
        try await git(["push", "origin", "main:release-2"], in: repository)
        try await git(["checkout", "-b", "foo/baz"], in: repository)
        try await git(["branch", "--set-upstream-to=origin/release-2", "foo/baz"], in: repository)
        let name = try await pushBranch()
        XCTAssertEqual(name, "release-2")
    }

    func testIsThePushDestinationAndNotTheUpstreamInAFork() async throws {
        try await addRemote("origin")
        let source = try await addRemote("upstream")
        try await git(["push", "upstream", "main"], in: repository)
        try await git(["fetch", "upstream"], in: repository)
        try await git(["checkout", "-b", "feature/128-tidy"], in: repository)
        try await git(["branch", "--set-upstream-to=upstream/main", "feature/128-tidy"], in: repository)
        try await git(["config", "push.default", "current"], in: repository)
        try await git(["config", "branch.feature/128-tidy.pushRemote", "origin"], in: repository)
        XCTAssertTrue(source.contains("upstream"))
        let name = try await pushBranch()
        XCTAssertEqual(name, "feature/128-tidy")
    }

    func testKeepsTheWholeBranchNameWhenTheRemotesOwnNameHasASlash() async throws {
        try await addRemote("my/fork")
        try await git(["push", "my/fork", "main:release-2"], in: repository)
        try await git(["checkout", "-b", "local-name"], in: repository)
        try await git(["branch", "--set-upstream-to=my/fork/release-2", "local-name"], in: repository)
        try await git(["config", "push.default", "upstream"], in: repository)
        let name = try await pushBranch()
        XCTAssertEqual(name, "release-2")
    }

    func testIsNotTheTrunkANewWorktreesBranchWasStartedFrom() async throws {
        try await addRemote("origin")
        try await git(["push", "-u", "origin", "main"], in: repository)
        try await git(["remote", "set-head", "origin", "main"], in: repository)
        try await git(["config", "push.default", "simple"], in: repository)
        let path = try await command.ensureWorktree(repository, work: issue128, branch: "feature/128-tidy")
        let facts = try await command.readRepository(path)
        XCTAssertEqual(facts?.branch, "feature/128-tidy")
        XCTAssertNil(facts?.pushBranch)
    }

    func testIsNotTheTrunkABranchMadeByHandWasStartedFrom() async throws {
        try await addRemote("origin")
        try await git(["push", "-u", "origin", "main"], in: repository)
        try await git(["remote", "set-head", "origin", "main"], in: repository)
        try await git(["config", "push.default", "simple"], in: repository)
        try await git(["switch", "--track", "-c", "fix/9", "origin/main"], in: repository)
        let name = try await pushBranch()
        XCTAssertNil(name)
    }

    func testIsNotABranchOfARemoteOtherThanTheOneTheBranchIsPushedTo() async throws {
        try await addRemote("origin")
        try await addRemote("upstream")
        try await git(["push", "upstream", "main"], in: repository)
        try await git(["fetch", "upstream"], in: repository)
        try await git(["config", "push.default", "simple"], in: repository)
        try await git(["checkout", "-b", "feature/128-tidy"], in: repository)
        try await git(["branch", "--set-upstream-to=upstream/main", "feature/128-tidy"], in: repository)
        let name = try await pushBranch()
        XCTAssertNil(name)
    }

    func testIsNotAnotherIssuesBranchThatANewBranchWasStartedFrom() async throws {
        try await addRemote("origin")
        try await git(["push", "origin", "main:feature/128-tidy"], in: repository)
        try await git(["fetch", "origin"], in: repository)
        try await git(["config", "push.default", "simple"], in: repository)
        try await git(["switch", "--track", "-c", "feature/130-other", "origin/feature/128-tidy"], in: repository)
        let name = try await pushBranch()
        XCTAssertNil(name)
    }

    func testIsNotAnotherIssuesBranchEvenWhenPushNamesIt() async throws {
        try await addRemote("origin")
        try await git(["push", "origin", "main:feature/128-tidy"], in: repository)
        try await git(["fetch", "origin"], in: repository)
        try await git(["config", "push.default", "upstream"], in: repository)
        try await git(["switch", "--track", "-c", "feature/130-other", "origin/feature/128-tidy"], in: repository)
        let name = try await pushBranch()
        XCTAssertNil(name)
    }

    func testIsNothingAtAllWhenTheBranchHasNeither() async throws {
        let name = try await pushBranch()
        XCTAssertNil(name)
    }

    // MARK: an Issue's branch that exists nowhere

    /// A clone like `statiolake/dockim`: the default branch is `master`, and
    /// the Issue's `feature/3-wip` exists nowhere yet.
    private func masterOrigin() async throws {
        try await git(["branch", "-m", "main", "master"], in: repository)
        let origin = Path.join(parent, "origin.git")
        try await git(["init", "--bare", "-b", "master", origin])
        try await git(["remote", "add", "origin", origin], in: repository)
        try await git(["push", "-u", "origin", "master"], in: repository)
        try await git(["remote", "set-head", "origin", "--auto"], in: repository)
    }

    func testIsDroppedFromThePlanSoTheIssueReadsAsNotStarted() {
        XCTAssertEqual(IssueBranchPlan(branch: "feature/3-wip", reachable: false).offered, IssueBranchPlan(reachable: false))
        XCTAssertEqual(IssueBranchPlan(branch: "feature/3-wip", reachable: true).offered, IssueBranchPlan(branch: "feature/3-wip", reachable: true))
        XCTAssertEqual(
            IssueBranchPlan(branch: "feature/3-wip", reachable: false, checkedOutAt: "/x").offered,
            IssueBranchPlan(branch: "feature/3-wip", reachable: false, checkedOutAt: "/x")
        )
    }

    func testIsMadeInAWorktreeFromAMasterDefaultBranch() async throws {
        try await masterOrigin()
        let path = try await command.ensureWorktree(repository, work: .issue(3), branch: "feature/3-wip")
        let made = try await git(["rev-parse", "HEAD"], in: path)
        let wanted = try await git(["rev-parse", "origin/master"], in: repository)
        XCTAssertEqual(made.trimmed, wanted.trimmed)
    }

    // MARK: a merged pull request whose head was deleted

    func testIsRefusedRatherThanInventedInAWorktreeOrTheRoot() async throws {
        try await masterOrigin()
        let merged = WorkItem.pull(3)
        await GitTestSupport.assertRejects(
            try await command.ensureWorktree(repository, work: merged, branch: "claude/gone"),
            matching: "on neither this machine nor any remote"
        )
        await GitTestSupport.assertRejects(
            try await command.switchRootBranch(repository, work: merged, branch: "claude/gone"),
            matching: "on neither this machine nor any remote"
        )
    }

    // MARK: a branch in the root checkout

    func testIsMadeFromTheDefaultBranchAndSwitchedToWithoutTrackingIt() async throws {
        try await masterOrigin()
        try await git(["checkout", "-b", "side"], in: repository)
        try GitTestSupport.write(Path.join(repository, "SIDE"), "side\n")
        try await git(["add", "SIDE"], in: repository)
        try await git(["commit", "-m", "side"], in: repository)

        let path = try await command.switchRootBranch(repository, work: .issue(3), branch: "feature/3-wip")
        XCTAssertEqual(path, repository)
        let head = try await git(["branch", "--show-current"], in: repository)
        XCTAssertEqual(head.trimmed, "feature/3-wip")
        let made = try await git(["rev-parse", "HEAD"], in: repository)
        let wanted = try await git(["rev-parse", "origin/master"], in: repository)
        XCTAssertEqual(made.trimmed, wanted.trimmed)
        await GitTestSupport.assertRejects(try await git(["rev-parse", "--abbrev-ref", "@{u}"], in: repository))
    }

    func testSwitchesToABranchThatAlreadyExists() async throws {
        try await git(["branch", "feature/128-tidy"], in: repository)
        _ = try await command.switchRootBranch(repository, work: issue128, branch: "feature/128-tidy")
        let head = try await git(["branch", "--show-current"], in: repository)
        XCTAssertEqual(head.trimmed, "feature/128-tidy")
    }

    func testRefusesARootWithUncommittedChangesRatherThanCarryThemOver() async throws {
        try GitTestSupport.write(Path.join(repository, "README"), "changed\n")
        await GitTestSupport.assertRejects(
            try await command.switchRootBranch(repository, work: issue128, branch: "feature/128-wip"),
            matching: "uncommitted changes"
        )
        let head = try await git(["branch", "--show-current"], in: repository)
        XCTAssertEqual(head.trimmed, "main")
    }

    func testRefusesABranchAnotherWorktreeAlreadyHas() async throws {
        _ = try await command.ensureWorktree(repository, work: issue128, branch: "feature/128-wip")
        await GitTestSupport.assertRejects(
            try await command.switchRootBranch(repository, work: issue128, branch: "feature/128-wip"),
            matching: "already checked out in"
        )
    }

    // MARK: readDirty / readAhead / readBranch

    func testReadsDirtyAheadAndTheBranchOfARealCheckout() async throws {
        let clean = try await command.readDirty(repository)
        XCTAssertEqual(clean, false)
        try GitTestSupport.write(Path.join(repository, "NEW"), "untracked\n")
        let dirty = try await command.readDirty(repository)
        XCTAssertEqual(dirty, true)
        let noUpstream = try await command.readAhead(repository)
        XCTAssertNil(noUpstream)
        try await addRemote("origin")
        try await git(["push", "-u", "origin", "main"], in: repository)
        try await git(["add", "NEW"], in: repository)
        try await git(["commit", "-m", "second"], in: repository)
        let ahead = try await command.readAhead(repository)
        XCTAssertEqual(ahead, 1)
        let branch = try await command.readBranch(repository)
        XCTAssertEqual(branch, "main")
        try await git(["checkout", "--detach"], in: repository)
        let detached = try await command.readBranch(repository)
        XCTAssertNil(detached)
    }
}

fileprivate extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}

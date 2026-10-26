// Port of apps/desktop/src/main/shell/worktreeFolder.test.ts.
//
// Against a real repository and a real filesystem, because every fact under
// test belongs to one of those two: what `git worktree remove` refuses, what
// `stat` reports when a parent's permission bit changes, and what git leaves
// behind when it half-succeeds.

import Foundation
import XCTest
@testable import DevHubCore

final class WorktreeFolderTests: XCTestCase {
    private let command = GitTestSupport.command
    private let runtime = LocalRepositoryRuntime()
    private var parent = ""
    private var repository = ""
    /// Set by a test that locks a directory, so teardown can unlock it first.
    private var locked: String?

    override func setUp() async throws {
        try XCTSkipUnless(GitTestSupport.hasGit, "git is not installed")
        parent = try GitTestSupport.temporaryDirectory("devhub-worktree-")
        repository = Path.join(parent, "widget")
        try GitTestSupport.mkdir(repository)
        try await command.run(["init", "-b", "main", repository])
        try GitTestSupport.write(Path.join(repository, "README.md"), "widget\n")
        try await command.run(["add", "."], cwd: repository)
        try await command.run(["commit", "-m", "first"], cwd: repository)
        locked = nil
    }

    override func tearDown() async throws {
        if let locked { chmod(locked, 0o755) }
        if !parent.isEmpty { GitTestSupport.remove(parent) }
    }

    /// The paths `git worktree list` currently admits to.
    private func listedWorktrees() async throws -> [String] {
        let listing = try await command.run(["worktree", "list", "--porcelain"], cwd: repository)
        return listing.split(separator: "\n").filter { $0.hasPrefix("worktree ") }.map { String($0.dropFirst("worktree ".count)) }
    }

    private func addWorktree(_ name: String) async throws -> String {
        let path = Path.join(parent, name)
        try await command.run(["worktree", "add", "-b", name, path], cwd: repository)
        return path
    }

    /// Permission bits mean nothing to root, which is who runs the Docker
    /// tests; these cases need an ordinary user.
    private func lockParent() throws {
        try XCTSkipIf(geteuid() == 0, "root reads through any permission bit")
        locked = parent
        chmod(parent, 0o000)
    }

    // MARK: what a folder says about itself

    func testReadsALinkedWorktreesRepositoryOffItsGitFile() async throws {
        let path = try await addWorktree("feature")
        XCTAssertEqual(
            try WorktreeFolders.read(runtime, path),
            WorktreeFolder(root: path, mainWorktree: repository, gitdir: Path.join(repository, ".git", "worktrees", "feature"))
        )
    }

    func testSaysNothingAboutTheRepositoryItselfWhoseGitIsADirectory() throws {
        XCTAssertNil(try WorktreeFolders.read(runtime, repository))
    }

    func testSaysNothingAboutAPlainFolder() throws {
        let plain = Path.join(parent, "plain")
        try GitTestSupport.mkdir(plain)
        XCTAssertNil(try WorktreeFolders.read(runtime, plain))
    }

    func testStillRecognisesAWorktreeGitHasForgotten() async throws {
        let path = try await addWorktree("feature")
        GitTestSupport.remove(Path.join(repository, ".git", "worktrees"))
        let listed = try await listedWorktrees()
        XCTAssertFalse(listed.contains(path))
        XCTAssertEqual(
            try WorktreeFolders.read(runtime, path),
            WorktreeFolder(root: path, mainWorktree: repository, gitdir: Path.join(repository, ".git", "worktrees", "feature"))
        )
    }

    // MARK: a folder that cannot be read

    func testIsNotReportedAsAFolderThatIsGone() async throws {
        let path = try await addWorktree("feature")
        try lockParent()
        XCTAssertThrowsError(try WorktreeFolders.folderIsDirectory(runtime, path)) { error in
            let failure = error as? CodedFailure
            XCTAssertNotNil(failure)
            XCTAssertTrue(failure?.summary.contains("EACCES") ?? false)
            XCTAssertTrue(failure?.summary.contains(path) ?? false)
        }
    }

    func testIsRootInaccessibleToAnOpenNotRootMissing() async throws {
        let path = try await addWorktree("feature")
        try lockParent()
        XCTAssertEqual(WorktreeFolders.unreadableReason(runtime, path), .rootInaccessible)
    }

    func testIsRootMissingWhenItReallyIsNotThere() {
        XCTAssertEqual(WorktreeFolders.unreadableReason(runtime, Path.join(parent, "nowhere")), .rootMissing)
        XCTAssertNil(WorktreeFolders.unreadableReason(runtime, repository))
    }

    // MARK: disposing of a worktree

    func testRemovesTheFolderAndGitsRecordOfIt() async throws {
        let path = try await addWorktree("feature")
        try await WorktreeFolders.dispose(command, mainWorktree: repository, root: path, force: false)
        XCTAssertFalse(GitTestSupport.exists(path))
        let listed = try await listedWorktrees()
        XCTAssertFalse(listed.contains(path))
    }

    func testPrunesTheRecordWhenTheFolderIsAlreadyGone() async throws {
        let path = try await addWorktree("feature")
        GitTestSupport.remove(path)
        try await WorktreeFolders.dispose(command, mainWorktree: repository, root: path, force: false)
        let listed = try await listedWorktrees()
        XCTAssertFalse(listed.contains(path))
    }

    func testLetsGitRefuseAWorktreeWithWorkInIt() async throws {
        let path = try await addWorktree("feature")
        try GitTestSupport.write(Path.join(path, "scratch.txt"), "unsaved\n")
        await GitTestSupport.assertRejects(try await WorktreeFolders.dispose(command, mainWorktree: repository, root: path, force: false)) { error in
            XCTAssertTrue(error is CodedFailure)
        }
        XCTAssertTrue(GitTestSupport.exists(Path.join(path, "scratch.txt")))
        let listed = try await listedWorktrees()
        XCTAssertTrue(listed.contains(path))
    }

    func testRemovesAWorktreeWithWorkInItOnceThePersonHasBeenAsked() async throws {
        let path = try await addWorktree("feature")
        try GitTestSupport.write(Path.join(path, "scratch.txt"), "unsaved\n")
        try await WorktreeFolders.dispose(command, mainWorktree: repository, root: path, force: true)
        XCTAssertFalse(GitTestSupport.exists(path))
        let listed = try await listedWorktrees()
        XCTAssertFalse(listed.contains(path))
    }

    func testFailsAndDeletesNothingWhenTheFolderCannotBeRead() async throws {
        let path = try await addWorktree("feature")
        try GitTestSupport.write(Path.join(path, "scratch.txt"), "unsaved\n")
        try lockParent()
        await GitTestSupport.assertRejects(try await WorktreeFolders.dispose(command, mainWorktree: repository, root: path, force: true), matching: "EACCES")
        chmod(parent, 0o755)
        locked = nil
        let listed = try await listedWorktrees()
        XCTAssertTrue(listed.contains(path))
        XCTAssertEqual(try GitTestSupport.read(Path.join(path, "scratch.txt")), "unsaved\n")
    }

    func testFinishesTheJobWhenGitRemovedItsRecordAndLeftTheFolder() async throws {
        let path = try await addWorktree("feature")
        try GitTestSupport.write(Path.join(path, "scratch.txt"), "unsaved\n")
        GitTestSupport.remove(Path.join(repository, ".git", "worktrees"))
        try await WorktreeFolders.dispose(command, mainWorktree: repository, root: path, force: true)
        XCTAssertFalse(GitTestSupport.exists(path))
    }

    func testNeverDeletesAFolderThatDoesNotNameThisRepository() async throws {
        let stranger = Path.join(parent, "stranger")
        try GitTestSupport.mkdir(stranger)
        try GitTestSupport.write(Path.join(stranger, "keep.txt"), "mine\n")
        await GitTestSupport.assertRejects(try await WorktreeFolders.dispose(command, mainWorktree: repository, root: stranger, force: true)) { error in
            XCTAssertTrue(error is CodedFailure)
        }
        XCTAssertEqual(try GitTestSupport.read(Path.join(stranger, "keep.txt")), "mine\n")
    }

    func testStillDisposesOfTheWorktreeOnARetryAfterAFailure() async throws {
        let path = try await addWorktree("feature")
        try GitTestSupport.write(Path.join(path, "scratch.txt"), "unsaved\n")
        try lockParent()
        await GitTestSupport.assertRejects(try await WorktreeFolders.dispose(command, mainWorktree: repository, root: path, force: true))
        chmod(parent, 0o755)
        locked = nil
        try await WorktreeFolders.dispose(command, mainWorktree: repository, root: path, force: true)
        XCTAssertFalse(GitTestSupport.exists(path))
        let listed = try await listedWorktrees()
        XCTAssertFalse(listed.contains(path))
    }

    // MARK: model/worktrees.test.ts

    func testAWorktreesDirectoryIsASiblingOfTheRepositoryNamedForTheIssue() {
        XCTAssertEqual(Worktrees.directory(mainWorktree: "/projects/widget", work: .issue(128), branch: "feature/128-wip"), "/projects/widget_128")
    }

    func testIsTheIssuesWhateverTheBranchIsCalled() {
        XCTAssertEqual(Worktrees.directory(mainWorktree: "/projects/widget", work: .issue(128), branch: "feature/128-short-name"), "/projects/widget_128")
        XCTAssertEqual(Worktrees.directory(mainWorktree: "/projects/widget", work: .issue(128), branch: "tidy-up"), "/projects/widget_128")
    }

    func testIsTheIssuesForAPullRequestWhoseBranchNamesTheIssue() {
        XCTAssertEqual(Worktrees.number(for: .pull(130), branch: "feature/128-short-name"), 128)
        XCTAssertEqual(Worktrees.directory(mainWorktree: "/projects/widget", work: .pull(130), branch: "feature/128-short-name"), "/projects/widget_128")
    }

    func testIsThePullRequestsOwnForABranchThatNamesNoIssue() {
        XCTAssertEqual(Worktrees.number(for: .pull(130), branch: "alice/fix-the-crash"), 130)
        XCTAssertEqual(Worktrees.directory(mainWorktree: "/projects/widget", work: .pull(130), branch: "alice/fix-the-crash"), "/projects/widget_130")
    }

    func testDoesNotReadAnIssuesNumberFromItsBranch() {
        XCTAssertEqual(Worktrees.number(for: .issue(128), branch: "feature/9-crash"), 128)
    }

    func testIgnoresATrailingSeparatorOnTheRepository() {
        XCTAssertEqual(Worktrees.directory(mainWorktree: "/projects/widget/", work: .issue(128), branch: "main"), "/projects/widget_128")
    }

    func testNamesTheRepositoryByItsLastSegment() {
        XCTAssertEqual(Worktrees.baseName("/projects/widget"), "widget")
        XCTAssertEqual(Worktrees.baseName("/projects/widget/"), "widget")
    }

    func testClosingDeletesAWorktreeOnlyWhenTheRowIsAWorktreesRoot() {
        XCTAssertFalse(Worktrees.closingDeletesWorktree(mainWorktree: nil, worktree: nil, root: "/projects/widget"))
        XCTAssertFalse(Worktrees.closingDeletesWorktree(mainWorktree: "/projects/widget", worktree: "/projects/widget", root: "/projects/widget"))
        XCTAssertTrue(Worktrees.closingDeletesWorktree(mainWorktree: "/projects/other", worktree: "/projects/widget", root: "/projects/widget"))
        XCTAssertFalse(Worktrees.closingDeletesWorktree(mainWorktree: "/projects/other", worktree: "/projects/widget", root: "/projects/widget/packages/app"))
    }
}

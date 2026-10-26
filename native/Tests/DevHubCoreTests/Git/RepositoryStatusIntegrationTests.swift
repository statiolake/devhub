// WP4's acceptance integration test: a real repository, the real git, the real
// HEAD watcher and the real poller — a worktree added and removed, and a
// branch change on screen within a second of `git switch`.

import Foundation
import XCTest
@testable import DevHubCore

final class RepositoryStatusIntegrationTests: XCTestCase {
    func testABranchChangeIsPublishedWithinASecondAndWorktreesComeAndGo() async throws {
        try XCTSkipUnless(GitTestSupport.hasGit, "git is not installed")
        let parent = try GitTestSupport.temporaryDirectory("devhub-status-")
        defer { GitTestSupport.remove(parent) }
        let git = GitTestSupport.command
        let root = Path.join(parent, "widget")
        try GitTestSupport.mkdir(root)
        try await git.run(["init", "-q", "-b", "main", root])
        try await git.run(["commit", "-q", "--allow-empty", "-m", "first"], cwd: root)

        let runtime = LocalRepositoryRuntime()
        let workspaces = TestCell([WatchedWorkspace(id: "w-1", root: root, runtime: runtime)])
        let published = PublishedStatuses()
        let watcher = RepositoryStatusWatcher(deps: RepositoryStatusDeps(
            gitCommand: { _ in git },
            environment: ["PATH": ""],
            workspaces: { workspaces.value },
            publish: { published.append($0) }
        ))
        await watcher.start()
        defer { Task { await watcher.stop() } }

        func waitFor(_ what: String, within seconds: Double, _ condition: () -> Bool) async {
            let deadline = Date().addingTimeInterval(seconds)
            while Date() < deadline {
                if condition() { return }
                try? await Task.sleep(nanoseconds: 10_000_000)
            }
            XCTFail("\(what) did not happen within \(seconds) s")
        }
        await waitFor("the first round", within: 10) { published.last?.workspace("w-1")?.branch == "main" }
        // The watcher is armed by the round that has just published.
        try await Task.sleep(nanoseconds: UInt64(HeadWatcher.debounceCeilingMs) * 1_000_000)

        try await git.run(["switch", "-q", "-c", "feature/128-tidy"], cwd: root)
        let switched = Date()
        await waitFor("the switch", within: 1.5) { published.last?.workspace("w-1")?.branch == "feature/128-tidy" }
        XCTAssertLessThan(Date().timeIntervalSince(switched), 1.5)

        // A worktree, opened as a second Workspace, is read as one.
        let path = try await git.ensureWorktree(root, work: .issue(9), branch: "feature/9-wip")
        workspaces.value.append(WatchedWorkspace(id: "w-2", root: path, runtime: runtime))
        await watcher.observe()
        await waitFor("the worktree's row", within: 10) { published.last?.workspace("w-2")?.branch == "feature/9-wip" }
        let row = published.last?.workspace("w-2")
        XCTAssertEqual(row?.mainWorktree, root)
        XCTAssertEqual(row?.worktree, path)
        XCTAssertEqual(row?.closingDeletesWorktree(root: path), true)
        XCTAssertEqual(row?.dirty, false)

        // Closed and disposed of: the row goes with it.
        workspaces.value.removeLast()
        await watcher.observe()
        try await WorktreeFolders.dispose(git, mainWorktree: root, root: path, force: false)
        XCTAssertFalse(GitTestSupport.exists(path))
        await waitFor("the worktree's row to go", within: 10) { published.last.map { $0.workspace("w-2") == nil } ?? false }
        await watcher.stop()
    }
}

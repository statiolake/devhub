// Port of apps/desktop/src/main/shell/headWatcher.test.ts.
//
// The watcher, against real repositories: what is being pinned is that git's
// own writes reach the watch on this platform, in an ordinary clone and in a
// linked worktree, and that a directory with no `.git` at all is reported
// rather than silently unwatched.

import Foundation
import XCTest
@testable import DevHubCore

final class HeadWatcherTests: XCTestCase {
    private let runtime = LocalRepositoryRuntime()
    private var cleanups: [() -> Void] = []

    override func setUp() async throws {
        try XCTSkipUnless(GitTestSupport.hasGit, "git is not installed")
    }

    override func tearDown() async throws {
        while let cleanup = cleanups.popLast() { cleanup() }
    }

    @discardableResult
    private func git(_ directory: String, _ args: String...) async throws -> String {
        try await GitTestSupport.command.run(args, cwd: directory)
    }

    /// A repository with one commit on `main`, removed when the case ends.
    private func repository() async throws -> String {
        let root = try GitTestSupport.temporaryDirectory("devhub-head-")
        cleanups.append { GitTestSupport.remove(root) }
        try await git(root, "init", "-q", "-b", "main", ".")
        try GitTestSupport.write(Path.join(root, "file.txt"), "one\n")
        try await git(root, "add", "file.txt")
        try await git(root, "commit", "-qm", "first")
        return root
    }

    private final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var value = 0
        func bump() { lock.lock(); value += 1; lock.unlock() }
        var count: Int { lock.lock(); defer { lock.unlock() }; return value }
    }

    /// A watcher that records how many times it was told something moved.
    private func watching() -> (HeadWatcher, Counter) {
        let counter = Counter()
        let watcher = HeadWatcher { counter.bump() }
        cleanups.append { watcher.stop() }
        return (watcher, counter)
    }

    /// A count of the changes this case caused, and nothing else: a repository
    /// made moments ago may still be delivering its own creation events.
    private func settled(_ counter: Counter) async throws -> () -> Int {
        try await Task.sleep(nanoseconds: UInt64(HeadWatcher.debounceCeilingMs) * 1_000_000)
        let before = counter.count
        return { counter.count - before }
    }

    /// Wait for a condition the filesystem will reach, or say it never did.
    private func until(_ what: String, budgetMs: Int = HeadWatcher.debounceCeilingMs * 5, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(Double(budgetMs) / 1000)
        while Date() < deadline {
            if condition() { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("\(what) did not happen within \(budgetMs)ms")
    }

    func testNoticesGitCheckoutBInAnOrdinaryClone() async throws {
        let root = try await repository()
        let (watcher, counter) = watching()
        await watcher.arm([WatchedRepository(key: "w-1", worktree: root, runtime: runtime)])
        XCTAssertEqual(watcher.failures(), [])
        XCTAssertEqual(watcher.armedCount, 1)
        let since = try await settled(counter)

        try await git(root, "checkout", "-q", "-b", "spike/rework")
        try await until("the checkout was noticed") { since() > 0 }
    }

    func testNoticesACheckoutInALinkedWorktreeNotTheMainOnes() async throws {
        let root = try await repository()
        let linked = root + "-wt"
        cleanups.append { GitTestSupport.remove(linked) }
        try await git(root, "worktree", "add", "-q", "-b", "side", linked)

        let (watcher, counter) = watching()
        await watcher.arm([WatchedRepository(key: "w-1", worktree: linked, runtime: runtime)])
        XCTAssertEqual(watcher.failures(), [])
        let since = try await settled(counter)

        // The linked worktree's `HEAD` lives under the main repository's
        // `.git/worktrees/<name>`, the only place this checkout is written.
        XCTAssertTrue(try GitDirectory.of(runtime, worktree: linked).contains("worktrees"))
        try await git(linked, "checkout", "-q", "-b", "side-two")
        try await until("the worktree's checkout was noticed") { since() > 0 }
    }

    func testStaysQuietWhileNothingHappens() async throws {
        let root = try await repository()
        let (watcher, counter) = watching()
        await watcher.arm([WatchedRepository(key: "w-1", worktree: root, runtime: runtime)])
        let since = try await settled(counter)
        try await Task.sleep(nanoseconds: UInt64(HeadWatcher.debounceCeilingMs) * 1_000_000)
        XCTAssertEqual(since(), 0)
    }

    func testSaysWhichCheckoutItCouldNotWatchRatherThanGoingQuiet() async throws {
        let plain = try GitTestSupport.temporaryDirectory("devhub-plain-")
        cleanups.append { GitTestSupport.remove(plain) }
        let (watcher, _) = watching()
        await watcher.arm([WatchedRepository(key: "w-1", worktree: plain, runtime: runtime)])
        XCTAssertEqual(watcher.armedCount, 0)
        let failure = watcher.failures().first
        XCTAssertEqual(failure?.key, "w-1")
        XCTAssertEqual(failure?.worktree, plain)
        XCTAssertTrue(failure?.reason.contains(".git") ?? false)
    }

    func testKeepsAWatcherAReArmAskedForAgainAndDropsTheRest() async throws {
        let first = try await repository()
        let second = try await repository()
        let (watcher, counter) = watching()
        await watcher.arm([
            WatchedRepository(key: "w-1", worktree: first, runtime: runtime),
            WatchedRepository(key: "w-2", worktree: second, runtime: runtime),
        ])
        XCTAssertEqual(watcher.armedCount, 2)

        await watcher.arm([WatchedRepository(key: "w-1", worktree: first, runtime: runtime)])
        XCTAssertEqual(watcher.armedCount, 1)
        let since = try await settled(counter)

        try await git(second, "checkout", "-q", "-b", "gone")
        try await Task.sleep(nanoseconds: UInt64(HeadWatcher.debounceCeilingMs) * 1_000_000)
        XCTAssertEqual(since(), 0)

        try await git(first, "checkout", "-q", "-b", "kept")
        try await until("the kept checkout was noticed") { since() > 0 }
    }

    func testCoalescesABurstIntoOneReadWithinTheCeiling() async throws {
        let root = try await repository()
        let (watcher, counter) = watching()
        await watcher.arm([WatchedRepository(key: "w-1", worktree: root, runtime: runtime)])
        let since = try await settled(counter)
        try await git(root, "checkout", "-q", "-b", "one")
        try await git(root, "checkout", "-q", "-b", "two")
        try await git(root, "checkout", "-q", "-b", "three")
        try await until("the burst was noticed") { since() > 0 }
        try await Task.sleep(nanoseconds: UInt64(HeadWatcher.debounceCeilingMs) * 1_000_000)
        XCTAssertLessThanOrEqual(since(), 2)
    }

    func testResolvesAGitFileToTheDirectoryItNames() async throws {
        let root = try await repository()
        XCTAssertEqual(try GitDirectory.of(runtime, worktree: root), Path.join(root, ".git"))
        let plain = try GitTestSupport.temporaryDirectory("devhub-plain-")
        cleanups.append { GitTestSupport.remove(plain) }
        XCTAssertThrowsError(try GitDirectory.of(runtime, worktree: plain)) { error in
            XCTAssertEqual(failureText(error), "\(plain)/.git does not exist")
        }
        try GitTestSupport.write(Path.join(plain, ".git"), "nonsense\n")
        XCTAssertThrowsError(try GitDirectory.of(runtime, worktree: plain)) { error in
            XCTAssertEqual(failureText(error), "\(plain)/.git is not a directory and does not name one")
        }
        try GitTestSupport.write(Path.join(plain, ".git"), "gitdir:   \n")
        XCTAssertThrowsError(try GitDirectory.of(runtime, worktree: plain)) { error in
            XCTAssertEqual(failureText(error), "\(plain)/.git names an empty gitdir")
        }
        try GitTestSupport.write(Path.join(plain, ".git"), "gitdir: ../elsewhere/.git/worktrees/x\n")
        XCTAssertEqual(try GitDirectory.of(runtime, worktree: plain), GitDirectory.resolve(plain, "../elsewhere/.git/worktrees/x"))
        XCTAssertEqual(GitDirectory.resolve("/a/b", "../c/./d"), "/a/c/d")
    }
}

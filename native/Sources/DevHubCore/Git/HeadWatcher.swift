// Port of apps/desktop/src/main/shell/headWatcher.ts.
//
// Noticing a checkout instead of asking about one.
//
// Which branch is checked out changes while somebody watches — they run
// `git switch` and look at the Sidebar — so DevHub used to re-read it every two
// seconds. That is thirty-eight `git` processes a minute per workspace, to learn
// thirty-eight times that nothing moved. A checkout is an event, and the
// filesystem already has it: git writes `HEAD`.
//
// So the fast clock is gone and a watcher is in its place, with a slow safety
// poll behind it. The poll is what makes the watcher safe to be wrong about:
// an event that never arrives costs a minute of staleness, not a branch name
// that is wrong forever, and a watcher that could not be armed at all says so
// rather than quietly becoming a poll nobody knows they are running.
//
// What is watched is the git directory and its `refs/`, not the working tree.
// Which directory that is, and how it is watched, belong to the checkout's
// runtime. Everything in this file is above that line: the debounce, the
// re-arm rule and the record of what could not be watched read the same
// either way.

import Foundation

/// One checkout to watch: what to call it, and where its git directory is.
public struct WatchedRepository: Sendable {
    /// The caller's own name for it, so a re-arm can tell what is unchanged.
    public var key: String
    /// The root of the checkout — the directory whose `.git` is resolved.
    public var worktree: String
    /// The machine the checkout is on.
    public var runtime: RepositoryRuntime

    public init(key: String, worktree: String, runtime: RepositoryRuntime) {
        self.key = key
        self.worktree = worktree
        self.runtime = runtime
    }
}

/// Why one checkout is not being watched, in a sentence a person can read.
public struct WatchFailure: Equatable, Sendable {
    public var key: String
    public var worktree: String
    public var reason: String
}

/// What the repository status poller needs of a HEAD watcher, so a test can
/// stand in for the filesystem.
public protocol HeadWatching: AnyObject, Sendable {
    func arm(_ repositories: [WatchedRepository]) async
    func failures() -> [WatchFailure]
    func stop()
}

/// Every open checkout's `HEAD`, watched.
///
/// `arm` is the whole interface: it is given the set that should be watched
/// and makes that true, keeping the watchers of the checkouts that are still in
/// it and closing the ones that are not.
public final class HeadWatcher: HeadWatching, @unchecked Sendable {
    /// How long after the last filesystem event the branch is read: a single
    /// checkout is a handful of writes in a few milliseconds, and reading once
    /// at the end of them is one `git` instead of five.
    public static let debounceMs = 250

    /// The longest a burst of events may hold the read off: the number the
    /// promise "a checkout is on screen within a second" is made of.
    public static let debounceCeilingMs = 1000

    private struct Armed {
        let worktree: String
        let watch: GitDirectoryWatch
    }

    private let lock = NSLock()
    private var armed: [String: Armed] = [:]
    private var failed: [String: WatchFailure] = [:]
    /// The keys in the order they failed, for `failures()`.
    private var failureOrder: [String] = []
    private let onChange: @Sendable () -> Void
    private let queue = DispatchQueue(label: "devhub.head-watcher")
    private var timer: DispatchWorkItem?
    /// When the burst now being coalesced started, for the ceiling.
    private var burstStartedAt: DispatchTime?
    private var stopped = false

    public init(onChange: @escaping @Sendable () -> Void) {
        self.onChange = onChange
    }

    /// Watch exactly these checkouts.
    ///
    /// A checkout already armed under the same key and worktree is left alone —
    /// re-arming it would tear down a working watcher and take a window in
    /// which a checkout goes unseen — and anything else is closed and armed
    /// again.
    public func arm(_ repositories: [WatchedRepository]) async {
        if isStopped { return }
        var wanted: [String: WatchedRepository] = [:]
        var order: [String] = []
        for repository in repositories {
            if wanted[repository.key] == nil { order.append(repository.key) }
            wanted[repository.key] = repository
        }
        let toClose: [GitDirectoryWatch] = locked {
            var closing: [GitDirectoryWatch] = []
            for (key, entry) in armed where wanted[key]?.worktree != entry.worktree {
                closing.append(entry.watch)
                armed[key] = nil
            }
            return closing
        }
        for watch in toClose { watch.close() }
        for key in order {
            guard let repository = wanted[key] else { continue }
            let already = locked { armed[key] != nil }
            if already { continue }
            locked {
                failed[key] = nil
                failureOrder.removeAll { $0 == key }
            }
            do {
                let watch = try await repository.runtime.watchGitDirectory(worktree: repository.worktree) { [weak self] in
                    self?.touched()
                }
                let keep: Bool = locked {
                    if stopped { return false }
                    armed[key] = Armed(worktree: repository.worktree, watch: watch)
                    return true
                }
                if !keep { watch.close() }
            } catch {
                // Not a swallow: a checkout that cannot be watched is exactly
                // what this class is asked about, and the caller shows it. The
                // safety poll keeps the branch true meanwhile.
                locked {
                    failed[key] = WatchFailure(key: key, worktree: repository.worktree, reason: CodedFailure.text(of: error))
                    failureOrder.append(key)
                }
            }
        }
    }

    /// The checkouts that are not being watched, and why.
    public func failures() -> [WatchFailure] {
        locked { failureOrder.compactMap { failed[$0] } }
    }

    /// How many checkouts are watched right now.
    public var armedCount: Int { locked { armed.count } }

    public func stop() {
        let closing: [GitDirectoryWatch] = locked {
            stopped = true
            let all = armed.values.map(\.watch)
            armed = [:]
            timer?.cancel()
            timer = nil
            burstStartedAt = nil
            return all
        }
        for watch in closing { watch.close() }
    }

    private var isStopped: Bool { locked { stopped } }

    /// Something under a git directory moved.
    ///
    /// Coalesced twice over: the read happens once the writing stops, and once
    /// a second has passed however long the writing goes on for.
    private func touched() {
        locked {
            if stopped { return }
            let now = DispatchTime.now()
            let started = burstStartedAt ?? now
            burstStartedAt = started
            let elapsedMs = Int((now.uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000)
            let wait = max(0, min(Self.debounceMs, Self.debounceCeilingMs - elapsedMs))
            timer?.cancel()
            let item = DispatchWorkItem { [weak self] in self?.fire() }
            timer = item
            queue.asyncAfter(deadline: now + .milliseconds(wait), execute: item)
        }
    }

    private func fire() {
        let go: Bool = locked {
            if stopped { return false }
            timer = nil
            burstStartedAt = nil
            return true
        }
        if go { onChange() }
    }

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}

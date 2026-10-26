// Port of apps/desktop/src/main/runtime/gitDirectory.ts, and of the local
// half of `Runtime.watchGitDirectory` (main/runtime/local.ts).
//
// Where a checkout keeps `HEAD`.
//
// `.git` is a directory in an ordinary clone and a file holding `gitdir: …` in
// a linked worktree, where the real one is `<main>/.git/worktrees/<name>` — and
// that is the directory whose `HEAD` a checkout in *that* worktree rewrites.
// Reading the file rather than running `git rev-parse --git-dir` keeps this off
// the process budget the watcher exists to cut.

import Foundation
#if canImport(CoreServices)
import CoreServices
#endif

/// A failure to find a checkout's git directory, in a sentence naming `.git`.
public struct GitDirectoryError: Error, Equatable, Sendable, CustomStringConvertible {
    public let message: String
    public var description: String { message }
}

public enum GitDirectory {
    /// A `.git` file naming a gitdir is a line, not a document.
    static let maxMarkerBytes = 4096

    public static func of(_ runtime: RepositoryRuntime, worktree: String) throws -> String {
        let dotGit = Path.join(worktree, ".git")
        let kind = try runtime.stat(dotGit)
        if kind == .directory { return dotGit }
        if kind == .absent { throw GitDirectoryError(message: "\(dotGit) does not exist") }
        let text = try runtime.readTextFile(dotGit, maxBytes: maxMarkerBytes)
        let line = (text.split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init) ?? "").jsTrimmed
        guard line.hasPrefix("gitdir:") else {
            throw GitDirectoryError(message: "\(dotGit) is not a directory and does not name one")
        }
        let target = String(line.dropFirst("gitdir:".count)).jsTrimmed
        if target.isEmpty { throw GitDirectoryError(message: "\(dotGit) names an empty gitdir") }
        return target.hasPrefix("/") ? target : resolve(worktree, target)
    }

    /// Node's `path.resolve(base, relative)` for a relative `relative`: joined
    /// and normalised (`.` and `..` folded), never touching the filesystem.
    static func resolve(_ base: String, _ relative: String) -> String {
        let joined = relative.hasPrefix("/") ? relative : base + "/" + relative
        var parts: [Substring] = []
        for part in joined.split(separator: "/") {
            if part == "." || part.isEmpty { continue }
            if part == ".." { if !parts.isEmpty { parts.removeLast() }; continue }
            parts.append(part)
        }
        return "/" + parts.joined(separator: "/")
    }
}

// MARK: - Watching a git directory on this machine

/// The git directory's own entries (`HEAD`, `packed-refs`, …) and everything
/// under its `refs/`, watched: FSEvents on macOS, a cheap `stat` poll
/// elsewhere. Never the working tree, and never `objects/`.
final class LocalGitDirectoryWatch: GitDirectoryWatch, @unchecked Sendable {
    private let lock = NSLock()
    private var closed = false
    private let onChange: @Sendable () -> Void
    private let queue = DispatchQueue(label: "devhub.git-directory-watch")
    private var timer: DispatchSourceTimer?
    private var lastSignature: [String: String] = [:]
    private let gitDirectory: String
    #if canImport(CoreServices)
    private var stream: FSEventStreamRef?
    private var realGitDirectory: String = ""
    #endif

    private init(gitDirectory: String, onChange: @escaping @Sendable () -> Void) {
        self.gitDirectory = gitDirectory
        self.onChange = onChange
    }

    static func start(gitDirectory: String, pollMs: Int, onChange: @escaping @Sendable () -> Void) throws -> LocalGitDirectoryWatch {
        // The git directory must be there to be watched. Its `refs/` may not
        // be: a linked worktree's record holds only the refs that are its own
        // (bisect, rewritten), and older gits make none until one is written —
        // whatever appears there later is seen either way.
        if try LocalFiles.stat(gitDirectory) != .directory {
            throw GitDirectoryError(message: "\(gitDirectory) is not a directory DevHub can watch")
        }
        let watch = LocalGitDirectoryWatch(gitDirectory: gitDirectory, onChange: onChange)
        #if canImport(CoreServices)
        try watch.startEvents()
        #else
        watch.startPolling(pollMs: pollMs)
        #endif
        return watch
    }

    func close() {
        lock.lock()
        guard !closed else { lock.unlock(); return }
        closed = true
        let timer = self.timer
        self.timer = nil
        #if canImport(CoreServices)
        let stream = self.stream
        self.stream = nil
        #endif
        lock.unlock()
        timer?.cancel()
        #if canImport(CoreServices)
        if let stream {
            FSEventStreamStop(stream)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
        }
        #endif
    }

    deinit { close() }

    private var isClosed: Bool {
        lock.lock(); defer { lock.unlock() }
        return closed
    }

    fileprivate func fire() {
        if !isClosed { onChange() }
    }

    // MARK: Polling

    private func startPolling(pollMs: Int) {
        lastSignature = signature()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + .milliseconds(pollMs), repeating: .milliseconds(max(10, pollMs)))
        timer.setEventHandler { [weak self] in self?.poll() }
        lock.lock(); self.timer = timer; lock.unlock()
        timer.resume()
    }

    private func poll() {
        let now = signature()
        if now != lastSignature {
            lastSignature = now
            fire()
        }
    }

    /// What the watched entries look like now: identity, size and mtime of
    /// each direct child of the git directory, and of everything under `refs/`.
    private func signature() -> [String: String] {
        var result: [String: String] = [:]
        let fm = FileManager.default
        func record(_ path: String) {
            var info = stat()
            guard lstat(path, &info) == 0 else { return }
            #if canImport(Darwin)
            let mtime = "\(info.st_mtimespec.tv_sec).\(info.st_mtimespec.tv_nsec)"
            #else
            let mtime = "\(info.st_mtim.tv_sec).\(info.st_mtim.tv_nsec)"
            #endif
            result[path] = "\(info.st_ino):\(info.st_size):\(mtime)"
        }
        record(gitDirectory)
        for name in (try? fm.contentsOfDirectory(atPath: gitDirectory)) ?? [] where name != "objects" {
            record(Path.join(gitDirectory, name))
        }
        let refs = Path.join(gitDirectory, "refs")
        if let walker = fm.enumerator(atPath: refs) {
            while let relative = walker.nextObject() as? String {
                record(Path.join(refs, relative))
            }
        }
        return result
    }

    // MARK: FSEvents

    #if canImport(CoreServices)
    private func startEvents() throws {
        realGitDirectory = Self.realPath(gitDirectory)
        var context = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passUnretained(self).toOpaque(),
            retain: nil,
            release: nil,
            copyDescription: nil
        )
        let callback: FSEventStreamCallback = { _, info, count, paths, _, _ in
            guard let info else { return }
            let watch = Unmanaged<LocalGitDirectoryWatch>.fromOpaque(info).takeUnretainedValue()
            let names = paths.assumingMemoryBound(to: UnsafeMutablePointer<CChar>.self)
            var relevant = false
            for index in 0..<count where watch.isRelevant(String(cString: names[index])) {
                relevant = true
                break
            }
            if relevant { watch.fire() }
        }
        let flags = FSEventStreamCreateFlags(kFSEventStreamCreateFlagNoDefer | kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagWatchRoot)
        guard let stream = FSEventStreamCreate(
            kCFAllocatorDefault,
            callback,
            &context,
            [realGitDirectory] as CFArray,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            0.02,
            flags
        ) else {
            throw GitDirectoryError(message: "\(gitDirectory) could not be watched")
        }
        FSEventStreamSetDispatchQueue(stream, queue)
        guard FSEventStreamStart(stream) else {
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
            throw GitDirectoryError(message: "\(gitDirectory) could not be watched")
        }
        lock.lock(); self.stream = stream; lock.unlock()
    }

    /// The git directory's own entries and anything under `refs/`; not
    /// `objects/`, which a fetch writes thousands of times.
    fileprivate func isRelevant(_ path: String) -> Bool {
        let root = realGitDirectory
        if path == root || path == root + "/" { return true }
        guard path.hasPrefix(root + "/") else { return false }
        let rest = path.dropFirst(root.count + 1)
        if rest.hasPrefix("refs/") || rest == "refs" { return true }
        return !rest.contains("/")
    }

    private static func realPath(_ path: String) -> String {
        guard let resolved = realpath(path, nil) else { return path }
        defer { free(resolved) }
        return String(cString: resolved)
    }
    #endif
}

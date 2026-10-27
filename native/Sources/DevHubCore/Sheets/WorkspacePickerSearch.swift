// Port of apps/desktop/src/main/shell/workspacePicker.ts, and of the pool in
// apps/desktop/src/shell/components/shell/WorkspacePicker.tsx.
//
// The workspace picker's search. `settings.toml` lists where a workspace can
// come from: directories to walk, commands that print paths, and dated
// folders. This runs those sources for one query and streams what it finds,
// so the sheet fills in as results arrive rather than waiting for the slowest
// source.
//
// Two rules keep it from being a hazard. A source is *configured*, so it is
// trusted to name paths but never to be fast: every walk is depth-bounded and
// every command has a timeout it cannot exceed. And a run ends with its task:
// cancelling it stops the walk between directories and kills a command that
// is still running.

import Foundation

/// One thing a run says, in the order it says it.
public enum WorkspacePickerEvent: Equatable, Sendable {
    case started(sourceCount: Int)
    case candidate(WorkspacePickerCandidate)
    case sourceError(sourceId: String, errorCount: Int, truncated: Bool)
    case sourceCompleted(sourceId: String, candidateCount: Int, errorCount: Int)
    case completed(candidateCount: Int, errorCount: Int, truncated: Bool)
    case cancelled
}

/// One folder a source offers.
public struct WorkspacePickerCandidate: Equatable, Sendable {
    public var path: String
    public var label: String
    public var score: Double
    public var sourceId: String
    /// The source's place in `workspace_sources`: the order the person wrote.
    public var sourceRank: Int
    /// The folder is not there yet, and choosing this row makes it.
    public var missing: Bool
    public var worktree: Bool

    public init(path: String, label: String, score: Double, sourceId: String, sourceRank: Int, missing: Bool, worktree: Bool) {
        self.path = path
        self.label = label
        self.score = score
        self.sourceId = sourceId
        self.sourceRank = sourceRank
        self.missing = missing
        self.worktree = worktree
    }
}

/// What a run looks at on disk; a test's own.
public protocol PickerFileSystem: Sendable {
    func isDirectory(_ path: String) -> Bool
    /// The names of the directories in `path`, in the order the disk lists them.
    func directories(in path: String) throws -> [String]
    /// What kind of git checkout `path` is (a `.git` directory or a `.git` file).
    func checkout(_ path: String) -> WorkspaceKind?
}

public struct LocalPickerFileSystem: PickerFileSystem {
    public init() {}

    public func isDirectory(_ path: String) -> Bool {
        var directory: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &directory) && directory.boolValue
    }

    public func directories(in path: String) throws -> [String] {
        let names = try FileManager.default.contentsOfDirectory(atPath: path)
        return names.filter { name in
            // `withFileTypes` + `isDirectory()`: a symlink to a folder is not
            // walked into, as Node's dirent says it is a link.
            var info = stat()
            guard lstat(Path.join(path, name), &info) == 0 else { return false }
            return (info.st_mode & S_IFMT) == S_IFDIR
        }.sorted()
    }

    public func checkout(_ path: String) -> WorkspaceKind? {
        var info = stat()
        guard stat(Path.join(path, ".git"), &info) == 0 else { return nil }
        return (info.st_mode & S_IFMT) == S_IFDIR ? .gitRepository : .gitWorktree
    }
}

public enum WorkspacePickerSearch {
    static let maxCandidates = 1000
    static let maxStderrBytes = 16 * 1024

    /// `expandHome`.
    public static func expandHome(_ path: String, home: String) -> String {
        if path == "~" { return home }
        if path.hasPrefix("~/") { return Path.join(home, String(path.dropFirst(2))) }
        return path
    }

    /// One run for `query`: every source at once, each offering in its own
    /// order. Ends with `completed`, or `cancelled` when its task was.
    public static func run(
        _ config: Config, query: String, now: Date = Date(), home: String = NSHomeDirectory(),
        environment: [String: String] = ProcessInfo.processInfo.environment,
        files: any PickerFileSystem = LocalPickerFileSystem(),
        emit: @escaping @Sendable (WorkspacePickerEvent) -> Void
    ) async {
        let state = RunState()
        emit(.started(sourceCount: config.workspaceSources.count))
        await withTaskGroup(of: Void.self) { group in
            for (rank, source) in config.workspaceSources.enumerated() {
                group.addTask {
                    await runSource(
                        source, rank: rank, query: query, now: now, home: home, environment: environment, files: files,
                        state: state, emit: emit)
                }
            }
        }
        if Task.isCancelled {
            emit(.cancelled)
            return
        }
        let counts = state.counts()
        emit(.completed(candidateCount: counts.candidates, errorCount: counts.errors, truncated: counts.truncated))
    }

    private static func runSource(
        _ source: WorkspaceSource, rank: Int, query: String, now: Date, home: String, environment: [String: String],
        files: any PickerFileSystem, state: RunState, emit: @escaping @Sendable (WorkspacePickerEvent) -> Void
    ) async {
        // The `seen` set is per source: a path two sources both name is offered
        // by both, and the pool keeps it under the earlier one.
        let seen = Guarded(Set<String>())
        let offer: @Sendable (String, String, Bool) -> Void = { path, label, missing in
            if Task.isCancelled { return }
            if seen.with({ $0.contains(path) }) { return }
            guard state.admit() else { return }
            let value = Fuzzy.score(path, query)
            if value == 0 {
                state.unadmit()
                return
            }
            _ = seen.with { $0.insert(path) }
            // A folder that is not there yet is no checkout of anything.
            let worktree = !missing && files.checkout(path) == .gitWorktree
            emit(.candidate(WorkspacePickerCandidate(
                path: path, label: label, score: value, sourceId: source.id, sourceRank: rank, missing: missing,
                worktree: worktree)))
        }
        do {
            switch source {
            case let .filesystem(filesystem):
                try walk(filesystem, home: home, files: files, offer: offer)
            case let .date(date):
                let path = expandHome(DateTemplate.expand(date.path, now: now), home: home)
                let label = Worktrees.baseName(path).isEmpty ? path : Worktrees.baseName(path)
                if files.isDirectory(path) {
                    offer(path, label, false)
                } else if date.createIfMissing {
                    offer(path, label, true)
                }
            case let .command(command):
                try await runCommand(command, environment: environment, state: state, offer: offer)
            }
        } catch {
            if Task.isCancelled { return }
            // A source that cannot be read is one source failing, not the search.
            let errors = state.failed()
            emit(.sourceError(sourceId: source.id, errorCount: errors, truncated: state.counts().truncated))
            return
        }
        if Task.isCancelled { return }
        let counts = state.counts()
        emit(.sourceCompleted(sourceId: source.id, candidateCount: counts.candidates, errorCount: counts.errors))
    }

    struct SourceFailure: Error, CustomStringConvertible {
        let description: String
    }

    private static func matchesKind(_ path: String, _ kinds: [WorkspaceKind], files: any PickerFileSystem) -> Bool {
        if kinds.contains(.directory) { return true }
        guard let checkout = files.checkout(path) else { return false }
        return kinds.contains(checkout)
    }

    static func walk(
        _ source: FilesystemSource, home: String, files: any PickerFileSystem, offer: @Sendable (String, String, Bool) -> Void
    ) throws {
        let root = expandHome(source.path, home: home)
        let maxDepth = Int(source.maxDepth ?? source.minDepth)
        let minDepth = Int(source.minDepth)
        let excluded = Set(source.excludeNames)
        guard files.isDirectory(root) else {
            throw SourceFailure(description: "workspace source root is not a directory: \(source.id)")
        }
        func visit(_ directory: String, _ depth: Int) {
            if Task.isCancelled || depth > maxDepth { return }
            // One unreadable directory does not end the walk.
            guard let names = try? files.directories(in: directory) else { return }
            for name in names {
                if Task.isCancelled { return }
                if excluded.contains(name) { continue }
                if !source.includeHidden && name.hasPrefix(".") { continue }
                let path = Path.join(directory, name)
                if depth >= minDepth && matchesKind(path, source.kinds, files: files) {
                    offer(path, name, false)
                }
                visit(path, depth + 1)
            }
        }
        visit(root, 1)
    }

    static func runCommand(
        _ source: CommandSource, environment: [String: String], state: RunState,
        offer: @Sendable (String, String, Bool) -> Void
    ) async throws {
        guard let program = source.command.first, !program.isEmpty else {
            throw SourceFailure(description: "workspace source has no command: \(source.id)")
        }
        let answer = try await BoundedExec.run(
            argv: source.command, cwd: nil, environment: environment, timeoutMs: Int(source.timeoutMs),
            limits: ExecLimits(stdoutBytes: 4 * 1024 * 1024, stderrBytes: maxStderrBytes))
        state.stderr(answer.stderr.count)
        guard answer.code == 0 else {
            throw SourceFailure(description: "workspace source exited with \(answer.code.map(String.init) ?? answer.signal ?? "?")")
        }
        for line in answer.stdoutText.split(separator: "\n", omittingEmptySubsequences: false) {
            let path = line.trimmingCharacters(in: .whitespaces)
            if path.isEmpty || !path.hasPrefix("/") { continue }
            let base = Worktrees.baseName(path)
            offer(path, base.isEmpty ? path : base, false)
        }
    }

    /// `collectParentDirectories`: every folder a workspace could be created
    /// *beside*, from the same sources, in the sources' order. Throws
    /// `CancellationError` when cancelled: a short list would look complete.
    public static func parentDirectories(
        _ config: Config, now: Date = Date(), home: String = NSHomeDirectory(),
        environment: [String: String] = ProcessInfo.processInfo.environment,
        files: any PickerFileSystem = LocalPickerFileSystem()
    ) async throws -> [String] {
        let found = Guarded<[(path: String, rank: Int, sequence: Int)]>([])
        let cancelled = Guarded(false)
        await run(config, query: "", now: now, home: home, environment: environment, files: files) { event in
            switch event {
            case let .candidate(candidate):
                found.with { $0.append((candidate.path, candidate.sourceRank, $0.count)) }
            case .cancelled:
                cancelled.with { $0 = true }
            default: break
            }
        }
        if cancelled.with({ $0 }) || Task.isCancelled { throw CancellationError() }
        let ordered = found.with { $0 }.sorted { $0.rank == $1.rank ? $0.sequence < $1.sequence : $0.rank < $1.rank }
        var parents: [String] = []
        var seen = Set<String>()
        for candidate in ordered {
            let parent = Worktrees.parentDirectory(candidate.path)
            // A workspace at the root has no folder above it to clone into.
            if parent == candidate.path || seen.contains(parent) { continue }
            seen.insert(parent)
            parents.append(parent)
        }
        return parents
    }
}

/// One run's counters, shared by its sources.
final class RunState: @unchecked Sendable {
    private let lock = NSLock()
    private var candidates = 0
    private var errors = 0
    private var stderrBytes = 0
    private var truncated = false

    /// Room for one more candidate; false (and truncated) past the cap.
    func admit() -> Bool {
        lock.withLock {
            if candidates >= WorkspacePickerSearch.maxCandidates {
                truncated = true
                return false
            }
            candidates += 1
            return true
        }
    }

    func unadmit() { lock.withLock { candidates -= 1 } }

    func failed() -> Int { lock.withLock { errors += 1; return errors } }

    func stderr(_ bytes: Int) {
        lock.withLock { stderrBytes = min(WorkspacePickerSearch.maxStderrBytes, stderrBytes + bytes) }
    }

    func counts() -> (candidates: Int, errors: Int, truncated: Bool) {
        lock.withLock { (candidates, errors, truncated) }
    }
}

/// Everything any round of the picker has found, in the order Settings put
/// its sources in (`WorkspacePicker.tsx`'s pool). It only ever grows for as
/// long as the sheet stands: typing re-runs the search, but the rows already
/// on screen are still true.
public struct WorkspacePickerPool: Equatable, Sendable {
    public private(set) var candidates: [WorkspacePickerCandidate] = []

    public init() {}

    /// A candidate arrived: new paths join; a path two sources name belongs to
    /// the earlier one. Sorted by rank alone, stably, so each source's rows
    /// keep the order that source produced them. Returns whether it changed.
    @discardableResult
    public mutating func add(_ candidate: WorkspacePickerCandidate) -> Bool {
        if let index = candidates.firstIndex(where: { $0.path == candidate.path }) {
            guard candidate.sourceRank < candidates[index].sourceRank else { return false }
            candidates[index].sourceRank = candidate.sourceRank
        } else {
            candidates.append(candidate)
        }
        candidates = candidates.enumerated().sorted { left, right in
            left.element.sourceRank != right.element.sourceRank
                ? left.element.sourceRank < right.element.sourceRank : left.offset < right.offset
        }.map(\.element)
        return true
    }

    public func candidate(_ path: String) -> WorkspacePickerCandidate? { candidates.first { $0.path == path } }

    /// The rows, as the picker draws them.
    public var items: [PickerItem] {
        candidates.map { candidate in
            PickerItem(
                id: candidate.path, label: candidate.label,
                // A row that is an offer to make it says so where every other
                // row says where it is.
                detail: .path(candidate.path, suffix: candidate.missing ? " — not created yet" : nil),
                searchText: candidate.path, glyph: .folder, worktree: candidate.worktree)
        }
    }
}

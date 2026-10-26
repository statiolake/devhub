// The machine a checkout is on, as git, the HEAD watcher and the repository
// status poller need to see it.
//
// Port of the parts of apps/desktop/src/main/runtime/runtime.ts (and the local
// arm, main/runtime/local.ts) that WP4's files call: `exec` with a deadline,
// a cancellation and output caps (`runBounded` in main/terminal/command.ts),
// `stat` / `readTextFile` / `makeDirectory` / `removeTree`,
// `watchGitDirectory`, `cadence` and `reading().connected`. The whole Runtime
// (PTYs, launchers, forwards, the remote arm) is WP3's and WP12's; a WP3
// runtime conforms to this protocol to carry its git.

import Foundation
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif

/// What `stat` answers about a path. Not-there is an answer (`absent`); a
/// path that could not be looked at throws `RuntimeFileError`.
public enum RuntimeFileKind: String, Sendable, Equatable {
    case absent, directory, file, other
}

/// A path DevHub could not look at, with the errno that said why.
///
/// The split this file is built on: `ENOENT` and `ENOTDIR` mean the path is
/// not there, which is an answer; every other errno — `EACCES` on a parent
/// whose permissions changed, `EIO` on a failing disk — means DevHub could not
/// find out, and that is a failure that travels with its code.
public struct RuntimeFileError: Error, Equatable, Sendable, CustomStringConvertible {
    public let path: String
    /// The errno's name: `EACCES`, `EIO`, …
    public let code: String

    public init(path: String, code: String) {
        self.path = path
        self.code = code
    }

    public var description: String { "\(code): \(path)" }
}

/// What a loop over one machine is allowed to cost (`RuntimeCadence`, the
/// repository half).
public struct RepositoryCadence: Sendable, Equatable {
    /// How often the slow round and the safety branch round run.
    public var repositoryPollMs: Int
    /// How recently a full round must have finished for a focus to skip one.
    public var repositoryFocusRefreshMinIntervalMs: Int
    /// `nil`: real filesystem events, not a poll.
    public var headWatchPollMs: Int?

    public init(repositoryPollMs: Int, repositoryFocusRefreshMinIntervalMs: Int, headWatchPollMs: Int?) {
        self.repositoryPollMs = repositoryPollMs
        self.repositoryFocusRefreshMinIntervalMs = repositoryFocusRefreshMinIntervalMs
        self.headWatchPollMs = headWatchPollMs
    }

    /// This Mac's numbers (`LOCAL_CADENCE`, repository half).
    public static let local = RepositoryCadence(
        repositoryPollMs: 60 * 1000,
        repositoryFocusRefreshMinIntervalMs: RepositoryCadenceRules.focusRefreshMinIntervalMs,
        headWatchPollMs: nil
    )
}

/// The repository rules of apps/desktop/src/main/runtime/cadence.ts.
public enum RepositoryCadenceRules {
    /// How recently a full round must have finished for a focus to skip its
    /// own, on this Mac.
    ///
    /// Ten seconds, because that is the longest a person who has just come back
    /// would call the row "current" and the shortest that stops a rapid
    /// tab-dance from turning into traffic.
    public static let focusRefreshMinIntervalMs = 10_000

    /// The same rule for a machine across a network: half a minute is the
    /// answer to "how stale may a remote row be when I come back".
    public static let remoteFocusRefreshMinIntervalMs = 30_000

    /// How long a lookup started from the picker may run before it is refused.
    ///
    /// Twenty seconds: longer than a cold `git` on a large checkout and shorter
    /// than a person's patience, and when it expires the sheet says so in a
    /// sentence rather than going on spinning.
    public static let lookupDeadlineMs = 20_000
}

/// One command's answer: exit code or signal, and what it wrote (capped).
public struct ExecAnswer: Sendable, Equatable {
    /// `nil` when the child was stopped by a signal.
    public var code: Int32?
    /// The signal's name (`SIGTERM`) when it was stopped by one.
    public var signal: String?
    public var stdout: Data
    public var stderr: Data

    public init(code: Int32?, signal: String?, stdout: Data, stderr: Data) {
        self.code = code
        self.signal = signal
        self.stdout = stdout
        self.stderr = stderr
    }

    public var stdoutText: String { String(decoding: stdout, as: UTF8.self) }
    public var stderrText: String { String(decoding: stderr, as: UTF8.self) }
}

/// The ways an exec did not get as far as an answer (`PortFailure`).
public enum ExecFailure: Error, Equatable, Sendable, CustomStringConvertible {
    /// The program could not be started: the system's own reason.
    case unavailable(String)
    /// The deadline passed and the child was killed.
    case timedOut

    public var description: String {
        switch self {
        case .unavailable(let reason): return reason
        case .timedOut: return "the command timed out"
        }
    }
}

/// Output caps, and what a longer answer is: truncation, the way git's
/// `GIT_LIMITS` reads a prefix.
public struct ExecLimits: Sendable, Equatable {
    public var stdoutBytes: Int
    public var stderrBytes: Int

    public init(stdoutBytes: Int, stderrBytes: Int) {
        self.stdoutBytes = stdoutBytes
        self.stderrBytes = stderrBytes
    }
}

/// A watch on one checkout's git directory. `close` is idempotent.
public protocol GitDirectoryWatch: AnyObject, Sendable {
    func close()
}

/// The machine a checkout is on, as WP4 needs it.
public protocol RepositoryRuntime: Sendable {
    /// `local`, `ssh:<host>`: what makes two runtimes the same machine.
    var id: String { get }
    var cadence: RepositoryCadence { get }
    /// Whether the machine is answering (`reading().connected`).
    var isConnected: Bool { get }

    /// Run `argv` (no shell) and answer with what it did. Throws
    /// `ExecFailure` when it never answered, and `CancellationError` when the
    /// task running it was cancelled (the child is killed either way).
    func exec(
        argv: [String],
        cwd: String?,
        environment: [String: String],
        timeoutMs: Int,
        limits: ExecLimits
    ) async throws -> ExecAnswer

    func stat(_ path: String) throws -> RuntimeFileKind
    func readTextFile(_ path: String, maxBytes: Int) throws -> String
    func makeDirectory(_ path: String) throws
    func removeTree(_ path: String) throws

    /// Watch the git directory of the checkout rooted at `worktree` (and its
    /// `refs/`), calling `onChange` whenever something under it moves.
    func watchGitDirectory(worktree: String, onChange: @escaping @Sendable () -> Void) async throws -> GitDirectoryWatch
}

// MARK: - This machine

/// This Mac (or this Linux box, in tests), behind `RepositoryRuntime`.
public struct LocalRepositoryRuntime: RepositoryRuntime {
    public let id = "local"
    public var cadence: RepositoryCadence
    public var isConnected: Bool { true }
    /// How often a checkout is polled when the platform has no file events
    /// DevHub uses (Linux). macOS uses FSEvents.
    public var watchPollMs: Int

    public init(cadence: RepositoryCadence = .local, watchPollMs: Int = 100) {
        self.cadence = cadence
        self.watchPollMs = watchPollMs
    }

    public func exec(
        argv: [String],
        cwd: String?,
        environment: [String: String],
        timeoutMs: Int,
        limits: ExecLimits
    ) async throws -> ExecAnswer {
        try await BoundedExec.run(argv: argv, cwd: cwd, environment: environment, timeoutMs: timeoutMs, limits: limits)
    }

    public func stat(_ path: String) throws -> RuntimeFileKind {
        try LocalFiles.stat(path)
    }

    public func readTextFile(_ path: String, maxBytes: Int) throws -> String {
        guard let handle = FileHandle(forReadingAtPath: path) else {
            throw RuntimeFileError(path: path, code: LocalFiles.errnoName(errno == 0 ? EACCES : errno))
        }
        defer { try? handle.close() }
        let data = (try? handle.read(upToCount: maxBytes)) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }

    public func makeDirectory(_ path: String) throws {
        do {
            try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        } catch {
            throw RuntimeFileError(path: path, code: LocalFiles.code(of: error))
        }
    }

    public func removeTree(_ path: String) throws {
        if try stat(path) == .absent { return }
        do {
            try FileManager.default.removeItem(atPath: path)
        } catch {
            throw RuntimeFileError(path: path, code: LocalFiles.code(of: error))
        }
    }

    /// The git directory and its `refs/`, watched.
    ///
    /// The git directory itself, not `HEAD`: git replaces `HEAD` by writing a
    /// temporary file and renaming it over the old one, and a watcher on the
    /// file follows the inode that was renamed away. The directory sees the
    /// rename, and sees `packed-refs` too.
    public func watchGitDirectory(worktree: String, onChange: @escaping @Sendable () -> Void) async throws -> GitDirectoryWatch {
        let gitDirectory = try GitDirectory.of(self, worktree: worktree)
        return try LocalGitDirectoryWatch.start(gitDirectory: gitDirectory, pollMs: watchPollMs, onChange: onChange)
    }
}

enum LocalFiles {
    static func stat(_ path: String) throws -> RuntimeFileKind {
        let (type, failure) = statMode(path)
        if let type {
            if type == S_IFDIR { return .directory }
            if type == S_IFREG { return .file }
            return .other
        }
        if failure == ENOENT || failure == ENOTDIR { return .absent }
        throw RuntimeFileError(path: path, code: errnoName(failure))
    }

    static func code(of error: Error) -> String {
        let ns = error as NSError
        if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError, underlying.domain == NSPOSIXErrorDomain {
            return errnoName(Int32(underlying.code))
        }
        if ns.domain == NSPOSIXErrorDomain { return errnoName(Int32(ns.code)) }
        return ns.localizedDescription
    }

    static func errnoName(_ value: Int32) -> String {
        switch value {
        case ENOENT: return "ENOENT"
        case ENOTDIR: return "ENOTDIR"
        case EACCES: return "EACCES"
        case EPERM: return "EPERM"
        case EIO: return "EIO"
        case EEXIST: return "EEXIST"
        case ENOTEMPTY: return "ENOTEMPTY"
        case ELOOP: return "ELOOP"
        case ENAMETOOLONG: return "ENAMETOOLONG"
        case EISDIR: return "EISDIR"
        case EBUSY: return "EBUSY"
        case EROFS: return "EROFS"
        default: return "errno \(value)"
        }
    }
}

// MARK: - Running a bounded command

/// `runBounded`, for this machine: argv (never a shell), a deadline, output
/// caps that truncate, Task cancellation that kills the child, and the signal
/// that stopped it when one did.
public enum BoundedExec {
    public static func run(
        argv: [String],
        cwd: String?,
        environment: [String: String],
        timeoutMs: Int,
        limits: ExecLimits
    ) async throws -> ExecAnswer {
        guard let file = argv.first else { throw ExecFailure.unavailable("nothing to run") }
        try Task.checkCancellation()
        let executable: String
        if file.contains("/") {
            executable = file
        } else if let found = ProcessRunner.resolveExecutable(file, searchPath: environment["PATH"] ?? "") {
            executable = found
        } else {
            // What Node says for a program not on PATH, which names the fix.
            throw ExecFailure.unavailable("spawn \(file) ENOENT")
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = Array(argv.dropFirst())
        process.environment = environment
        if let cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        let outPipe = Pipe(), errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe
        process.standardInput = FileHandle(forReadingAtPath: "/dev/null")

        let collector = CappedCollector(limits: limits)
        outPipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if !chunk.isEmpty { collector.append(out: chunk) }
        }
        errPipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if !chunk.isEmpty { collector.append(err: chunk) }
        }
        let exit = ExitLatch()
        process.terminationHandler = { finished in
            exit.fire(status: finished.terminationStatus, signalled: finished.terminationReason == .uncaughtSignal)
        }
        if let cwd, (try? LocalFiles.stat(cwd)) != .directory {
            outPipe.fileHandleForReading.readabilityHandler = nil
            errPipe.fileHandleForReading.readabilityHandler = nil
            throw ExecFailure.unavailable("spawn \(file) ENOENT (no such directory: \(cwd))")
        }
        do {
            try process.run()
        } catch {
            outPipe.fileHandleForReading.readabilityHandler = nil
            errPipe.fileHandleForReading.readabilityHandler = nil
            throw ExecFailure.unavailable("spawn \(file) \(LocalFiles.code(of: error))")
        }

        let child = ChildBox(process)
        let stop = StopReason()
        let watchdog = Task.detached {
            try await Task.sleep(nanoseconds: UInt64(max(0, timeoutMs)) * 1_000_000)
            stop.set(.timedOut)
            child.terminate()
            exit.abandon()
        }
        let (status, signalled) = await withTaskCancellationHandler {
            await exit.wait()
        } onCancel: {
            stop.set(.cancelled)
            child.terminate()
            // Not waited for: on Linux, Foundation learns of an exit only once
            // every inherited copy of its watch descriptor is closed, and a
            // grandchild may hold one for as long as it likes.
            exit.abandon()
        }
        watchdog.cancel()

        outPipe.fileHandleForReading.readabilityHandler = nil
        errPipe.fileHandleForReading.readabilityHandler = nil
        // Whatever arrived between the last handler call and the exit — read
        // without blocking, because a grandchild (`sh -c "sleep 30"`'s sleep)
        // may hold the pipe open long after the child itself has gone.
        if stop.value == nil {
            collector.append(out: drainWithoutBlocking(outPipe.fileHandleForReading))
            collector.append(err: drainWithoutBlocking(errPipe.fileHandleForReading))
        }
        try? outPipe.fileHandleForReading.close()
        try? errPipe.fileHandleForReading.close()

        switch stop.value {
        case .cancelled: throw CancellationError()
        case .timedOut: throw ExecFailure.timedOut
        case nil: break
        }
        let (out, err) = collector.snapshot()
        return ExecAnswer(
            code: signalled ? nil : status,
            signal: signalled ? signalName(status) : nil,
            stdout: out,
            stderr: err
        )
    }

    static func signalName(_ number: Int32) -> String {
        switch number {
        case SIGTERM: return "SIGTERM"
        case SIGKILL: return "SIGKILL"
        case SIGINT: return "SIGINT"
        case SIGHUP: return "SIGHUP"
        case SIGQUIT: return "SIGQUIT"
        case SIGABRT: return "SIGABRT"
        case SIGSEGV: return "SIGSEGV"
        case SIGPIPE: return "SIGPIPE"
        case SIGBUS: return "SIGBUS"
        default: return "signal \(number)"
        }
    }
}

final class CappedCollector: @unchecked Sendable {
    private let lock = NSLock()
    private let limits: ExecLimits
    private var out = Data()
    private var err = Data()

    init(limits: ExecLimits) { self.limits = limits }

    func append(out chunk: Data) {
        guard !chunk.isEmpty else { return }
        lock.lock(); defer { lock.unlock() }
        Self.capped(&out, chunk, limits.stdoutBytes)
    }

    func append(err chunk: Data) {
        guard !chunk.isEmpty else { return }
        lock.lock(); defer { lock.unlock() }
        Self.capped(&err, chunk, limits.stderrBytes)
    }

    func snapshot() -> (Data, Data) {
        lock.lock(); defer { lock.unlock() }
        return (out, err)
    }

    /// One rule for both streams: the first `cap` bytes are kept.
    private static func capped(_ buffer: inout Data, _ chunk: Data, _ cap: Int) {
        guard buffer.count < cap else { return }
        let room = cap - buffer.count
        buffer.append(chunk.count <= room ? chunk : chunk.prefix(room))
    }
}

/// A one-shot latch a termination handler fires and one task awaits.
final class ExitLatch: @unchecked Sendable {
    private let lock = NSLock()
    private var result: (Int32, Bool)?
    private var waiter: CheckedContinuation<(Int32, Bool), Never>?

    /// Stop waiting: the waiter is resumed as though the child had been
    /// killed. Used once the child has been told to go and nobody will read
    /// what it said.
    func abandon() { fire(status: SIGKILL, signalled: true) }

    func fire(status: Int32, signalled: Bool) {
        lock.lock()
        if result != nil { lock.unlock(); return }
        result = (status, signalled)
        let pending = waiter
        waiter = nil
        lock.unlock()
        pending?.resume(returning: (status, signalled))
    }

    func wait() async -> (Int32, Bool) {
        await withCheckedContinuation { continuation in
            lock.lock()
            if let result {
                lock.unlock()
                continuation.resume(returning: result)
            } else {
                waiter = continuation
                lock.unlock()
            }
        }
    }
}

/// The child, killable from any thread: SIGTERM, then SIGKILL after a second
/// (a child spawned from a concurrency thread on Linux may have SIGTERM
/// blocked; SIGKILL cannot be).
final class ChildBox: @unchecked Sendable {
    private let process: Process
    init(_ process: Process) { self.process = process }

    func terminate() {
        guard process.isRunning else { return }
        process.terminate()
        let pid = process.processIdentifier
        let process = self.process
        DispatchQueue.global().asyncAfter(deadline: .now() + 1) {
            if process.isRunning { kill(pid, SIGKILL) }
        }
    }
}

final class StopReason: @unchecked Sendable {
    enum Reason { case timedOut, cancelled }
    private let lock = NSLock()
    private var reason: Reason?

    func set(_ value: Reason) {
        lock.lock(); defer { lock.unlock() }
        if reason == nil { reason = value }
    }

    var value: Reason? {
        lock.lock(); defer { lock.unlock() }
        return reason
    }
}

/// `stat(2)`, following symlinks as Node's `fs.stat` does: the file type bits,
/// or the errno.
private func statMode(_ path: String) -> (mode_t?, Int32) {
    var info = stat()
    if stat(path, &info) == 0 { return (info.st_mode & S_IFMT, 0) }
    return (nil, errno)
}

/// What a pipe holds right now, up to its end or until it would block.
func drainWithoutBlocking(_ handle: FileHandle) -> Data {
    let descriptor = handle.fileDescriptor
    let flags = fcntl(descriptor, F_GETFL)
    _ = fcntl(descriptor, F_SETFL, flags | O_NONBLOCK)
    var result = Data()
    var buffer = [UInt8](repeating: 0, count: 65536)
    while true {
        let count = buffer.withUnsafeMutableBytes { read(descriptor, $0.baseAddress, $0.count) }
        if count <= 0 { break }
        result.append(contentsOf: buffer[0..<count])
    }
    return result
}

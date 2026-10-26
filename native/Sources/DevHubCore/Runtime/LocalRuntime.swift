// Port of apps/desktop/src/main/runtime/local.ts (and the local arm of
// main/runtime/byteStream.ts).
//
// This machine, behind the `MachineRuntime` interface.
//
// Every method here is code that already existed somewhere else, moved rather
// than rewritten: `exec` is `BoundedCommand.run`, `spawnPty` is `openPty`, the
// probes are the filesystem calls callers used to make inline. If a local
// Workspace behaves differently after this file exists, something was
// rewritten that should not have been.
//
// There is exactly one instance (`MachineRuntimes.local`), because there is
// exactly one of this machine. It keeps no connection and can lose nothing, so
// its `reading()` is a count and a latency that will read as zero.

import Foundation
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif

/// What the loops cost on this machine: the 300 ms reconcile and the minute's
/// repository poll the loops have always used, and real filesystem events for
/// a local `HEAD`.
public let localCadence = RuntimeCadence(
    reconcileIntervalMs: 300,
    repositoryPollMs: 60 * 1000,
    repositoryFocusRefreshMinIntervalMs: Cadence.repositoryFocusRefreshMinIntervalMs,
    headWatchPollMs: nil
)

public final class LocalRuntime: MachineRuntime, @unchecked Sendable {
    public let id: RuntimeId = .local
    public let `where` = ""
    public let cadence = localCadence

    private let lock = NSLock()
    private var scratch: String?
    private var frozenEnvironment: [String: String]?
    private let environmentSource: @Sendable () -> [String: String]
    private let homeSource: @Sendable () -> String
    /// Round-trip times of the last few execs, newest last.
    private var latencies: [Double] = []
    private var execTimes: [Double] = []
    private var lastFailure: String?
    private let ptyFactory: PtyFactory

    /// How many recent round trips a median is taken over.
    static let latencySamples = 16

    /// - Parameters:
    ///   - environment: the frozen launch environment (WP1's login
    ///     environment import); this process's environment when nil.
    ///   - home: `$HOME`; this process's when nil.
    public init(
        environment: (@Sendable () -> [String: String])? = nil,
        home: (@Sendable () -> String)? = nil,
        pty: PtyFactory? = nil
    ) {
        environmentSource = environment ?? { ProcessInfo.processInfo.environment }
        homeSource = home ?? {
            ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()
        }
        ptyFactory = pty ?? openPty
    }

    public func home() async throws -> String { homeSource() }

    /// What a command on this machine runs in: the frozen launch environment,
    /// read once and kept, because a terminal must not observe an environment
    /// that changed under it.
    public func environment() async throws -> [String: String] {
        lock.withLock {
            if let frozenEnvironment { return frozenEnvironment }
            let env = environmentSource()
            frozenEnvironment = env
            return env
        }
    }

    /// Look the configured name up the way a shell on this machine would
    /// (`resolveExecutable` in `main/shell/runtimes.ts`).
    public func resolveProgram(_ configured: String, searchPath: String) async -> ProgramResolution {
        LocalRuntime.resolve(configured, searchPath: searchPath, home: homeSource())
    }

    static func resolve(_ value: String, searchPath: String, home: String) -> ProgramResolution {
        var expanded = value
        if value == "~" { expanded = home } else if value.hasPrefix("~/") { expanded = Path.join(home, String(value.dropFirst(2))) }
        if expanded.hasPrefix("/") {
            return isExecutableFile(expanded)
                ? .absolutePath(expanded)
                : .unavailable(configured: value, lookup: .explicit(path: expanded), where: nil)
        }
        // The directories are kept whether the lookup succeeds or not: on
        // failure they are the whole diagnostic.
        let directories = searchPath.split(separator: ":").map(String.init).filter { !$0.isEmpty }
        for directory in directories {
            let candidate = Path.join(directory, expanded)
            if isExecutableFile(candidate) { return .absolutePath(candidate) }
        }
        return .unavailable(configured: value, lookup: .path(directories: directories), where: nil)
    }

    static func isExecutableFile(_ path: String) -> Bool {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), !isDirectory.boolValue else {
            return false
        }
        return access(path, X_OK) == 0
    }

    /// This machine's own tmux, which is the person's and not DevHub's: there
    /// is nothing to install and nothing to add to the environment.
    public func tmuxProgram(_ configured: String, searchPath: String) async -> TmuxProgram {
        let resolved = await resolveProgram(configured, searchPath: searchPath)
        if let message = resolved.unavailableMessage { return .unavailable(reason: message) }
        return .resolved(path: resolved.path ?? configured, environment: [:])
    }

    /// The config file itself, because this is the machine it is on. Read and
    /// not `stat`: the answer carries which config this is, and nothing but
    /// the bytes can say that.
    public func userTmuxConfig(_ localPath: String) async -> UserTmuxConfig {
        guard let data = FileManager.default.contents(atPath: localPath) else { return .none }
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: localPath, isDirectory: &isDirectory), isDirectory.boolValue {
            return .none
        }
        return UserTmuxConfig(path: localPath, digest: UserTmuxConfig.digest(of: String(decoding: data, as: UTF8.self)))
    }

    public func exec(_ request: ExecRequest) async throws -> ExecResult {
        guard let file = request.argv.first else {
            throw portFailure(.failed, detail: "a runtime exec needs a program to run")
        }
        let started = Date().timeIntervalSince1970 * 1000
        record(execAt: started)
        do {
            let output = try await BoundedCommand.run(
                CommandSpec(file: file, args: Array(request.argv.dropFirst()), cwd: request.cwd, env: request.env ?? [:]),
                deadline: request.deadline,
                cancel: request.cancel,
                limits: request.limits,
                stdin: request.stdin,
                onOutput: request.onOutput
            )
            record(latencyFrom: started)
            return output
        } catch {
            record(latencyFrom: started)
            lock.withLock { lastFailure = RuntimeFailureText.of(error) }
            throw error
        }
    }

    public func spawnPty(_ launch: PtyLaunch) throws -> any PseudoTerminal {
        try ptyFactory(launch)
    }

    public func spawnStream(_ request: StreamRequest) throws -> any ByteStream {
        guard let file = request.argv.first else {
            throw portFailure(.failed, detail: "a runtime stream needs a program to run")
        }
        return try LocalByteStream(
            CommandSpec(file: file, args: Array(request.argv.dropFirst()), cwd: request.cwd, env: request.env ?? [:]),
            cancel: request.cancel
        )
    }

    /// This DevHub's own user-data directory, or the system temp directory
    /// before anything has said which profile is running.
    public func scratchDirectory() async throws -> String {
        lock.withLock { scratch ?? NSTemporaryDirectory() }
    }

    /// Say where this machine's own files go. Called once, at startup.
    public func keepFiles(under userDataDirectory: String) {
        lock.lock(); scratch = userDataDirectory; lock.unlock()
    }

    public func stat(_ path: String) async throws -> FileKind {
        let (found, mode, code) = posixStat(path, follow: true)
        if found { return (mode & S_IFMT) == S_IFDIR ? .directory : .file }
        if code == ENOENT || code == ENOTDIR { return .absent }
        throw RuntimeFileError(path: path, code: LocalRuntime.errnoName(code))
    }

    /// Read at most `maxBytes` of a file, as UTF-8.
    public func readTextFile(_ path: String, maxBytes: Int) async throws -> String {
        guard let handle = FileHandle(forReadingAtPath: path) else {
            throw RuntimeFileError(path: path, code: LocalRuntime.errnoName(errno == 0 ? ENOENT : errno))
        }
        defer { try? handle.close() }
        do {
            let data = try handle.read(upToCount: maxBytes) ?? Data()
            return String(decoding: data, as: UTF8.self)
        } catch {
            throw RuntimeFileError(path: path, code: "\(error)")
        }
    }

    public func writeTextFile(_ path: String, text: String, mode: Int) async throws {
        let fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, mode_t(mode))
        if fd < 0 { throw RuntimeFileError(path: path, code: LocalRuntime.errnoName(errno)) }
        defer { close(fd) }
        try LocalRuntime.writeAll(fd, text, path: path)
    }

    public func writeNewTextFile(_ path: String, text: String, mode: Int) async throws -> Bool {
        let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, mode_t(mode))
        if fd < 0 {
            if errno == EEXIST { return false }
            throw RuntimeFileError(path: path, code: LocalRuntime.errnoName(errno))
        }
        defer { close(fd) }
        try LocalRuntime.writeAll(fd, text, path: path)
        return true
    }

    private static func writeAll(_ fd: Int32, _ text: String, path: String) throws {
        let bytes = Array(text.utf8)
        var offset = 0
        while offset < bytes.count {
            let written = bytes[offset...].withUnsafeBytes { raw in
                #if canImport(Glibc)
                Glibc.write(fd, raw.baseAddress, raw.count)
                #else
                Darwin.write(fd, raw.baseAddress, raw.count)
                #endif
            }
            if written < 0 {
                if errno == EINTR { continue }
                throw RuntimeFileError(path: path, code: errnoName(errno))
            }
            offset += written
        }
    }

    public func readdir(_ path: String) async throws -> [DirEntry] {
        do {
            let names = try FileManager.default.contentsOfDirectory(atPath: path)
            return names.map { name in
                var isDirectory: ObjCBool = false
                let full = Path.join(path, name)
                // `withFileTypes` does not follow a link, so neither does this.
                let (found, mode, _) = posixStat(full, follow: false)
                if found { isDirectory = ObjCBool((mode & S_IFMT) == S_IFDIR) }
                return DirEntry(name: name, directory: isDirectory.boolValue)
            }
        } catch {
            throw RuntimeFileError(path: path, code: LocalRuntime.errorCode(error))
        }
    }

    public func removeTree(_ path: String) async throws {
        if !posixStat(path, follow: false).found { return }
        do {
            try FileManager.default.removeItem(atPath: path)
        } catch {
            if !posixStat(path, follow: false).found { return }
            throw RuntimeFileError(path: path, code: LocalRuntime.errorCode(error))
        }
    }

    public func makeDirectory(_ path: String) async throws {
        do {
            try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        } catch {
            throw RuntimeFileError(path: path, code: LocalRuntime.errorCode(error))
        }
    }

    public func realpath(_ path: String) async throws -> String {
        #if canImport(Glibc)
        guard let resolved = Glibc.realpath(path, nil) else {
            throw RuntimeFileError(path: path, code: LocalRuntime.errnoName(errno))
        }
        #else
        guard let resolved = Darwin.realpath(path, nil) else {
            throw RuntimeFileError(path: path, code: LocalRuntime.errnoName(errno))
        }
        #endif
        defer { free(resolved) }
        return String(cString: resolved)
    }

    /// Already here.
    public func commandFromHere(_ command: MachineCommand) async throws -> MachineCommand { command }

    /// Already here: the port on this Mac is the port.
    public func forwardLoopbackPort(_ port: Int) async throws -> LoopbackForward {
        LoopbackForward(to: nil, close: {})
    }

    /// Nothing is multiplexed to this Mac from this Mac.
    public func resumed() {}

    public func reading() -> RuntimeReading {
        lock.lock(); defer { lock.unlock() }
        let sorted = latencies.sorted()
        let now = Date().timeIntervalSince1970 * 1000
        let recent = execTimes.filter { now - $0 < 60_000 }.count
        return RuntimeReading(
            id: id.rawValue,
            connected: true,
            masterPid: nil,
            medianRoundTripMs: sorted.isEmpty ? 0 : sorted[sorted.count / 2],
            reconcileIntervalMs: cadence.reconcileIntervalMs,
            execsLastMinute: recent,
            muxSessionsHeld: 0,
            muxSessionsWaiting: 0,
            muxFallbacks: 0,
            loginEnvironmentNames: [],
            lastFailure: lastFailure
        )
    }

    private func record(execAt time: Double) {
        lock.lock()
        execTimes.append(time)
        execTimes.removeAll { time - $0 >= 60_000 }
        lock.unlock()
    }

    private func record(latencyFrom started: Double) {
        lock.lock()
        latencies.append(Date().timeIntervalSince1970 * 1000 - started)
        if latencies.count > LocalRuntime.latencySamples { latencies.removeFirst() }
        lock.unlock()
    }

    static func errnoName(_ code: Int32) -> String {
        switch code {
        case ENOENT: return "ENOENT"
        case ENOTDIR: return "ENOTDIR"
        case EACCES: return "EACCES"
        case EPERM: return "EPERM"
        case EEXIST: return "EEXIST"
        case EISDIR: return "EISDIR"
        case ELOOP: return "ELOOP"
        case ENAMETOOLONG: return "ENAMETOOLONG"
        default: return "errno \(code)"
        }
    }

    static func errorCode(_ error: any Error) -> String {
        let ns = error as NSError
        if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError, underlying.domain == NSPOSIXErrorDomain {
            return errnoName(Int32(underlying.code))
        }
        if ns.domain == NSPOSIXErrorDomain { return errnoName(Int32(ns.code)) }
        switch ns.code {
        case NSFileNoSuchFileError, NSFileReadNoSuchFileError: return "ENOENT"
        case NSFileReadNoPermissionError, NSFileWriteNoPermissionError: return "EACCES"
        default: return ns.localizedDescription
        }
    }
}

/// The last bytes of a stream's stderr kept for its ending.
public let streamStderrBytes = 16 * 1024

/// A long-lived local program over pipes.
final class LocalByteStream: ByteStream, @unchecked Sendable {
    let stdout: AsyncStream<Data>
    private let continuation: AsyncStream<Data>.Continuation
    private let process = Process()
    private let lock = NSLock()
    private var stderrTail = Data()
    private var end: StreamEnd?
    private var waiters: [CheckedContinuation<StreamEnd, any Error>] = []
    private var launchFailure: (any Error)?
    private let stdinPipe = Pipe()
    private var readers: [PipeReader] = []

    init(_ spec: CommandSpec, cancel: CancellationToken) throws {
        var made: AsyncStream<Data>.Continuation!
        stdout = AsyncStream { made = $0 }
        continuation = made
        guard let executable = BoundedCommand.locate(spec.file, environment: spec.env) else {
            launchFailure = portFailure(.unavailable, detail: "\(spec.file) is not a program DevHub can run")
            continuation.finish()
            return
        }
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = spec.args
        process.environment = spec.env
        if let cwd = spec.cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        let out = Pipe(), err = Pipe()
        process.standardOutput = out
        process.standardError = err
        process.standardInput = stdinPipe
        let stream = continuation
        let queue = DispatchQueue(label: "devhub.byte-stream")
        readers = [
            PipeReader(out, queue: queue, onChunk: { stream.yield($0) }, onEnd: { stream.finish() }),
            PipeReader(err, queue: queue, onChunk: { [weak self] in self?.keep(stderr: $0) }, onEnd: {}),
        ]
        process.terminationHandler = { [weak self] finished in
            let signalled = finished.terminationReason == .uncaughtSignal
            self?.ended(StreamEnd(
                code: signalled ? nil : finished.terminationStatus,
                signal: signalled ? finished.terminationStatus : nil,
                stderr: Data()
            ))
        }
        do {
            try process.run()
            for reader in readers { reader.start() }
        } catch {
            for reader in readers {
                reader.start()
                reader.stop()
            }
            launchFailure = portFailure(.unavailable, detail: "\(spec.file) could not be started: \(error.localizedDescription)")
            continuation.finish()
            return
        }
        cancel.onCancelled { [weak self] in self?.kill() }
    }

    private func keep(stderr chunk: Data) {
        lock.lock()
        stderrTail.append(chunk)
        if stderrTail.count > streamStderrBytes { stderrTail = stderrTail.suffix(streamStderrBytes) }
        lock.unlock()
    }

    private func ended(_ value: StreamEnd) {
        lock.lock()
        var finished = value
        finished.stderr = stderrTail
        end = finished
        let pending = waiters
        waiters = []
        lock.unlock()
        for waiter in pending { waiter.resume(returning: finished) }
    }

    func ended() async throws -> StreamEnd {
        if let launchFailure { throw launchFailure }
        return try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if let end {
                lock.unlock()
                continuation.resume(returning: end)
                return
            }
            waiters.append(continuation)
            lock.unlock()
        }
    }

    func kill() {
        guard launchFailure == nil, process.isRunning else { return }
        try? stdinPipe.fileHandleForWriting.close()
        #if canImport(Glibc)
        _ = Glibc.kill(process.processIdentifier, SIGKILL)
        #else
        _ = Darwin.kill(process.processIdentifier, SIGKILL)
        #endif
    }
}

/// `stat`/`lstat`, as (found, mode, errno).
func posixStat(_ path: String, follow: Bool) -> (found: Bool, mode: mode_t, errno: Int32) {
    var info = stat()
    let result = follow ? stat(path, &info) : lstat(path, &info)
    return result == 0 ? (true, info.st_mode, 0) : (false, 0, errno)
}

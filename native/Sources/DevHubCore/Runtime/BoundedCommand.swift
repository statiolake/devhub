// Port of `runBounded` and `resolveExecutable` in
// apps/desktop/src/main/terminal/command.ts.
//
// Running one bounded provider command.
//
// Every tmux invocation goes through here, and every one of them is bounded in
// three ways at once: an operation deadline that started at the caller's first
// probe, a byte cap per stream, and cancellation. A provider that hangs, floods
// or forks must not be able to hold an operation open.
//
// What is preserved exactly is the budget — the deadline covers the drain, not
// only the exit — and which failure wins when several apply.
//
// Deviation: the TS child is its own process group and the whole group is
// SIGKILLed on a failure. Foundation's `Process` does not offer a process
// group, so only the child itself is killed; the pipes are let go of, so a
// descendant that keeps one open cannot hold the operation.

import Foundation
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif

/// A validated executable.
///
/// The path is canonical and was a regular executable file when it was
/// resolved; the runtime never re-derives it from a configured string later.
public struct ResolvedExecutable: Sendable, Equatable {
    public var path: String
    public var basename: String
    public init(path: String, basename: String) {
        self.path = path
        self.basename = basename
    }
}

/// What a command is run as.
public struct CommandSpec: Sendable {
    public var file: String
    public var args: [String]
    /// Where to run it, or nil for "wherever this process is".
    public var cwd: String?
    public var env: [String: String]
    public init(file: String, args: [String], cwd: String?, env: [String: String]) {
        self.file = file
        self.args = args
        self.cwd = cwd
        self.env = env
    }
}

public enum BoundedCommand {
    /// Resolve a configured executable: an absolute path, a leading-`~` path,
    /// or a bare command name looked up in absolute PATH entries only.
    ///
    /// A relative path with a separator is refused rather than interpreted
    /// against whatever directory this process happens to be in.
    public static func resolveExecutable(
        home: String,
        environment: [String: String],
        configured: String
    ) -> ResolvedExecutable? {
        if configured.isEmpty || configured.contains("\0") { return nil }
        if configured == "~" || configured.hasPrefix("~/") {
            return inspectExecutable(home + String(configured.dropFirst()))
        }
        if configured.hasPrefix("/") { return inspectExecutable(configured) }
        if configured.contains("/") { return nil }
        guard let path = environment["PATH"], !path.isEmpty else { return nil }
        for entry in path.split(separator: ":", omittingEmptySubsequences: false) {
            let directory = String(entry)
            if directory.isEmpty || !directory.hasPrefix("/") { continue }
            if let resolved = inspectExecutable(Path.join(directory, configured)) { return resolved }
        }
        return nil
    }

    static func inspectExecutable(_ path: String) -> ResolvedExecutable? {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), !isDirectory.boolValue else {
            return nil
        }
        guard access(path, X_OK) == 0 else { return nil }
        let real = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
        let base = real.split(separator: "/").last.map(String.init) ?? real
        return ResolvedExecutable(path: real, basename: base)
    }

    /// The program a bare name runs, found on the command's own PATH as
    /// `spawn` finds it. nil when there is none.
    static func locate(_ file: String, environment: [String: String]) -> String? {
        if file.contains("/") { return file }
        let search = environment["PATH"] ?? "/usr/bin:/bin"
        for entry in search.split(separator: ":") where !entry.isEmpty {
            let candidate = Path.join(String(entry), file)
            var isDirectory: ObjCBool = false
            if FileManager.default.fileExists(atPath: candidate, isDirectory: &isDirectory),
               !isDirectory.boolValue, access(candidate, X_OK) == 0 {
                return candidate
            }
        }
        return nil
    }

    /// Run one command to completion inside the operation's budget.
    public static func run(
        _ spec: CommandSpec,
        deadline: OperationDeadline,
        cancel: CancellationToken,
        limits: ExecLimits,
        stdin: Data? = nil,
        onOutput: (@Sendable (Data) -> Void)? = nil
    ) async throws -> ExecResult {
        // The deadline started at the caller's first probe, not when this
        // child happens to be spawned. Refuse a late spawn outright.
        try deadline.check(cancel)
        guard let executable = locate(spec.file, environment: spec.env) else {
            throw portFailure(.unavailable, detail: "\(spec.file) is not a program DevHub can run")
        }
        let run = BoundedRun(limits: limits, onOutput: onOutput)
        return try await run.start(
            executable: executable,
            spec: spec,
            stdin: stdin,
            deadline: deadline,
            cancel: cancel
        )
    }
}

/// One child, its two capped streams, and the one answer it gives.
private final class BoundedRun: @unchecked Sendable {
    private let lock = NSLock()
    private let limits: ExecLimits
    private let onOutput: (@Sendable (Data) -> Void)?
    private var stdout = Data()
    private var stderr = Data()
    private var stdoutSeen = 0
    private var stderrSeen = 0
    private var stdoutClosed = false
    private var stderrClosed = false
    private var exit: (code: Int32?, signal: Int32?)?
    private var settled = false
    private var continuation: CheckedContinuation<ExecResult, any Error>?
    private var process: Process?
    private var watchdog: Task<Void, Never>?
    private var pipes: [Pipe] = []
    private var sources: [DispatchSourceRead] = []
    private let queue = DispatchQueue(label: "devhub.bounded-command")

    init(limits: ExecLimits, onOutput: (@Sendable (Data) -> Void)?) {
        self.limits = limits
        self.onOutput = onOutput
    }

    func start(
        executable: String,
        spec: CommandSpec,
        stdin: Data?,
        deadline: OperationDeadline,
        cancel: CancellationToken
    ) async throws -> ExecResult {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<ExecResult, any Error>) in
            lock.lock()
            self.continuation = continuation
            lock.unlock()

            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = spec.args
            process.environment = spec.env
            if let cwd = spec.cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
            let outPipe = Pipe(), errPipe = Pipe()
            process.standardOutput = outPipe
            process.standardError = errPipe
            var inPipe: Pipe?
            if stdin != nil {
                let pipe = Pipe()
                process.standardInput = pipe
                inPipe = pipe
            } else {
                process.standardInput = FileHandle.nullDevice
            }
            pipes = [outPipe, errPipe] + (inPipe.map { [$0] } ?? [])
            for (pipe, isError) in [(outPipe, false), (errPipe, true)] {
                let fd = pipe.fileHandleForReading.fileDescriptor
                // Non-blocking, and drained to EAGAIN on every event: one event
                // may carry the last bytes and the end of the stream together.
                _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
                let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
                source.setEventHandler { [weak self] in
                    var buffer = [UInt8](repeating: 0, count: 65_536)
                    while true {
                        let count = buffer.withUnsafeMutableBytes { raw in
                            #if canImport(Glibc)
                            Glibc.read(fd, raw.baseAddress, raw.count)
                            #else
                            Darwin.read(fd, raw.baseAddress, raw.count)
                            #endif
                        }
                        if count > 0 {
                            self?.accept(Data(buffer[0..<count]), stderr: isError, deadline: deadline)
                            continue
                        }
                        if count < 0 && errno == EINTR { continue }
                        if count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) { return }
                        source.cancel()
                        self?.accept(Data(), stderr: isError, deadline: deadline)
                        return
                    }
                }
                // The descriptor is closed by the pipe, and the pipe is kept
                // until the source has let go of it: a descriptor closed under a
                // live source is a number the next pipe may be handed.
                source.setCancelHandler { withExtendedLifetime(pipe) {} }
                sources.append(source)
            }
            process.terminationHandler = { [weak self] finished in
                let signalled = finished.terminationReason == .uncaughtSignal
                self?.exited(
                    code: signalled ? nil : finished.terminationStatus,
                    signal: signalled ? finished.terminationStatus : nil,
                    deadline: deadline
                )
            }
            self.process = process
            do {
                try process.run()
                for source in sources { source.resume() }
            } catch {
                // A suspended source must not be released: resume it to cancel it.
                for source in sources { source.resume() }
                let code = (error as NSError).code
                let unavailable = code == Int(ENOENT) || code == Int(EACCES)
                    || (error as NSError).domain == NSCocoaErrorDomain
                finish(failure: portFailure(unavailable ? .unavailable : .failed, detail: "\(spec.file) could not be started: \(error.localizedDescription)"))
                return
            }
            if let stdin, let inPipe {
                // A program that stops reading before its input is all written
                // has not been given what the caller handed it.
                let writer = inPipe.fileHandleForWriting
                do {
                    try writer.write(contentsOf: stdin)
                    try writer.close()
                } catch {
                    finish(failure: portFailure(.failed, detail: "\(spec.file) stopped reading its input before all of it was written (\(error.localizedDescription))"))
                    return
                }
            }
            cancel.onCancelled { [weak self] in self?.finish(failure: portFailure(.cancelled)) }
            let wait = max(0, deadline.remaining)
            watchdog = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000))
                if Task.isCancelled { return }
                self?.finish(failure: portFailure(.timedOut))
            }
        }
    }

    // One rule for both streams, so a cap that is right for one of them
    // cannot be quietly wrong for the other.
    private func accept(_ chunk: Data, stderr isError: Bool, deadline: OperationDeadline) {
        if chunk.isEmpty {
            lock.lock()
            if isError { stderrClosed = true } else { stdoutClosed = true }
            lock.unlock()
            completeIfDone(deadline: deadline)
            return
        }
        onOutput?(chunk)
        lock.lock()
        let cap = isError ? limits.stderrBytes : limits.stdoutBytes
        let seen = isError ? stderrSeen : stdoutSeen
        let total = seen + chunk.count
        var overflowFailure: (any Error)?
        if seen < cap {
            if total <= cap {
                if isError { stderr.append(chunk) } else { stdout.append(chunk) }
            } else if case .fail(let failure) = limits.overflow {
                overflowFailure = failure()
            } else {
                let kept = chunk.prefix(cap - seen)
                if isError { stderr.append(kept) } else { stdout.append(kept) }
            }
        }
        if isError { stderrSeen = total } else { stdoutSeen = total }
        lock.unlock()
        if let overflowFailure { finish(failure: overflowFailure) }
    }

    private func exited(code: Int32?, signal: Int32?, deadline: OperationDeadline) {
        lock.lock()
        exit = (code, signal)
        lock.unlock()
        completeIfDone(deadline: deadline)
    }

    // `close` rather than `exit`: the drain is part of the same budget, so a
    // descendant holding a pipe open cannot be mistaken for completion.
    private func completeIfDone(deadline: OperationDeadline) {
        lock.lock()
        guard let exit, stdoutClosed, stderrClosed, !settled else {
            lock.unlock()
            return
        }
        let result = ExecResult(code: exit.code, signal: exit.signal, stdout: stdout, stderr: stderr)
        lock.unlock()
        // The provider answered, so the operation's watchdog starts again.
        deadline.answered()
        finish(result: result)
    }

    private func finish(result: ExecResult? = nil, failure: (any Error)? = nil) {
        lock.lock()
        if settled {
            lock.unlock()
            return
        }
        settled = true
        let continuation = self.continuation
        self.continuation = nil
        let process = self.process
        let watchdog = self.watchdog
        let sources = self.sources
        lock.unlock()
        watchdog?.cancel()
        if failure != nil {
            for source in sources where !source.isCancelled { source.cancel() }
            if let process, process.isRunning {
                kill(process.processIdentifier, SIGKILL)
            }
        }
        if let failure {
            continuation?.resume(throwing: failure)
        } else if let result {
            continuation?.resume(returning: result)
        }
    }
}

/// Read one pipe to its end on a dispatch source: non-blocking, drained to
/// EAGAIN on every event, the pipe kept until the source has let go of it.
/// Used where `FileHandle.readabilityHandler` would do on Darwin and does not
/// reliably report the end of a stream on Linux.
final class PipeReader: @unchecked Sendable {
    private let source: DispatchSourceRead

    init(_ pipe: Pipe, queue: DispatchQueue, onChunk: @escaping @Sendable (Data) -> Void, onEnd: @escaping @Sendable () -> Void) {
        let fd = pipe.fileHandleForReading.fileDescriptor
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        source.setEventHandler {
            var buffer = [UInt8](repeating: 0, count: 65_536)
            while true {
                let count = buffer.withUnsafeMutableBytes { raw in
                    #if canImport(Glibc)
                    Glibc.read(fd, raw.baseAddress, raw.count)
                    #else
                    Darwin.read(fd, raw.baseAddress, raw.count)
                    #endif
                }
                if count > 0 {
                    onChunk(Data(buffer[0..<count]))
                    continue
                }
                if count < 0 && errno == EINTR { continue }
                if count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) { return }
                source.cancel()
                onEnd()
                return
            }
        }
        source.setCancelHandler { withExtendedLifetime(pipe) {} }
        self.source = source
    }

    func start() { source.resume() }

    func stop() {
        if !source.isCancelled { source.cancel() }
    }
}

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
// The child is its own process group (`SpawnedChild`), so a provider that
// forks (tmux does) is terminated as a whole on a failure rather than leaving
// a descendant holding a pipe.

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
        limits: MachineExecLimits,
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
    private let limits: MachineExecLimits
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
    private var child: SpawnedChild?
    private var watchdog: Task<Void, Never>?
    private var readers: [DescriptorReader] = []
    private let queue = DispatchQueue(label: "devhub.bounded-command")

    init(limits: MachineExecLimits, onOutput: (@Sendable (Data) -> Void)?) {
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
            lock.withLock { self.continuation = continuation }

            let child: SpawnedChild
            do {
                child = try SpawnedChild.spawn(executable: executable, args: spec.args, env: spec.env, cwd: spec.cwd, pipeStdin: stdin != nil)
            } catch {
                let code = (error as NSError).code
                let unavailable = code == Int(ENOENT) || code == Int(EACCES)
                finish(failure: portFailure(unavailable ? .unavailable : .failed, detail: "\(spec.file) could not be started: \(String(cString: strerror(Int32(code))))"))
                return
            }
            let readers = [
                DescriptorReader(child.stdout, queue: queue, onChunk: { [weak self] in self?.accept($0, stderr: false, deadline: deadline) }, onEnd: { [weak self] in self?.accept(Data(), stderr: false, deadline: deadline) }),
                DescriptorReader(child.stderr, queue: queue, onChunk: { [weak self] in self?.accept($0, stderr: true, deadline: deadline) }, onEnd: { [weak self] in self?.accept(Data(), stderr: true, deadline: deadline) }),
            ]
            lock.withLock {
                self.child = child
                self.readers = readers
            }
            for reader in readers { reader.start() }
            child.whenExited { [weak self] code, signal in
                self?.exited(code: code, signal: signal, deadline: deadline)
            }
            if let stdin {
                // A program that stops reading before its input is all written
                // has not been given what the caller handed it.
                if !writeAllAndClose(child.stdin, stdin) {
                    finish(failure: portFailure(.failed, detail: "\(spec.file) stopped reading its input before all of it was written (EPIPE)"))
                    return
                }
            }
            cancel.onCancelled { [weak self] in self?.finish(failure: portFailure(.cancelled)) }
            let wait = max(0, deadline.remaining)
            let watchdog = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000))
                if Task.isCancelled { return }
                self?.finish(failure: portFailure(.timedOut))
            }
            lock.withLock { self.watchdog = watchdog }
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
        let child = self.child
        let watchdog = self.watchdog
        let readers = self.readers
        lock.unlock()
        watchdog?.cancel()
        if failure != nil {
            // The whole group: a provider that forked must not leave a
            // descendant holding a pipe.
            for reader in readers { reader.stop() }
            child?.signalGroup(SIGKILL)
        }
        if let failure {
            continuation?.resume(throwing: failure)
        } else if let result {
            continuation?.resume(returning: result)
        }
    }
}

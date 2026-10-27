// This Mac (or this Linux box) as a `HostMachine`: the TS app's
// `LocalRuntime` (apps/desktop/src/main/runtime/local.ts), for what a
// conversation needs of it.
//
// Programs are started with `posix_spawn` rather than Foundation's
// `Process`, for three things a host's scripts depend on:
//
// - each in a process group of its own, so stopping one stops what it
//   started (a journal stream's `tail` and watchdog) and nothing else;
// - an empty signal mask and default dispositions in the child, whatever the
//   spawning thread had blocked (a Swift concurrency thread can have SIGTERM
//   blocked, and a child inherits that; Docs/PLAN.md §3.4);
// - the parent's ends of every pipe closed in the child, so closing the
//   stream's stdin here is an EOF its watchdog sees.

import Foundation

#if canImport(Glibc)
    import Glibc
#elseif canImport(Darwin)
    import Darwin
#endif

public struct LocalMachine: HostMachine {
    public init() {
        LocalMachine.ignoreBrokenPipes
    }

    /// A write to a program that has gone is an error to report, not a signal that ends DevHub.
    private static let ignoreBrokenPipes: Void = {
        signal(SIGPIPE, SIG_IGN)
    }()

    public var whereSuffix: String { "" }

    public func home() async throws -> String {
        if let home = ProcessInfo.processInfo.environment["HOME"], !home.isEmpty { return home }
        return NSHomeDirectory()
    }

    public func exec(_ argv: [String], stdin: Data?, timeout: Double, limits: MachineLimits) async throws -> MachineResult {
        let child = try SpawnedProcess(argv, keepStdin: stdin != nil)
        if let stdin { child.feed(stdin) }
        let run = ExecRun(child: child, limits: limits)
        return try await run.wait(timeout: timeout)
    }

    public func spawnStream(_ argv: [String]) throws -> MachineStream {
        LocalStream(try SpawnedProcess(argv, keepStdin: true))
    }

    public func stat(_ path: String) async throws -> MachineFileKind {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) else { return .absent }
        if isDirectory.boolValue { return .directory }
        let attributes = try? FileManager.default.attributesOfItem(atPath: path)
        return attributes?[.type] as? FileAttributeType == .typeRegular ? .file : .other
    }

    public func readDirectory(_ path: String) async throws -> [MachineDirEntry] {
        try FileManager.default.contentsOfDirectory(atPath: path).sorted().map { name in
            var isDirectory: ObjCBool = false
            _ = FileManager.default.fileExists(atPath: (path as NSString).appendingPathComponent(name), isDirectory: &isDirectory)
            return MachineDirEntry(name: name, directory: isDirectory.boolValue)
        }
    }

    public func removeTree(_ path: String) async throws {
        guard FileManager.default.fileExists(atPath: path) else { return }
        try FileManager.default.removeItem(atPath: path)
    }

    public func writeTextFile(_ path: String, _ text: String, mode: Int) async throws {
        let url = URL(fileURLWithPath: path)
        try Data(text.utf8).write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: mode], ofItemAtPath: path)
    }
}

// MARK: - A spawned program

/// A small lock-guarded box: the one way state is shared between the
/// threads that read a child's pipes and wait for it.
final class Guarded<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value

    init(_ value: Value) { self.value = value }

    func with<T>(_ body: (inout Value) -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body(&value)
    }
}

/// A program started in its own process group with three pipes, read by
/// threads of its own and waited for by another.
final class SpawnedProcess: @unchecked Sendable {
    let pid: pid_t
    private let stdinFd: Guarded<Int32?>
    let stdoutFd: Int32
    let stderrFd: Int32

    init(_ argv: [String], keepStdin: Bool) throws {
        guard let file = argv.first else { throw MachineError(.launchFailed, "nothing to run") }
        var input: [Int32] = [-1, -1]
        var output: [Int32] = [-1, -1]
        var errors: [Int32] = [-1, -1]
        guard pipe(&input) == 0, pipe(&output) == 0, pipe(&errors) == 0 else {
            throw MachineError(.launchFailed, "\(file) could not be started: \(String(cString: strerror(errno)))")
        }
        for fd in input + output + errors { _ = fcntl(fd, F_SETFD, FD_CLOEXEC) }

        #if canImport(Darwin)
            var actions: posix_spawn_file_actions_t? = nil
            var attributes: posix_spawnattr_t? = nil
        #else
            var actions = posix_spawn_file_actions_t()
            var attributes = posix_spawnattr_t()
        #endif
        posix_spawn_file_actions_init(&actions)
        posix_spawnattr_init(&attributes)
        defer {
            posix_spawn_file_actions_destroy(&actions)
            posix_spawnattr_destroy(&attributes)
        }
        posix_spawn_file_actions_adddup2(&actions, input[0], 0)
        posix_spawn_file_actions_adddup2(&actions, output[1], 1)
        posix_spawn_file_actions_adddup2(&actions, errors[1], 2)
        // Its three streams and nothing else: a host or a follower lives on,
        // and whatever it inherited stays open as long as it does.
        SpawnHygiene.closeInherited(&actions)
        var empty = sigset_t()
        sigemptyset(&empty)
        posix_spawnattr_setsigmask(&attributes, &empty)
        var defaults = sigset_t()
        sigemptyset(&defaults)
        for signal in [SIGPIPE, SIGTERM, SIGHUP, SIGINT, SIGQUIT, SIGCHLD] { sigaddset(&defaults, signal) }
        posix_spawnattr_setsigdefault(&attributes, &defaults)
        posix_spawnattr_setpgroup(&attributes, 0)
        posix_spawnattr_setflags(
            &attributes,
            Int16(truncatingIfNeeded: Int32(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF) | SpawnHygiene.spawnFlags))

        let environment = ProcessInfo.processInfo.environment.map { "\($0.key)=\($0.value)" }
        let cArgv = argv.map { strdup($0) } + [nil]
        let cEnv = environment.map { strdup($0) } + [nil]
        defer {
            for pointer in cArgv { free(pointer) }
            for pointer in cEnv { free(pointer) }
        }
        var pid: pid_t = 0
        let spawned = file.contains("/")
            ? posix_spawn(&pid, file, &actions, &attributes, cArgv, cEnv)
            : posix_spawnp(&pid, file, &actions, &attributes, cArgv, cEnv)
        close(input[0])
        close(output[1])
        close(errors[1])
        guard spawned == 0 else {
            close(input[1])
            close(output[0])
            close(errors[0])
            throw MachineError(.launchFailed, "\(file) could not be started: \(String(cString: strerror(spawned)))")
        }
        self.pid = pid
        stdoutFd = output[0]
        stderrFd = errors[0]
        if keepStdin {
            stdinFd = Guarded(input[1])
        } else {
            close(input[1])
            stdinFd = Guarded(nil)
        }
    }

    /// Write `data` to the program's stdin on a thread of its own, then close it.
    func feed(_ data: Data) {
        Thread.detachNewThread { [self] in
            guard let fd = stdinFd.with({ $0 }) else { return }
            data.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
                var offset = 0
                while offset < buffer.count {
                    let wrote = write(fd, buffer.baseAddress! + offset, buffer.count - offset)
                    if wrote < 0 {
                        if errno == EINTR { continue }
                        return
                    }
                    offset += wrote
                }
            }
            closeStdin()
        }
    }

    func closeStdin() {
        let fd: Int32? = stdinFd.with { fd in
            defer { fd = nil }
            return fd
        }
        if let fd { close(fd) }
    }

    /// Signal the program's whole process group.
    func signalGroup(_ signal: Int32) {
        _ = Glibc_or_Darwin_kill(-pid, signal)
    }

    /// Read `fd` to its end on a thread of its own, each chunk to `chunk`, then `done`.
    static func drain(_ fd: Int32, chunk: @escaping @Sendable (Data) -> Void, done: @escaping @Sendable () -> Void) {
        Thread.detachNewThread {
            var buffer = [UInt8](repeating: 0, count: 64 * 1024)
            while true {
                let count = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress!, $0.count) }
                if count > 0 {
                    chunk(Data(buffer[0..<count]))
                } else if count < 0 && errno == EINTR {
                    continue
                } else {
                    break
                }
            }
            close(fd)
            done()
        }
    }

    /// Wait for the program on a thread of its own; `ended` gets its exit code or signal.
    func waitForExit(_ ended: @escaping @Sendable (_ code: Int32?, _ signal: Int32?) -> Void) {
        let pid = self.pid
        Thread.detachNewThread {
            var status: Int32 = 0
            while waitpid(pid, &status, 0) < 0 {
                if errno != EINTR {
                    ended(nil, nil)
                    return
                }
            }
            let low = status & 0x7f
            if low == 0 {
                ended((status >> 8) & 0xff, nil)
            } else {
                ended(nil, low)
            }
        }
    }
}

@inline(__always)
private func Glibc_or_Darwin_kill(_ pid: pid_t, _ signal: Int32) -> Int32 {
    kill(pid, signal)
}

/// Stop a process group: SIGTERM, and SIGKILL a second later for one that
/// did not take it (a child whose mask blocked SIGTERM before it was reset).
func stopGroup(_ child: SpawnedProcess, finished: @escaping @Sendable () -> Bool) {
    child.signalGroup(SIGTERM)
    DispatchQueue.global().asyncAfter(deadline: .now() + 1) {
        if !finished() { child.signalGroup(SIGKILL) }
    }
}

// MARK: - exec

private final class ExecRun: @unchecked Sendable {
    private struct State {
        var stdout = Data()
        var stderr = Data()
        var openPipes = 2
        var exit: (code: Int32?, signal: Int32?)?
        var failure: MachineError?
        var continuation: CheckedContinuation<MachineResult, Error>?
        var resumed = false
    }

    private let child: SpawnedProcess
    private let limits: MachineLimits
    private let state = Guarded(State())

    init(child: SpawnedProcess, limits: MachineLimits) {
        self.child = child
        self.limits = limits
    }

    func wait(timeout: Double) async throws -> MachineResult {
        try await withCheckedThrowingContinuation { continuation in
            state.with { $0.continuation = continuation }
            SpawnedProcess.drain(
                child.stdoutFd, chunk: { [self] chunk in take(chunk, stdout: true) }, done: { [self] in pipeClosed() })
            SpawnedProcess.drain(
                child.stderrFd, chunk: { [self] chunk in take(chunk, stdout: false) }, done: { [self] in pipeClosed() })
            child.waitForExit { [self] code, signal in
                state.with { $0.exit = (code, signal) }
                finishIfDone()
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [self] in
                let late = state.with { state -> Bool in
                    guard !state.resumed, state.exit == nil else { return false }
                    state.failure = state.failure ?? MachineError(.timedOut, "did not finish within \(JsonValue.javaScriptNumber(timeout))s")
                    return true
                }
                if late { stopGroup(child) { [self] in state.with { $0.exit != nil } } }
            }
        }
    }

    private func take(_ chunk: Data, stdout: Bool) {
        let overflowed = state.with { state -> Bool in
            let limit = stdout ? limits.stdoutBytes : limits.stderrBytes
            let current = stdout ? state.stdout.count : state.stderr.count
            let room = max(0, limit - current)
            let kept = chunk.prefix(room)
            if stdout { state.stdout.append(kept) } else { state.stderr.append(kept) }
            guard chunk.count > room, stdout, limits.overflow == .fail, state.failure == nil else { return false }
            state.failure = MachineError(.overflow, "printed more than the \(limit) bytes DevHub reads at once")
            return true
        }
        if overflowed { stopGroup(child) { [self] in state.with { $0.exit != nil } } }
    }

    private func pipeClosed() {
        state.with { $0.openPipes -= 1 }
        finishIfDone()
    }

    private func finishIfDone() {
        let outcome = state.with { state -> (CheckedContinuation<MachineResult, Error>, Result<MachineResult, Error>)? in
            guard !state.resumed, state.openPipes == 0, let exit = state.exit, let continuation = state.continuation else {
                return nil
            }
            state.resumed = true
            if let failure = state.failure { return (continuation, .failure(failure)) }
            return (continuation, .success(MachineResult(code: exit.code, signal: exit.signal, stdout: state.stdout, stderr: state.stderr)))
        }
        if let (continuation, result) = outcome { continuation.resume(with: result) }
    }
}

// MARK: - A stream

private final class LocalStream: MachineStream, @unchecked Sendable {
    private struct State {
        var stderr = Data()
        var openPipes = 2
        var exit: (code: Int32?, signal: Int32?)?
        var waiters: [CheckedContinuation<MachineResult, Error>] = []
        var result: MachineResult?
        var killed = false
    }

    private static let STDERR_BYTES = 8 * 1024

    private let child: SpawnedProcess
    private let state = Guarded(State())
    let stdout: AsyncThrowingStream<Data, Error>

    init(_ child: SpawnedProcess) {
        self.child = child
        var continuation: AsyncThrowingStream<Data, Error>.Continuation!
        stdout = AsyncThrowingStream(bufferingPolicy: .unbounded) { continuation = $0 }
        let out = continuation!
        SpawnedProcess.drain(
            child.stdoutFd, chunk: { chunk in out.yield(chunk) },
            done: { [self] in
                out.finish()
                pipeClosed()
            })
        SpawnedProcess.drain(
            child.stderrFd,
            chunk: { [self] chunk in
                state.with { state in
                    let room = max(0, LocalStream.STDERR_BYTES - state.stderr.count)
                    state.stderr.append(chunk.prefix(room))
                }
            }, done: { [self] in pipeClosed() })
        child.waitForExit { [self] code, signal in
            state.with { $0.exit = (code, signal) }
            settle()
        }
    }

    func ended() async throws -> MachineResult {
        try await withCheckedThrowingContinuation { continuation in
            let done = state.with { state -> MachineResult? in
                if let result = state.result { return result }
                state.waiters.append(continuation)
                return nil
            }
            if let done { continuation.resume(returning: done) }
        }
    }

    func kill() {
        let first = state.with { state -> Bool in
            defer { state.killed = true }
            return !state.killed
        }
        guard first else { return }
        child.closeStdin()
        if state.with({ $0.exit == nil }) {
            stopGroup(child) { [self] in state.with { $0.exit != nil } }
        } else {
            // The leader is gone; what it left of its group goes too.
            child.signalGroup(SIGKILL)
        }
    }

    private func pipeClosed() {
        state.with { $0.openPipes -= 1 }
        settle()
    }

    private func settle() {
        let (waiters, result) = state.with { state -> ([CheckedContinuation<MachineResult, Error>], MachineResult?) in
            guard state.result == nil, state.openPipes == 0, let exit = state.exit else { return ([], nil) }
            let result = MachineResult(code: exit.code, signal: exit.signal, stdout: Data(), stderr: state.stderr)
            state.result = result
            defer { state.waiters = [] }
            return (state.waiters, result)
        }
        if let result { for waiter in waiters { waiter.resume(returning: result) } }
    }
}

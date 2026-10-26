import Foundation

/// The result of running a program to completion.
public struct ProcessOutput: Sendable, Equatable {
    public let status: Int32
    public let stdout: Data
    public let stderr: Data

    public var stdoutText: String { String(decoding: stdout, as: UTF8.self) }
    public var stderrText: String { String(decoding: stderr, as: UTF8.self) }
    public var succeeded: Bool { status == 0 }
}

public enum ProcessRunnerError: Error, Equatable, CustomStringConvertible {
    case launchFailed(executable: String, reason: String)
    case timedOut(executable: String, seconds: Double)

    public var description: String {
        switch self {
        case .launchFailed(let executable, let reason):
            return "\(executable) could not be started: \(reason)"
        case .timedOut(let executable, let seconds):
            return "\(executable) did not finish within \(seconds)s"
        }
    }
}

/// Runs a program (no shell) and collects its output, with a deadline.
///
/// The one door through which Core starts short-lived processes (`git`, `gh`,
/// `tmux` subcommands, `ps`). Long-lived children with streaming stdio (a
/// conversation CLI, `tail -f` on a journal, the Neovim relay) get their own
/// type in the work packages that need them; this one is for request/answer.
public struct ProcessRunner: Sendable {
    public var environment: [String: String]?

    public init(environment: [String: String]? = nil) {
        self.environment = environment
    }

    /// Runs `executable` (an absolute path) with `arguments`.
    ///
    /// - Parameters:
    ///   - stdin: bytes written to the child's stdin, which is then closed.
    ///   - timeout: seconds; past it the child is terminated (SIGTERM) and
    ///     `ProcessRunnerError.timedOut` is thrown.
    public func run(
        _ executable: String,
        _ arguments: [String] = [],
        currentDirectory: String? = nil,
        stdin: Data? = nil,
        timeout: Double = 30
    ) async throws -> ProcessOutput {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        if let environment { process.environment = environment }
        if let currentDirectory { process.currentDirectoryURL = URL(fileURLWithPath: currentDirectory) }

        let outPipe = Pipe(), errPipe = Pipe(), inPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe
        process.standardInput = inPipe

        let collector = OutputCollector()
        outPipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if !chunk.isEmpty { collector.append(out: chunk) }
        }
        errPipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if !chunk.isEmpty { collector.append(err: chunk) }
        }

        let exit = ExitSignal()
        process.terminationHandler = { finished in exit.fire(finished.terminationStatus) }

        do {
            try process.run()
        } catch {
            outPipe.fileHandleForReading.readabilityHandler = nil
            errPipe.fileHandleForReading.readabilityHandler = nil
            throw ProcessRunnerError.launchFailed(executable: executable, reason: "\(error.localizedDescription)")
        }
        if let stdin { inPipe.fileHandleForWriting.write(stdin) }
        try? inPipe.fileHandleForWriting.close()

        // The watchdog terminates the child at the deadline; the exit that
        // follows is what ends the wait either way, so nothing is left running.
        let child = UncheckedBox(process)
        let timedOut = Flag()
        let watchdog = Task {
            try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            timedOut.set()
            child.value.terminate()
            // A child spawned from a concurrency thread on Linux inherits that
            // thread's blocked signals, so SIGTERM may never arrive; SIGKILL
            // cannot be blocked. One second's grace first.
            try await Task.sleep(nanoseconds: 1_000_000_000)
            if child.value.isRunning { kill(child.value.processIdentifier, SIGKILL) }
        }
        let status = await exit.wait() ?? -1
        if !timedOut.isSet { watchdog.cancel() }

        if timedOut.isSet {
            outPipe.fileHandleForReading.readabilityHandler = nil
            errPipe.fileHandleForReading.readabilityHandler = nil
            throw ProcessRunnerError.timedOut(executable: executable, seconds: timeout)
        }

        outPipe.fileHandleForReading.readabilityHandler = nil
        errPipe.fileHandleForReading.readabilityHandler = nil
        // Whatever arrived between the last handler call and the exit.
        if let rest = try? outPipe.fileHandleForReading.readToEnd(), !rest.isEmpty { collector.append(out: rest) }
        if let rest = try? errPipe.fileHandleForReading.readToEnd(), !rest.isEmpty { collector.append(err: rest) }
        let (out, err) = collector.snapshot()
        return ProcessOutput(status: status, stdout: out, stderr: err)
    }

    /// Finds `name` on `searchPath` (a `PATH`-style list), as `which` does.
    /// A name with a `/` in it is returned as is when it is executable.
    public static func resolveExecutable(_ name: String, searchPath: String) -> String? {
        let fm = FileManager.default
        if name.contains("/") { return fm.isExecutableFile(atPath: name) ? name : nil }
        for directory in searchPath.split(separator: ":") where !directory.isEmpty {
            let candidate = Path.join(String(directory), name)
            if fm.isExecutableFile(atPath: candidate) { return candidate }
        }
        return nil
    }
}

private final class OutputCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var out = Data()
    private var err = Data()

    func append(out chunk: Data) { lock.lock(); out.append(chunk); lock.unlock() }
    func append(err chunk: Data) { lock.lock(); err.append(chunk); lock.unlock() }
    func snapshot() -> (Data, Data) { lock.lock(); defer { lock.unlock() }; return (out, err) }
}

/// A one-shot latch a termination handler fires and any number of tasks await.
private final class ExitSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var status: Int32?
    private var waiters: [CheckedContinuation<Int32?, Never>] = []

    func fire(_ value: Int32) {
        lock.lock()
        status = value
        let pending = waiters
        waiters = []
        lock.unlock()
        for waiter in pending { waiter.resume(returning: value) }
    }

    func wait() async -> Int32? {
        await withCheckedContinuation { continuation in
            lock.lock()
            if let status {
                lock.unlock()
                continuation.resume(returning: status)
            } else {
                waiters.append(continuation)
                lock.unlock()
            }
        }
    }
}

private final class UncheckedBox<Value>: @unchecked Sendable {
    let value: Value
    init(_ value: Value) { self.value = value }
}

private final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    func set() { lock.lock(); value = true; lock.unlock() }
    var isSet: Bool { lock.lock(); defer { lock.unlock() }; return value }
}

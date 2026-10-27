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
        // Not Foundation's `Process`: on Linux it reads its pipes through
        // `FileHandle.readabilityHandler`, whose descriptor is closed as soon
        // as the source is cancelled, before libdispatch has let go of it —
        // the next pipe handed the same number can then sit on a stale epoll
        // registration and never hear from its child, or have the event loop
        // crash on it. And it learns of an exit through a socket every
        // descendant inherits. `SpawnedChild` closes a descriptor only once
        // its source is done with it, and reaps on a thread of its own.
        let child: SpawnedChild
        do {
            child = try SpawnedChild.spawn(
                executable: executable, args: arguments, env: environment ?? ProcessInfo.processInfo.environment,
                cwd: currentDirectory, pipeStdin: stdin != nil)
        } catch {
            let code = Int32((error as NSError).code)
            throw ProcessRunnerError.launchFailed(executable: executable, reason: String(cString: strerror(code)))
        }

        let run = RunToEnd()
        let queue = DispatchQueue(label: "devhub.process-runner")
        let readers = [
            DescriptorReader(child.stdout, queue: queue, onChunk: { run.append(out: $0) }, onEnd: { run.ended(stream: 0) }),
            DescriptorReader(child.stderr, queue: queue, onChunk: { run.append(err: $0) }, onEnd: { run.ended(stream: 1) }),
        ]
        for reader in readers { reader.start() }
        child.whenExited { code, signal in run.exited(code ?? signal ?? -1) }
        if let stdin {
            // On a thread of its own: a child that writes a lot before it
            // reads must not wait on a writer that waits on it.
            let fd = child.stdin
            DispatchQueue.global().async { _ = writeAllAndClose(fd, stdin) }
        }

        // The watchdog terminates the child at the deadline; the exit that
        // follows is what ends the wait either way, so nothing is left running.
        let watchdog = Task {
            try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            run.timedOut()
            child.signalGroup(SIGTERM)
            // A child spawned from a concurrency thread on Linux inherits that
            // thread's blocked signals, so SIGTERM may never arrive; SIGKILL
            // cannot be blocked. One second's grace first.
            try await Task.sleep(nanoseconds: 1_000_000_000)
            if child.isRunning { child.signalGroup(SIGKILL) }
        }
        let outcome = await run.finished()
        watchdog.cancel()
        if outcome.timedOut {
            // Whatever still holds the pipes is not waited for.
            for reader in readers { reader.stop() }
            throw ProcessRunnerError.timedOut(executable: executable, seconds: timeout)
        }
        return ProcessOutput(status: outcome.status, stdout: outcome.stdout, stderr: outcome.stderr)
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

/// One run's output and exit: done once the child has exited and both its
/// streams have ended — or, past the deadline, once it has exited.
private final class RunToEnd: @unchecked Sendable {
    struct Outcome {
        let status: Int32
        let stdout: Data
        let stderr: Data
        let timedOut: Bool
    }

    private let lock = NSLock()
    private var out = Data()
    private var err = Data()
    private var streamsOpen = 2
    private var status: Int32?
    private var late = false
    private var outcome: Outcome?
    private var waiters: [CheckedContinuation<Outcome, Never>] = []

    func append(out chunk: Data) { lock.withLock { out.append(chunk) } }
    func append(err chunk: Data) { lock.withLock { err.append(chunk) } }
    func ended(stream: Int) { settle { $0.streamsOpen -= 1 } }
    func exited(_ value: Int32) { settle { $0.status = value } }
    func timedOut() { settle { $0.late = true } }

    private func settle(_ change: (RunToEnd) -> Void) {
        let (done, pending): (Outcome?, [CheckedContinuation<Outcome, Never>]) = lock.withLock {
            change(self)
            guard outcome == nil, let status, streamsOpen == 0 || late else { return (nil, []) }
            let done = Outcome(status: status, stdout: out, stderr: err, timedOut: late)
            outcome = done
            defer { waiters = [] }
            return (done, waiters)
        }
        guard let done else { return }
        for waiter in pending { waiter.resume(returning: done) }
    }

    func finished() async -> Outcome {
        await withCheckedContinuation { continuation in
            let done: Outcome? = lock.withLock {
                if let outcome { return outcome }
                waiters.append(continuation)
                return nil
            }
            if let done { continuation.resume(returning: done) }
        }
    }
}

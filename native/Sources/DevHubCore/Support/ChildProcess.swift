// A long-lived child process with streaming stdio.
//
// `ProcessRunner` is for request/answer: run, collect, exit. This is for the
// children that stay — a login shell being asked for its environment, a
// conversation CLI, `tail -f` on a journal, a usage reader — whose output is
// read as it arrives and whose stdin is written while they run.
//
// It is `posix_spawn` rather than Foundation's `Process` for two reasons the
// TypeScript app gets from Node's `spawn` for free: a child can be started in
// a session of its own (`detached: true` — an interactive login shell must not
// take over the terminal DevHub was started from), and its whole process group
// can be signalled. Termination is SIGTERM, then SIGKILL after a grace period:
// a child spawned from a Swift-concurrency thread on Linux may inherit blocked
// signals and never see the SIGTERM (PLAN.md §3.4).

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif
import Foundation

public enum ChildProcessError: Error, Equatable, CustomStringConvertible, Sendable {
    case spawnFailed(executable: String, errno: Int32)
    case notRunning

    public var description: String {
        switch self {
        case .spawnFailed(let executable, let code):
            return "\(executable) could not be started: \(String(cString: strerror(code)))"
        case .notRunning:
            return "the process is not running"
        }
    }
}

/// How a child ended.
public enum ChildExit: Equatable, Sendable, CustomStringConvertible {
    case exited(Int32)
    case signaled(Int32)

    public var code: Int32? {
        if case .exited(let code) = self { return code }
        return nil
    }

    public var signal: Int32? {
        if case .signaled(let signal) = self { return signal }
        return nil
    }

    /// Node's name for a signal (`SIGTERM`), for messages that say it the way
    /// the TypeScript app's do.
    public static func signalName(_ signal: Int32) -> String {
        switch signal {
        case SIGHUP: return "SIGHUP"
        case SIGINT: return "SIGINT"
        case SIGQUIT: return "SIGQUIT"
        case SIGKILL: return "SIGKILL"
        case SIGSEGV: return "SIGSEGV"
        case SIGPIPE: return "SIGPIPE"
        case SIGTERM: return "SIGTERM"
        case SIGABRT: return "SIGABRT"
        case SIGUSR1: return "SIGUSR1"
        case SIGUSR2: return "SIGUSR2"
        default: return "SIG\(signal)"
        }
    }

    public var description: String {
        switch self {
        case .exited(let code): return "exited with code \(code)"
        case .signaled(let signal): return "killed by \(ChildExit.signalName(signal))"
        }
    }
}

public final class ChildProcess: @unchecked Sendable {
    /// What one of the child's standard streams is connected to.
    public enum Stream: Sendable {
        /// A pipe DevHub reads (stdout, stderr) or writes (stdin).
        case pipe
        /// `/dev/null`.
        case null
    }

    /// `POSIX_SPAWN_SETSID`, which glibc only declares under `_GNU_SOURCE`.
    #if canImport(Darwin)
    static let spawnSetSID: Int32 = Int32(POSIX_SPAWN_SETSID)
    #else
    static let spawnSetSID: Int32 = 0x80
    #endif

    public let pid: pid_t
    public let executable: String
    /// Chunks of the child's stdout as they arrive; finishes at EOF.
    public let stdout: AsyncStream<Data>
    /// Chunks of the child's stderr as they arrive; finishes at EOF.
    public let stderr: AsyncStream<Data>

    private let lock = NSLock()
    private var stdinFD: Int32
    private var exitStatus: ChildExit?
    private var waiters: [CheckedContinuation<ChildExit, Never>] = []
    private let newSession: Bool

    private init(pid: pid_t, executable: String, stdinFD: Int32, newSession: Bool, stdout: AsyncStream<Data>, stderr: AsyncStream<Data>) {
        self.pid = pid
        self.executable = executable
        self.stdinFD = stdinFD
        self.newSession = newSession
        self.stdout = stdout
        self.stderr = stderr
    }

    /// Start `executable` (an absolute path) with `arguments`.
    ///
    /// - Parameters:
    ///   - environment: the child's whole environment (nothing is inherited).
    ///   - newSession: start the child in a session (and process group) of its
    ///     own, as Node's `detached: true` does.
    public static func spawn(
        executable: String,
        arguments: [String] = [],
        environment: [String: String],
        currentDirectory: String? = nil,
        newSession: Bool = false,
        stdin: Stream = .null,
        stdout: Stream = .pipe,
        stderr: Stream = .pipe
    ) throws -> ChildProcess {
        var actions = posix_spawn_file_actions_t()
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        var attributes = posix_spawnattr_t()
        posix_spawnattr_init(&attributes)
        defer { posix_spawnattr_destroy(&attributes) }

        var flags: Int32 = Int32(POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF)
        if newSession { flags |= ChildProcess.spawnSetSID }
        posix_spawnattr_setflags(&attributes, Int16(truncatingIfNeeded: flags))
        // A clean signal state: nothing blocked (see the header), every signal
        // at its default.
        var none = sigset_t()
        sigemptyset(&none)
        posix_spawnattr_setsigmask(&attributes, &none)
        var all = sigset_t()
        sigfillset(&all)
        posix_spawnattr_setsigdefault(&attributes, &all)

        var opened: [Int32] = []
        func pipePair() throws -> (Int32, Int32) {
            var fds: [Int32] = [0, 0]
            if pipe(&fds) != 0 { throw ChildProcessError.spawnFailed(executable: executable, errno: errno) }
            opened += fds
            return (fds[0], fds[1])
        }
        defer { for fd in opened { close(fd) } }

        var parentStdin: Int32 = -1
        var parentStdout: Int32 = -1
        var parentStderr: Int32 = -1
        switch stdin {
        case .pipe:
            let (read, write) = try pipePair()
            posix_spawn_file_actions_adddup2(&actions, read, 0)
            parentStdin = dup(write)
        case .null:
            posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        }
        switch stdout {
        case .pipe:
            let (read, write) = try pipePair()
            posix_spawn_file_actions_adddup2(&actions, write, 1)
            parentStdout = dup(read)
        case .null:
            posix_spawn_file_actions_addopen(&actions, 1, "/dev/null", O_WRONLY, 0)
        }
        switch stderr {
        case .pipe:
            let (read, write) = try pipePair()
            posix_spawn_file_actions_adddup2(&actions, write, 2)
            parentStderr = dup(read)
        case .null:
            posix_spawn_file_actions_addopen(&actions, 2, "/dev/null", O_WRONLY, 0)
        }
        // The pipe ends the child does not use are closed in it by `opened`'s
        // close-on-exec below.
        for fd in opened { _ = fcntl(fd, F_SETFD, FD_CLOEXEC) }
        for fd in [parentStdin, parentStdout, parentStderr] where fd >= 0 { _ = fcntl(fd, F_SETFD, FD_CLOEXEC) }

        if let currentDirectory {
            posix_spawn_file_actions_addchdir_np(&actions, currentDirectory)
        }

        let argv = ([executable] + arguments).map { strdup($0) }
        defer { for pointer in argv { free(pointer) } }
        let envp = environment.map { strdup("\($0.key)=\($0.value)") }
        defer { for pointer in envp { free(pointer) } }
        var cArgs: [UnsafeMutablePointer<CChar>?] = argv + [nil]
        var cEnv: [UnsafeMutablePointer<CChar>?] = envp + [nil]

        var pid: pid_t = 0
        let result = posix_spawn(&pid, executable, &actions, &attributes, &cArgs, &cEnv)
        if result != 0 {
            for fd in [parentStdin, parentStdout, parentStderr] where fd >= 0 { close(fd) }
            throw ChildProcessError.spawnFailed(executable: executable, errno: result)
        }

        let child = ChildProcess(
            pid: pid,
            executable: executable,
            stdinFD: parentStdin,
            newSession: newSession,
            stdout: ChildProcess.reader(parentStdout),
            stderr: ChildProcess.reader(parentStderr)
        )
        child.startReaping()
        return child
    }

    /// A stream of what arrives on `fd`, read on a thread of its own, closed
    /// at EOF. An unused stream (`fd < 0`) finishes at once.
    private static func reader(_ fd: Int32) -> AsyncStream<Data> {
        AsyncStream { continuation in
            guard fd >= 0 else {
                continuation.finish()
                return
            }
            let thread = Thread {
                var buffer = [UInt8](repeating: 0, count: 65536)
                while true {
                    let count = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
                    if count < 0 && errno == EINTR { continue }
                    if count <= 0 { break }
                    continuation.yield(Data(buffer[0..<count]))
                }
                close(fd)
                continuation.finish()
            }
            thread.start()
        }
    }

    private func startReaping() {
        let pid = self.pid
        let thread = Thread { [self] in
            var status: Int32 = 0
            while waitpid(pid, &status, 0) < 0 {
                if errno != EINTR {
                    status = 0
                    break
                }
            }
            let exit: ChildExit
            // WIFEXITED / WEXITSTATUS / WTERMSIG, spelled out: the macros are
            // not imported into Swift.
            let low = status & 0x7f
            if low == 0 {
                exit = .exited((status >> 8) & 0xff)
            } else {
                exit = .signaled(low)
            }
            lock.lock()
            exitStatus = exit
            let pending = waiters
            waiters = []
            lock.unlock()
            for waiter in pending { waiter.resume(returning: exit) }
        }
        thread.start()
    }

    /// How the child ended, once it has.
    public var exit: ChildExit? {
        lock.lock()
        defer { lock.unlock() }
        return exitStatus
    }

    public var isRunning: Bool { exit == nil }

    /// Wait for the child to end.
    public func wait() async -> ChildExit {
        await withCheckedContinuation { continuation in
            lock.lock()
            if let exitStatus {
                lock.unlock()
                continuation.resume(returning: exitStatus)
            } else {
                waiters.append(continuation)
                lock.unlock()
            }
        }
    }

    /// Write to the child's stdin (which must be a pipe).
    public func write(_ data: Data) throws {
        lock.lock()
        let fd = stdinFD
        lock.unlock()
        guard fd >= 0 else { throw ChildProcessError.notRunning }
        var offset = 0
        let bytes = [UInt8](data)
        while offset < bytes.count {
            let written = bytes[offset...].withUnsafeBytes { Foundation.write(fd, $0.baseAddress, $0.count) }
            if written < 0 {
                if errno == EINTR { continue }
                throw ChildProcessError.notRunning
            }
            offset += written
        }
    }

    /// Close the child's stdin, so it sees EOF.
    public func closeStdin() {
        lock.lock()
        let fd = stdinFD
        stdinFD = -1
        lock.unlock()
        if fd >= 0 { close(fd) }
    }

    /// Send `signal` to the child — or to its whole process group, when it was
    /// started in a session of its own.
    public func signal(_ signal: Int32) {
        guard isRunning else { return }
        if newSession {
            _ = kill(-pid, signal)
        } else {
            _ = kill(pid, signal)
        }
    }

    /// SIGTERM, then SIGKILL after `grace` seconds if it is still running.
    public func terminate(grace: Double = 1) {
        signal(SIGTERM)
        let pid = self.pid
        let group = newSession
        Thread.detachNewThread { [weak self] in
            Thread.sleep(forTimeInterval: grace)
            guard let self, self.isRunning else { return }
            _ = kill(group ? -pid : pid, SIGKILL)
        }
    }

    deinit {
        if stdinFD >= 0 { close(stdinFD) }
    }
}

extension AsyncStream where Element == Data {
    /// Everything the stream carries, until it finishes.
    public func collect() async -> Data {
        var all = Data()
        for await chunk in self { all.append(chunk) }
        return all
    }
}

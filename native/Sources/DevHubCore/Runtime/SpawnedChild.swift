// The one way the runtime starts a program over pipes: what Node's
// `spawn(file, args, { stdio: [...pipes], detached: true })` gives the TS
// `runBounded` and `openByteStream`.
//
// Not Foundation's `Process`, for two reasons that both decide whether an
// answer ever arrives. On Linux, `Process` learns that its child exited through
// a socket the child inherits — and so does every descendant, so a child that
// forks (tmux does: the server it starts outlives the client) keeps the parent
// from ever hearing that the client exited. And `Process` offers no session of
// the child's own, so a provider's descendants cannot be killed as a whole.
//
// Here the child is started in a new session (`detached: true`), inherits
// exactly its three standard streams and nothing else — the way libuv opens
// every descriptor close-on-exec — and is reaped by a thread of its own.

import Foundation
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif

final class SpawnedChild: @unchecked Sendable {
    let pid: pid_t
    /// The parent's ends: stdin's write end (or -1), stdout's and stderr's
    /// read ends. Owned by whoever reads them; closed by them.
    let stdin: Int32
    let stdout: Int32
    let stderr: Int32

    private let lock = NSLock()
    private var exitStatus: (code: Int32?, signal: Int32?)?
    private var onExit: (@Sendable (Int32?, Int32?) -> Void)?

    private init(pid: pid_t, stdin: Int32, stdout: Int32, stderr: Int32) {
        self.pid = pid
        self.stdin = stdin
        self.stdout = stdout
        self.stderr = stderr
    }

    /// One spawn at a time from here, so a pipe made for one child is
    /// close-on-exec before another child of this runtime can be started.
    private static let spawnLock = NSLock()

    #if canImport(Darwin)
    private static let sessionFlag = Int32(POSIX_SPAWN_SETSID)
    #else
    /// glibc declares it only under `_GNU_SOURCE`.
    private static let sessionFlag: Int32 = 0x80
    #endif

    /// Start `executable` (an absolute path).
    ///
    /// - Throws: the `errno` posix_spawn answered, as an `NSError` in
    ///   `NSPOSIXErrorDomain`.
    static func spawn(executable: String, args: [String], env: [String: String], cwd: String?, pipeStdin: Bool) throws -> SpawnedChild {
        spawnLock.lock()
        defer { spawnLock.unlock() }

        #if canImport(Darwin)
        var actions: posix_spawn_file_actions_t?
        var attributes: posix_spawnattr_t?
        #else
        var actions = posix_spawn_file_actions_t()
        var attributes = posix_spawnattr_t()
        #endif
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawnattr_init(&attributes)
        defer { posix_spawnattr_destroy(&attributes) }

        let flags = Int32(POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF) | sessionFlag | SpawnHygiene.spawnFlags
        posix_spawnattr_setflags(&attributes, Int16(truncatingIfNeeded: flags))
        // A clean signal state: nothing blocked, every signal at its default —
        // what a process started from a shell would have.
        var none = sigset_t()
        sigemptyset(&none)
        posix_spawnattr_setsigmask(&attributes, &none)
        var all = sigset_t()
        sigfillset(&all)
        posix_spawnattr_setsigdefault(&attributes, &all)

        var made: [Int32] = []
        func pipePair() throws -> (read: Int32, write: Int32) {
            var fds: [Int32] = [0, 0]
            if pipe(&fds) != 0 { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
            for fd in fds { _ = fcntl(fd, F_SETFD, FD_CLOEXEC) }
            made += fds
            return (fds[0], fds[1])
        }
        var keep: Set<Int32> = []
        defer { for fd in made where !keep.contains(fd) { close(fd) } }

        var parentStdin: Int32 = -1
        if pipeStdin {
            // A reader that has gone must be an error on the write, not a
            // SIGPIPE that ends DevHub — Node ignores it for the same reason.
            // The child gets the default back (`setsigdefault` above).
            _ = ignoreBrokenPipes

            let input = try pipePair()
            posix_spawn_file_actions_adddup2(&actions, input.read, 0)
            parentStdin = input.write
        } else {
            posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        }
        let output = try pipePair()
        posix_spawn_file_actions_adddup2(&actions, output.write, 1)
        let errors = try pipePair()
        posix_spawn_file_actions_adddup2(&actions, errors.write, 2)
        SpawnHygiene.closeInherited(&actions)
        if let cwd { posix_spawn_file_actions_addchdir_np(&actions, cwd) }

        let argv = ([executable] + args).map { strdup($0) }
        defer { for pointer in argv { free(pointer) } }
        let envp = env.map { strdup("\($0.key)=\($0.value)") }
        defer { for pointer in envp { free(pointer) } }
        var cArgs: [UnsafeMutablePointer<CChar>?] = argv + [nil]
        var cEnv: [UnsafeMutablePointer<CChar>?] = envp + [nil]

        var pid: pid_t = 0
        let result = posix_spawn(&pid, executable, &actions, &attributes, &cArgs, &cEnv)
        if result != 0 { throw NSError(domain: NSPOSIXErrorDomain, code: Int(result)) }
        if parentStdin >= 0 { keep.insert(parentStdin) }
        keep.insert(output.read)
        keep.insert(errors.read)
        let child = SpawnedChild(pid: pid, stdin: parentStdin, stdout: output.read, stderr: errors.read)
        child.reap()
        return child
    }

    /// Called once, with (code, nil) or (nil, signal), when the child has
    /// exited — at once when it already has.
    func whenExited(_ handler: @escaping @Sendable (Int32?, Int32?) -> Void) {
        let already: (code: Int32?, signal: Int32?)? = lock.withLock {
            if let exitStatus { return exitStatus }
            onExit = handler
            return nil
        }
        if let already { handler(already.code, already.signal) }
    }

    var isRunning: Bool { lock.withLock { exitStatus == nil } }

    private func reap() {
        let pid = self.pid
        let thread = Thread { [self] in
            var status: Int32 = 0
            while waitpid(pid, &status, 0) < 0 {
                if errno != EINTR {
                    status = 0
                    break
                }
            }
            // WIFEXITED / WEXITSTATUS / WTERMSIG, spelled out: the macros are
            // not imported into Swift.
            let low = status & 0x7f
            let ended: (code: Int32?, signal: Int32?) = low == 0 ? ((status >> 8) & 0xff, nil) : (nil, low)
            let handler: (@Sendable (Int32?, Int32?) -> Void)? = lock.withLock {
                exitStatus = ended
                defer { onExit = nil }
                return onExit
            }
            handler?(ended.code, ended.signal)
        }
        thread.start()
    }

    /// Signal the child's whole session — the group it leads, descendants
    /// included, even once the leader itself has exited — and the child.
    func signalGroup(_ signal: Int32) {
        #if canImport(Glibc)
        _ = Glibc.kill(-pid, signal)
        if isRunning { _ = Glibc.kill(pid, signal) }
        #else
        _ = Darwin.kill(-pid, signal)
        if isRunning { _ = Darwin.kill(pid, signal) }
        #endif
    }
}

/// Read one descriptor to its end on a dispatch source: non-blocking, drained
/// to EAGAIN on every event (one event may carry the last bytes and the end of
/// the stream together), closed once the source has let go of it — a
/// descriptor closed under a live source is a number the next pipe may be
/// handed.
final class DescriptorReader: @unchecked Sendable {
    private let source: DispatchSourceRead

    init(_ fd: Int32, queue: DispatchQueue, onChunk: @escaping @Sendable (Data) -> Void, onEnd: @escaping @Sendable () -> Void) {
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
        source.setCancelHandler { close(fd) }
        self.source = source
    }

    func start() { source.resume() }

    func stop() {
        if !source.isCancelled { source.cancel() }
    }

    var isStopped: Bool { source.isCancelled }
}

private let ignoreBrokenPipes: Void = {
    _ = signal(SIGPIPE, SIG_IGN)
}()

/// Write all of `data` to `fd`, then close it. False when the reader went away
/// before all of it was written.
func writeAllAndClose(_ fd: Int32, _ data: Data) -> Bool {
    defer { close(fd) }
    let bytes = [UInt8](data)
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
            return false
        }
        offset += written
    }
    return true
}

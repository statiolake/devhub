// Port of apps/desktop/src/main/terminal/pty.ts.
//
// The one place DevHub opens a pseudo-terminal.
//
// The TS app reached `node-pty` through the VS Code submodule; the native app
// opens the PTY itself with `forkpty`, so a surface (WP9's SwiftTerm view, or
// anything else) is handed bytes and writes bytes, and everything below the
// narrow `PseudoTerminal` protocol can be exercised with a fake.
//
// The program a DevHub PTY runs is always a tmux client (`tmux attach-session`),
// so the child is set up the way a terminal emulator sets up its shell: a new
// session with the PTY as its controlling terminal, the signal mask and the
// dispositions a Swift process may have changed put back, the working
// directory and the environment exactly as given.

import Foundation
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif

/// What to open a pseudo-terminal on.
public struct PtyLaunch: Sendable, Equatable {
    /// The absolute path of the program to run. Always the tmux client.
    public var file: String
    public var args: [String]
    public var cwd: String
    public var cols: Int
    public var rows: Int
    public var pixelWidth: Int
    public var pixelHeight: Int
    public var env: [String: String]

    public init(
        file: String, args: [String], cwd: String,
        cols: Int, rows: Int, pixelWidth: Int = 0, pixelHeight: Int = 0,
        env: [String: String]
    ) {
        self.file = file
        self.args = args
        self.cwd = cwd
        self.cols = cols
        self.rows = rows
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
        self.env = env
    }
}

/// A terminal's size, in cells and pixels (`TerminalSize`).
public struct TerminalSize: Sendable, Equatable {
    public var cols: Int
    public var rows: Int
    public var pixelWidth: Int
    public var pixelHeight: Int
    public init(cols: Int, rows: Int, pixelWidth: Int = 0, pixelHeight: Int = 0) {
        self.cols = cols
        self.rows = rows
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
    }

    public static let minCols = 1, maxCols = 500, minRows = 1, maxRows = 500, maxPixel = 10_000

    /// The bounds `validateSize` holds a size to.
    public var isValid: Bool {
        cols >= TerminalSize.minCols && cols <= TerminalSize.maxCols
            && rows >= TerminalSize.minRows && rows <= TerminalSize.maxRows
            && pixelWidth >= 0 && pixelHeight >= 0
            && pixelWidth <= TerminalSize.maxPixel && pixelHeight <= TerminalSize.maxPixel
    }
}

/// The narrow PTY the attachment logic owns.
public protocol PseudoTerminal: AnyObject, Sendable {
    var pid: Int32 { get }
    /// Every byte the program writes. Set before `resume()`.
    func onData(_ listener: @escaping @Sendable (Data) -> Void)
    /// `exitCode` is the program's, when the platform reported one.
    func onExit(_ listener: @escaping @Sendable (Int32?) -> Void)
    func write(_ bytes: Data)
    func resize(_ size: TerminalSize)
    func kill()
    func pause()
    func resume()
}

public typealias PtyFactory = @Sendable (PtyLaunch) throws -> any PseudoTerminal

/// The environment the tmux client starts with.
///
/// The surface's capability set is deliberately stable across launch
/// environments: inheriting the host's `TERM` (`dumb`, or a Ghostty- or
/// WezTerm-specific value) can make tmux refuse the client outright.
/// `TMUX`/`TMUX_PANE` are removed because a DevHub launched from inside a tmux
/// pane must not let its client believe it is nesting inside that server.
///
/// `TERM` stays `xterm-256color` and `COLORTERM` says `truecolor`: `TERM` names
/// a terminfo entry that must exist on any machine, and `COLORTERM` is the
/// out-of-band channel invented precisely because terminfo could not express
/// 24-bit colour. tmux reads it from the attaching client and adds the `RGB`
/// feature for that client on its own.
public func terminalEnvironment(_ base: [String: String]) -> [String: String] {
    var env = base
    env.removeValue(forKey: "TMUX")
    env.removeValue(forKey: "TMUX_PANE")
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"
    return env
}

public enum PtyError: Error, Equatable, CustomStringConvertible {
    case forkFailed(errno: Int32)
    case unsupported

    public var description: String {
        switch self {
        case .forkFailed(let code): return "DevHub could not open a terminal: \(String(cString: strerror(code)))"
        case .unsupported: return "DevHub cannot open a terminal on this platform"
        }
    }
}

#if os(Linux)
private typealias ForkPtyFunction = @convention(c) (
    UnsafeMutablePointer<Int32>?, UnsafeMutablePointer<CChar>?, UnsafeMutableRawPointer?, UnsafeMutablePointer<winsize>?
) -> pid_t

/// glibc has had `forkpty` in libc itself since 2.34; it is not exported to
/// Swift by the Glibc module, so it is looked up once.
private let linuxForkpty: ForkPtyFunction? = {
    guard let handle = dlopen(nil, RTLD_NOW), let symbol = dlsym(handle, "forkpty") else {
        guard let util = dlopen("libutil.so.1", RTLD_NOW), let symbol = dlsym(util, "forkpty") else { return nil }
        return unsafeBitCast(symbol, to: ForkPtyFunction.self)
    }
    return unsafeBitCast(symbol, to: ForkPtyFunction.self)
}()
#endif

/// Open a real PTY running `launch.file`.
public let openPty: PtyFactory = { launch in try ForkedPty(launch) }

/// A child on a PTY this process holds the master side of.
public final class ForkedPty: PseudoTerminal, @unchecked Sendable {
    public let pid: Int32
    private let master: Int32
    private let lock = NSLock()
    private var dataListeners: [@Sendable (Data) -> Void] = []
    private var exitListeners: [@Sendable (Int32?) -> Void] = []
    private var source: DispatchSourceRead?
    private var paused = true
    private var ended = false
    private var exitCode: Int32??
    private let queue = DispatchQueue(label: "devhub.pty")

    init(_ launch: PtyLaunch) throws {
        // Everything the child needs is made before the fork: between `fork`
        // and `exec` only async-signal-safe calls are allowed.
        let file = strdup(launch.file)!
        let cwd = strdup(launch.cwd)!
        let argList = [launch.file] + launch.args
        let envList = launch.env.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }
        let argv = UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>.allocate(capacity: argList.count + 1)
        let envp = UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>.allocate(capacity: envList.count + 1)
        for (index, item) in argList.enumerated() { argv[index] = strdup(item) }
        argv[argList.count] = nil
        for (index, item) in envList.enumerated() { envp[index] = strdup(item) }
        envp[envList.count] = nil
        defer {
            free(file)
            free(cwd)
            for index in 0..<argList.count { free(argv[index]) }
            for index in 0..<envList.count { free(envp[index]) }
            argv.deallocate()
            envp.deallocate()
        }
        var size = winsize(
            ws_row: UInt16(clamping: launch.rows), ws_col: UInt16(clamping: launch.cols),
            ws_xpixel: UInt16(clamping: launch.pixelWidth), ws_ypixel: UInt16(clamping: launch.pixelHeight)
        )
        var empty = sigset_t()
        sigemptyset(&empty)
        var masterFd: Int32 = -1
        let afterFork = SpawnHygiene.prepareForFork()
        #if os(Linux)
        guard let forkpty = linuxForkpty else { throw PtyError.unsupported }
        let child = forkpty(&masterFd, nil, nil, &size)
        #else
        let child = Darwin.forkpty(&masterFd, nil, nil, &size)
        #endif
        if child < 0 { throw PtyError.forkFailed(errno: errno) }
        if child == 0 {
            // The child. A thread of a Swift process may have blocked signals
            // (see PLAN.md §3.4), and blocked or ignored signals survive exec:
            // a tmux client that never sees SIGWINCH never resizes.
            _ = sigprocmask(SIG_SETMASK, &empty, nil)
            _ = signal(SIGPIPE, SIG_DFL)
            _ = signal(SIGINT, SIG_DFL)
            _ = signal(SIGQUIT, SIG_DFL)
            _ = signal(SIGTERM, SIG_DFL)
            _ = signal(SIGCHLD, SIG_DFL)
            // Its terminal and nothing else: what it inherited of DevHub's
            // stays open for as long as it lives (SpawnHygiene.swift).
            SpawnHygiene.closeInheritedAfterFork(afterFork)
            _ = chdir(cwd)
            _ = execve(file, argv, envp)
            _exit(127)
        }
        pid = child
        master = masterFd
        _ = fcntl(masterFd, F_SETFD, FD_CLOEXEC)
        // Non-blocking, and drained to EAGAIN on every event (see `DescriptorReader`).
        _ = fcntl(masterFd, F_SETFL, fcntl(masterFd, F_GETFL) | O_NONBLOCK)
        let source = DispatchSource.makeReadSource(fileDescriptor: masterFd, queue: queue)
        source.setEventHandler { [weak self] in self?.readAvailable() }
        // Closed once the source has let go of it, never before: a descriptor
        // closed under a live source is a number the next pipe may be handed,
        // and libdispatch's epoll registration for it is then the wrong one.
        let fd = masterFd
        source.setCancelHandler { _ = close(fd) }
        self.source = source
        // Held paused until the owner has said where the bytes go: nothing may
        // reach a view before it is ready for them.
    }

    deinit {
        // A source is cancelled only once it runs: one still held paused is
        // let go first, and its cancel handler closes the master.
        if !ended {
            if paused { source?.resume() }
            source?.cancel()
        }
    }

    public func onData(_ listener: @escaping @Sendable (Data) -> Void) {
        lock.lock(); dataListeners.append(listener); lock.unlock()
    }

    public func onExit(_ listener: @escaping @Sendable (Int32?) -> Void) {
        lock.lock()
        if let exitCode {
            lock.unlock()
            listener(exitCode)
            return
        }
        exitListeners.append(listener)
        lock.unlock()
    }

    public func write(_ bytes: Data) {
        // Once it has ended the master is on its way to being closed, and its
        // number may soon be another descriptor's.
        if lock.withLock({ ended }) { return }
        bytes.withUnsafeBytes { raw in
            guard var pointer = raw.baseAddress else { return }
            var left = raw.count
            while left > 0 {
                let written = Glibc_or_Darwin_write(master, pointer, left)
                if written < 0 {
                    if errno == EINTR { continue }
                    // The terminal's input queue is full: let the client read.
                    if errno == EAGAIN { usleep(1_000); continue }
                    return
                }
                left -= written
                pointer = pointer.advanced(by: written)
            }
        }
    }

    public func resize(_ size: TerminalSize) {
        var ws = winsize(
            ws_row: UInt16(clamping: size.rows), ws_col: UInt16(clamping: size.cols),
            ws_xpixel: UInt16(clamping: size.pixelWidth), ws_ypixel: UInt16(clamping: size.pixelHeight)
        )
        if lock.withLock({ ended }) { return }
        _ = ioctl(master, UInt(TIOCSWINSZ), &ws)
    }

    public func kill() {
        lock.lock()
        let alreadyEnded = ended
        lock.unlock()
        if alreadyEnded { return }
        _ = Glibc_or_Darwin_kill(pid, SIGHUP)
        _ = Glibc_or_Darwin_kill(pid, SIGKILL)
    }

    public func pause() {
        lock.lock()
        defer { lock.unlock() }
        if paused || ended { return }
        paused = true
        source?.suspend()
    }

    public func resume() {
        lock.lock()
        defer { lock.unlock() }
        if !paused || ended { return }
        paused = false
        source?.resume()
    }

    private func readAvailable() {
        var buffer = [UInt8](repeating: 0, count: 65_536)
        while true {
            let count = buffer.withUnsafeMutableBytes { Glibc_or_Darwin_read(master, $0.baseAddress, $0.count) }
            if count > 0 {
                let chunk = Data(buffer[0..<count])
                let listeners = lock.withLock { dataListeners }
                for listener in listeners { listener(chunk) }
                continue
            }
            if count < 0 && errno == EINTR { continue }
            if count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) { return }
            // EOF, or EIO once the last slave descriptor closed: the child is
            // gone or going.
            finishExit()
            return
        }
    }

    private func finishExit() {
        lock.lock()
        if ended {
            lock.unlock()
            return
        }
        ended = true
        let source = self.source
        let wasPaused = paused
        lock.unlock()
        if wasPaused { source?.resume() }
        source?.cancel()
        let pid = self.pid
        Thread.detachNewThread { [weak self] in
            var status: Int32 = 0
            var answer: pid_t
            repeat { answer = waitpid(pid, &status, 0) } while answer < 0 && errno == EINTR
            let code: Int32? = answer == pid && (status & 0x7f) == 0 ? (status >> 8) & 0xff : nil
            self?.reportExit(code)
        }
    }

    private func reportExit(_ code: Int32?) {
        lock.lock()
        exitCode = .some(code)
        let listeners = exitListeners
        exitListeners = []
        lock.unlock()
        for listener in listeners { listener(code) }
    }
}

// The libc spellings, without the module name, so the methods above can use
// names (`write`, `kill`, `read`) of their own.
@inline(__always) private func Glibc_or_Darwin_write(_ fd: Int32, _ buffer: UnsafeRawPointer, _ count: Int) -> Int {
    #if canImport(Glibc)
    return Glibc.write(fd, buffer, count)
    #else
    return Darwin.write(fd, buffer, count)
    #endif
}

@inline(__always) private func Glibc_or_Darwin_read(_ fd: Int32, _ buffer: UnsafeMutableRawPointer?, _ count: Int) -> Int {
    #if canImport(Glibc)
    return Glibc.read(fd, buffer, count)
    #else
    return Darwin.read(fd, buffer, count)
    #endif
}

@inline(__always) private func Glibc_or_Darwin_kill(_ pid: pid_t, _ signal: Int32) -> Int32 {
    #if canImport(Glibc)
    return Glibc.kill(pid, signal)
    #else
    return Darwin.kill(pid, signal)
    #endif
}

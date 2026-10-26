// POSIX unix-domain stream sockets: the control socket (`control.sock`, WP7)
// and the managed Neovims' sockets (WP7) are both these.
//
// A thin layer with the rules the TypeScript app relies on spelled out:
//
// - `sun_path` is 104 bytes on macOS (108 on Linux), and a path that does not
//   fit is a failure that says so, never a silent truncation onto some other
//   path.
// - A listening socket is created with the mode it is meant to have (0600 for
//   the control socket), not chmod-ed afterwards, so there is no moment it is
//   open to anybody else.
// - A stale socket file (nobody listening) is taken over; a live one is
//   refused, which is how a second DevHub on one profile is turned away.

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif
import Foundation

public enum UnixSocketError: Error, Equatable, CustomStringConvertible, Sendable {
    /// The path is longer than `sun_path` can hold.
    case pathTooLong(path: String, limit: Int)
    /// Another process is already listening there.
    case inUse(path: String)
    case system(operation: String, path: String, errno: Int32)
    case closed

    public var description: String {
        switch self {
        case .pathTooLong(let path, let limit):
            return "\(path) is too long for a unix socket (\(path.utf8.count) bytes; at most \(limit))"
        case .inUse(let path):
            return "\(path) is already being listened on"
        case .system(let operation, let path, let code):
            return "\(operation) \(path): \(String(cString: strerror(code)))"
        case .closed:
            return "the socket is closed"
        }
    }
}

public enum UnixSocket {
    /// The longest path `sun_path` holds, its terminating NUL excluded.
    public static var maxPathBytes: Int {
        MemoryLayout.size(ofValue: sockaddr_un().sun_path) - 1
    }

    static func address(_ path: String) throws -> sockaddr_un {
        let bytes = Array(path.utf8)
        guard bytes.count <= maxPathBytes else { throw UnixSocketError.pathTooLong(path: path, limit: maxPathBytes) }
        var address = sockaddr_un()
        #if canImport(Darwin)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        #endif
        address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            for (index, byte) in bytes.enumerated() { raw[index] = byte }
            raw[bytes.count] = 0
        }
        return address
    }

    static func newSocket(_ path: String) throws -> Int32 {
        #if canImport(Darwin)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        #else
        let fd = socket(AF_UNIX, Int32(SOCK_STREAM.rawValue), 0)
        #endif
        if fd < 0 { throw UnixSocketError.system(operation: "socket", path: path, errno: errno) }
        _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
        #if canImport(Darwin)
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        #endif
        return fd
    }

    /// Connect to `path`.
    public static func connect(_ path: String) throws -> UnixSocketConnection {
        var address = try address(path)
        let fd = try newSocket(path)
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Foundation.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        if result != 0 {
            let code = errno
            close(fd)
            throw UnixSocketError.system(operation: "connect", path: path, errno: code)
        }
        return UnixSocketConnection(fd: fd)
    }

    /// Whether something is listening at `path` now.
    public static func isLive(_ path: String) -> Bool {
        guard let connection = try? connect(path) else { return false }
        connection.close()
        return true
    }

    /// Listen at `path`, the socket file created with `mode`.
    ///
    /// A file already there that nobody answers on is a socket left by a
    /// process that died, and is taken over; one somebody answers on is
    /// `inUse`.
    public static func listen(_ path: String, mode: mode_t = 0o600, backlog: Int32 = 64) throws -> UnixSocketListener {
        var address = try address(path)
        if FileSystem.exists(path) {
            if isLive(path) { throw UnixSocketError.inUse(path: path) }
            try? FileSystem.unlink(path)
        }
        let fd = try newSocket(path)
        // The mode the file is created with is the umask's complement.
        let previous = umask(~mode & 0o777)
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        let bindErrno = errno
        umask(previous)
        if bound != 0 {
            close(fd)
            if bindErrno == EADDRINUSE { throw UnixSocketError.inUse(path: path) }
            throw UnixSocketError.system(operation: "bind", path: path, errno: bindErrno)
        }
        #if canImport(Darwin)
        let listening = Darwin.listen(fd, backlog)
        #else
        let listening = Glibc.listen(fd, backlog)
        #endif
        if listening != 0 {
            let code = errno
            close(fd)
            throw UnixSocketError.system(operation: "listen", path: path, errno: code)
        }
        return UnixSocketListener(fd: fd, path: path)
    }
}

/// A listening socket. `connections` accepts on a thread of its own.
public final class UnixSocketListener: @unchecked Sendable {
    public let path: String
    private let lock = NSLock()
    private var fd: Int32

    init(fd: Int32, path: String) {
        self.fd = fd
        self.path = path
    }

    /// Every connection made to the socket, until `close`.
    public var connections: AsyncStream<UnixSocketConnection> {
        let fd = lock.withLock { self.fd }
        return AsyncStream { continuation in
            guard fd >= 0 else {
                continuation.finish()
                return
            }
            Thread.detachNewThread {
                while true {
                    let client = accept(fd, nil, nil)
                    if client < 0 {
                        if errno == EINTR || errno == ECONNABORTED { continue }
                        break
                    }
                    _ = fcntl(client, F_SETFD, FD_CLOEXEC)
                    #if canImport(Darwin)
                    var on: Int32 = 1
                    setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
                    #endif
                    continuation.yield(UnixSocketConnection(fd: client))
                }
                continuation.finish()
            }
        }
    }

    /// Stop listening and remove the socket file.
    public func close(unlinking: Bool = true) {
        let fd = lock.withLock { () -> Int32 in
            let fd = self.fd
            self.fd = -1
            return fd
        }
        guard fd >= 0 else { return }
        _ = shutdown(fd, Int32(SHUT_RDWR))
        #if canImport(Darwin)
        _ = Darwin.close(fd)
        #else
        _ = Glibc.close(fd)
        #endif
        if unlinking { try? FileSystem.unlink(path) }
    }

    deinit { close(unlinking: false) }
}

/// One connected stream socket.
public final class UnixSocketConnection: @unchecked Sendable {
    private let lock = NSLock()
    private var fd: Int32

    init(fd: Int32) {
        self.fd = fd
    }

    /// Chunks as they arrive, read on a thread of its own; finishes at EOF or
    /// `close`. Read it once.
    public var incoming: AsyncStream<Data> {
        let fd = lock.withLock { self.fd }
        return AsyncStream { continuation in
            guard fd >= 0 else {
                continuation.finish()
                return
            }
            Thread.detachNewThread {
                var buffer = [UInt8](repeating: 0, count: 65536)
                while true {
                    let count = buffer.withUnsafeMutableBytes { recv(fd, $0.baseAddress, $0.count, 0) }
                    if count < 0 && errno == EINTR { continue }
                    if count <= 0 { break }
                    continuation.yield(Data(buffer[0..<count]))
                }
                continuation.finish()
            }
        }
    }

    /// The incoming bytes, line by line.
    public var lines: AsyncLineReader<AsyncStream<Data>> { AsyncLineReader(incoming) }

    /// Write all of `data`.
    public func send(_ data: Data) throws {
        let fd = lock.withLock { self.fd }
        guard fd >= 0 else { throw UnixSocketError.closed }
        let bytes = [UInt8](data)
        var offset = 0
        #if canImport(Darwin)
        let flags: Int32 = 0
        #else
        let flags = Int32(MSG_NOSIGNAL)
        #endif
        while offset < bytes.count {
            let written = bytes[offset...].withUnsafeBytes { Foundation.send(fd, $0.baseAddress, $0.count, flags) }
            if written < 0 {
                if errno == EINTR { continue }
                throw UnixSocketError.system(operation: "send", path: "", errno: errno)
            }
            offset += written
        }
    }

    /// Write `line` and a newline.
    public func send(line: String) throws { try send(Data((line + "\n").utf8)) }

    /// No more writes: the other side reads EOF.
    public func shutdownWrite() {
        let fd = lock.withLock { self.fd }
        if fd >= 0 { _ = shutdown(fd, Int32(SHUT_WR)) }
    }

    public func close() {
        let fd = lock.withLock { () -> Int32 in
            let fd = self.fd
            self.fd = -1
            return fd
        }
        guard fd >= 0 else { return }
        _ = shutdown(fd, Int32(SHUT_RDWR))
        #if canImport(Darwin)
        _ = Darwin.close(fd)
        #else
        _ = Glibc.close(fd)
        #endif
    }

    deinit { close() }
}

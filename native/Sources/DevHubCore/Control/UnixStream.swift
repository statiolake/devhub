// Unix-domain stream sockets, as the control socket and Neovim's `--listen`
// socket need them: connect, listen, accept, read, write, close.
//
// Plain POSIX, so it is the same code on macOS and Linux (where the tests
// run). Blocking calls only; the async callers run them off Swift's
// cooperative pool (`UnixStream.offload`), so a slow peer never stalls a task
// that has nothing to do with it.
//
// A write to a peer that has gone must be an error, not a SIGPIPE that kills
// the process: macOS gets `SO_NOSIGPIPE` on every socket, Linux `MSG_NOSIGNAL`
// on every send.

import Foundation

#if canImport(Glibc)
    import Glibc
#elseif canImport(Musl)
    import Musl
#elseif canImport(Darwin)
    import Darwin
#endif

public enum UnixStream {
    /// A socket call that failed, with its `errno`.
    public struct Failure: Error, Equatable, CustomStringConvertible, Sendable {
        public let operation: String
        public let code: Int32
        public let path: String?

        public init(operation: String, code: Int32, path: String? = nil) {
            self.operation = operation
            self.code = code
            self.path = path
        }

        public var description: String {
            let reason = String(cString: strerror(code))
            if let path { return "\(operation) \(path): \(reason) (\(UnixStream.errnoName(code)))" }
            return "\(operation): \(reason) (\(UnixStream.errnoName(code)))"
        }

        /// Nothing is listening there: no file (`ENOENT`), a file nobody is
        /// accepting on (`ECONNREFUSED`), or not a socket (`ENOTSOCK`). How a
        /// caller tells a stale socket file from a live server.
        public var isRefused: Bool {
            code == ECONNREFUSED || code == ENOENT || code == ENOTSOCK
        }
    }

    /// The `code` Node puts on an errno error (`ENOENT`, `ECONNREFUSED`, …).
    public static func errnoName(_ code: Int32) -> String {
        switch code {
        case ENOENT: return "ENOENT"
        case ECONNREFUSED: return "ECONNREFUSED"
        case ENOTSOCK: return "ENOTSOCK"
        case EACCES: return "EACCES"
        case EADDRINUSE: return "EADDRINUSE"
        case ENAMETOOLONG: return "ENAMETOOLONG"
        case EPIPE: return "EPIPE"
        case ECONNRESET: return "ECONNRESET"
        case EAGAIN: return "EAGAIN"
        case ETIMEDOUT: return "ETIMEDOUT"
        case EINVAL: return "EINVAL"
        case EBADF: return "EBADF"
        default: return "errno \(code)"
        }
    }

    /// The longest path a `sockaddr_un` holds on this platform, NUL excluded.
    public static var maxPathBytes: Int {
        MemoryLayout.size(ofValue: sockaddr_un().sun_path) - 1
    }

    private static func address(_ path: String) throws -> sockaddr_un {
        var address = sockaddr_un()
        let bytes = Array(path.utf8)
        guard bytes.count <= maxPathBytes else {
            throw Failure(operation: "socket path", code: ENAMETOOLONG, path: path)
        }
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

    private static func newSocket(path: String?) throws -> Int32 {
        #if canImport(Darwin)
            let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        #else
            let fd = socket(AF_UNIX, Int32(SOCK_STREAM.rawValue), 0)
        #endif
        guard fd >= 0 else { throw Failure(operation: "socket", code: errno, path: path) }
        _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
        #if canImport(Darwin)
            var one: Int32 = 1
            _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        #endif
        return fd
    }

    /// Connect to the socket at `path`; the connected descriptor.
    public static func connect(_ path: String) throws -> Int32 {
        var address = try address(path)
        let fd = try newSocket(path: path)
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { generic in
                #if canImport(Darwin)
                    Darwin.connect(fd, generic, socklen_t(MemoryLayout<sockaddr_un>.size))
                #else
                    Glibc.connect(fd, generic, socklen_t(MemoryLayout<sockaddr_un>.size))
                #endif
            }
        }
        if result != 0 {
            let code = errno
            close(fd)
            throw Failure(operation: "connect", code: code, path: path)
        }
        return fd
    }

    /// Bind and listen at `path`, which must not exist; the listening descriptor.
    public static func listen(_ path: String, backlog: Int32 = 64) throws -> Int32 {
        var address = try address(path)
        let fd = try newSocket(path: path)
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { generic in
                bind(fd, generic, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        if bound != 0 {
            let code = errno
            close(fd)
            throw Failure(operation: "bind", code: code, path: path)
        }
        #if canImport(Darwin)
            let listening = Darwin.listen(fd, backlog)
        #else
            let listening = Glibc.listen(fd, backlog)
        #endif
        if listening != 0 {
            let code = errno
            close(fd)
            throw Failure(operation: "listen", code: code, path: path)
        }
        return fd
    }

    /// The next connection on a listening descriptor.
    public static func accept(_ listener: Int32) throws -> Int32 {
        while true {
            #if canImport(Darwin)
                let fd = Darwin.accept(listener, nil, nil)
            #else
                let fd = Glibc.accept(listener, nil, nil)
            #endif
            if fd >= 0 {
                _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
                #if canImport(Darwin)
                    var one: Int32 = 1
                    _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
                #endif
                return fd
            }
            if errno == EINTR { continue }
            throw Failure(operation: "accept", code: errno)
        }
    }

    /// Up to `maximum` bytes; empty at end of stream.
    public static func read(_ fd: Int32, maximum: Int = 65_536) throws -> [UInt8] {
        var buffer = [UInt8](repeating: 0, count: maximum)
        while true {
            let count = buffer.withUnsafeMutableBytes { raw in recv(fd, raw.baseAddress, maximum, 0) }
            if count >= 0 { return Array(buffer.prefix(count)) }
            if errno == EINTR { continue }
            throw Failure(operation: "read", code: errno)
        }
    }

    /// All of `bytes`, or a failure.
    public static func write(_ fd: Int32, _ bytes: [UInt8]) throws {
        #if canImport(Darwin)
            let flags: Int32 = 0
        #else
            let flags = Int32(MSG_NOSIGNAL)
        #endif
        var offset = 0
        while offset < bytes.count {
            let sent = bytes.withUnsafeBytes { raw in
                send(fd, raw.baseAddress! + offset, bytes.count - offset, flags)
            }
            if sent < 0 {
                if errno == EINTR { continue }
                throw Failure(operation: "write", code: errno)
            }
            offset += sent
        }
    }

    public static func write(_ fd: Int32, _ text: String) throws {
        try write(fd, Array(text.utf8))
    }

    /// No more reading or writing on it, from either side: a reader blocked
    /// in `read` returns at end of stream. The descriptor stays open.
    public static func shutdownBoth(_ fd: Int32) {
        _ = shutdown(fd, Int32(SHUT_RDWR))
    }

    /// No more writing: the peer reads end of stream.
    public static func shutdownWrite(_ fd: Int32) {
        _ = shutdown(fd, Int32(SHUT_WR))
    }

    public static func close(_ fd: Int32) {
        #if canImport(Darwin)
            _ = Darwin.close(fd)
        #else
            _ = Glibc.close(fd)
        #endif
    }

    /// Reads on `fd` give up after `seconds` with `EAGAIN`.
    public static func setReadTimeout(_ fd: Int32, seconds: Double) {
        var time = timeval()
        time.tv_sec = Int(seconds)
        #if canImport(Darwin)
            time.tv_usec = Int32((seconds - Double(Int(seconds))) * 1_000_000)
        #else
            time.tv_usec = Int((seconds - Double(Int(seconds))) * 1_000_000)
        #endif
        _ = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &time, socklen_t(MemoryLayout<timeval>.size))
    }

    /// Run blocking work on a thread of its own and await it, so the
    /// cooperative pool is never held by a socket.
    public static func offload<T: Sendable>(_ work: @escaping @Sendable () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            let thread = Thread {
                do {
                    continuation.resume(returning: try work())
                } catch {
                    continuation.resume(throwing: error)
                }
            }
            thread.stackSize = 1 << 20
            thread.start()
        }
    }
}

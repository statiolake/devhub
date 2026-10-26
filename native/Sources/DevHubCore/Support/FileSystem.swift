#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif
import Foundation

/// A failed file operation, with its `errno` — the TypeScript code decides on
/// `error.code === "ENOENT"`, and so does the port.
public struct FileSystemError: Error, Equatable, CustomStringConvertible, Sendable {
    public let operation: String
    public let path: String
    public let errno: Int32

    public var isNotFound: Bool { errno == ENOENT }

    /// Node's spelling of the code (`ENOENT`, `EACCES`, …), for messages that
    /// name it the way the TypeScript app's do.
    public var code: String {
        switch errno {
        case ENOENT: return "ENOENT"
        case EACCES: return "EACCES"
        case EEXIST: return "EEXIST"
        case ENOTDIR: return "ENOTDIR"
        case EISDIR: return "EISDIR"
        case EPERM: return "EPERM"
        case ENOSPC: return "ENOSPC"
        case EROFS: return "EROFS"
        case ENAMETOOLONG: return "ENAMETOOLONG"
        case ELOOP: return "ELOOP"
        case EBUSY: return "EBUSY"
        case EXDEV: return "EXDEV"
        default: return "E\(errno)"
        }
    }

    public var description: String {
        "\(code): \(String(cString: strerror(errno))), \(operation) '\(path)'"
    }
}

/// The few POSIX file operations Core needs with their `errno` intact.
public enum FileSystem {
    static func failure(_ operation: String, _ path: String) -> FileSystemError {
        FileSystemError(operation: operation, path: path, errno: errno)
    }

    public static func readBytes(_ path: String) throws -> [UInt8] {
        let fd = open(path, O_RDONLY)
        if fd < 0 { throw failure("open", path) }
        defer { close(fd) }
        var out: [UInt8] = []
        var buffer = [UInt8](repeating: 0, count: 65536)
        while true {
            let count = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
            if count < 0 {
                if errno == EINTR { continue }
                throw failure("read", path)
            }
            if count == 0 { break }
            out.append(contentsOf: buffer[0..<count])
        }
        return out
    }

    public static func exists(_ path: String) -> Bool {
        var info = stat()
        return stat(path, &info) == 0
    }

    /// `stat(path).mode & 0o777`, or nil when it is not there.
    public static func permissions(_ path: String) -> mode_t? {
        var info = stat()
        guard stat(path, &info) == 0 else { return nil }
        return info.st_mode & 0o777
    }

    public static func size(_ path: String) -> Int? {
        var info = stat()
        guard stat(path, &info) == 0 else { return nil }
        return Int(info.st_size)
    }

    public static func isDirectory(_ path: String) -> Bool {
        var info = stat()
        guard stat(path, &info) == 0 else { return false }
        return (info.st_mode & S_IFMT) == S_IFDIR
    }

    public static func isRegularFile(_ path: String) -> Bool {
        var info = stat()
        guard stat(path, &info) == 0 else { return false }
        return (info.st_mode & S_IFMT) == S_IFREG
    }

    /// `mkdir -p`, with `mode` for the directories it makes.
    public static func makeDirectories(_ path: String, mode: mode_t = 0o777) throws {
        if path.isEmpty || isDirectory(path) { return }
        let parent = (path as NSString).deletingLastPathComponent
        if !parent.isEmpty && parent != path { try makeDirectories(parent, mode: mode) }
        if mkdir(path, mode) != 0 && errno != EEXIST { throw failure("mkdir", path) }
    }

    public static func rename(_ from: String, _ to: String) throws {
        #if canImport(Darwin)
        let result = Darwin.rename(from, to)
        #else
        let result = Glibc.rename(from, to)
        #endif
        if result != 0 { throw failure("rename", from) }
    }

    public static func unlink(_ path: String) throws {
        #if canImport(Darwin)
        let result = Darwin.unlink(path)
        #else
        let result = Glibc.unlink(path)
        #endif
        if result != 0 { throw failure("unlink", path) }
    }

    public static func chmod(_ path: String, _ mode: mode_t) throws {
        #if canImport(Darwin)
        let result = Darwin.chmod(path, mode)
        #else
        let result = Glibc.chmod(path, mode)
        #endif
        if result != 0 { throw failure("chmod", path) }
    }

    /// Write `bytes` to a new file (`O_CREAT | O_EXCL`) and fsync it.
    public static func writeNewFile(_ path: String, _ bytes: [UInt8], mode: mode_t = 0o600) throws {
        let fd = open(path, O_WRONLY | O_CREAT | O_EXCL, mode)
        if fd < 0 { throw failure("open", path) }
        var failed: FileSystemError?
        var offset = 0
        while offset < bytes.count {
            let written = bytes[offset...].withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
            if written < 0 {
                if errno == EINTR { continue }
                failed = failure("write", path)
                break
            }
            offset += written
        }
        if failed == nil && fsync(fd) != 0 { failed = failure("fsync", path) }
        close(fd)
        if let failed { throw failed }
    }

    /// Write through a temporary file in the same directory and rename over
    /// the target, so a crash mid-write leaves the previous file intact. The
    /// target's permissions are kept.
    public static func atomicWrite(_ path: String, _ text: String, temporaryPrefix: String? = nil) throws {
        let parent = (path as NSString).deletingLastPathComponent
        try makeDirectories(parent)
        let existingMode = permissions(path)
        let name = (path as NSString).lastPathComponent
        let millis = Int(Date().timeIntervalSince1970 * 1000)
        let temporary = Path.join(parent, ".\(temporaryPrefix ?? name).devhub-\(getpid())-\(millis).tmp")
        try writeNewFile(temporary, Array(text.utf8))
        do {
            if let existingMode { try chmod(temporary, existingMode) }
            try rename(temporary, path)
        } catch {
            try? unlink(temporary)
            throw error
        }
    }
}

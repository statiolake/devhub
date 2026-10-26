// Port of apps/desktop/src/main/diagnostics/mainLog.ts
//
// DevHub's console, kept in a file as well.
//
// Everything DevHub says — every `[devhub] …` line, every warning — goes to
// stderr, which nobody sees in an app launched from the Dock. So the same lines
// are appended, with a timestamp and a level, to `devhub-main.log` in the log
// folder (`<userData>/logs`, the one Settings' log button opens), and
// `DevHub: Open Log` opens it.
//
// The file is kept small by one rotation: past `maxBytes` it becomes
// `devhub-main.log.1`, replacing the one before, and a fresh file starts. A
// line is written synchronously, so a line said just before a crash is in the
// file after it. Nothing here may break the console it wraps: a file that
// cannot be written is said once on the real stderr and then left alone.
//
// The file name, folder, format and rotation are the TypeScript app's, so the
// two apps on one profile write one log the same way.

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif
import Foundation

public enum MainLogLocation {
    public static let fileName = "devhub-main.log"

    /// Past this, the file is rotated.
    public static let maxBytes = 5 * 1024 * 1024

    /// The folder DevHub's logs are in, given the app's user-data directory.
    public static func logDirectory(userData: String) -> String { Path.join(userData, "logs") }

    /// Where the main log is, given the app's user-data directory.
    public static func mainLogPath(userData: String) -> String {
        Path.join(logDirectory(userData: userData), fileName)
    }
}

/// One file, appended to, rotated once past `maxBytes`. Not thread-safe on its
/// own; `MainLog` serialises it.
public final class RotatingLog {
    public let path: String
    private let maxBytes: Int
    private let complain: (String) -> Void
    private var fd: Int32 = -1
    private var size = 0
    private var broken = false

    public init(path: String, maxBytes: Int = MainLogLocation.maxBytes, complain: @escaping (String) -> Void = { _ in }) {
        self.path = path
        self.maxBytes = maxBytes
        self.complain = complain
    }

    deinit { close() }

    /// Append `text`; false once the file cannot be written.
    @discardableResult
    public func write(_ text: String) -> Bool {
        if broken { return false }
        let bytes = Array(text.utf8)
        do {
            if fd >= 0 && size > 0 && size + bytes.count > maxBytes { rotate() }
            let fd = try open()
            var offset = 0
            while offset < bytes.count {
                let written = bytes[offset...].withUnsafeBytes { buffer in
                    #if canImport(Darwin)
                    Darwin.write(fd, buffer.baseAddress, buffer.count)
                    #else
                    Glibc.write(fd, buffer.baseAddress, buffer.count)
                    #endif
                }
                if written < 0 {
                    if errno == EINTR { continue }
                    throw FileSystem.failure("write", path)
                }
                offset += written
            }
            size += bytes.count
            return true
        } catch {
            broken = true
            close()
            complain("[devhub] log: \(path) cannot be written, logging to the console only: \(error)")
            return false
        }
    }

    public func close() {
        guard fd >= 0 else { return }
        #if canImport(Darwin)
        _ = Darwin.close(fd)
        #else
        _ = Glibc.close(fd)
        #endif
        fd = -1
    }

    private func openAppending() throws -> (Int32, Int) {
        let fd = Foundation.open(path, O_WRONLY | O_APPEND | O_CREAT, 0o666)
        if fd < 0 { throw FileSystem.failure("open", path) }
        var info = stat()
        if fstat(fd, &info) != 0 {
            let failure = FileSystem.failure("fstat", path)
            #if canImport(Darwin)
            _ = Darwin.close(fd)
            #else
            _ = Glibc.close(fd)
            #endif
            throw failure
        }
        if (info.st_mode & S_IFMT) == S_IFDIR {
            #if canImport(Darwin)
            _ = Darwin.close(fd)
            #else
            _ = Glibc.close(fd)
            #endif
            throw FileSystemError(operation: "open", path: path, errno: EISDIR)
        }
        return (fd, Int(info.st_size))
    }

    private func open() throws -> Int32 {
        if fd >= 0 { return fd }
        try FileSystem.makeDirectories((path as NSString).deletingLastPathComponent)
        var (fd, size) = try openAppending()
        // A file already past the limit from an earlier run starts fresh.
        if size >= maxBytes {
            #if canImport(Darwin)
            _ = Darwin.close(fd)
            #else
            _ = Glibc.close(fd)
            #endif
            moveAside()
            (fd, size) = try openAppending()
        }
        self.fd = fd
        self.size = size
        return fd
    }

    private func rotate() {
        close()
        moveAside()
    }

    /// The current file becomes `.1`; one that has gone is nothing to move.
    private func moveAside() {
        // Deleted from under DevHub, most likely: appending recreates it.
        try? FileSystem.rename(path, path + ".1")
    }
}

public enum LogLevel: String, CaseIterable, Sendable {
    case log, info, warn, error, debug

    /// How the level is written in the file: `log` is `INFO`.
    public var name: String { self == .log ? "INFO" : rawValue.uppercased() }
}

/// `2026-10-25T09:41:07.123Z INFO  [devhub] …`, one line per call.
public func logLine(_ level: LogLevel, _ when: Date, _ message: String) -> String {
    let name = level.name.padding(toLength: max(5, level.name.count), withPad: " ", startingAt: 0)
    return "\(isoTimestamp(when)) \(name) \(message)\n"
}

/// `logLine` over Node's `util.format` arguments: `%s`, `%d`, `%i`, `%f`,
/// `%j`, `%o`, `%O` and `%%` in a leading string, the rest joined by spaces.
public func logLine(_ level: LogLevel, _ when: Date, _ args: [Any]) -> String {
    logLine(level, when, utilFormat(args))
}

/// `Date.prototype.toISOString()`.
public func isoTimestamp(_ date: Date) -> String {
    let millisecondsSinceEpoch = (date.timeIntervalSince1970 * 1000).rounded(.down)
    let seconds = Int(floor(millisecondsSinceEpoch / 1000))
    let millis = Int(millisecondsSinceEpoch) - seconds * 1000
    var time = time_t(seconds)
    var parts = tm()
    gmtime_r(&time, &parts)
    func pad(_ value: Int32, _ width: Int) -> String {
        let text = String(value)
        return String(repeating: "0", count: max(0, width - text.count)) + text
    }
    return "\(pad(parts.tm_year + 1900, 4))-\(pad(parts.tm_mon + 1, 2))-\(pad(parts.tm_mday, 2))T\(pad(parts.tm_hour, 2)):\(pad(parts.tm_min, 2)):\(pad(parts.tm_sec, 2)).\(pad(Int32(millis), 3))Z"
}

/// The part of Node's `util.format` DevHub's own log lines use.
public func utilFormat(_ args: [Any]) -> String {
    guard let first = args.first else { return "" }
    func text(_ value: Any) -> String {
        if let number = value as? Double { return JSString.number(number) }
        if let number = value as? Int { return String(number) }
        return String(describing: value)
    }
    guard let format = first as? String else { return args.map(text).joined(separator: " ") }
    var rest = Array(args.dropFirst())
    var out = ""
    let scalars = Array(format.unicodeScalars)
    var index = 0
    while index < scalars.count {
        let scalar = scalars[index]
        if scalar == "%", index + 1 < scalars.count {
            let directive = scalars[index + 1]
            if directive == "%" {
                out += "%"
                index += 2
                continue
            }
            if "sdifjoOc".unicodeScalars.contains(directive) {
                guard !rest.isEmpty else {
                    out.unicodeScalars.append(scalar)
                    index += 1
                    continue
                }
                let value = rest.removeFirst()
                switch directive {
                case "d", "i":
                    if let number = value as? Double { out += directive == "i" ? String(Int(number)) : JSString.number(number) } else { out += text(value) }
                case "f":
                    out += text(value)
                case "c":
                    break
                default:
                    out += text(value)
                }
                index += 2
                continue
            }
        }
        out.unicodeScalars.append(scalar)
        index += 1
    }
    for value in rest { out += " " + text(value) }
    return out
}

/// DevHub's console: every line goes to stderr and, once `install` has run,
/// to `devhub-main.log` as well.
public final class MainLog: @unchecked Sendable {
    public static let shared = MainLog()

    private let lock = NSLock()
    private var file: RotatingLog?
    private var now: @Sendable () -> Date = { Date() }
    private var console: @Sendable (LogLevel, String) -> Void = { _, message in
        FileHandle.standardError.write(Data((message + "\n").utf8))
    }

    public init() {}

    /// Tee the console into `path`. `console` and `now` are for tests.
    public func install(
        path: String,
        maxBytes: Int = MainLogLocation.maxBytes,
        console: (@Sendable (LogLevel, String) -> Void)? = nil,
        now: (@Sendable () -> Date)? = nil
    ) {
        lock.lock()
        defer { lock.unlock() }
        if let console { self.console = console }
        if let now { self.now = now }
        file?.close()
        let complain = self.console
        file = RotatingLog(path: path, maxBytes: maxBytes) { message in complain(.error, message) }
    }

    /// Put the console back to stderr alone.
    public func uninstall() {
        lock.lock()
        defer { lock.unlock() }
        file?.close()
        file = nil
    }

    public func write(_ level: LogLevel, _ message: String) {
        lock.lock()
        defer { lock.unlock() }
        console(level, message)
        file?.write(logLine(level, now(), message))
    }

    public func log(_ message: String) { write(.log, message) }
    public func info(_ message: String) { write(.info, message) }
    public func warn(_ message: String) { write(.warn, message) }
    public func error(_ message: String) { write(.error, message) }
    public func debug(_ message: String) { write(.debug, message) }
}

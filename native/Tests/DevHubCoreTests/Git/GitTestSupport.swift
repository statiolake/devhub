import Foundation
import XCTest
@testable import DevHubCore

/// The `git` on PATH, in an environment that reads neither the machine's
/// identity nor its hooks (as the TS tests' `command`).
enum GitTestSupport {
    static var environment: [String: String] {
        var environment = ProcessInfo.processInfo.environment
        environment["GIT_CONFIG_GLOBAL"] = "/dev/null"
        environment["GIT_CONFIG_SYSTEM"] = "/dev/null"
        environment["GIT_AUTHOR_NAME"] = "DevHub Test"
        environment["GIT_AUTHOR_EMAIL"] = "test@example.com"
        environment["GIT_COMMITTER_NAME"] = "DevHub Test"
        environment["GIT_COMMITTER_EMAIL"] = "test@example.com"
        return environment
    }

    static let command = GitCommand(runtime: LocalRepositoryRuntime(), git: "git", environment: environment)

    static var hasGit: Bool {
        ProcessRunner.resolveExecutable("git", searchPath: ProcessInfo.processInfo.environment["PATH"] ?? "") != nil
    }

    /// A fresh directory, by its real path: git answers with real paths, and
    /// on a Mac `/tmp` is a symlink.
    static func temporaryDirectory(_ prefix: String) throws -> String {
        let base = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("\(prefix)\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        guard let resolved = realpath(base.path, nil) else { return base.path }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    static func write(_ path: String, _ text: String) throws {
        try text.write(toFile: path, atomically: false, encoding: .utf8)
    }

    static func read(_ path: String) throws -> String {
        try String(contentsOfFile: path, encoding: .utf8)
    }

    static func exists(_ path: String) -> Bool {
        FileManager.default.fileExists(atPath: path)
    }

    static func isDirectory(_ path: String) -> Bool {
        var directory: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &directory) && directory.boolValue
    }

    static func mkdir(_ path: String) throws {
        try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
    }

    static func remove(_ path: String) {
        try? FileManager.default.removeItem(atPath: path)
    }

    /// `expect(promise).rejects.toThrow(pattern)`.
    static func assertRejects<T>(
        _ expression: @autoclosure () async throws -> T,
        matching pattern: String? = nil,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ check: ((Error) -> Void)? = nil
    ) async {
        do {
            _ = try await expression()
            XCTFail("expected a failure", file: file, line: line)
        } catch {
            if let pattern {
                let text = failureText(error)
                XCTAssertNotNil(text.range(of: pattern, options: .regularExpression), "\(text) does not match \(pattern)", file: file, line: line)
            }
            check?(error)
        }
    }
}

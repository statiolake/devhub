import Foundation
import XCTest
@testable import DevHubCore

/// Fixtures captured from the TypeScript app (`Tests/DevHubCoreTests/Fixtures/`),
/// read by path. Each file was produced by running the TypeScript source
/// itself (`apps/desktop/src/main/cli/**`, `main/editor/**`,
/// `main/agent/devhubSkill.ts`) over the cases it lists, so a test that
/// compares against one compares against what the TypeScript app does.
enum WP7Fixtures {
    static let root = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures")

    static func text(_ path: String) throws -> String {
        try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8)
    }

    static func json(_ path: String) throws -> WireJSON {
        try WireJSON.parse(try text(path))
    }
}

/// A directory of its own, short enough for a socket path (`sun_path` is
/// 104 bytes on macOS, and the test runner's temporary directory is long).
func wp7SocketDirectory(_ name: String) throws -> String {
    let path = "/tmp/dh-\(name)-\(DevhubWait.randomHex())"
    try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
    return path
}

func wp7RemoveDirectory(_ path: String) {
    try? FileManager.default.removeItem(atPath: path)
}

/// Run an async throwing expression and hand back what it threw.
func wp7Caught<T>(_ body: () async throws -> T) async -> Error? {
    do {
        _ = try await body()
        return nil
    } catch {
        return error
    }
}

/// Wait (briefly) for a condition that another task is about to make true.
func wp7Eventually(_ timeout: Double = 2, _ condition: () async -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if await condition() { return true }
        try? await Task.sleep(for: .milliseconds(5))
    }
    return await condition()
}

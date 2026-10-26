import Foundation

/// Fixtures captured from the TypeScript app, under `Tests/DevHubCoreTests/Fixtures/<area>/`.
///
/// Found by this file's own path rather than as a SwiftPM resource, so a
/// package can add fixtures without touching `Package.swift`.
enum ConfigFixture {
    static let root = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .appendingPathComponent("Fixtures")

    static func url(_ area: String, _ name: String) -> URL {
        root.appendingPathComponent(area).appendingPathComponent(name)
    }

    static func text(_ area: String, _ name: String) throws -> String {
        try String(contentsOf: url(area, name), encoding: .utf8)
    }

    static func json(_ area: String, _ name: String) throws -> Any {
        try JSONSerialization.jsonObject(with: Data(contentsOf: url(area, name)), options: [.fragmentsAllowed])
    }
}

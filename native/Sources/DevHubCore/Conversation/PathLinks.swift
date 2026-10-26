// Port of apps/desktop/src/main/agent/conversation/pathLinks.ts
//
// Which of the paths a GUI conversation's text names are files, on the
// Agent's machine.
//
// The view finds the words that could be paths and asks here before it draws
// any of them as a link, so that a link is only ever drawn to something that
// is there. "There" is the Agent's own machine — this Mac, or the host it
// runs on — because that is the disk the Agent was talking about, and the
// question is asked through that machine: one `/bin/sh` for a whole batch,
// which is one round trip over the host's ssh master rather than one per word.
//
// A path is spelled the three ways the Agent spells one: absolute, `~/…`
// (that machine's home), or relative to the Agent's directory. A file is a
// regular file or a symlink to one (`test -f`); a folder is not a link.

import Foundation

/// At most this many paths to one `/bin/sh`, so its argv stays well inside `ARG_MAX`.
private let PER_SHELL = 250
private let TIMEOUT_SECONDS: Double = 15

/// Prints `1` for each argument that is a file and `0` for each that is not, one per line.
private let SCRIPT = #"for p do if [ -f "$p" ]; then echo 1; else echo 0; fi; done"#

/// A path the conversation's text named that is not one, or that cannot be resolved.
public struct PathLinkRefused: Error, CustomStringConvertible, Equatable {
    public let message: String
    public var description: String { message }
}

/// Each of `paths` as the absolute path of the file it names on `machine`, or
/// nil when it names none. `cwd` is what a relative path is relative to; a
/// relative path with no `cwd` is a broken promise of the view's.
public func resolvePathCandidates(_ machine: any PathLinkMachine, cwd: String?, _ paths: [String]) async throws -> [String?] {
    let home = paths.contains { $0.hasPrefix("~/") } ? try await machine.home() : nil
    let absolute = try paths.map { try absoluteOf($0, cwd, home) }
    var answers: [String?] = []
    var at = 0
    while at < absolute.count {
        let batch = Array(absolute[at..<min(at + PER_SHELL, absolute.count)])
        let files = try await filesAmong(machine, batch)
        for (index, path) in batch.enumerated() { answers.append(files[index] ? path : nil) }
        at += PER_SHELL
    }
    return answers
}

/// `path.posix.join`: the parts joined with `/`, then normalized.
private func posixJoined(_ parts: String...) -> String {
    PathResolution.normalize(parts.filter { !$0.isEmpty }.joined(separator: "/"))
}

private func absoluteOf(_ path: String, _ cwd: String?, _ home: String?) throws -> String {
    if path.contains("\0") || path.isEmpty { throw PathLinkRefused(message: "\(JsonValue.quoted(path)) is not a path") }
    if path.hasPrefix("/") { return PathResolution.normalize(path) }
    if path.hasPrefix("~/") {
        guard let home else { throw PathLinkRefused(message: "no home to resolve \(path) in") }
        return posixJoined(home, String(path.dropFirst(2)))
    }
    guard let cwd, cwd.hasPrefix("/") else {
        throw PathLinkRefused(
            message: "\(path) is relative, and the conversation named no directory it is relative to")
    }
    return posixJoined(cwd, path)
}

private func filesAmong(_ machine: any PathLinkMachine, _ paths: [String]) async throws -> [Bool] {
    let result = try await machine.exec(
        ["/bin/sh", "-c", SCRIPT, "devhub-path-links"] + paths, stdin: nil, timeout: TIMEOUT_SECONDS,
        // Two bytes a path, and room to spare.
        limits: MachineLimits(stdoutBytes: paths.count * 2 + 64, stderrBytes: 8 * 1024, overflow: .truncate))
    if result.code != 0 {
        let status = result.code.map { String($0) } ?? result.signal.map { String($0) } ?? "null"
        let stderr = jsTrim(String(decoding: result.stderr, as: UTF8.self))
        throw PathLinkRefused(
            message:
                "DevHub could not ask\(machine.whereSuffix) which paths in the conversation are files (exit \(status)): \(stderr)"
        )
    }
    var lines = String(decoding: result.stdout, as: UTF8.self).components(separatedBy: "\n")
    if lines.last == "" { lines.removeLast() }
    if lines.count != paths.count {
        throw PathLinkRefused(
            message: "asked\(machine.whereSuffix) about \(paths.count) paths, /bin/sh answered \(lines.count)")
    }
    return lines.map { $0 == "1" }
}

/// `Number.MAX_SAFE_INTEGER`: a column past any line's end.
public let END_OF_LINE = 9_007_199_254_740_991

/// Where a link's range puts the editor: a line (and column) is a caret there;
/// lines from–to are selected whole, the last to its end — a column past a
/// line's end is its end, as the editor clamps it.
public func fileSelection(_ range: FileRange?) -> FileSelection? {
    switch range {
    case nil: return nil
    case .line(let line, let column): return FileSelection(line: line, column: column)
    case .lines(let from, let to):
        return FileSelection(line: from, column: 1, end: ControlPosition(line: to, column: END_OF_LINE))
    }
}

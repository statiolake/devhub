// Port of the store of apps/desktop/src/shell/conversation/pathLinks.tsx.
//
// File paths in the conversation, drawn as links that open the file in the
// editor.
//
// A word is a link when its spelling says it could be a path (`TextLinks`)
// *and* Core says it names a file on the Agent's machine — local, or the host
// the Agent runs on. The second gate is what keeps "and/or" and "e.g." plain:
// nothing is linked on a guess. Until it has answered, a candidate is drawn
// as the text it is, so a link appears where one belongs and nothing else
// moves.
//
// One `PathLinks` per conversation asks, batches and remembers. Every
// candidate drawn in a tick is asked about in one request; a file, once
// found, stays a link for as long as the conversation is on the page (a click
// on one that has gone since is refused, and said). A word that named
// nothing is asked about again once the Agent's turn has ended, because the
// turn may be what made it (`forgetAbsent`).

import Foundation

@MainActor
public final class PathLinks {
    /// At most this many paths in one request: a long grep is several.
    public static let batch = 500

    public typealias Resolve = @MainActor (_ cwd: String?, _ paths: [String]) async throws -> [String?]

    public enum Known: Equatable, Sendable {
        case file(String)
        case none
    }

    private let resolve: Resolve
    private let reportFailure: @MainActor (Error) -> Void
    private let schedule: @MainActor (@escaping @MainActor () -> Void) -> Void
    /// A candidate's key → the file's absolute path, or none.
    private var known: [String: Known] = [:]
    /// Keys asked about or about to be, by the directory they are relative to.
    private var queued: [String: [(key: String, path: String)]] = [:]
    private var queuedOrder: [String] = []
    private var asking: Set<String> = []
    private var scheduled = false
    private var listeners: [UUID: @MainActor () -> Void] = [:]

    public init(
        resolve: @escaping Resolve, reportFailure: @escaping @MainActor (Error) -> Void,
        schedule: @escaping @MainActor (@escaping @MainActor () -> Void) -> Void = { work in
            DispatchQueue.main.async { MainActor.assumeIsolated { work() } }
        }
    ) {
        self.resolve = resolve
        self.reportFailure = reportFailure
        self.schedule = schedule
    }

    static func isRelative(_ path: String) -> Bool { !path.hasPrefix("/") && !path.hasPrefix("~/") }

    static func key(_ cwd: String?, _ path: String) -> String { isRelative(path) ? "\(cwd ?? "")\n\(path)" : path }

    /// The file `path` names, `.none` for none, nil until it has been said.
    public func file(_ cwd: String?, _ path: String) -> Known? { known[Self.key(cwd, path)] }

    /// Ask about `path` in the next batch, unless it is known or being asked.
    public func want(_ cwd: String?, _ path: String) {
        let key = Self.key(cwd, path)
        if known[key] != nil || asking.contains(key) { return }
        if Self.isRelative(path), cwd == nil {
            // Relative to a directory the session has not named yet: nothing to ask about.
            known[key] = Known.none
            return
        }
        asking.insert(key)
        let base = Self.isRelative(path) ? (cwd ?? "") : "\u{0}absolute"
        if queued[base] == nil { queuedOrder.append(base) }
        queued[base, default: []].append((key, path))
        if scheduled { return }
        scheduled = true
        schedule { [weak self] in self?.flush() }
    }

    /// Forget what `path` named, so it is asked about again when next drawn.
    public func forget(_ cwd: String?, _ path: String) {
        if known.removeValue(forKey: Self.key(cwd, path)) != nil { emit() }
    }

    /// Forget every word that named nothing: the turn that ended may have made it.
    public func forgetAbsent() {
        let before = known.count
        known = known.filter { $0.value != Known.none }
        if known.count != before { emit() }
    }

    @discardableResult
    public func subscribe(_ listener: @escaping @MainActor () -> Void) -> () -> Void {
        let id = UUID()
        listeners[id] = listener
        return { [weak self] in
            MainActor.assumeIsolated { _ = self?.listeners.removeValue(forKey: id) }
        }
    }

    private func flush() {
        scheduled = false
        let order = queuedOrder
        let all = queued
        queued = [:]
        queuedOrder = []
        for base in order {
            let entries = all[base] ?? []
            let cwd = base == "\u{0}absolute" ? nil : base
            var at = 0
            while at < entries.count {
                let slice = Array(entries[at..<min(at + Self.batch, entries.count)])
                Task { @MainActor [weak self] in await self?.ask(cwd, slice) }
                at += Self.batch
            }
        }
    }

    private func ask(_ cwd: String?, _ entries: [(key: String, path: String)]) async {
        var files: [String?]
        do {
            files = try await resolve(cwd, entries.map(\.path))
            if files.count != entries.count {
                throw PathLinkRefused(
                    message: "main answered \(files.count) of \(entries.count) paths the conversation asked about")
            }
        } catch {
            // Said once, for the batch, and the words stay plain text until the next turn ends.
            files = entries.map { _ in nil }
            reportFailure(error)
        }
        for (index, entry) in entries.enumerated() {
            asking.remove(entry.key)
            known[entry.key] = files[index].map(Known.file) ?? Known.none
        }
        emit()
    }

    private func emit() {
        for listener in listeners.values { listener() }
    }
}

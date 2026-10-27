// Port of apps/desktop/src/main/shell/settingsWindow.ts (`buildSnapshot` and
// the IPC behind the window) and of the session rules of
// apps/desktop/src/settings/SettingsApp.tsx (`adopt`, `update`'s settle
// counting, the refusal's lifetime).
//
// Read the config, save it against the revision it was drafted from, reset a
// screen's part to the defaults, reload, re-resolve the runtimes, and move
// DevHub's terminal sessions to another socket. A save carries the revision
// it was drafted from, so an edit made in a text editor while Settings was
// open is a refusal rather than a silent overwrite.

import Foundation

/// What the window draws (`SettingsSnapshotWire`).
public struct SettingsSnapshot: Equatable, Sendable {
    public var sequence: Int
    public var revision: ContentRevision
    public var config: Config
    public var resolved: ResolvedRuntimes
    public var health: RuntimeHealth
    /// What became of the login-shell environment import, in a sentence.
    public var loginEnvironment: String
    public var sessionId: String
    public var logDirectory: String
    /// `clean`, `unclean` or `unknown`.
    public var previousExit: String
    /// The last external read that did not parse, if the file is broken now.
    public var diagnostic: ConfigDiagnostic?
    /// Keys the file names that DevHub no longer reads.
    public var notices: [RetiredKeyNotice]

    /// `Last quit`'s word.
    public var previousExitText: String {
        switch previousExit {
        case "clean": return "Normal"
        case "unclean": return "Unexpected"
        default: return "Unknown"
        }
    }
}

/// What the window needs of the running app.
public protocol SettingsHost: AnyObject, Sendable {
    /// A save changed the config: the shell re-projects it.
    func adopt(_ config: Config) async
    /// What the socket a person wants to move to looks like right now.
    func preflightSocket(_ name: String) async throws -> TerminalPreflight
    /// Move DevHub's terminal sessions onto that socket, or fail loudly.
    func changeSocket(_ name: String) async throws
    /// The PATH every lookup is made in.
    func launchPath() -> String
    func loginEnvironmentSummary() -> String
    func previousExit() -> String
}

public actor SettingsService {
    private let store: ConfigStore
    private let host: any SettingsHost
    private let logDirectory: String
    private let home: String
    private var sequence = 0
    public let sessionId = UUID().uuidString.lowercased()

    public init(store: ConfigStore, host: any SettingsHost, logDirectory: String, home: String = NSHomeDirectory()) {
        self.store = store
        self.host = host
        self.logDirectory = logDirectory
        self.home = home
    }

    /// `buildSnapshot`.
    public func snapshot() async throws -> SettingsSnapshot {
        let loaded: LoadedConfig
        if let current = await store.current() {
            loaded = current
        } else {
            loaded = try await store.load()
        }
        let resolved = Runtimes.resolve(loaded.config.runtimes, searchPath: host.launchPath(), home: home)
        sequence += 1
        return SettingsSnapshot(
            sequence: sequence, revision: loaded.revision, config: loaded.config, resolved: resolved,
            health: Runtimes.health(resolved), loginEnvironment: host.loginEnvironmentSummary(), sessionId: sessionId,
            logDirectory: logDirectory, previousExit: host.previousExit(), diagnostic: await store.lastDiagnostic(),
            notices: loaded.notices)
    }

    public func save(revision: ContentRevision, config: Config) async throws -> SettingsSnapshot {
        let loaded = try await store.save(expectedRevision: revision, config: config)
        await host.adopt(loaded.config)
        return try await snapshot()
    }

    public func resetScope(revision: ContentRevision, keys: [ConfigScopeKey]) async throws -> SettingsSnapshot {
        let loaded = try await store.resetScope(expectedRevision: revision, keys: keys)
        await host.adopt(loaded.config)
        return try await snapshot()
    }

    public func reload() async throws -> SettingsSnapshot {
        if case let .applied(loaded) = try await store.reload() { await host.adopt(loaded.config) }
        return try await snapshot()
    }

    public func recheck() async throws -> SettingsSnapshot { try await snapshot() }

    public func socketPreflight(_ name: String) async throws -> TerminalPreflight {
        try await host.preflightSocket(name)
    }

    /// The socket name is saved only once the sessions have actually moved: a
    /// file naming a socket the app is not on would be a lie the next launch
    /// would believe.
    public func socketApply(_ name: String) async throws -> SettingsSnapshot {
        try await host.changeSocket(name)
        let loaded: LoadedConfig
        if let current = await store.current() { loaded = current } else { loaded = try await store.load() }
        var config = loaded.config
        config.runtimes.tmuxSocketName = name
        let saved = try await store.save(expectedRevision: loaded.revision, config: config)
        await host.adopt(saved.config)
        return try await snapshot()
    }

    /// Copy Summary: deliberately not the config (profiles carry environment
    /// values, and a summary is something people paste into issues).
    public func summary() async throws -> String {
        let snapshot = try await snapshot()
        func health(_ value: RuntimeHealthValue) -> WireJSON { .string(value.rawValue) }
        var object: [(String, WireJSON)] = [
            ("sessionId", .string(snapshot.sessionId)), ("previousExit", .string(snapshot.previousExit)),
            ("runtimeHealth", .object([
                ("shell", health(snapshot.health.shell)), ("git", health(snapshot.health.git)), ("tmux", health(snapshot.health.tmux)),
                ("inspectionAvailable", .bool(snapshot.health.inspectionAvailable)),
            ])),
        ]
        if let code = snapshot.diagnostic?.code { object.append(("configDiagnostic", .string(code.rawValue))) }
        object.append(("logDirectory", .string(logDirectory)))
        return WireJSON.object(object).pretty
    }
}

/// The window's session (`SettingsApp`): what DevHub is on, what is shown,
/// and the rule that keeps a push from taking the keyboard away mid-edit.
public struct SettingsSession: Sendable {
    /// What DevHub is on now.
    public private(set) var snapshot: SettingsSnapshot?
    /// What is shown, and edited.
    public private(set) var draft: Config?
    /// The socket being asked for (the snapshot is what DevHub is actually on).
    public private(set) var socketDraft: String?
    private var lastSequence = 0
    private var edits = 0
    private var settledEdits = 0
    /// The refusal on screen, under the rule every DevHub window uses.
    public private(set) var refusal = AlertLifetime<SettingsRules.Refusal>(identity: { $0.identity })

    public init() {}

    /// `adopt`: a snapshot newer than the last one taken becomes what DevHub
    /// is on — and what is shown, unless the person is part-way through an edit.
    public mutating func adopt(_ next: SettingsSnapshot) {
        if next.sequence < lastSequence { return }
        lastSequence = next.sequence
        snapshot = next
        if edits != settledEdits { return }
        draft = next.config
        socketDraft = next.config.runtimes.tmuxSocketName
    }

    /// A change is applied, not staged: the draft moves now; the save that
    /// follows settles what it sent (`edits`), and returns the count to settle.
    public mutating func edit(_ next: Config) -> Int {
        edits += 1
        draft = next
        return edits
    }

    public mutating func editSocket(_ next: String) {
        edits += 1
        socketDraft = next
    }

    /// DevHub has taken everything typed up to `count`.
    public mutating func settle(_ count: Int) { settledEdits = max(settledEdits, count) }

    /// Edits the person has explicitly asked DevHub to replace.
    public mutating func discardEdits() { settledEdits = edits }

    public mutating func refuse(_ refusal: SettingsRules.Refusal) { self.refusal.raise(refusal) }
    /// The person started something.
    public mutating func acted() { refusal.clear() }
    public mutating func dismissRefusal() { refusal.dismiss() }

    /// Whether the socket asked for is not the one DevHub is on.
    public var socketMoved: Bool {
        guard let asked = socketDraft?.trimmingCharacters(in: .whitespaces), let snapshot, !asked.isEmpty else { return false }
        return asked != snapshot.config.runtimes.tmuxSocketName
    }

    /// The band at the top: a refusal, or the file's own diagnostic.
    public var notice: String? {
        if let refusal = refusal.alert { return refusal.message }
        return snapshot?.diagnostic.map(SettingsRules.fileDiagnosticMessage)
    }
}

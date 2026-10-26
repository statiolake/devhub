// Port of apps/desktop/src/model/persistence.ts — the records and their
// encoding.
//
// DevHub's own state on disk: `state.json` under the app's user-data dir. The
// record shapes are the Rust ones (snake_case, `kind`-tagged), so a state file
// written by either app loads in the other. Schema 12; see `StateSchema` for
// what each version changed and why each bump is for the other direction.

import Foundation

/// The schema history, verbatim in spirit from persistence.ts:
///
/// - 2 retired `navigation.activity` and added `split`; 3 made a close's
///   Agents step one value; 4 took the close out of the file entirely (a v2/v3
///   `closing`/`closing_failed` loads as an open Workspace).
/// - 5 added `location` (a v4 record is a folder on this machine).
/// - 6 added `session_machines`.
/// - 7 added `sidebar.order`.
/// - 8 was the dev container location kind.
/// - 9 added `terminal.zoom_offset`.
/// - 10 made Scratch a Workspace (`navigation.context` absent is Scratch;
///   `"global"` and `scratch` sessions migrated away).
/// - 11 added `agents[].presentation` and `profile_presentation`.
/// - 12 moved the dev container out of `location` and onto `editor`.
///
/// `sidebar.expanded` was retired and `sidebar.collapsed` came back without a
/// bump, as did an Agent's `terminal`, `terminal_share`,
/// `terminal_stacked_share` and `smart_buttons`: absent means what every older
/// file meant.
public enum StateSchema {
    public static let version = 12
    public static let defaultTmuxSocketName = "devhub"
    static let minSidebarWidth: Double = 200
    static let maxSidebarWidth: Double = 400
    static let defaultWindowWidth: Double = 1200
    static let defaultWindowHeight: Double = 800
    static let maxAgentNameBytes = 512
    static let maxAgentProfileArgs = 128
    static let maxAgentProfileArgBytes = 4096
    static let maxAgentProfileEnvEntries = 128
    static let maxAgentProfileEnvKeyBytes = 256
    static let maxAgentProfileEnvValueBytes = 16384
    static let maxAgentProfileSnapshotBytes = 256 * 1024
    static let maxOpaqueMappingBytes = 4096
}

public enum StateErrorCode: String, Sendable, Equatable {
    case io = "STATE_IO"
    case permissionDenied = "STATE_PERMISSION_DENIED"
    case unsafePath = "STATE_UNSAFE_PATH"
    case corrupt = "STATE_CORRUPT"
    case invalid = "STATE_INVALID"
    case newerVersion = "STATE_NEWER_VERSION"
    case invalidTransition = "STATE_INVALID_TRANSITION"
    case cancelled = "STATE_CANCELLED"

    /// What each code means, in the words the person using DevHub gets to read.
    public var reason: String {
        switch self {
        case .io: return "the file could not be written"
        case .permissionDenied: return "permission was denied"
        case .unsafePath: return "the path is not a private regular file"
        case .corrupt: return "the file on disk could not be parsed"
        case .invalid: return "the state DevHub was about to write is not valid"
        case .newerVersion: return "the file on disk was written by a newer DevHub"
        case .invalidTransition: return "the state changed in a way the store forbids"
        case .cancelled: return "the write was cancelled"
        }
    }
}

/// A failure of the state store, said in full: `describe()` names the file
/// and what happened to it.
public struct StateError: Error, Equatable, Sendable, CustomStringConvertible {
    public let code: StateErrorCode
    public let path: String?
    /// The cause's own words (the operating system's, or which field was wrong).
    public let cause: String?

    public init(_ code: StateErrorCode, path: String? = nil, cause: String? = nil) {
        self.code = code
        self.path = path
        self.cause = cause
    }

    public func describe(_ fallbackPath: String? = nil) -> String {
        let place = path ?? fallbackPath ?? "DevHub's state"
        let because = cause.map { $0.isEmpty ? "" : " (\($0))" } ?? ""
        return "\(place): \(code.reason)\(because)"
    }

    public var description: String { describe() }
}

// MARK: - Records

public enum NavigationContextRecord: Equatable, Sendable {
    case workspace(String)
    case agent(String)
}

public struct WindowFrame: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double
    public var maximized: Bool
}

public struct SidebarState: Equatable, Sendable {
    public var width: Double
    /// Whether the Sidebar was left as its icon rail.
    public var collapsed: Bool
    /// The top-level rows in the order the person put them, as workspace ids.
    public var order: [String]
}

public struct ShutdownMetadata: Equatable, Sendable {
    public var clean: Bool
    public var launchGeneration: Double
}

public enum PersistedAgentControlState: Equatable, Sendable {
    case running
    case stopping
    case stopFailed(DiagnosticCode)
}

/// A Workspace's availability, and nothing about a close.
public enum WorkspaceLifecycleRecord: Equatable, Sendable {
    case available
    case unavailable(DiagnosticCode)
}

/// `true` is the old spelling of "waiting".
public enum UnreadRecord: Equatable, Sendable {
    case reason(AgentStatus)
    case flag(Bool)

    var reason: AgentStatus? {
        switch self {
        case let .reason(status): return status
        case let .flag(value): return value ? .waiting : nil
        }
    }
}

public struct AgentTerminalRecord: Equatable, Sendable {
    public var terminalId: String
    public var open: Bool
}

public struct AgentStateRecord: Equatable, Sendable {
    public var agentId: String
    public var workspaceId: String
    public var profileId: String
    public var profileKind: AgentProfileKind?
    public var profileDisplayName: String?
    /// The program the Agent was launched with, as it was at launch.
    public var profileCommand: String?
    public var profileArgs: [String]?
    public var profileEnv: OrderedStringMap?
    /// The snapshot's default presentation, as it was at launch.
    public var profilePresentation: AgentPresentation?
    /// How the Agent was launched to be shown. See version 11.
    public var presentation: AgentPresentation
    public var ordinal: Double
    public var temporaryName: String?
    public var status: AgentStatus
    public var unread: UnreadRecord?
    public var runtimeHealth: AgentRuntimeHealth
    public var controlState: PersistedAgentControlState
    /// An adapter's own identity for this Agent. Opaque and never interpreted.
    public var providerMapping: String?
    public var terminal: AgentTerminalRecord?
    public var terminalShare: Double?
    public var terminalStackedShare: Double?
}

public enum WorkspaceLocationRecord: Equatable, Sendable {
    case local
    case ssh(host: String)
}

public struct EditorRecord: Equatable, Sendable {
    /// The `devcontainer.json`, on the Workspace's machine.
    public var configPath: String
    public var startedContainerId: String?
}

public struct WorkspaceStateRecord: Equatable, Sendable {
    public var workspaceId: String
    public var selectedPath: String
    public var canonicalPath: String
    public var location: WorkspaceLocationRecord?
    public var editor: EditorRecord?
    public var repositoryId: String?
    public var lastAgentId: String?
    public var lifecycle: WorkspaceLifecycleRecord
    public var agents: [AgentStateRecord]
    /// Read, never written: how the content area was tiled when terminals were
    /// the Workspace's (DevHub at 3de5ad4).
    public var paneLayout: WireJSON?
    public var paneTerminals: WireJSON?
}

/// A tmux session DevHub created, and can therefore close.
public struct OwnedSessionRecordState: Equatable, Sendable {
    public var workspaceId: String
    public var sessionName: String
}

public enum CleanupSessionStatus: String, Equatable, Sendable, CaseIterable {
    case pending, completed, failed, conflict
}

public enum RecreationSessionStatus: String, Equatable, Sendable, CaseIterable {
    case pending, completed, failed
}

/// Where a socket change got to.
public enum SocketTransitionState: Equatable, Sendable {
    case stable
    case pending(requestedSocketName: String, required: [OwnedSessionRecordState], preflight: SocketTargetPreflightState,
                 verifiedOldSessions: [OwnedSessionRecordState]?)
    case cleaningOld(oldSocketName: String, requestedSocketName: String, required: [OwnedSessionRecordState],
                     targetPreflight: SocketTargetPreflightState,
                     sessions: [(session: OwnedSessionRecordState, status: CleanupSessionStatus)])
    case oldCleaned(oldSocketName: String, newSocketName: String, required: [OwnedSessionRecordState])
    case recreationPending(effectiveSocketName: String, required: [OwnedSessionRecordState],
                           sessions: [(session: OwnedSessionRecordState, status: RecreationSessionStatus)])

    public static func == (lhs: SocketTransitionState, rhs: SocketTransitionState) -> Bool {
        lhs.json == rhs.json
    }

    var required: [OwnedSessionRecordState]? {
        switch self {
        case .stable: return nil
        case let .pending(_, required, _, _), let .cleaningOld(_, _, required, _, _), let .oldCleaned(_, _, required),
             let .recreationPending(_, required, _):
            return required
        }
    }
}

public struct TmuxState: Equatable, Sendable {
    public var effectiveSocketName: String
    public var transition: SocketTransitionState
}

public struct PersistedAppState: Equatable, Sendable {
    public var schemaVersion: Int
    public var workspaces: [WorkspaceStateRecord]
    /// Every machine DevHub has owned tmux sessions on.
    public var sessionMachines: [String]
    /// Absent is Scratch.
    public var navigation: NavigationContextRecord?
    public var sidebar: SidebarState
    public var splitRatio: Double
    public var zoomOffset: Double
    public var smartButtons: SmartButtonsPlacement
    public var windowFrame: WindowFrame
    public var tmux: TmuxState
    public var shutdown: ShutdownMetadata

    /// `freshState`.
    public static func fresh() -> PersistedAppState {
        PersistedAppState(
            schemaVersion: StateSchema.version, workspaces: [], sessionMachines: [], navigation: nil,
            sidebar: SidebarState(width: AppModel.sidebarDefaultWidth, collapsed: false, order: []),
            splitRatio: AppModel.splitDefaultRatio, zoomOffset: 0, smartButtons: SmartButtonsPlacement(),
            windowFrame: WindowFrame(x: 0, y: 0, width: StateSchema.defaultWindowWidth, height: StateSchema.defaultWindowHeight, maximized: false),
            tmux: TmuxState(effectiveSocketName: StateSchema.defaultTmuxSocketName, transition: .stable),
            shutdown: ShutdownMetadata(clean: true, launchGeneration: 0)
        )
    }

    /// `markStarting`.
    @discardableResult
    public mutating func markStarting() -> Bool {
        let previous = shutdown.launchGeneration
        let wasClean = shutdown.clean
        shutdown.clean = false
        shutdown.launchGeneration += 1
        return wasClean || shutdown.launchGeneration != previous
    }

    /// `markCleanShutdown`.
    @discardableResult
    public mutating func markCleanShutdown() -> Bool {
        if shutdown.clean { return false }
        shutdown.clean = true
        return true
    }
}

// MARK: - Encoding (the file's own spelling, in the order the TS app writes it)

extension OwnedSessionRecordState {
    var json: WireJSON {
        ["kind": "workspace", "workspace_id": .string(workspaceId), "session_name": .string(sessionName)]
    }
}

extension SocketTransitionState {
    var json: WireJSON {
        switch self {
        case .stable: return ["kind": "stable"]
        case let .pending(requested, required, preflight, verified):
            return .object(dropping: [
                ("kind", "pending"), ("requested_socket_name", .string(requested)),
                ("required", .array(required.map(\.json))), ("preflight", .string(preflight.rawValue)),
                ("verified_old_sessions", verified.map { .array($0.map(\.json)) }),
            ])
        case let .cleaningOld(old, requested, required, preflight, sessions):
            return [
                "kind": "cleaning_old", "old_socket_name": .string(old), "requested_socket_name": .string(requested),
                "required": .array(required.map(\.json)), "target_preflight": .string(preflight.rawValue),
                "sessions": .array(sessions.map { ["session": $0.session.json, "status": .string($0.status.rawValue)] }),
            ]
        case let .oldCleaned(old, new, required):
            return [
                "kind": "old_cleaned", "old_socket_name": .string(old), "new_socket_name": .string(new),
                "required": .array(required.map(\.json)),
            ]
        case let .recreationPending(effective, required, sessions):
            return [
                "kind": "recreation_pending", "effective_socket_name": .string(effective),
                "required": .array(required.map(\.json)),
                "sessions": .array(sessions.map { ["session": $0.session.json, "status": .string($0.status.rawValue)] }),
            ]
        }
    }
}

extension SmartButtonsSpot {
    var json: WireJSON {
        switch self {
        case let .anchored(edge, along): return ["anchored": .string(edge.rawValue), "along": .number(along)]
        case let .free(offset): return ["right": .number(offset.right), "bottom": .number(offset.bottom)]
        }
    }
}

extension AgentStateRecord {
    var json: WireJSON {
        let controlState: WireJSON
        switch self.controlState {
        case .running: controlState = ["kind": "running"]
        case .stopping: controlState = ["kind": "stopping"]
        case let .stopFailed(diagnostic): controlState = ["kind": "stop_failed", "diagnostic": .string(diagnostic.rawValue)]
        }
        let unread: WireJSON? = self.unread.map {
            switch $0 {
            case let .reason(status): return .string(status.rawValue)
            case let .flag(value): return .bool(value)
            }
        }
        return .object(dropping: [
            ("agent_id", .string(agentId)),
            ("workspace_id", .string(workspaceId)),
            ("profile_id", .string(profileId)),
            ("profile_kind", profileKind.map { .string($0.rawValue) }),
            ("profile_display_name", profileDisplayName.map(WireJSON.string)),
            ("profile_command", profileCommand.map(WireJSON.string)),
            ("profile_args", profileArgs.map(WireJSON.strings)),
            ("profile_env", profileEnv.map { env in .object(env.entries.map { ($0.key, WireJSON.string($0.value)) }) }),
            ("profile_presentation", profilePresentation.map { .string($0.rawValue) }),
            ("presentation", .string(presentation.rawValue)),
            ("ordinal", .number(ordinal)),
            ("temporary_name", temporaryName.map(WireJSON.string)),
            ("status", .string(status.rawValue)),
            ("unread", unread),
            ("runtime_health", .string(runtimeHealth.rawValue)),
            ("control_state", controlState),
            ("terminal", terminal.map { ["terminal_id": .string($0.terminalId), "open": .bool($0.open)] }),
            ("terminal_share", terminalShare.map(WireJSON.number)),
            ("terminal_stacked_share", terminalStackedShare.map(WireJSON.number)),
            ("provider_mapping", providerMapping.map(WireJSON.string)),
        ])
    }
}

extension WorkspaceStateRecord {
    var json: WireJSON {
        let lifecycle: WireJSON
        switch self.lifecycle {
        case .available: lifecycle = ["kind": "available"]
        case let .unavailable(reason): lifecycle = ["kind": "unavailable", "reason": .string(reason.rawValue)]
        }
        let location: WireJSON? = self.location.map {
            switch $0 {
            case .local: return ["kind": "local"]
            case let .ssh(host): return ["kind": "ssh", "host": .string(host)]
            }
        }
        return .object(dropping: [
            ("workspace_id", .string(workspaceId)),
            ("selected_path", .string(selectedPath)),
            ("canonical_path", .string(canonicalPath)),
            ("location", location),
            ("editor", editor.map { editor in
                .object(dropping: [
                    ("kind", "dev_container"), ("config_path", .string(editor.configPath)),
                    ("started_container_id", editor.startedContainerId.map(WireJSON.string)),
                ])
            }),
            ("repository_id", repositoryId.map(WireJSON.string)),
            ("last_agent_id", lastAgentId.map(WireJSON.string)),
            ("lifecycle", lifecycle),
            ("agents", .array(agents.map(\.json))),
            ("pane_layout", paneLayout),
            ("pane_terminals", paneTerminals),
        ])
    }
}

extension PersistedAppState {
    /// The document, as `JSON.stringify` would see it.
    public var json: WireJSON {
        let navigation: WireJSON
        switch self.navigation {
        case nil: navigation = [:]
        case let .workspace(id)?: navigation = ["context": ["kind": "workspace", "workspace_id": .string(id)]]
        case let .agent(id)?: navigation = ["context": ["kind": "agent", "agent_id": .string(id)]]
        }
        return [
            "schema_version": .int(schemaVersion),
            "workspaces": .array(workspaces.map(\.json)),
            "session_machines": .strings(sessionMachines),
            "navigation": navigation,
            "sidebar": ["width": .number(sidebar.width), "collapsed": .bool(sidebar.collapsed), "order": .strings(sidebar.order)],
            "split": ["ratio": .number(splitRatio)],
            "terminal": ["zoom_offset": .number(zoomOffset)],
            "smart_buttons": .object(dropping: [("tui", smartButtons.tui?.json), ("gui", smartButtons.gui?.json)]),
            "window": ["frame": [
                "x": .number(windowFrame.x), "y": .number(windowFrame.y), "width": .number(windowFrame.width),
                "height": .number(windowFrame.height), "maximized": .bool(windowFrame.maximized),
            ]],
            "tmux": ["effective_socket_name": .string(tmux.effectiveSocketName), "transition": tmux.transition.json],
            "shutdown": ["clean": .bool(shutdown.clean), "launch_generation": .number(shutdown.launchGeneration)],
        ]
    }

    /// `JSON.stringify(state, undefined, 2)` plus the newline the store writes.
    public var fileText: String { json.pretty + "\n" }
}

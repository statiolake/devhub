// Port of apps/desktop/src/main/terminal/ports.ts (the targets, the durable
// session records, the preflight and inspection values).
//
// The terminal runtime's port vocabulary: the domain values it accepts and the
// inspection values it returns. Everything tmux — socket names, session names,
// marker options, process output — stops inside the runtime; nothing here
// names any of it except the socket, which is a configured value the settings
// window shows.

import Foundation

/// A tmux socket name (`tmux -L <name>`).
///
/// The value comes from the config file, so it is validated before it can ever
/// reach argv: a name with a separator or a space would be a different socket,
/// or a different argument entirely.
public struct SocketName: Hashable, Sendable, CustomStringConvertible {
    public let rawValue: String

    public static let maxBytes = 64

    public static func isValid(_ value: String) -> Bool {
        !value.isEmpty && value.utf16.count <= maxBytes
            && value.unicodeScalars.allSatisfy { scalar in
                (scalar >= "A" && scalar <= "Z") || (scalar >= "a" && scalar <= "z")
                    || (scalar >= "0" && scalar <= "9") || scalar == "_" || scalar == "." || scalar == "-"
            }
    }

    public init(_ value: String) throws {
        guard SocketName.isValid(value) else { throw portFailure(.failed) }
        rawValue = value
    }

    public var description: String { rawValue }
}

/// The extra tmux arguments the config may set. Only these two are safe.
public func isSafeTmuxArgument(_ argument: String) -> Bool {
    argument == "-u" || argument == "-2"
}

/// A workspace's terminal: the folder it lives in, named by its workspace id.
public struct WorkspaceTerminalTarget: Hashable, Sendable {
    public var machine: RuntimeId
    public var workspaceId: String
    /// Absolute, canonical.
    public var root: String
    public init(machine: RuntimeId, workspaceId: String, root: String) {
        self.machine = machine
        self.workspaceId = workspaceId
        self.root = root
    }
}

/// An Agent's session: one workspace's folder, named by the Agent's own id.
///
/// What makes it a different *kind* of target is not its transport but its
/// lifetime — a workspace terminal is a place that is created on demand and
/// outlives whatever runs in it, while an Agent session runs one command and
/// ends when that command ends.
public struct AgentTerminalTarget: Hashable, Sendable {
    public var machine: RuntimeId
    public var agentId: String
    public var workspaceId: String
    /// Absolute, canonical: the workspace root the Agent runs in.
    public var root: String
    public init(machine: RuntimeId, agentId: String, workspaceId: String, root: String) {
        self.machine = machine
        self.agentId = agentId
        self.workspaceId = workspaceId
        self.root = root
    }
}

/// An Agent's own terminal (`Cmd+Q V`, `devhub --tell terminal open`), named by
/// its own id and marked with its Agent's Workspace.
///
/// A session of its own on the Workspace's machine, created once with whatever
/// it runs — the login shell, or the command it was opened with — and gone
/// when that ends. Unlike the Workspace's own session it is never recreated on
/// demand; a terminal that ended is not a place to go back to.
public struct PaneTerminalTarget: Hashable, Sendable {
    public var machine: RuntimeId
    public var terminalId: String
    public var workspaceId: String
    /// Absolute, canonical: the root of the Workspace it belongs to.
    public var root: String
    public init(machine: RuntimeId, terminalId: String, workspaceId: String, root: String) {
        self.machine = machine
        self.terminalId = terminalId
        self.workspaceId = workspaceId
        self.root = root
    }
}

/// Which terminal a request is about.
///
/// `scratch` is the tmux server's anchor: the session the bootstrap creates in
/// the same breath as the server, so the server has DevHub's marker from its
/// first instant. It is not Scratch any more — Scratch is a Workspace — so
/// nothing accounts for it and the startup sweep reaps it; the name is the one
/// it had when it was.
public enum TerminalTarget: Hashable, Sendable {
    case scratch(machine: RuntimeId)
    case workspace(WorkspaceTerminalTarget)
    case agent(AgentTerminalTarget)
    case terminal(PaneTerminalTarget)

    public var machine: RuntimeId {
        switch self {
        case .scratch(let machine): return machine
        case .workspace(let target): return target.machine
        case .agent(let target): return target.machine
        case .terminal(let target): return target.machine
        }
    }

    /// This machine's anchor.
    public static let localScratch = TerminalTarget.scratch(machine: .local)

    public static func workspace(machine: RuntimeId, workspaceId: String, root: String) -> TerminalTarget {
        .workspace(WorkspaceTerminalTarget(machine: machine, workspaceId: workspaceId, root: root))
    }

    public static func agent(machine: RuntimeId, agentId: String, workspaceId: String, root: String) -> TerminalTarget {
        .agent(AgentTerminalTarget(machine: machine, agentId: agentId, workspaceId: workspaceId, root: root))
    }

    public static func terminal(machine: RuntimeId, terminalId: String, workspaceId: String, root: String) -> TerminalTarget {
        .terminal(PaneTerminalTarget(machine: machine, terminalId: terminalId, workspaceId: workspaceId, root: root))
    }

    /// Whether two targets name the same terminal (`sameTarget`).
    ///
    /// The Agent id is the whole identity of an Agent: a workspace can be
    /// reopened at a different root, and the Agent running in it is still that
    /// Agent.
    public func same(as other: TerminalTarget) -> Bool {
        if machine != other.machine { return false }
        switch (self, other) {
        case (.scratch, .scratch): return true
        case (.agent(let left), .agent(let right)): return left.agentId == right.agentId
        case (.terminal(let left), .terminal(let right)): return left.terminalId == right.terminalId
        case (.workspace(let left), .workspace(let right)):
            return left.workspaceId == right.workspaceId && left.root == right.root
        default: return false
        }
    }
}

/// What an Agent session is started with.
///
/// The command is not resolved to an absolute path here. tmux execs it from
/// the server's own environment, which is DevHub's frozen launch environment,
/// so a command DevHub can find is a command the Agent can run.
public struct AgentSessionCommand: Sendable, Equatable {
    public var file: String
    public var args: [String]
    /// Extra variables for this Agent only, on top of the server's.
    public var env: [String: String]
    public init(file: String, args: [String], env: [String: String] = [:]) {
        self.file = file
        self.args = args
        self.env = env
    }
}

/// A session DevHub owns, as it is written to disk.
///
/// This is the only durable record of a tmux resource: an unmarked session is
/// counted and never named, so it can never become a kill target after a crash.
public enum OwnedSessionRecord: Hashable, Sendable {
    case scratch(sessionName: String)
    case workspace(workspaceId: String, sessionName: String)
    case agent(agentId: String, workspaceId: String, sessionName: String)
    case terminal(terminalId: String, workspaceId: String, sessionName: String)

    public var sessionName: String {
        switch self {
        case .scratch(let name): return name
        case .workspace(_, let name): return name
        case .agent(_, _, let name): return name
        case .terminal(_, _, let name): return name
        }
    }

    /// `sameOwnedSession`: the exact record, kind and ids and name.
    public func same(as other: OwnedSessionRecord) -> Bool { self == other }
}

/// One Agent session as a listing found it.
///
/// The record is the session's identity; when it last wrote is an
/// *observation*, true only of the listing that made it, so it travels beside
/// the record rather than inside it.
public struct ListedAgentSession: Sendable, Equatable {
    public var record: OwnedSessionRecord
    /// `#{window_activity}`: when the Agent's pane last wrote, to the second.
    /// nil means the runtime did not say, and a reader that uses it to skip
    /// work must not skip.
    public var activity: String?
    public init(record: OwnedSessionRecord, activity: String?) {
        self.record = record
        self.activity = activity
    }
}

/// The sessions that must exist for the app's persisted workspaces.
public struct RequiredTerminalSet: Sendable, Equatable {
    public let sessions: [OwnedSessionRecord]

    public init(_ sessions: [OwnedSessionRecord]) throws {
        var names = Set<String>()
        for session in sessions {
            if !names.insert(session.sessionName).inserted { throw portFailure(.failed) }
        }
        if !sessions.contains(where: { if case .scratch = $0 { return true } else { return false } }) {
            throw portFailure(.failed)
        }
        self.sessions = sessions
    }
}

/// What a socket looks like before the app is allowed to adopt it.
public enum SocketTargetPreflightState: String, Sendable, Equatable {
    case notChecked = "not_checked"
    case targetAbsent = "target_absent"
    case targetDevhubEmpty = "target_devhub_empty"
    case wrongMarker = "wrong_marker"
    case markedSessions = "marked_sessions"
}

public struct TerminalPreflight: Sendable, Equatable {
    public let requestedSocketName: SocketName
    public let state: SocketTargetPreflightState
    public let ownedSessionCount: Int
    public let unknownSessionCount: Int

    public init(
        requestedSocketName: SocketName,
        state: SocketTargetPreflightState,
        ownedSessionCount: Int,
        unknownSessionCount: Int
    ) throws {
        if (state == .targetAbsent && (ownedSessionCount != 0 || unknownSessionCount != 0))
            || (state == .targetDevhubEmpty && ownedSessionCount != 0) {
            throw portFailure(.failed)
        }
        self.requestedSocketName = requestedSocketName
        self.state = state
        self.ownedSessionCount = ownedSessionCount
        self.unknownSessionCount = unknownSessionCount
    }
}

public struct TerminalOwnedSessions: Sendable, Equatable {
    public let sessions: [OwnedSessionRecord]
    public let unknownSessionCount: Int

    public init(sessions: [OwnedSessionRecord], unknownSessionCount: Int) throws {
        var names = Set<String>()
        for session in sessions {
            if !names.insert(session.sessionName).inserted { throw portFailure(.failed) }
        }
        self.sessions = sessions
        self.unknownSessionCount = unknownSessionCount
    }
}

/// One input to the consolidated Workspace close inspection
/// (`ResourceInspection` in `model/domain.ts`).
public enum TerminalResourceInspection: Sendable, Equatable {
    case clean
    case busy(count: Int)
    /// `diagnostic` is a `DiagnosticCode` (`close_terminal_unknown`), `reason`
    /// the one sentence that says why.
    case unknown(diagnostic: String, reason: String?)

    /// `CLEAN` for nothing, `busy(n)` otherwise.
    public static func count(_ count: Int) -> TerminalResourceInspection {
        count == 0 ? .clean : .busy(count: count)
    }

    /// `unknownResource`: an empty reason is no reason.
    public static func unknownResource(_ diagnostic: String, reason: String?) -> TerminalResourceInspection {
        .unknown(diagnostic: diagnostic, reason: (reason?.isEmpty ?? true) ? nil : reason)
    }
}

/// What closing a workspace would destroy, per resource kind.
public struct TerminalInspection: Sendable, Equatable {
    public var process: TerminalResourceInspection
    public var extraPanes: TerminalResourceInspection
    public var extraWindows: TerminalResourceInspection

    public static let clean = TerminalInspection(process: .clean, extraPanes: .clean, extraWindows: .clean)

    public static func unknown(_ reason: String) -> TerminalInspection {
        let unknown = TerminalResourceInspection.unknownResource("close_terminal_unknown", reason: reason)
        return TerminalInspection(process: unknown, extraPanes: unknown, extraWindows: unknown)
    }
}

/// The environment and home every DevHub child is launched with.
///
/// Frozen at startup: the terminal must not observe an environment that changed
/// under it, and the same values are what the shell inside tmux inherits.
public struct RuntimeLaunchContext: Sendable, Equatable {
    /// Absolute. The client's working directory and the anchor session's root.
    public var home: String
    public var environment: [String: String]
    public init(home: String, environment: [String: String]) {
        self.home = home
        self.environment = environment
    }
}

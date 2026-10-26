// Port of `TmuxTerminalRuntime` and `BootstrapConfig` in
// apps/desktop/src/main/terminal/tmux.ts.
//
// DevHub's tmux-backed terminal runtime: the only owner of DevHub's tmux
// socket, session names and marker options. The app model above it sees domain
// targets and inspection counts; tmux names, formats, process output and child
// handles stop here.
//
// Why tmux at all: a terminal surface must survive the app. The shell runs in
// the tmux server, and a surface is a short-lived tmux *client* on a PTY.
// Closing a window, or quitting DevHub, kills clients — never sessions — so the
// same shell, with its scrollback and its running command, is there on the
// next launch. That is the feature; the marker protocol is what makes it safe.
//
// Every destructive command re-reads the marker and the session list
// immediately before it runs, and reads the result back afterwards. Ordinary
// operations hold a shared permit of the gate; a socket transition holds it
// exclusively, so no operation can slip between the final inventory of the old
// socket and the commit of the new effective name.

import Foundation

/// A configured executable, or the sentence saying why there is none.
public enum RuntimeExecutable: Sendable, Equatable {
    case resolved(ResolvedExecutable)
    case unavailable(reason: String)
}

/// One Agent's visible screen and the title its program set.
public struct AgentScreenReading: Sendable, Equatable {
    public var screen: String
    public var oscTitle: String
    public init(screen: String, oscTitle: String) {
        self.screen = screen
        self.oscTitle = oscTitle
    }
}

/// What one reconcile round learned, out of one tmux invocation.
public struct AgentRound: Sendable, Equatable {
    public var marker: MarkerState
    /// Empty unless the marker is `owned`; nothing else may be acted on.
    public var agents: [ListedAgentSession]
    /// By Agent id, for the screens this round asked for *and* tmux answered.
    public var screens: [String: AgentScreenReading]
}

/// One reading of a socket: who owns the server, and what is on it.
public struct Inventory: Sendable, Equatable {
    public var marker: MarkerState
    /// Empty unless the marker is `owned`.
    public var sessions: [SessionInfo]
}

/// One tmux command's result, with the refusal it would raise.
public struct TmuxOutput: Sendable {
    public var success: Bool
    public var code: Int32?
    public var signal: Int32?
    public var stdout: Data
    public var stderr: Data
    /// The command failed because there is no server (`serverReach`).
    public var noServer: Bool
    let subcommand: String

    public func refusal() -> PortFailure { TmuxMarkers.tmuxRefusal(subcommand, stderr: stderr) }
}

/// What DevHub counts about its tmux traffic, for `devhub --metrics`.
public enum TmuxCounter {
    public static let tmuxListSessions = "tmux.list-sessions"
    public static let agentScreenCapture = "agent.screen.capture"
    public static let agentReconcileRound = "agent.reconcile.round"
}

public struct TmuxTerminalRuntimeOptions: Sendable {
    public var context: RuntimeLaunchContext
    /// The configured `runtimes.tmux`, already resolved; unavailable disables
    /// the runtime.
    public var tmux: RuntimeExecutable
    /// What that particular tmux needs in its environment in order to be
    /// itself (a shipped tmux's `TERMINFO`). Empty for the person's own.
    public var tmuxEnvironment: [String: String]
    /// The configured `runtimes.shell`; only its basename is used.
    public var shell: ResolvedExecutable?
    /// The configured `runtimes.tmux_args`. Anything unsafe disables the runtime.
    public var tmuxArgs: [String]
    /// The configured `runtimes.tmux_socket_name`.
    public var effectiveSocketName: String
    /// The directory holding this machine's own `devhub` command, put in front
    /// of every pane's PATH. nil on the machine DevHub runs on.
    public var paneBinDirectory: String?
    public var timeoutMs: Double?
    /// Where the one-shot bootstrap config is written.
    public var bootstrapDirectory: String?
    /// The one user tmux config, as the path on *this Mac* where a person
    /// edits it (`<configDirectory>/tmux.conf`). Asked of the machine again on
    /// every bring-up.
    public var userTmuxConfigSource: String?
    /// The machine tmux runs on.
    public var host: (any MachineRuntime)?
    /// Where the runtime's own log lines go.
    public var log: (@Sendable (String) -> Void)?
    /// Counted events (`TmuxCounter`).
    public var count: (@Sendable (String) -> Void)?

    public init(
        context: RuntimeLaunchContext,
        tmux: RuntimeExecutable,
        tmuxEnvironment: [String: String] = [:],
        shell: ResolvedExecutable? = nil,
        tmuxArgs: [String] = [],
        effectiveSocketName: String,
        paneBinDirectory: String? = nil,
        timeoutMs: Double? = nil,
        bootstrapDirectory: String? = nil,
        userTmuxConfigSource: String? = nil,
        host: (any MachineRuntime)? = nil,
        log: (@Sendable (String) -> Void)? = nil,
        count: (@Sendable (String) -> Void)? = nil
    ) {
        self.context = context
        self.tmux = tmux
        self.tmuxEnvironment = tmuxEnvironment
        self.shell = shell
        self.tmuxArgs = tmuxArgs
        self.effectiveSocketName = effectiveSocketName
        self.paneBinDirectory = paneBinDirectory
        self.timeoutMs = timeoutMs
        self.bootstrapDirectory = bootstrapDirectory
        self.userTmuxConfigSource = userTmuxConfigSource
        self.host = host
        self.log = log
        self.count = count
    }
}

/// The limits every tmux answer is read under: an over-long answer is a
/// failure, not a truncation, because what tmux answers is identity.
let tmuxLimits = MachineExecLimits(
    stdoutBytes: TmuxCommand.maxOutputBytes,
    stderrBytes: TmuxCommand.maxStderrBytes,
    overflow: .fail({ TmuxCommand.shapeFailure("more output than DevHub will read") })
)

public final class TmuxTerminalRuntime: @unchecked Sendable {
    private let context: RuntimeLaunchContext
    private let tmux: RuntimeExecutable
    private let tmuxOwnEnvironment: [String: String]
    private let shellName: String?
    private let tmuxArgs: [String]
    private let gate = RuntimeOperationGate()
    private let bootstrapDirectory: String
    private let userTmuxConfigSource: String
    public let host: any MachineRuntime
    private let paneBinDirectory: String?
    public let timeoutMs: Double
    private let log: @Sendable (String) -> Void
    private let count: @Sendable (String) -> Void

    private let lock = NSLock()
    private var effectiveSocket: SocketName?
    /// One in-flight bring-up per socket, shared by concurrent callers.
    private var serverBootstraps: [SocketName: Task<Void, any Error>] = [:]
    /// The executable whose `tmux -V` this runtime has already accepted.
    private var acceptedVersionOf: String?

    public init(_ options: TmuxTerminalRuntimeOptions) {
        context = options.context
        // One unsafe argument disables the adapter rather than being filtered
        // out of it: a config that asked for something DevHub will not do must
        // not be silently reinterpreted as one that did not ask.
        let argumentsSafe = options.tmuxArgs.allSatisfy(isSafeTmuxArgument)
        tmux = argumentsSafe
            ? options.tmux
            : .unavailable(reason: "DevHub will not run tmux with the configured tmux_args: one of them is not an argument DevHub passes on.")
        tmuxArgs = argumentsSafe ? options.tmuxArgs : []
        tmuxOwnEnvironment = options.tmuxEnvironment
        shellName = options.shell?.basename
        effectiveSocket = try? SocketName(options.effectiveSocketName)
        timeoutMs = options.timeoutMs ?? TmuxMarkers.defaultTimeoutMs
        bootstrapDirectory = options.bootstrapDirectory ?? NSTemporaryDirectory()
        userTmuxConfigSource = options.userTmuxConfigSource ?? "/dev/null"
        host = options.host ?? MachineRuntimes.local
        paneBinDirectory = options.paneBinDirectory
        log = options.log ?? { line in FileHandle.standardError.write(Data((line + "\n").utf8)) }
        count = options.count ?? { _ in }
    }

    /// Which machine this adapter's tmux server is on.
    public var machine: RuntimeId { host.id }

    /// For a sentence: `""` here, `" on <host>"` there.
    public var `where`: String { host.where }

    /// A PTY on the machine tmux is on.
    public func spawnPty(_ launch: PtyLaunch) throws -> any PseudoTerminal { try host.spawnPty(launch) }

    /// Why this machine has no usable tmux, or nil when it has one.
    public var unavailableReason: String? {
        if case .unavailable(let reason) = tmux { return reason }
        if currentSocket == nil { return "DevHub has no usable tmux socket name for the terminals\(self.where)." }
        return nil
    }

    /// True when a tmux executable and a usable socket name are both present.
    public var adapterAvailable: Bool { unavailableReason == nil }

    public var contextHome: String { context.home }
    public var environment: [String: String] { context.environment }

    private var currentSocket: SocketName? { lock.withLock { effectiveSocket } }

    private func executable() throws -> ResolvedExecutable {
        switch tmux {
        case .unavailable(let reason): throw portFailure(.unavailable, detail: reason)
        case .resolved(let value): return value
        }
    }

    private func socket() throws -> SocketName {
        guard let socket = currentSocket else { throw portFailure(.failed) }
        return socket
    }

    public func setEffectiveSocket(_ socket: SocketName) {
        lock.withLock { effectiveSocket = socket }
    }

    /// A fresh read-only health probe: executable, protocol, current socket.
    public func recheckHealth() async -> Bool {
        guard let socket = currentSocket else { return false }
        do {
            _ = try await preflightSync(socket, cancel: CancellationToken())
            return true
        } catch {
            return false
        }
    }

    /// The sessions the persisted workspaces require. Deterministic from the
    /// snapshot alone, so the set can be rebuilt after a crash.
    public func requiredTerminalSet(_ workspaces: [(workspaceId: String, canonicalPath: String)]) throws -> RequiredTerminalSet {
        var sessions: [OwnedSessionRecord] = [.scratch(sessionName: TmuxMarkers.scratchSession)]
        for workspace in workspaces {
            if !TmuxMarkers.isUuid(workspace.workspaceId) { throw portFailure(.failed) }
            sessions.append(.workspace(
                workspaceId: workspace.workspaceId,
                sessionName: TmuxNames.workspaceSession(root: workspace.canonicalPath)
            ))
        }
        return try RequiredTerminalSet(sessions)
    }

    // MARK: - The port surface. Each one takes the gate.

    private func withOperation<T>(_ cancel: CancellationToken, _ body: () async throws -> T) async throws -> T {
        let permit = try await gate.acquireOperation(cancel)
        defer { permit.release() }
        return try await body()
    }

    public func preflight(_ requested: SocketName, cancel: CancellationToken = CancellationToken()) async throws -> TerminalPreflight {
        try await withOperation(cancel) { try await preflightSync(requested, cancel: cancel) }
    }

    public func ensure(_ target: TerminalTarget, cancel: CancellationToken = CancellationToken()) async throws -> TerminalTarget {
        try await withOperation(cancel) {
            try await ensureSyncOnSocket(try socket(), target, cancel: cancel)
            return target
        }
    }

    public func inspect(_ target: TerminalTarget, cancel: CancellationToken = CancellationToken()) async throws -> TerminalInspection {
        try await withOperation(cancel) { try await inspectSync(target, cancel: cancel) }
    }

    public func closeWorkspace(_ target: WorkspaceTerminalTarget, cancel: CancellationToken = CancellationToken()) async throws {
        try await withOperation(cancel) { try await closeSync(target, cancel: cancel) }
    }

    public func inspectOwnedSessions(_ socket: SocketName, cancel: CancellationToken = CancellationToken()) async throws -> TerminalOwnedSessions {
        try await withOperation(cancel) { try await inspectOwnedSessionsSync(socket, cancel: cancel) }
    }

    public func closeOwnedSession(_ socket: SocketName, _ session: OwnedSessionRecord, cancel: CancellationToken = CancellationToken()) async throws {
        try await withOperation(cancel) { try await closeOwnedSessionSync(socket, session, cancel: cancel) }
    }

    public func ensureOnSocket(_ socket: SocketName, _ target: TerminalTarget, cancel: CancellationToken = CancellationToken()) async throws -> TerminalTarget {
        try await withOperation(cancel) {
            try await ensureSyncOnSocket(socket, target, cancel: cancel)
            return target
        }
    }

    // The transition variants run *inside* a held transition permit, so they
    // must not take the gate again. They are the only way to touch a socket
    // that is not the effective one, which is what a socket change is.

    public func transitionPreflight(_ socket: SocketName, cancel: CancellationToken) async throws -> TerminalPreflight {
        try await preflightSync(socket, cancel: cancel)
    }

    public func transitionInspectOwnedSessions(_ socket: SocketName, cancel: CancellationToken) async throws -> TerminalOwnedSessions {
        try await inspectOwnedSessionsSync(socket, cancel: cancel)
    }

    public func transitionCloseOwnedSession(_ socket: SocketName, _ session: OwnedSessionRecord, cancel: CancellationToken) async throws {
        try await closeOwnedSessionSync(socket, session, cancel: cancel)
    }

    public func transitionEnsureOnSocket(_ socket: SocketName, _ target: TerminalTarget, cancel: CancellationToken) async throws {
        try await ensureSyncOnSocket(socket, target, cancel: cancel)
    }

    /// Exclusive access for a socket change, held across the whole transition.
    public func beginTransition(_ cancel: CancellationToken = CancellationToken()) async throws -> RuntimeOperationGate.Permit {
        try await gate.acquireTransition(cancel)
    }

    /// Shared access, for a caller that runs its own provider work (attach).
    public func acquireOperation(_ cancel: CancellationToken) async throws -> RuntimeOperationGate.Permit {
        try await gate.acquireOperation(cancel)
    }

    /// `ensure` for a caller that already holds an operation permit.
    public func ensureUnlocked(_ target: TerminalTarget, cancel: CancellationToken) async throws {
        try await ensureSyncOnSocket(try socket(), target, cancel: cancel)
    }

    /// The session list on the effective socket, for a caller holding a permit.
    public func listSessionsUnlocked(cancel: CancellationToken, deadline: OperationDeadline) async throws -> [SessionInfo] {
        try await listSessions(try socket(), cancel: cancel, deadline: deadline)
    }

    // MARK: - Implementation

    private func preflightSync(_ requested: SocketName, cancel: CancellationToken) async throws -> TerminalPreflight {
        let deadline = OperationDeadline.within(timeoutMs)
        try await ensureVersion(requested, cancel: cancel, deadline: deadline)
        let inventory = try await self.inventory(requested, cancel: cancel, deadline: deadline)
        switch inventory.marker {
        case .absent:
            return try TerminalPreflight(requestedSocketName: requested, state: .targetAbsent, ownedSessionCount: 0, unknownSessionCount: 0)
        case .wrong:
            return try TerminalPreflight(requestedSocketName: requested, state: .wrongMarker, ownedSessionCount: 0, unknownSessionCount: 0)
        case .owned:
            let owned = inventory.sessions.filter { TmuxMarkers.isMarked($0.marking, expectedGlobalRoot: contextHome) }.count
            return try TerminalPreflight(
                requestedSocketName: requested,
                state: owned == 0 ? .targetDevhubEmpty : .markedSessions,
                ownedSessionCount: owned,
                unknownSessionCount: max(0, inventory.sessions.count - owned)
            )
        }
    }

    /// After this returns, the target's exact marked session exists.
    ///
    /// A terminal is a *place*: if it is not there it is created. An Agent is
    /// a *process*: its session is created once, by `launchAgent`, so a missing
    /// Agent session means the Agent ended, and recreating it here would
    /// resurrect it as an empty shell wearing its name.
    private func ensureSyncOnSocket(_ socket: SocketName, _ target: TerminalTarget, cancel: CancellationToken) async throws {
        let deadline = OperationDeadline.within(timeoutMs)
        try await ensureVersion(socket, cancel: cancel, deadline: deadline)
        try await ensureServer(socket, cancel: cancel, deadline: deadline)
        let sessions = try await listSessions(socket, cancel: cancel, deadline: deadline)
        let identity = try targetIdentity(target, sessions: sessions)
        if let existing = sessions.first(where: { $0.name == identity.sessionName }) {
            if !TmuxMarkers.sessionMatches(existing.marking, identity) { throw portFailure(.conflict) }
            // The session is proven DevHub's, so its options are DevHub's to
            // state. Re-stating them here is what migrates a session created by
            // an older build.
            try await applySessionOptions(socket, identity, cancel: cancel, deadline: deadline)
            return
        }
        switch target {
        case .agent, .terminal: throw portFailure(.conflict)
        default: break
        }
        try await createSession(socket, SessionSpec(identity: identity), cancel: cancel, deadline: deadline)
    }

    // MARK: Agents

    /// Start one Agent: a marked session whose session command is the Agent.
    ///
    /// There is no separate "is it already running" branch. The create is the
    /// claim: if a session with this Agent's name already exists, tmux refuses
    /// and the launch is a conflict, which is the truth.
    public func launchAgent(_ target: AgentTerminalTarget, command: AgentSessionCommand, cancel: CancellationToken = CancellationToken()) async throws {
        try await withOperation(cancel) {
            let socket = try socket()
            let deadline = OperationDeadline.within(timeoutMs)
            try await ensureVersion(socket, cancel: cancel, deadline: deadline)
            try await ensureServer(socket, cancel: cancel, deadline: deadline)
            let identity = try targetIdentity(.agent(target), sessions: [])
            var spec = SessionSpec(identity: identity)
            spec.command = command
            try await createSession(socket, spec, cancel: cancel, deadline: deadline)
            // Read the whole marker tuple back before calling the Agent
            // started. A session that exists but is not this Agent's is
            // somebody else's resource, and the row must not claim it.
            let readBack = try await listSessions(socket, cancel: cancel, deadline: deadline)
            guard let created = readBack.first(where: { $0.name == identity.sessionName }),
                  TmuxMarkers.sessionMatches(created.marking, identity)
            else { throw portFailure(.conflict) }
        }
    }

    // MARK: Pane terminals

    /// Start one pane terminal: a marked session running the login shell, or
    /// `command` when there is one, in `cwd` (the Workspace's root when nil).
    ///
    /// The create is the claim, as it is for an Agent. Answers the pane it
    /// made, read back with its whole marker tuple.
    public func launchTerminal(
        _ target: PaneTerminalTarget,
        cwd: String? = nil,
        command: AgentSessionCommand? = nil,
        cancel: CancellationToken = CancellationToken()
    ) async throws -> PaneTerminalPane {
        try await withOperation(cancel) {
            let socket = try socket()
            let deadline = OperationDeadline.within(timeoutMs)
            try await ensureVersion(socket, cancel: cancel, deadline: deadline)
            try await ensureServer(socket, cancel: cancel, deadline: deadline)
            let identity = try targetIdentity(.terminal(target), sessions: [])
            var spec = SessionSpec(identity: identity)
            spec.cwd = cwd
            spec.command = command
            try await createSession(socket, spec, cancel: cancel, deadline: deadline)
            let panes = try await paneTerminalsOn(socket, cancel: cancel, deadline: deadline)
            let created = panes.first { $0.terminalId == target.terminalId && $0.pane.active }
                ?? panes.first { $0.terminalId == target.terminalId }
            // A command that exited at once takes its session with it, and
            // that is a terminal that did not open rather than one to hand out.
            guard let created, created.pane.workspaceId == target.workspaceId else { throw portFailure(.conflict) }
            return created
        }
    }

    /// Every pane of every pane terminal on this machine's effective socket.
    public func paneTerminals(cancel: CancellationToken = CancellationToken()) async throws -> [PaneTerminalPane] {
        try await withOperation(cancel) {
            let socket = try socket()
            let deadline = OperationDeadline.within(timeoutMs)
            try await ensureVersion(socket, cancel: cancel, deadline: deadline)
            return try await paneTerminalsOn(socket, cancel: cancel, deadline: deadline)
        }
    }

    private func paneTerminalsOn(_ socket: SocketName, cancel: CancellationToken, deadline: OperationDeadline) async throws -> [PaneTerminalPane] {
        try await markedPanesOn(socket, cancel: cancel, deadline: deadline) { stdout, home in
            try TmuxMarkers.parsePaneTerminals(stdout, contextHome: home)
        }
    }

    /// Every pane of the Workspaces' editor terminals (their `ws-` sessions),
    /// each with the command line its terminal runs in front when `ps` says.
    public func workspacePanes(cancel: CancellationToken = CancellationToken()) async throws -> [WorkspacePane] {
        try await withOperation(cancel) {
            let socket = try socket()
            let deadline = OperationDeadline.within(timeoutMs)
            try await ensureVersion(socket, cancel: cancel, deadline: deadline)
            let panes = try await markedPanesOn(socket, cancel: cancel, deadline: deadline) { stdout, home in
                try TmuxMarkers.parseWorkspacePanes(stdout, contextHome: home)
            }
            let argv = await foregroundArgs(panes.map(\.pid), cancel: cancel, deadline: deadline)
            return panes.map { WorkspacePane(pane: $0, argv: argv[$0.pid]) }
        }
    }

    /// Move one pane of a Workspace's editor terminal into that Workspace's
    /// Agent terminal (`join-pane`), its process running on: a split of the
    /// terminal's active pane, or — `replace`, for the fresh shell
    /// `launchTerminal` just started — in its place, the shell killed. A window
    /// the pane leaves empty closes, and a `ws-` session with it.
    public func joinIntoTerminal(_ target: PaneTerminalTarget, paneId: String, replace: Bool, cancel: CancellationToken = CancellationToken()) async throws {
        try await withOperation(cancel) {
            let socket = try socket()
            let deadline = OperationDeadline.within(timeoutMs)
            let source = try await markedPanesOn(socket, cancel: cancel, deadline: deadline) { stdout, home in
                try TmuxMarkers.parseWorkspacePanes(stdout, contextHome: home)
            }.first { $0.paneId == paneId }
            let into = try await paneTerminalsOn(socket, cancel: cancel, deadline: deadline)
                .filter { $0.terminalId == target.terminalId }
                .enumerated()
                .sorted { ($0.element.pane.active ? 1 : 0, -$0.offset) > ($1.element.pane.active ? 1 : 0, -$1.offset) }
                .map(\.element)
            guard source?.workspaceId == target.workspaceId, let front = into.first, front.pane.workspaceId == target.workspaceId else {
                throw portFailure(.conflict)
            }
            let output = try await runTmux(
                socket,
                ["join-pane", "-s", paneId, "-t", front.pane.paneId]
                    + (replace && into.count == 1 ? [";", "kill-pane", "-t", front.pane.paneId] : []),
                cancel: cancel,
                deadline: deadline
            )
            if !output.success { throw output.refusal() }
        }
    }

    /// Hand an Agent terminal's windows to its Workspace's editor terminal:
    /// `move-window` into the `ws-` session (made first when it is not there),
    /// every process running on. The `tm-` session ends with its last window.
    public func moveTerminalToWorkspace(_ target: PaneTerminalTarget, cancel: CancellationToken = CancellationToken()) async throws {
        try await withOperation(cancel) {
            let socket = try socket()
            let workspace = TerminalTarget.workspace(machine: target.machine, workspaceId: target.workspaceId, root: target.root)
            try await ensureSyncOnSocket(socket, workspace, cancel: cancel)
            let deadline = OperationDeadline.within(timeoutMs)
            let sessions = try await listSessions(socket, cancel: cancel, deadline: deadline)
            let into = try targetIdentity(workspace, sessions: sessions).sessionName
            var windows: [String] = []
            for pane in try await paneTerminalsOn(socket, cancel: cancel, deadline: deadline)
            where pane.terminalId == target.terminalId && pane.pane.workspaceId == target.workspaceId {
                if !windows.contains(pane.pane.windowId) { windows.append(pane.pane.windowId) }
            }
            if windows.isEmpty { return }
            var args: [String] = []
            for (index, window) in windows.enumerated() {
                if index > 0 { args.append(";") }
                args += ["move-window", "-s", window, "-t", "\(into):"]
            }
            let output = try await runTmux(socket, args, cancel: cancel, deadline: deadline)
            if !output.success { throw output.refusal() }
        }
    }

    /// Start `argv` in a new window of a Workspace's own (`ws-`) session, made
    /// first when it is not there: terminal mode's managed Neovim. A window and
    /// not a split, so the editor has the whole editor area and the person's
    /// layout is left alone. Answers the new pane's id (`%12`).
    public func openEditorWindow(_ target: WorkspaceTerminalTarget, argv: [String], cancel: CancellationToken = CancellationToken()) async throws -> String {
        if argv.isEmpty || argv.contains(where: { $0.scalarContains("\0") }) { throw portFailure(.failed) }
        return try await withOperation(cancel) {
            let socket = try socket()
            let workspace = TerminalTarget.workspace(target)
            try await ensureSyncOnSocket(socket, workspace, cancel: cancel)
            let deadline = OperationDeadline.within(timeoutMs)
            let sessions = try await listSessions(socket, cancel: cancel, deadline: deadline)
            let session = try targetIdentity(workspace, sessions: sessions).sessionName
            let output = try await runTmux(
                socket,
                TmuxMarkers.editorWindowArgs(session: session, root: target.root, argv: argv),
                cancel: cancel,
                deadline: deadline
            )
            if !output.success { throw output.refusal() }
            let paneId = String(decoding: output.stdout, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            if !TmuxMarkers.isPaneId(paneId) { throw TmuxCommand.shapeFailure("new-window answered with no pane id") }
            return paneId
        }
    }

    public enum EditorPaneState: String, Sendable, Equatable { case alive, dead, gone }

    /// Whether `paneId` is one of a Workspace's own panes, and running.
    public func editorPaneState(_ target: WorkspaceTerminalTarget, paneId: String, cancel: CancellationToken = CancellationToken()) async throws -> EditorPaneState {
        try await withOperation(cancel) {
            guard let pane = try await workspacePaneUnlocked(target, paneId: paneId, cancel: cancel) else { return .gone }
            return pane.dead ? .dead : .alive
        }
    }

    /// Bring one of a Workspace's panes to the front: its window, then it.
    public func activateEditorPane(_ target: WorkspaceTerminalTarget, paneId: String, cancel: CancellationToken = CancellationToken()) async throws {
        try await onWorkspacePane(target, paneId: paneId, args: TmuxMarkers.activatePaneArgs(paneId), cancel: cancel)
    }

    /// Kill one of a Workspace's panes. One already gone is not a failure.
    public func killEditorPane(_ target: WorkspaceTerminalTarget, paneId: String, cancel: CancellationToken = CancellationToken()) async throws {
        try await onWorkspacePane(target, paneId: paneId, args: ["kill-pane", "-t", paneId], cancel: cancel)
    }

    /// Run a command on a pane once it is read back, in the same held permit,
    /// as one of this Workspace's: a pane id is only unique on its server, and
    /// acting on another session's pane cannot be taken back.
    private func onWorkspacePane(_ target: WorkspaceTerminalTarget, paneId: String, args: [String], cancel: CancellationToken) async throws {
        try await withOperation(cancel) {
            guard try await workspacePaneUnlocked(target, paneId: paneId, cancel: cancel) != nil else { return }
            let output = try await runTmux(try socket(), args, cancel: cancel, deadline: OperationDeadline.within(timeoutMs))
            if !output.success { throw output.refusal() }
        }
    }

    private func workspacePaneUnlocked(_ target: WorkspaceTerminalTarget, paneId: String, cancel: CancellationToken) async throws -> MarkedPane? {
        if !TmuxMarkers.isPaneId(paneId) { return nil }
        let panes = try await markedPanesOn(try socket(), cancel: cancel, deadline: OperationDeadline.within(timeoutMs)) { stdout, home in
            try TmuxMarkers.parseWorkspacePanes(stdout, contextHome: home)
        }
        return panes.first { $0.paneId == paneId && $0.workspaceId == target.workspaceId }
    }

    /// What each pane's terminal runs in front, by the pane's pid: the leader
    /// of its foreground process group (`ssh prod`, not the shell under it).
    /// Best effort: a `ps` that does not answer says nothing.
    private func foregroundArgs(_ pids: [Int], cancel: CancellationToken, deadline: OperationDeadline) async -> [Int: String] {
        func ps(_ fields: String, _ of: [Int]) async throws -> [(Int, String)] {
            if of.isEmpty { return [] }
            let answer = try await host.exec(ExecRequest(
                argv: ["ps", "-ww", "-o", fields, "-p", of.map(String.init).joined(separator: ",")],
                cwd: contextHome,
                env: tmuxEnvironment(),
                deadline: deadline,
                cancel: cancel,
                limits: tmuxLimits
            ))
            // A pid that has gone makes `ps` exit 1; the rest still holds.
            return answer.stdoutText.scalarSplit("\n").compactMap { line in
                let trimmed = line.drop { $0 == " " || $0 == "\t" }
                let digits = trimmed.prefix { $0.isASCII && $0.isNumber }
                let rest = trimmed.dropFirst(digits.count)
                guard !digits.isEmpty, let first = rest.first, first == " " || first == "\t" else { return nil }
                let value = rest.trimmingCharacters(in: .whitespaces)
                guard !value.isEmpty, let pid = Int(digits) else { return nil }
                return (pid, value)
            }
        }
        var found: [Int: String] = [:]
        do {
            let groups = try await ps("pid=,tpgid=", pids.filter { $0 > 0 })
            var leaderIds: [Int] = []
            for (_, group) in groups {
                if let id = Int(group), !leaderIds.contains(id) { leaderIds.append(id) }
            }
            var leaders: [Int: String] = [:]
            for (pid, args) in try await ps("pid=,args=", leaderIds) { leaders[pid] = args }
            for (pid, group) in groups {
                if let id = Int(group), let argv = leaders[id] { found[pid] = argv }
            }
        } catch {
            // Best effort, as above.
        }
        return found
    }

    private func markedPanesOn<Pane>(
        _ socket: SocketName,
        cancel: CancellationToken,
        deadline: OperationDeadline,
        parse: (Data, String) throws -> (marker: MarkerState, panes: [Pane])
    ) async throws -> [Pane] {
        let output = try await runTmux(
            socket,
            ["display-message", "-p", TmuxMarkers.paneMarkerFormat, ";", "list-panes", "-a", "-F", TmuxMarkers.terminalPaneFormat],
            cancel: cancel,
            deadline: deadline
        )
        if !output.success {
            if output.noServer { return [] }
            if output.stdout.isEmpty { throw portFailure(.conflict) }
            throw output.refusal()
        }
        let (marker, panes) = try parse(output.stdout, contextHome)
        if marker == .wrong { throw portFailure(.conflict) }
        return panes
    }

    /// Type a line into a pane terminal's shell and press Return — what
    /// `terminal open --command` means: the command runs *in* the shell, so the
    /// terminal is still there, with its output, when the command ends. `-l`
    /// sends the text as literal characters, never as key names.
    public func typeIntoTerminal(_ target: PaneTerminalTarget, text: String, cancel: CancellationToken = CancellationToken()) async throws {
        // A lone `;` is tmux's command separator when it is a whole argument,
        // and a line with a NUL cannot be typed at all.
        if text == ";" || text.scalarContains("\0") { throw portFailure(.failed) }
        try await withOperation(cancel) {
            let socket = try socket()
            let deadline = OperationDeadline.within(timeoutMs)
            let panes = try await paneTerminalsOn(socket, cancel: cancel, deadline: deadline)
            let pane = panes.first { $0.terminalId == target.terminalId && $0.pane.active }
                ?? panes.first { $0.terminalId == target.terminalId }
            guard let pane, pane.pane.workspaceId == target.workspaceId else { throw portFailure(.conflict) }
            let output = try await runTmux(
                socket,
                ["send-keys", "-t", pane.pane.paneId, "-l", "--", text, ";", "send-keys", "-t", pane.pane.paneId, "Enter"],
                cancel: cancel,
                deadline: deadline
            )
            if !output.success { throw output.refusal() }
        }
    }

    /// Kill one pane terminal's session, by the exact-record rule.
    public func closeTerminal(_ target: PaneTerminalTarget, cancel: CancellationToken = CancellationToken()) async throws {
        try await closeMarkedSession(
            .terminal(terminalId: target.terminalId, workspaceId: target.workspaceId, sessionName: TmuxNames.terminalSession(terminalId: target.terminalId)),
            cancel: cancel
        )
    }

    /// Every Agent session on the effective socket, by Agent id.
    ///
    /// This is the whole of "which Agents are alive". tmux destroys a session
    /// when its command exits, so an id that is not in this list is an Agent
    /// that has ended.
    public func listAgents(cancel: CancellationToken = CancellationToken()) async throws -> [ListedAgentSession] {
        let round = try await agentRound([], cancel: cancel)
        if round.marker == .wrong { throw portFailure(.conflict) }
        return round.agents
    }

    /// One reconcile round: the Agent listing and the screens worth reading, in
    /// one tmux invocation.
    ///
    /// **The batch is composed before the round runs, so `captureIds` comes
    /// from the *previous* round's activity markers.**
    ///
    /// **A session's absence is a fact about that session, never about the
    /// machine.** tmux ends a client's queue at the first command that fails,
    /// so the only command in the batch that can fail on a target is guarded
    /// by `if-shell -F -t <session> '#{session_name}'`: a format test rather
    /// than a shell, run in the same server-side queue as the capture. A
    /// session that is gone contributes an empty screen record and nothing
    /// else, and the *listing* — which ran first — is what marks that Agent as
    /// having exited.
    ///
    /// **Where a failure is attributed.** Nothing at all is the marker probe's
    /// (there is no server), and the marker alone is the listing's. Once the
    /// end-of-listing record is in hand the round has the machine's answer, and
    /// no later exit code may take it back.
    public func agentRound(_ captureIds: [String], cancel: CancellationToken = CancellationToken()) async throws -> AgentRound {
        try await withOperation(cancel) {
            let socket = try socket()
            let deadline = OperationDeadline.within(timeoutMs)
            try await ensureVersion(socket, cancel: cancel, deadline: deadline)
            let wanted = Array(captureIds.prefix(TmuxMarkers.maxCapturesPerRound))
            count(TmuxCounter.tmuxListSessions)
            var args = [
                "display-message", "-p", TmuxMarkers.markerFormat,
                ";", "list-sessions", "-F", TmuxMarkers.sessionFormat,
                ";", "display-message", "-p", TmuxMarkers.listedFormat,
            ]
            for agentId in wanted {
                let session = TmuxNames.agentSession(agentId: agentId)
                args += [
                    ";", "display-message", "-p", "-t", session, TmuxMarkers.captureFormat,
                    // The one command here that can fail on its target, and the
                    // reason the whole batch used to fail with it.
                    ";", "if-shell", "-F", "-t", session, TmuxMarkers.sessionExistsFormat, "capture-pane -p -J -t \(session)",
                    ";", "display-message", "-p", TmuxMarkers.captureEndFormat,
                ]
            }
            let output = try await runTmux(socket, args, cancel: cancel, deadline: deadline)
            return try readRound(output, wanted: wanted)
        }
    }

    /// Read what one batched round answered, in the order it was asked.
    func readRound(_ output: TmuxOutput, wanted: [String]) throws -> AgentRound {
        if !output.success && output.stdout.isEmpty {
            return AgentRound(marker: output.noServer ? .absent : .wrong, agents: [], screens: [:])
        }
        let records = try TmuxCommand.splitRecords(output.stdout)
        guard let first = records.first?.scalarSplit("\u{1f}"), first.first == TmuxMarkers.markerRecord else {
            throw TmuxCommand.shapeFailure("no marker where the marker record should be")
        }
        if first.count < 2 || first[1] != TmuxMarkers.protocolValue {
            return AgentRound(marker: .wrong, agents: [], screens: [:])
        }
        var sessions: [[String]] = []
        var index = 1
        var listed = false
        while index < records.count {
            let fields = records[index].scalarSplit("\u{1f}")
            if fields.count == 1 && fields[0] == TmuxMarkers.listedRecord {
                listed = true
                index += 1
                break
            }
            if fields.count != TmuxMarkers.sessionFields.count { throw TmuxCommand.shapeFailure("a record of the wrong width") }
            sessions.append(fields)
            index += 1
        }
        if !listed {
            // The server was DevHub's and went away between the two commands,
            // which is the same answer an absent server gives.
            if output.noServer { return AgentRound(marker: .owned, agents: [], screens: [:]) }
            throw output.refusal()
        }
        let agents = try TmuxMarkers.sessionsFrom(sessions)
            .filter { $0.context == TmuxMarkers.agentContext && TmuxMarkers.isMarked($0.marking, expectedGlobalRoot: contextHome) }
            .map { ListedAgentSession(record: try ownedSessionRecord($0), activity: $0.activity) }
        var screens: [String: AgentScreenReading] = [:]
        // Every Agent the batch named answers with exactly two records — the
        // header and the screen — so the answer is read *by position against
        // what was asked for*, and a count that does not match is tmux
        // disagreeing with the batch DevHub wrote.
        if records.count - index != wanted.count * 2 {
            throw TmuxCommand.shapeFailure("a screen for every Agent the round asked about")
        }
        for asked in wanted {
            let header = records[index].scalarSplit("\u{1f}")
            let screen = records[index + 1]
            index += 2
            if header.count != TmuxMarkers.captureFields.count || header[0] != TmuxMarkers.captureRecord {
                throw TmuxCommand.shapeFailure("a record of the wrong width")
            }
            // The pane answered with an Agent id, and it has to be the one the
            // queue named; what became of that Agent is the listing's to say.
            if header[1] != asked { continue }
            count(TmuxCounter.agentScreenCapture)
            screens[asked] = AgentScreenReading(screen: screen, oscTitle: header[2])
        }
        return AgentRound(marker: .owned, agents: agents, screens: screens)
    }

    /// Every pane of every Workspace terminal session on this server, with its
    /// foreground command, its output signals and whether it is on screen — one
    /// tmux invocation (`list-panes -a`). No server is no terminals, not a
    /// failure. A server DevHub does not own is the usual fail-closed conflict.
    public func terminalPanes(cancel: CancellationToken = CancellationToken()) async throws -> (panes: [PaneSample], terminals: [TerminalSessionSample]) {
        try await withOperation(cancel) {
            let socket = try socket()
            let deadline = OperationDeadline.within(timeoutMs)
            try await ensureVersion(socket, cancel: cancel, deadline: deadline)
            let output = try await runTmux(
                socket,
                ["display-message", "-p", TmuxMarkers.paneMarkerFormat, ";", "list-panes", "-a", "-F", TmuxMarkers.paneActivityFormat],
                cancel: cancel,
                deadline: deadline
            )
            if !output.success {
                if output.noServer { return ([], []) }
                if output.stdout.isEmpty { throw portFailure(.conflict) }
                throw output.refusal()
            }
            let reading = try TmuxMarkers.parsePaneActivity(output.stdout, contextHome: contextHome)
            if reading.marker == .wrong { throw portFailure(.conflict) }
            return (reading.panes, reading.terminals)
        }
    }

    /// Type text into one Agent's prompt, as a paste, and submit it.
    ///
    /// The bytes are wrapped in the bracketed-paste markers a terminal sends
    /// when a person pastes, so a multi-line instruction lands in the prompt
    /// box as one message. The line breaks are carriage returns — what a
    /// terminal puts on the wire for Return. The Return goes separately, a beat
    /// later (`pasteSubmitDelayMs`).
    ///
    /// **Why the identity is read again first.** This writes, and there is no
    /// discarding a keystroke that has already been typed into the wrong pane.
    public func injectAgentText(_ record: OwnedSessionRecord, text: String, cancel: CancellationToken = CancellationToken()) async throws {
        guard case .agent(let agentId, _, let sessionName) = record else { throw portFailure(.failed) }
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw portFailure(.failed) }
        try await withOperation(cancel) {
            let socket = try socket()
            let deadline = OperationDeadline.within(timeoutMs)
            let identity = try await runTmux(
                socket,
                ["display-message", "-p", "-t", sessionName, "#{\(TmuxMarkers.agentIdOption)}"],
                cancel: cancel,
                deadline: deadline
            )
            if !identity.success { throw portFailure(.conflict) }
            if try TmuxCommand.parseCapture(identity.stdout).scalarSplit("\n").first != agentId {
                throw portFailure(.conflict)
            }
            let body = text.replacingOccurrences(of: "\r\n", with: "\r").replacingOccurrences(of: "\n", with: "\r")
            let paste = "\u{1b}[200~\(body)\u{1b}[201~"
            let typed = try await runTmux(socket, ["send-keys", "-t", sessionName, "-l", "--", paste], cancel: cancel, deadline: deadline)
            if !typed.success { throw typed.refusal() }
            try await Task.sleep(nanoseconds: UInt64(TmuxMarkers.pasteSubmitDelayMs * 1_000_000))
            try cancel.check()
            let submitted = try await runTmux(socket, ["send-keys", "-t", sessionName, "Enter"], cancel: cancel, deadline: deadline)
            if !submitted.success { throw submitted.refusal() }
        }
    }

    /// The pid of the process tmux runs in an Agent's pane — the Agent's
    /// command itself, which is where its CLI's processes are found. Read with
    /// the Agent id the session carries, in one command, so a same-named
    /// session that is not this Agent's is a conflict.
    public func agentPanePid(_ record: OwnedSessionRecord, cancel: CancellationToken = CancellationToken()) async throws -> Int {
        guard case .agent(let agentId, _, let sessionName) = record else { throw portFailure(.failed) }
        return try await withOperation(cancel) {
            let socket = try socket()
            let deadline = OperationDeadline.within(timeoutMs)
            let answer = try await runTmux(
                socket,
                ["display-message", "-p", "-t", sessionName, "#{\(TmuxMarkers.agentIdOption)}\(TmuxMarkers.fs)#{pane_pid}"],
                cancel: cancel,
                deadline: deadline
            )
            if !answer.success { throw answer.refusal() }
            let line = try TmuxCommand.parseCapture(answer.stdout).scalarSplit("\n")[0]
            let parts = line.scalarSplit("\u{1f}")
            if parts[0] != agentId { throw portFailure(.conflict) }
            guard parts.count > 1, let first = parts[1].first, first != "0",
                  parts[1].allSatisfy({ $0.isASCII && $0.isNumber }), let pid = Int(parts[1])
            else { throw TmuxCommand.shapeFailure("no pane pid where the pane pid should be") }
            return pid
        }
    }

    /// Start an Agent's command again in its own pane: tmux kills the process
    /// the pane runs and runs `command` there instead (`respawn-pane -k`), in
    /// the Agent's folder — what Restart Session is for a terminal Agent.
    ///
    /// The session, its window and its pane stay, so every client attached to
    /// it goes on drawing the same pane, the marker tuple is untouched, and a
    /// reconcile round never sees the Agent gone. The session must be this
    /// Agent's, whole marker tuple and all, before anything is killed, and the
    /// pane's title is blanked again for the reason `createSession` blanks it.
    public func respawnAgent(_ target: AgentTerminalTarget, command: AgentSessionCommand, cancel: CancellationToken = CancellationToken()) async throws {
        try await withOperation(cancel) {
            let socket = try socket()
            let deadline = OperationDeadline.within(timeoutMs)
            try await ensureVersion(socket, cancel: cancel, deadline: deadline)
            let identity = try targetIdentity(.agent(target), sessions: [])
            if try await host.stat(identity.root) != .directory { throw portFailure(.rootMissing) }
            if try await markerState(socket, cancel: cancel, deadline: deadline) != .owned { throw portFailure(.conflict) }
            guard let listed = try await listSessions(socket, cancel: cancel, deadline: deadline).first(where: { $0.name == identity.sessionName }),
                  TmuxMarkers.sessionMatches(listed.marking, identity)
            else { throw portFailure(.conflict) }
            var env = sessionEnvironment(SessionSpec(identity: identity))
            for (key, value) in command.env { env[key] = value }
            let args = ["respawn-pane", "-k", "-t", identity.sessionName, "-c", identity.root]
                + (try TmuxMarkers.envArguments(env))
                + ["--", command.file] + command.args
                + [";", "select-pane", "-t", identity.sessionName, "-T", ""]
            let output = try await runTmux(socket, args, cancel: cancel, deadline: deadline)
            if !output.success { throw output.refusal() }
        }
    }

    /// Kill one Agent's session, by the same exact-record rule as any other.
    public func closeAgent(_ record: OwnedSessionRecord, cancel: CancellationToken = CancellationToken()) async throws {
        try await closeMarkedSession(record, cancel: cancel)
    }

    /// Every DevHub-marked session on this machine's effective socket.
    public func markedSessions(cancel: CancellationToken = CancellationToken()) async throws -> [OwnedSessionRecord] {
        try await inspectOwnedSessions(try socket(), cancel: cancel).sessions
    }

    /// Kill one marked session on this machine's effective socket.
    public func closeMarkedSession(_ record: OwnedSessionRecord, cancel: CancellationToken = CancellationToken()) async throws {
        try await withOperation(cancel) { try await closeOwnedSessionSync(try socket(), record, cancel: cancel) }
    }

    /// The exact marked sessions on a socket: the only operation that turns
    /// provider metadata into durable cleanup records.
    private func inspectOwnedSessionsSync(_ socket: SocketName, cancel: CancellationToken) async throws -> TerminalOwnedSessions {
        let deadline = OperationDeadline.within(timeoutMs)
        try await ensureVersion(socket, cancel: cancel, deadline: deadline)
        let inventory = try await self.inventory(socket, cancel: cancel, deadline: deadline)
        switch inventory.marker {
        case .absent: return try TerminalOwnedSessions(sessions: [], unknownSessionCount: 0)
        case .wrong: throw portFailure(.conflict)
        case .owned: break
        }
        var owned: [OwnedSessionRecord] = []
        for session in inventory.sessions where TmuxMarkers.isMarked(session.marking, expectedGlobalRoot: contextHome) {
            owned.append(try ownedSessionRecord(session))
        }
        return try TerminalOwnedSessions(sessions: owned, unknownSessionCount: max(0, inventory.sessions.count - owned.count))
    }

    private func ownedSessionRecord(_ session: SessionInfo) throws -> OwnedSessionRecord {
        let uuid = TmuxMarkers.isUuid
        if session.context == TmuxMarkers.globalContext && session.workspaceId == TmuxMarkers.globalId
            && session.name == TmuxMarkers.scratchSession {
            return .scratch(sessionName: TmuxMarkers.scratchSession)
        }
        if session.context == TmuxMarkers.workspaceContext, let workspaceId = session.workspaceId, uuid(workspaceId) {
            return .workspace(workspaceId: workspaceId, sessionName: session.name)
        }
        if session.context == TmuxMarkers.agentContext, let agentId = session.agentId, let workspaceId = session.workspaceId,
           uuid(agentId), uuid(workspaceId) {
            return .agent(agentId: agentId, workspaceId: workspaceId, sessionName: session.name)
        }
        if session.context == TmuxMarkers.terminalContext, let workspaceId = session.workspaceId, uuid(workspaceId),
           let terminalId = TmuxMarkers.terminalIdOfSession(session.name) {
            return .terminal(terminalId: terminalId, workspaceId: workspaceId, sessionName: session.name)
        }
        throw portFailure(.conflict)
    }

    private func closeOwnedSessionSync(_ socket: SocketName, _ expected: OwnedSessionRecord, cancel: CancellationToken) async throws {
        let deadline = OperationDeadline.within(timeoutMs)
        try await ensureVersion(socket, cancel: cancel, deadline: deadline)
        switch try await markerState(socket, cancel: cancel, deadline: deadline) {
        case .absent: return
        case .wrong: throw portFailure(.conflict)
        case .owned: break
        }
        guard try await findOwned(socket, expected, cancel: cancel, deadline: deadline) != nil else { return }
        // The first marker/list pair only establishes an idempotent candidate.
        // Re-inspect both immediately before the kill, so a replaced session or
        // a changed server marker cannot turn this exact record into a broad,
        // name-based destructive operation.
        switch try await markerState(socket, cancel: cancel, deadline: deadline) {
        case .absent: return
        case .wrong: throw portFailure(.conflict)
        case .owned: break
        }
        guard try await findOwned(socket, expected, cancel: cancel, deadline: deadline) != nil else { return }
        let output = try await runTmux(socket, ["kill-session", "-t", expected.sessionName], cancel: cancel, deadline: deadline)
        if !output.success { throw output.refusal() }
        // Confirm the destructive operation's result: completion stays
        // idempotent across a crash, and a replacement is never mistaken for
        // the session that was meant to be removed.
        let remaining = try await listSessions(socket, cancel: cancel, deadline: deadline)
        guard let survivor = remaining.first(where: { $0.name == expected.sessionName }) else { return }
        throw portFailure(try matchesOwnedRecord(survivor, expected) ? .failed : .conflict)
    }

    /// The exact session for a record, or nil when it is already gone. A
    /// same-named session that is not the record is a conflict.
    private func findOwned(_ socket: SocketName, _ expected: OwnedSessionRecord, cancel: CancellationToken, deadline: OperationDeadline) async throws -> SessionInfo? {
        let sessions = try await listSessions(socket, cancel: cancel, deadline: deadline)
        for session in sessions where session.name == expected.sessionName {
            if try matchesOwnedRecord(session, expected) { return session }
        }
        if sessions.contains(where: { $0.name == expected.sessionName }) { throw portFailure(.conflict) }
        return nil
    }

    private func matchesOwnedRecord(_ session: SessionInfo, _ expected: OwnedSessionRecord) throws -> Bool {
        if session.name != expected.sessionName { return false }
        if case .scratch = expected {
            return TmuxMarkers.sessionMatches(session.marking, try targetIdentity(.scratch(machine: machine), sessions: []))
        }
        guard let root = session.root, TmuxMarkers.isRootMetadata(root) else { return false }
        switch expected {
        case .agent(let agentId, let workspaceId, let sessionName):
            return session.context == TmuxMarkers.agentContext && session.workspaceId == workspaceId
                && session.agentId == agentId && sessionName == TmuxNames.agentSession(agentId: agentId)
        case .terminal(let terminalId, let workspaceId, let sessionName):
            return session.context == TmuxMarkers.terminalContext && session.workspaceId == workspaceId
                && session.agentId == TmuxMarkers.noAgent && sessionName == TmuxNames.terminalSession(terminalId: terminalId)
        case .workspace(let workspaceId, let sessionName):
            return session.context == TmuxMarkers.workspaceContext && session.workspaceId == workspaceId
                && session.agentId == TmuxMarkers.noAgent && TmuxMarkers.isWorkspaceSessionName(sessionName, root: root)
        case .scratch:
            return false
        }
    }

    private func inspectSync(_ target: TerminalTarget, cancel: CancellationToken) async throws -> TerminalInspection {
        let deadline = OperationDeadline.within(timeoutMs)
        do {
            let socket = try socket()
            try await ensureVersion(socket, cancel: cancel, deadline: deadline)
            let inventory = try await self.inventory(socket, cancel: cancel, deadline: deadline)
            if inventory.marker == .absent { return .clean }
            if inventory.marker == .wrong {
                return .unknown("The tmux server\(self.where) is not the one DevHub started, so DevHub will not speak for what is in it.")
            }
            let identity = try targetIdentity(target, sessions: inventory.sessions)
            guard let session = inventory.sessions.first(where: { $0.name == identity.sessionName }) else { return .clean }
            if !TmuxMarkers.sessionMatches(session.marking, identity) {
                return .unknown("A tmux session\(self.where) already has the name DevHub uses for this workspace, and it is not DevHub's.")
            }
            // Without the configured shell's name there is no way to tell a
            // pane that is only a shell from one running the viewer's work.
            if shellName == nil {
                return .unknown("DevHub does not know which shell\(self.where) is the configured one, so it cannot tell an idle pane from a working one.")
            }
            let (windows, panes) = try await listWindowsAndPanes(socket, session: session.name, cancel: cancel, deadline: deadline)
            return TerminalInspection(
                process: .count(panes.filter { !isConfiguredShellCommand($0) }.count),
                extraPanes: .count(max(0, panes.count - 1)),
                extraWindows: .count(max(0, windows - 1))
            )
        } catch let failure as PortFailure where failure.code == .cancelled {
            throw failure
        } catch {
            // The provider's own words, kept: which tmux, on which machine,
            // refused what is the part the person reading a close
            // confirmation can act on.
            return .unknown("DevHub could not read the tmux\(self.where): \(RuntimeFailureText.of(error))")
        }
    }

    private func closeSync(_ target: WorkspaceTerminalTarget, cancel: CancellationToken) async throws {
        let socket = try socket()
        let deadline = OperationDeadline.within(timeoutMs)
        try await ensureVersion(socket, cancel: cancel, deadline: deadline)
        let inventory = try await self.inventory(socket, cancel: cancel, deadline: deadline)
        if inventory.marker == .absent { return }
        if inventory.marker == .wrong { throw portFailure(.conflict) }
        let identity = try workspaceIdentity(target, sessions: inventory.sessions)
        guard let existing = inventory.sessions.first(where: { $0.name == identity.sessionName }) else { return }
        if !TmuxMarkers.sessionMatches(existing.marking, identity) { throw portFailure(.conflict) }
        // Re-inspect immediately before the destructive command.
        let recheck = try await self.inventory(socket, cancel: cancel, deadline: deadline)
        if recheck.marker == .absent { return }
        if recheck.marker == .wrong { throw portFailure(.conflict) }
        guard let current = recheck.sessions.first(where: { $0.name == identity.sessionName }) else { return }
        if !TmuxMarkers.sessionMatches(current.marking, identity) { throw portFailure(.conflict) }
        let output = try await runTmux(socket, ["kill-session", "-t", identity.sessionName], cancel: cancel, deadline: deadline)
        if !output.success { throw output.refusal() }
    }

    /// Bring the socket up, and do it once at a time.
    ///
    /// Attaching takes a *shared* permit, because two surfaces attaching at
    /// once is normal. Bringing a socket up is not shareable: the second caller
    /// would see a server that exists with its marker not yet written and read
    /// that as somebody else's tmux. Concurrent callers therefore share one
    /// attempt. The result is not cached: a server can be killed underneath the
    /// app between two operations.
    private func ensureServer(_ socket: SocketName, cancel: CancellationToken, deadline: OperationDeadline) async throws {
        let attempt: Task<Void, any Error> = lock.withLock {
            if let inFlight = serverBootstraps[socket] { return inFlight }
            let task = Task { [self] in
                defer { lock.withLock { serverBootstraps[socket] = nil } }
                try await bringServerUp(socket, cancel: cancel, deadline: deadline)
            }
            serverBootstraps[socket] = task
            return task
        }
        try await attempt.value
    }

    private func bringServerUp(_ socket: SocketName, cancel: CancellationToken, deadline: OperationDeadline) async throws {
        // Asked of the machine here and not when the adapter was built, so that
        // the config this bring-up applies is the one on disk now.
        let config = await host.userTmuxConfig(userTmuxConfigSource)
        let marker = try await markerState(socket, cancel: cancel, deadline: deadline)
        if marker == .wrong { throw portFailure(.conflict) }
        if marker == .absent { try await bootstrapAbsentServer(socket, config: config, cancel: cancel, deadline: deadline) }
        // Before the anchor and before any session this bring-up goes on to
        // make: a session created under the wrong config is a pane whose
        // shell, keys and status line are not the ones the person asked for.
        try await applyUserConfig(socket, config: config, cancel: cancel, deadline: deadline)
        // The anchor is the *app's* session, and the app runs on one machine.
        if machine.isLocal { try await ensureScratch(socket, cancel: cancel, deadline: deadline) }
    }

    /// Verify the complete anchor identity after every bootstrap or attach.
    ///
    /// A marker alone is not ownership: an existing partial or mismatched
    /// `scratch` session is opaque and must never be repaired in place. If the
    /// exact session is absent on an otherwise-owned server, create it through
    /// the same metadata chain and read it back again.
    private func ensureScratch(_ socket: SocketName, cancel: CancellationToken, deadline: OperationDeadline) async throws {
        let identity = try targetIdentity(.scratch(machine: machine), sessions: [])
        let inventory = try await self.inventory(socket, cancel: cancel, deadline: deadline)
        if let scratch = inventory.sessions.first(where: { $0.name == TmuxMarkers.scratchSession }) {
            if inventory.marker != .owned || !TmuxMarkers.sessionMatches(scratch.marking, identity) { throw portFailure(.conflict) }
            return
        }
        try await createSession(socket, SessionSpec(identity: identity), cancel: cancel, deadline: deadline)
        let readBack = try await self.inventory(socket, cancel: cancel, deadline: deadline)
        guard readBack.marker == .owned,
              let created = readBack.sessions.first(where: { $0.name == TmuxMarkers.scratchSession }),
              TmuxMarkers.sessionMatches(created.marking, identity)
        else { throw portFailure(.conflict) }
    }

    public func markerState(_ socket: SocketName, cancel: CancellationToken, deadline: OperationDeadline) async throws -> MarkerState {
        let output = try await runTmux(socket, ["show-options", "-gqv", TmuxMarkers.protocolOption], cancel: cancel, deadline: deadline)
        if !output.success {
            // A reachable server without this option is an existing foreign
            // server, not an absent one.
            return output.noServer ? .absent : .wrong
        }
        if output.stdout.isEmpty { return .wrong }
        return try TmuxCommand.parseOptionValue(output.stdout) == TmuxMarkers.protocolValue ? .owned : .wrong
    }

    public func ensureVersion(_ socket: SocketName, cancel: CancellationToken, deadline: OperationDeadline) async throws {
        let executable = try executable().path
        if lock.withLock({ acceptedVersionOf == executable }) { return }
        let output = try await runTmux(socket, ["-V"], cancel: cancel, deadline: deadline)
        if !output.success { throw portFailure(.unavailable) }
        guard let line = try TmuxCommand.parseLines(output.stdout).first, line.hasPrefix("tmux ") else {
            throw portFailure(.incompatible)
        }
        let parts = String(line.dropFirst("tmux ".count)).scalarSplit(".")
        let major = TmuxMarkers.parseNumericPrefix(parts.first ?? "")
        let minor = TmuxMarkers.parseNumericPrefix(parts.count > 1 ? parts[1] : "")
        if major < TmuxMarkers.minTmuxMajor || (major == TmuxMarkers.minTmuxMajor && minor < TmuxMarkers.minTmuxMinor) {
            throw portFailure(.incompatible)
        }
        lock.withLock { acceptedVersionOf = executable }
    }

    public func targetIdentity(_ target: TerminalTarget, sessions: [SessionInfo]) throws -> TargetIdentity {
        switch target {
        case .scratch:
            return TargetIdentity(
                sessionName: TmuxMarkers.scratchSession, root: contextHome,
                workspaceId: TmuxMarkers.globalId, context: TmuxMarkers.globalContext, agentId: TmuxMarkers.noAgent
            )
        case .agent(let agent):
            // No fallback name. A collision is a second session claiming to be
            // the same Agent, and renaming around it would hide exactly the
            // thing worth stopping for.
            if !TmuxMarkers.isUuid(agent.agentId) || !agent.root.hasPrefix("/") { throw portFailure(.failed) }
            return TargetIdentity(
                sessionName: TmuxNames.agentSession(agentId: agent.agentId), root: agent.root,
                workspaceId: agent.workspaceId, context: TmuxMarkers.agentContext, agentId: agent.agentId
            )
        case .terminal(let terminal):
            if !TmuxMarkers.isUuid(terminal.terminalId) || !TmuxMarkers.isUuid(terminal.workspaceId) || !terminal.root.hasPrefix("/") {
                throw portFailure(.failed)
            }
            return TargetIdentity(
                sessionName: TmuxNames.terminalSession(terminalId: terminal.terminalId), root: terminal.root,
                workspaceId: terminal.workspaceId, context: TmuxMarkers.terminalContext, agentId: TmuxMarkers.noAgent
            )
        case .workspace(let workspace):
            return try workspaceIdentity(workspace, sessions: sessions)
        }
    }

    /// A workspace session's name is a digest of its root, so it is the same
    /// name on every launch. The longer name exists only for the case where
    /// the short one is already taken by a session that is not this
    /// workspace's.
    private func workspaceIdentity(_ target: WorkspaceTerminalTarget, sessions: [SessionInfo]) throws -> TargetIdentity {
        let root = target.root
        if !root.hasPrefix("/") { throw portFailure(.failed) }
        let digest = TmuxMarkers.workspaceDigest(root: root)
        let short = "ws-" + digest.prefix(20)
        let long = "ws-" + digest.prefix(32)
        func identity(_ name: String) -> TargetIdentity {
            TargetIdentity(sessionName: name, root: root, workspaceId: target.workspaceId, context: TmuxMarkers.workspaceContext, agentId: TmuxMarkers.noAgent)
        }
        func expected(_ name: String) -> Bool? {
            sessions.first { $0.name == name }.map { TmuxMarkers.sessionMatches($0.marking, identity(name)) }
        }
        let shortState = expected(short)
        if shortState == nil || shortState == true { return identity(short) }
        let longState = expected(long)
        if longState == nil || longState == true { return identity(long) }
        throw portFailure(.conflict)
    }

    /// State a marked session's own options on a session already proven owned.
    private func applySessionOptions(_ socket: SocketName, _ identity: TargetIdentity, cancel: CancellationToken, deadline: OperationDeadline) async throws {
        let options = TmuxMarkers.sessionOptions(context: identity.context)
        if options.isEmpty { return }
        var args: [String] = []
        for (index, (option, value)) in options.enumerated() {
            if index > 0 { args.append(";") }
            args += ["set-option", "-t", identity.sessionName, option, value]
        }
        let output = try await runTmux(socket, args, cancel: cancel, deadline: deadline)
        if !output.success { throw output.refusal() }
    }

    struct SessionSpec {
        var name: String
        var root: String
        var context: String
        var workspaceId: String
        var agentId: String
        /// Where the first pane starts, when it is not `root`.
        var cwd: String?
        /// The session's own command, when the session *is* a command: the
        /// pane dies when it exits and takes the session with it.
        var command: AgentSessionCommand?

        init(identity: TargetIdentity) {
            name = identity.sessionName
            root = identity.root
            context = identity.context
            workspaceId = identity.workspaceId
            agentId = identity.agentId
        }
    }

    /// What every pane of a session DevHub creates is given, beyond the
    /// server's: its origin.
    private func sessionEnvironment(_ spec: SessionSpec) -> [String: String] {
        [TmuxMarkers.devhubOrigin: TmuxMarkers.originValue(machine: machine, context: spec.context, workspaceId: spec.workspaceId, agentId: spec.agentId)]
    }

    /// The PATH a pane DevHub creates gets, with DevHub's own `devhub` in
    /// front. nil on the machine DevHub runs on, and when the machine has no
    /// PATH of its own. tmux takes a new pane's PATH from **the client that
    /// created the session**, so it is stated on the client (`tmuxEnvironment`).
    private func panePath(_ base: String?) -> String? {
        guard let directory = paneBinDirectory, let base, !base.isEmpty else { return nil }
        return "\(directory):\(base)"
    }

    private func createSession(_ socket: SocketName, _ spec: SessionSpec, cancel: CancellationToken, deadline: OperationDeadline) async throws {
        if try await host.stat(spec.root) != .directory { throw portFailure(.rootMissing) }
        if let cwd = spec.cwd {
            if !cwd.hasPrefix("/") { throw portFailure(.rootMissing) }
            if try await host.stat(cwd) != .directory { throw portFailure(.rootMissing) }
        }
        if try await markerState(socket, cancel: cancel, deadline: deadline) != .owned { throw portFailure(.conflict) }
        let canonical: String
        do {
            canonical = try await host.realpath(spec.root)
        } catch {
            throw portFailure(.rootInaccessible, detail: RuntimeFailureText.of(error))
        }
        // The root is identity. A path that canonicalises to somewhere else is
        // a different directory, and the session must not claim to be its.
        if canonical != spec.root { throw portFailure(.conflict) }
        var env = sessionEnvironment(spec)
        for (key, value) in spec.command?.env ?? [:] { env[key] = value }
        // One client queue creates the session and writes its whole marker
        // tuple, so a session can never be observed half-owned.
        var args = ["new-session", "-d", "-s", spec.name, "-c", spec.cwd ?? spec.root] + (try TmuxMarkers.envArguments(env))
        if let command = spec.command { args += ["--", command.file] + command.args }
        args += [
            ";", "set-option", "-t", spec.name, TmuxMarkers.contextOption, spec.context,
            ";", "set-option", "-t", spec.name, TmuxMarkers.workspaceIdOption, spec.workspaceId,
            ";", "set-option", "-t", spec.name, TmuxMarkers.rootOption, spec.root,
            ";", "set-option", "-t", spec.name, TmuxMarkers.agentIdOption, spec.agentId,
        ]
        // An Agent's pane starts with no title at all: an empty title is an
        // Agent that has not spoken, and anything else is the Agent speaking.
        if spec.context == TmuxMarkers.agentContext { args += [";", "select-pane", "-t", spec.name, "-T", ""] }
        for (option, value) in TmuxMarkers.sessionOptions(context: spec.context) {
            args += [";", "set-option", "-t", spec.name, option, value]
        }
        // The last read before creating a session: a server that changed
        // marker state while argv was being prepared receives nothing.
        if try await markerState(socket, cancel: cancel, deadline: deadline) != .owned { throw portFailure(.conflict) }
        let output = try await runTmux(socket, args, cancel: cancel, deadline: deadline)
        // Leave a possibly-created session for exact reconciliation. A blind
        // kill could destroy a concurrent or unknown resource.
        if !output.success { throw portFailure(.conflict) }
        if !machine.isLocal && spec.name != TmuxMarkers.scratchSession {
            try await retireRemoteAnchor(socket, cancel: cancel, deadline: deadline)
        }
    }

    /// Take the bootstrap's anchor session off a machine that is not this one,
    /// once something else holds the server up, and only when it is DevHub's.
    private func retireRemoteAnchor(_ socket: SocketName, cancel: CancellationToken, deadline: OperationDeadline) async throws {
        let sessions = try await listSessions(socket, cancel: cancel, deadline: deadline)
        guard let anchor = sessions.first(where: { $0.name == TmuxMarkers.scratchSession }),
              TmuxMarkers.sessionMatches(anchor.marking, try targetIdentity(.scratch(machine: machine), sessions: []))
        else { return }
        if sessions.count < 2 { return }
        _ = try await runTmux(socket, ["kill-session", "-t", TmuxMarkers.scratchSession], cancel: cancel, deadline: deadline)
    }

    /// Every session on the socket, with its whole marker tuple, in one
    /// command — one process rather than `4N + 1`, and atomic per session.
    public func listSessions(_ socket: SocketName, cancel: CancellationToken, deadline: OperationDeadline) async throws -> [SessionInfo] {
        count(TmuxCounter.tmuxListSessions)
        let output = try await runTmux(socket, ["list-sessions", "-F", TmuxMarkers.sessionFormat], cancel: cancel, deadline: deadline)
        if !output.success {
            if output.noServer { return [] }
            throw output.refusal()
        }
        return try TmuxMarkers.sessionsFrom(try TmuxCommand.parseRecords(output.stdout, fieldCount: TmuxMarkers.sessionFields.count))
    }

    /// Every attached client on the socket, which is every terminal on screen:
    /// the one number that says whether clients are leaking.
    public func listClients(_ socket: SocketName, cancel: CancellationToken, deadline: OperationDeadline) async throws -> [ClientInfo] {
        let output = try await runTmux(socket, ["list-clients", "-F", TmuxMarkers.clientFormat], cancel: cancel, deadline: deadline)
        if !output.success {
            if output.noServer { return [] }
            throw output.refusal()
        }
        return try TmuxCommand.parseRecords(output.stdout, fieldCount: TmuxMarkers.clientFields.count)
            .map { ClientInfo(tty: $0[1], session: $0[2]) }
    }

    /// The client list on the effective socket.
    public func listClientsUnlocked(cancel: CancellationToken, deadline: OperationDeadline) async throws -> [ClientInfo] {
        try await listClients(try socket(), cancel: cancel, deadline: deadline)
    }

    /// The server's marker and its whole session list, in one tmux client.
    ///
    /// The marker is read *first* in the client's queue, so a foreign server is
    /// refused before its listing is read. A failure with nothing on stdout is
    /// the marker probe's own — there is no server — and a failure with the
    /// marker record on stdout is the listing's.
    public func inventory(_ socket: SocketName, cancel: CancellationToken, deadline: OperationDeadline) async throws -> Inventory {
        count(TmuxCounter.tmuxListSessions)
        let output = try await runTmux(
            socket,
            ["display-message", "-p", TmuxMarkers.markerFormat, ";", "list-sessions", "-F", TmuxMarkers.sessionFormat],
            cancel: cancel,
            deadline: deadline
        )
        if !output.success && output.stdout.isEmpty {
            return Inventory(marker: output.noServer ? .absent : .wrong, sessions: [])
        }
        let records = try TmuxCommand.parseRecords(output.stdout, fieldCount: TmuxMarkers.sessionFields.count)
        guard let first = records.first, first[0] == TmuxMarkers.markerRecord else {
            throw TmuxCommand.shapeFailure("no marker where the marker record should be")
        }
        let marker: MarkerState = first[1] == TmuxMarkers.protocolValue ? .owned : .wrong
        if marker != .owned { return Inventory(marker: marker, sessions: []) }
        if !output.success {
            if output.noServer { return Inventory(marker: marker, sessions: []) }
            throw output.refusal()
        }
        return Inventory(marker: marker, sessions: try TmuxMarkers.sessionsFrom(Array(records.dropFirst())))
    }

    /// The windows and panes of one session, in one command; each record says
    /// which listing it came from.
    private func listWindowsAndPanes(_ socket: SocketName, session: String, cancel: CancellationToken, deadline: OperationDeadline) async throws -> (Int, [String]) {
        let fs = TmuxMarkers.fs, rs = TmuxMarkers.rs
        let output = try await runTmux(
            socket,
            [
                "list-windows", "-t", session, "-F", "\(TmuxMarkers.windowRecord)\(fs)#{window_id}\(rs)",
                ";", "list-panes", "-t", session, "-F", "\(TmuxMarkers.paneRecord)\(fs)#{pane_current_command}\(rs)",
            ],
            cancel: cancel,
            deadline: deadline
        )
        if !output.success { throw output.refusal() }
        let records = try TmuxCommand.parseRecords(output.stdout, fieldCount: 2)
        let windows = records.filter { $0[0] == TmuxMarkers.windowRecord }.count
        let panes = records.filter { $0[0] == TmuxMarkers.paneRecord }.map { $0[1] }
        if windows > TmuxMarkers.maxWindows || panes.count > TmuxMarkers.maxPanes {
            throw TmuxCommand.shapeFailure("more windows or panes than DevHub will read")
        }
        if windows + panes.count != records.count {
            throw TmuxCommand.shapeFailure("a record from a listing DevHub did not ask for")
        }
        return (windows, panes)
    }

    /// The configured shell's name on this machine, when DevHub knows it.
    public var configuredShell: String? { shellName }

    private func isConfiguredShellCommand(_ command: String) -> Bool {
        guard let shellName else { return false }
        var trimmed = Substring(command)
        while trimmed.hasPrefix("-") { trimmed = trimmed.dropFirst() }
        let name = trimmed.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? String(trimmed)
        return name == shellName
    }

    /// Make the running server run the config the machine has now.
    ///
    /// The digest is what keeps that from being a `source-file` per attach,
    /// and it is recorded only after the sourcing succeeded: tmux runs the rest
    /// of a sequence after a failed `source-file`, so they are two commands,
    /// and a config that does not parse leaves the old digest in place and is
    /// re-sourced — and re-reported — on the next attach. A config that does
    /// not parse is a refusal and not a log line.
    private func applyUserConfig(_ socket: SocketName, config: UserTmuxConfig, cancel: CancellationToken, deadline: OperationDeadline) async throws {
        let recorded = try await runTmux(socket, ["show-options", "-gqv", TmuxMarkers.configDigestOption], cancel: cancel, deadline: deadline)
        if !recorded.success { throw recorded.refusal() }
        // Empty is a server that has never been told — not a digest.
        let applied = recorded.stdout.isEmpty ? "" : try TmuxCommand.parseOptionValue(recorded.stdout)
        if applied == config.digest { return }
        if config.path != UserTmuxConfig.none.path {
            let sourced = try await runTmux(socket, ["source-file", config.path], cancel: cancel, deadline: deadline)
            if !sourced.success {
                throw TmuxMarkers.configRefusal(path: config.path, stdout: sourced.stdout, stderr: sourced.stderr)
            }
        }
        let recording = try await runTmux(socket, ["set-option", "-g", TmuxMarkers.configDigestOption, config.digest], cancel: cancel, deadline: deadline)
        if !recording.success { throw recording.refusal() }
        log(
            config.path == UserTmuxConfig.none.path
                ? "[devhub] no tmux config at \(userTmuxConfigSource), so tmux\(self.where) runs DevHub's settings only"
                : "[devhub] tmux\(self.where) now runs the config at \(config.path)"
        )
    }

    /// Probe or bootstrap an absent server through a startup config.
    ///
    /// tmux reads `-f` only while creating a new server; against an existing
    /// one this invocation is a read-only `show-options` probe and the config
    /// is ignored. That closes the absent-to-wrong-marker race without ever
    /// issuing a mutating command to a server DevHub does not own.
    private func bootstrapAbsentServer(_ socket: SocketName, config: UserTmuxConfig, cancel: CancellationToken, deadline: OperationDeadline) async throws {
        let scratchEnvironment = sessionEnvironment(SessionSpec(identity: try targetIdentity(.scratch(machine: machine), sessions: [])))
        let bootstrap = try await BootstrapConfigFile.create(
            host: host,
            directory: bootstrapDirectory,
            text: TmuxMarkers.bootstrapConfig(scratchEnvironment)
        )
        let output: TmuxOutput
        do {
            output = try await runBootstrapProbe(bootstrap, config: config, socket: socket, scratchEnvironment: scratchEnvironment, cancel: cancel, deadline: deadline)
            await bootstrap.remove()
        } catch {
            await bootstrap.remove()
            throw error
        }
        if output.success {
            if output.stdout.isEmpty { throw portFailure(.conflict) }
            if try TmuxCommand.parseOptionValue(output.stdout) != TmuxMarkers.protocolValue { throw portFailure(.conflict) }
            return
        }
        // A trusted user config may already have created a session named
        // `scratch` with a foreign or partial identity. That observable
        // collision is a conflict; an actual server startup error is a failure.
        let sessions = (try? await listSessions(socket, cancel: cancel, deadline: deadline)) ?? []
        if sessions.contains(where: { $0.name == TmuxMarkers.scratchSession }) { throw portFailure(.conflict) }
        throw output.refusal()
    }

    private func runBootstrapProbe(
        _ bootstrap: BootstrapConfigFile,
        config: UserTmuxConfig,
        socket: SocketName,
        scratchEnvironment: [String: String],
        cancel: CancellationToken,
        deadline: OperationDeadline
    ) async throws -> TmuxOutput {
        var env = tmuxEnvironment()
        env[TmuxMarkers.bootstrapEnvRoot] = contextHome
        env[TmuxMarkers.bootstrapEnvUserConfig] = config.path
        for (key, value) in TmuxMarkers.bootstrapEnvironment(scratchEnvironment) { env[key] = value }
        return try await runTmuxSpec(
            CommandSpec(
                file: try executable().path,
                // `show-options` alone does not create a server. Start it and
                // read the marker in one client queue: on an existing server
                // `start-server` is a no-op and the startup config is ignored.
                args: tmuxArgs + ["-f", bootstrap.path, "-L", socket.rawValue, "start-server", ";", "show-options", "-gqv", TmuxMarkers.protocolOption],
                cwd: contextHome,
                env: env
            ),
            subcommand: "start-server",
            cancel: cancel,
            deadline: deadline
        )
    }

    /// The client's environment: this machine's, and what a pane here must get.
    ///
    /// A DevHub launched from inside a tmux pane must still create and inspect
    /// its own dedicated server, so `TMUX` and `TMUX_PANE` go. And the PATH a
    /// pane DevHub creates will have is the *client's* PATH, so it is stated
    /// here. See `panePath`.
    private func tmuxEnvironment() -> [String: String] {
        var env = context.environment
        for (key, value) in tmuxOwnEnvironment { env[key] = value }
        env.removeValue(forKey: "TMUX")
        env.removeValue(forKey: "TMUX_PANE")
        if let pane = panePath(env["PATH"]) { env["PATH"] = pane }
        return env
    }

    public func runTmux(_ socket: SocketName, _ args: [String], cancel: CancellationToken, deadline: OperationDeadline) async throws -> TmuxOutput {
        try await runTmuxSpec(
            CommandSpec(
                file: try executable().path,
                args: tmuxArgs + ["-L", socket.rawValue] + args,
                // The client's working directory must stay usable even when a
                // workspace has been deleted; session creation still receives
                // its target root through tmux's explicit `-c` argument.
                cwd: contextHome,
                env: tmuxEnvironment()
            ),
            subcommand: TmuxMarkers.tmuxSubcommand(args),
            cancel: cancel,
            deadline: deadline
        )
    }

    /// The one choke point every tmux DevHub runs goes through: a timeout is
    /// named on the way out, a socket tmux could not use is thrown on the way
    /// out (`serverReach`), and a refusal is carried on the result.
    private func runTmuxSpec(_ spec: CommandSpec, subcommand: String, cancel: CancellationToken, deadline: OperationDeadline) async throws -> TmuxOutput {
        let answer: ExecResult
        do {
            answer = try await host.exec(ExecRequest(
                argv: [spec.file] + spec.args,
                cwd: spec.cwd,
                env: spec.env,
                deadline: deadline,
                cancel: cancel,
                limits: tmuxLimits
            ))
        } catch let failure as PortFailure where failure.code == .timedOut && failure.detail == nil {
            throw portFailure(.timedOut, detail: "tmux `\(subcommand)` did not answer within \(TmuxTerminalRuntime.seconds(deadline.budgetMs)) s")
        }
        let success = answer.success
        let reach = success ? nil : TmuxCommand.serverReach(answer.stderr)
        if case .socketUnusable(let failure) = reach { throw failure }
        return TmuxOutput(
            success: success, code: answer.code, signal: answer.signal,
            stdout: answer.stdout, stderr: answer.stderr,
            noServer: reach == .noServer, subcommand: subcommand
        )
    }

    /// How long a diagnostic says DevHub waited, in seconds and without noise.
    static func seconds(_ milliseconds: Double) -> String {
        let value = (milliseconds / 100).rounded() / 10
        return value == value.rounded() ? String(Int(value)) : String(value)
    }

    /// The argv that attaches one PTY client to an exact marked session.
    public func attachArgv(_ sessionName: String) throws -> [String] {
        tmuxArgs + ["-L", try socket().rawValue, "attach-session", "-t", sessionName]
    }

    public func tmuxPath() throws -> String { try executable().path }

    /// The environment a tmux client DevHub opens a PTY on runs in, whole.
    public func tmuxEnv() -> [String: String] { terminalEnvironment(tmuxEnvironment()) }

    /// What this tmux needs added to whatever environment it is started in,
    /// for a client DevHub does **not** start.
    public func tmuxRequires() -> [String: String] { tmuxOwnEnvironment }
}

/// The startup config file, created 0600 and removed as soon as tmux has read
/// it. Written on the machine tmux is about to start on, because that is the
/// only machine the `-f` path means anything on.
final class BootstrapConfigFile: Sendable {
    let host: any MachineRuntime
    let path: String

    private init(host: any MachineRuntime, path: String) {
        self.host = host
        self.path = path
    }

    static func create(host: any MachineRuntime, directory: String, text: String) async throws -> BootstrapConfigFile {
        for _ in 0..<8 {
            var random = SystemRandomNumberGenerator()
            let suffix = (0..<6).map { _ in String(format: "%02x", UInt8.random(in: 0...255, using: &random)) }.joined()
            let path = Path.join(directory, "devhub-tmux-bootstrap-\(ProcessInfo.processInfo.processIdentifier)-\(suffix)")
            let created: Bool
            do {
                // Exclusive create: never write through an existing path.
                created = try await host.writeNewTextFile(path, text: text, mode: 0o600)
            } catch {
                throw portFailure(.failed, detail: RuntimeFailureText.of(error))
            }
            // Not a swallow: a taken name is retried, which is the loop.
            if created { return BootstrapConfigFile(host: host, path: path) }
        }
        throw portFailure(.failed)
    }

    func remove() async {
        // The file is already gone, which is the goal.
        try? await host.removeTree(path)
    }
}

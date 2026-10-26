// The controller's ports on the real services: WP3's terminal Agents and
// tmux runtimes, WP4's git, and the managed Neovims with the person's own
// `nvim` (apps/desktop/src/main/shell/agentWiring.ts `wireAgents`,
// terminalWiring.ts, appController.ts `createManagedNeovims` and
// `disposeWorktree`).

import Foundation

// MARK: - The model, as a round reads it

/// The live model as WP3's wiring reads it: a copy the controller replaces on
/// every snapshot, read synchronously from any thread.
public final class ControllerModelMirror: TerminalAgentModel, @unchecked Sendable {
    private let lock = NSLock()
    private var snapshot: AppSnapshot?

    public init() {}

    func update(_ snapshot: AppSnapshot) { lock.withLock { self.snapshot = snapshot } }

    public func workspaces() -> [TerminalAgentWorkspace] {
        guard let snapshot = lock.withLock({ snapshot }) else { return [] }
        return snapshot.workspaces.map { workspace in
            TerminalAgentWorkspace(id: workspace.id.rawValue, root: workspace.root, agents: workspace.agents.map { agent in
                TerminalAgentRecord(
                    id: agent.id.rawValue, displayName: agent.displayName, profile: ControllerModelMirror.terminalProfile(agent.profile),
                    presentation: agent.presentation)
            })
        }
    }

    public func machine(of workspaceId: String) -> RuntimeId? {
        guard let snapshot = lock.withLock({ snapshot }),
              let workspace = snapshot.workspaces.first(where: { $0.id.rawValue == workspaceId })
        else { return nil }
        return try? RuntimeId.parse(workspace.location.runtimeId)
    }

    /// A model profile as WP3 runs it.
    public static func terminalProfile(_ profile: AgentProfile) -> TerminalAgentProfile {
        var env: [String: String] = [:]
        for (key, value) in profile.env { env[key] = value }
        return TerminalAgentProfile(kind: profile.kind, command: profile.command, args: profile.args, env: env)
    }
}

// MARK: - Agents

/// What a GUI Agent's launch, restart and conversation are, supplied by the
/// conversation layer (WP5/WP6): the half of `AgentAdapter` the terminal
/// wiring does not have.
public protocol GuiAgentControl: Sendable {
    func launch(workspaceId: WorkspaceId, agentId: AgentId, profile: AgentProfile, root: String) async -> AgentLaunchResult
    func restart(_ agentId: AgentId) async throws
    func conversation(_ agentId: AgentId) async throws -> (any TellConversation)?
}

/// `AgentPort` on WP3's `TerminalAgentWiring`, with the GUI half from
/// `GuiAgentControl` when there is one.
public struct TerminalAgentPort: AgentPort {
    public let wiring: TerminalAgentWiring
    public let gui: (any GuiAgentControl)?

    public init(wiring: TerminalAgentWiring, gui: (any GuiAgentControl)? = nil) {
        self.wiring = wiring
        self.gui = gui
    }

    static func code(_ raw: String) -> AgentFailureCode { AgentFailureCode(rawValue: raw) ?? .tmuxCommandFailed }

    public func launch(
        workspaceId: WorkspaceId, agentId: AgentId, profile: AgentProfile, presentation: AgentPresentation, root: String
    ) async -> AgentLaunchResult {
        if presentation == .gui {
            guard let gui else {
                return .failed(code: .agentRuntimeUnavailable, detail: "This DevHub has no conversation runtime, so no GUI Agent can be started.")
            }
            return await gui.launch(workspaceId: workspaceId, agentId: agentId, profile: profile, root: root)
        }
        switch await wiring.launch(
            workspaceId: workspaceId.rawValue, agentId: agentId.rawValue,
            profile: ControllerModelMirror.terminalProfile(profile), workspaceRoot: root)
        {
        case .started: return .started
        case let .failed(refusal): return .failed(code: Self.code(refusal.code), detail: refusal.detail)
        }
    }

    public func stop(_ agentId: AgentId) async -> AgentStopResult {
        switch await wiring.stop(agentId.rawValue) {
        case .stopped: return .stopped
        case let .failed(refusal): return .failed(code: Self.code(refusal.code), detail: refusal.detail)
        }
    }

    /// A terminal Agent's session ends the same way however it is asked to.
    public func terminate(_ agentId: AgentId) async -> AgentStopResult { await stop(agentId) }

    public func restartTerminal(_ agentId: AgentId) async throws { try await wiring.restartTerminal(agentId.rawValue) }

    public func restartConversation(_ agentId: AgentId) async throws {
        guard let gui else { throw InvariantViolation("a GUI Agent's restart was dispatched with no conversation runtime") }
        try await gui.restart(agentId)
    }

    public func reconcile(machine: String, agentId: AgentId?) async throws -> AgentReconciliation {
        let round = try await wiring.reconcile(machine: try RuntimeId.parse(machine), agentId: agentId?.rawValue)
        return AgentReconciliation(
            observations: round.observations.map { observation in
                AgentObservation(
                    agentId: AgentId(unchecked: observation.agentId),
                    status: AgentStatus(observation.status),
                    runtimeHealth: AgentRuntimeHealth(rawValue: observation.runtimeHealth) ?? .unavailable,
                    activity: observation.activity,
                    injection: observation.injection,
                    failure: observation.failure.map { AgentFailure(code: Self.code($0.code), detail: $0.detail) }
                )
            },
            exited: round.exited.map { AgentId(unchecked: $0) }
        )
    }

    public func closeWorkspaceAgents(_ workspaceId: WorkspaceId) async throws {
        try await wiring.closeWorkspaceAgents(workspaceId.rawValue)
    }

    public func queueInjection(_ agentId: AgentId, text: String, review: Bool) throws -> String {
        try wiring.queueInjection(agentId.rawValue, text: text, review: review)
    }

    public func confirmInjection(_ agentId: AgentId, injectionId: String, text: String) throws -> Bool {
        try wiring.confirmInjection(agentId.rawValue, injectionId: injectionId, text: text)
    }

    public func cancelInjection(_ agentId: AgentId, injectionId: String) -> Bool {
        wiring.cancelInjection(agentId.rawValue, injectionId: injectionId)
    }

    public func conversation(_ agentId: AgentId) async throws -> (any TellConversation)? {
        try await gui?.conversation(agentId)
    }
}

// MARK: - Terminals

/// `TerminalPort` on WP3's runtimes and surfaces.
public struct TmuxTerminalPort: TerminalPort {
    public let surfaces: TerminalSurfaces
    private let runtimeFor: @Sendable (RuntimeId) async throws -> TmuxTerminalRuntime

    public init(surfaces: TerminalSurfaces, runtimeFor: @escaping @Sendable (RuntimeId) async throws -> TmuxTerminalRuntime) {
        self.surfaces = surfaces
        self.runtimeFor = runtimeFor
    }

    public func inspect(_ place: TerminalWorkspacePlace) async -> TerminalInspection {
        do {
            return try await runtimeFor(place.machine).inspect(.workspace(place.target))
        } catch {
            return .unknown(RuntimeFailureText.of(error))
        }
    }

    public func closeWorkspaceTerminals(_ place: TerminalWorkspacePlace) async throws {
        try await surfaces.closeWorkspace(place.target)
    }

    public func unavailableReason(_ machine: RuntimeId) async throws -> String? {
        try await runtimeFor(machine).unavailableReason
    }

    public func tmuxPath(_ machine: RuntimeId) async throws -> String { try await runtimeFor(machine).tmuxPath() }

    public func paneTerminals(_ machine: RuntimeId) async throws -> [PaneTerminalPane] {
        try await runtimeFor(machine).paneTerminals()
    }

    public func workspacePanes(_ machine: RuntimeId) async throws -> [WorkspacePane] {
        try await runtimeFor(machine).workspacePanes()
    }

    public func launchTerminal(_ target: PaneTerminalTarget) async throws {
        _ = try await runtimeFor(target.machine).launchTerminal(target)
    }

    public func typeIntoTerminal(_ target: PaneTerminalTarget, text: String) async throws {
        try await runtimeFor(target.machine).typeIntoTerminal(target, text: text)
    }

    public func closePaneTerminal(_ target: PaneTerminalTarget) async throws {
        try await surfaces.closePaneTerminal(target)
    }

    public func closeTerminal(_ target: PaneTerminalTarget) async throws {
        try await runtimeFor(target.machine).closeTerminal(target)
    }

    public func joinIntoTerminal(_ target: PaneTerminalTarget, paneId: String, replace: Bool) async throws {
        try await runtimeFor(target.machine).joinIntoTerminal(target, paneId: paneId, replace: replace)
    }

    public func moveTerminalToWorkspace(_ target: PaneTerminalTarget) async throws {
        try await runtimeFor(target.machine).moveTerminalToWorkspace(target)
    }

    public func profile(_ target: TerminalTarget) async throws -> TerminalProfileAnswer {
        try await surfaces.profile(target)
    }
}

// MARK: - Repositories

/// `RepositoryPort` on WP4's git: the worktree disposal a close ends with
/// (`disposeWorktree`) and the worktree an Issue's branch gets.
public struct GitRepositoryPort: RepositoryPort {
    /// The git of the machine a Workspace is on.
    private let gitCommand: @Sendable (WorkspaceLocation) async throws -> GitCommand

    public init(gitCommand: @escaping @Sendable (WorkspaceLocation) async throws -> GitCommand) {
        self.gitCommand = gitCommand
    }

    public func disposeWorktree(location: WorkspaceLocation, root: String, repository: WorkspaceRepositoryWire?, force: Bool) async throws {
        let command = try await gitCommand(location)
        // The folder's own claim, read before anything is removed: it is the
        // claim that survives a `git worktree remove` that failed half-way.
        let folder = try WorktreeFolders.read(command.runtime, root)
        let gitSaysWorktree = repository?.mainWorktree != nil && repository?.worktree == root
            && repository?.worktree != repository?.mainWorktree
        guard let mainWorktree = gitSaysWorktree ? repository?.mainWorktree : folder?.mainWorktree else {
            // The repository itself, a folder not read yet, or a subdirectory
            // of a checkout: removing any of those is not what this is for.
            throw CodedFailure.workspace("This workspace is not a worktree of a repository DevHub can see.")
        }
        try await WorktreeFolders.dispose(command, mainWorktree: mainWorktree, root: root, force: force)
    }

    public func ensureWorktree(location: WorkspaceLocation, mainWorktree: String, issue: Int, branch: String) async throws -> String {
        try await gitCommand(location).ensureWorktree(mainWorktree, work: .issue(issue), branch: branch)
    }
}

// MARK: - The managed Neovims

public enum ControllerNeovims {
    /// `createManagedNeovims`: terminal mode's editor, in this Mac's tmux,
    /// started with the person's own `nvim` from the login PATH — the same
    /// lookup `runtimes.*` gets, so DevHub and a shell inside it cannot
    /// disagree about which Neovim there is. A socket directory that does not
    /// fit, and a missing `nvim`, are said at the first jump, not at startup.
    public static func make(
        userDataPath: String, launchPath: @escaping @Sendable () -> String, loginFailure: @escaping @Sendable () -> String?,
        local: @escaping @Sendable () async throws -> TmuxTerminalRuntime,
        machine: any MachineRuntime = MachineRuntimes.local,
        log: @escaping @Sendable (String) -> Void = { FileHandle.standardError.write(Data(($0 + "\n").utf8)) }
    ) -> ManagedNeovims {
        let runtime: @Sendable () async throws -> TmuxTerminalRuntime = {
            let tmux = try await local()
            if let reason = tmux.unavailableReason { throw ManagedNeovimError(reason) }
            return tmux
        }
        let candidates = [
            Path.join(userDataPath, "devhub", "nvim"),
            Path.join(NSTemporaryDirectory(), "devhub-nvim-\(getuid())"),
        ]
        var socketDirectory = candidates[1]
        var socketProblem: String?
        do {
            socketDirectory = try ManagedNeovimSockets.directory(for: candidates)
        } catch {
            socketProblem = String(describing: error)
        }
        let problem = socketProblem
        return ManagedNeovims(
            panes: TmuxEditorPanes(runtime: runtime),
            nvim: {
                if let problem { throw ManagedNeovimError(problem) }
                let resolved = await machine.resolveProgram("nvim", searchPath: launchPath())
                guard let path = resolved.path else {
                    throw ManagedNeovimError(
                        Runtimes.executableMissingMessage(resolved, loginFailure: loginFailure()) ?? "DevHub could not find 'nvim'.")
                }
                return path
            },
            socketDirectory: socketDirectory,
            onExit: { workspaceId in log("[devhub] the managed Neovim of \(workspaceId) ended") }
        )
    }
}

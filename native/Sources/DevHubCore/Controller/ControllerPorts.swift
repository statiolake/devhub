// What the app controller (`AppController`, the Core half of
// apps/desktop/src/main/shell/appController.ts) drives, as protocols: the
// Agent runtime (`AgentAdapter` in main/shell/adapters.ts), the terminal
// runtime (`TerminalAdapter` and the Agent-terminal calls the controller makes
// on a machine's tmux), the repository facts, and the window (`AppShell`,
// WP9's AppKit side).
//
// Each port is the controller's whole view of its service, so the controller
// is tested here with fakes and wired in the app to WP3's
// `TerminalAgentWiring` / `TerminalRuntimes` (`TerminalAgentPort`,
// `TmuxTerminalPort`) and WP4's repository status.

import Foundation

/// The Agent runtime: terminal Agents (WP3) and GUI Agents (WP5/WP6) behind
/// one face, as `wireAgents` hands them to the controller.
public protocol AgentPort: Sendable {
    /// Start an Agent. A failure is a `failed` result, never a throw.
    func launch(
        workspaceId: WorkspaceId, agentId: AgentId, profile: AgentProfile, presentation: AgentPresentation, root: String
    ) async -> AgentLaunchResult
    func stop(_ agentId: AgentId) async -> AgentStopResult
    func terminate(_ agentId: AgentId) async -> AgentStopResult
    /// A terminal Agent's CLI started again in its own pane, on its session.
    func restartTerminal(_ agentId: AgentId) async throws
    /// A GUI Agent's CLI started again on its session; done once it is ready.
    func restartConversation(_ agentId: AgentId) async throws
    /// One round on one machine, or about one Agent on it.
    func reconcile(machine: String, agentId: AgentId?) async throws -> AgentReconciliation
    /// Stop every Agent of a Workspace; "already gone" is success.
    func closeWorkspaceAgents(_ workspaceId: WorkspaceId) async throws
    /// Queue words for an Agent, sent once it is idle. Answers the injection's id.
    func queueInjection(_ agentId: AgentId, text: String, review: Bool) throws -> String
    /// A GUI Agent's conversation as `devhub --tell` reaches into it.
    func conversation(_ agentId: AgentId) async throws -> (any TellConversation)?
}

/// A Workspace as the terminal runtime is asked about it.
public struct TerminalWorkspacePlace: Equatable, Sendable {
    public var machine: RuntimeId
    public var workspaceId: String
    public var root: String

    public init(machine: RuntimeId, workspaceId: String, root: String) {
        self.machine = machine
        self.workspaceId = workspaceId
        self.root = root
    }

    public var target: WorkspaceTerminalTarget {
        WorkspaceTerminalTarget(machine: machine, workspaceId: workspaceId, root: root)
    }
}

/// The terminal runtime: a Workspace's terminals and each Agent's own terminal.
public protocol TerminalPort: Sendable {
    /// What closing the Workspace would destroy in its terminals.
    func inspect(_ place: TerminalWorkspacePlace) async -> TerminalInspection
    /// Close the Workspace's terminal sessions; "already gone" is success.
    func closeWorkspaceTerminals(_ place: TerminalWorkspacePlace) async throws
    /// Why the machine has no usable tmux, or nil when it has one.
    func unavailableReason(_ machine: RuntimeId) async throws -> String?
    /// The tmux DevHub runs on the machine.
    func tmuxPath(_ machine: RuntimeId) async throws -> String
    func paneTerminals(_ machine: RuntimeId) async throws -> [PaneTerminalPane]
    func workspacePanes(_ machine: RuntimeId) async throws -> [WorkspacePane]
    func launchTerminal(_ target: PaneTerminalTarget) async throws
    func typeIntoTerminal(_ target: PaneTerminalTarget, text: String) async throws
    /// Its clients, its session (`surfaces.closePaneTerminal`).
    func closePaneTerminal(_ target: PaneTerminalTarget) async throws
    /// Kill the session only (an Agent terminal this call could not hand over).
    func closeTerminal(_ target: PaneTerminalTarget) async throws
    func joinIntoTerminal(_ target: PaneTerminalTarget, paneId: String, replace: Bool) async throws
    func moveTerminalToWorkspace(_ target: PaneTerminalTarget) async throws
    /// The command line a terminal attaches to a target with.
    func profile(_ target: TerminalTarget) async throws -> TerminalProfileAnswer
}

/// The worktree disposal a close may end with (WP4's `WorktreeFolders.dispose`
/// through the Workspace's machine's git).
public protocol RepositoryPort: Sendable {
    /// `disposeWorktree`: remove the worktree folder the Workspace sits in.
    /// `repository` is the last status round's facts about it; the folder's
    /// own claim is read by the port. `force` only for `remove-anyway`.
    func disposeWorktree(location: WorkspaceLocation, root: String, repository: WorkspaceRepositoryWire?, force: Bool) async throws
    /// `ensureWorktree`: the worktree folder for an Issue's branch, made when
    /// it is not there. Answers its path.
    func ensureWorktree(location: WorkspaceLocation, mainWorktree: String, issue: Int, branch: String) async throws -> String
}

/// The machines a Workspace can be on, as the controller asks them things.
public protocol MachinePort: Sendable {
    /// The filesystem of a machine (`runtimeById(machine)`); throws for one
    /// DevHub cannot reach.
    func paths(_ machine: RuntimeId) throws -> any MachinePaths
    /// Where a machine is, for a sentence: "" here, " on <host>" there.
    func whereText(_ machine: RuntimeId) -> String
    /// A profile's program looked up on the machine (`resolveProgram`).
    func resolveProgram(_ machine: RuntimeId, _ command: String, searchPath: String) async throws -> ProgramResolution
}

/// `MachinePort` over WP3's runtimes (`MachineRuntimes.runtime(for:)`).
public struct RuntimeMachines: MachinePort {
    private let runtime: @Sendable (RuntimeId) throws -> any MachineRuntime

    public init(runtime: @escaping @Sendable (RuntimeId) throws -> any MachineRuntime = { try MachineRuntimes.runtime(for: $0) }) {
        self.runtime = runtime
    }

    public func paths(_ machine: RuntimeId) throws -> any MachinePaths { RuntimeMachinePaths(try runtime(machine)) }
    public func whereText(_ machine: RuntimeId) -> String { (try? runtime(machine))?.where ?? (machine.isLocal ? "" : " on \(machine.rawValue.dropFirst(4))") }
    public func resolveProgram(_ machine: RuntimeId, _ command: String, searchPath: String) async throws -> ProgramResolution {
        await (try runtime(machine)).resolveProgram(command, searchPath: searchPath)
    }
}

/// The window: everything the controller asks of the AppKit side (WP9).
/// Called on whatever executor the controller runs on; an implementation
/// hops to the main actor itself.
public protocol AppShell: Sendable {
    /// The newest projection, for the views.
    func publishSnapshot(_ snapshot: AppSnapshotWire) async
    /// An app-wide failure, drawn once.
    func publishError(_ error: AppError) async
    /// An app condition went up (`summary`) or came down (nil).
    func publishCondition(source: String, summary: String?, reason: String) async
    /// `ShellWindow.raise`: DevHub in front.
    func bringToFront() async
    /// The keyboard to whatever the selection has on screen.
    func placeKeyboardOnSurface() async
    /// A notification from `devhub --tell notify`.
    func notify(_ text: String) async throws
    /// Run a palette command the way the palette does.
    func runCommand(_ id: CommandId) async -> Bool
    /// The app is to quit (`detach`).
    func quit() async
}

/// An `AppShell` that does nothing: the controller with no window (tests,
/// and the moment before the window exists).
public struct HeadlessShell: AppShell {
    public init() {}
    public func publishSnapshot(_ snapshot: AppSnapshotWire) async {}
    public func publishError(_ error: AppError) async {}
    public func publishCondition(source: String, summary: String?, reason: String) async {}
    public func bringToFront() async {}
    public func placeKeyboardOnSurface() async {}
    public func notify(_ text: String) async throws {}
    public func runCommand(_ id: CommandId) async -> Bool { false }
    public func quit() async {}
}

/// The filesystem of a machine, as the controller resolves a path on it.
public protocol MachinePaths: PathMachine {
    func home() async throws -> String
    func realpath(_ path: String) async throws -> String
    func isDirectory(_ path: String) async throws -> Bool
}

/// A `MachineRuntime`'s filesystem as `MachinePaths` (and as `PathMachine`).
public struct RuntimeMachinePaths: MachinePaths {
    public let runtime: any MachineRuntime
    public init(_ runtime: any MachineRuntime) { self.runtime = runtime }
    public func home() async throws -> String { try await runtime.home() }
    public func realpath(_ path: String) async throws -> String { try await runtime.realpath(path) }
    public func isDirectory(_ path: String) async throws -> Bool { try await runtime.stat(path) == .directory }
    public func stat(_ path: String) async throws -> PathMachineKind {
        switch try await runtime.stat(path) {
        case .directory: return .directory
        case .file: return .file
        case .absent: return .absent
        }
    }
}

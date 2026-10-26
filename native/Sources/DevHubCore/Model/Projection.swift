// Port of the projection half of apps/desktop/src/model/wire.ts
// (`snapshotWire`, `drawnWorkspaceOrder`, `outcomeWire`, `replayWire`,
// `agentProfilesWire`, `intentFromWire`) and of the snapshot wire types and
// helpers of apps/desktop/src/ipc/appShell.ts (`AppSnapshotWire`,
// `WorkspaceWire`, `AgentWire`, `sidebarWorkspaces`, `workspaceForContext`,
// `contextKey`, `clampSidebarWidth`, `clampSplitRatio`).
//
// The projection seam: model values in, what the UI draws out. The native app
// has no process boundary to cross, so the "wire" is plain Swift values — but
// it is still the one place the Workspaces are put in the order the Sidebar
// draws them, the one place a row learns its group, its home-abbreviated root
// and its editor attachment's label, so every reader (the Sidebar, the chords,
// the palette, the window layout) reads the same list.

import Foundation

public struct AgentTerminalWire: Hashable, Sendable {
    /// What its session is named by (`tm-<id>`).
    public var id: String
    /// Its tmux session.
    public var session: String
    /// Shown when its Agent is the view's; hidden is still running.
    public var open: Bool
}

public struct AgentWire: Equatable, Sendable {
    public var controlState: AgentControlState
    public var failure: AgentFailure?
    public var displayName: String
    public var id: String
    public var ordinal: Int
    public var profileId: String
    public var profileKind: AgentProfileKind
    public var presentation: AgentPresentation
    public var runtimeHealth: AgentRuntimeHealth
    public var status: AgentStatus
    public var unread: AgentStatus?
    public var activity: String?
    public var promptCache: PromptCache?
    public var injection: AgentInjection
    public var automaticActions: [String]
    public var workspaceId: String
    public var terminal: AgentTerminalWire?
    /// Absent when the default.
    public var terminalShare: Double?
    public var terminalStackedShare: Double?
}

public enum WorkspaceLocationWire: Hashable, Sendable {
    case local
    case ssh(host: String)
}

public struct WorkspaceWire: Equatable, Sendable {
    public var agents: [AgentWire]
    public var canCreateAgent: Bool
    public var id: String
    public var label: String
    public var location: WorkspaceLocationWire
    public var editor: EditorAttachmentWire
    public var root: String
    /// The same folder, written the way a person writes it: `~/projects/widget`.
    public var displayRoot: String
    public var key: String
    /// The rows this one is grouped with.
    public var groupKey: String
    public var selectedPath: String
    public var state: WorkspaceState
    public var close: WorkspaceClose
    public var lastAgentId: String?
    /// Absent when idle and read.
    public var terminals: TerminalActivity?
}

extension WorkspaceWire: OrderableWorkspace {
    public var orderId: String { id }
    public var orderLabel: String { label }
    public var orderKey: String { key }
}

/// `LayoutWire`: the content area, by surface key names.
public enum LayoutWire: Hashable, Sendable {
    case workbench(editorKey: String)
    case agent(agentKey: String)
    case split(editorKey: String, agentKey: String)
    case unavailable
}

public enum ContextWire: Hashable, Sendable {
    case workspace(String)
    case agent(String)

    /// `contextKey`.
    public var key: String {
        switch self {
        case let .workspace(id): return "workspace:\(id)"
        case let .agent(id): return "agent:\(id)"
        }
    }

    public var workspaceId: String? { if case let .workspace(id) = self { return id } else { return nil } }
    public var agentId: String? { if case let .agent(id) = self { return id } else { return nil } }
}

public struct SelectionWire: Hashable, Sendable {
    public var context: ContextWire
    public var presentation: SurfacePresentation
}

public struct AppSnapshotWire: Equatable, Sendable {
    public static let schemaVersion = 1

    public var editorHost: EditorHostState
    public var layout: LayoutWire
    public var readiness: AppReadiness
    public var revision: Int
    public var selection: SelectionWire
    public var scratchWorkspaceId: String
    public var sidebar: SidebarSnapshot
    public var splitRatio: Double
    public var visibleTerminal: String?
    public var paneFocus: String?
    public var smartButtons: SmartButtonsPlacement
    public var terminalZoomOffset: Int
    /// In the order the Sidebar draws them.
    public var workspaces: [WorkspaceWire]
    public var history: HistoryAvailability?

    /// `workspaceById`.
    public func workspace(_ id: String) -> WorkspaceWire? { workspaces.first { $0.id == id } }

    /// `workspaceForContext`.
    public func workspace(for context: ContextWire) -> WorkspaceWire? {
        switch context {
        case let .workspace(id): return workspace(id)
        case let .agent(id): return workspaces.first { $0.agents.contains { $0.id == id } }
        }
    }

    /// `sidebarWorkspaces`: Scratch, and every other Workspace in order. A
    /// snapshot whose Scratch is not among its Workspaces is a broken
    /// snapshot, and it throws.
    public func sidebarWorkspaces() throws -> (scratch: WorkspaceWire, rows: [WorkspaceWire]) {
        guard let scratch = workspaces.first(where: { $0.id == scratchWorkspaceId }) else {
            throw InvariantViolation("Scratch \(scratchWorkspaceId) is not one of the snapshot's workspaces")
        }
        return (scratch, workspaces.filter { $0.id != scratchWorkspaceId })
    }

    /// Scratch, then the workspaces in sidebar order.
    public func orderedWorkspaces() throws -> [WorkspaceWire] {
        let (scratch, rows) = try sidebarWorkspaces()
        return [scratch] + rows
    }
}

public enum Projection {
    /// `RepositoryOf`: which repository a workspace is a checkout of, as its
    /// main worktree's path (git's answer, nil when unknown).
    public typealias RepositoryOf = (String) -> String?
    /// `HomeOf`: the home directory of the machine a location is on.
    public typealias HomeOf = (WorkspaceLocation) -> String?

    /// The Workspaces in the order the Sidebar draws them.
    static func drawnWorkspaces(_ snapshot: AppSnapshot, _ repositoryOf: RepositoryOf) -> [WorkspaceSnapshot] {
        WorkspaceOrder.order(
            snapshot.workspaces, mainWorktreeOf: { repositoryOf($0.id.rawValue) },
            explicit: snapshot.workspaceOrder.map(\.rawValue)
        )
    }

    /// `drawnWorkspaceOrder`: Scratch, then the rows as drawn — what the model
    /// is told when it repairs the selection after a Workspace's removal.
    public static func drawnWorkspaceOrder(_ snapshot: AppSnapshot, _ repositoryOf: RepositoryOf) -> [WorkspaceId] {
        let drawn = drawnWorkspaces(snapshot, repositoryOf)
        guard let scratch = drawn.first(where: { $0.id == snapshot.scratchWorkspaceId }) else { return drawn.map(\.id) }
        return [scratch.id] + drawn.filter { $0.id != scratch.id }.map(\.id)
    }

    static func layoutWire(_ layout: SurfaceLayout) -> LayoutWire {
        switch layout {
        case let .workbench(editor): return .workbench(editorKey: editor.name)
        case let .agent(agent): return .agent(agentKey: agent.name)
        case let .split(editor, agent): return .split(editorKey: editor.name, agentKey: agent.name)
        case .unavailable: return .unavailable
        }
    }

    static func contextWire(_ context: NavigationContext) -> ContextWire {
        switch context {
        case let .workspace(id): return .workspace(id.rawValue)
        case let .agent(id): return .agent(id.rawValue)
        }
    }

    static func editorAttachmentWire(root: String, _ editor: EditorAttachment) -> EditorAttachmentWire {
        switch editor {
        case .host: return .host
        case let .devContainer(configPath): return .devContainer(label: DevContainerConfig.label(folder: root, configPath: configPath))
        }
    }

    static func agentWire(_ agent: AgentSnapshot) -> AgentWire {
        AgentWire(
            controlState: agent.controlState, failure: agent.failure, displayName: agent.displayName, id: agent.id.rawValue,
            ordinal: agent.ordinal, profileId: agent.profileId, profileKind: agent.profileKind, presentation: agent.presentation,
            runtimeHealth: agent.runtimeHealth, status: agent.status, unread: agent.unread, activity: agent.activity,
            promptCache: agent.promptCache, injection: agent.injection, automaticActions: agent.automaticActions,
            workspaceId: agent.workspaceId.rawValue,
            terminal: agent.terminal.map {
                AgentTerminalWire(id: $0.terminalId, session: AgentTerminals.sessionName($0.terminalId), open: $0.open)
            },
            terminalShare: agent.terminalShare == AgentTerminals.defaultShare ? nil : agent.terminalShare,
            terminalStackedShare: agent.terminalStackedShare == AgentTerminals.defaultShare ? nil : agent.terminalStackedShare
        )
    }

    /// `snapshotWire`.
    public static func snapshotWire(
        _ snapshot: AppSnapshot, readiness: AppReadiness, repositoryOf: RepositoryOf, homeOf: HomeOf
    ) throws -> AppSnapshotWire {
        if snapshot.revision > AppModel.maxSafeInteger { throw InvariantViolation("snapshot revision is outside the safe range") }
        let workspaces = drawnWorkspaces(snapshot, repositoryOf).map { workspace in
            WorkspaceWire(
                agents: workspace.agents.map(agentWire),
                canCreateAgent: workspace.canCreateAgent,
                id: workspace.id.rawValue,
                label: workspace.label,
                location: { if case let .ssh(host, _) = workspace.location { return .ssh(host: host) } else { return .local } }(),
                editor: editorAttachmentWire(root: workspace.root, workspace.editor),
                root: workspace.root,
                displayRoot: DomainPaths.abbreviateHome(workspace.root, home: homeOf(workspace.location)),
                key: workspace.key,
                groupKey: WorkspaceOrder.groupKey(workspace.key, mainWorktree: repositoryOf(workspace.id.rawValue)),
                selectedPath: workspace.selectedPath,
                state: workspace.state,
                close: workspace.close,
                lastAgentId: workspace.lastAgentId?.rawValue,
                terminals: workspace.terminals == .idle ? nil : workspace.terminals
            )
        }
        let wire = AppSnapshotWire(
            editorHost: snapshot.editorHost, layout: layoutWire(snapshot.layout), readiness: readiness,
            revision: snapshot.revision,
            selection: SelectionWire(context: contextWire(snapshot.selection.context), presentation: snapshot.selection.presentation),
            scratchWorkspaceId: snapshot.scratchWorkspaceId.rawValue, sidebar: snapshot.sidebar, splitRatio: snapshot.splitRatio,
            visibleTerminal: snapshot.visibleTerminal?.terminalId, paneFocus: snapshot.paneFocus,
            smartButtons: snapshot.smartButtons, terminalZoomOffset: snapshot.terminalZoomOffset, workspaces: workspaces,
            history: snapshot.history
        )
        if wire.sidebar.width < AppModel.sidebarMinWidth || wire.sidebar.width > AppModel.sidebarMaxWidth {
            throw InvariantViolation("sidebar width is outside the App Shell range")
        }
        return wire
    }

    /// `clampSidebarWidth`: keep pointer updates bounded before they cross the
    /// intent seam.
    public static func clampSidebarWidth(_ width: Double) -> Double {
        max(AppModel.sidebarMinWidth, min(AppModel.sidebarMaxWidth, jsRoundDouble(width)))
    }

    /// `clampSplitRatio`: rounded to whole percent.
    public static func clampSplitRatio(_ ratio: Double) -> Double {
        max(AppModel.splitMinRatio, min(AppModel.splitMaxRatio, jsRoundDouble(ratio * 100) / 100))
    }
}

/// `AgentProfileWire`.
public struct AgentProfileWire: Hashable, Sendable {
    public var displayName: String
    public var id: String
    public var kind: AgentProfileKind
    public var presentation: AgentPresentation
    public var presentations: [AgentPresentation]

    /// `agentProfilesWire`'s projection of one profile.
    public init(_ profile: AgentProfile) {
        displayName = profile.displayName
        id = profile.id
        kind = profile.kind
        presentation = profile.presentation
        presentations = profile.kind.presentations
    }
}

// MARK: - intentFromWire

/// What a view can send, before it is validated (`AppIntentWire`). The
/// native views raise these with plain strings — ids off the projection, a
/// width off a drag — and `UserIntent.fromWire` validates them once, before
/// they reach the coordinator.
public enum AppIntentWire: Equatable, Sendable {
    case selectContext(ContextWire, split: Bool = false)
    case resizeSidebar(width: Double)
    case toggleSidebar
    case navigateHistory(NavigationDirection)
    case reorderWorkspaces([String])
    case reorderAgents(workspaceId: String, order: [String])
    case resizeSplit(ratio: Double)
    case resizeAgentTerminal(agentId: String, share: Double, stacked: Bool = false)
    case placeSmartButtons(presentation: String, spot: SmartButtonsSpot?)
    case openWorkspacePicker
    case requestCreateAgent(workspaceId: String, profileId: String, split: Bool = false, presentation: String? = nil, resume: String? = nil)
    case renameAgent(agentId: String, displayName: String)
    case setAutomaticAction(agentId: String, actionId: String, automatic: Bool)
    case stopAgent(agentId: String)
    case confirmStopAgent(confirmationId: String, moveTerminal: Bool = false)
    case confirmContinueAgent(confirmationId: String)
    case restartAgent(agentId: String)
    case confirmRestartAgent(confirmationId: String)
    case retryStopAgent(agentId: String)
    case markAgentUnread(agentId: String)
    case reconcileAgent(agentId: String)
    case retryWorkspace(workspaceId: String)
    case locateWorkspace(workspaceId: String, path: String)
    case confirmCloseWorkspace(confirmationId: String)
}

extension UserIntent {
    /// `intentFromWire`: decode one wire intent into a domain command, or
    /// refuse it as `invalid_intent`.
    public static func fromWire(_ wire: AppIntentWire) throws -> UserIntent {
        func parse<T>(_ work: () throws -> T) throws -> T {
            do { return try work() } catch is DomainError { throw NamedFailure.invalidIntent }
        }
        func presentationFrom(_ split: Bool) -> SurfacePresentation { split ? .beside : .full }
        switch wire {
        case let .selectContext(context, split):
            switch context {
            case let .workspace(id): return .selectContext(.workspace(try parse { try WorkspaceId(id) }), presentation: presentationFrom(split))
            case let .agent(id): return .selectContext(.agent(try parse { try AgentId(id) }), presentation: presentationFrom(split))
            }
        case let .resizeSplit(ratio):
            guard ratio.isFinite, ratio >= AppModel.splitMinRatio, ratio <= AppModel.splitMaxRatio else { throw NamedFailure.invalidIntent }
            return .resizeSplit(ratio: ratio)
        case let .placeSmartButtons(presentation, spot):
            if let spot, !SmartButtons.isSpot(spot) { throw NamedFailure.invalidIntent }
            return .placeSmartButtons(try parse { try AgentPresentation.parse(presentation) }, spot)
        case let .resizeAgentTerminal(agentId, share, stacked):
            guard AgentTerminals.isShare(share) else { throw NamedFailure.invalidIntent }
            return .resizeAgentTerminal(try parse { try AgentId(agentId) }, share: share, stacked: stacked)
        case let .resizeSidebar(width):
            guard width.rounded() == width, width >= AppModel.sidebarMinWidth, width <= AppModel.sidebarMaxWidth else {
                throw NamedFailure.invalidIntent
            }
            return .resizeSidebar(width: width)
        case .toggleSidebar: return .toggleSidebar
        case let .navigateHistory(direction): return .navigateHistory(direction)
        case let .reorderWorkspaces(order): return .reorderWorkspaces(try order.map { id in try parse { try WorkspaceId(id) } })
        case let .reorderAgents(workspaceId, order):
            return .reorderAgents(try parse { try WorkspaceId(workspaceId) }, try order.map { id in try parse { try AgentId(id) } })
        case .openWorkspacePicker:
            // The picker is a shell-side dialog; it never reaches the model.
            throw NamedFailure.invalidIntent
        case let .retryWorkspace(id): return .retryWorkspace(try parse { try WorkspaceId(id) })
        case let .locateWorkspace(id, path):
            return .locateWorkspace(try parse { try WorkspaceId(id) }, path: try parse { try RequestedPaths.requestedPath(path) })
        case let .confirmCloseWorkspace(id): return .confirmCloseWorkspace(try parse { try ConfirmationId(id) })
        case let .requestCreateAgent(workspaceId, profileId, split, presentation, resume):
            return .createAgent(
                workspaceId: try parse { try WorkspaceId(workspaceId) },
                profileId: try parse { try DomainIds.agentProfileId(profileId) },
                presentation: presentationFrom(split),
                agentPresentation: try presentation.map { value in try parse { try AgentPresentation.parse(value) } },
                resume: try resume.map { value in try parse { try DomainIds.sessionId(value) } }
            )
        case let .renameAgent(agentId, displayName):
            if displayName.jsTrimmed.isEmpty || displayName.contains("\0") || displayName.unicodeScalars.count > 256 {
                throw NamedFailure.invalidIntent
            }
            return .renameAgent(try parse { try AgentId(agentId) }, displayName: displayName)
        case let .setAutomaticAction(agentId, actionId, automatic):
            if actionId.isEmpty || actionId.utf16.count > 256 { throw NamedFailure.invalidIntent }
            return .setAutomaticAction(try parse { try AgentId(agentId) }, actionId: actionId, automatic: automatic)
        case let .stopAgent(id): return .stopAgent(try parse { try AgentId(id) })
        case let .confirmStopAgent(id, moveTerminal):
            return .confirmStopAgent(try parse { try ConfirmationId(id) }, moveTerminal: moveTerminal)
        case let .confirmContinueAgent(id): return .confirmContinueAgent(try parse { try ConfirmationId(id) })
        case let .restartAgent(id): return .restartAgent(try parse { try AgentId(id) })
        case let .confirmRestartAgent(id): return .confirmRestartAgent(try parse { try ConfirmationId(id) })
        case let .retryStopAgent(id): return .retryStopAgent(try parse { try AgentId(id) })
        case let .markAgentUnread(id): return .markAgentUnread(try parse { try AgentId(id) })
        case let .reconcileAgent(id): return .reconcileAgent(try parse { try AgentId(id) })
        }
    }
}

// Port of apps/desktop/src/model/coordinator.ts
//
// The application coordinator: the only place domain transitions are combined
// with adapter-facing operations.
//
// A port of `crates/devhub-app-core/src/application/coordinator.rs`. Three
// properties are the reason this is a state machine and not a pile of async
// functions:
//
// - **Nothing here performs an effect.** It emits one, tagged with a token,
//   and waits for a completion carrying that exact token. A stale answer to a
//   superseded operation is rejected rather than applied to whatever is current.
// - **A dispatch is idempotent by identity.** The same `IntentId` replays the
//   cached result; a different intent under a used id is a duplicate, not a
//   silent overwrite.
// - **Every emitted event is sequenced and retained**, so a reader that missed
//   a window of them replays from its cursor and is told when the gap is real.
//
// A value type, like the model it holds: `dispatchUser` and
// `acceptProviderEvent` are `mutating`, and the effects to carry out are read
// off the event log (`drainEffects`). The App's controller holds one inside an
// actor.

import Foundation

/// What the coordinator asks an adapter to do. It never does it itself.
public enum Effect: Equatable, Sendable {
    case noop
    case detach(DetachReason)
    /// The place as it was asked for, machine and all: resolved on its own machine.
    case resolveWorkspacePath(OperationToken, location: RequestedWorkspaceLocation)
    case generateWorkspaceId(OperationToken, location: WorkspaceLocation, selectedPath: String)
    /// `extraArgs` are appended to the resolved profile's arguments, for this
    /// Agent only; `resume` is the session this Agent resumes, if any.
    case resolveAgentProfile(OperationToken, workspaceId: WorkspaceId, profileId: String, extraArgs: [String], resume: String?)
    case generateConfirmationId(OperationToken, purpose: ConfirmationPurpose)
    case generateAgentId(OperationToken, workspaceId: WorkspaceId)
    case launchAgent(OperationToken, workspaceId: WorkspaceId, agentId: AgentId, profile: AgentProfile, agentPresentation: AgentPresentation)
    case inspectWorkspace(OperationToken, workspaceId: WorkspaceId)
    /// `moveTerminal`: hand its terminal to the Workspace's editor terminal first.
    case stopAgent(OperationToken, agentId: AgentId, moveTerminal: Bool)
    case terminateAgent(OperationToken, agentId: AgentId)
    /// Start an Agent's CLI again on its session.
    case restartAgent(OperationToken, agentId: AgentId)
    /// One round, one tmux server.
    case reconcileAgents(OperationToken, machine: String)
    case reconcileAgent(OperationToken, agentId: AgentId)
    case closeWorkspace(OperationToken, workspaceId: WorkspaceId, worktree: WorktreeDisposition)
    case persistState(OperationToken)
}

public enum CoordinatorEvent: Equatable, Sendable {
    case snapshot(AppSnapshot)
    case effect(Effect)
    case noop
    case error(NamedFailure)
    case operationCompleted(OperationToken)
}

public struct SequencedCoordinatorEvent: Equatable, Sendable {
    public var sequence: Int
    public var event: CoordinatorEvent
}

public struct CoordinatorSubscription: Equatable, Sendable {
    public var cursor: Int
    public var events: [SequencedCoordinatorEvent]
    public var historyGap: Bool
    public var snapshot: AppSnapshot
}

/// The Workspaces in the order the Sidebar draws them, Scratch first.
public typealias DrawnOrder = @Sendable (AppSnapshot) -> [WorkspaceId]

public struct AppCoordinator: Sendable {
    public static let maxIntentLedgerEntries = 1024
    public static let maxProviderLedgerEntries = 1024
    public static let maxConfirmationIdEntries = 1024
    public static let maxCompletedTokenEntries = 1024
    public static let maxRetainedEvents = 4096

    private enum OperationKind: Equatable, Sendable {
        case resolveWorkspacePath, generateWorkspaceId, resolveAgentProfile, generateConfirmationId, generateAgentId
        case launchAgent, inspectWorkspace, stopAgent, restartAgent, reconcileAgent, reconcileAgents, terminateAgent
        case persistState, closeWorkspace
    }

    private enum OperationTarget: Equatable, Sendable {
        case location(RequestedWorkspaceLocation)
        case workspacePath(WorkspaceId)
        case resolvedLocation(WorkspaceLocation, selectedPath: String)
        case workspace(WorkspaceId)
        case agent(AgentId)
        case agentLaunch(WorkspaceId, AgentId)
        case profile(WorkspaceId, profileId: String)
        case application
    }

    private struct PendingOperation: Sendable {
        var token: OperationToken
        var kind: OperationKind
        var target: OperationTarget
    }

    private struct CachedDispatch: Sendable {
        var operationId: OperationId?
        var intent: UserIntent?
        var event: ProviderEvent?
        var outcome: IntentOutcome?
        var error: Error?
    }

    /// What an Agent is asked about before it is done to it.
    private enum AgentAct: Equatable, Sendable {
        /// `terminal`: it has one open, which the question offers to keep.
        case stop(terminal: Bool)
        case `continue`(presentation: AgentPresentation, session: String?)
        case restart

        var name: String {
            switch self {
            case .stop: return "stop"
            case .continue: return "continue"
            case .restart: return "restart"
            }
        }

        func purpose(_ agentId: AgentId) -> ConfirmationPurpose {
            switch self {
            case .stop: return .stopAgent(agentId)
            case .continue: return .continueAgent(agentId)
            case .restart: return .restartAgent(agentId)
            }
        }

        func confirmation(_ agentId: AgentId) -> ConfirmationOutcomePurpose {
            switch self {
            case let .stop(terminal): return .agentStop(agentId, terminal: terminal)
            case let .continue(presentation, _): return .agentContinue(agentId, presentation: presentation)
            case .restart: return .agentRestart(agentId)
            }
        }
    }

    private enum PendingConfirmationRequest: Equatable, Sendable {
        case agent(AgentId, act: AgentAct)
        case workspaceClose(WorkspaceId, worktree: WorktreeDisposition, inspection: CloseInspectionProjection)
    }

    private struct PendingConfirmationState: Equatable, Sendable {
        var request: PendingConfirmationRequest
        var confirmationId: ConfirmationId
    }

    /// One reconcile that has been asked for and has not answered yet, one per scope.
    private enum ActiveReconcile: Equatable, Sendable {
        case agents(OperationToken, machine: String)
        case agent(OperationToken, AgentId)

        var token: OperationToken {
            switch self {
            case let .agents(token, _), let .agent(token, _): return token
            }
        }

        var scope: String {
            switch self {
            case let .agents(_, machine): return "agents:\(machine)"
            case let .agent(_, agentId): return "agent:\(agentId.rawValue)"
            }
        }
    }

    /// A close that has been asked for and is still asking its questions.
    private struct CloseRequest: Equatable, Sendable {
        var workspaceId: WorkspaceId
        var worktree: WorktreeDisposition
    }

    private struct ResolvedProfile: Sendable {
        var workspaceId: WorkspaceId
        var profile: AgentProfile
        var presentation: SurfacePresentation
        var agentPresentation: AgentPresentation
    }

    private struct LaunchProfile: Sendable {
        var workspaceId: WorkspaceId
        var agentId: AgentId
        var profile: AgentProfile
        var presentation: SurfacePresentation
        var agentPresentation: AgentPresentation
    }

    public private(set) var model: AppModel
    private let drawnOrder: DrawnOrder
    public private(set) var events: [SequencedCoordinatorEvent] = []
    private var nextSequence = 0
    private var subscriberCursor = 0
    private var intentCache: [IntentId: CachedDispatch] = [:]
    private var intentOrder: [IntentId] = []
    private var providerEventCache: [ProviderEventId: CachedDispatch] = [:]
    private var providerEventOrder: [ProviderEventId] = []
    private var confirmationIds = Set<ConfirmationId>()
    private var confirmationIdOrder: [ConfirmationId] = []
    private var pending: [OperationId: PendingOperation] = [:]
    private var pendingOrder: [OperationId] = []
    private var completedTokens: [OperationId: OperationToken] = [:]
    private var completedTokenOrder: [(OperationId, OperationToken)] = []
    private var resolvedLocations: [OperationId: (location: WorkspaceLocation, selectedPath: String)] = [:]
    private var resolvedProfiles: [OperationId: ResolvedProfile] = [:]
    /// The Agent each continue launch replaces, by operation.
    private var replacedByLaunch: [OperationId: AgentId] = [:]
    /// The same, once its launch is running: stopped when that launch's save is over.
    private var stopAfterPersist: [OperationId: AgentId] = [:]
    private var launchProfiles: [OperationId: LaunchProfile] = [:]
    private var requestedPresentations: [OperationId: (presentation: SurfacePresentation, agentPresentation: AgentPresentation?)] = [:]
    private var closeRequests: [OperationId: CloseRequest] = [:]
    private var confirmationRequests: [OperationId: PendingConfirmationRequest] = [:]
    private var confirmations: [PendingConfirmationState] = []
    private var finalizationPending = Set<OperationId>()
    private var finalizationWorkspaces: [OperationId: WorkspaceId] = [:]
    /// Keyed by `locationKey`: a close in flight holds *that place* against a
    /// second opening.
    private var finalizationRoots: [String: OperationId] = [:]
    private var finalizationBackups: [OperationId: WorkspaceCloseRollback] = [:]
    private var nextGeneration = 0
    private var naturalExitStopTokens: [String: AgentId] = [:]
    private var naturalExitStopOrder: [String] = []
    private var activeReconciles: [String: ActiveReconcile] = [:]
    private var activeReconcileOrder: [String] = []
    public private(set) var readiness: AppReadiness = .starting
    private var detached: DetachReason?

    public init(model: AppModel, drawnOrder: @escaping DrawnOrder) {
        self.model = model
        self.drawnOrder = drawnOrder
        emit(.snapshot(model.snapshot()))
    }

    /// Whether a close of `workspaceId` is under way: being inspected, its
    /// question being made, or its steps running. A question already on
    /// screen is not this — it waits for the person, and is the picker's to
    /// know (`closeUnderway`).
    public func closeUnderway(_ workspaceId: WorkspaceId) -> Bool {
        if model.workspace(workspaceId)?.close.isRunning == true { return true }
        if closeRequests.values.contains(where: { $0.workspaceId == workspaceId }) { return true }
        return confirmationRequests.values.contains {
            if case let .workspaceClose(id, _, _) = $0 { return id == workspaceId }
            return false
        }
    }

    private func drawn() -> [WorkspaceId] { drawnOrder(model.snapshot()) }

    public func snapshot() -> AppSnapshot { model.snapshot() }

    public mutating func markReady() { readiness = .ready }

    public var isDetached: Bool { detached != nil }

    @discardableResult
    public mutating func setEditorHostState(_ state: EditorHostState) -> Bool {
        let changed = model.setEditorHostState(state)
        if changed { emit(.snapshot(snapshot())) }
        return changed
    }

    /// Change the model outside an intent — the controller's own observations
    /// (a launch's hydrate, a repository association). Emits the snapshot when
    /// anything moved.
    public mutating func withModel<T>(_ body: (inout AppModel) throws -> T) rethrows -> T {
        let before = model.revision
        let result = try body(&model)
        if model.revision != before { emit(.snapshot(snapshot())) }
        return result
    }

    public mutating func subscribe() -> CoordinatorSubscription {
        let subscription = subscribeFrom(subscriberCursor)
        subscriberCursor = nextSequence
        return subscription
    }

    public func subscribeFrom(_ cursor: Int) -> CoordinatorSubscription {
        CoordinatorSubscription(
            cursor: nextSequence,
            events: events.filter { $0.sequence > cursor },
            historyGap: !events.isEmpty && cursor + 1 < events[0].sequence,
            snapshot: snapshot()
        )
    }

    public func replayFrom(_ cursor: Int) -> CoordinatorSubscription { subscribeFrom(cursor) }

    /// The effects emitted after `cursor`, and the cursor to read from next.
    public func effects(after cursor: Int) -> (effects: [Effect], cursor: Int) {
        let effects = events.compactMap { event -> Effect? in
            guard event.sequence > cursor, case let .effect(effect) = event.event else { return nil }
            return effect
        }
        return (effects, nextSequence)
    }

    // MARK: - Dispatch

    public mutating func dispatchUser(_ envelope: IntentEnvelope) throws -> IntentOutcome {
        let id = envelope.intentId
        if let cached = intentCache[id] {
            if cached.operationId == envelope.operationId && cached.intent == envelope.intent {
                emit(.noop)
                return try replayCached(cached)
            }
            throw NamedFailure.invalidIntent
        }
        if detached != nil {
            let outcome = IntentOutcome.detached(snapshot())
            cacheIntent(id, envelope, outcome, nil)
            emit(.noop)
            return outcome
        }
        guard let operationId = envelope.operationId else {
            let error = NamedFailure.invalidIntent
            cacheIntent(id, envelope, nil, error)
            throw error
        }
        do {
            let outcome = try dispatchNewIntent(envelope.intent, operationId)
            cacheIntent(id, envelope, outcome, nil)
            return outcome
        } catch {
            // Thrown and not also emitted: whoever catches it decides where it is drawn.
            let refused = try Self.refusal(error)
            cacheIntent(id, envelope, nil, refused)
            throw refused
        }
    }

    public mutating func acceptProviderEvent(_ envelope: ProviderEventEnvelope) throws -> IntentOutcome {
        let id = envelope.eventId
        if let cached = providerEventCache[id] {
            if cached.event == envelope.event {
                emit(.noop)
                return try replayCached(cached)
            }
            throw NamedFailure.invalidIntent
        }
        do {
            let outcome = try applyProviderEvent(envelope.event)
            cacheProviderEvent(id, envelope.event, outcome, nil)
            return outcome
        } catch {
            let refused = try Self.refusal(error)
            cacheProviderEvent(id, envelope.event, nil, refused)
            throw refused
        }
    }

    /// What a refused request is thrown as: the refusal itself, or a
    /// `DomainError` its model threw in the words it is shown in. Anything
    /// else is not a refusal and is thrown on untouched.
    private static func refusal(_ raw: Error) throws -> Error {
        if raw is NamedFailure || raw is StaleCompletion { return raw }
        if let domain = raw as? DomainError { return NamedFailure.domain(domain.code) }
        throw raw
    }

    private func replayCached(_ cached: CachedDispatch) throws -> IntentOutcome {
        if let error = cached.error { throw error }
        guard let outcome = cached.outcome else {
            throw InvariantViolation("a cached dispatch has neither an outcome nor a refusal")
        }
        return outcome
    }

    private mutating func dispatchNewIntent(_ intent: UserIntent, _ id: OperationId) throws -> IntentOutcome {
        let beforeRevision = model.revision
        switch intent {
        case let .selectContext(context, presentation):
            try model.selectContext(context, presentation: presentation)
            return try transitionOutcome(beforeRevision, id)
        case .swapSplitFocus:
            try model.swapSplitFocus()
            return try transitionOutcome(beforeRevision, id)
        case let .navigateHistory(direction):
            try model.navigateHistory(direction)
            return try transitionOutcome(beforeRevision, id)
        case .toggleScratch:
            try model.toggleScratch()
            return try transitionOutcome(beforeRevision, id)
        case let .adoptScratchDay(workspaceId, location, selectedPath):
            try model.adoptScratchDay(Workspace(id: workspaceId, location: location, selectedPath: selectedPath))
            return try transitionOutcome(beforeRevision, id)
        case let .attachEditor(workspaceId, editor):
            try model.attachEditor(workspaceId, editor)
            return try transitionOutcome(beforeRevision, id)
        case let .editorContainerStarted(workspaceId, containerId):
            try model.noteEditorContainerStarted(workspaceId, containerId)
            return try transitionOutcome(beforeRevision, id)
        case let .resizeSplit(ratio):
            try model.setSplitRatio(ratio)
            return try transitionOutcome(beforeRevision, id)
        case let .placeSmartButtons(presentation, spot):
            try model.placeSmartButtons(presentation, spot)
            return try transitionOutcome(beforeRevision, id)
        case let .resizeSidebar(width):
            try model.setSidebarWidth(width)
            return try transitionOutcome(beforeRevision, id)
        case let .reorderWorkspaces(order):
            model.setWorkspaceOrder(order)
            return try transitionOutcome(beforeRevision, id)
        case let .reorderAgents(workspaceId, order):
            try model.setAgentOrder(workspaceId, order)
            return try transitionOutcome(beforeRevision, id)
        case .toggleSidebar:
            model.toggleSidebar()
            return try transitionOutcome(beforeRevision, id)
        case let .terminalZoom(direction, base):
            try model.zoomTerminal(base: base, direction: direction)
            return try transitionOutcome(beforeRevision, id)
        case let .openFolder(location):
            return try beginWorkspaceResolution(location, id)
        case let .newWindow(path):
            if let path { return try beginWorkspaceResolution(.local(path: path), id) }
            try model.selectContext(.workspace(model.scratchWorkspaceId))
            return try transitionOutcome(beforeRevision, id)
        case let .retryWorkspace(workspaceId):
            return try beginWorkspaceRetry(workspaceId, id)
        case let .workspaceRootUnreadable(workspaceId, reason):
            guard model.workspace(workspaceId) != nil else { throw NamedFailure.domain(.unknownWorkspace) }
            try model.markWorkspaceUnavailable(workspaceId, reason)
            return try transitionOutcome(beforeRevision, id)
        case let .locateWorkspace(workspaceId, path):
            return try beginWorkspaceRelocation(workspaceId, path, id)
        case let .createAgent(workspaceId, profileId, extraArgs, presentation, agentPresentation, resume):
            return try beginProfileResolution(workspaceId, profileId, extraArgs, presentation, agentPresentation, resume, id)
        case let .continueAgent(agentId, presentation, session):
            // Refused before anything is asked.
            _ = try continuable(agentId, presentation)
            return try askAbout(agentId, .continue(presentation: presentation, session: session), id)
        case let .confirmContinueAgent(confirmation):
            return try confirmAgentAct(confirmation, "continue", id)
        case let .renameAgent(agentId, displayName):
            try model.renameAgent(agentId, displayName)
            return try transitionOutcome(beforeRevision, id)
        case let .setAutomaticAction(agentId, actionId, automatic):
            try model.setAgentAutomaticAction(agentId, actionId: actionId, automatic: automatic)
            return try transitionOutcome(beforeRevision, id)
        case let .stopAgent(agentId):
            return try askAbout(agentId, .stop(terminal: model.agentTerminal(agentId) != nil), id)
        case let .confirmStopAgent(confirmation, moveTerminal):
            return try confirmAgentAct(confirmation, "stop", id, moveTerminal: moveTerminal)
        case let .retryStopAgent(agentId):
            return try retryStop(agentId, id)
        case let .restartAgent(agentId):
            try restartable(agentId)
            return try askAbout(agentId, .restart, id)
        case let .confirmRestartAgent(confirmation):
            return try confirmAgentAct(confirmation, "restart", id)
        case let .markAgentUnread(agentId):
            try model.markAgentUnread(agentId)
            return try transitionOutcome(beforeRevision, id)
        case let .reconcileAgent(agentId):
            return try requestAgentReconcile(id, agentId)
        case let .reconcileAgents(machine):
            return try requestAgentsReconcile(id, machine)
        case let .requestCloseWorkspace(workspaceId, worktree):
            return try closeWorkspace(workspaceId, worktree, id)
        case let .confirmCloseWorkspace(confirmation):
            return try confirmWorkspaceClose(confirmation, id)
        case let .windowFocusChanged(focused):
            model.setWindowFocused(focused)
            return try transitionOutcome(beforeRevision, id)
        case let .terminalActivityObserved(workspaces):
            model.observeTerminalActivity(workspaces)
            // Not persisted: the reading is live tmux state.
            let snapshot = snapshot()
            if snapshot.revision == beforeRevision {
                emit(.noop)
                return .noop(snapshot)
            }
            emit(.snapshot(snapshot))
            return .updated(snapshot)
        case let .agentTerminalOpened(agentId, terminalId, focus):
            try model.agentTerminalOpened(agentId, terminalId: terminalId, focus: focus)
            return try transitionOutcome(beforeRevision, id)
        case let .agentTerminalShown(agentId, open, focus):
            model.showAgentTerminal(agentId, open: open, focus: focus)
            return try transitionOutcome(beforeRevision, id)
        case let .agentTerminalClosed(agentId):
            model.agentTerminalClosed(agentId)
            return try transitionOutcome(beforeRevision, id)
        case let .resizeAgentTerminal(agentId, share, stacked):
            try model.resizeAgentTerminal(agentId, share: share, stacked: stacked)
            return try transitionOutcome(beforeRevision, id)
        case let .focusPane(target):
            model.focusPane(target)
            return try transitionOutcome(beforeRevision, id)
        case let .cyclePaneFocus(direction):
            try model.cyclePaneFocus(direction)
            return try transitionOutcome(beforeRevision, id)
        case let .paneTerminalsObserved(workspaces, alive, since):
            model.observePaneTerminals(workspaces, alive: Set(alive), since: since)
            return try transitionOutcome(beforeRevision, id)
        case .windowClosed:
            return detach(.windowClosed)
        case .quit:
            return detach(.quit)
        }
    }

    private mutating func transitionOutcome(_ beforeRevision: Int, _ id: OperationId) throws -> IntentOutcome {
        let snapshot = snapshot()
        if snapshot.revision == beforeRevision {
            emit(.noop)
            return .noop(snapshot)
        }
        emit(.snapshot(snapshot))
        try queuePersist(id)
        return .updated(snapshot)
    }

    // MARK: - Reconcile

    public mutating func requestAgentReconcile(_ id: OperationId, _ agentId: AgentId) throws -> IntentOutcome {
        if pending[id] != nil { throw NamedFailure.at(.operationPending) }
        guard model.workspaceForAgent(agentId) != nil else { throw NamedFailure.domain(.unknownAgent) }
        invalidateReconcileScope("agent:\(agentId.rawValue)")
        let token = try startOperation(.reconcileAgent, .agent(agentId), id)
        setActiveReconcile(.agent(token, agentId))
        emitEffect(.reconcileAgent(token, agentId: agentId))
        return .deferred(id, snapshot: snapshot())
    }

    public mutating func requestAgentsReconcile(_ id: OperationId, _ machine: String) throws -> IntentOutcome {
        if pending[id] != nil { throw NamedFailure.at(.operationPending) }
        invalidateReconcileScope("agents:\(machine)")
        let token = try startOperation(.reconcileAgents, .application, id)
        setActiveReconcile(.agents(token, machine: machine))
        emitEffect(.reconcileAgents(token, machine: machine))
        return .deferred(id, snapshot: snapshot())
    }

    // MARK: - Beginnings

    /// Open a place, whichever machine it is on: resolved on the machine it is on.
    private mutating func beginWorkspaceResolution(_ location: RequestedWorkspaceLocation, _ id: OperationId) throws -> IntentOutcome {
        let token = try startOperation(.resolveWorkspacePath, .location(location), id)
        emitEffect(.resolveWorkspacePath(token, location: location))
        return .deferred(id, snapshot: snapshot())
    }

    /// The place is known; a Workspace needs an id before it can be one.
    private mutating func beginWorkspaceIdentity(_ location: WorkspaceLocation, _ selectedPath: String, _ id: OperationId) throws -> IntentOutcome {
        let token = try startOperation(.generateWorkspaceId, .resolvedLocation(location, selectedPath: selectedPath), id)
        resolvedLocations[token.operationId] = (location, selectedPath)
        emitEffect(.generateWorkspaceId(token, location: location, selectedPath: selectedPath))
        return .deferred(token.operationId, snapshot: snapshot())
    }

    private mutating func beginWorkspaceRetry(_ workspaceId: WorkspaceId, _ id: OperationId) throws -> IntentOutcome {
        guard let workspace = model.workspace(workspaceId) else { throw NamedFailure.domain(.unknownWorkspace) }
        guard case .unavailable = workspace.state else { throw NamedFailure.domain(.workspaceNotUnavailable) }
        return try beginWorkspaceRelocation(workspaceId, try RequestedPaths.requestedPath(workspace.selectedPath), id)
    }

    private mutating func beginWorkspaceRelocation(_ workspaceId: WorkspaceId, _ path: String, _ id: OperationId) throws -> IntentOutcome {
        guard let workspace = model.workspace(workspaceId) else { throw NamedFailure.domain(.unknownWorkspace) }
        guard case .unavailable = workspace.state else { throw NamedFailure.domain(.workspaceNotUnavailable) }
        let token = try startOperation(.resolveWorkspacePath, .workspacePath(workspaceId), id)
        // On the machine the Workspace is already on.
        emitEffect(.resolveWorkspacePath(token, location: try RequestedWorkspaceLocation.make(workspace.location.relocated(to: path))))
        return .deferred(id, snapshot: snapshot())
    }

    private mutating func beginProfileResolution(
        _ workspaceId: WorkspaceId, _ profileId: String, _ extraArgs: [String], _ presentation: SurfacePresentation,
        _ agentPresentation: AgentPresentation?, _ resume: String?, _ id: OperationId
    ) throws -> IntentOutcome {
        guard let workspace = model.workspace(workspaceId) else { throw NamedFailure.domain(.unknownWorkspace) }
        guard workspace.canCreateAgent else { throw NamedFailure.domain(.workspaceUnavailable) }
        let token = try startOperation(.resolveAgentProfile, .profile(workspaceId, profileId: profileId), id)
        requestedPresentations[token.operationId] = (presentation, agentPresentation)
        emitEffect(.resolveAgentProfile(token, workspaceId: workspaceId, profileId: profileId, extraArgs: extraArgs, resume: resume))
        return .deferred(id, snapshot: snapshot())
    }

    /// Stop the Agent a continue launch replaced, if this operation had one.
    private mutating func stopReplaced(_ id: OperationId) throws -> IntentOutcome? {
        guard let replaced = stopAfterPersist.removeValue(forKey: id) else { return nil }
        guard model.agent(replaced) != nil else { return nil }
        return try startAgentStop(replaced, id, moveTerminal: false)
    }

    private func continuable(_ agentId: AgentId, _ presentation: AgentPresentation) throws -> (workspaceId: WorkspaceId, profileId: String) {
        guard let agent = model.agent(agentId), let workspace = model.workspaceForAgent(agentId) else {
            throw NamedFailure.domain(.unknownAgent)
        }
        if agent.presentation == presentation {
            throw NamedFailure.domain(
                .invalidAgentControlTransition,
                "“\(agent.displayName)” is already \(presentation == .tui ? "a terminal" : "a GUI") Agent."
            )
        }
        return (workspace.id, agent.profile.id)
    }

    private mutating func beginContinue(_ agentId: AgentId, _ presentation: AgentPresentation, _ session: String?, _ id: OperationId) throws -> IntentOutcome {
        let (workspaceId, profileId) = try continuable(agentId, presentation)
        let outcome = try beginProfileResolution(workspaceId, profileId, [], .full, presentation, session, id)
        replacedByLaunch[id] = agentId
        return outcome
    }

    /// Stop an Agent, or carry it on, or restart it, asking first only if that
    /// would interrupt anything (`interruptsNothing`), or it has a terminal open.
    private mutating func askAbout(_ agentId: AgentId, _ act: AgentAct, _ id: OperationId) throws -> IntentOutcome {
        guard let found = model.agent(agentId), model.workspaceForAgent(agentId) != nil else {
            throw NamedFailure.domain(.unknownAgent)
        }
        if found.interruptsNothing && act != .stop(terminal: true) {
            return try doAgentAct(agentId, act, id)
        }
        let token = try startOperation(.generateConfirmationId, .agent(agentId), id)
        confirmationRequests[id] = .agent(agentId, act: act)
        emitEffect(.generateConfirmationId(token, purpose: act.purpose(agentId)))
        return .deferred(id, snapshot: snapshot())
    }

    private mutating func confirmAgentAct(_ confirmation: ConfirmationId, _ act: String, _ id: OperationId, moveTerminal: Bool = false) throws -> IntentOutcome {
        guard let index = confirmations.firstIndex(where: { pending in
            if case let .agent(_, pendingAct) = pending.request { return pendingAct.name == act && pending.confirmationId == confirmation }
            return false
        }) else { throw NamedFailure.invalidIntent }
        let state = confirmations.remove(at: index)
        guard case let .agent(agentId, pendingAct) = state.request else { throw NamedFailure.invalidIntent }
        return try doAgentAct(agentId, pendingAct, id, moveTerminal: moveTerminal)
    }

    private mutating func doAgentAct(_ agentId: AgentId, _ act: AgentAct, _ id: OperationId, moveTerminal: Bool = false) throws -> IntentOutcome {
        switch act {
        case let .stop(terminal): return try startAgentStop(agentId, id, moveTerminal: moveTerminal && terminal)
        case let .continue(presentation, session): return try beginContinue(agentId, presentation, session, id)
        case .restart: return try startAgentRestart(agentId, id)
        }
    }

    /// Agent `agentId`, when it can be restarted: `agentRestart` says so.
    private func restartable(_ agentId: AgentId) throws {
        guard let agent = model.agent(agentId), model.workspaceForAgent(agentId) != nil else {
            throw NamedFailure.domain(.unknownAgent)
        }
        if case let .refused(why) = AgentRules.restart(
            displayName: agent.displayName, presentation: agent.presentation, profileKind: agent.profile.kind, failure: agent.failure
        ) {
            throw NamedFailure.domain(.invalidAgentControlTransition, why)
        }
    }

    private mutating func startAgentRestart(_ agentId: AgentId, _ id: OperationId) throws -> IntentOutcome {
        let token = try startOperation(.restartAgent, .agent(agentId), id)
        emitEffect(.restartAgent(token, agentId: agentId))
        return .deferred(id, snapshot: snapshot())
    }

    /// Actually stop it. The one second half, whether or not anything was asked.
    private mutating func startAgentStop(_ agentId: AgentId, _ id: OperationId, moveTerminal: Bool) throws -> IntentOutcome {
        try model.requestAgentStop(agentId)
        let token = try startOperation(.stopAgent, .agent(agentId), id)
        emitEffect(.stopAgent(token, agentId: agentId, moveTerminal: moveTerminal))
        emit(.snapshot(snapshot()))
        return .deferred(id, snapshot: snapshot())
    }

    private mutating func retryStop(_ agentId: AgentId, _ id: OperationId) throws -> IntentOutcome {
        guard let found = model.agent(agentId) else { throw NamedFailure.domain(.unknownAgent) }
        guard found.canRetryStop else { throw NamedFailure.domain(.invalidAgentControlTransition) }
        try model.retryAgentStop(agentId)
        let token = try startOperation(.stopAgent, .agent(agentId), id)
        emitEffect(.stopAgent(token, agentId: agentId, moveTerminal: false))
        emit(.snapshot(snapshot()))
        return .deferred(id, snapshot: snapshot())
    }

    private mutating func beginWorkspaceInspection(_ request: CloseRequest, _ id: OperationId) throws -> IntentOutcome {
        let token = try startOperation(.inspectWorkspace, .workspace(request.workspaceId), id)
        closeRequests[id] = request
        emitEffect(.inspectWorkspace(token, workspaceId: request.workspaceId))
        return .deferred(id, snapshot: snapshot())
    }

    private mutating func confirmWorkspaceClose(_ confirmation: ConfirmationId, _ id: OperationId) throws -> IntentOutcome {
        guard let index = confirmations.firstIndex(where: { pending in
            if case .workspaceClose = pending.request { return pending.confirmationId == confirmation }
            return false
        }) else { throw NamedFailure.invalidIntent }
        let state = confirmations.remove(at: index)
        guard case let .workspaceClose(workspaceId, worktree, _) = state.request else { throw NamedFailure.invalidIntent }
        return try startClose(CloseRequest(workspaceId: workspaceId, worktree: worktree), id)
    }

    /// Close a Workspace. One function, one act, first attempt or fifth: ask
    /// everything first; then a fixed sequence of idempotent steps; nothing
    /// persisted while it runs; failure visible and final for that attempt.
    private mutating func closeWorkspace(_ workspaceId: WorkspaceId, _ worktree: WorktreeDisposition, _ id: OperationId) throws -> IntentOutcome {
        guard let workspace = model.workspace(workspaceId) else { throw NamedFailure.domain(.unknownWorkspace) }
        if workspaceId == model.scratchWorkspaceId { throw NamedFailure.domain(.scratchCannotClose) }
        if workspace.close.isRunning { throw NamedFailure.domain(.workspaceClosing) }
        return try beginWorkspaceInspection(CloseRequest(workspaceId: workspaceId, worktree: worktree), id)
    }

    // MARK: - Completions

    private mutating func applyProviderEvent(_ event: ProviderEvent) throws -> IntentOutcome {
        switch event {
        case let .workspacePathResolved(token, location, selectedPath):
            return try completeWorkspacePath(token, location, selectedPath)
        case let .workspaceIdGenerated(token, workspaceId):
            return try completeWorkspaceId(token, workspaceId)
        case let .workspaceInspectionCompleted(token, workspaceId, inspection):
            return try completeWorkspaceInspection(token, workspaceId, inspection)
        case let .agentStopCompleted(token, agentId, result):
            return try completeAgentStop(token, agentId, result)
        case let .agentRestartCompleted(token, agentId):
            _ = try takePending(token, .restartAgent) { $0 == .agent(agentId) }
            emit(.operationCompleted(token))
            return .noop(snapshot())
        case let .agentTerminationCompleted(token, agentId, result):
            _ = try takePending(token, .terminateAgent) { $0 == .agent(agentId) }
            let snapshot = snapshot()
            emit(.operationCompleted(token))
            if case let .failed(code, detail) = result { throw NamedFailure.agent(code, detail) }
            return .noop(snapshot)
        case let .workspaceCloseCompleted(token, workspaceId, result):
            return try completeWorkspaceClose(token, workspaceId, result)
        case let .confirmationIdGenerated(token, confirmation):
            return try completeConfirmationId(token, confirmation)
        case let .profileResolutionCompleted(token, workspaceId, result):
            switch result {
            case let .resolved(profile): return try completeProfileResolved(token, workspaceId, profile)
            case let .failed(code, detail):
                _ = try takePending(token, .resolveAgentProfile) {
                    if case let .profile(id, _) = $0 { return id == workspaceId }
                    return false
                }
                clearOperationAuxiliaryState(token)
                throw NamedFailure.agent(code, detail)
            }
        case let .agentIdGenerated(token, workspaceId, agentId):
            return try completeAgentId(token, workspaceId, agentId)
        case let .agentLaunchCompleted(token, workspaceId, agentId, result):
            return try completeAgentLaunch(token, workspaceId, agentId, result)
        case let .agentsReconciled(token, reconciliation):
            return try completeAgentsReconcile(token, reconciliation)
        case let .agentStatusChanged(token, agentId, status, runtimeHealth):
            return try reconcileAgent(token, agentId, status, runtimeHealth)
        case let .agentExited(token, agentId):
            return try handleAgentExited(token, agentId)
        case let .statePersisted(token):
            return try completePersist(token)
        case let .statePersistenceFailed(token, reason):
            return try completePersistFailed(token, reason)
        case let .operationFailed(token, failure):
            return try completeOperationFailed(token, failure)
        }
    }

    private mutating func completeOperationFailed(_ token: OperationToken, _ failure: AppError) throws -> IntentOutcome {
        guard let operation = pending[token.operationId] else {
            throw completedTokens[token.operationId] != nil ? StaleCompletion(operationId: token.operationId) as Error : unknownOperation(token.operationId)
        }
        if operation.token != token { throw StaleCompletion(operationId: token.operationId) }
        removePending(token.operationId)
        clearOperationAuxiliaryState(token)
        rememberCompleted(token)
        throw NamedFailure(failure)
    }

    private mutating func clearOperationAuxiliaryState(_ token: OperationToken) {
        let id = token.operationId
        resolvedLocations[id] = nil
        requestedPresentations[id] = nil
        resolvedProfiles[id] = nil
        launchProfiles[id] = nil
        replacedByLaunch[id] = nil
        stopAfterPersist[id] = nil
        closeRequests[id] = nil
        confirmationRequests[id] = nil
        finalizationPending.remove(id)
        if finalizationWorkspaces.removeValue(forKey: id) != nil {
            finalizationBackups[id] = nil
            for (root, owner) in finalizationRoots where owner == id { finalizationRoots[root] = nil }
        }
        for scope in activeReconcileOrder where activeReconciles[scope]?.token == token { removeActiveReconcile(scope) }
    }

    private mutating func completeWorkspacePath(_ token: OperationToken, _ location: WorkspaceLocation, _ selectedPath: String) throws -> IntentOutcome {
        let operation = try takePending(token, .resolveWorkspacePath) {
            if case .location = $0 { return true }
            if case .workspacePath = $0 { return true }
            return false
        }
        if case let .workspacePath(workspaceId) = operation.target {
            try model.relocateWorkspace(workspaceId, location: location, selectedPath: selectedPath)
            try model.selectContext(.workspace(workspaceId))
            let snapshot = snapshot()
            emit(.snapshot(snapshot))
            emit(.operationCompleted(token))
            try queuePersist(token.operationId)
            return .updated(snapshot)
        }
        return try beginWorkspaceIdentity(location, selectedPath, operation.token.operationId)
    }

    private mutating func completeWorkspaceId(_ token: OperationToken, _ workspaceId: WorkspaceId) throws -> IntentOutcome {
        _ = try takePending(token, .generateWorkspaceId) {
            if case .resolvedLocation = $0 { return true }
            return false
        }
        guard let resolved = resolvedLocations.removeValue(forKey: token.operationId) else { throw unknownOperation(token.operationId) }
        let key = resolved.location.key
        if finalizationRoots[key] != nil { throw NamedFailure.domain(.duplicateWorkspaceRoot) }
        if let existing = model.workspaces.first(where: { $0.state.isAvailable && $0.key == key }) {
            let beforeRevision = model.revision
            try model.selectContext(.workspace(existing.id))
            let snapshot = snapshot()
            if snapshot.revision != beforeRevision {
                emit(.snapshot(snapshot))
                emit(.operationCompleted(token))
                try queuePersist(token.operationId)
                return .updated(snapshot)
            }
            emit(.operationCompleted(token))
            emit(.noop)
            return .noop(snapshot)
        }
        try model.addWorkspace(Workspace(id: workspaceId, location: resolved.location, selectedPath: resolved.selectedPath))
        // Opening a folder is choosing it, new or not.
        try model.selectContext(.workspace(workspaceId))
        let snapshot = snapshot()
        emit(.snapshot(snapshot))
        emit(.operationCompleted(token))
        try queuePersist(token.operationId)
        return .updated(snapshot)
    }

    private mutating func completeProfileResolved(_ token: OperationToken, _ workspaceId: WorkspaceId, _ profile: AgentProfile) throws -> IntentOutcome {
        _ = try takePending(token, .resolveAgentProfile) { $0 == .profile(workspaceId, profileId: profile.id) }
        let id = token.operationId
        if !workspaceAllowsAgentCreation(workspaceId) {
            resolvedProfiles[id] = nil
            replacedByLaunch[id] = nil
            throw StaleCompletion(operationId: id)
        }
        let requested = requestedPresentations.removeValue(forKey: id)
        let agentPresentation = try resolveAgentPresentation(profile, requested?.agentPresentation)
        let nextToken = try startOperation(.generateAgentId, .profile(workspaceId, profileId: profile.id), id)
        resolvedProfiles[nextToken.operationId] = ResolvedProfile(
            workspaceId: workspaceId, profile: profile, presentation: requested?.presentation ?? .full,
            agentPresentation: agentPresentation
        )
        emitEffect(.generateAgentId(nextToken, workspaceId: workspaceId))
        return .deferred(nextToken.operationId, snapshot: snapshot())
    }

    /// How the Agent this launch makes is shown: what the request asked for,
    /// or the profile's default. A presentation the profile's kind cannot have
    /// is refused here, before anything is started.
    private func resolveAgentPresentation(_ profile: AgentProfile, _ requested: AgentPresentation?) throws -> AgentPresentation {
        let presentation = requested ?? profile.presentation
        guard profile.kind.presentations.contains(presentation) else {
            throw NamedFailure.domain(
                .invalidProfile,
                "“\(profile.displayName)” cannot open as GUI: only Claude and Codex profiles can. It can open as a terminal."
            )
        }
        return presentation
    }

    private mutating func completeAgentId(_ token: OperationToken, _ workspaceId: WorkspaceId, _ agentId: AgentId) throws -> IntentOutcome {
        _ = try takePending(token, .generateAgentId) {
            if case let .profile(id, _) = $0 { return id == workspaceId }
            return false
        }
        if !workspaceAllowsAgentCreation(workspaceId) {
            resolvedProfiles[token.operationId] = nil
            replacedByLaunch[token.operationId] = nil
            throw StaleCompletion(operationId: token.operationId)
        }
        guard let resolved = resolvedProfiles.removeValue(forKey: token.operationId) else { throw unknownOperation(token.operationId) }
        launchProfiles[token.operationId] = LaunchProfile(
            workspaceId: workspaceId, agentId: agentId, profile: resolved.profile, presentation: resolved.presentation,
            agentPresentation: resolved.agentPresentation
        )
        let launchToken = try startOperation(.launchAgent, .agentLaunch(workspaceId, agentId), token.operationId)
        emitEffect(.launchAgent(
            launchToken, workspaceId: workspaceId, agentId: agentId, profile: resolved.profile,
            agentPresentation: resolved.agentPresentation
        ))
        return .deferred(launchToken.operationId, snapshot: snapshot())
    }

    private mutating func completeAgentLaunch(
        _ token: OperationToken, _ workspaceId: WorkspaceId, _ agentId: AgentId, _ result: AgentLaunchResult
    ) throws -> IntentOutcome {
        if !workspaceAllowsAgentCreation(workspaceId) {
            cancelWorkspaceAgentOperations(workspaceId)
            throw StaleCompletion(operationId: token.operationId)
        }
        guard let expected = launchProfiles[token.operationId] else {
            throw pending[token.operationId] != nil || completedTokens[token.operationId] != nil
                ? StaleCompletion(operationId: token.operationId) as Error : unknownOperation(token.operationId)
        }
        if expected.workspaceId != workspaceId || expected.agentId != agentId { throw StaleCompletion(operationId: token.operationId) }
        _ = try takePending(token, .launchAgent) { $0 == .agentLaunch(workspaceId, agentId) }
        launchProfiles[token.operationId] = nil
        let replaced = replacedByLaunch.removeValue(forKey: token.operationId)
        if case let .failed(code, detail) = result { throw NamedFailure.agent(code, detail) }
        do {
            try model.addAgent(
                owner: workspaceId, id: agentId, profile: expected.profile, agentPresentation: expected.agentPresentation,
                presentation: expected.presentation
            )
        } catch {
            let refused = try Self.refusal(error)
            let terminateToken = try startOperation(.terminateAgent, .agent(agentId), token.operationId)
            emitEffect(.terminateAgent(terminateToken, agentId: agentId))
            throw refused
        }
        try model.selectContext(.agent(agentId), presentation: expected.presentation)
        let snapshot = snapshot()
        emit(.snapshot(snapshot))
        emit(.operationCompleted(token))
        try queuePersist(token.operationId)
        // The Agent it replaces goes once the new one is written down.
        if let replaced { stopAfterPersist[token.operationId] = replaced }
        return .updated(snapshot)
    }

    private mutating func completeAgentsReconcile(_ token: OperationToken, _ reconciliation: AgentReconciliation) throws -> IntentOutcome {
        guard let scope = scopeOfToken(token, agents: true) else { throw StaleCompletion(operationId: token.operationId) }
        _ = try takePending(token, .reconcileAgents) { $0 == .application }
        removeActiveReconcile(scope)
        for observation in reconciliation.observations where model.workspaceForAgent(observation.agentId) == nil {
            throw NamedFailure.domain(.unknownAgent)
        }
        for agentId in reconciliation.exited where model.workspaceForAgent(agentId) == nil {
            throw NamedFailure.domain(.unknownAgent)
        }
        let canceledStopTokens = reconciliation.exited.flatMap { cancelAgentStopStateAfterExit($0) }
        let beforeRevision = model.revision
        try model.reconcileAgents(reconciliation)
        let snapshot = snapshot()
        if snapshot.revision == beforeRevision {
            for stopToken in canceledStopTokens { emit(.operationCompleted(stopToken)) }
            emit(.operationCompleted(token))
            emit(.noop)
            return .noop(snapshot)
        }
        emit(.snapshot(snapshot))
        for stopToken in canceledStopTokens { emit(.operationCompleted(stopToken)) }
        emit(.operationCompleted(token))
        try queuePersist(token.operationId)
        return .updated(snapshot)
    }

    private mutating func completeConfirmationId(_ token: OperationToken, _ confirmation: ConfirmationId) throws -> IntentOutcome {
        if confirmationIds.contains(confirmation) || confirmations.contains(where: { $0.confirmationId == confirmation }) {
            throw NamedFailure.invalidIntent
        }
        guard let request = confirmationRequests[token.operationId] else {
            throw pending[token.operationId] != nil || completedTokens[token.operationId] != nil
                ? StaleCompletion(operationId: token.operationId) as Error : unknownOperation(token.operationId)
        }
        switch request {
        case let .agent(agentId, _):
            _ = try takePending(token, .generateConfirmationId) { $0 == .agent(agentId) }
        case let .workspaceClose(workspaceId, _, _):
            _ = try takePending(token, .generateConfirmationId) { $0 == .workspace(workspaceId) }
        }
        confirmationRequests[token.operationId] = nil
        confirmationIds.insert(confirmation)
        confirmationIdOrder.append(confirmation)
        while confirmationIdOrder.count > Self.maxConfirmationIdEntries {
            confirmationIds.remove(confirmationIdOrder.removeFirst())
        }
        let purpose: ConfirmationOutcomePurpose
        switch request {
        case let .workspaceClose(_, worktree, inspection): purpose = .workspaceClose(inspection: inspection, worktree: worktree)
        case let .agent(agentId, act): purpose = act.confirmation(agentId)
        }
        // One open question per subject.
        confirmations.removeAll { pending in
            switch (request, pending.request) {
            case let (.agent(a, _), .agent(b, _)): return a == b
            case let (.workspaceClose(a, _, _), .workspaceClose(b, _, _)): return a == b
            default: return false
            }
        }
        confirmations.append(PendingConfirmationState(request: request, confirmationId: confirmation))
        emit(.operationCompleted(token))
        return .confirmationRequired(confirmation, snapshot: snapshot(), purpose: purpose)
    }

    private mutating func completeWorkspaceInspection(
        _ token: OperationToken, _ workspaceId: WorkspaceId, _ inspection: CloseInspectionInputs
    ) throws -> IntentOutcome {
        _ = try takePending(token, .inspectWorkspace) { $0 == .workspace(workspaceId) }
        guard let request = closeRequests.removeValue(forKey: token.operationId) else { throw unknownOperation(token.operationId) }
        if CloseInspection.consolidate(inspection).isClean { return try startClose(request, token.operationId) }
        guard model.workspace(workspaceId) != nil else { throw NamedFailure.domain(.unknownWorkspace) }
        let confirmationToken = try startOperation(.generateConfirmationId, .workspace(workspaceId), token.operationId)
        confirmationRequests[token.operationId] = .workspaceClose(
            workspaceId, worktree: request.worktree,
            inspection: CloseInspectionProjection(workspaceId: workspaceId, workspaceLabel: try labelOf(workspaceId), inputs: inspection)
        )
        emitEffect(.generateConfirmationId(confirmationToken, purpose: .workspaceClose(workspaceId)))
        return .deferred(token.operationId, snapshot: snapshot())
    }

    private func labelOf(_ workspaceId: WorkspaceId) throws -> String {
        guard let workspace = snapshot().workspace(workspaceId) else { throw NamedFailure.domain(.unknownWorkspace) }
        return workspace.label
    }

    /// Every question is answered. Hand the whole close to the environment.
    private mutating func startClose(_ request: CloseRequest, _ id: OperationId) throws -> IntentOutcome {
        guard model.workspace(request.workspaceId) != nil else { throw NamedFailure.domain(.unknownWorkspace) }
        let token = try startOperation(.closeWorkspace, .workspace(request.workspaceId), id)
        do {
            try model.beginWorkspaceClose(request.workspaceId)
        } catch {
            removePending(id)
            rememberCompleted(token)
            throw try Self.refusal(error)
        }
        cancelWorkspaceAgentOperations(request.workspaceId)
        invalidateReconciliation()
        emit(.snapshot(snapshot()))
        emitEffect(.closeWorkspace(token, workspaceId: request.workspaceId, worktree: request.worktree))
        return .deferred(id, snapshot: snapshot())
    }

    private mutating func completeAgentStop(_ token: OperationToken, _ agentId: AgentId, _ result: AgentStopResult) throws -> IntentOutcome {
        if let naturalExit = naturalExitStopTokens[token.key] {
            if naturalExit != agentId || model.workspaceForAgent(agentId) != nil { throw StaleCompletion(operationId: token.operationId) }
            emit(.operationCompleted(token))
            return .noop(snapshot())
        }
        _ = try takePending(token, .stopAgent) { $0 == .agent(agentId) }
        switch result {
        case .stopped:
            if model.workspaceForAgent(agentId) == nil {
                rememberNaturalExitStop(token, agentId)
                emit(.operationCompleted(token))
                return .noop(snapshot())
            }
            try model.agentExited(agentId)
            invalidateReconciliationAfterAgentRemoval(agentId)
        case .failed:
            // Still there and still stoppable: the row says so.
            try model.markAgentStopFailed(agentId, .cleanupFailed)
        }
        let snapshot = snapshot()
        emit(.snapshot(snapshot))
        emit(.operationCompleted(token))
        try queuePersist(token.operationId)
        if case let .failed(code, detail) = result { throw NamedFailure.agent(code, detail) }
        return .updated(snapshot)
    }

    /// The close ended. Either the Workspace goes, or one step is named.
    private mutating func completeWorkspaceClose(_ token: OperationToken, _ workspaceId: WorkspaceId, _ result: WorkspaceCloseResult) throws -> IntentOutcome {
        _ = try takePending(token, .closeWorkspace) { $0 == .workspace(workspaceId) }
        if case let .failed(step, diagnostic, detail) = result {
            try model.markWorkspaceCloseFailed(workspaceId, step: step, diagnostic: diagnostic, detail: detail)
            let snapshot = snapshot()
            emit(.snapshot(snapshot))
            emit(.operationCompleted(token))
            emit(.error(NamedFailure.domain(.workspaceClosingFailed)))
            try queuePersist(token.operationId)
            return .updated(snapshot)
        }
        guard let workspace = model.workspace(workspaceId) else { throw StaleCompletion(operationId: token.operationId) }
        for agent in workspace.agents { try model.agentExited(agent.id) }
        let backup = try model.closeWorkspaceForPersistence(workspaceId, inspection: .clean, drawn: drawn())
        finalizationRoots[backup.workspace.key] = token.operationId
        finalizationPending.insert(token.operationId)
        finalizationWorkspaces[token.operationId] = workspaceId
        finalizationBackups[token.operationId] = backup
        let snapshot = snapshot()
        emit(.snapshot(snapshot))
        emit(.operationCompleted(token))
        try queuePersist(token.operationId)
        return .deferred(token.operationId, snapshot: snapshot)
    }

    private mutating func completePersist(_ token: OperationToken) throws -> IntentOutcome {
        _ = try takePending(token, .persistState) { $0 == .application }
        emit(.operationCompleted(token))
        if let stopped = try stopReplaced(token.operationId) { return stopped }
        if finalizationPending.remove(token.operationId) != nil {
            finalizationWorkspaces[token.operationId] = nil
            if let backup = finalizationBackups.removeValue(forKey: token.operationId) {
                finalizationRoots[backup.workspace.key] = nil
            }
        }
        return .noop(snapshot())
    }

    /// The save that was to make the close final did not happen: the Workspace
    /// comes back, and the close is a failure at its last step.
    private mutating func completePersistFailed(_ token: OperationToken, _ reason: String) throws -> IntentOutcome {
        _ = try takePending(token, .persistState) { $0 == .application }
        _ = try stopReplaced(token.operationId)
        if finalizationPending.remove(token.operationId) != nil {
            let workspaceId = finalizationWorkspaces.removeValue(forKey: token.operationId)
            if let backup = finalizationBackups.removeValue(forKey: token.operationId) {
                try model.rollbackWorkspaceClose(backup)
                finalizationRoots[backup.workspace.key] = nil
                if let workspaceId {
                    try model.markWorkspaceCloseFailed(workspaceId, step: .state, diagnostic: .cleanupFailed, detail: reason)
                }
            }
        }
        let error = NamedFailure.at(.persistenceDegraded, reason)
        emit(.snapshot(snapshot()))
        emit(.error(error))
        emit(.operationCompleted(token))
        return .persistenceDegraded(snapshot())
    }

    private mutating func reconcileAgent(
        _ token: OperationToken, _ agentId: AgentId, _ status: AgentStatus, _ runtimeHealth: AgentRuntimeHealth
    ) throws -> IntentOutcome {
        let scope = "agent:\(agentId.rawValue)"
        guard let active = activeReconciles[scope], active.token == token else { throw StaleCompletion(operationId: token.operationId) }
        _ = try takePending(token, .reconcileAgent) { $0 == .agent(agentId) }
        removeActiveReconcile(scope)
        let beforeRevision = model.revision
        try model.setAgentStatus(agentId, status)
        try model.setAgentRuntimeHealth(agentId, runtimeHealth)
        let snapshot = snapshot()
        if snapshot.revision == beforeRevision {
            emit(.operationCompleted(token))
            emit(.noop)
            return .noop(snapshot)
        }
        emit(.snapshot(snapshot))
        emit(.operationCompleted(token))
        try queuePersist(token.operationId)
        return .updated(snapshot)
    }

    private mutating func handleAgentExited(_ token: OperationToken, _ agentId: AgentId) throws -> IntentOutcome {
        let scope = "agent:\(agentId.rawValue)"
        guard let active = activeReconciles[scope], active.token == token else { throw StaleCompletion(operationId: token.operationId) }
        _ = try takePending(token, .reconcileAgent) { $0 == .agent(agentId) }
        removeActiveReconcile(scope)
        let stopTokens = cancelAgentStopStateAfterExit(agentId)
        let removed = model.workspaceForAgent(agentId) != nil
        if removed { try model.agentExited(agentId) }
        let snapshot = snapshot()
        if removed { emit(.snapshot(snapshot)) }
        for stopToken in stopTokens { emit(.operationCompleted(stopToken)) }
        emit(.operationCompleted(token))
        try queuePersist(token.operationId)
        return removed ? .updated(snapshot) : .noop(snapshot)
    }

    // MARK: - Bookkeeping

    private mutating func cancelAgentStopStateAfterExit(_ agentId: AgentId) -> [OperationToken] {
        let ids = pendingOrder.filter { id in
            guard let operation = pending[id] else { return false }
            return operation.target == .agent(agentId) && (operation.kind == .stopAgent || operation.kind == .generateConfirmationId)
        }
        var completedStopTokens: [OperationToken] = []
        for id in ids {
            guard let operation = pending[id] else { continue }
            removePending(id)
            rememberCompleted(operation.token)
            clearOperationAuxiliaryState(operation.token)
            if operation.kind == .stopAgent {
                rememberNaturalExitStop(operation.token, agentId)
                completedStopTokens.append(operation.token)
            }
        }
        for (id, request) in confirmationRequests {
            if case let .agent(a, _) = request, a == agentId { confirmationRequests[id] = nil }
        }
        confirmations.removeAll { if case let .agent(a, _) = $0.request { return a == agentId } else { return false } }
        return completedStopTokens
    }

    private mutating func rememberNaturalExitStop(_ token: OperationToken, _ agentId: AgentId) {
        let key = token.key
        naturalExitStopTokens[key] = agentId
        naturalExitStopOrder.append(key)
        while naturalExitStopOrder.count > Self.maxCompletedTokenEntries {
            naturalExitStopTokens[naturalExitStopOrder.removeFirst()] = nil
        }
    }

    /// An Agent that has gone invalidates whatever was asking about it: its
    /// own reconcile and every machine's round.
    private mutating func invalidateReconciliationAfterAgentRemoval(_ agentId: AgentId) {
        for scope in activeReconcileOrder where scope == "agent:\(agentId.rawValue)" || scope.hasPrefix("agents:") {
            invalidateReconcileScope(scope)
        }
    }

    private mutating func setActiveReconcile(_ active: ActiveReconcile) {
        if activeReconciles[active.scope] == nil { activeReconcileOrder.append(active.scope) }
        activeReconciles[active.scope] = active
    }

    private mutating func removeActiveReconcile(_ scope: String) {
        activeReconciles[scope] = nil
        activeReconcileOrder.removeAll { $0 == scope }
    }

    private func scopeOfToken(_ token: OperationToken, agents: Bool) -> String? {
        for scope in activeReconcileOrder {
            guard let active = activeReconciles[scope], active.token == token else { continue }
            if case .agents = active, agents { return scope }
            if case .agent = active, !agents { return scope }
        }
        return nil
    }

    private mutating func takePending(
        _ token: OperationToken, _ kind: OperationKind, _ targetMatches: (OperationTarget) -> Bool
    ) throws -> PendingOperation {
        guard let operation = pending[token.operationId] else {
            throw completedTokens[token.operationId] != nil ? StaleCompletion(operationId: token.operationId) as Error : unknownOperation(token.operationId)
        }
        if operation.token != token || operation.kind != kind || !targetMatches(operation.target) {
            throw StaleCompletion(operationId: token.operationId)
        }
        removePending(token.operationId)
        rememberCompleted(token)
        return operation
    }

    private mutating func startOperation(_ kind: OperationKind, _ target: OperationTarget, _ id: OperationId) throws -> OperationToken {
        if pending[id] != nil { throw NamedFailure.at(.operationPending) }
        nextGeneration += 1
        if nextGeneration > AppModel.maxSafeInteger { throw NamedFailure.at(.operationPending) }
        let token = OperationToken(operationId: id, generation: nextGeneration)
        pending[id] = PendingOperation(token: token, kind: kind, target: target)
        pendingOrder.append(id)
        return token
    }

    private mutating func removePending(_ id: OperationId) {
        if pending.removeValue(forKey: id) != nil { pendingOrder.removeAll { $0 == id } }
    }

    private func unknownOperation(_ id: OperationId) -> InvariantViolation {
        InvariantViolation("a completion arrived for operation \(id.rawValue), which was never started")
    }

    /// Whether an operation with this identity is still in flight.
    public func hasPending(_ id: OperationId) -> Bool { pending[id] != nil }

    /// The Agents a launch is under way for: a sweep counts them as accounted for.
    public func launchingAgents() -> [AgentId] {
        pendingOrder.compactMap { id in
            guard let operation = pending[id], operation.kind == .launchAgent, case let .agentLaunch(_, agentId) = operation.target else {
                return nil
            }
            return agentId
        }
    }

    /// The open confirmations, by id, and what each is about.
    public var openConfirmations: [ConfirmationId] { confirmations.map(\.confirmationId) }

    private mutating func invalidateReconciliation() {
        for scope in activeReconcileOrder { invalidateReconcileScope(scope) }
    }

    /// Drop a reconcile whose answer no longer describes the model, announcing
    /// the superseded operation as completed.
    private mutating func invalidateReconcileScope(_ scope: String) {
        guard let active = activeReconciles[scope] else { return }
        removeActiveReconcile(scope)
        if pending[active.token.operationId] != nil {
            removePending(active.token.operationId)
            rememberCompleted(active.token)
            emit(.operationCompleted(active.token))
        }
    }

    private func workspaceAllowsAgentCreation(_ workspaceId: WorkspaceId) -> Bool {
        model.workspace(workspaceId)?.canCreateAgent ?? false
    }

    private mutating func cancelWorkspaceAgentOperations(_ workspaceId: WorkspaceId) {
        let ids = pendingOrder.filter { id in
            guard let operation = pending[id] else { return false }
            let targetsWorkspace: Bool
            switch operation.target {
            case let .profile(w, _), let .agentLaunch(w, _), let .workspace(w): targetsWorkspace = w == workspaceId
            default: targetsWorkspace = false
            }
            let cancellable = [.resolveAgentProfile, .generateAgentId, .launchAgent, .terminateAgent, .generateConfirmationId]
                .contains(operation.kind)
            return targetsWorkspace && cancellable
        }
        for id in ids {
            if let operation = pending[id] {
                removePending(id)
                rememberCompleted(operation.token)
            }
            resolvedProfiles[id] = nil
            launchProfiles[id] = nil
            replacedByLaunch[id] = nil
            confirmationRequests[id] = nil
        }
        let model = self.model
        confirmations.removeAll { pending in
            switch pending.request {
            case let .agent(agentId, _): return model.workspaceForAgent(agentId)?.id == workspaceId
            case let .workspaceClose(id, _, _): return id == workspaceId
            }
        }
    }

    private mutating func rememberCompleted(_ token: OperationToken) {
        completedTokens[token.operationId] = token
        completedTokenOrder.append((token.operationId, token))
        while completedTokenOrder.count > Self.maxCompletedTokenEntries {
            let (evictedId, evictedToken) = completedTokenOrder.removeFirst()
            if completedTokens[evictedId] == evictedToken { completedTokens[evictedId] = nil }
        }
    }

    /// Schedule the save that follows a mutation. The mutation and the save it
    /// needs are one act, so a failure to schedule it throws.
    private mutating func queuePersist(_ id: OperationId) throws {
        let token = try startOperation(.persistState, .application, id)
        emitEffect(.persistState(token))
    }

    private mutating func emitEffect(_ effect: Effect) { emit(.effect(effect)) }

    private mutating func emit(_ event: CoordinatorEvent) {
        nextSequence += 1
        events.append(SequencedCoordinatorEvent(sequence: nextSequence, event: event))
        if events.count > Self.maxRetainedEvents { events.removeFirst() }
    }

    private mutating func cacheIntent(_ id: IntentId, _ envelope: IntentEnvelope, _ outcome: IntentOutcome?, _ error: Error?) {
        if intentCache[id] == nil { intentOrder.append(id) }
        intentCache[id] = CachedDispatch(operationId: envelope.operationId, intent: envelope.intent, outcome: outcome, error: error)
        while intentOrder.count > Self.maxIntentLedgerEntries { intentCache[intentOrder.removeFirst()] = nil }
    }

    private mutating func cacheProviderEvent(_ id: ProviderEventId, _ event: ProviderEvent, _ outcome: IntentOutcome?, _ error: Error?) {
        if providerEventCache[id] == nil { providerEventOrder.append(id) }
        providerEventCache[id] = CachedDispatch(event: event, outcome: outcome, error: error)
        while providerEventOrder.count > Self.maxProviderLedgerEntries { providerEventCache[providerEventOrder.removeFirst()] = nil }
    }

    private mutating func detach(_ reason: DetachReason) -> IntentOutcome {
        if detached == nil {
            detached = reason
            emitEffect(.detach(reason))
        } else {
            emit(.noop)
        }
        return .detached(snapshot())
    }
}

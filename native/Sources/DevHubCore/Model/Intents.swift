// Port of apps/desktop/src/model/intents.ts
//
// The command algebra and the effect seam.
//
// A port of `crates/devhub-app-core/src/application/{types,error,intent}.rs`.
// Two things are deliberately separate here and must stay separate:
//
// - `UserIntent` is what a person asked for. It can never carry a provider
//   observation, a canonical root, a generated identity, an inspection or a
//   profile — those are results, and results do not arrive through the UI.
// - `ProviderEvent` is what an adapter finished doing, and it is accepted only
//   against the exact operation generation that asked for it.

import Foundation

/// Native application lifecycle readiness owned by the coordinator.
public enum AppReadiness: String, Sendable, Hashable {
    case starting, ready, unavailable
}

public struct IntentId: UuidIdentity {
    public let rawValue: String
    public init(unchecked rawValue: String) { self.rawValue = rawValue }
    public static func random() -> IntentId { IntentId(unchecked: UUID().uuidString.lowercased()) }
}

public struct OperationId: UuidIdentity {
    public let rawValue: String
    public init(unchecked rawValue: String) { self.rawValue = rawValue }
    public static func random() -> OperationId { OperationId(unchecked: UUID().uuidString.lowercased()) }
}

public struct ConfirmationId: UuidIdentity {
    public let rawValue: String
    public init(unchecked rawValue: String) { self.rawValue = rawValue }
    public static func random() -> ConfirmationId { ConfirmationId(unchecked: UUID().uuidString.lowercased()) }
}

public struct ProviderEventId: UuidIdentity {
    public let rawValue: String
    public init(unchecked rawValue: String) { self.rawValue = rawValue }
    public static func random() -> ProviderEventId { ProviderEventId(unchecked: UUID().uuidString.lowercased()) }
}

/// A completion is accepted only for the exact operation generation that
/// asked for it, so a late adapter answer cannot mutate a newer operation that
/// reused the same domain identity.
public struct OperationToken: Hashable, Sendable {
    public var operationId: OperationId
    public var generation: Int

    public init(operationId: OperationId, generation: Int) {
        self.operationId = operationId
        self.generation = generation
    }

    /// `tokenKey`.
    public var key: String { "\(operationId.rawValue)#\(generation)" }
}

public enum RequestedPaths {
    /// `requestedPath`: a path exactly as a caller requested it. It is not a
    /// canonical Workspace Root; only a resolver completion may create that.
    public static func requestedPath(_ raw: String) throws -> String {
        if raw.jsTrimmed.isEmpty || raw.contains("\0") || raw.utf16.count > 32768 { throw domainFail(.invalidPath) }
        return raw
    }
}

/// Where a caller asked DevHub to open, before anything has resolved it.
public enum RequestedWorkspaceLocation: Hashable, Sendable {
    case local(path: String)
    case ssh(host: String, path: String)

    public var path: String {
        switch self {
        case let .local(path), let .ssh(_, path): return path
        }
    }

    /// `requestedLocation`: the one way one is made.
    public static func make(_ requested: RequestedLocation) throws -> RequestedWorkspaceLocation {
        switch requested {
        case let .local(path): return .local(path: try RequestedPaths.requestedPath(path))
        case let .ssh(host, path):
            return .ssh(host: try DomainHosts.sshHost(host), path: try RequestedPaths.requestedPath(path))
        }
    }

    /// `requestedAtPath`: the same machine this request named, at a resolved path.
    public func at(path: String) -> RequestedLocation {
        switch self {
        case .local: return .local(path: path)
        case let .ssh(host, _): return .ssh(host: host, path: path)
        }
    }

    /// `whereRequested`: empty when it is this Mac.
    public var whereText: String {
        switch self {
        case .local: return ""
        case let .ssh(host, _): return " on \(host)"
        }
    }
}

/// What is to become of the folder a worktree Workspace sits in.
public enum WorktreeDisposition: String, Hashable, Sendable {
    /// Not a worktree, or the person chose to close and leave it.
    case keep
    /// DevHub believes it is clean, so nothing was asked. git is still the authority.
    case remove
    /// The person was shown what would be lost and said yes: `--force`.
    case removeAnyway = "remove-anyway"
}

public enum UserIntent: Equatable, Sendable {
    case selectContext(NavigationContext, presentation: SurfacePresentation)
    /// Side by side: put the keyboard in the other half.
    case swapSplitFocus
    /// Back, or Forward.
    case navigateHistory(NavigationDirection)
    /// Scratch, and back again.
    case toggleScratch
    /// Attach a Workspace's editor somewhere else.
    case attachEditor(WorkspaceId, EditorAttachment)
    case editorContainerStarted(WorkspaceId, containerId: String)
    /// Today's daily folder is Scratch from now on.
    case adoptScratchDay(WorkspaceId, location: WorkspaceLocation, selectedPath: String)
    /// Where the top-level rows go, as the person just arranged them.
    case reorderWorkspaces([WorkspaceId])
    case reorderAgents(WorkspaceId, [AgentId])
    case resizeSidebar(width: Double)
    case toggleSidebar
    /// Zoom the Agent panes' text one step, or forget the zoom.
    case terminalZoom(TerminalZoom.Direction, base: Double)
    case resizeSplit(ratio: Double)
    case placeSmartButtons(AgentPresentation, SmartButtonsSpot?)
    case openFolder(RequestedWorkspaceLocation)
    case newWindow(path: String?)
    case retryWorkspace(WorkspaceId)
    /// Main could not read the Workspace's folder.
    case workspaceRootUnreadable(WorkspaceId, reason: DiagnosticCode)
    case locateWorkspace(WorkspaceId, path: String)
    case createAgent(
        workspaceId: WorkspaceId, profileId: String, extraArgs: [String] = [], presentation: SurfacePresentation = .full,
        agentPresentation: AgentPresentation? = nil, resume: String? = nil
    )
    /// Carry an Agent's session on in the other presentation.
    case continueAgent(AgentId, presentation: AgentPresentation, session: String?)
    case confirmContinueAgent(ConfirmationId)
    /// Stop an Agent's CLI and start it again on the same session.
    case restartAgent(AgentId)
    case confirmRestartAgent(ConfirmationId)
    case renameAgent(AgentId, displayName: String)
    case setAutomaticAction(AgentId, actionId: String, automatic: Bool)
    case stopAgent(AgentId)
    /// `moveTerminal`: move its terminal to the Workspace's editor terminal.
    case confirmStopAgent(ConfirmationId, moveTerminal: Bool = false)
    case retryStopAgent(AgentId)
    case markAgentUnread(AgentId)
    case reconcileAgent(AgentId)
    case reconcileAgents(machine: String)
    /// Close this Workspace — first attempt or fifth, it is the same request.
    case requestCloseWorkspace(WorkspaceId, worktree: WorktreeDisposition)
    case confirmCloseWorkspace(ConfirmationId)
    case windowFocusChanged(Bool)
    case terminalActivityObserved([WorkspaceTerminalObservation])
    case agentTerminalOpened(AgentId, terminalId: String, focus: Bool)
    case agentTerminalShown(AgentId, open: Bool, focus: Bool)
    case agentTerminalClosed(AgentId)
    case resizeAgentTerminal(AgentId, share: Double, stacked: Bool = false)
    case focusPane(PaneFocusTarget)
    case cyclePaneFocus(direction: Int)
    case paneTerminalsObserved(workspaces: [WorkspaceId], alive: [String], since: Double)
    case windowClosed
    case quit
}

public struct IntentEnvelope: Equatable, Sendable {
    public var intentId: IntentId
    public var operationId: OperationId?
    public var intent: UserIntent

    public init(intentId: IntentId = .random(), operationId: OperationId? = .random(), intent: UserIntent) {
        self.intentId = intentId
        self.operationId = operationId
        self.intent = intent
    }
}

/// A stop or a termination, as the Agent port answered it.
public enum AgentStopResult: Equatable, Sendable {
    case stopped
    case failed(code: AgentFailureCode, detail: String?)
}

/// A profile looked up for one launch, on the machine its Agent would run on.
public enum AgentProfileResolution: Equatable, Sendable {
    case resolved(AgentProfile)
    case failed(code: AgentFailureCode, detail: String)
}

public enum AgentLaunchResult: Equatable, Sendable {
    case started
    case failed(code: AgentFailureCode, detail: String?)
}

/// How a close ended. There is no third answer, and no partial one.
public enum WorkspaceCloseResult: Equatable, Sendable {
    case closed
    case failed(step: CloseStep, diagnostic: DiagnosticCode, detail: String?)
}

public enum ProviderEvent: Equatable, Sendable {
    case workspacePathResolved(OperationToken, location: WorkspaceLocation, selectedPath: String)
    case workspaceIdGenerated(OperationToken, WorkspaceId)
    case workspaceInspectionCompleted(OperationToken, WorkspaceId, CloseInspectionInputs)
    case agentStopCompleted(OperationToken, AgentId, AgentStopResult)
    /// A GUI Agent's CLI was started again on its session, and is ready.
    case agentRestartCompleted(OperationToken, AgentId)
    case agentTerminationCompleted(OperationToken, AgentId, AgentStopResult)
    case workspaceCloseCompleted(OperationToken, WorkspaceId, WorkspaceCloseResult)
    case confirmationIdGenerated(OperationToken, ConfirmationId)
    case profileResolutionCompleted(OperationToken, WorkspaceId, AgentProfileResolution)
    case agentIdGenerated(OperationToken, WorkspaceId, AgentId)
    case agentLaunchCompleted(OperationToken, WorkspaceId, AgentId, AgentLaunchResult)
    case agentsReconciled(OperationToken, AgentReconciliation)
    case agentStatusChanged(OperationToken, AgentId, status: AgentStatus, runtimeHealth: AgentRuntimeHealth)
    case agentExited(OperationToken, AgentId)
    case statePersisted(OperationToken)
    /// What the store said, in the words the reader gets.
    case statePersistenceFailed(OperationToken, reason: String)
    /// The adapter could not complete an operation. This consumes the token.
    case operationFailed(OperationToken, AppError)

    public var token: OperationToken {
        switch self {
        case let .workspacePathResolved(token, _, _), let .workspaceIdGenerated(token, _),
             let .workspaceInspectionCompleted(token, _, _), let .agentStopCompleted(token, _, _),
             let .agentRestartCompleted(token, _), let .agentTerminationCompleted(token, _, _),
             let .workspaceCloseCompleted(token, _, _), let .confirmationIdGenerated(token, _),
             let .profileResolutionCompleted(token, _, _), let .agentIdGenerated(token, _, _),
             let .agentLaunchCompleted(token, _, _, _), let .agentsReconciled(token, _),
             let .agentStatusChanged(token, _, _, _), let .agentExited(token, _), let .statePersisted(token),
             let .statePersistenceFailed(token, _), let .operationFailed(token, _):
            return token
        }
    }
}

public struct ProviderEventEnvelope: Equatable, Sendable {
    public var eventId: ProviderEventId
    public var event: ProviderEvent

    public init(eventId: ProviderEventId = .random(), event: ProviderEvent) {
        self.eventId = eventId
        self.event = event
    }
}

/// What a confirmation is about, subject included.
public enum ConfirmationOutcomePurpose: Equatable, Sendable {
    case workspaceClose(inspection: CloseInspectionProjection, worktree: WorktreeDisposition)
    /// `terminal`: it has a terminal open, so the sheet offers to move it to the editor.
    case agentStop(AgentId, terminal: Bool)
    case agentContinue(AgentId, presentation: AgentPresentation)
    case agentRestart(AgentId)
}

public enum IntentOutcome: Equatable, Sendable {
    case noop(AppSnapshot)
    case updated(AppSnapshot)
    case confirmationRequired(ConfirmationId, snapshot: AppSnapshot, purpose: ConfirmationOutcomePurpose)
    case deferred(OperationId, snapshot: AppSnapshot)
    case detached(AppSnapshot)
    case persistenceDegraded(AppSnapshot)

    public var snapshot: AppSnapshot {
        switch self {
        case let .noop(snapshot), let .updated(snapshot), let .confirmationRequired(_, snapshot, _),
             let .deferred(_, snapshot), let .detached(snapshot), let .persistenceDegraded(snapshot):
            return snapshot
        }
    }

    public var kind: String {
        switch self {
        case .noop: return "noop"
        case .updated: return "updated"
        case .confirmationRequired: return "confirmation_required"
        case .deferred: return "deferred"
        case .detached: return "detached"
        case .persistenceDegraded: return "persistence_degraded"
        }
    }
}

public enum ConfirmationPurpose: Equatable, Sendable {
    case stopAgent(AgentId)
    case continueAgent(AgentId)
    case restartAgent(AgentId)
    case workspaceClose(WorkspaceId)
}

public enum DetachReason: String, Equatable, Sendable {
    case windowClosed = "window_closed"
    case quit
}

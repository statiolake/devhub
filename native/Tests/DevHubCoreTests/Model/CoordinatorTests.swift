// Port of apps/desktop/src/model/coordinator.test.ts

import XCTest
@testable import DevHubCore

private let CONFIRM = ConfirmationId(unchecked: "550e8400-e29b-41d4-a716-4466554400c0")

/// A test driver that plays the adapter's part: it collects the effects the
/// coordinator emits and hands back exactly the completion each one asked for.
final class Driver {
    var coordinator: AppCoordinator
    private var nextId = 0
    private var cursor = 0

    init(_ coordinator: AppCoordinator = coordinatorFor(scratchModel())) { self.coordinator = coordinator }

    var model: AppModel { coordinator.model }
    var snapshot: AppSnapshot { coordinator.snapshot() }

    private func freshId() -> String {
        nextId += 1
        let hex = String(nextId, radix: 16)
        return "550e8400-e29b-41d4-a716-" + String(repeating: "0", count: 12 - hex.count) + hex
    }

    @discardableResult
    func dispatch(_ intent: UserIntent) throws -> IntentOutcome {
        try coordinator.dispatchUser(IntentEnvelope(
            intentId: IntentId(unchecked: freshId()), operationId: OperationId(unchecked: freshId()), intent: intent
        ))
    }

    /// Every effect emitted since the last time this was called.
    func drainEffects() -> [Effect] {
        let subscription = coordinator.subscribeFrom(cursor)
        cursor = subscription.cursor
        return subscription.events.compactMap { if case let .effect(effect) = $0.event { return effect } else { return nil } }
    }

    /// Every error emitted since the last drain, in order.
    func drainErrors() -> [NamedFailure] {
        let subscription = coordinator.subscribeFrom(cursor)
        cursor = subscription.cursor
        return subscription.events.compactMap { if case let .error(error) = $0.event { return error } else { return nil } }
    }

    /// Answer one effect with the completion the coordinator is waiting for.
    @discardableResult
    func answer(_ effect: Effect, _ inspection: CloseInspectionInputs = .clean) throws -> IntentOutcome? {
        switch effect {
        case let .persistState(token): return try accept(.statePersisted(token))
        case let .resolveWorkspacePath(token, location):
            return try accept(.workspacePathResolved(
                token, location: try WorkspaceLocation.make(location.at(path: location.path)), selectedPath: location.path
            ))
        case let .generateWorkspaceId(token, _, _): return try accept(.workspaceIdGenerated(token, WS_A))
        case let .resolveAgentProfile(token, workspaceId, _, _, _):
            return try accept(.profileResolutionCompleted(token, workspaceId, .resolved(codex)))
        case let .generateAgentId(token, workspaceId): return try accept(.agentIdGenerated(token, workspaceId, AG_A))
        case let .launchAgent(token, workspaceId, agentId, _, _):
            return try accept(.agentLaunchCompleted(token, workspaceId, agentId, .started))
        case let .generateConfirmationId(token, _): return try accept(.confirmationIdGenerated(token, CONFIRM))
        case let .inspectWorkspace(token, workspaceId):
            return try accept(.workspaceInspectionCompleted(token, workspaceId, inspection))
        case let .closeWorkspace(token, workspaceId, _): return try accept(.workspaceCloseCompleted(token, workspaceId, .closed))
        case let .stopAgent(token, agentId, _): return try accept(.agentStopCompleted(token, agentId, .stopped))
        default: return nil
        }
    }

    @discardableResult
    func accept(_ event: ProviderEvent) throws -> IntentOutcome {
        try coordinator.acceptProviderEvent(ProviderEventEnvelope(eventId: ProviderEventId(unchecked: freshId()), event: event))
    }

    /// Run every pending effect to completion, in order.
    func settle(_ inspection: CloseInspectionInputs = .clean) throws {
        for _ in 0..<64 {
            let effects = drainEffects()
            if effects.isEmpty { return }
            for effect in effects { try answer(effect, inspection) }
        }
        XCTFail("effects did not settle")
    }

    func openFolder(_ path: String) throws {
        try dispatch(.openFolder(.local(path: path)))
        try settle()
    }

    func createAgent(_ agentPresentation: AgentPresentation? = nil) throws {
        try dispatch(.createAgent(workspaceId: WS_A, profileId: "codex", presentation: .full, agentPresentation: agentPresentation))
    }

    func setStatus(_ id: AgentId, _ status: AgentStatus, failure: AgentFailure? = nil) throws {
        try coordinator.withModel { try $0.setAgentStatus(id, status, failure: failure) }
    }
}

/// How a call was refused: the code a person is shown, or which of the two
/// refusals nobody is shown it was.
func errorCode(_ run: () throws -> Any?) -> String? {
    do { _ = try run() } catch let error as NamedFailure { return error.wire.code.rawValue } catch is StaleCompletion {
        return "stale"
    } catch is InvariantViolation { return "invariant" } catch { return nil }
    return nil
}

func refusalOf(_ run: () throws -> Any?) -> Error? {
    do { _ = try run() } catch { return error }
    return nil
}

private func closeIntent(_ worktree: WorktreeDisposition = .keep) -> UserIntent { .requestCloseWorkspace(WS_A, worktree: worktree) }

extension Effect {
    var name: String {
        switch self {
        case .noop: return "noop"
        case .detach: return "detach"
        case .resolveWorkspacePath: return "resolve_workspace_path"
        case .generateWorkspaceId: return "generate_workspace_id"
        case .resolveAgentProfile: return "resolve_agent_profile"
        case .generateConfirmationId: return "generate_confirmation_id"
        case .generateAgentId: return "generate_agent_id"
        case .launchAgent: return "launch_agent"
        case .inspectWorkspace: return "inspect_workspace"
        case .stopAgent: return "stop_agent"
        case .terminateAgent: return "terminate_agent"
        case .restartAgent: return "restart_agent"
        case .reconcileAgents: return "reconcile_agents"
        case .reconcileAgent: return "reconcile_agent"
        case .closeWorkspace: return "close_workspace"
        case .persistState: return "persist_state"
        }
    }
}

final class CoordinatorTests: XCTestCase {
    // MARK: dispatch

    func testAnswersAPureTransitionImmediatelyAndPersistsIt() throws {
        let driver = Driver()
        XCTAssertEqual(try driver.dispatch(.resizeSidebar(width: 300)).kind, "updated")
        XCTAssertEqual(driver.drainEffects().map(\.name), ["persist_state"])
    }

    func testReportsATransitionThatChangedNothingAsANoop() throws {
        let driver = Driver()
        try driver.dispatch(.resizeSidebar(width: 300))
        try driver.settle()
        XCTAssertEqual(try driver.dispatch(.resizeSidebar(width: 300)).kind, "noop")
    }

    func testReplaysTheSameResultForARepeatedIntentId() throws {
        var coordinator = coordinatorFor(scratchModel())
        let envelope = IntentEnvelope(
            intentId: IntentId(unchecked: "550e8400-e29b-41d4-a716-4466554400f0"),
            operationId: OperationId(unchecked: "550e8400-e29b-41d4-a716-4466554400f1"), intent: .resizeSidebar(width: 300)
        )
        let first = try coordinator.dispatchUser(envelope)
        let second = try coordinator.dispatchUser(envelope)
        XCTAssertEqual(second, first)
    }

    func testRefusesADifferentIntentUnderAUsedIntentId() throws {
        var coordinator = coordinatorFor(scratchModel())
        let id = IntentId(unchecked: "550e8400-e29b-41d4-a716-4466554400f0")
        let op = OperationId(unchecked: "550e8400-e29b-41d4-a716-4466554400f1")
        try coordinator.dispatchUser(IntentEnvelope(intentId: id, operationId: op, intent: .resizeSidebar(width: 300)))
        XCTAssertEqual(errorCode { try coordinator.dispatchUser(IntentEnvelope(intentId: id, operationId: op, intent: .resizeSidebar(width: 320))) }, "invalid_intent")
    }

    func testRefusesWithItsModelsOwnRefusalNamedAndReplaysTheSameOne() {
        var coordinator = coordinatorFor(scratchModel())
        let envelope = IntentEnvelope(
            intentId: IntentId(unchecked: "550e8400-e29b-41d4-a716-4466554400e0"),
            operationId: OperationId(unchecked: "550e8400-e29b-41d4-a716-4466554400e1"), intent: .resizeSidebar(width: 1)
        )
        let first = refusalOf { try coordinator.dispatchUser(envelope) }
        XCTAssertEqual((first as? NamedFailure)?.wire.code, .invalidIntent)
        let second = refusalOf { try coordinator.dispatchUser(envelope) }
        XCTAssertEqual(second as? NamedFailure, first as? NamedFailure)
    }

    func testRefusesAnIntentWithNoTrustedOperationIdentity() {
        var coordinator = coordinatorFor(scratchModel())
        XCTAssertEqual(errorCode {
            try coordinator.dispatchUser(IntentEnvelope(
                intentId: IntentId(unchecked: "550e8400-e29b-41d4-a716-4466554400f0"), operationId: nil, intent: .resizeSidebar(width: 300)
            ))
        }, "invalid_intent")
    }

    // MARK: opening a folder

    func testResolvesGeneratesAnIdentityAndAddsTheWorkspace() throws {
        let driver = Driver()
        XCTAssertEqual(try driver.dispatch(.openFolder(.local(path: "/dev/project"))).kind, "deferred")
        try driver.settle()
        XCTAssertEqual(driver.snapshot.workspaces.map(\.root), [scratchPath, "/dev/project"])
    }

    func testSelectsAFolderItHasJustAdded() throws {
        let driver = Driver()
        try driver.openFolder("/dev/project")
        XCTAssertEqual(driver.snapshot.selection.context, .workspace(WS_A))
    }

    func testSelectsTheExistingWorkspaceWhenTheSameFolderIsOpenedAgain() throws {
        let driver = Driver()
        try driver.openFolder("/dev/project")
        try driver.dispatch(.selectContext(.workspace(driver.model.scratchWorkspaceId), presentation: .full))
        try driver.settle()
        try driver.openFolder("/dev/project")
        XCTAssertEqual(driver.snapshot.workspaces.count, 2)
        XCTAssertEqual(driver.snapshot.selection.context, .workspace(WS_A))
    }

    func testResolvesThePathOnTheMachineItIsOnHostAndAll() throws {
        let driver = Driver()
        try driver.dispatch(.openFolder(.ssh(host: "build.example.com", path: "/srv/api")))
        let effects = driver.drainEffects()
        XCTAssertEqual(effects.map(\.name), ["resolve_workspace_path"])
        guard case let .resolveWorkspacePath(_, location) = effects[0] else { return XCTFail() }
        XCTAssertEqual(location, .ssh(host: "build.example.com", path: "/srv/api"))
    }

    func testAddsItAsAWorkspaceLikeAnyOtherAndKeepsTheMachine() throws {
        let driver = Driver()
        try driver.dispatch(.openFolder(.ssh(host: "build.example.com", path: "/srv/api")))
        try driver.settle()
        let workspace = driver.snapshot.workspaces[1]
        XCTAssertEqual(workspace.location, .ssh(host: "build.example.com", path: "/srv/api"))
        XCTAssertEqual(workspace.key, "ssh://build.example.com/srv/api")
        XCTAssertTrue(workspace.canCreateAgent)
    }

    func testKeepsASecondMachinesIdenticalPathAsASecondWorkspace() throws {
        let driver = Driver()
        let ids = [WS_A, WorkspaceId(unchecked: "550e8400-e29b-41d4-a716-4466554400b1")]
        for (index, id) in ids.enumerated() {
            try driver.dispatch(.openFolder(.ssh(host: index == 0 ? "build.example.com" : "staging.example.com", path: "/srv/api")))
            for _ in 0..<4 {
                let effects = driver.drainEffects()
                if effects.isEmpty { break }
                for effect in effects {
                    if case let .generateWorkspaceId(token, _, _) = effect {
                        try driver.accept(.workspaceIdGenerated(token, id))
                        continue
                    }
                    try driver.answer(effect)
                }
            }
            try driver.settle()
        }
        XCTAssertEqual(driver.snapshot.workspaces.count, 3)
    }

    // MARK: tokens

    func testRejectsACompletionForASupersededGeneration() throws {
        let driver = Driver()
        try driver.dispatch(.openFolder(.local(path: "/dev/project")))
        guard case let .resolveWorkspacePath(token, _) = driver.drainEffects()[0] else { return XCTFail() }
        let stale = OperationToken(operationId: token.operationId, generation: token.generation + 1)
        XCTAssertEqual(errorCode {
            try driver.accept(.workspacePathResolved(stale, location: .local(path: "/dev/project"), selectedPath: "/dev/project"))
        }, "stale")
    }

    func testRejectsACompletionForAnOperationNobodyStarted() {
        let driver = Driver()
        XCTAssertEqual(errorCode {
            try driver.accept(.statePersisted(OperationToken(operationId: OperationId(unchecked: "550e8400-e29b-41d4-a716-4466554400ff"), generation: 1)))
        }, "invariant")
    }

    // MARK: closing a workspace

    /// Opened a workspace and asked to close it, stopped at the `close_workspace` effect.
    private func atTheFirstStep() throws -> (Driver, Effect) {
        let driver = Driver()
        try driver.openFolder("/dev/project")
        try driver.dispatch(closeIntent())
        let inspect = driver.drainEffects()[0]
        XCTAssertEqual(inspect.name, "inspect_workspace")
        try driver.answer(inspect)
        let effect = driver.drainEffects()[0]
        XCTAssertEqual(effect.name, "close_workspace")
        return (driver, effect)
    }

    private func closeToken(_ effect: Effect) -> OperationToken {
        guard case let .closeWorkspace(token, _, _) = effect else { fatalError("unexpected") }
        return token
    }

    func testClosesWithoutAConfirmationWhenNothingIsBusy() throws {
        let driver = Driver()
        try driver.openFolder("/dev/project")
        try driver.dispatch(closeIntent())
        try driver.settle()
        XCTAssertEqual(driver.snapshot.workspaces.count, 1)
    }

    func testAsksEverythingBeforeItDoesAnything() throws {
        let driver = Driver()
        try driver.openFolder("/dev/project")
        try driver.dispatch(closeIntent())
        XCTAssertEqual(driver.drainEffects().map(\.name), ["inspect_workspace"])
    }

    func testRunsTheStepsAsOneActNotOneSaveAtATime() throws {
        let (driver, effect) = try atTheFirstStep()
        XCTAssertEqual(driver.drainEffects().count, 0)
        try driver.answer(effect)
        XCTAssertEqual(driver.drainEffects().map(\.name), ["persist_state"])
    }

    func testCarriesTheAnswerAboutTheFolderIntoTheClose() throws {
        let driver = Driver()
        try driver.openFolder("/dev/project")
        try driver.dispatch(closeIntent(.removeAnyway))
        try driver.answer(driver.drainEffects()[0])
        guard case let .closeWorkspace(_, _, worktree) = driver.drainEffects()[0] else { return XCTFail() }
        XCTAssertEqual(worktree, .removeAnyway)
    }

    private func inspectToken(_ driver: Driver) -> OperationToken {
        guard case let .inspectWorkspace(token, _) = driver.drainEffects()[0] else { fatalError("unexpected") }
        return token
    }

    func testAsksForConfirmationWhenAResourceIsBusyThenClosesOnConfirm() throws {
        let driver = Driver()
        try driver.openFolder("/dev/project")
        try driver.dispatch(closeIntent())
        try driver.accept(.workspaceInspectionCompleted(inspectToken(driver), WS_A, CloseInspectionInputs(unsavedEditors: .of(["main.ts"]))))
        guard case let .generateConfirmationId(token, _) = driver.drainEffects()[0] else { return XCTFail() }
        let required = try driver.accept(.confirmationIdGenerated(token, CONFIRM))
        guard case let .confirmationRequired(_, _, purpose) = required, case .workspaceClose = purpose else { return XCTFail() }
        XCTAssertEqual(driver.drainEffects().count, 0)
        try driver.dispatch(.confirmCloseWorkspace(CONFIRM))
        try driver.settle()
        XCTAssertEqual(driver.snapshot.workspaces.count, 1)
    }

    func testAsksAboutUnsavedEditorsBeforeARemoveCloseTouchesTheWorktree() throws {
        for worktree in [WorktreeDisposition.remove, .removeAnyway] {
            let driver = Driver()
            try driver.openFolder("/dev/project")
            try driver.dispatch(closeIntent(worktree))
            try driver.accept(.workspaceInspectionCompleted(inspectToken(driver), WS_A, CloseInspectionInputs(unsavedEditors: .of(["Untitled-1"]))))
            XCTAssertEqual(try driver.answer(driver.drainEffects()[0])?.kind, "confirmation_required")
            XCTAssertEqual(driver.drainEffects().count, 0)
            XCTAssertEqual(driver.snapshot.workspaces.count, 2)
            try driver.dispatch(.confirmCloseWorkspace(CONFIRM))
            guard case let .closeWorkspace(_, _, disposition) = driver.drainEffects()[0] else { return XCTFail() }
            XCTAssertEqual(disposition, worktree)
        }
    }

    func testTellsTheQuestionWhatTheCloseWillDoToTheWorktree() throws {
        for worktree in [WorktreeDisposition.keep, .remove, .removeAnyway] {
            let driver = Driver()
            try driver.openFolder("/dev/project")
            try driver.dispatch(closeIntent(worktree))
            try driver.accept(.workspaceInspectionCompleted(inspectToken(driver), WS_A, CloseInspectionInputs(unsavedEditors: .of(["Untitled-1"]))))
            guard case let .confirmationRequired(_, _, .workspaceClose(_, disposition))? = try driver.answer(driver.drainEffects()[0]) else {
                return XCTFail()
            }
            XCTAssertEqual(disposition, worktree)
        }
    }

    func testChangesNothingWhenTheQuestionIsLeftUnanswered() throws {
        let driver = Driver()
        try driver.openFolder("/dev/project")
        try driver.dispatch(closeIntent())
        try driver.accept(.workspaceInspectionCompleted(inspectToken(driver), WS_A, CloseInspectionInputs(agents: try .busyCount(1))))
        try driver.answer(driver.drainEffects()[0])
        XCTAssertEqual(driver.drainEffects().count, 0)
        XCTAssertEqual(driver.snapshot.workspaces[1].close, .idle)
    }

    func testClosesAWorkspaceWhoseAgentsAreAllIdleAndStopsThemWithIt() throws {
        let driver = Driver()
        try driver.openFolder("/dev/project")
        try driver.createAgent()
        try driver.settle()
        XCTAssertEqual(driver.snapshot.workspaces[1].agents.count, 1)
        try driver.dispatch(closeIntent())
        try driver.settle()
        XCTAssertEqual(driver.snapshot.workspaces.count, 1)
    }

    func testClosesAWorkspaceWhoseAgentWasKilledFromOutside() throws {
        let driver = Driver()
        try driver.openFolder("/dev/project")
        try driver.createAgent()
        try driver.settle()
        try driver.dispatch(closeIntent())
        try driver.answer(driver.drainEffects()[0])
        let close = driver.drainEffects()[0]
        try driver.accept(.workspaceCloseCompleted(closeToken(close), WS_A, .closed))
        try driver.settle()
        XCTAssertEqual(driver.snapshot.workspaces.count, 1)
    }

    func testRefusesASecondCloseWhileOneIsRunning() throws {
        let (driver, _) = try atTheFirstStep()
        XCTAssertEqual(errorCode { try driver.dispatch(closeIntent()) }, "workspace_closing")
    }

    func testNamesTheStepAndTheCauseWhenOneFailsAndKeepsTheRow() throws {
        let (driver, effect) = try atTheFirstStep()
        _ = driver.drainErrors()
        try driver.accept(.workspaceCloseCompleted(closeToken(effect), WS_A, .failed(step: .agents, diagnostic: .closeAgentsUnknown, detail: nil)))
        let workspace = driver.snapshot.workspaces[1]
        XCTAssertEqual(workspace.close, .failed(step: .agents, diagnostic: .closeAgentsUnknown, detail: nil))
        XCTAssertEqual(workspace.state, .available)
        let errors = driver.drainErrors()
        XCTAssertEqual(errors.count, 1)
        XCTAssertEqual(errors[0].wire.code, .workspaceCloseFailed)
    }

    func testSucceedsOnTheNextAttemptOnceTheCauseIsGone() throws {
        let (driver, effect) = try atTheFirstStep()
        try driver.accept(.workspaceCloseCompleted(closeToken(effect), WS_A, .failed(step: .terminal, diagnostic: .closeTerminalUnknown, detail: nil)))
        try driver.settle()
        XCTAssertEqual(driver.snapshot.workspaces.count, 2)
        try driver.dispatch(closeIntent())
        try driver.settle()
        XCTAssertEqual(driver.snapshot.workspaces.count, 1)
    }

    func testClearsAPreviousFailureWhenTheNextCloseStarts() throws {
        let (driver, effect) = try atTheFirstStep()
        try driver.accept(.workspaceCloseCompleted(closeToken(effect), WS_A, .failed(step: .worktree, diagnostic: .cleanupFailed, detail: nil)))
        try driver.settle()
        try driver.dispatch(closeIntent())
        try driver.answer(driver.drainEffects()[0])
        XCTAssertEqual(driver.snapshot.workspaces[1].close, .running)
    }

    func testRefusesAConfirmationThatWasNeverIssued() {
        let driver = Driver()
        XCTAssertEqual(errorCode { try driver.dispatch(.confirmCloseWorkspace(CONFIRM)) }, "invalid_intent")
    }

    // MARK: launching an agent

    func testResolvesTheProfileGeneratesAnIdentityLaunchesAndSelectsIt() throws {
        let driver = Driver()
        try driver.openFolder("/dev/project")
        try driver.createAgent()
        try driver.settle()
        XCTAssertEqual(driver.snapshot.workspaces[1].agents.map(\.id), [AG_A])
        XCTAssertEqual(driver.snapshot.selection, NavigationSelection(context: .agent(AG_A), presentation: .full))
    }

    func testSurfacesALaunchFailureInsteadOfAddingAPhantomAgent() throws {
        let driver = Driver()
        try driver.openFolder("/dev/project")
        try driver.createAgent()
        try driver.answer(driver.drainEffects()[0])
        try driver.answer(driver.drainEffects()[0])
        guard case let .launchAgent(token, _, _, _, _) = driver.drainEffects()[0] else { return XCTFail() }
        XCTAssertEqual(errorCode {
            try driver.accept(.agentLaunchCompleted(token, WS_A, AG_A, .failed(code: .agentRuntimeUnavailable, detail: nil)))
        }, "agent_runtime_unavailable")
        XCTAssertEqual(driver.snapshot.workspaces[1].agents.count, 0)
    }

    func testAnOperationAPortCouldNotCarryOutReachesWhoeverAskedInTheWordsItWasDrawnIn() throws {
        let reported = AppError.at(.workspaceUnavailable).withDetail("/src/api could not be opened as a workspace: not a directory")
        let driver = Driver()
        try driver.openFolder("/dev/project")
        try driver.createAgent()
        guard case let .resolveAgentProfile(token, _, _, _, _) = driver.drainEffects()[0] else { return XCTFail() }
        let refusal = refusalOf { try driver.accept(.operationFailed(token, reported)) }
        XCTAssertEqual(errorWire(refusal!), reported)
    }

    func testARefusalTheCoordinatorThrowsIsNotAlsoEmittedAsAnErrorEvent() throws {
        let driver = Driver()
        try driver.openFolder("/dev/project")
        try driver.createAgent()
        guard case let .resolveAgentProfile(token, _, _, _, _) = driver.drainEffects()[0] else { return XCTFail() }
        XCTAssertTrue(refusalOf {
            try driver.accept(.profileResolutionCompleted(token, WS_A, .failed(code: .agentProfileUnavailable, detail: "codex was not found.")))
        } is NamedFailure)
        XCTAssertTrue(refusalOf { try driver.dispatch(.stopAgent(AG_A)) } is NamedFailure)
        XCTAssertEqual(driver.drainErrors(), [])
    }

    func testRefusesAnUnresolvedProfileAsTheProfilesFailureAndLeavesTheWorkspaceOpen() throws {
        let driver = Driver()
        try driver.openFolder("/dev/project")
        try driver.createAgent()
        guard case let .resolveAgentProfile(token, _, _, _, _) = driver.drainEffects()[0] else { return XCTFail() }
        let refusal = refusalOf {
            try driver.accept(.profileResolutionCompleted(token, WS_A, .failed(code: .agentProfileUnavailable, detail: "codex was not found in /usr/bin:/bin.")))
        }
        let wire = errorWire(refusal!)
        XCTAssertEqual(wire.code, .agentProfileUnavailable)
        XCTAssertEqual(wire.summary, "The agent could not start from this profile.")
        XCTAssertEqual(wire.detail, "codex was not found in /usr/bin:/bin.")
        XCTAssertEqual(driver.model.workspace(WS_A)?.canCreateAgent, true)
        try driver.createAgent()
        XCTAssertEqual(driver.drainEffects().first?.name, "resolve_agent_profile")
    }

    func testAnAgentWhoseLaunchIsUnderWayIsNamedUntilTheModelHasIt() throws {
        let driver = Driver()
        try driver.openFolder("/dev/project")
        try driver.createAgent()
        try driver.answer(driver.drainEffects()[0])
        XCTAssertEqual(driver.coordinator.launchingAgents(), [])
        try driver.answer(driver.drainEffects()[0])
        let launch = driver.drainEffects()[0]
        XCTAssertEqual(launch.name, "launch_agent")
        XCTAssertNil(driver.model.agent(AG_A))
        XCTAssertEqual(driver.coordinator.launchingAgents(), [AG_A])
        try driver.answer(launch)
        XCTAssertNotNil(driver.model.agent(AG_A))
        XCTAssertEqual(driver.coordinator.launchingAgents(), [])
    }

    // MARK: continuing

    private let AG_B0 = AgentId(unchecked: "550e8400-e29b-41d4-a716-4466554400b0")

    /// A GUI Agent AG_A, and a continue-in-terminal asked of it, up to its launch.
    private func continuing() throws -> (Driver, OperationToken, AgentPresentation) {
        let driver = Driver()
        try driver.openFolder("/dev/project")
        try driver.createAgent(.gui)
        try driver.settle()
        try driver.setStatus(AG_A, .idle)
        try driver.dispatch(.continueAgent(AG_A, presentation: .tui, session: "thread-1"))
        let resolve = driver.drainEffects()[0]
        guard case let .resolveAgentProfile(_, _, profileId, extraArgs, resume) = resolve else { throw InvariantViolation("unexpected") }
        XCTAssertEqual(profileId, "codex")
        XCTAssertEqual(extraArgs, [])
        XCTAssertEqual(resume, "thread-1")
        try driver.answer(resolve)
        guard case let .generateAgentId(token, _) = driver.drainEffects()[0] else { throw InvariantViolation("unexpected") }
        try driver.accept(.agentIdGenerated(token, WS_A, AG_B0))
        guard case let .launchAgent(launch, _, _, _, presentation) = driver.drainEffects()[0] else { throw InvariantViolation("unexpected") }
        return (driver, launch, presentation)
    }

    func testContinuesInATerminalThenStopsTheGuiOneAndShowsTheNewOne() throws {
        let (driver, launch, presentation) = try continuing()
        XCTAssertEqual(presentation, .tui)
        XCTAssertEqual(driver.model.agent(AG_A)?.controlState, .running)
        try driver.accept(.agentLaunchCompleted(launch, WS_A, AG_B0, .started))
        let persist = driver.drainEffects()[0]
        XCTAssertEqual(persist.name, "persist_state")
        XCTAssertEqual(driver.model.agent(AG_A)?.controlState, .running)
        try driver.answer(persist)
        let stop = driver.drainEffects().first { $0.name == "stop_agent" }
        guard case let .stopAgent(_, agentId, _)? = stop else { return XCTFail() }
        XCTAssertEqual(agentId, AG_A)
        XCTAssertEqual(driver.model.agent(AG_A)?.controlState, .stopping)
        XCTAssertEqual(driver.snapshot.selection.context, .agent(AG_B0))
    }

    func testLeavesTheGuiAgentRunningWhenTheTerminalCouldNotBeStarted() throws {
        let (driver, launch, _) = try continuing()
        XCTAssertEqual(errorCode {
            try driver.accept(.agentLaunchCompleted(launch, WS_A, AG_B0, .failed(code: .agentProfileUnavailable, detail: nil)))
        }, "agent_profile_unavailable")
        XCTAssertFalse(driver.drainEffects().contains { $0.name == "stop_agent" })
        XCTAssertEqual(driver.model.agent(AG_A)?.controlState, .running)
    }

    func testContinueIsRefusedForAnAgentThatIsAlreadyInThatPresentation() throws {
        for presentation in [AgentPresentation.tui, .gui] {
            let driver = Driver()
            try driver.openFolder("/dev/project")
            try driver.createAgent(presentation)
            try driver.settle()
            XCTAssertEqual(errorCode { try driver.dispatch(.continueAgent(AG_A, presentation: presentation, session: "thread-1")) }, "invalid_intent")
        }
    }

    func testContinuesATerminalAgentInTheGuiResumingTheSession() throws {
        let AG_B1 = AgentId(unchecked: "550e8400-e29b-41d4-a716-4466554400b1")
        let driver = Driver()
        try driver.openFolder("/dev/project")
        try driver.createAgent(.tui)
        try driver.settle()
        try driver.setStatus(AG_A, .idle)
        try driver.dispatch(.continueAgent(AG_A, presentation: .gui, session: "thread-9"))
        let resolve = driver.drainEffects()[0]
        guard case let .resolveAgentProfile(_, _, _, _, resume) = resolve else { return XCTFail() }
        XCTAssertEqual(resume, "thread-9")
        try driver.answer(resolve)
        guard case let .generateAgentId(token, _) = driver.drainEffects()[0] else { return XCTFail() }
        try driver.accept(.agentIdGenerated(token, WS_A, AG_B1))
        guard case let .launchAgent(launch, _, _, _, presentation) = driver.drainEffects()[0] else { return XCTFail() }
        XCTAssertEqual(presentation, .gui)
        XCTAssertEqual(driver.model.agent(AG_A)?.controlState, .running)
        try driver.accept(.agentLaunchCompleted(launch, WS_A, AG_B1, .started))
        try driver.answer(driver.drainEffects()[0])
        guard case let .stopAgent(_, agentId, _)? = driver.drainEffects().first(where: { $0.name == "stop_agent" }) else { return XCTFail() }
        XCTAssertEqual(agentId, AG_A)
    }

    private func continuingBusy(_ presentation: AgentPresentation, _ status: AgentStatus) throws -> (Driver, [Effect]) {
        let driver = Driver()
        try driver.openFolder("/dev/project")
        try driver.createAgent(presentation)
        try driver.settle()
        try driver.setStatus(AG_A, status)
        try driver.dispatch(.continueAgent(AG_A, presentation: presentation == .tui ? .gui : .tui, session: "thread-3"))
        return (driver, driver.drainEffects())
    }

    func testContinueAsksFirstWhenTheAgentIsNotIdleAndLaunchesNothingYet() throws {
        for presentation in [AgentPresentation.tui, .gui] {
            for status in [AgentStatus.working, .background, .waiting, .error, .unknown] {
                let (driver, effects) = try continuingBusy(presentation, status)
                XCTAssertEqual(effects.map(\.name), ["generate_confirmation_id"])
                guard case let .generateConfirmationId(token, _) = effects[0] else { return XCTFail() }
                let required = try driver.accept(.confirmationIdGenerated(token, CONFIRM))
                guard case let .confirmationRequired(id, _, purpose) = required else { return XCTFail() }
                XCTAssertEqual(id, CONFIRM)
                XCTAssertEqual(purpose, .agentContinue(AG_A, presentation: presentation == .tui ? .gui : .tui))
                XCTAssertFalse(driver.drainEffects().contains { $0.name == "resolve_agent_profile" || $0.name == "stop_agent" })
                XCTAssertEqual(driver.model.agent(AG_A)?.controlState, .running)
            }
        }
    }

    func testContinueGoesOnOnceConfirmed() throws {
        let AG_B2 = AgentId(unchecked: "550e8400-e29b-41d4-a716-4466554400b2")
        let (driver, effects) = try continuingBusy(.tui, .working)
        guard case let .generateConfirmationId(token, _) = effects[0] else { return XCTFail() }
        try driver.accept(.confirmationIdGenerated(token, CONFIRM))
        _ = driver.drainEffects()
        try driver.dispatch(.confirmContinueAgent(CONFIRM))
        let resolve = driver.drainEffects()[0]
        guard case let .resolveAgentProfile(_, _, _, _, resume) = resolve else { return XCTFail() }
        XCTAssertEqual(resume, "thread-3")
        try driver.answer(resolve)
        guard case let .generateAgentId(idToken, _) = driver.drainEffects()[0] else { return XCTFail() }
        try driver.accept(.agentIdGenerated(idToken, WS_A, AG_B2))
        guard case let .launchAgent(launch, _, _, _, presentation) = driver.drainEffects()[0] else { return XCTFail() }
        XCTAssertEqual(presentation, .gui)
        try driver.accept(.agentLaunchCompleted(launch, WS_A, AG_B2, .started))
        try driver.answer(driver.drainEffects()[0])
        guard case let .stopAgent(_, agentId, _)? = driver.drainEffects().first(where: { $0.name == "stop_agent" }) else { return XCTFail() }
        XCTAssertEqual(agentId, AG_A)
    }

    func testAContinueIsNotAnsweredByAStopsConfirmation() throws {
        let (driver, effects) = try continuingBusy(.gui, .working)
        guard case let .generateConfirmationId(token, _) = effects[0] else { return XCTFail() }
        try driver.accept(.confirmationIdGenerated(token, CONFIRM))
        XCTAssertEqual(errorCode { try driver.dispatch(.confirmStopAgent(CONFIRM)) }, "invalid_intent")
    }

    func testAContinueIsLetGoOfWhenTheAgentItIsAboutExits() throws {
        let (driver, effects) = try continuingBusy(.gui, .working)
        guard case let .generateConfirmationId(token, _) = effects[0] else { return XCTFail() }
        try driver.accept(.confirmationIdGenerated(token, CONFIRM))
        try driver.dispatch(.reconcileAgents(machine: "local"))
        guard case let .reconcileAgents(round, _)? = driver.drainEffects().first(where: { $0.name == "reconcile_agents" }) else { return XCTFail() }
        try driver.accept(.agentsReconciled(round, AgentReconciliation(exited: [AG_A])))
        _ = driver.drainEffects()
        XCTAssertEqual(errorCode { try driver.dispatch(.confirmContinueAgent(CONFIRM)) }, "invalid_intent")
    }

    // MARK: restarting an Agent's session

    private func restarting(_ presentation: AgentPresentation, _ status: AgentStatus, _ failure: AgentFailureCode? = nil) throws -> Driver {
        let driver = Driver()
        try driver.openFolder("/dev/project")
        try driver.createAgent(presentation)
        try driver.settle()
        try driver.setStatus(AG_A, status, failure: failure.map { AgentFailure(code: $0, detail: "said") })
        return driver
    }

    func testRestartsAnIdleGuiAgentAtOnceAndTheAgentStaysAsItIs() throws {
        let driver = try restarting(.gui, .idle)
        XCTAssertEqual(try driver.dispatch(.restartAgent(AG_A)).kind, "deferred")
        let effects = driver.drainEffects()
        XCTAssertEqual(effects.map(\.name), ["restart_agent"])
        guard case let .restartAgent(token, agentId) = effects[0] else { return XCTFail() }
        XCTAssertEqual(agentId, AG_A)
        XCTAssertEqual(try driver.accept(.agentRestartCompleted(token, AG_A)).kind, "noop")
        XCTAssertEqual(driver.model.agent(AG_A)?.controlState, .running)
        XCTAssertEqual(driver.drainEffects(), [])
    }

    func testRestartAsksFirstWhenAGuiAgentIsNotIdle() throws {
        for status in [AgentStatus.working, .background, .waiting, .error, .unknown] {
            let driver = try restarting(.gui, status)
            try driver.dispatch(.restartAgent(AG_A))
            let effects = driver.drainEffects()
            XCTAssertEqual(effects.map(\.name), ["generate_confirmation_id"])
            guard case let .generateConfirmationId(token, purpose) = effects[0] else { return XCTFail() }
            XCTAssertEqual(purpose, .restartAgent(AG_A))
            guard case let .confirmationRequired(id, _, asked) = try driver.accept(.confirmationIdGenerated(token, CONFIRM)) else { return XCTFail() }
            XCTAssertEqual(id, CONFIRM)
            XCTAssertEqual(asked, .agentRestart(AG_A))
            XCTAssertEqual(driver.drainEffects(), [])
        }
    }

    func testRestartGoesOnOnceConfirmedAndIsNotAnsweredByAStopsOrAContinuesConfirmation() throws {
        let driver = try restarting(.gui, .working)
        try driver.dispatch(.restartAgent(AG_A))
        guard case let .generateConfirmationId(token, _) = driver.drainEffects()[0] else { return XCTFail() }
        try driver.accept(.confirmationIdGenerated(token, CONFIRM))
        XCTAssertEqual(errorCode { try driver.dispatch(.confirmStopAgent(CONFIRM)) }, "invalid_intent")
        XCTAssertEqual(errorCode { try driver.dispatch(.confirmContinueAgent(CONFIRM)) }, "invalid_intent")
        try driver.dispatch(.confirmRestartAgent(CONFIRM))
        let effects = driver.drainEffects()
        guard effects.count == 1, case let .restartAgent(_, agentId) = effects[0] else { return XCTFail() }
        XCTAssertEqual(agentId, AG_A)
    }

    func testRestartsAnIdleTerminalAgentAtOnceAsItDoesAGuiOne() throws {
        let driver = try restarting(.tui, .idle)
        XCTAssertEqual(try driver.dispatch(.restartAgent(AG_A)).kind, "deferred")
        let effects = driver.drainEffects()
        guard effects.count == 1, case let .restartAgent(token, _) = effects[0] else { return XCTFail() }
        try driver.accept(.agentRestartCompleted(token, AG_A))
        XCTAssertEqual(driver.model.agent(AG_A)?.presentation, .tui)
        XCTAssertEqual(driver.model.agent(AG_A)?.controlState, .running)
    }

    func testRestartAsksFirstWhenATerminalAgentIsWorking() throws {
        let driver = try restarting(.tui, .working)
        try driver.dispatch(.restartAgent(AG_A))
        let effects = driver.drainEffects()
        guard effects.count == 1, case let .generateConfirmationId(_, purpose) = effects[0] else { return XCTFail() }
        XCTAssertEqual(purpose, .restartAgent(AG_A))
    }

    func testRestartsAGuiAgentWhoseCliStoppedItselfAtOnce() throws {
        for failure in [AgentFailureCode.conversationNotSignedIn, .conversationRefused] {
            let driver = try restarting(.gui, .error, failure)
            XCTAssertEqual(try driver.dispatch(.restartAgent(AG_A)).kind, "deferred")
            XCTAssertEqual(driver.drainEffects().map(\.name), ["restart_agent"])
        }
    }

    func testRestartIsRefusedSayingWhyForAConversationDevHubStoppedReading() throws {
        let driver = try restarting(.gui, .error, .conversationProtocolMismatch)
        let refusal = refusalOf { try driver.dispatch(.restartAgent(AG_A)) } as? NamedFailure
        XCTAssertNotNil(refusal)
        XCTAssertTrue(refusal?.wire.detail?.contains("would stop there again after a restart") == true)
        XCTAssertEqual(driver.drainEffects(), [])
    }

    // MARK: how a launched agent is shown

    private func requested(_ profile: AgentProfile, _ agentPresentation: AgentPresentation? = nil) throws -> (Driver, Error?, [Effect]) {
        let driver = Driver()
        try driver.openFolder("/dev/project")
        try driver.dispatch(.createAgent(workspaceId: WS_A, profileId: profile.id, presentation: .full, agentPresentation: agentPresentation))
        guard case let .resolveAgentProfile(token, _, _, _, _) = driver.drainEffects()[0] else { throw InvariantViolation("unexpected") }
        let refusal = refusalOf { try driver.accept(.profileResolutionCompleted(token, WS_A, .resolved(profile))) }
        return (driver, refusal, driver.drainEffects())
    }

    private func launched(_ driver: Driver, _ next: [Effect]) throws -> Effect {
        try driver.answer(next[0])
        let launch = driver.drainEffects()[0]
        XCTAssertEqual(launch.name, "launch_agent")
        return launch
    }

    func testALaunchedAgentIsTheProfilesDefaultWhenTheRequestDoesNotSay() throws {
        let (driver, _, next) = try requested(codex)
        let launch = try launched(driver, next)
        guard case let .launchAgent(_, _, _, _, presentation) = launch else { return XCTFail() }
        XCTAssertEqual(presentation, .tui)
        try driver.answer(launch)
        try driver.settle()
        XCTAssertEqual(driver.snapshot.workspaces[1].agents.first?.presentation, .tui)
    }

    func testALaunchedAgentIsWhatTheRequestAskedFor() throws {
        let (driver, _, next) = try requested(codex, .gui)
        let launch = try launched(driver, next)
        guard case let .launchAgent(_, _, _, _, presentation) = launch else { return XCTFail() }
        XCTAssertEqual(presentation, .gui)
        try driver.answer(launch)
        try driver.settle()
        let agent = driver.snapshot.workspaces[1].agents.first
        XCTAssertEqual(agent?.presentation, .gui)
        XCTAssertEqual(agent?.profile.presentation, .tui)
    }

    func testRefusesGuiForAProfileWhoseKindHasNoneBeforeAnythingStarts() throws {
        let cursor = profile("cursor", "Cursor", kind: .cursor, command: "cursor-agent")
        let (_, refusal, next) = try requested(cursor, .gui)
        XCTAssertTrue(refusal is NamedFailure)
        XCTAssertEqual(next, [])
        let wire = errorWire(refusal!)
        XCTAssertEqual(wire.code, .agentProfileUnavailable)
        XCTAssertEqual(wire.summary, "The agent could not start from this profile.")
        XCTAssertEqual(wire.detail, "“Cursor” cannot open as GUI: only Claude and Codex profiles can. It can open as a terminal.")
    }

    func testNamesALaunchRefusedForItsPresentationAsTheProfiles() throws {
        let (driver, _, next) = try requested(codex, .gui)
        guard case let .launchAgent(token, _, _, _, _) = try launched(driver, next) else { return XCTFail() }
        let refusal = refusalOf {
            try driver.accept(.agentLaunchCompleted(token, WS_A, AG_A, .failed(code: .agentProfileUnavailable, detail: "GUI mode is not available yet.")))
        }
        let wire = errorWire(refusal!)
        XCTAssertEqual(wire.code, .agentProfileUnavailable)
        XCTAssertEqual(wire.detail, "GUI mode is not available yet.")
        XCTAssertEqual(driver.snapshot.workspaces[1].agents.count, 0)
    }

    // MARK: stopping an agent

    private func withAgent(_ status: AgentStatus) throws -> Driver {
        let driver = Driver()
        try driver.openFolder("/dev/project")
        try driver.createAgent()
        try driver.settle()
        if status != .unknown {
            try driver.dispatch(.reconcileAgents(machine: "local"))
            guard case let .reconcileAgents(token, _)? = driver.drainEffects().first(where: { $0.name == "reconcile_agents" }) else {
                throw InvariantViolation("the coordinator did not ask for a reconcile")
            }
            try driver.accept(.agentsReconciled(token, AgentReconciliation(observations: [
                AgentObservation(agentId: AG_A, status: status, runtimeHealth: .healthy),
            ])))
            _ = driver.drainEffects()
        }
        return driver
    }

    func testStopsAnIdleAgentWhereItStandsWithNoQuestion() throws {
        let driver = try withAgent(.idle)
        XCTAssertNotEqual(try driver.dispatch(.stopAgent(AG_A)).kind, "confirmation_required")
        let effects = driver.drainEffects()
        XCTAssertTrue(effects.map(\.name).contains("stop_agent"))
        for effect in effects { try driver.answer(effect) }
        try driver.settle()
        XCTAssertEqual(driver.snapshot.workspaces[1].agents.count, 0)
    }

    func testAsksAboutAnIdleAgentWithItsTerminalOpenAndCanKeepTheTerminal() throws {
        let driver = try withAgent(.idle)
        try driver.dispatch(.agentTerminalOpened(AG_A, terminalId: AG_A.rawValue, focus: false))
        _ = driver.drainEffects()
        try driver.dispatch(.stopAgent(AG_A))
        guard case let .generateConfirmationId(token, _) = driver.drainEffects()[0] else { return XCTFail() }
        guard case let .confirmationRequired(_, _, purpose) = try driver.accept(.confirmationIdGenerated(token, CONFIRM)) else { return XCTFail() }
        XCTAssertEqual(purpose, .agentStop(AG_A, terminal: true))
        try driver.dispatch(.confirmStopAgent(CONFIRM, moveTerminal: true))
        guard case let .stopAgent(_, agentId, moveTerminal)? = driver.drainEffects().first(where: { $0.name == "stop_agent" }) else { return XCTFail() }
        XCTAssertEqual(agentId, AG_A)
        XCTAssertTrue(moveTerminal)
    }

    func testAsksBeforeStoppingAnAgentThatIsWorking() throws {
        let driver = try withAgent(.working)
        try driver.dispatch(.stopAgent(AG_A))
        guard case let .generateConfirmationId(token, _) = driver.drainEffects()[0] else { return XCTFail() }
        XCTAssertEqual(try driver.accept(.confirmationIdGenerated(token, CONFIRM)).kind, "confirmation_required")
        XCTAssertEqual(driver.snapshot.workspaces[1].agents.count, 1)
    }

    func testAsksBeforeStoppingABackgroundAgentOrOneNobodyHasRead() throws {
        for status in [AgentStatus.background, .unknown] {
            let driver = try withAgent(status)
            try driver.dispatch(.stopAgent(AG_A))
            XCTAssertEqual(driver.drainEffects()[0].name, "generate_confirmation_id")
        }
    }

    func testConfirmsStopsAndRemovesTheAgent() throws {
        let driver = Driver()
        try driver.openFolder("/dev/project")
        try driver.createAgent()
        try driver.settle()
        try driver.dispatch(.stopAgent(AG_A))
        guard case let .generateConfirmationId(token, _) = driver.drainEffects()[0] else { return XCTFail() }
        XCTAssertEqual(try driver.accept(.confirmationIdGenerated(token, CONFIRM)).kind, "confirmation_required")
        try driver.dispatch(.confirmStopAgent(CONFIRM))
        try driver.settle()
        XCTAssertEqual(driver.snapshot.workspaces[1].agents.count, 0)
    }

    func testKeepsAFailedStopRetryableAndRefusesItInThePortsOwnWords() throws {
        let driver = Driver()
        try driver.openFolder("/dev/project")
        try driver.createAgent()
        try driver.settle()
        try driver.dispatch(.stopAgent(AG_A))
        guard case let .generateConfirmationId(token, _) = driver.drainEffects()[0] else { return XCTFail() }
        try driver.accept(.confirmationIdGenerated(token, CONFIRM))
        try driver.dispatch(.confirmStopAgent(CONFIRM))
        guard case let .stopAgent(stop, _, _)? = driver.drainEffects().first(where: { $0.name == "stop_agent" }) else { return XCTFail() }
        let refusal = refusalOf {
            try driver.accept(.agentStopCompleted(stop, AG_A, .failed(code: .tmuxCommandTimedOut, detail: "tmux did not answer kill-session within 5 seconds.")))
        }
        let wire = errorWire(refusal!)
        XCTAssertEqual(wire.code, .tmuxCommandTimedOut)
        XCTAssertEqual(wire.detail, "tmux did not answer kill-session within 5 seconds.")
        XCTAssertEqual(driver.snapshot.workspaces[1].agents[0].controlState, .stopFailed(diagnostic: .cleanupFailed))
    }

    func testAnAgentTheModelCouldNotTakeIsTerminated() throws {
        let driver = Driver()
        try driver.openFolder("/dev/project")
        try driver.createAgent()
        try driver.settle()
        try driver.createAgent()
        var terminate: OperationToken?
        for _ in 0..<8 where terminate == nil {
            for effect in driver.drainEffects() {
                if case let .terminateAgent(token, _) = effect {
                    terminate = token
                    continue
                }
                if effect.name == "launch_agent" {
                    XCTAssertTrue(refusalOf { try driver.answer(effect) } is NamedFailure)
                } else {
                    try driver.answer(effect)
                }
            }
        }
        guard let terminate else { return XCTFail() }
        let refusal = refusalOf {
            try driver.accept(.agentTerminationCompleted(terminate, AG_A, .failed(code: .tmuxCommandFailed, detail: "tmux kill-session exited with status 1.")))
        }
        let wire = errorWire(refusal!)
        XCTAssertEqual(wire.code, .tmuxCommandFailed)
        XCTAssertEqual(wire.detail, "tmux kill-session exited with status 1.")
    }

    func testACloseCompletionNobodyIsWaitingForIsRefused() throws {
        let (driver, effect) = try atTheFirstStep()
        try driver.accept(.workspaceCloseCompleted(closeToken(effect), WS_A, .closed))
        XCTAssertNotNil(refusalOf { try driver.accept(.workspaceCloseCompleted(self.closeToken(effect), WS_A, .closed)) })
    }

    // MARK: persistence, replay, detaching

    func testReportsAFailedSaveAsDegradedRatherThanLosingIt() throws {
        let driver = Driver()
        try driver.dispatch(.resizeSidebar(width: 300))
        guard case let .persistState(token) = driver.drainEffects()[0] else { return XCTFail() }
        XCTAssertEqual(try driver.accept(.statePersistenceFailed(token, reason: "/state.json: permission was denied (EACCES)")).kind, "persistence_degraded")
    }

    func testSaysWhichFileCouldNotBeSavedAndWhy() throws {
        let driver = Driver()
        try driver.dispatch(.resizeSidebar(width: 300))
        guard case let .persistState(token) = driver.drainEffects()[0] else { return XCTFail() }
        try driver.accept(.statePersistenceFailed(token, reason: "/state.json: permission was denied (EACCES)"))
        let errors = driver.drainErrors()
        XCTAssertEqual(errors.count, 1)
        XCTAssertEqual(errors[0].wire.code, .persistenceDegraded)
        XCTAssertEqual(errors[0].wire.detail, "/state.json: permission was denied (EACCES)")
    }

    func testHandsANewSubscriberTheFullHistoryAndItsCursor() throws {
        let driver = Driver()
        try driver.dispatch(.resizeSidebar(width: 300))
        let replay = driver.coordinator.replayFrom(0)
        XCTAssertFalse(replay.historyGap)
        XCTAssertGreaterThan(replay.events.count, 0)
        XCTAssertEqual(replay.cursor, replay.events.last?.sequence)
    }

    func testEmitsOneDetachEffectAndAnswersEveryLaterIntentAsDetached() throws {
        let driver = Driver()
        try driver.dispatch(.quit)
        XCTAssertEqual(driver.drainEffects(), [.detach(.quit)])
        XCTAssertEqual(try driver.dispatch(.resizeSidebar(width: 300)).kind, "detached")
        XCTAssertEqual(driver.drainEffects(), [])
    }

    func testClosingAgainAfterACloseThatFailedStartsFromTheBeginningAndFinishes() throws {
        let (driver, effect) = try atTheFirstStep()
        try driver.accept(.workspaceCloseCompleted(closeToken(effect), WS_A, .failed(step: .editor, diagnostic: .closeEditorVetoed, detail: nil)))
        try driver.settle()
        guard case .failed = driver.snapshot.workspaces[1].close else { return XCTFail() }
        try driver.dispatch(closeIntent())
        let again = driver.drainEffects()
        XCTAssertEqual(again.map(\.name), ["inspect_workspace"])
        for effect in again { try driver.answer(effect) }
        try driver.settle()
        XCTAssertEqual(driver.snapshot.workspaces.count, 1)
    }

    // MARK: reconciling agents

    private func reconcilingDriver() throws -> Driver {
        let driver = Driver()
        try driver.openFolder("/dev/project")
        try driver.createAgent()
        try driver.settle()
        return driver
    }

    private func reconcileToken(_ driver: Driver) throws -> OperationToken {
        try driver.dispatch(.reconcileAgents(machine: "local"))
        guard case let .reconcileAgents(token, _)? = driver.drainEffects().first(where: { $0.name == "reconcile_agents" }) else { throw InvariantViolation("no reconcile") }
        return token
    }

    func testAsksTheProviderAboutEveryAgentAtOnce() throws {
        let driver = try reconcilingDriver()
        try driver.dispatch(.reconcileAgents(machine: "local"))
        XCTAssertEqual(driver.drainEffects().map(\.name), ["reconcile_agents"])
    }

    func testKeepsTwoMachinesRoundsApart() throws {
        let driver = try reconcilingDriver()
        try driver.dispatch(.reconcileAgents(machine: "local"))
        guard case let .reconcileAgents(first, _) = driver.drainEffects()[0] else { return XCTFail() }
        try driver.dispatch(.reconcileAgents(machine: "ssh:build.example.com"))
        guard case let .reconcileAgents(second, _) = driver.drainEffects()[0] else { return XCTFail() }
        try driver.accept(.agentsReconciled(second, AgentReconciliation()))
        XCTAssertNoThrow(try driver.accept(.agentsReconciled(first, AgentReconciliation())))
    }

    func testProjectsWhatTheProviderReportedOntoTheRows() throws {
        let driver = try reconcilingDriver()
        let token = try reconcileToken(driver)
        try driver.accept(.agentsReconciled(token, AgentReconciliation(observations: [
            AgentObservation(agentId: AG_A, status: .working, runtimeHealth: .healthy),
        ])))
        let agent = driver.snapshot.workspaces[1].agents[0]
        XCTAssertEqual(agent.status, .working)
        XCTAssertEqual(agent.runtimeHealth, .healthy)
    }

    func testCarriesWhatTheAgentSaysItIsDoingOntoItsRow() throws {
        let driver = try reconcilingDriver()
        func said(_ activity: String?) throws -> String? {
            let token = try reconcileToken(driver)
            try driver.accept(.agentsReconciled(token, AgentReconciliation(observations: [
                AgentObservation(agentId: AG_A, status: .working, runtimeHealth: .healthy, activity: activity),
            ])))
            return driver.snapshot.workspaces[1].agents[0].activity
        }
        XCTAssertEqual(try said("Reading agentReconciler.ts"), "Reading agentReconciler.ts")
        XCTAssertNil(try said(nil))
    }

    func testTakesTheRowAwayWhenTheProviderSaysTheAgentIsGone() throws {
        let driver = try reconcilingDriver()
        let token = try reconcileToken(driver)
        try driver.accept(.agentsReconciled(token, AgentReconciliation(exited: [AG_A])))
        XCTAssertEqual(driver.snapshot.workspaces[1].agents.count, 0)
    }

    func testAnnouncesARoundItSuperseded() throws {
        let driver = try reconcilingDriver()
        let superseded = try reconcileToken(driver)
        try driver.dispatch(.reconcileAgents(machine: "local"))
        let events = driver.coordinator.subscribeFrom(0).events.map(\.event)
        XCTAssertTrue(events.contains { if case let .operationCompleted(token) = $0 { return token.operationId == superseded.operationId } else { return false } })
    }

    func testAnAgentReconcileOfOneAgentReadsItAndMayFindItGone() throws {
        let driver = try reconcilingDriver()
        try driver.dispatch(.reconcileAgent(AG_A))
        guard case let .reconcileAgent(token, _) = driver.drainEffects()[0] else { return XCTFail() }
        XCTAssertEqual(try driver.accept(.agentStatusChanged(token, AG_A, status: .working, runtimeHealth: .healthy)).kind, "updated")
        try driver.dispatch(.reconcileAgent(AG_A))
        guard case let .reconcileAgent(gone, _)? = driver.drainEffects().first(where: { $0.name == "reconcile_agent" }) else { return XCTFail() }
        XCTAssertEqual(try driver.accept(.agentExited(gone, AG_A)).kind, "updated")
        XCTAssertNil(driver.model.agent(AG_A))
    }

    // MARK: the window coming and going

    func testCarriesTheWindowsFocusIntoTheModel() throws {
        let driver = Driver()
        XCTAssertTrue(driver.model.windowFocused)
        XCTAssertEqual(try driver.dispatch(.windowFocusChanged(false)).kind, "updated")
        XCTAssertFalse(driver.model.windowFocused)
        XCTAssertEqual(try driver.dispatch(.windowFocusChanged(false)).kind, "noop")
        try driver.dispatch(.windowFocusChanged(true))
        XCTAssertTrue(driver.model.windowFocused)
    }

    // MARK: Scratch

    private let WS_DAY = WorkspaceId(unchecked: "550e8400-e29b-41d4-a716-4466554400d0")

    func testMakesTheAdoptedDaysFolderScratchAndPersistsIt() throws {
        let driver = Driver()
        let yesterday = driver.model.scratchWorkspaceId
        let tomorrow = "/scratch-test/junk/20260924"
        XCTAssertEqual(try driver.dispatch(.adoptScratchDay(WS_DAY, location: .local(path: tomorrow), selectedPath: tomorrow)).kind, "updated")
        XCTAssertTrue(driver.drainEffects().map(\.name).contains("persist_state"))
        XCTAssertEqual(driver.snapshot.scratchWorkspaceId, WS_DAY)
        XCTAssertEqual(driver.snapshot.workspaces.map(\.id), [yesterday, WS_DAY])
    }

    func testDoesNothingWhenTheDayIsTheOneScratchAlreadyIs() throws {
        let driver = Driver()
        XCTAssertEqual(try driver.dispatch(.adoptScratchDay(WS_DAY, location: .local(path: scratchPath), selectedPath: scratchPath)).kind, "noop")
        XCTAssertEqual(driver.snapshot.workspaces.count, 1)
    }

    func testRefusesToCloseTodaysScratch() {
        let driver = Driver()
        let scratch = driver.model.scratchWorkspaceId
        XCTAssertEqual(errorCode { try driver.dispatch(.requestCloseWorkspace(scratch, worktree: .keep)) }, "invalid_intent")
        XCTAssertNotNil(driver.model.workspace(scratch))
    }

    func testAnswersANewWindowWithNoFolderBySelectingScratch() throws {
        let driver = Driver()
        try driver.openFolder("/dev/project")
        try driver.dispatch(.newWindow(path: nil))
        XCTAssertEqual(driver.snapshot.selection.context, .workspace(driver.model.scratchWorkspaceId))
    }

    // MARK: where a close lands

    private let S1 = aid("00000000-0000-4000-8000-0000000000f1")
    private let S2 = aid("00000000-0000-4000-8000-0000000000f2")
    private let A1 = aid("00000000-0000-4000-8000-0000000000a1")
    private let A2 = aid("00000000-0000-4000-8000-0000000000a2")
    private let A3 = aid("00000000-0000-4000-8000-0000000000a3")
    private let B1 = aid("00000000-0000-4000-8000-0000000000b1")
    private let C1 = aid("00000000-0000-4000-8000-0000000000c1")
    private let C2 = aid("00000000-0000-4000-8000-0000000000c2")
    private let ALPHA = wid("00000000-0000-4000-8000-00000000000a")
    private let BRAVO = wid("00000000-0000-4000-8000-00000000000b")
    private let CHARLIE = wid("00000000-0000-4000-8000-00000000000c")

    private func arranged() throws -> Driver {
        var model = scratchModel()
        try model.addWorkspace(localWorkspace("/dev/charlie", id: CHARLIE.rawValue))
        try model.addWorkspace(localWorkspace("/dev/alpha", id: ALPHA.rawValue))
        try model.addWorkspace(localWorkspace("/dev/bravo", id: BRAVO.rawValue))
        for (id, owner) in [(S1, model.scratchWorkspaceId), (S2, model.scratchWorkspaceId), (A1, ALPHA), (A2, ALPHA), (A3, ALPHA), (B1, BRAVO), (C1, CHARLIE), (C2, CHARLIE)] {
            try model.add(owner, id)
            try model.setAgentStatus(id, .idle)
        }
        return Driver(coordinatorFor(model))
    }

    private func select(_ driver: Driver, _ context: NavigationContext) throws {
        try driver.dispatch(.selectContext(context, presentation: .full))
        try driver.settle()
    }

    private func closeAgent(_ driver: Driver, _ id: AgentId) throws {
        try driver.dispatch(.stopAgent(id))
        try driver.settle()
    }

    private func closeWorkspace(_ driver: Driver, _ id: WorkspaceId) throws {
        try driver.dispatch(.requestCloseWorkspace(id, worktree: .keep))
        try driver.settle()
    }

    func testClosingAnAgentInTheMiddleLandsOnTheOneAfterIt() throws {
        let driver = try arranged()
        try select(driver, .agent(A2))
        try closeAgent(driver, A2)
        XCTAssertEqual(driver.snapshot.selection.context, .agent(A3))
    }

    func testClosingAWorkspacesLastAgentLandsOnTheAgentAboveIt() throws {
        let driver = try arranged()
        try select(driver, .agent(A3))
        try closeAgent(driver, A3)
        XCTAssertEqual(driver.snapshot.selection.context, .agent(A2))
    }

    func testClosingAWorkspacesOnlyAgentLandsOnTheWorkspacesOwnRow() throws {
        let driver = try arranged()
        try select(driver, .agent(B1))
        try closeAgent(driver, B1)
        XCTAssertEqual(driver.snapshot.selection.context, .workspace(BRAVO))
    }

    func testClosingTheLastRowOnScreenLandsOnTheAgentAboveItThenOnItsWorkspace() throws {
        let driver = try arranged()
        try select(driver, .agent(C2))
        try closeAgent(driver, C2)
        XCTAssertEqual(driver.snapshot.selection.context, .agent(C1))
        try closeAgent(driver, C1)
        XCTAssertEqual(driver.snapshot.selection.context, .workspace(CHARLIE))
    }

    func testClosesScratchsAgentsByTheSameRuleAndStaysInScratch() throws {
        let driver = try arranged()
        let scratch = driver.model.scratchWorkspaceId
        try select(driver, .agent(S1))
        try closeAgent(driver, S1)
        XCTAssertEqual(driver.snapshot.selection.context, .agent(S2))
        try closeAgent(driver, S2)
        XCTAssertEqual(driver.snapshot.selection.context, .workspace(scratch))
    }

    func testAnAgentThatExitsOnItsOwnIsReplacedByTheSameRule() throws {
        let driver = try arranged()
        try select(driver, .agent(A3))
        try driver.dispatch(.reconcileAgents(machine: "local"))
        guard case let .reconcileAgents(token, _)? = driver.drainEffects().first(where: { $0.name == "reconcile_agents" }) else { return XCTFail() }
        try driver.accept(.agentsReconciled(token, AgentReconciliation(exited: [A3])))
        XCTAssertEqual(driver.snapshot.selection.context, .agent(A2))
    }

    func testClosingTheLastRowLandsOnTheOneBeforeIt() throws {
        let driver = try arranged()
        try select(driver, .workspace(CHARLIE))
        try closeWorkspace(driver, CHARLIE)
        XCTAssertEqual(driver.snapshot.selection.context, .agent(B1))
    }

    func testClosingAWorkspaceWithAgentsLandsOnTheRowAfterAllOfThem() throws {
        let driver = try arranged()
        try select(driver, .agent(B1))
        try closeWorkspace(driver, BRAVO)
        XCTAssertEqual(driver.snapshot.selection.context, .workspace(CHARLIE))
    }

    func testClosingAWorkspaceFromInsideOneOfItsAgentsSkipsItsOtherAgents() throws {
        let driver = try arranged()
        try select(driver, .agent(A1))
        try closeWorkspace(driver, ALPHA)
        XCTAssertEqual(driver.snapshot.selection.context, .workspace(BRAVO))
    }

    func testClosingWhatIsNotSelectedLeavesTheSelectionWhereItIs() throws {
        let driver = try arranged()
        try select(driver, .agent(A2))
        try closeWorkspace(driver, BRAVO)
        try closeAgent(driver, A3)
        XCTAssertEqual(driver.snapshot.selection.context, .agent(A2))
    }

    func testAnAgentCloseThatAsksMovesNothingUntilItIsConfirmed() throws {
        let driver = try arranged()
        try driver.setStatus(A3, .working)
        try select(driver, .agent(A3))
        try driver.dispatch(.stopAgent(A3))
        XCTAssertEqual(try driver.answer(driver.drainEffects()[0])?.kind, "confirmation_required")
        XCTAssertEqual(driver.drainEffects().count, 0)
        XCTAssertEqual(driver.snapshot.selection.context, .agent(A3))
        try driver.dispatch(.confirmStopAgent(CONFIRM))
        try driver.settle()
        XCTAssertEqual(driver.snapshot.selection.context, .agent(A2))
    }

    func testAWorkspaceCloseThatAsksMovesNothingUntilItIsConfirmed() throws {
        let driver = try arranged()
        try select(driver, .agent(B1))
        try driver.dispatch(.requestCloseWorkspace(BRAVO, worktree: .keep))
        let inspect = driver.drainEffects()[0]
        XCTAssertEqual(inspect.name, "inspect_workspace")
        try driver.answer(inspect, CloseInspectionInputs(unsavedEditors: .of(["main.ts"])))
        XCTAssertEqual(try driver.answer(driver.drainEffects()[0])?.kind, "confirmation_required")
        XCTAssertEqual(driver.drainEffects().count, 0)
        XCTAssertEqual(driver.snapshot.selection.context, .agent(B1))
        try driver.dispatch(.confirmCloseWorkspace(CONFIRM))
        try driver.settle()
        XCTAssertEqual(driver.snapshot.selection.context, .workspace(CHARLIE))
    }

    // MARK: a launch that resumes a session

    func testAsksMainForTheProfileWithTheSessionToResumeByIdAlone() throws {
        let driver = Driver()
        try driver.openFolder("/dev/project")
        try driver.dispatch(.createAgent(workspaceId: WS_A, profileId: "claude", presentation: .full, agentPresentation: .gui, resume: "session-1"))
        guard case let .resolveAgentProfile(_, _, _, extraArgs, resume) = driver.drainEffects()[0] else { return XCTFail() }
        XCTAssertEqual(extraArgs, [])
        XCTAssertEqual(resume, "session-1")
    }

    func testTakesTheSessionAPastSessionRowNamesOffTheWire() throws {
        func request(_ resume: String) throws -> UserIntent {
            try UserIntent.fromWire(.requestCreateAgent(workspaceId: WS_A.rawValue, profileId: "codex", presentation: "tui", resume: resume))
        }
        guard case let .createAgent(_, _, _, _, presentation, resume) = try request("0199a1b2-thread") else { return XCTFail() }
        XCTAssertEqual(presentation, .tui)
        XCTAssertEqual(resume, "0199a1b2-thread")
        XCTAssertEqual(errorCode { try request("--dangerously-skip-permissions") }, "invalid_intent")
        XCTAssertEqual(errorCode { try request("a b") }, "invalid_intent")
    }
}

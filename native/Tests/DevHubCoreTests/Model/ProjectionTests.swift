// Port of apps/desktop/src/model/wire.test.ts. The checks that a wire value
// of the wrong JavaScript type is refused have no Swift counterpart — the
// wire here is typed, so a string where a number belongs does not compile —
// and every other rule is pinned as the TypeScript test pins it.

import XCTest
@testable import DevHubCore

private let P_WS = WorkspaceId(unchecked: "22222222-2222-4222-8222-222222222222")
private let P_AG = AgentId(unchecked: "33333333-3333-4333-8333-333333333333")

private func project(_ model: AppModel, repositoryOf: @escaping Projection.RepositoryOf = { _ in nil },
                     homeOf: @escaping Projection.HomeOf = { _ in nil }) throws -> AppSnapshotWire {
    try Projection.snapshotWire(model.snapshot(), readiness: .ready, repositoryOf: repositoryOf, homeOf: homeOf)
}

private func withWorkspace(_ path: String = "/example", location: WorkspaceLocation? = nil) throws -> AppModel {
    var model = scratchModel()
    try model.addWorkspace(Workspace(id: P_WS, location: location ?? .local(path: path), selectedPath: path))
    return model
}

private func withAgent(_ presentation: AgentPresentation = .tui) throws -> AppModel {
    var model = try withWorkspace("/dev/w")
    try model.addAgent(owner: P_WS, id: P_AG, profile: profile(kind: .claude, presentation: presentation), agentPresentation: presentation)
    try model.selectContext(.agent(P_AG))
    return model
}

private func row(_ wire: AppSnapshotWire) -> WorkspaceWire? { wire.workspaces.first { $0.id == P_WS.rawValue } }

final class ProjectionStateTests: XCTestCase {
    func testCarriesEachWorkspaceStateWhole() throws {
        var model = try withWorkspace()
        XCTAssertEqual(row(try project(model))?.state, .available)
        try model.markWorkspaceUnavailable(P_WS, .rootMissing)
        XCTAssertEqual(row(try project(model))?.state, .unavailable(reason: .rootMissing))
    }

    func testCarriesBothHalvesOfACloseFailureTheStepAndTheReason() throws {
        for step in CloseStep.allCases {
            for diagnostic in DiagnosticCode.allCases {
                var model = try withWorkspace()
                try model.beginWorkspaceClose(P_WS)
                try model.markWorkspaceCloseFailed(P_WS, step: step, diagnostic: diagnostic)
                XCTAssertEqual(row(try project(model))?.close, .failed(step: step, diagnostic: diagnostic, detail: nil))
            }
        }
    }

    func testSaysNothingAboutACloseInTheWorkspacesAvailability() throws {
        var model = try withWorkspace()
        try model.beginWorkspaceClose(P_WS)
        try model.markWorkspaceUnavailable(P_WS, .rootMissing)
        let projected = row(try project(model))
        XCTAssertEqual(projected?.state, .unavailable(reason: .rootMissing))
        XCTAssertEqual(projected?.close, .running)
    }

    func testCarriesTheReasonAStopFailedWhicheverItIs() throws {
        for diagnostic in DiagnosticCode.allCases {
            var model = try withAgent()
            try model.requestAgentStop(P_AG)
            try model.markAgentStopFailed(P_AG, diagnostic)
            XCTAssertEqual(row(try project(model))?.agents.first?.controlState, .stopFailed(diagnostic: diagnostic))
        }
    }

    // MARK: the order the projection puts the rows in

    private let A = WorkspaceId(unchecked: "22222222-2222-4222-8222-22222222000a")
    private let B = WorkspaceId(unchecked: "22222222-2222-4222-8222-22222222000b")
    private let W = WorkspaceId(unchecked: "22222222-2222-4222-8222-22222222000c")

    private func ordered(_ order: [WorkspaceId]) throws -> [WorkspaceWire] {
        var model = scratchModel()
        try model.addWorkspace(Workspace(id: B, location: .local(path: "/b"), selectedPath: "/b"))
        try model.addWorkspace(Workspace(id: A, location: .local(path: "/a"), selectedPath: "/a"))
        try model.addWorkspace(Workspace(id: W, location: .local(path: "/a_wt"), selectedPath: "/a_wt"))
        _ = model.setWorkspaceOrder(order)
        let a = A.rawValue, w = W.rawValue
        return try project(model, repositoryOf: { $0 == a || $0 == w ? "/a" : nil }).workspaces.filter { $0.root != scratchPath }
    }

    func testSaysWhichGroupEachRowIsIn() throws {
        let rows = try ordered([])
        XCTAssertEqual(rows.map(\.root), ["/a", "/a_wt", "/b"])
        XCTAssertEqual(rows.map(\.groupKey), ["/a", "/a", "/b"])
    }

    func testAppliesThePersonsArrangementOverTheAutomaticRule() throws {
        XCTAssertEqual(try ordered([B, A]).map(\.root), ["/b", "/a", "/a_wt"])
    }

    // MARK: the path a row shows

    private let home = "/Users/example"
    private let remoteHome = "/volume1/home/example"

    private func rowAt(_ root: String, _ location: WorkspaceLocation, home: @escaping (String) -> String?) throws -> WorkspaceWire? {
        let model = try withWorkspace(root, location: location)
        return row(try project(model, homeOf: { at in
            if case let .ssh(host, _) = at { return home(host) }
            return home("local")
        }))
    }

    func testAbbreviatesAFolderUnderThisMachinesHome() throws {
        let one = try rowAt("\(home)/projects/x", .local(path: "\(home)/projects/x")) { _ in self.home }
        XCTAssertEqual(one?.displayRoot, "~/projects/x")
        XCTAssertEqual(one?.root, "\(home)/projects/x")
    }

    func testLeavesAFolderThatIsNotUnderItAlone() throws {
        XCTAssertEqual(try rowAt("/srv/api", .local(path: "/srv/api")) { _ in self.home }?.displayRoot, "/srv/api")
    }

    func testUsesTheRemoteMachinesHomeForARemoteFolder() throws {
        let one = try rowAt("\(remoteHome)/api", .ssh(host: "nas", path: "\(remoteHome)/api")) { id in
            id == "nas" ? self.remoteHome : self.home
        }
        XCTAssertEqual(one?.displayRoot, "~/api")
    }

    func testShowsTheTruePathUntilTheMachineHasAnswered() throws {
        let one = try rowAt("\(remoteHome)/api", .ssh(host: "nas", path: "\(remoteHome)/api")) { _ in "" }
        XCTAssertEqual(one?.displayRoot, "\(remoteHome)/api")
    }
}

final class ProjectionIntentTests: XCTestCase {
    // MARK: where the Smart Buttons were dragged

    private func place(_ spot: SmartButtonsSpot?, _ presentation: String = "tui") throws -> UserIntent {
        try UserIntent.fromWire(.placeSmartButtons(presentation: presentation, spot: spot))
    }

    private func refused(_ body: () throws -> UserIntent) -> Bool {
        do {
            _ = try body()
            return false
        } catch let error as NamedFailure {
            return error.code == .invalidIntent
        } catch {
            return false
        }
    }

    func testCarriesAPlaceAndAPutBackAsNoPlace() throws {
        let free = SmartButtonsSpot.free(SmartButtonsOffset(right: 20, bottom: 30))
        XCTAssertEqual(try place(free), .placeSmartButtons(.tui, free))
        XCTAssertEqual(try place(.anchored(edge: .top, along: 40), "gui"), .placeSmartButtons(.gui, .anchored(edge: .top, along: 40)))
        XCTAssertEqual(try place(nil, "gui"), .placeSmartButtons(.gui, nil))
    }

    func testRefusesAPlaceThatIsNotOneAndAPresentationThatIsNeither() {
        XCTAssertTrue(refused { try place(.free(SmartButtonsOffset(right: -3, bottom: 0))) })
        XCTAssertTrue(refused { try place(.anchored(edge: .top, along: -1)) })
        XCTAssertTrue(refused { try place(.free(SmartButtonsOffset(right: 0, bottom: 0)), "sideways") })
    }

    // MARK: an automatic action ticked

    private let agent = "33333333-3333-4333-8333-333333333333"

    func testCarriesWhichActionForWhichAgentOnOrOff() throws {
        XCTAssertEqual(
            try UserIntent.fromWire(.setAutomaticAction(agentId: agent, actionId: "fix_ci", automatic: true)),
            .setAutomaticAction(AgentId(unchecked: agent), actionId: "fix_ci", automatic: true))
    }

    func testRefusesAnActionThatIsNotNamed() {
        XCTAssertTrue(refused { try UserIntent.fromWire(.setAutomaticAction(agentId: self.agent, actionId: "", automatic: true)) })
    }

    // MARK: how an Agent is shown

    private func request(_ presentation: String?) throws -> UserIntent {
        try UserIntent.fromWire(.requestCreateAgent(
            workspaceId: P_WS.rawValue, profileId: "claude", presentation: presentation))
    }

    func testCarriesThePresentationANewAgentAskedFor() throws {
        guard case let .createAgent(_, _, _, _, agentPresentation, _) = try request("gui") else { return XCTFail() }
        XCTAssertEqual(agentPresentation, .gui)
    }

    func testLeavesItToTheProfileWhenTheRequestDoesNotSay() throws {
        guard case let .createAgent(_, _, _, _, agentPresentation, _) = try request(nil) else { return XCTFail() }
        XCTAssertNil(agentPresentation)
    }

    func testRefusesAPresentationThatIsNeither() {
        XCTAssertTrue(refused { try request("sideways") })
    }

    func testOffersEachProfilesDefaultAndEveryPresentationItsKindHas() throws {
        let claude = try AgentProfile.create(id: "claude", displayName: "Claude", kind: .claude, command: "claude", presentation: .gui)
        let cursor = try AgentProfile.create(id: "cursor", displayName: "Cursor", kind: .cursor, command: "cursor-agent")
        let wires = [claude, cursor].map(AgentProfileWire.init)
        XCTAssertEqual(wires.map(\.id), ["claude", "cursor"])
        XCTAssertEqual(wires.map(\.displayName), ["Claude", "Cursor"])
        XCTAssertEqual(wires.map(\.kind), [.claude, .cursor])
        XCTAssertEqual(wires.map(\.presentation), [.gui, .tui])
        XCTAssertEqual(wires.map(\.presentations), [[.tui, .gui], [.tui]])
    }

    func testSaysHowEachAgentWasLaunched() throws {
        XCTAssertEqual(row(try project(try withAgent(.gui)))?.agents.first?.presentation, .gui)
    }

    // MARK: an Agent's terminal

    func testProjectsTheAgentsTerminalItsSessionAndWhichOneIsOnScreen() throws {
        var model = try withAgent()
        try model.agentTerminalOpened(P_AG, terminalId: P_AG.rawValue, focus: true)
        _ = try model.resizeAgentTerminal(P_AG, share: 0.3)
        let wire = try project(model)
        XCTAssertEqual(wire.visibleTerminal, P_AG.rawValue)
        XCTAssertEqual(wire.paneFocus, P_AG.rawValue)
        let agent = wire.workspaces.flatMap(\.agents).first { $0.id == P_AG.rawValue }
        XCTAssertEqual(agent?.terminal, AgentTerminalWire(id: P_AG.rawValue, session: "tm-\(P_AG.rawValue)", open: true))
        XCTAssertEqual(agent?.terminalShare, 0.3)
    }

    func testSaysNothingAboutAnAgentWithNoTerminal() throws {
        let wire = try project(try withAgent())
        let agent = wire.workspaces.flatMap(\.agents).first { $0.id == P_AG.rawValue }
        XCTAssertNil(agent?.terminal)
        XCTAssertNil(agent?.terminalShare)
        XCTAssertNil(wire.visibleTerminal)
        XCTAssertNil(wire.paneFocus)
    }

    func testTakesTheDividersResizeAndRefusesAShareItCouldNotBe() throws {
        XCTAssertEqual(
            try UserIntent.fromWire(.resizeAgentTerminal(agentId: P_AG.rawValue, share: 0.3)),
            .resizeAgentTerminal(P_AG, share: 0.3))
        XCTAssertTrue(refused { try UserIntent.fromWire(.resizeAgentTerminal(agentId: P_AG.rawValue, share: 0.95)) })
        XCTAssertTrue(refused { try UserIntent.fromWire(.resizeAgentTerminal(agentId: "nope", share: 0.3)) })
    }

    func testTakesTheSplitsLevelDividerAsItsOwn() throws {
        XCTAssertEqual(
            try UserIntent.fromWire(.resizeAgentTerminal(agentId: P_AG.rawValue, share: 0.3, stacked: true)),
            .resizeAgentTerminal(P_AG, share: 0.3, stacked: true))
        XCTAssertEqual(
            try UserIntent.fromWire(.resizeAgentTerminal(agentId: P_AG.rawValue, share: 0.3, stacked: false)),
            .resizeAgentTerminal(P_AG, share: 0.3))
    }
}

final class NamedFailureTests: XCTestCase {
    private let wire = AppError.at(.workspaceUnavailable).withDetail("the folder is gone")

    func testIsDrawnAsItsOwnWireTitleAndDetail() {
        XCTAssertEqual(errorWire(NamedFailure(wire)), wire)
        XCTAssertEqual(errorWire(NamedFailure(wire)).code, .workspaceUnavailable)
        XCTAssertEqual(errorWire(NamedFailure(wire)).summary, "The workspace is unavailable.")
        XCTAssertEqual(errorWire(NamedFailure(wire)).detail, "the folder is gone")
    }

    func testStaysItselfWhenABoundaryHandsItOnAgain() {
        let failure = NamedFailure(wire)
        XCTAssertEqual(namedFailure(failure), failure)
        XCTAssertEqual(errorWire(namedFailure(namedFailure(failure))), wire)
    }

    func testReadsAsItsTitleAndItsDetailWhereItIsText() {
        XCTAssertEqual(failureText(NamedFailure(wire)), "The workspace is unavailable. the folder is gone")
        XCTAssertEqual(failureText(NamedFailure(AppError.at(.workspaceUnavailable).withSummary("fatal: no"))), "fatal: no")
    }

    func testIsANamedFailureUnderTheTitleItsDomainCodeReadsAs() {
        let cases: [(DomainErrorCode, AppErrorCode)] = [
            (.unknownWorkspace, .unknownContext), (.unknownAgent, .unknownContext),
            (.workspaceUnavailable, .workspaceUnavailable), (.workspaceClosing, .workspaceClosing),
            (.workspaceClosingFailed, .workspaceCloseFailed), (.invalidProfile, .agentProfileUnavailable),
            (.scratchCannotClose, .invalidIntent),
        ]
        for (code, expected) in cases {
            let refusal = NamedFailure.domain(code)
            XCTAssertEqual(errorWire(refusal), refusal.wire)
            XCTAssertEqual(refusal.wire.code, expected, code.rawValue)
        }
    }

    func testCarriesTheRaisersSentenceAsItsDetail() {
        let refusal = NamedFailure.domain(.invalidProfile, "only as a terminal").wire
        XCTAssertEqual(refusal.code, .agentProfileUnavailable)
        XCTAssertEqual(refusal.summary, "The agent could not start from this profile.")
        XCTAssertEqual(refusal.detail, "only as a terminal")
        XCTAssertNil(NamedFailure.at(.operationPending).wire.detail)
    }

    func testNamesTheAgentPortsRefusalByWhatThePortSaid() {
        XCTAssertEqual(NamedFailure.agent(.tmuxSessionConflict, "taken").wire.code, .tmuxSessionConflict)
        XCTAssertEqual(NamedFailure.agent(.tmuxSessionConflict, "taken").wire.detail, "taken")
        XCTAssertEqual(NamedFailure.agent(.agentRuntimeUnavailable).wire.code, .agentRuntimeUnavailable)
    }

    func testIsNotABareDomainErrorWhichOnlyTheCoordinatorConverts() {
        XCTAssertEqual(errorWire(DomainError(.workspaceClosing)).code, .nativeUnavailable)
    }

    func testIncludesAWireIntentThatCarriesNoCommand() {
        XCTAssertEqual(errorWire(namedFailure(NamedFailure.invalidIntent)).code, .invalidIntent)
    }

    func testAFailureDevHubDidNotExpectIsDrawnAsTheCatchAllWithItsMessageAsTheDetail() {
        struct Boom: Error, CustomStringConvertible { var description: String { "boom" } }
        XCTAssertEqual(errorWire(Boom()).code, .nativeUnavailable)
        XCTAssertEqual(errorWire(Boom()).summary, "The native app shell is unavailable.")
        XCTAssertEqual(errorWire(Boom()).detail, "boom")
        XCTAssertEqual(errorWire(namedFailure(Boom())).detail, "boom")
        XCTAssertEqual(failureText(Boom()), "boom")
    }

    func testAFileThatIsNotThereToOpenIsSaidAsItself() {
        let failure = NamedFailure.fileNotFound("/work/gone.ts", detail: "It is no longer there.")
        XCTAssertEqual(failure.wire.code, .fileNotFound)
        XCTAssertEqual(failure.wire.summary, "File not found: /work/gone.ts")
        XCTAssertEqual(failure.wire.detail, "It is no longer there.")
        XCTAssertEqual(failure.wire.actions, [])
        XCTAssertEqual(errorWire(namedFailure(failure)).code, .fileNotFound)
    }

    func testAGitFailureIsDrawnInItsOwnWords() {
        let coded = CodedFailure.workspace("fatal: 'x' is already checked out")
        XCTAssertEqual(errorWire(coded).code, .workspaceUnavailable)
        XCTAssertEqual(errorWire(coded).summary, "fatal: 'x' is already checked out")
        XCTAssertEqual(failureText(coded), "fatal: 'x' is already checked out")
    }
}

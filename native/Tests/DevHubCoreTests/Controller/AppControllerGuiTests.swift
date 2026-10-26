// The controller's GUI-Agent acts that are not the window's
// (appController.ts `continueAgentIn`, `continueAgentElsewhere`,
// `requestRestartAgent`, `requestCloseAgent`, `raiseCloseConfirmation`), the
// records beside `state.json` (`drafts.json`, `limit-resumes.json`), and the
// session sweep's view of the model.

import Foundation
import XCTest
@testable import DevHubCore

final class AppControllerGuiTests: XCTestCase {
    private func guiAgent(_ rig: ControllerRig) async throws -> AgentId {
        let workspace = try await rig.open("/work/api")
        _ = try await rig.controller.dispatch(.createAgent(
            workspaceId: workspace, profileId: "claude", presentation: .full, agentPresentation: .gui))
        let model = await rig.controller.model
        return try XCTUnwrap(model.workspace(workspace)?.agents.last?.id)
    }

    func testARestartOfABusyAgentIsAQuestionOnTheSheet() async throws {
        let rig = ControllerRig()
        let agent = try await guiAgent(rig)
        try await rig.controller.requestRestartAgent(agent)
        await rig.settled()
        guard case let .closeConfirmation(_, purpose)? = rig.shell.modals.all.last else {
            return XCTFail("\(rig.shell.modals.all)")
        }
        XCTAssertEqual(purpose, .agentRestart(agent))
    }

    func testAStopOfABusyAgentIsAQuestionOnTheSheet() async throws {
        let rig = ControllerRig()
        let agent = try await guiAgent(rig)
        try await rig.controller.requestCloseAgent(agent)
        await rig.settled()
        guard case .closeConfirmation? = rig.shell.modals.all.last else { return XCTFail("\(rig.shell.modals.all)") }
        XCTAssertEqual(rig.agents.stops.all, [])
    }

    func testContinuesAGuiAgentInTheTerminalOnTheSessionItsCliNamed() async throws {
        let rig = ControllerRig()
        let agent = try await guiAgent(rig)
        // Idle: carried on at once, with no question.
        rig.agents.reconciliation = { _, _ in
            AgentReconciliation(observations: [AgentObservation(agentId: agent, status: .idle, runtimeHealth: .healthy)])
        }
        await rig.controller.reconcileAgents(on: "local")
        try await rig.controller.continueAgentElsewhere(agent)
        await rig.settled()
        let model = await rig.controller.model
        let continued = try XCTUnwrap(model.workspaces.flatMap(\.agents).last)
        XCTAssertEqual(continued.presentation, .tui)
        XCTAssertEqual(continued.profile.args.suffix(2), ["--resume", "gui-session"])
        XCTAssertEqual(rig.agents.launches.all.last?.2, .tui)
    }

    func testAContinueOfABusyAgentIsAQuestionOnTheSheet() async throws {
        let rig = ControllerRig()
        let agent = try await guiAgent(rig)
        try await rig.controller.continueAgentIn(agent, presentation: .tui, session: "s-1")
        await rig.settled()
        guard case let .closeConfirmation(_, purpose)? = rig.shell.modals.all.last else {
            return XCTFail("\(rig.shell.modals.all)")
        }
        XCTAssertEqual(purpose, .agentContinue(agent, presentation: .tui))
    }

    func testTheSweepFindsWhatTheModelAccountsForAndTheMachinesItRemembers() async throws {
        let rig = ControllerRig()
        let agent = try await guiAgent(rig)
        let world = ControllerSweepWorld(
            controller: rig.controller, adapter: { _ in throw InvariantViolation("not asked") },
            hostFiles: { _ in throw InvariantViolation("not asked") })
        let accounted = world.accounted()
        XCTAssertTrue(accounted.agents.contains(agent.rawValue))
        let model = await rig.controller.model
        XCTAssertEqual(accounted.workspaces, Set(model.workspaces.map(\.id.rawValue)))
        XCTAssertEqual(world.workspaceMachines(), [.local])
        await rig.settled()
        XCTAssertEqual(world.remembered(), ["local"])
    }

    func testTheRecordsBesideTheStateFileLiveAsLongAsTheirAgents() throws {
        let directory = NSTemporaryDirectory() + "devhub-records-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let alive = Guarded<Set<String>>(["a1", "a2"])
        try #"{"version":1,"drafts":{"a1":"half","gone":"x"}}"#.write(toFile: directory + "/drafts.json", atomically: true, encoding: .utf8)
        try "not json".write(toFile: directory + "/limit-resumes.json", atomically: true, encoding: .utf8)
        let (records, refused) = try GuiAgentRecords.load(beside: directory + "/state.json", accounted: { alive.with { $0 } })
        XCTAssertEqual(records.drafts.get("a1"), "half")
        XCTAssertEqual(records.drafts.get("gone"), "")
        XCTAssertEqual(refused.count, 1)
        XCTAssertTrue(refused[0].hasPrefix("\(directory)/limit-resumes.json could not be read"), refused[0])
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory + "/limit-resumes.json.corrupt"))
        records.drafts.set("a2", "kept")
        alive.with { $0 = ["a2"] }
        records.prune { _ in }
        XCTAssertEqual(records.drafts.get("a1"), "")
        XCTAssertEqual(records.drafts.get("a2"), "kept")
    }

    func testAConversationsFailuresAreDrawnUnderTheirOwnTitles() {
        XCTAssertEqual(errorWire(ConversationError.refused("no")).code, .conversationRefused)
        XCTAssertEqual(errorWire(ConversationError.stopped("gone")).detail, "gone")
        XCTAssertEqual(errorWire(ConversationError.notResumable("x")).code, .conversationNotResumable)
        XCTAssertEqual(errorWire(TerminalAgentSessionLookupError.unreadable("ps failed")).code, .sessionsUnreadable)
        XCTAssertEqual(errorWire(TerminalAgentSessionLookupError.notResumable("which?")).detail, "which?")
    }
}

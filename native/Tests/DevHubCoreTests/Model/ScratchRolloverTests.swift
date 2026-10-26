// Port of apps/desktop/src/model/scratchRollover.test.ts

import Foundation
import XCTest
@testable import DevHubCore

private let YESTERDAY = WorkspaceId(unchecked: "550e8400-e29b-41d4-a716-446655440001")
private let TODAY = WorkspaceId(unchecked: "550e8400-e29b-41d4-a716-446655440002")
private let PROJECT = WorkspaceId(unchecked: "550e8400-e29b-41d4-a716-446655440003")
private let AGENT = AgentId(unchecked: "550e8400-e29b-41d4-a716-4466554400a0")
private let rolloverCodex = profile()

private func folder(_ id: WorkspaceId, _ path: String) -> Workspace {
    Workspace(id: id, location: .local(path: path), selectedPath: path)
}

private func yesterday() -> Workspace { folder(YESTERDAY, "/data/junk/20260922") }
private func todayFolder() -> Workspace { folder(TODAY, "/data/junk/20260923") }

/// Yesterday's Scratch, with an Agent created in it and selected.
private func yesterdayWithAgent() throws -> AppModel {
    var model = AppModel(scratch: yesterday())
    try model.addAgent(owner: YESTERDAY, id: AGENT, profile: rolloverCodex, agentPresentation: .tui)
    return model
}

final class ScratchRolloverTests: XCTestCase {
    // MARK: Scratch is today's daily-folder Workspace

    func testIsSelectedLabelledScratchAndOneOfTheWorkspaces() {
        let snapshot = AppModel(scratch: todayFolder()).snapshot()
        XCTAssertEqual(snapshot.scratchWorkspaceId, TODAY)
        XCTAssertEqual(snapshot.selection.context, .workspace(TODAY))
        XCTAssertEqual(snapshot.workspaces.map(\.label), ["Scratch"])
        XCTAssertEqual(snapshot.workspaces.first?.root, "/data/junk/20260923")
        XCTAssertEqual(snapshot.layout, .workbench(editor: .workspaceEditor(TODAY)))
    }

    func testTakesAgentsLikeAnyWorkspace() throws {
        XCTAssertEqual(try yesterdayWithAgent().snapshot().workspaces.first?.agents.map(\.id), [AGENT])
    }

    func testCannotBeClosedWhileItIsTodays() {
        var model = AppModel(scratch: todayFolder())
        XCTAssertEqual(codeOf { try model.closeWorkspace(TODAY, inspection: .clean, drawn: drawn(model)) }, .scratchCannotClose)
    }

    // MARK: midnight

    func testLeavesYesterdaysFolderAsAnOrdinaryRowAgentSelectionAndAll() throws {
        var model = try yesterdayWithAgent()
        XCTAssertTrue(try model.adoptScratchDay(todayFolder()))
        let snapshot = model.snapshot()
        XCTAssertEqual(snapshot.scratchWorkspaceId, TODAY)
        let labels = Dictionary(uniqueKeysWithValues: snapshot.workspaces.map { ($0.id, $0.label) })
        XCTAssertEqual(labels, [YESTERDAY: "20260922", TODAY: "Scratch"])
        XCTAssertEqual(snapshot.workspaces.first { $0.id == YESTERDAY }?.agents.map(\.id), [AGENT])
        XCTAssertEqual(snapshot.selection.context, .agent(AGENT))
    }

    func testMakesYesterdaysRowClosableAndToggleScratchGoToTheNewDay() throws {
        var model = AppModel(scratch: yesterday())
        _ = try model.adoptScratchDay(todayFolder())
        try model.selectContext(.workspace(YESTERDAY))
        try model.toggleScratch()
        XCTAssertEqual(model.snapshot().selection.context, .workspace(TODAY))
        try model.closeWorkspace(YESTERDAY, inspection: .clean, drawn: drawn(model))
        XCTAssertEqual(model.snapshot().workspaces.map(\.id), [TODAY])
    }

    func testAdoptsAFolderThatIsAlreadyOpenRatherThanOpeningItTwice() throws {
        var model = AppModel(scratch: yesterday())
        try model.addWorkspace(folder(PROJECT, "/data/junk/20260923"))
        _ = try model.adoptScratchDay(todayFolder())
        let snapshot = model.snapshot()
        XCTAssertEqual(snapshot.scratchWorkspaceId, PROJECT)
        XCTAssertFalse(snapshot.workspaces.map(\.id).contains(TODAY))
    }

    func testIsANoOpOnTheSameDay() throws {
        var model = AppModel(scratch: todayFolder())
        let before = model.snapshot().revision
        XCTAssertFalse(try model.adoptScratchDay(folder(PROJECT, "/data/junk/20260923")))
        XCTAssertEqual(model.snapshot().revision, before)
    }

    func testGoesThroughTheCoordinatorAsOneIntent() throws {
        var coordinator = coordinatorFor(AppModel(scratch: yesterday()))
        let fresh = todayFolder()
        _ = try coordinator.dispatchUser(IntentEnvelope(
            intentId: IntentId(unchecked: "00000000-0000-4000-8000-000000000001"),
            operationId: OperationId(unchecked: "00000000-0000-4000-8000-000000000002"),
            intent: .adoptScratchDay(fresh.id, location: fresh.location, selectedPath: fresh.selectedPath)))
        XCTAssertEqual(coordinator.snapshot().scratchWorkspaceId, TODAY)
    }

    // MARK: launch

    func testReconcilesAStateFileFromYesterdayYesterdaysRowTodaysScratch() throws {
        let written = try StatePersistence.state(from: try yesterdayWithAgent().snapshot())
        let snapshot = try StatePersistence.hydrate(written, profiles: [rolloverCodex], today: todayFolder()).snapshot()
        XCTAssertEqual(snapshot.scratchWorkspaceId, TODAY)
        let old = snapshot.workspaces.first { $0.id == YESTERDAY }
        XCTAssertEqual(old?.label, "20260922")
        XCTAssertEqual(old?.agents.map(\.id), [AGENT])
    }

    func testKeepsTodaysWorkspaceAndItsIdWhenTheFileAlreadyHasIt() throws {
        let written = try StatePersistence.state(from: AppModel(scratch: todayFolder()).snapshot())
        let model = try StatePersistence.hydrate(written, profiles: [], today: folder(PROJECT, "/data/junk/20260923"))
        XCTAssertEqual(model.snapshot().scratchWorkspaceId, TODAY)
        XCTAssertEqual(model.snapshot().workspaces.count, 1)
    }

    func testWritesBeingOnScratchAsScratchSoTomorrowOpensTomorrows() throws {
        let written = try StatePersistence.state(from: AppModel(scratch: yesterday()).snapshot())
        XCTAssertNil(written.navigation)
        let model = try StatePersistence.hydrate(written, profiles: [], today: todayFolder())
        XCTAssertEqual(model.snapshot().selection.context, .workspace(TODAY))
    }

    // MARK: migrating a version-9 state file

    func testReadsTheFolderlessScratchAsTodaysScratchAndDropsItsSession() async throws {
        var model = AppModel(scratch: todayFolder())
        try model.addWorkspace(folder(PROJECT, "/data/project"))
        let written = try StatePersistence.state(from: model.snapshot()).json
        let project = (written["workspaces"]?.arrayValue ?? []).filter { $0["workspace_id"] == .string(PROJECT.rawValue) }
        let v9 = written
            .editing("schema_version", 9)
            .editing("workspaces", .array(project))
            .editing("navigation", ["context": ["kind": "global"]])
            .editing("tmux", [
                "effective_socket_name": "devhub",
                "transition": [
                    "kind": "old_cleaned", "old_socket_name": "devhub", "new_socket_name": "devhub-next",
                    "required": [
                        ["kind": "scratch", "session_name": "scratch"],
                        ["kind": "workspace", "workspace_id": .string(PROJECT.rawValue), "session_name": "ws-0123456789abcdef0123"],
                    ],
                ],
            ])
        let scratch = StateScratch()
        scratch.write(v9)
        let load = try await scratch.store().loadState()
        XCTAssertNil(load.metadata.corruptionDetail)
        XCTAssertTrue(load.metadata.migrated)
        XCTAssertEqual(load.state.schemaVersion, StateSchema.version)
        XCTAssertNil(load.state.navigation)
        guard case let .oldCleaned(_, _, required) = load.state.tmux.transition else { return XCTFail() }
        XCTAssertEqual(required.map(\.workspaceId), [PROJECT.rawValue])
        let snapshot = try StatePersistence.hydrate(load.state, profiles: [], today: todayFolder()).snapshot()
        XCTAssertEqual(snapshot.scratchWorkspaceId, TODAY)
        XCTAssertEqual(snapshot.selection.context, .workspace(TODAY))
        XCTAssertEqual(Set(snapshot.workspaces.map(\.id)), [TODAY, PROJECT])
    }

    func testRefusesAVersion10FileThatStillNamesTheFolderlessContext() async throws {
        let written = try StatePersistence.state(from: AppModel(scratch: todayFolder()).snapshot()).json
        let scratch = StateScratch()
        scratch.write(written.editing("navigation", ["context": ["kind": "global"]]))
        let load = try await scratch.store().loadState()
        XCTAssertTrue(load.metadata.corruptionDetail?.contains("navigation.context.kind") == true)
    }
}

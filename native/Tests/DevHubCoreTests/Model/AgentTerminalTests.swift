// Port of apps/desktop/src/model/agentTerminal.test.ts

import XCTest
@testable import DevHubCore

private let T_WS_A = WorkspaceId(unchecked: "550e8400-e29b-41d4-a716-446655440000")
private let T_WS_B = WorkspaceId(unchecked: "550e8400-e29b-41d4-a716-446655440001")
private let T_AG_A = AgentId(unchecked: "550e8400-e29b-41d4-a716-4466554400a0")
private let T_AG_B = AgentId(unchecked: "550e8400-e29b-41d4-a716-4466554400b0")
private let T_AG_C = AgentId(unchecked: "550e8400-e29b-41d4-a716-4466554400c0")
private let T_OLD = "11111111-1111-4111-8111-111111111111"
private let T_OTHER = "22222222-2222-4222-8222-222222222222"

private let terminalCodex = profile()

/// WS_A with two Agents, WS_B with one and WS_A's first Agent selected.
private func terminalModel() throws -> AppModel {
    var made = scratchModel()
    try made.addWorkspace(localWorkspace("/dev/a", id: T_WS_A.rawValue))
    try made.addWorkspace(localWorkspace("/dev/b", id: T_WS_B.rawValue))
    try made.addAgent(owner: T_WS_A, id: T_AG_A, profile: terminalCodex, agentPresentation: .tui)
    try made.addAgent(owner: T_WS_A, id: T_AG_B, profile: terminalCodex, agentPresentation: .tui)
    try made.addAgent(owner: T_WS_B, id: T_AG_C, profile: terminalCodex, agentPresentation: .tui)
    try made.selectContext(.agent(T_AG_A))
    return made
}

final class AgentTerminalModelTests: XCTestCase {
    // MARK: one terminal per Agent

    func testIsNamedByItsAgentAndShowsRightOfThatAgentWhenOpened() throws {
        var m = try terminalModel()
        XCTAssertNil(m.visibleTerminal())
        try m.agentTerminalOpened(T_AG_A, terminalId: T_AG_A.rawValue, focus: true)
        XCTAssertEqual(m.visibleTerminal()?.agentId, T_AG_A)
        XCTAssertEqual(m.visibleTerminal()?.terminalId, T_AG_A.rawValue)
        XCTAssertEqual(m.visibleTerminal()?.open, true)
        XCTAssertEqual(m.paneFocus, T_AG_A.rawValue)
        XCTAssertEqual(AgentTerminals.sessionName(T_AG_A.rawValue), "tm-\(T_AG_A.rawValue)")
        let agent = m.snapshot().workspaces.first { $0.id == T_WS_A }?.agents.first { $0.id == T_AG_A }
        XCTAssertEqual(agent?.terminal?.terminalId, T_AG_A.rawValue)
        XCTAssertEqual(m.snapshot().visibleTerminal?.agentId, T_AG_A)
    }

    func testSwitchesWithTheAgentEachShowsItsOwnAndTheOneLeftRunsOnHidden() throws {
        var m = try terminalModel()
        try m.agentTerminalOpened(T_AG_A, terminalId: T_AG_A.rawValue, focus: true)
        try m.selectContext(.agent(T_AG_B))
        XCTAssertNil(m.visibleTerminal())
        XCTAssertEqual(m.agentTerminal(T_AG_A)?.open, true)
        XCTAssertNil(m.paneFocus)
        try m.agentTerminalOpened(T_AG_B, terminalId: T_AG_B.rawValue)
        XCTAssertEqual(m.visibleTerminal()?.agentId, T_AG_B)
        try m.selectContext(.agent(T_AG_A))
        XCTAssertEqual(m.visibleTerminal()?.agentId, T_AG_A)
    }

    func testHidesAndShowsWithoutTheSessionGoingAndTheKeyboardLeavesAHiddenOne() throws {
        var m = try terminalModel()
        try m.agentTerminalOpened(T_AG_A, terminalId: T_AG_A.rawValue, focus: true)
        XCTAssertTrue(m.showAgentTerminal(T_AG_A, open: false))
        XCTAssertNil(m.visibleTerminal())
        XCTAssertNil(m.paneFocus)
        XCTAssertEqual(m.agentTerminal(T_AG_A)?.open, false)
        XCTAssertTrue(m.showAgentTerminal(T_AG_A, open: true, focus: true))
        XCTAssertEqual(m.paneFocus, T_AG_A.rawValue)
        XCTAssertFalse(m.showAgentTerminal(T_AG_B, open: true))
    }

    func testOnAWorkspacesRowBesideAnAgentIsTheAgentItPairsWith() throws {
        var m = try terminalModel()
        try m.agentTerminalOpened(T_AG_B, terminalId: T_AG_B.rawValue)
        try m.selectContext(.workspace(T_WS_A), presentation: .beside)
        XCTAssertEqual(m.terminalAgentId(), T_AG_A)
        XCTAssertNil(m.visibleTerminal())
        try m.selectContext(.agent(T_AG_B))
        try m.selectContext(.workspace(T_WS_A), presentation: .beside)
        XCTAssertEqual(m.terminalAgentId(), T_AG_B)
        XCTAssertEqual(m.visibleTerminal()?.agentId, T_AG_B)
        try m.selectContext(.workspace(m.scratchWorkspaceId))
        XCTAssertNil(m.terminalAgentId())
    }

    func testIsNotShownWithTheWorkbenchAloneAndIsBackAsItWasWithItsAgent() throws {
        var m = try terminalModel()
        try m.agentTerminalOpened(T_AG_A, terminalId: T_AG_A.rawValue, focus: true)
        try m.selectContext(.workspace(T_WS_A))
        XCTAssertNil(m.terminalAgentId())
        XCTAssertNil(m.visibleTerminal())
        XCTAssertNil(m.paneFocus)
        XCTAssertEqual(m.agentTerminal(T_AG_A)?.open, true)
        XCTAssertNil(m.snapshot().visibleTerminal)
        XCTAssertFalse(try m.cyclePaneFocus())
        try m.selectContext(.agent(T_AG_A))
        XCTAssertEqual(m.visibleTerminal()?.agentId, T_AG_A)
        try m.selectContext(.workspace(T_WS_A), presentation: .beside)
        XCTAssertEqual(m.visibleTerminal()?.agentId, T_AG_A)
    }

    func testGoesWhenItIsClosedOrWhenItsAgentDoes() throws {
        var m = try terminalModel()
        try m.agentTerminalOpened(T_AG_A, terminalId: T_AG_A.rawValue, focus: true)
        XCTAssertTrue(m.agentTerminalClosed(T_AG_A))
        XCTAssertNil(m.paneFocus)
        XCTAssertFalse(m.agentTerminalClosed(T_AG_A))
        try m.agentTerminalOpened(T_AG_C, terminalId: T_AG_C.rawValue)
        _ = try m.resizeAgentTerminal(T_AG_C, share: 0.6)
        try m.agentExited(T_AG_C)
        XCTAssertNil(m.agentTerminal(T_AG_C))
        XCTAssertEqual(m.terminalShare(T_AG_C), AgentTerminals.defaultShare)
    }

    func testRemembersItsWidthPerAgentClampedAcrossAClose() throws {
        var m = try terminalModel()
        XCTAssertTrue(try m.resizeAgentTerminal(T_AG_A, share: 0.7))
        XCTAssertFalse(try m.resizeAgentTerminal(T_AG_A, share: 0.7))
        XCTAssertEqual(m.terminalShare(T_AG_B), AgentTerminals.defaultShare)
        try m.agentTerminalOpened(T_AG_A, terminalId: T_AG_A.rawValue)
        _ = m.agentTerminalClosed(T_AG_A)
        XCTAssertEqual(m.terminalShare(T_AG_A), 0.7)
        _ = try m.resizeAgentTerminal(T_AG_A, share: 5)
        XCTAssertEqual(m.terminalShare(T_AG_A), AgentTerminals.clampShare(5))
    }

    func testKeepsTheHeightUnderASplitApartFromTheWidthBesideAFullAgent() throws {
        var m = try terminalModel()
        XCTAssertTrue(try m.resizeAgentTerminal(T_AG_A, share: 0.3, stacked: true))
        XCTAssertFalse(try m.resizeAgentTerminal(T_AG_A, share: 0.3, stacked: true))
        XCTAssertEqual(m.terminalStackedShare(T_AG_A), 0.3)
        XCTAssertEqual(m.terminalShare(T_AG_A), AgentTerminals.defaultShare)
        _ = try m.resizeAgentTerminal(T_AG_A, share: 0.7)
        XCTAssertEqual(m.terminalStackedShare(T_AG_A), 0.3)
        XCTAssertEqual(m.terminalShare(T_AG_A), 0.7)
    }

    // MARK: which terminals are still running

    func testClosesOneWhoseSessionALaterReadingDidNotFind() throws {
        var m = try terminalModel()
        try m.agentTerminalOpened(T_AG_A, terminalId: T_AG_A.rawValue, openedAt: 100)
        try m.agentTerminalOpened(T_AG_B, terminalId: T_AG_B.rawValue, openedAt: 100)
        XCTAssertTrue(m.observePaneTerminals([T_WS_A], alive: [T_AG_B.rawValue], since: 200))
        XCTAssertNil(m.agentTerminal(T_AG_A))
        XCTAssertNotNil(m.agentTerminal(T_AG_B))
    }

    func testKeepsOneTheModelLearnedOfAfterTheReadingBegan() throws {
        var m = try terminalModel()
        try m.agentTerminalOpened(T_AG_A, terminalId: T_AG_A.rawValue, openedAt: 300)
        XCTAssertFalse(m.observePaneTerminals([T_WS_A], alive: [], since: 200))
        XCTAssertNotNil(m.agentTerminal(T_AG_A))
    }

    func testSaysNothingAboutAWorkspaceTheReadingWasNotAbout() throws {
        var m = try terminalModel()
        try m.agentTerminalOpened(T_AG_C, terminalId: T_AG_C.rawValue, openedAt: 100)
        XCTAssertFalse(m.observePaneTerminals([T_WS_A], alive: [], since: 200))
        XCTAssertNotNil(m.agentTerminal(T_AG_C))
    }

    // MARK: moving the keyboard between panes

    func testCyclesTheEditorTheAgentAndTheTerminalWrapping() throws {
        var m = try terminalModel()
        try m.selectContext(.agent(T_AG_A), presentation: .beside)
        try m.agentTerminalOpened(T_AG_A, terminalId: T_AG_A.rawValue)
        XCTAssertTrue(try m.cyclePaneFocus())
        XCTAssertEqual(m.paneFocus, T_AG_A.rawValue)
        _ = try m.cyclePaneFocus()
        XCTAssertNil(m.paneFocus)
        XCTAssertEqual(m.selection, NavigationSelection(context: .workspace(T_WS_A), presentation: .beside))
        _ = try m.cyclePaneFocus()
        XCTAssertEqual(m.selection.context, .agent(T_AG_A))
        _ = try m.cyclePaneFocus(-1)
        XCTAssertEqual(m.selection.context, .workspace(T_WS_A))
    }

    func testGoesBetweenTheContentAndTheTerminalWithOnePaneOfContent() throws {
        var m = try terminalModel()
        try m.agentTerminalOpened(T_AG_A, terminalId: T_AG_A.rawValue)
        XCTAssertTrue(try m.cyclePaneFocus())
        XCTAssertEqual(m.paneFocus, T_AG_A.rawValue)
        XCTAssertTrue(try m.cyclePaneFocus())
        XCTAssertNil(m.paneFocus)
        XCTAssertEqual(m.selection.context, .agent(T_AG_A))
    }

    func testIsANoOpWithOnePaneOnScreenAndWithTheTerminalHidden() throws {
        var m = try terminalModel()
        XCTAssertFalse(try m.cyclePaneFocus())
        try m.agentTerminalOpened(T_AG_A, terminalId: T_AG_A.rawValue)
        _ = m.showAgentTerminal(T_AG_A, open: false)
        XCTAssertFalse(try m.cyclePaneFocus())
    }

    func testOnlyFocusesTheTerminalOnScreen() throws {
        var m = try terminalModel()
        try m.agentTerminalOpened(T_AG_C, terminalId: T_AG_C.rawValue)
        XCTAssertFalse(m.focusPane(.terminal(terminalId: T_AG_C.rawValue)))
        try m.agentTerminalOpened(T_AG_A, terminalId: T_AG_A.rawValue)
        XCTAssertTrue(m.focusPane(.terminal(terminalId: T_AG_A.rawValue)))
        XCTAssertTrue(m.focusPane(.content))
        XCTAssertNil(m.paneFocus)
    }

    // MARK: across a restart

    /// Written to text and read back, as a restart does.
    private func restore(_ state: PersistedAppState) throws -> AppModel {
        guard case let .state(read, _, _) = StateDecoding.decode(Array(state.fileText.utf8)) else {
            throw InvariantViolation("the state did not read back")
        }
        return try StatePersistence.hydrate(
            read, profiles: [terminalCodex], today: localWorkspace("/x", id: "550e8400-e29b-41d4-a716-4466554400ff"))
    }

    private func records(_ state: PersistedAppState) -> [AgentStateRecord] { state.workspaces.flatMap(\.agents) }

    func testWritesEachAgentsTerminalAndWidthAndReadsThemBack() throws {
        var m = try terminalModel()
        try m.agentTerminalOpened(T_AG_A, terminalId: T_AG_A.rawValue)
        try m.agentTerminalOpened(T_AG_B, terminalId: T_AG_B.rawValue)
        _ = m.showAgentTerminal(T_AG_B, open: false)
        _ = try m.resizeAgentTerminal(T_AG_B, share: 0.25)
        _ = try m.resizeAgentTerminal(T_AG_B, share: 0.55, stacked: true)
        _ = try m.resizeAgentTerminal(T_AG_C, share: 0.6)
        let state = try StatePersistence.state(from: m.snapshot())
        XCTAssertNoThrow(try StateValidation.validate(state))
        func record(_ id: AgentId) -> AgentStateRecord? { records(state).first { $0.agentId == id.rawValue } }
        XCTAssertEqual(record(T_AG_A)?.terminal, AgentTerminalRecord(terminalId: T_AG_A.rawValue, open: true))
        XCTAssertNil(record(T_AG_A)?.terminalShare)
        XCTAssertNil(record(T_AG_A)?.terminalStackedShare)
        XCTAssertEqual(record(T_AG_B)?.terminal, AgentTerminalRecord(terminalId: T_AG_B.rawValue, open: false))
        XCTAssertEqual(record(T_AG_B)?.terminalShare, 0.25)
        XCTAssertEqual(record(T_AG_B)?.terminalStackedShare, 0.55)
        XCTAssertNil(record(T_AG_C)?.terminal)
        XCTAssertEqual(record(T_AG_C)?.terminalShare, 0.6)
        for one in state.workspaces {
            XCTAssertNil(one.paneLayout)
            XCTAssertNil(one.paneTerminals)
        }
        let restored = try restore(state)
        XCTAssertEqual(restored.agentTerminal(T_AG_A), AgentTerminal(agentId: T_AG_A, terminalId: T_AG_A.rawValue, open: true, openedAt: 0))
        XCTAssertEqual(restored.agentTerminal(T_AG_B)?.open, false)
        XCTAssertEqual(restored.terminalShare(T_AG_B), 0.25)
        XCTAssertEqual(restored.terminalStackedShare(T_AG_B), 0.55)
        XCTAssertEqual(restored.terminalShare(T_AG_C), 0.6)
        XCTAssertEqual(restored.terminalStackedShare(T_AG_C), AgentTerminals.defaultShare)
    }

    func testRefusesATerminalRecordThatIsNotOne() throws {
        var m = try terminalModel()
        try m.agentTerminalOpened(T_AG_A, terminalId: T_AG_A.rawValue)
        var state = try StatePersistence.state(from: m.snapshot())
        func edit(_ change: (inout AgentStateRecord) -> Void) {
            for w in state.workspaces.indices {
                for a in state.workspaces[w].agents.indices where state.workspaces[w].agents[a].agentId == T_AG_A.rawValue {
                    change(&state.workspaces[w].agents[a])
                }
            }
        }
        edit { $0.terminalShare = 2 }
        XCTAssertThrowsError(try StateValidation.validate(state))
        edit { $0.terminalShare = nil; $0.terminalStackedShare = 0.05 }
        XCTAssertThrowsError(try StateValidation.validate(state))
        edit { $0.terminalStackedShare = nil; $0.terminal = AgentTerminalRecord(terminalId: "nope", open: true) }
        XCTAssertThrowsError(try StateValidation.validate(state))
    }

    /// A Workspace record as 3de5ad4 wrote it: a tree of panes, its terminals.
    private func legacy(_ state: inout PersistedAppState, _ id: WorkspaceId, _ layout: WireJSON, _ terminals: WireJSON) {
        guard let index = state.workspaces.firstIndex(where: { $0.workspaceId == id.rawValue }) else { return }
        state.workspaces[index].paneLayout = layout
        state.workspaces[index].paneTerminals = terminals
    }

    private let oldTree: WireJSON = [
        "kind": "split", "axis": "row", "ratio": 0.7, "first": ["kind": "content"],
        "second": [
            "kind": "split", "axis": "column", "ratio": 0.5,
            "first": ["kind": "terminal", "terminal_id": .string(T_OLD)],
            "second": ["kind": "terminal", "terminal_id": .string(T_OTHER)],
        ],
    ]
    private let oldTerminals: WireJSON = [
        ["terminal_id": .string(T_OLD), "name": "Terminal 1"],
        ["terminal_id": .string(T_OTHER), "name": "Terminal 2", "command": "npm run dev"],
    ]

    func testGivesAWorkspacesFirstTerminalFromBeforeToItsLastAgentAndDropsTheRest() throws {
        var m = try terminalModel()
        try m.selectContext(.agent(T_AG_B))
        var state = try StatePersistence.state(from: m.snapshot())
        legacy(&state, T_WS_A, oldTree, oldTerminals)
        XCTAssertNoThrow(try StateValidation.validate(state))
        let restored = try restore(state)
        XCTAssertEqual(restored.agentTerminal(T_AG_B), AgentTerminal(agentId: T_AG_B, terminalId: T_OLD, open: true, openedAt: 0))
        XCTAssertNil(restored.agentTerminal(T_AG_A))
        XCTAssertNil(restored.agentTerminalById(T_OTHER))
        XCTAssertEqual(restored.terminalShare(T_AG_B), AgentTerminals.defaultShare)
        let next = try StatePersistence.state(from: restored.snapshot())
        XCTAssertNil(next.workspaces.first { $0.workspaceId == T_WS_A.rawValue }?.paneLayout)
    }

    func testCarriesTheWidthOfATerminalThatSatRightOfTheContent() {
        let carried = AgentTerminals.legacy(
            layout: [
                "kind": "split", "axis": "row", "ratio": 0.7, "first": ["kind": "content"],
                "second": ["kind": "terminal", "terminal_id": .string(T_OLD)],
            ],
            terminals: [["terminal_id": .string(T_OLD), "name": "Terminal 1"]])
        XCTAssertEqual(carried?.terminalId, T_OLD)
        XCTAssertEqual(carried?.share ?? 0, 0.3, accuracy: 1e-9)
    }

    func testGivesItToTheOnlyAgentWhenNoneWasLastAndToNobodyWithoutOne() throws {
        let m = try terminalModel()
        var state = try StatePersistence.state(from: m.snapshot())
        legacy(&state, T_WS_B, oldTree, oldTerminals)
        if let index = state.workspaces.firstIndex(where: { $0.workspaceId == T_WS_B.rawValue }) {
            state.workspaces[index].lastAgentId = nil
        }
        legacy(&state, m.scratchWorkspaceId, oldTree, oldTerminals)
        let restored = try restore(state)
        XCTAssertEqual(restored.agentTerminal(T_AG_C)?.terminalId, T_OLD)
    }

    func testDropsALayoutFromBeforeThatDoesNotReadWithoutRefusingTheFile() throws {
        let m = try terminalModel()
        var state = try StatePersistence.state(from: m.snapshot())
        legacy(&state, T_WS_A, ["kind": "spiral"], [["terminal_id": "not-a-uuid"]])
        legacy(&state, T_WS_B, "garbage", "garbage")
        XCTAssertNoThrow(try StateValidation.validate(state))
        let restored = try restore(state)
        XCTAssertEqual(restored.agentTerminals(), [])
    }

    // MARK: where the terminal goes

    func testTakesItsShareOfTheWidthOnTheRightPastASeam() {
        let placed = AgentTerminals.place(LayoutRect(x: 10, y: 20, width: 1006, height: 500), share: 0.4, gap: 6)
        XCTAssertEqual(placed.terminal, LayoutRect(x: 616, y: 20, width: 400, height: 500))
        XCTAssertEqual(placed.seam, LayoutRect(x: 610, y: 20, width: 6, height: 500))
        XCTAssertEqual(placed.content, LayoutRect(x: 10, y: 20, width: 600, height: 500))
    }

    func testUnderItsAgentTakesItsShareOfTheHeightAtTheBottomPastASeam() {
        let placed = AgentTerminals.placeBelow(LayoutRect(x: 10, y: 20, width: 500, height: 806), share: 0.4, gap: 6)
        XCTAssertEqual(placed.content, LayoutRect(x: 10, y: 20, width: 500, height: 480))
        XCTAssertEqual(placed.seam, LayoutRect(x: 10, y: 500, width: 500, height: 6))
        XCTAssertEqual(placed.terminal, LayoutRect(x: 10, y: 506, width: 500, height: 320))
    }

    func testClampsAShareItIsAskedFor() {
        XCTAssertEqual(AgentTerminals.clampShare(0), 0.15)
        XCTAssertEqual(AgentTerminals.clampShare(1), 0.85)
        XCTAssertEqual(AgentTerminals.clampShare(Double.nan), AgentTerminals.defaultShare)
    }
}

// Port of apps/desktop/src/main/shell/chords.test.ts

import XCTest
@testable import DevHubCore

private func wireAgent(_ id: String, _ workspaceId: String, _ ordinal: Int, unread: AgentStatus? = nil) -> AgentWire {
    AgentWire(
        controlState: .running, failure: nil, displayName: id, id: id, ordinal: ordinal, profileId: "profile",
        profileKind: .claude, presentation: .tui, runtimeHealth: .healthy, status: .idle, unread: unread, activity: nil,
        promptCache: nil, injection: .none, automaticActions: [], workspaceId: workspaceId, terminal: nil,
        terminalShare: nil, terminalStackedShare: nil)
}

/// `"a1"` for an Agent that has been read, `"a1!"` for one that is unread.
private func wireWorkspace(
    _ id: String, _ agentIds: [String], label: String? = nil, canCreateAgent: Bool = true, groupKey: String? = nil,
    lastAgentId: String? = nil
) -> WorkspaceWire {
    WorkspaceWire(
        agents: agentIds.enumerated().map { index, written in
            written.hasSuffix("!")
                ? wireAgent(String(written.dropLast()), id, index, unread: .idle)
                : wireAgent(written, id, index)
        },
        canCreateAgent: canCreateAgent, id: id, label: label ?? id, location: .local, editor: .host,
        root: "/workspaces/\(id)", displayRoot: "/workspaces/\(id)", key: "/workspaces/\(id)",
        groupKey: groupKey ?? "/workspaces/\(id)", selectedPath: "/workspaces/\(id)", state: .available, close: .idle,
        lastAgentId: lastAgentId, terminals: nil)
}

private let SCRATCH_ID = "scratch"
private let SCRATCH = ContextWire.workspace(SCRATCH_ID)

private func snapshotOf(
    workspaces: [WorkspaceWire] = [], scratch: WorkspaceWire = wireWorkspace(SCRATCH_ID, [], label: "Scratch"),
    context: ContextWire = SCRATCH, presentation: SurfacePresentation = .full
) -> AppSnapshotWire {
    AppSnapshotWire(
        editorHost: .ready, layout: .workbench(editorKey: "workspace-editor:\(SCRATCH_ID)"), readiness: .ready, revision: 1,
        selection: SelectionWire(context: context, presentation: presentation), scratchWorkspaceId: scratch.id,
        sidebar: SidebarSnapshot(width: 248, collapsed: false), splitRatio: 0.55, visibleTerminal: nil, paneFocus: nil,
        smartButtons: SmartButtonsPlacement(), terminalZoomOffset: 0, workspaces: [scratch] + workspaces, history: nil)
}

private let one = wireWorkspace("one", ["a1"])
private let two = wireWorkspace("two", ["b1", "b2"])
private let empty = wireWorkspace("empty", [])

private func resolveChord(_ commandId: CommandId, _ snapshot: AppSnapshotWire) throws -> ChordEffect? {
    try Chords.resolve(commandId, snapshot)
}

private func selects(_ context: ContextWire) -> ChordEffect { .selectContext(context) }
private func passes(_ context: ContextWire) -> ChordEffect { .selectContext(context, passing: true) }

final class ChordsResolveTests: XCTestCase {
    // MARK: the workspace cycle

    func testCountsScratchAsEntry0AndTheWorkspacesFrom1() throws {
        let snapshot = snapshotOf(workspaces: [one, two])
        XCTAssertEqual(try resolveChord(.selectEntry0, snapshot), selects(SCRATCH))
        XCTAssertEqual(try resolveChord(.selectEntry2, snapshot), selects(.workspace("two")))
    }

    func testDoesNothingForADigitPastTheEndOfTheList() throws {
        XCTAssertNil(try resolveChord(.selectEntry3, snapshotOf(workspaces: [one, two])))
    }

    func testStepsThroughScratchAndTheWorkspacesWrappingAtBothEnds() throws {
        let snapshot = snapshotOf(workspaces: [one, two])
        XCTAssertEqual(try resolveChord(.nextWorkspace, snapshot), selects(.workspace("one")))
        XCTAssertEqual(try resolveChord(.previousWorkspace, snapshot), selects(.workspace("two")))
        XCTAssertEqual(try resolveChord(.nextWorkspace, snapshotOf(workspaces: [one, two], context: .workspace("two"))), selects(SCRATCH))
    }

    func testMovesOutOfAnAgentByTheWorkspaceThatAgentIsIn() throws {
        XCTAssertEqual(
            try resolveChord(.previousWorkspace, snapshotOf(workspaces: [one, two], context: .agent("b2"))), selects(.workspace("one")))
    }

    func testDoesNothingWhenScratchIsTheOnlyEntry() throws {
        XCTAssertNil(try resolveChord(.nextWorkspace, snapshotOf()))
    }

    // MARK: the Agent cycle

    func testCrossesWorkspacesBecauseAnAgentIsTheUnitOfWork() throws {
        XCTAssertEqual(try resolveChord(.nextAgent, snapshotOf(workspaces: [one, two], context: .agent("a1"))), selects(.agent("b1")))
    }

    func testWrapsAroundTheWholeListNotAroundOneWorkspace() throws {
        XCTAssertEqual(try resolveChord(.nextAgent, snapshotOf(workspaces: [one, two], context: .agent("b2"))), selects(.agent("a1")))
        XCTAssertEqual(try resolveChord(.previousAgent, snapshotOf(workspaces: [one, two], context: .agent("a1"))), selects(.agent("b2")))
    }

    func testStartsAtTheFirstOrTheLastFromARowThatIsNotAnAgent() throws {
        let snapshot = snapshotOf(workspaces: [one, two])
        XCTAssertEqual(try resolveChord(.nextAgent, snapshot), selects(.agent("a1")))
        XCTAssertEqual(try resolveChord(.previousAgent, snapshot), selects(.agent("b2")))
    }

    func testIsANoOpNotAnErrorWithNoAgentsAnywhere() throws {
        XCTAssertNil(try resolveChord(.nextAgent, snapshotOf(workspaces: [empty])))
    }

    func testStepsFromAnEditorsOwnRowNotFromTheAgentItTogglesWith() throws {
        let ring = snapshotOf(
            workspaces: [one, wireWorkspace("two", ["b1", "b2"], lastAgentId: "b2")],
            scratch: wireWorkspace(SCRATCH_ID, ["s1"], label: "Scratch"), context: .workspace("two"))
        XCTAssertEqual(try resolveChord(.nextAgent, ring), selects(.agent("b1")))
        XCTAssertEqual(try resolveChord(.previousAgent, ring), selects(.agent("a1")))
    }

    func testStepsFromAWorkspaceWithNoAgentsFromWhereItsRowIs() throws {
        let ring = snapshotOf(
            workspaces: [one, empty, two], scratch: wireWorkspace(SCRATCH_ID, ["s1"], label: "Scratch"), context: .workspace("empty"))
        XCTAssertEqual(try resolveChord(.nextAgent, ring), selects(.agent("b1")))
        XCTAssertEqual(try resolveChord(.previousAgent, ring), selects(.agent("a1")))
    }

    // MARK: the unread Agent cycle

    private let mixed = [wireWorkspace("one", ["a1", "a2!"]), wireWorkspace("two", ["b1!", "b2"])]

    private func from(_ agentId: String, _ commandId: CommandId) throws -> ChordEffect? {
        try resolveChord(commandId, snapshotOf(workspaces: mixed, context: .agent(agentId)))
    }

    func testSkipsTheAgentsThatHaveBeenReadInSidebarOrder() throws {
        XCTAssertEqual(try from("a1", .nextUnreadAgent), selects(.agent("a2")))
        XCTAssertEqual(try from("a2", .nextUnreadAgent), selects(.agent("b1")))
        XCTAssertEqual(try from("b2", .previousUnreadAgent), selects(.agent("b1")))
    }

    func testWrapsAroundTheWholeRingCrossingWorkspaces() throws {
        XCTAssertEqual(try from("b1", .nextUnreadAgent), selects(.agent("a2")))
        XCTAssertEqual(try from("a1", .previousUnreadAgent), selects(.agent("b1")))
    }

    func testStartsAtTheTopFromARowThatIsNotAnAgent() throws {
        let snapshot = snapshotOf(workspaces: mixed)
        XCTAssertEqual(try resolveChord(.nextUnreadAgent, snapshot), selects(.agent("a2")))
        XCTAssertEqual(try resolveChord(.previousUnreadAgent, snapshot), selects(.agent("b1")))
        XCTAssertEqual(try resolveChord(.nextUnreadAgent, snapshotOf(workspaces: mixed, context: .workspace("two"))), selects(.agent("b1")))
    }

    func testIsANoOpWithNothingUnreadAndWithNoAgentsAtAll() throws {
        let read = snapshotOf(workspaces: [one, two], context: .agent("a1"))
        XCTAssertNil(try resolveChord(.nextUnreadAgent, read))
        XCTAssertNil(try resolveChord(.previousUnreadAgent, read))
        XCTAssertNil(try resolveChord(.nextUnreadAgent, snapshotOf(workspaces: [empty])))
    }

    func testLeavesTheUnnarrowedCycleAlone() throws {
        XCTAssertEqual(try from("a1", .nextAgent), selects(.agent("a2")))
        XCTAssertEqual(try from("a2", .nextAgent), selects(.agent("b1")))
        XCTAssertEqual(try from("b1", .previousAgent), selects(.agent("a2")))
    }

    // MARK: the tab cycle

    func testWalksEveryRowInOrderWithoutMindingWhichKindItIs() throws {
        XCTAssertEqual(try resolveChord(.nextTab, snapshotOf(workspaces: [one, two])), passes(.workspace("one")))
        XCTAssertEqual(try resolveChord(.nextTab, snapshotOf(workspaces: [one, two], context: .workspace("one"))), passes(.agent("a1")))
        XCTAssertEqual(try resolveChord(.nextTab, snapshotOf(workspaces: [one, two], context: .agent("a1"))), passes(.workspace("two")))
    }

    func testWrapsFromTheLastRowBackToScratch() throws {
        XCTAssertEqual(try resolveChord(.nextTab, snapshotOf(workspaces: [one, two], context: .agent("b2"))), passes(SCRATCH))
        XCTAssertEqual(try resolveChord(.previousTab, snapshotOf(workspaces: [one, two])), passes(.agent("b2")))
    }

    func testTabsDoNothingWhenScratchIsTheOnlyRow() throws {
        XCTAssertNil(try resolveChord(.nextTab, snapshotOf()))
    }

    // MARK: the two halves of a workspace

    func testGoesFromAnAgentBackToItsWorkspaceIntoItsTerminal() throws {
        XCTAssertEqual(
            try resolveChord(.toggleWorkspaceAgent, snapshotOf(workspaces: [two], context: .agent("b2"))),
            .selectContext(.workspace("two"), focus: .editor))
    }

    func testCarriesNoSuchIntentTheOtherWayOrFromAnywhereElse() throws {
        for effect in [
            try resolveChord(.toggleWorkspaceAgent, snapshotOf(workspaces: [two], context: .workspace("two"))),
            try resolveChord(.focusEditor, snapshotOf(workspaces: [two], context: .agent("b2"))),
            try resolveChord(.nextWorkspace, snapshotOf(workspaces: [two], context: .agent("b2"))),
        ] {
            if case let .selectContext(_, _, focus, _)? = effect { XCTAssertNil(focus) }
        }
    }

    func testGoesFromTheWorkspaceBackToTheAgentItWasLastIn() throws {
        XCTAssertEqual(
            try resolveChord(.toggleWorkspaceAgent, snapshotOf(workspaces: [wireWorkspace("two", ["b1", "b2"], lastAgentId: "b2")], context: .workspace("two"))),
            .selectContext(.agent("b2"), presentation: .full))
    }

    func testGoesToTheFirstAgentFromAWorkspaceThatHasNeverHadOneOpen() throws {
        XCTAssertEqual(
            try resolveChord(.toggleWorkspaceAgent, snapshotOf(workspaces: [two], context: .workspace("two"))),
            .selectContext(.agent("b1"), presentation: .full))
    }

    func testDoesNothingFromAWorkspaceWithNoAgentsAtAll() throws {
        XCTAssertNil(try resolveChord(.toggleWorkspaceAgent, snapshotOf(workspaces: [empty], context: .workspace("empty"))))
    }

    func testMovesTheKeyboardInsteadWhenBothHalvesAreAlreadyOnScreen() throws {
        XCTAssertEqual(
            try resolveChord(.toggleWorkspaceAgent, snapshotOf(workspaces: [two], context: .agent("b1"), presentation: .beside)), .swapSplitFocus)
    }

    func testTheTwoHalvesDoNothingAtAllOnScratch() throws {
        XCTAssertNil(try resolveChord(.toggleWorkspaceAgent, snapshotOf()))
    }

    // MARK: the layout toggles

    func testPutsTheAgentBesideTheEditorAndBackToTheAgent() throws {
        XCTAssertEqual(
            try resolveChord(.toggleSplit, snapshotOf(workspaces: [two], context: .agent("b1"))), .selectContext(.agent("b1"), presentation: .beside))
        XCTAssertEqual(
            try resolveChord(.toggleSplit, snapshotOf(workspaces: [two], context: .agent("b1"), presentation: .beside)),
            .selectContext(.agent("b1"), presentation: .full))
    }

    func testSplitsFromTheEditorToTheWorkspacesLastAgentAndBackToTheEditor() throws {
        let remembered = wireWorkspace("two", ["b1", "b2"], lastAgentId: "b2")
        XCTAssertEqual(
            try resolveChord(.toggleSplit, snapshotOf(workspaces: [remembered], context: .workspace("two"))),
            .selectContext(.workspace("two"), presentation: .beside))
        XCTAssertEqual(
            try resolveChord(.toggleSplit, snapshotOf(workspaces: [remembered], context: .workspace("two"), presentation: .beside)),
            .selectContext(.workspace("two"), presentation: .full))
    }

    func testSplitsFromAWorkspaceThatHasNeverHadAnAgentOpenToItsFirst() throws {
        XCTAssertEqual(
            try resolveChord(.toggleSplit, snapshotOf(workspaces: [two], context: .workspace("two"))),
            .selectContext(.workspace("two"), presentation: .beside))
    }

    func testLeavesTheSplitToTheHalfTheKeyboardWasMovedTo() throws {
        XCTAssertEqual(
            try resolveChord(.toggleSplit, snapshotOf(workspaces: [two], context: .agent("b2"), presentation: .beside)),
            .selectContext(.agent("b2"), presentation: .full))
    }

    func testTheSplitDoesNothingOnAWorkspaceWithNoAgentsOrOnScratch() throws {
        XCTAssertNil(try resolveChord(.toggleSplit, snapshotOf(workspaces: [empty], context: .workspace("empty"))))
        XCTAssertNil(try resolveChord(.toggleSplit, snapshotOf()))
    }

    func testAsksTheModelForTheJumpToScratchFromEitherEndOfIt() throws {
        XCTAssertEqual(try resolveChord(.toggleScratch, snapshotOf(workspaces: [two], context: .agent("b1"))), .toggleScratch(focus: .editor))
        XCTAssertEqual(try resolveChord(.toggleScratch, snapshotOf()), .toggleScratch(focus: .editor))
    }

    func testMovesTheKeyboardToTheOtherPaneOfASplitAndNowhereElse() throws {
        XCTAssertEqual(try resolveChord(.swapSplitFocus, snapshotOf(workspaces: [two], context: .agent("b1"), presentation: .beside)), .swapSplitFocus)
        XCTAssertNil(try resolveChord(.swapSplitFocus, snapshotOf(workspaces: [two], context: .agent("b1"))))
        XCTAssertNil(try resolveChord(.swapSplitFocus, snapshotOf()))
    }

    func testShowsTheEditorBySelectingItFromAnAgentOrFromScratch() throws {
        XCTAssertEqual(try resolveChord(.focusEditor, snapshotOf(workspaces: [two], context: .agent("b1"))), selects(.workspace("two")))
        XCTAssertEqual(try resolveChord(.focusEditor, snapshotOf()), selects(SCRATCH))
    }

    // MARK: the commands that act on what is selected

    private var inTwo: AppSnapshotWire { snapshotOf(workspaces: [one, two], context: .workspace("two")) }
    private var onAgent: AppSnapshotWire { snapshotOf(workspaces: [one, two], context: .agent("b2")) }

    func testAddsAnAgentToTheSelectedWorkspaceFromARowOrItsAgent() throws {
        XCTAssertEqual(try resolveChord(.addAgent, inTwo), .openAgentPicker(workspaceId: "two"))
        XCTAssertEqual(try resolveChord(.addAgent, onAgent), .openAgentPicker(workspaceId: "two"))
    }

    func testAddsAnAgentOnScratchLikeAnywhereButNotWhereOneCannotStart() throws {
        XCTAssertEqual(try resolveChord(.addAgent, snapshotOf()), .openAgentPicker(workspaceId: SCRATCH_ID))
        XCTAssertNil(try resolveChord(.addAgent, snapshotOf(workspaces: [wireWorkspace("shut", [], canCreateAgent: false)], context: .workspace("shut"))))
    }

    func testRenamesTheSelectedAgentAndNothingOnARow() throws {
        XCTAssertEqual(try resolveChord(.renameAgent, onAgent), .renameAgent(agentId: "b2"))
        XCTAssertNil(try resolveChord(.renameAgent, inTwo))
    }

    func testMarksTheSelectedAgentUnreadAndNothingOnARow() throws {
        XCTAssertEqual(try resolveChord(.markAgentUnread, onAgent), .markAgentUnread(agentId: "b2"))
        XCTAssertNil(try resolveChord(.markAgentUnread, inTwo))
    }

    func testSendsAnActionToTheSelectedAgentAndNothingOnARow() throws {
        XCTAssertEqual(try resolveChord(.sendAgentAction, onAgent), .openAgentActions(agentId: "b2"))
        XCTAssertNil(try resolveChord(.sendAgentAction, inTwo))
    }

    func testClosesTheSmallThingWhenStandingOnOneTheBigThingWhenNot() throws {
        XCTAssertEqual(try resolveChord(.closeSelection, onAgent), .closeAgent(agentId: "b2"))
        XCTAssertEqual(try resolveChord(.closeSelection, inTwo), .closeWorkspace(workspaceId: "two"))
        XCTAssertNil(try resolveChord(.closeSelection, snapshotOf()))
        XCTAssertEqual(
            try resolveChord(.closeSelection, snapshotOf(scratch: wireWorkspace(SCRATCH_ID, ["s1"], label: "Scratch"), context: .agent("s1"))),
            .closeAgent(agentId: "s1"))
    }

    func testClosesTheWorkspaceFromEitherRowAndNothingOnScratch() throws {
        XCTAssertEqual(try resolveChord(.closeWorkspace, inTwo), .closeWorkspace(workspaceId: "two"))
        XCTAssertEqual(try resolveChord(.closeWorkspace, onAgent), .closeWorkspace(workspaceId: "two"))
        XCTAssertNil(try resolveChord(.closeWorkspace, snapshotOf()))
    }

    // MARK: the commands that need nothing at all

    func testOpensThePickersTheSettingsAndTheHelp() throws {
        let nothing = snapshotOf()
        XCTAssertEqual(try resolveChord(.addWorkspace, nothing), .openWorkspacePicker)
        XCTAssertEqual(try resolveChord(.openTabPicker, nothing), .openTabPicker)
        XCTAssertEqual(try resolveChord(.openIssuePicker, nothing), .openIssuePicker)
        XCTAssertEqual(try resolveChord(.refreshRepositories, nothing), .refreshRepositories)
        XCTAssertEqual(try resolveChord(.openSettings, nothing), .openSettings)
        XCTAssertEqual(try resolveChord(.openLog, nothing), .openLog)
        XCTAssertEqual(try resolveChord(.focusSidebar, nothing), .focusSidebar)
        XCTAssertEqual(try resolveChord(.toggleSidebar, nothing), .toggleSidebar)
        XCTAssertEqual(try resolveChord(.showChordHelp, nothing), .openChordHelp)
        XCTAssertEqual(try resolveChord(.openCommandPalette, nothing), .openCommandPalette)
        var history = nothing
        history.history = HistoryAvailability(canGoBack: true, canGoForward: false)
        XCTAssertEqual(try resolveChord(.navigateBack, history), .navigateHistory(.back))
        XCTAssertNil(try resolveChord(.navigateForward, history))
    }

    func testAsksForTheAlertToGoWhetherOrNotOneIsShowing() throws {
        XCTAssertEqual(try resolveChord(.dismissAlert, snapshotOf()), .dismissAlert)
    }

    func testAsksForTheNoticeCenterWhetherOrNotAnythingWasSaid() throws {
        XCTAssertEqual(try resolveChord(.showNotifications, snapshotOf()), .showNotifications)
    }

    func testResolvesTheDoublePrefixToNothingTheRouterForwardsIt() throws {
        XCTAssertNil(try resolveChord(.forwardPrefix, snapshotOf()))
    }

    // MARK: the order every cycle walks

    private func uuid(_ last: String) -> String { "550e8400-e29b-41d4-a716-446655\(last)" }

    private func projected() throws -> AppSnapshotWire {
        var model = scratchModel("/src/daily/20260923")
        let ZEBRA_WT = uuid("4000a1"), ALPHA = uuid("4000a2"), ZEBRA = uuid("4000a3"), MIDDLE = uuid("4000a4")
        for (id, path) in [(ZEBRA_WT, "/src/zebra_topic"), (ALPHA, "/src/alpha"), (ZEBRA, "/src/zebra"), (MIDDLE, "/src/middle")] {
            try model.addWorkspace(Workspace(id: WorkspaceId(unchecked: id), location: .local(path: path), selectedPath: path))
        }
        try model.addAgent(owner: WorkspaceId(unchecked: ZEBRA), id: AgentId(unchecked: uuid("4000b1")), profile: profile(), agentPresentation: .tui)
        try model.addAgent(owner: WorkspaceId(unchecked: ZEBRA_WT), id: AgentId(unchecked: uuid("4000b2")), profile: profile(), agentPresentation: .tui)
        try model.addAgent(owner: WorkspaceId(unchecked: ALPHA), id: AgentId(unchecked: uuid("4000b3")), profile: profile(), agentPresentation: .tui)
        let repositories = [ZEBRA: "/src/zebra", ZEBRA_WT: "/src/zebra", ALPHA: "/src/alpha"]
        return try Projection.snapshotWire(model.snapshot(), readiness: .ready, repositoryOf: { repositories[$0] }, homeOf: { _ in nil })
    }

    private func sidebarRows(_ snapshot: AppSnapshotWire) throws -> [ContextWire] {
        let (scratch, rows) = try snapshot.sidebarWorkspaces()
        return ([scratch] + rows).flatMap { workspace in [ContextWire.workspace(workspace.id)] + workspace.agents.map { .agent($0.id) } }
    }

    private func selecting(_ snapshot: AppSnapshotWire, _ context: ContextWire) -> AppSnapshotWire {
        var copy = snapshot
        copy.selection = SelectionWire(context: context, presentation: .full)
        return copy
    }

    func testGroupsWorktreesUnderTheirRepositoryByName() throws {
        XCTAssertEqual(try projected().sidebarWorkspaces().rows.map(\.label), ["alpha", "middle", "zebra", "zebra_topic"])
    }

    func testStepsNextTabThroughTheRowsTheSidebarDraws() throws {
        let snapshot = try projected()
        let rows = try sidebarRows(snapshot)
        var visited: [ContextWire] = []
        var context = ContextWire.workspace(snapshot.scratchWorkspaceId)
        for _ in rows {
            guard case let .selectContext(next, _, _, _)? = try resolveChord(.nextTab, selecting(snapshot, context)) else { return XCTFail() }
            context = next
            visited.append(context)
        }
        XCTAssertEqual(visited, Array(rows.dropFirst()) + [rows[0]])
    }

    func testStepsNextAgentThroughTheAgentsInTheSameOrder() throws {
        let snapshot = try projected()
        let agents = try sidebarRows(snapshot).filter { $0.agentId != nil }
        var visited: [ContextWire] = []
        var context = ContextWire.workspace(snapshot.scratchWorkspaceId)
        for _ in agents {
            guard case let .selectContext(next, _, _, _)? = try resolveChord(.nextAgent, selecting(snapshot, context)) else { return XCTFail() }
            context = next
            visited.append(context)
        }
        XCTAssertEqual(visited, agents)
    }

    func testNamesTheRowsADigitSelectsInTheSameOrder() throws {
        let snapshot = try projected()
        XCTAssertEqual(try resolveChord(.selectEntry1, snapshot), selects(.workspace(uuid("4000a2"))))
        XCTAssertEqual(try resolveChord(.selectEntry2, snapshot), selects(.workspace(uuid("4000a4"))))
    }

    // MARK: moving the row that is selected

    private let tree = [
        wireWorkspace("alpha", ["a1", "a2"]), wireWorkspace("widget", []),
        wireWorkspace("widget_a", [], groupKey: "/workspaces/widget"), wireWorkspace("widget_b", [], groupKey: "/workspaces/widget"),
        wireWorkspace("zebra", []),
    ]

    private func move(_ context: ContextWire, _ commandId: CommandId) throws -> ChordEffect? {
        try resolveChord(commandId, snapshotOf(workspaces: tree, context: context))
    }

    func testMovesARepositoryPastTheGroupBelowItWorktreesAndAll() throws {
        XCTAssertEqual(
            try move(.workspace("widget"), .moveEntryDown),
            .reorderEntries(workspaceId: nil, order: ["alpha", "zebra", "widget", "widget_a", "widget_b"]))
    }

    func testMovesAWorktreeWithinItsOwnGroup() throws {
        XCTAssertEqual(
            try move(.workspace("widget_b"), .moveEntryUp),
            .reorderEntries(workspaceId: nil, order: ["alpha", "widget", "widget_b", "widget_a", "zebra"]))
    }

    func testWillNotLiftAWorktreeOverItsOwnRepository() throws {
        XCTAssertNil(try move(.workspace("widget_a"), .moveEntryUp))
    }

    func testIsANoOpAtEitherEndOfTheRange() throws {
        XCTAssertNil(try move(.workspace("alpha"), .moveEntryUp))
        XCTAssertNil(try move(.workspace("zebra"), .moveEntryDown))
        XCTAssertNil(try move(.workspace("widget_b"), .moveEntryDown))
    }

    func testMovesAnAgentWithinItsOwnWorkspace() throws {
        XCTAssertEqual(try move(.agent("a2"), .moveEntryUp), .reorderEntries(workspaceId: "alpha", order: ["a2", "a1"]))
        XCTAssertNil(try move(.agent("a1"), .moveEntryUp))
    }

    func testDoesNothingOnScratchWhichIsTheFirstRowByDefinition() throws {
        XCTAssertNil(try move(SCRATCH, .moveEntryDown))
        XCTAssertNil(try move(SCRATCH, .moveEntryUp))
    }

    // MARK: the Agent's terminal

    private let T1 = "11111111-1111-4111-8111-111111111111"

    private func withTerminal(_ focused: Bool, _ presentation: SurfacePresentation = .full) -> AppSnapshotWire {
        var snapshot = snapshotOf(workspaces: [one], context: .agent("a1"), presentation: presentation)
        snapshot.visibleTerminal = T1
        if focused { snapshot.paneFocus = T1 }
        return snapshot
    }

    func testTogglesTheSelectedAgentsTerminal() throws {
        XCTAssertEqual(try resolveChord(.toggleTerminal, snapshotOf(workspaces: [one], context: .agent("a1"))), .toggleTerminal(agentId: "a1"))
    }

    func testOnAWorkspacesRowBesideAnAgentTogglesTheAgentItPairsWith() throws {
        XCTAssertEqual(
            try resolveChord(.toggleTerminal, snapshotOf(workspaces: [two], context: .workspace("two"), presentation: .beside)),
            .toggleTerminal(agentId: "b1"))
        var remembered = two
        remembered.lastAgentId = "b2"
        XCTAssertEqual(
            try resolveChord(.toggleTerminal, snapshotOf(workspaces: [remembered], context: .workspace("two"), presentation: .beside)),
            .toggleTerminal(agentId: "b2"))
    }

    func testOnTheWorkbenchAloneSaysTheTerminalIsShownWithItsAgent() throws {
        XCTAssertEqual(
            try resolveChord(.toggleTerminal, snapshotOf(workspaces: [two], context: .workspace("two"))), .terminalNeedsAgentView(workspaceId: "two"))
    }

    func testSaysSoOnAWorkspaceWithNoAgentRatherThanDoingNothing() throws {
        XCTAssertEqual(
            try resolveChord(.toggleTerminal, snapshotOf(workspaces: [empty], context: .workspace("empty"))), .terminalNeedsAgent(workspaceId: "empty"))
        XCTAssertEqual(try resolveChord(.toggleTerminal, snapshotOf()), .terminalNeedsAgent(workspaceId: SCRATCH_ID))
    }

    func testCyclesToTheTerminalOnceOneIsShownAndSwapsABareSplitAsBefore() throws {
        XCTAssertEqual(try resolveChord(.swapSplitFocus, withTerminal(false)), .cyclePaneFocus)
        XCTAssertEqual(try resolveChord(.swapSplitFocus, snapshotOf(workspaces: [one], context: .agent("a1"), presentation: .beside)), .swapSplitFocus)
        XCTAssertNil(try resolveChord(.swapSplitFocus, snapshotOf()))
    }

    func testClosesTheFocusedTerminalWithXAndTheAgentOtherwise() throws {
        XCTAssertEqual(try resolveChord(.closeSelection, withTerminal(true)), .closeTerminal(terminalId: T1))
        XCTAssertEqual(try resolveChord(.closeSelection, withTerminal(false)), .closeAgent(agentId: "a1"))
    }

    func testStillFocusesTheSidebarFromThePalette() throws {
        XCTAssertEqual(try resolveChord(.focusSidebar, snapshotOf()), .focusSidebar)
    }
}

final class ChordsTableTests: XCTestCase {
    private func press(
        _ key: String, _ code: String, command: Bool = false, shift: Bool = false, option: Bool = false, control: Bool = false
    ) -> CommandId? {
        Chords.match(Chords.defaultTable(), KeyStroke(
            key: ChordKeys.strokeKey(key), code: code, command: command, control: control, option: option, shift: shift))?.commandId
    }

    func testReachesThePickerByTheFinderKey() {
        XCTAssertEqual(press("f", "KeyF"), .addWorkspace)
    }

    func testGivesTheThreeNewCommandsTheFreeUnshiftedLetters() {
        XCTAssertNil(press("s", "KeyS"))
        XCTAssertEqual(press("v", "KeyV"), .toggleTerminal)
        XCTAssertNil(press("S", "KeyS", shift: true))
        XCTAssertNil(press("ArrowLeft", "ArrowLeft"))
        XCTAssertNil(press("ArrowUp", "ArrowUp"))
        XCTAssertEqual(press("b", "KeyB"), .toggleSidebar)
        XCTAssertEqual(press("u", "KeyU"), .markAgentUnread)
        XCTAssertEqual(press("d", "KeyD"), .dismissAlert)
        XCTAssertEqual(press("m", "KeyM"), .showNotifications)
        XCTAssertNil(press("M", "KeyM", shift: true))
    }

    func testKeepsTheCaseRuleLowerActsInsideUpperReachesFurther() {
        XCTAssertEqual(press("c", "KeyC"), .addAgent)
        XCTAssertEqual(press("W", "KeyW", shift: true), .closeWorkspace)
        XCTAssertNil(press("w", "KeyW"))
    }

    func testSeparatesRenameFromSettingsByShiftAsTheMultiplexerDoes() {
        XCTAssertEqual(press(",", "Comma"), .renameAgent)
        XCTAssertEqual(press("<", "Comma", shift: true), .openSettings)
    }

    func testNoLongerClaimsTheWorkbenchsTerminalKey() {
        XCTAssertNil(press("t", "KeyT"))
        XCTAssertNil(press("j", "KeyJ", control: true))
    }

    func testGivesTheThreeCyclesThreeDifferentKeys() {
        XCTAssertEqual(press("N", "KeyN", shift: true), .nextWorkspace)
        XCTAssertEqual(press("]", "BracketRight"), .nextAgent)
        XCTAssertEqual(press("n", "KeyN", command: true), .nextTab)
    }

    func testPutsTheUnreadNarrowingOnShiftOverTheSameBrackets() {
        XCTAssertEqual(press("}", "BracketRight", shift: true), .nextUnreadAgent)
        XCTAssertEqual(press("{", "BracketLeft", shift: true), .previousUnreadAgent)
    }

    func testReachesTheAgentCycleWithCommandHeldAsWell() {
        XCTAssertEqual(press("]", "BracketRight", command: true), .nextAgent)
        XCTAssertEqual(press("[", "BracketLeft", command: true), .previousAgent)
        XCTAssertEqual(press("[", "BracketLeft"), .previousAgent)
    }

    func testPutsBackAndForwardOnVimsHAndL() {
        XCTAssertEqual(press("h", "KeyH"), .navigateBack)
        XCTAssertEqual(press("l", "KeyL"), .navigateForward)
    }

    func testMatchesTheCharacterSoAJisKeyboardReachesTheSameCommands() {
        XCTAssertEqual(press("{", "BracketRight", shift: true), .previousUnreadAgent)
        XCTAssertEqual(press("}", "Backslash", shift: true), .nextUnreadAgent)
        XCTAssertEqual(press("[", "BracketRight"), .previousAgent)
        XCTAssertEqual(press("]", "Backslash"), .nextAgent)
        XCTAssertNil(press("@", "BracketLeft", shift: true))
    }

    func testIsReachedByOptionAndAnArrowOnAnyKeyboard() {
        XCTAssertEqual(press("ArrowUp", "ArrowUp", option: true), .moveEntryUp)
        XCTAssertEqual(press("ArrowDown", "ArrowDown", option: true), .moveEntryDown)
    }
}

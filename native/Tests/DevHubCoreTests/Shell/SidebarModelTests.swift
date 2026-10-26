// Ports of the decisions tested by apps/desktop/src/shell/components/sidebar/
// rowMenu.test.tsx, sidebarReorder.test.tsx, agentActivity.test.tsx,
// chordDigits.test.tsx, closingRow.test.tsx, sidebarKeyboard.test.tsx,
// statusMark.test.tsx and scratchRow.test.tsx — the parts that are not DOM.

import XCTest
@testable import DevHubCore

private typealias F = ShellFixtures

private func reorderSnapshot() -> AppSnapshotWire {
    F.snapshot([
        F.workspace("w-alpha", label: "alpha", agents: [F.agent("a-1", in: "w-alpha", ordinal: 0), F.agent("a-2", in: "w-alpha", ordinal: 1)]),
        F.workspace("w-widget", label: "widget"),
        F.workspace("w-wt-a", label: "widget_a", groupKey: "/work/widget"),
        F.workspace("w-wt-b", label: "widget_b", groupKey: "/work/widget"),
        F.workspace("w-zebra", label: "zebra"),
    ])
}

private let noProfiles = SidebarProfiles(available: true, names: ["claude": "Claude"])

final class SidebarRowMenuTests: XCTestCase {
    private func labels(_ items: [Sidebar.MenuItem]) -> [String] { items.map(\.label) }

    func testOffersRenameUnreadRestartContinueAndStopOnARunningGuiAgent() {
        let agent = F.agent("a-1", in: "w", presentation: .gui)
        XCTAssertEqual(labels(Sidebar.agentMenu(agent)), ["Rename…", "Mark as Unread", "Restart Session", "Continue in Terminal", "Stop Agent"])
    }

    func testOffersATerminalClaudeAgentContinueInGui() {
        let items = Sidebar.agentMenu(F.agent("a-1", in: "w", presentation: .tui))
        XCTAssertTrue(labels(items).contains("Continue in GUI"))
        XCTAssertFalse(labels(items).contains("Continue in Terminal"))
        XCTAssertEqual(items.first { $0.id == "continue" }?.action, .continueAgent(agentId: "a-1"))
    }

    func testOffersNoContinueForOtherCLIsAFailedAgentOrOneNotRunning() {
        for agent in [
            F.agent("a", in: "w", kind: .cursor),
            F.agent("a", in: "w", failure: AgentFailure(code: .conversationFailed)),
            F.agent("a", in: "w", control: .stopping),
            F.agent("a", in: "w", control: .stopFailed(diagnostic: .cleanupFailed)),
        ] {
            XCTAssertFalse(labels(Sidebar.agentMenu(agent)).contains { $0.hasPrefix("Continue") })
        }
    }

    func testPutsStopAgentLastAndApart() {
        let items = Sidebar.agentMenu(F.agent("a-1", in: "w"))
        XCTAssertEqual(items.last?.id, "stop")
        XCTAssertEqual(items.last?.separated, true)
        XCTAssertFalse(items.dropLast().contains { $0.separated })
    }

    func testLeavesOutMarkAsUnreadOnAnAgentAlreadyUnread() {
        XCTAssertFalse(labels(Sidebar.agentMenu(F.agent("a", in: "w", unread: .idle))).contains("Mark as Unread"))
    }

    func testOffersRestartOnATerminalClaudeOrCodexAndNotOnACustomCLI() {
        for kind in [AgentProfileKind.claude, .codex] {
            XCTAssertTrue(labels(Sidebar.agentMenu(F.agent("a", in: "w", kind: kind))).contains("Restart Session"))
        }
        XCTAssertFalse(labels(Sidebar.agentMenu(F.agent("a", in: "w", kind: .custom))).contains("Restart Session"))
    }

    func testSaysRetryStopAfterAStopFailedAndNothingWhileStopping() {
        let failed = Sidebar.agentMenu(F.agent("a", in: "w", control: .stopFailed(diagnostic: .cleanupFailed)))
        XCTAssertTrue(labels(failed).contains("Retry Stop"))
        XCTAssertEqual(failed.last?.action, .intent(.retryStopAgent(agentId: "a")))
        let stopping = Sidebar.agentMenu(F.agent("a", in: "w", control: .stopping))
        XCTAssertFalse(labels(stopping).contains { $0.contains("Stop") })
    }

    func testOffersOnlyTheCloseOnAWorkspaceAndSaysWorktreeWhereClosingDeletesTheFolder() throws {
        let snapshot = F.snapshot([F.workspace("w-1", label: "widget")])
        let plain = Sidebar.row(snapshot.workspace("w-1")!, snapshot: snapshot, repository: nil, profiles: noProfiles, digit: nil)
        XCTAssertEqual(labels(Sidebar.workspaceMenu(plain)), ["Close Workspace…"])
        let worktree = WorkspaceRepositoryWire(workspaceId: "w-1", mainWorktree: "/work/main", worktree: "/work/widget")
        let deleting = Sidebar.row(snapshot.workspace("w-1")!, snapshot: snapshot, repository: worktree, profiles: noProfiles, digit: nil)
        XCTAssertEqual(labels(Sidebar.workspaceMenu(deleting)), ["Close Worktree…"])
        XCTAssertEqual(Sidebar.workspaceMenu(deleting).first?.separated, true)
    }

    func testOffersScratchNoMenu() throws {
        let model = try Sidebar.model(F.snapshot(), repositories: RepositoryStatusWire(), profiles: noProfiles, armed: false)
        XCTAssertEqual(Sidebar.workspaceMenu(model.scratch), [])
    }
}

final class SidebarReorderTests: XCTestCase {
    func testAWorktreeLandsOnlyAmongTheWorktreesOfItsRepository() throws {
        let snapshot = reorderSnapshot()
        XCTAssertEqual(try Sidebar.dropLane(snapshot, .workspace("w-wt-a")), ["w-wt-a", "w-wt-b"])
        XCTAssertEqual(try Sidebar.dropLane(snapshot, .workspace("w-zebra")), ["w-alpha", "w-widget", "w-zebra"])
    }

    func testAnAgentLandsOnlyAmongItsOwnWorkspacesAgents() throws {
        XCTAssertEqual(try Sidebar.dropLane(reorderSnapshot(), .agent("a-1", workspaceId: "w-alpha")), ["a-1", "a-2"])
    }

    func testTheGapUnderThePointer() {
        let lane = ["w-alpha", "w-widget", "w-zebra"]
        XCTAssertEqual(Sidebar.gap(lane, rowId: "w-widget", half: .top), .before("w-widget"))
        XCTAssertEqual(Sidebar.gap(lane, rowId: "w-widget", half: .bottom), .before("w-zebra"))
        XCTAssertEqual(Sidebar.gap(lane, rowId: "w-zebra", half: .bottom), .end)
        XCTAssertEqual(Sidebar.gap(lane, rowId: "w-wt-a", half: .top), .none)
    }

    func testAsksForTheWholeOrderTheDropComesTo() throws {
        XCTAssertEqual(
            try Sidebar.dropIntent(reorderSnapshot(), .workspace("w-zebra"), before: "w-alpha"),
            .reorderWorkspaces(["w-zebra", "w-alpha", "w-widget", "w-wt-a", "w-wt-b"]))
    }

    func testMovesAWorktreeWithinItsGroupAndTakesNothingElseWithIt() throws {
        XCTAssertEqual(
            try Sidebar.dropIntent(reorderSnapshot(), .workspace("w-wt-b"), before: "w-wt-a"),
            .reorderWorkspaces(["w-alpha", "w-widget", "w-wt-b", "w-wt-a", "w-zebra"]))
    }

    func testAsksForNothingWhenTheRowIsLetGoWhereItAlreadyWas() throws {
        XCTAssertNil(try Sidebar.dropIntent(reorderSnapshot(), .workspace("w-wt-a"), before: "w-wt-a"))
    }

    func testMovesAnAgentWithinItsOwnWorkspace() throws {
        XCTAssertEqual(
            try Sidebar.dropIntent(reorderSnapshot(), .agent("a-2", workspaceId: "w-alpha"), before: "a-1"),
            .reorderAgents(workspaceId: "w-alpha", order: ["a-2", "a-1"]))
    }

    func testScratchIsNeverPickedUp() throws {
        let model = try Sidebar.model(reorderSnapshot(), repositories: RepositoryStatusWire(), profiles: noProfiles, armed: false)
        XCTAssertTrue(model.scratch.fixed)
    }

    func testMovingARowWithTheKeyboard() throws {
        let snapshot = reorderSnapshot()
        XCTAssertEqual(
            try Sidebar.moveIntent(snapshot, .workspace("w-widget"), .down),
            .reorderWorkspaces(["w-alpha", "w-zebra", "w-widget", "w-wt-a", "w-wt-b"]))
        XCTAssertEqual(
            try Sidebar.moveIntent(snapshot, .agent("a-1", workspaceId: "w-alpha"), .down),
            .reorderAgents(workspaceId: "w-alpha", order: ["a-2", "a-1"]))
        XCTAssertNil(try Sidebar.moveIntent(snapshot, .workspace("w-wt-a"), .up))
        XCTAssertNil(try Sidebar.moveIntent(snapshot, .workspace("w-alpha"), .up))
    }

    func testReadsATreeItemsSource() {
        let snapshot = reorderSnapshot()
        XCTAssertEqual(Sidebar.source(ofTreeItem: "workspace:w-zebra", snapshot), .workspace("w-zebra"))
        XCTAssertEqual(Sidebar.source(ofTreeItem: "agent:a-2", snapshot), .agent("a-2", workspaceId: "w-alpha"))
        XCTAssertNil(Sidebar.source(ofTreeItem: "agent:nobody", snapshot))
    }
}

final class SidebarRowTests: XCTestCase {
    func testLeadsWithWhatTheAgentIsDoingAndNamesItselfAfterIt() throws {
        let snapshot = F.snapshot([F.workspace("w", agents: [F.agent("a", in: "w", name: "Claude 2", activity: "Reading files")])])
        let row = try Sidebar.model(snapshot, repositories: RepositoryStatusWire(), profiles: noProfiles, armed: false)
        guard case let .workspace(workspace) = row.rows.first else { return XCTFail("no row") }
        XCTAssertEqual(workspace.agents[0].leading, "Reading files")
        XCTAssertEqual(workspace.agents[0].naming, "Claude 2")
    }

    func testDropsTheNameWhenItIsOnlyTheKindOfAgent() throws {
        let snapshot = F.snapshot([F.workspace("w", agents: [F.agent("a", in: "w", name: "Claude", activity: "Thinking")])])
        let row = try Sidebar.model(snapshot, repositories: RepositoryStatusWire(), profiles: noProfiles, armed: false)
        guard case let .workspace(workspace) = row.rows.first else { return XCTFail("no row") }
        XCTAssertNil(workspace.agents[0].naming)
        XCTAssertTrue(workspace.agents[0].description.contains("Claude"))
    }

    func testLeadsWithItsNameWhenTheAgentHasSaidNothing() throws {
        let snapshot = F.snapshot([F.workspace("w", agents: [F.agent("a", in: "w", name: "Codex")])])
        let row = try Sidebar.model(snapshot, repositories: RepositoryStatusWire(), profiles: noProfiles, armed: false)
        guard case let .workspace(workspace) = row.rows.first else { return XCTFail("no row") }
        XCTAssertEqual(workspace.agents[0].leading, "Codex")
        XCTAssertNil(workspace.agents[0].naming)
    }

    func testTheUnreadMarkIsTheIdleAgentsAndOnlyThenSaid() {
        XCTAssertEqual(Glyphs.status(.idle, unread: true), .statusUnread)
        XCTAssertEqual(Glyphs.status(.working, unread: true), .statusWorking)
        XCTAssertEqual(Glyphs.status(.background, unread: true), .statusBackground)
        XCTAssertEqual(Glyphs.status(.idle, unread: false), .statusIdle)
        let snapshot = F.snapshot([F.workspace("w", agents: [F.agent("a", in: "w", status: .idle, unread: .idle)])])
        let model = try? Sidebar.model(snapshot, repositories: RepositoryStatusWire(), profiles: noProfiles, armed: false)
        guard case let .workspace(workspace)? = model?.rows.first else { return XCTFail("no row") }
        XCTAssertEqual(workspace.agents[0].statusLabel, "Idle, unread")
        XCTAssertTrue(workspace.agents[0].showsUnread)
    }

    func testSaysWhyAStopFailedOnTheRow() throws {
        let snapshot = F.snapshot([F.workspace("w", agents: [F.agent("a", in: "w", control: .stopFailed(diagnostic: .closeAgentsUnknown))])])
        let model = try Sidebar.model(snapshot, repositories: RepositoryStatusWire(), profiles: noProfiles, armed: false)
        guard case let .workspace(workspace) = model.rows.first else { return XCTFail("no row") }
        XCTAssertEqual(workspace.agents[0].note, "DevHub could not confirm the agents had stopped.")
        XCTAssertTrue(workspace.agents[0].description.contains("DevHub could not confirm the agents had stopped."))
        XCTAssertEqual(workspace.agents[0].stopTooltip, "Retry stop")
    }

    func testNumbersScratchZeroAndTheWorkspacesFromOneWhileArmedAndStopsAtNine() throws {
        let workspaces = (1...11).map { F.workspace("w\($0)") }
        let unarmed = try Sidebar.model(F.snapshot(workspaces), repositories: RepositoryStatusWire(), profiles: noProfiles, armed: false)
        XCTAssertNil(unarmed.scratch.digit)
        let armed = try Sidebar.model(F.snapshot(workspaces), repositories: RepositoryStatusWire(), profiles: noProfiles, armed: true)
        XCTAssertEqual(armed.scratch.digit, 0)
        let digits = armed.rows.compactMap { entry -> Int?? in
            if case let .workspace(row) = entry { return .some(row.digit) } else { return nil }
        }
        XCTAssertEqual(digits, [1, 2, 3, 4, 5, 6, 7, 8, 9, nil, nil])
    }

    func testScratchIsTheFirstRowWithTheTerminalMarkAndIsNeitherClosedNorDragged() throws {
        let model = try Sidebar.model(F.snapshot([F.workspace("w")]), repositories: RepositoryStatusWire(), profiles: noProfiles, armed: false)
        XCTAssertEqual(model.scratch.label, "Scratch")
        XCTAssertEqual(model.scratch.glyph, .terminal)
        XCTAssertTrue(model.scratch.fixed)
        XCTAssertNil(model.scratch.closeTooltip)
        XCTAssertTrue(model.scratch.description.contains("~/work/Scratch"))
    }

    func testRefusesASnapshotWhoseScratchIsNotAmongItsWorkspaces() {
        var snapshot = F.snapshot()
        snapshot.scratchWorkspaceId = "somebody-else"
        XCTAssertThrowsError(try Sidebar.model(snapshot, repositories: RepositoryStatusWire(), profiles: noProfiles, armed: false))
    }

    func testAClosingRowOffersNothingAndIsNotAStop() throws {
        let snapshot = F.snapshot([F.workspace("w", close: .running)])
        let model = try Sidebar.model(snapshot, repositories: RepositoryStatusWire(), profiles: noProfiles, armed: false)
        guard case let .workspace(row) = model.rows.first else { return XCTFail("no row") }
        XCTAssertTrue(row.closing)
        XCTAssertNil(row.closeTooltip)
        XCTAssertFalse(row.canCreateAgent)
        XCTAssertEqual(row.state, .dimmed)
        XCTAssertFalse(Sidebar.treeItems(model).contains { $0.id == "workspace:w" })
    }

    func testAFailedCloseIsTheDangerInkAndSaysRetry() throws {
        let snapshot = F.snapshot([F.workspace("w", close: .failed(step: .agents, diagnostic: .closeAgentsUnknown, detail: nil))])
        let model = try Sidebar.model(snapshot, repositories: RepositoryStatusWire(), profiles: noProfiles, armed: false)
        guard case let .workspace(row) = model.rows.first else { return XCTFail("no row") }
        XCTAssertEqual(row.state, .closeFailed)
        XCTAssertEqual(row.closeTooltip, "Retry close")
        XCTAssertTrue(row.description.contains("Closing stopped while stopping the agents."))
    }

    func testTheCreateButtonSaysWhyItCannotBePressed() throws {
        let snapshot = F.snapshot([F.workspace("w")])
        let none = try Sidebar.model(snapshot, repositories: RepositoryStatusWire(), profiles: SidebarProfiles(available: true, names: [:]), armed: false)
        guard case let .workspace(row) = none.rows.first else { return XCTFail("no row") }
        XCTAssertFalse(row.createAgentEnabled)
        XCTAssertEqual(row.createAgentTooltip, "No enabled agent profiles")
        XCTAssertEqual(row.createAgentLabel, "Create agent in w, unavailable")
    }

    func testABranchLeavesTheLineOnceTheIssueIsKnown() throws {
        let snapshot = F.snapshot([F.workspace("w")])
        let branchOnly = WorkspaceRepositoryWire(workspaceId: "w", branch: "main")
        let row = Sidebar.row(snapshot.workspace("w")!, snapshot: snapshot, repository: branchOnly, profiles: noProfiles, digit: nil)
        XCTAssertEqual(row.branch, "main")
        var withIssue = branchOnly
        withIssue.issue = IssueStatus(number: 7, title: "Fix it", state: .open, url: "https://github.com/o/r/issues/7")
        let issueRow = Sidebar.row(snapshot.workspace("w")!, snapshot: snapshot, repository: withIssue, profiles: noProfiles, digit: nil)
        XCTAssertNil(issueRow.branch)
        XCTAssertEqual(issueRow.issue?.label, "Issue #7, open: Fix it")
    }
}

final class SidebarClosingTests: XCTestCase {
    func testKeepsAClosedRowAsAGhostAndOnlyARowThatWasClosing() {
        let before = [(id: "a", label: "alpha", closing: false), (id: "b", label: "beta", closing: true), (id: "c", label: "gamma", closing: false)]
        let after = [F.workspace("a")]
        XCTAssertEqual(Sidebar.rowsThatLeft(before, after), [ExitingRow(id: "b", label: "beta", index: 1)])
    }

    func testPutsTheGhostBackInThePlaceItHeldClampedToTheEnd() {
        let live = [F.workspace("a"), F.workspace("c")].map { SidebarEntry.workspace(Sidebar.row($0, snapshot: F.snapshot([$0]), repository: nil, profiles: noProfiles, digit: nil)) }
        let merged = Sidebar.merge(live, [ExitingRow(id: "b", label: "beta", index: 1), ExitingRow(id: "z", label: "zeta", index: 9)])
        let ids = merged.map { entry -> String in
            switch entry {
            case let .workspace(row): return row.id
            case let .exiting(row): return "ghost:\(row.id)"
            }
        }
        XCTAssertEqual(ids, ["a", "ghost:b", "c", "ghost:z"])
    }
}

final class SidebarKeyboardTests: XCTestCase {
    private func model() throws -> SidebarModel {
        try Sidebar.model(reorderSnapshot(), repositories: RepositoryStatusWire(), profiles: noProfiles, armed: false)
    }

    func testTheTabStopIsTheSelectedRow() throws {
        let items = Sidebar.treeItems(try model())
        XCTAssertEqual(Sidebar.tabStop(items, requested: nil, selection: .workspace(F.scratchId)), "workspace:\(F.scratchId)")
        XCTAssertEqual(Sidebar.tabStop(items, requested: nil, selection: .agent("a-2")), "agent:a-2")
        XCTAssertEqual(Sidebar.tabStop(items, requested: "agent:a-1", selection: .agent("a-2")), "agent:a-1")
        XCTAssertEqual(Sidebar.tabStop(items, requested: "agent:gone", selection: .workspace("w-zebra")), "workspace:w-zebra")
    }

    func testTheArrowsWalkTheTreeAndWrap() throws {
        let items = Sidebar.treeItems(try model())
        XCTAssertEqual(Sidebar.walk(items, from: "workspace:w-alpha", key: "arrowdown"), "agent:a-1")
        XCTAssertEqual(Sidebar.walk(items, from: "agent:a-2", key: "arrowdown"), "workspace:w-widget")
        XCTAssertEqual(Sidebar.walk(items, from: "workspace:\(F.scratchId)", key: "arrowup"), "workspace:w-zebra")
        XCTAssertEqual(Sidebar.walk(items, from: "workspace:w-zebra", key: "arrowdown"), "workspace:\(F.scratchId)")
        XCTAssertEqual(Sidebar.walk(items, from: "agent:a-2", key: "home"), "workspace:\(F.scratchId)")
        XCTAssertEqual(Sidebar.walk(items, from: nil, key: "end"), "workspace:w-zebra")
    }

    func testTheHorizontalKeysWalkBetweenAWorkspaceAndItsAgents() throws {
        let items = Sidebar.treeItems(try model())
        XCTAssertEqual(Sidebar.walk(items, from: "workspace:w-alpha", key: "arrowright"), "agent:a-1")
        XCTAssertEqual(Sidebar.walk(items, from: "agent:a-2", key: "arrowleft"), "workspace:w-alpha")
        XCTAssertNil(Sidebar.walk(items, from: "workspace:w-zebra", key: "arrowright"))
        XCTAssertNil(Sidebar.walk(items, from: "workspace:w-zebra", key: "arrowleft"))
    }
}

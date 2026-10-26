// Port of apps/desktop/src/model/appModel.test.ts

import XCTest
@testable import DevHubCore

let WS_A = WorkspaceId(unchecked: "550e8400-e29b-41d4-a716-446655440000")
let WS_B = WorkspaceId(unchecked: "550e8400-e29b-41d4-a716-446655440001")
let AG_A = AgentId(unchecked: "550e8400-e29b-41d4-a716-4466554400a0")
let AG_B = AgentId(unchecked: "550e8400-e29b-41d4-a716-4466554400a1")
let codex = profile()

extension AppModel {
    /// `model.addAgent(owner, id, codex, "tui")`.
    mutating func add(_ owner: WorkspaceId, _ id: AgentId, _ profile: AgentProfile = codex, _ presentation: AgentPresentation = .tui) throws {
        try addAgent(owner: owner, id: id, profile: profile, agentPresentation: presentation)
    }

    /// Scratch, as a context.
    var scratchContext: NavigationContext { .workspace(scratchWorkspaceId) }

    func full(_ context: NavigationContext) -> SurfaceLayout {
        resolveLayout(NavigationSelection(context: context, presentation: .full))
    }
}

func modelWith(_ roots: (WorkspaceId, String)...) throws -> AppModel {
    var model = scratchModel()
    for (id, path) in roots {
        try model.addWorkspace(Workspace(id: id, location: .local(path: path), selectedPath: path))
    }
    return model
}

final class AppModelTests: XCTestCase {
    func testStartsOnScratchWhichIsItsOnlyWorkspaceAndIsCalledScratch() {
        let model = scratchModel()
        let snapshot = model.snapshot()
        XCTAssertEqual(snapshot.workspaces.count, 1)
        XCTAssertEqual(snapshot.scratchWorkspaceId, model.scratchWorkspaceId)
        XCTAssertEqual(snapshot.workspaces[0].id, model.scratchWorkspaceId)
        XCTAssertEqual(snapshot.workspaces[0].label, "Scratch")
        XCTAssertEqual(snapshot.workspaces[0].root, scratchPath)
        XCTAssertEqual(snapshot.selection, NavigationSelection(context: model.scratchContext, presentation: .full))
        XCTAssertEqual(snapshot.revision, 0)
    }

    // MARK: layout resolution

    func testGivesScratchItsOwnWorkbenchLikeAnyWorkspace() {
        let model = scratchModel()
        XCTAssertEqual(model.full(model.scratchContext), .workbench(editor: .workspaceEditor(model.scratchWorkspaceId)))
    }

    func testGivesAWorkspaceItsOwnWorkbenchAlone() throws {
        let model = try modelWith((WS_A, "/dev/a"))
        XCTAssertEqual(model.full(.workspace(WS_A)), .workbench(editor: .workspaceEditor(WS_A)))
    }

    func testHasNothingToShowForAWorkspaceThatIsNotAvailable() throws {
        var model = try modelWith((WS_A, "/dev/a"))
        try model.markWorkspaceUnavailable(WS_A, .rootMissing)
        XCTAssertEqual(model.full(.workspace(WS_A)), .unavailable)
        try model.markWorkspaceAvailable(WS_A)
        try model.beginWorkspaceClose(WS_A)
        XCTAssertEqual(model.full(.workspace(WS_A)), .unavailable)
        try model.markWorkspaceCloseFailed(WS_A, step: .terminal, diagnostic: .closeTerminalUnknown)
        XCTAssertEqual(model.full(.workspace(WS_A)), .workbench(editor: .workspaceEditor(WS_A)))
    }

    func testGivesAPlainlySelectedAgentTheWholeContentArea() throws {
        var model = try modelWith((WS_A, "/dev/a"))
        try model.add(WS_A, AG_A)
        XCTAssertEqual(model.full(.agent(AG_A)), .agent(agent: .agent(AG_A)))
    }

    func testSplitsAnAgentBesideItsOwnWorkspacesWorkbenchWhenAsked() throws {
        var model = try modelWith((WS_A, "/dev/a"))
        try model.add(WS_A, AG_A)
        XCTAssertEqual(
            model.resolveLayout(NavigationSelection(context: .agent(AG_A), presentation: .beside)),
            .split(editor: .workspaceEditor(WS_A), agent: .agent(AG_A))
        )
    }

    func testKeepsThePresentationOutOfASelectionWithNoOtherHalf() throws {
        var model = try modelWith((WS_A, "/dev/a"))
        try model.selectContext(.workspace(WS_A), presentation: .beside)
        XCTAssertEqual(model.snapshot().selection.presentation, .full)
        try model.selectContext(model.scratchContext, presentation: .beside)
        XCTAssertEqual(model.snapshot().selection.presentation, .full)
    }

    func testSplitsAWorkspaceBesideTheAgentItIsPairedWith() throws {
        var model = try modelWith((WS_A, "/dev/a"))
        try model.add(WS_A, AG_A)
        try model.add(WS_A, AG_B)
        let beside = NavigationSelection(context: .workspace(WS_A), presentation: .beside)
        XCTAssertEqual(model.resolveLayout(beside), .split(editor: .workspaceEditor(WS_A), agent: .agent(AG_A)))
        try model.selectContext(.agent(AG_B))
        XCTAssertEqual(model.resolveLayout(beside), .split(editor: .workspaceEditor(WS_A), agent: .agent(AG_B)))
    }

    func testSwapsTheHalfOfASplitTheKeyboardIsInAndOnlyInsideOne() throws {
        var model = try modelWith((WS_A, "/dev/a"))
        try model.add(WS_A, AG_A)
        try model.selectContext(.agent(AG_A), presentation: .beside)
        try model.swapSplitFocus()
        XCTAssertEqual(model.snapshot().selection, NavigationSelection(context: .workspace(WS_A), presentation: .beside))
        try model.swapSplitFocus()
        XCTAssertEqual(model.snapshot().selection, NavigationSelection(context: .agent(AG_A), presentation: .beside))
        try model.selectContext(.agent(AG_A))
        try model.swapSplitFocus()
        XCTAssertEqual(model.snapshot().selection, NavigationSelection(context: .agent(AG_A), presentation: .full))
    }

    func testJumpsToScratchAndComesBackToTheWholeSelectionItLeft() throws {
        var model = try modelWith((WS_A, "/dev/a"))
        try model.add(WS_A, AG_A)
        try model.selectContext(.workspace(WS_A))
        try model.toggleScratch()
        XCTAssertEqual(model.snapshot().selection, NavigationSelection(context: model.scratchContext, presentation: .full))
        try model.toggleScratch()
        XCTAssertEqual(model.snapshot().selection, NavigationSelection(context: .workspace(WS_A), presentation: .full))
    }

    func testComesBackToAnAgentAndToOneThatWasSideBySideAsItWas() throws {
        var model = try modelWith((WS_A, "/dev/a"))
        try model.add(WS_A, AG_A)
        try model.selectContext(.agent(AG_A))
        try model.toggleScratch()
        try model.toggleScratch()
        XCTAssertEqual(model.snapshot().selection, NavigationSelection(context: .agent(AG_A), presentation: .full))
        try model.selectContext(.agent(AG_A), presentation: .beside)
        try model.toggleScratch()
        try model.toggleScratch()
        XCTAssertEqual(model.snapshot().selection, NavigationSelection(context: .agent(AG_A), presentation: .beside))
    }

    func testStaysOnScratchWhenTheWayBackHasBeenClosedOrWasNeverThere() throws {
        var model = try modelWith((WS_A, "/dev/a"))
        try model.selectContext(.workspace(WS_A))
        try model.toggleScratch()
        try model.closeWorkspace(WS_A, inspection: .clean, drawn: drawn(model))
        try model.toggleScratch()
        XCTAssertEqual(model.snapshot().selection.context, model.scratchContext)
        var fresh = scratchModel()
        try fresh.toggleScratch()
        XCTAssertEqual(fresh.snapshot().selection, NavigationSelection(context: fresh.scratchContext, presentation: .full))
    }

    func testRemembersWhereTheJumpOutStartedNotTheLastThingSelected() throws {
        var model = try modelWith((WS_A, "/dev/a"), (WS_B, "/dev/b"))
        try model.selectContext(.workspace(WS_A))
        try model.toggleScratch()
        try model.selectContext(.workspace(WS_B))
        try model.selectContext(model.scratchContext)
        try model.toggleScratch()
        XCTAssertEqual(model.snapshot().selection.context, .workspace(WS_A))
    }

    func testReselectingTheSameAgentADifferentWayMovesTheLayout() throws {
        var model = try modelWith((WS_A, "/dev/a"))
        try model.add(WS_A, AG_A)
        try model.selectContext(.agent(AG_A), presentation: .full)
        let before = model.snapshot().revision
        try model.selectContext(.agent(AG_A), presentation: .beside)
        XCTAssertGreaterThan(model.snapshot().revision, before)
        XCTAssertTrue(model.snapshot().layout.isSplit)
    }

    func testShowsNothingForAnAgentWhoseWorkspaceWentAway() throws {
        var model = try modelWith((WS_A, "/dev/a"))
        try model.add(WS_A, AG_A)
        try model.markWorkspaceUnavailable(WS_A, .rootMissing)
        XCTAssertEqual(model.full(.agent(AG_A)), .unavailable)
    }

    // MARK: the split

    func testSplitStartsWhereAPersonWouldPutItAndRemembersWhereTheyMovedIt() throws {
        var model = scratchModel()
        XCTAssertEqual(model.snapshot().splitRatio, AppModel.splitDefaultRatio)
        XCTAssertTrue(try model.setSplitRatio(0.7))
        XCTAssertEqual(model.snapshot().splitRatio, 0.7)
        XCTAssertFalse(try model.setSplitRatio(0.7))
    }

    func testRefusesARatioThatWouldLeaveAPaneWithNothingInIt() {
        var model = scratchModel()
        XCTAssertEqual(codeOf { try model.setSplitRatio(0.1) }, .invalidSplitRatio)
        XCTAssertEqual(codeOf { try model.setSplitRatio(0.99) }, .invalidSplitRatio)
    }

    // MARK: selection

    func testIsTheContextAndHowItIsShownAndANewAgentTakesIt() throws {
        var model = try modelWith((WS_A, "/dev/a"))
        try model.selectContext(.workspace(WS_A))
        XCTAssertEqual(model.selection, NavigationSelection(context: .workspace(WS_A), presentation: .full))
        try model.add(WS_A, AG_A)
        XCTAssertEqual(model.selection, NavigationSelection(context: .agent(AG_A), presentation: .full))
        try model.selectContext(model.scratchContext)
        XCTAssertEqual(model.selection, NavigationSelection(context: model.scratchContext, presentation: .full))
    }

    func testFallsToTheNextAgentThenTheWorkspaceWhenOneExits() throws {
        var model = try modelWith((WS_A, "/dev/a"))
        try model.add(WS_A, AG_A)
        try model.add(WS_A, AG_B)
        try model.selectContext(.agent(AG_A))
        try model.agentExited(AG_A)
        XCTAssertEqual(model.selection, NavigationSelection(context: .agent(AG_B), presentation: .full))
        try model.agentExited(AG_B)
        XCTAssertEqual(model.selection, NavigationSelection(context: .workspace(WS_A), presentation: .full))
    }

    func testRefusesADrawnOrderThatDoesNotNameTheOpenWorkspaces() throws {
        var model = try modelWith((WS_A, "/dev/a"), (WS_B, "/dev/b"))
        XCTAssertThrowsError(try model.closeWorkspace(WS_B, inspection: .clean, drawn: drawn(model) + [WS_A])) { error in
            XCTAssertTrue(String(describing: error).contains("does not name the open workspaces"))
        }
        XCTAssertNotNil(model.workspace(WS_B))
    }

    // MARK: ordinals

    func testNumbersAgentsPerWorkspaceAndProfile() throws {
        var model = try modelWith((WS_A, "/dev/a"), (WS_B, "/dev/b"))
        try model.add(WS_A, AG_A)
        try model.add(WS_B, AG_B)
        XCTAssertEqual(model.agent(AG_A)?.displayName, "Codex 1")
        XCTAssertEqual(model.agent(AG_B)?.displayName, "Codex 1")
    }

    func testShowsTheNumberOnlyOnceThereAreTwoOfAProfileToTellApart() throws {
        var model = try modelWith((WS_A, "/dev/a"))
        try model.add(WS_A, AG_A)
        func names() -> [String] { model.snapshot().workspaces[1].agents.map(\.displayName) }
        XCTAssertEqual(names(), ["Codex"])
        try model.add(WS_A, AG_B)
        XCTAssertEqual(names(), ["Codex 1", "Codex 2"])
        try model.renameAgent(AG_B, "Investigator")
        XCTAssertEqual(names(), ["Codex", "Investigator"])
    }

    // MARK: labels

    func testUsesTheBasenameUntilTwoWorkspacesCollide() throws {
        let model = try modelWith((WS_A, "/dev/alpha/app"), (WS_B, "/dev/beta/app"))
        XCTAssertEqual(model.snapshot().workspaces.map(\.label), ["Scratch", "app — alpha", "app — beta"])
    }

    func testLeavesAUniqueBasenameAlone() throws {
        let model = try modelWith((WS_A, "/dev/alpha"), (WS_B, "/dev/beta"))
        XCTAssertEqual(model.snapshot().workspaces.map(\.label), ["Scratch", "alpha", "beta"])
    }

    func testDoesNotCountScratchsFolderNameAsACollision() throws {
        let model = try modelWith((WS_A, "/elsewhere/20260923"))
        XCTAssertEqual(model.snapshot().workspaces.map(\.label), ["Scratch", "20260923"])
    }

    func testLabelsTwoHostsIdenticalPathsByTheirPlace() throws {
        var model = scratchModel()
        try model.addWorkspace(Workspace(id: WS_A, location: .ssh(host: "a", path: "/srv/api"), selectedPath: "/srv/api"))
        try model.addWorkspace(Workspace(id: WS_B, location: .ssh(host: "b", path: "/srv/api"), selectedPath: "/srv/api"))
        XCTAssertEqual(model.snapshot().workspaces.map(\.label), ["Scratch", "api — a:/srv/api", "api — b:/srv/api"])
    }

    // MARK: Scratch, today's daily folder

    private let tomorrow = "/scratch-test/junk/20260924"

    func testMovesToTheNewDaysFolderAndLeavesYesterdaysAsAnOrdinaryRow() throws {
        var model = scratchModel()
        let yesterday = model.scratchWorkspaceId
        try model.add(yesterday, AG_A)
        let day = localWorkspace(tomorrow)
        XCTAssertTrue(try model.adoptScratchDay(day))
        let snapshot = model.snapshot()
        XCTAssertEqual(snapshot.scratchWorkspaceId, day.id)
        let old = snapshot.workspace(yesterday)
        XCTAssertEqual(old?.label, "20260923")
        XCTAssertEqual(old?.agents.map(\.id), [AG_A])
        XCTAssertEqual(snapshot.selection.context, .agent(AG_A))
        XCTAssertEqual(snapshot.workspace(day.id)?.label, "Scratch")
    }

    func testAdoptsAnAlreadyOpenWorkspaceForTheDaysFolderInsteadOfASecondOne() throws {
        var model = try modelWith((WS_A, tomorrow))
        XCTAssertTrue(try model.adoptScratchDay(localWorkspace(tomorrow)))
        XCTAssertEqual(model.scratchWorkspaceId, WS_A)
        XCTAssertEqual(model.workspaces.count, 2)
    }

    func testAdoptIsANoOpWhenTheDayHasNotChanged() throws {
        var model = scratchModel()
        let before = model.snapshot().revision
        XCTAssertFalse(try model.adoptScratchDay(localWorkspace(scratchPath)))
        XCTAssertEqual(model.snapshot().revision, before)
        XCTAssertEqual(model.workspaces.count, 1)
    }

    func testRefusesToCloseTodaysScratchAndClosesYesterdaysLikeAnyRow() throws {
        var model = scratchModel()
        let yesterday = model.scratchWorkspaceId
        XCTAssertEqual(codeOf { try model.closeWorkspace(yesterday, inspection: .clean, drawn: drawn(model)) }, .scratchCannotClose)
        try model.adoptScratchDay(localWorkspace(tomorrow))
        try model.closeWorkspace(yesterday, inspection: .clean, drawn: drawn(model))
        XCTAssertNil(model.workspace(yesterday))
    }

    func testLetsAgentsBeCreatedInScratch() throws {
        var model = scratchModel()
        try model.add(model.scratchWorkspaceId, AG_A)
        XCTAssertEqual(model.snapshot().workspaces[0].agents.map(\.id), [AG_A])
    }

    // MARK: revisions, sidebar, closing

    func testBumpsOnlyWhenSomethingActuallyChanged() throws {
        var model = try modelWith((WS_A, "/dev/a"))
        let before = model.snapshot().revision
        try model.selectContext(.workspace(WS_A))
        let after = model.snapshot().revision
        XCTAssertGreaterThan(after, before)
        try model.selectContext(.workspace(WS_A))
        XCTAssertEqual(model.snapshot().revision, after)
    }

    func testClampsTheWidthToTheSupportedRange() throws {
        var model = scratchModel()
        XCTAssertEqual(codeOf { try model.setSidebarWidth(100) }, .invalidSidebarWidth)
        XCTAssertTrue(try model.setSidebarWidth(300))
        XCTAssertEqual(model.snapshot().sidebar.width, 300)
    }

    func testKeepsAWorkspacesAgentsInTheProjectionAlways() throws {
        var model = try modelWith((WS_A, "/dev/a"))
        try model.add(WS_A, AG_A)
        XCTAssertEqual(model.snapshot().workspaces[1].agents.map(\.id), [AG_A])
        try model.agentExited(AG_A)
        XCTAssertEqual(model.snapshot().workspaces[1].agents, [])
    }

    func testRefusesAWorkspaceThatStillHasAgents() throws {
        var model = try modelWith((WS_A, "/dev/a"))
        try model.add(WS_A, AG_A)
        XCTAssertEqual(codeOf { try model.closeWorkspace(WS_A, inspection: .clean, drawn: drawn(model)) }, .workspaceHasLiveAgents)
    }

    func testMovesTheSelectionToTheNextWorkspaceThenToScratch() throws {
        var model = try modelWith((WS_A, "/dev/a"), (WS_B, "/dev/b"))
        try model.selectContext(.workspace(WS_A))
        try model.closeWorkspace(WS_A, inspection: .clean, drawn: drawn(model))
        XCTAssertEqual(model.selection.context, .workspace(WS_B))
        try model.closeWorkspace(WS_B, inspection: .clean, drawn: drawn(model))
        XCTAssertEqual(model.selection, NavigationSelection(context: model.scratchContext, presentation: .full))
    }

    func testPutsARolledBackCloseBackWhereItWas() throws {
        var model = try modelWith((WS_A, "/dev/a"), (WS_B, "/dev/b"))
        try model.selectContext(.workspace(WS_A))
        let rollback = try model.closeWorkspaceForPersistence(WS_A, inspection: .clean, drawn: drawn(model))
        XCTAssertEqual(model.workspaces.count, 2)
        try model.rollbackWorkspaceClose(rollback)
        XCTAssertEqual(model.workspaces.map(\.id), [model.scratchWorkspaceId, WS_A, WS_B])
        XCTAssertEqual(model.selection.context, .workspace(WS_A))
    }

    func testOnlyRelocatesAnUnavailableWorkspaceAndKeepsItsIdentity() throws {
        var model = try modelWith((WS_A, "/dev/a"))
        XCTAssertEqual(codeOf { try model.relocateWorkspace(WS_A, location: .local(path: "/dev/moved"), selectedPath: "/dev/moved") }, .workspaceNotUnavailable)
        try model.markWorkspaceUnavailable(WS_A, .rootMissing)
        try model.relocateWorkspace(WS_A, location: .local(path: "/dev/moved"), selectedPath: "/dev/moved")
        XCTAssertEqual(model.workspace(WS_A)?.root, "/dev/moved")
        XCTAssertEqual(model.workspace(WS_A)?.state, .available)
    }

    func testRefusesASecondWorkspaceOnTheSameCanonicalRoot() throws {
        var model = try modelWith((WS_A, "/dev/a"))
        XCTAssertEqual(codeOf { try model.addWorkspace(Workspace(id: WS_B, location: .local(path: "/dev/a"), selectedPath: "/dev/a")) }, .duplicateWorkspaceRoot)
    }

    // MARK: wantsAttention

    func testWantsAttentionIsExactlyItWasMovingAndNowItIsYourTurn() {
        let moving: [AgentStatus] = [.working, .background]
        let yourTurn: [AgentStatus] = [.idle, .waiting, .error]
        for previous in AgentStatus.allCases {
            for next in AgentStatus.allCases {
                XCTAssertEqual(AppModel.wantsAttention(previous: previous, next: next), moving.contains(previous) && yourTurn.contains(next))
            }
        }
    }

    func testWantsAttentionIsTheFinishHoweverTheAgentWasMoving() {
        XCTAssertTrue(AppModel.wantsAttention(previous: .working, next: .idle))
        XCTAssertTrue(AppModel.wantsAttention(previous: .background, next: .idle))
        XCTAssertTrue(AppModel.wantsAttention(previous: .working, next: .waiting))
        XCTAssertTrue(AppModel.wantsAttention(previous: .background, next: .waiting))
        XCTAssertFalse(AppModel.wantsAttention(previous: .working, next: .background))
        XCTAssertFalse(AppModel.wantsAttention(previous: .background, next: .working))
        XCTAssertFalse(AppModel.wantsAttention(previous: .working, next: .unknown))
    }

    func testWantsAttentionSaysNothingAboutAScreenNobodyHadRead() {
        for next in AgentStatus.allCases { XCTAssertFalse(AppModel.wantsAttention(previous: .unknown, next: next)) }
        for status in AgentStatus.allCases { XCTAssertFalse(AppModel.wantsAttention(previous: status, next: status)) }
    }

    // MARK: unread agents

    private func withAgent() throws -> AppModel {
        var model = try modelWith((WS_A, "/dev/a"))
        try model.add(WS_A, AG_A)
        try model.selectContext(.workspace(WS_A))
        return model
    }

    private func ranAndThen(_ model: inout AppModel, _ status: AgentStatus) throws {
        try model.setAgentStatus(AG_A, .working)
        try model.setAgentStatus(AG_A, status)
    }

    func testBecomesUnreadWheneverItStopsWorkingForYouToAct() throws {
        for status in [AgentStatus.idle, .waiting, .error] {
            var model = try withAgent()
            try ranAndThen(&model, status)
            XCTAssertEqual(model.agent(AG_A)?.unread, status)
        }
    }

    func testStaysReadWhileItsBackgroundTasksWork() throws {
        var model = try withAgent()
        try ranAndThen(&model, .background)
        XCTAssertNil(model.agent(AG_A)?.unread)
        try model.setAgentStatus(AG_A, .idle)
        XCTAssertEqual(model.agent(AG_A)?.unread, .idle)
    }

    func testStaysReadWhenItsScreenStopsBeingReadable() throws {
        var model = try withAgent()
        try ranAndThen(&model, .unknown)
        XCTAssertNil(model.agent(AG_A)?.unread)
    }

    func testStaysReadWhenItStopsWorkingInFrontOfYou() throws {
        var model = try withAgent()
        try model.selectContext(.agent(AG_A))
        try ranAndThen(&model, .idle)
        XCTAssertNil(model.agent(AG_A)?.unread)
    }

    func testCountsTheSideBySidePaneAsLookingAtIt() throws {
        var model = try withAgent()
        try model.selectContext(.agent(AG_A), presentation: .beside)
        try ranAndThen(&model, .waiting)
        XCTAssertNil(model.agent(AG_A)?.unread)
    }

    func testReadsAnAgentMountedInTheSidePane() throws {
        var model = try withAgent()
        try ranAndThen(&model, .idle)
        try model.selectContext(.agent(AG_A), presentation: .beside)
        XCTAssertNil(model.agent(AG_A)?.unread)
    }

    func testDoesNotRaiseAMarkForAnythingThatDidNotStopWorking() throws {
        var model = try withAgent()
        try model.setAgentStatus(AG_A, .waiting)
        XCTAssertNil(model.agent(AG_A)?.unread)
        try model.setAgentStatus(AG_A, .idle)
        try model.setAgentStatus(AG_A, .waiting)
        XCTAssertNil(model.agent(AG_A)?.unread)
    }

    func testKeepsTheMarkWhileTheAgentMovesOnAndClearsItOnlyByOpeningIt() throws {
        var model = try withAgent()
        try ranAndThen(&model, .waiting)
        try model.setAgentStatus(AG_A, .idle)
        XCTAssertEqual(model.agent(AG_A)?.unread, .waiting)
        try model.selectContext(.agent(AG_A))
        XCTAssertNil(model.agent(AG_A)?.unread)
    }

    func testCanBePutBackByHandAndRereadByClickingTheSameRow() throws {
        var model = try withAgent()
        try model.selectContext(.agent(AG_A))
        try model.setAgentStatus(AG_A, .working)
        try model.markAgentUnread(AG_A)
        XCTAssertEqual(model.agent(AG_A)?.unread, .working)
        let before = model.snapshot().revision
        try model.selectContext(.agent(AG_A))
        XCTAssertNil(model.agent(AG_A)?.unread)
        XCTAssertGreaterThan(model.snapshot().revision, before)
    }

    // MARK: the window that is not in front

    private func selectedAgent() throws -> AppModel {
        var model = try modelWith((WS_A, "/dev/a"))
        try model.add(WS_A, AG_A)
        try model.selectContext(.agent(AG_A))
        return model
    }

    func testIsNobodyLookingAtAnythingWhileDevHubIsBehindAnotherWindow() throws {
        var model = try selectedAgent()
        model.setWindowFocused(false)
        XCTAssertFalse(model.isAgentVisible(AG_A))
        try model.setAgentStatus(AG_A, .working)
        try model.setAgentStatus(AG_A, .idle)
        XCTAssertEqual(model.agent(AG_A)?.unread, .idle)
    }

    func testReadsWhatIsOnScreenWhenTheWindowComesBack() throws {
        var model = try selectedAgent()
        model.setWindowFocused(false)
        try model.setAgentStatus(AG_A, .working)
        try model.setAgentStatus(AG_A, .idle)
        let before = model.snapshot().revision
        model.setWindowFocused(true)
        XCTAssertNil(model.agent(AG_A)?.unread)
        XCTAssertGreaterThan(model.snapshot().revision, before)
    }

    func testReadsNothingWhenTheWindowComesBackToSomethingThatIsNotAnAgent() throws {
        var model = try selectedAgent()
        model.setWindowFocused(false)
        try model.setAgentStatus(AG_A, .working)
        try model.setAgentStatus(AG_A, .error)
        try model.selectContext(.workspace(WS_A))
        model.setWindowFocused(true)
        XCTAssertEqual(model.agent(AG_A)?.unread, .error)
    }

    func testDoesNotReadAnAgentSelectedWhileTheWindowIsAway() throws {
        var model = try selectedAgent()
        try model.selectContext(.workspace(WS_A))
        model.setWindowFocused(false)
        try model.setAgentStatus(AG_A, .working)
        try model.setAgentStatus(AG_A, .idle)
        try model.selectContext(.agent(AG_A))
        XCTAssertEqual(model.agent(AG_A)?.unread, .idle)
        model.setWindowFocused(true)
        XCTAssertNil(model.agent(AG_A)?.unread)
    }

    // MARK: a refusal about one Agent

    private func failureOf(_ model: AppModel) -> AgentFailure? {
        model.snapshot().workspaces.flatMap(\.agents).first { $0.id == AG_A }?.failure
    }

    func testARefusalIsCarriedByTheAgentItIsAbout() throws {
        var model = try modelWith((WS_A, "/dev/a"))
        try model.add(WS_A, AG_A)
        try model.markAgentFailed(AG_A, AgentFailure(code: .tmuxSessionConflict, detail: "A session of that name is already there."))
        XCTAssertEqual(failureOf(model), AgentFailure(code: .tmuxSessionConflict, detail: "A session of that name is already there."))
    }

    func testARefusalGoesWhenTheNextReconcileReadsTheAgent() throws {
        var model = try modelWith((WS_A, "/dev/a"))
        try model.add(WS_A, AG_A)
        try model.markAgentFailed(AG_A, AgentFailure(code: .agentRuntimeUnavailable))
        XCTAssertNotNil(failureOf(model))
        try model.setAgentStatus(AG_A, .working)
        XCTAssertNil(failureOf(model))
    }

    func testARefusalStaysUntilThenHoweverManyTimesItIsRaisedAgain() throws {
        var model = try modelWith((WS_A, "/dev/a"))
        try model.add(WS_A, AG_A)
        try model.markAgentFailed(AG_A, AgentFailure(code: .agentRuntimeUnavailable))
        let before = model.snapshot().revision
        try model.markAgentFailed(AG_A, AgentFailure(code: .agentRuntimeUnavailable))
        XCTAssertEqual(model.snapshot().revision, before)
        XCTAssertEqual(failureOf(model), AgentFailure(code: .agentRuntimeUnavailable))
    }

    func testARefusalIsReplacedByADifferentRefusalAboutTheSameAgent() throws {
        var model = try modelWith((WS_A, "/dev/a"))
        try model.add(WS_A, AG_A)
        try model.markAgentFailed(AG_A, AgentFailure(code: .agentRuntimeUnavailable))
        try model.markAgentFailed(AG_A, AgentFailure(code: .tmuxCommandTimedOut))
        XCTAssertEqual(failureOf(model), AgentFailure(code: .tmuxCommandTimedOut))
    }

    // MARK: a failure a reading carries

    private let lost = AgentFailure(code: .conversationHostLost, detail: "the journal stopped")

    private func reading(_ failure: AgentFailure?) -> AgentReconciliation {
        AgentReconciliation(observations: [
            AgentObservation(agentId: AG_A, status: .unknown, runtimeHealth: .healthy, failure: failure),
        ])
    }

    func testAReadFailureIsShownWhileTheRoundsKeepReadingItWithoutBeingRepublished() throws {
        var model = try modelWith((WS_A, "/dev/a"))
        try model.add(WS_A, AG_A, codex, .gui)
        try model.reconcileAgents(reading(lost))
        XCTAssertEqual(failureOf(model), lost)
        let before = model.snapshot().revision
        try model.reconcileAgents(reading(lost))
        XCTAssertEqual(model.snapshot().revision, before)
        XCTAssertEqual(failureOf(model), lost)
    }

    func testAReadFailureGoesWithTheFirstReadingThatDoesNotCarryIt() throws {
        var model = try modelWith((WS_A, "/dev/a"))
        try model.add(WS_A, AG_A, codex, .gui)
        try model.reconcileAgents(reading(lost))
        try model.reconcileAgents(reading(nil))
        XCTAssertNil(failureOf(model))
    }

    // MARK: arranging the rows

    private func withTwoAgents() throws -> AppModel {
        var model = scratchModel()
        try model.addWorkspace(Workspace(id: WS_A, location: .local(path: "/srv/api"), selectedPath: "/srv/api"))
        try model.add(WS_A, AG_A)
        try model.add(WS_A, AG_B)
        return model
    }

    func testTakesAnyOrderForTheRows() {
        var model = scratchModel()
        XCTAssertEqual(model.workspaceOrder, [])
        XCTAssertTrue(model.setWorkspaceOrder([WS_B, WS_A]))
        XCTAssertEqual(model.workspaceOrder, [WS_B, WS_A])
    }

    func testPublishesNothingWhenTheOrderIsTheOneItAlreadyHad() {
        var model = scratchModel()
        model.setWorkspaceOrder([WS_B, WS_A])
        let before = model.snapshot().revision
        XCTAssertFalse(model.setWorkspaceOrder([WS_B, WS_A]))
        XCTAssertEqual(model.snapshot().revision, before)
    }

    func testMovesAnAgentWithinItsWorkspace() throws {
        var model = try withTwoAgents()
        XCTAssertTrue(try model.setAgentOrder(WS_A, [AG_B, AG_A]))
        XCTAssertEqual(model.snapshot().workspaces[1].agents.map(\.id), [AG_B, AG_A])
        XCTAssertFalse(try model.setAgentOrder(WS_A, [AG_B, AG_A]))
    }

    func testRefusesAnAgentOrderThatIsNotTheAgentsItHas() throws {
        var model = try withTwoAgents()
        XCTAssertEqual(codeOf { try model.setAgentOrder(WS_A, [AG_B]) }, .unknownAgent)
        XCTAssertEqual(codeOf { try model.setAgentOrder(WS_A, [AG_A, AG_A]) }, .unknownAgent)
        XCTAssertEqual(codeOf { try model.setAgentOrder(WS_B, [AG_A, AG_B]) }, .unknownWorkspace)
        XCTAssertEqual(model.snapshot().workspaces[1].agents.map(\.id), [AG_A, AG_B])
    }

    // MARK: Back and Forward

    func testHasNowhereToGoOnAFreshModel() throws {
        let model = try modelWith((WS_A, "/dev/a"))
        XCTAssertEqual(model.snapshot().history, HistoryAvailability(canGoBack: false, canGoForward: false))
    }

    func testWalksBackAndForwardOverSelectionsWithoutRecordingItsOwnMoves() throws {
        var model = try modelWith((WS_A, "/dev/a"), (WS_B, "/dev/b"))
        try model.selectContext(.workspace(WS_A))
        try model.selectContext(.workspace(WS_B))
        XCTAssertTrue(try model.navigateHistory(.back))
        XCTAssertEqual(model.selection.context, .workspace(WS_A))
        XCTAssertTrue(try model.navigateHistory(.back))
        XCTAssertEqual(model.selection.context, model.scratchContext)
        XCTAssertEqual(model.snapshot().history, HistoryAvailability(canGoBack: false, canGoForward: true))
        XCTAssertTrue(try model.navigateHistory(.forward))
        XCTAssertTrue(try model.navigateHistory(.forward))
        XCTAssertEqual(model.selection.context, .workspace(WS_B))
        XCTAssertFalse(try model.navigateHistory(.forward))
    }

    func testCutsOffForwardWhenSomewhereNewIsSelectedAfterGoingBack() throws {
        var model = try modelWith((WS_A, "/dev/a"), (WS_B, "/dev/b"))
        try model.selectContext(.workspace(WS_A))
        try model.selectContext(.workspace(WS_B))
        try model.navigateHistory(.back)
        try model.navigateHistory(.back)
        try model.selectContext(.workspace(WS_B))
        XCTAssertFalse(model.snapshot().history.canGoForward)
        try model.navigateHistory(.back)
        XCTAssertEqual(model.selection.context, model.scratchContext)
    }

    func testSkipsAWorkspaceThatHasBeenClosed() throws {
        var model = try modelWith((WS_A, "/dev/a"), (WS_B, "/dev/b"))
        try model.selectContext(.workspace(WS_A))
        try model.selectContext(.workspace(WS_B))
        try model.closeWorkspace(WS_A, inspection: .clean, drawn: drawn(model))
        try model.navigateHistory(.back)
        XCTAssertEqual(model.selection.context, model.scratchContext)
    }

    func testRecordsANewAgentAndSkipsItOnceItHasExited() throws {
        var model = try modelWith((WS_A, "/dev/a"))
        try model.selectContext(.workspace(WS_A))
        try model.add(WS_A, AG_A)
        try model.selectContext(model.scratchContext)
        try model.navigateHistory(.back)
        XCTAssertEqual(model.selection.context, .agent(AG_A))
        try model.navigateHistory(.forward)
        try model.agentExited(AG_A)
        try model.navigateHistory(.back)
        XCTAssertEqual(model.selection.context, .workspace(WS_A))
    }

    func testTreatsTheTwoHalvesOfOneSplitAsOnePlace() throws {
        var model = try modelWith((WS_A, "/dev/a"))
        try model.add(WS_A, AG_A)
        try model.selectContext(model.scratchContext)
        try model.selectContext(.agent(AG_A), presentation: .beside)
        try model.swapSplitFocus()
        try model.navigateHistory(.back)
        XCTAssertEqual(model.selection.context, model.scratchContext)
        try model.navigateHistory(.forward)
        XCTAssertEqual(model.selection, NavigationSelection(context: .workspace(WS_A), presentation: .beside))
    }

    func testStartsAgainFromAReset() throws {
        var model = try modelWith((WS_A, "/dev/a"))
        try model.selectContext(.workspace(WS_A))
        model.resetHistory()
        XCTAssertEqual(model.snapshot().history, HistoryAvailability(canGoBack: false, canGoForward: false))
    }
}

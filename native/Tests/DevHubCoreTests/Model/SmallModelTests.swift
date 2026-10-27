// Ports of apps/desktop/src/model/terminalMode.test.ts, noticeCenter.test.ts,
// noticeEpisodes.test.ts, terminalZoom.test.ts, navigationHistory.test.ts,
// commandPalette.test.ts and terminalActivity.test.ts.

import XCTest
@testable import DevHubCore

final class TerminalModeTests: XCTestCase {
    func testServesAFolderOnThisMac() {
        XCTAssertTrue(TerminalMode.supports(location: .local(path: "/a"), editor: .host))
    }

    func testServesAFolderWhoseEditorWasInADevContainerAsTheLocalFolder() {
        XCTAssertTrue(TerminalMode.supports(location: .local(path: "/a"), editor: .devContainer(configPath: ".devcontainer/devcontainer.json")))
    }

    func testDoesNotServeSshWorkspaces() {
        let ssh = WorkspaceLocation.ssh(host: "box", path: "/a")
        XCTAssertFalse(TerminalMode.supports(location: ssh, editor: .host))
        XCTAssertEqual(TerminalMode.unsupported(location: ssh), "SSH Workspaces are not available in terminal mode. Use VS Code mode to open them.")
    }
}

private struct SaidNotice: IdentifiedNotice {
    let identity: String
    let words: String
    init(_ identity: String, _ words: String? = nil) {
        self.identity = identity
        self.words = words ?? identity
    }
}

final class NoticeCenterTests: XCTestCase {
    func testKeepsWhatReachedTheScreenNewestFirstUnreadAndCurrent() {
        var center: [CenterEntry<SaidNotice>] = []
        center = NoticeCenter.shown(center, SaidNotice("a"), at: 1, key: 0)
        center = NoticeCenter.shown(center, SaidNotice("b"), at: 2, key: 1)
        XCTAssertEqual(center.map(\.notice.identity), ["b", "a"])
        XCTAssertTrue(center.allSatisfy { !$0.read && $0.current })
        XCTAssertEqual(NoticeCenter.unreadCount(center), 2)
    }

    func testIsOneEntryForANoticeWhoseWordsMovedWhileItStood() {
        var center = NoticeCenter.shown([], SaidNotice("a", "one"), at: 1, key: 0)
        center = NoticeCenter.shown(center, SaidNotice("a", "two"), at: 5, key: 1)
        XCTAssertEqual(center.count, 1)
        XCTAssertEqual(center[0].key, 0)
        XCTAssertEqual(center[0].at, 1)
        XCTAssertEqual(center[0].notice.words, "two")
    }

    func testIsANewEntryOnceTheLastOneOfThatNoticeIsOver() {
        var center = NoticeCenter.shown([], SaidNotice("a"), at: 1, key: 0)
        center = NoticeCenter.ended(center) { $0.identity == "a" }
        XCTAssertEqual(center[0].current, false)
        center = NoticeCenter.shown(center, SaidNotice("a"), at: 2, key: 1)
        XCTAssertEqual(center.map(\.key), [1, 0])
    }

    func testKeepsTheLastHundred() {
        var center: [CenterEntry<SaidNotice>] = []
        for i in 0..<(NoticeCenter.limit + 5) {
            center = NoticeCenter.shown(center, SaidNotice(String(i)), at: Double(i), key: i)
        }
        XCTAssertEqual(center.count, NoticeCenter.limit)
        XCTAssertEqual(center.first?.notice.identity, "104")
        XCTAssertEqual(center.last?.notice.identity, "5")
    }

    func testReadsOneNoticeOrEverything() {
        var center = NoticeCenter.shown([], SaidNotice("a"), at: 1, key: 0)
        center = NoticeCenter.shown(center, SaidNotice("b"), at: 2, key: 1)
        center = NoticeCenter.read(center, identity: "a")
        XCTAssertEqual(NoticeCenter.unreadCount(center), 1)
        center = NoticeCenter.read(center)
        XCTAssertEqual(NoticeCenter.unreadCount(center), 0)
        XCTAssertEqual(NoticeCenter.read(center), center)
    }

    func testRemovesOneEntryByItsKey() {
        var center = NoticeCenter.shown([], SaidNotice("a"), at: 1, key: 0)
        center = NoticeCenter.shown(center, SaidNotice("b"), at: 2, key: 1)
        XCTAssertEqual(NoticeCenter.removed(center, key: 0).map(\.key), [1])
    }
}

final class NoticeEpisodesTests: XCTestCase {
    private final class Clock: @unchecked Sendable { var now: Double = 0 }
    private let runtime = "app agent_runtime_unavailable"

    private func episodes(quietMs: Double = 5_000) -> (NoticeEpisodes, Clock) {
        let clock = Clock()
        return (NoticeEpisodes(quietMs: quietMs, now: { clock.now }), clock)
    }

    func testBeginsOnceHoweverFastThePublisherRuns() {
        var (gate, clock) = episodes()
        var reached: [Bool] = []
        for _ in 0..<60 {
            reached.append(gate.begins(runtime))
            clock.now += 50
        }
        XCTAssertEqual(reached.filter { $0 }.count, 1)
        XCTAssertTrue(reached[0])
    }

    func testHoldsForAsLongAsThePublisherKeepsFailing() {
        var (gate, clock) = episodes()
        _ = gate.begins(runtime)
        for _ in 0..<200 {
            clock.now += 300
            XCTAssertFalse(gate.begins(runtime))
        }
    }

    func testIsNewsAgainOnceThePublisherHasBeenQuiet() {
        var (gate, clock) = episodes()
        XCTAssertTrue(gate.begins(runtime))
        clock.now += 5_000
        XCTAssertTrue(gate.begins(runtime))
    }

    func testKeepsTwoCodesTakingTurnsDownToOneRaiseEach() {
        var (gate, clock) = episodes()
        let other = "app native_unavailable"
        var reached: [Bool] = []
        for publish in 0..<40 {
            reached.append(gate.begins(publish % 2 == 0 ? runtime : other))
            clock.now += 50
        }
        XCTAssertEqual(reached.filter { $0 }.count, 2)
    }

    func testTellsThePersonAgainOnceTheyHaveTakenTheNoticeOffScreen() {
        var (gate, clock) = episodes()
        XCTAssertTrue(gate.begins(runtime))
        clock.now += 100
        XCTAssertFalse(gate.begins(runtime))
        gate.ended(runtime)
        XCTAssertTrue(gate.begins(runtime))
    }
}

final class TerminalZoomTests: XCTestCase {
    private let base: Double = 13

    private func after(_ base: Double, _ direction: TerminalZoom.Direction, _ times: Int) -> Int {
        var offset = 0
        for _ in 0..<times { offset = TerminalZoom.nextOffset(base: base, offset: offset, direction: direction) }
        return offset
    }

    func testStepsOnePixelAtATimeInBothDirections() {
        XCTAssertEqual(TerminalZoom.zoomedFontSize(base: base, offset: after(base, .zoomIn, 3)), 16)
        XCTAssertEqual(TerminalZoom.zoomedFontSize(base: base, offset: after(base, .zoomOut, 2)), 11)
    }

    func testStopsAtTheEndsOfTheRangeTheSettingHas() {
        XCTAssertEqual(TerminalZoom.zoomedFontSize(base: base, offset: after(base, .zoomIn, 100)), TerminalZoom.maxFontSize)
        XCTAssertEqual(TerminalZoom.zoomedFontSize(base: base, offset: after(base, .zoomOut, 100)), TerminalZoom.minFontSize)
    }

    func testComesStraightBackFromAnEndOnTheFirstStepTheOtherWay() {
        let ceiling = after(base, .zoomIn, 100)
        let back = TerminalZoom.nextOffset(base: base, offset: ceiling, direction: .zoomOut)
        XCTAssertEqual(TerminalZoom.zoomedFontSize(base: base, offset: back), TerminalZoom.maxFontSize - 1)
    }

    func testResetsToTheSizeTheSettingsNameWhateverTheBaseIs() {
        XCTAssertEqual(TerminalZoom.nextOffset(base: base, offset: after(base, .zoomIn, 4), direction: .reset), 0)
        XCTAssertEqual(TerminalZoom.zoomedFontSize(base: 20, offset: 0), 20)
    }

    func testIsMeasuredFromTheSettingNotFromASizeItCopied() {
        let offset = after(11, .zoomIn, 2)
        XCTAssertEqual(TerminalZoom.zoomedFontSize(base: 11, offset: offset), 13)
        XCTAssertEqual(TerminalZoom.zoomedFontSize(base: 18, offset: offset), 20)
    }

    func testKnowsAnOffsetThatCannotNameAnySize() {
        XCTAssertTrue(TerminalZoom.isOffset(0.0))
        XCTAssertTrue(TerminalZoom.isOffset(-15.0))
        XCTAssertFalse(TerminalZoom.isOffset(16.0))
        XCTAssertFalse(TerminalZoom.isOffset(1.5))
        XCTAssertFalse(TerminalZoom.isOffset(Double.nan))
    }

    func testNeverLeavesTheRangeTheProjectionIsValidatedAgainst() {
        for base in TerminalZoom.minFontSize...TerminalZoom.maxFontSize {
            for direction in [TerminalZoom.Direction.zoomIn, .zoomOut] {
                for times in 0...40 {
                    let size = TerminalZoom.zoomedFontSize(base: Double(base), offset: after(Double(base), direction, times))
                    XCTAssertGreaterThanOrEqual(size, TerminalZoom.minFontSize)
                    XCTAssertLessThanOrEqual(size, TerminalZoom.maxFontSize)
                }
            }
        }
    }
}

final class NavigationHistoryTests: XCTestCase {
    private let always: (String) -> Bool = { _ in true }

    private func history(_ visits: String...) -> NavigationHistory<String> {
        var made = NavigationHistory(visits[0], same: { $0 == $1 })
        for visit in visits.dropFirst() { _ = made.visit(visit) }
        return made
    }

    func testGoesBackAndForwardOverWhatWasVisited() {
        var h = history("a", "b", "c")
        XCTAssertEqual(h.go(.back, exists: always), "b")
        XCTAssertEqual(h.go(.back, exists: always), "a")
        XCTAssertNil(h.go(.back, exists: always))
        XCTAssertEqual(h.current, "a")
        XCTAssertEqual(h.go(.forward, exists: always), "b")
        XCTAssertEqual(h.go(.forward, exists: always), "c")
        XCTAssertFalse(h.can(.forward, exists: always))
    }

    func testStartsWithNowhereToGo() {
        let h = history("a")
        XCTAssertFalse(h.can(.back, exists: always))
        XCTAssertFalse(h.can(.forward, exists: always))
    }

    func testDoesNotRecordTheMoveBackItselfMakes() {
        var h = history("a", "b")
        let target = h.go(.back, exists: always)!
        XCTAssertFalse(h.visit(target))
        XCTAssertEqual(h.list, ["a", "b"])
        XCTAssertTrue(h.can(.forward, exists: always))
    }

    func testCutsOffWhatWasAheadWhenSomewhereNewIsVisited() {
        var h = history("a", "b", "c")
        _ = h.go(.back, exists: always)
        _ = h.go(.back, exists: always)
        _ = h.visit("d")
        XCTAssertEqual(h.list, ["a", "d"])
        XCTAssertFalse(h.can(.forward, exists: always))
    }

    func testKeepsTheSamePlaceTwiceInARowAsOneEntry() {
        XCTAssertEqual(history("a", "a", "b", "b").list, ["a", "b"])
    }

    func testReplacesTheCurrentEntryWhenAskedWithoutTouchingWhatIsAhead() {
        var h = history("a", "b", "c")
        _ = h.go(.back, exists: always)
        _ = h.visit("b2", replace: true)
        XCTAssertEqual(h.list, ["a", "b2", "c"])
        XCTAssertEqual(h.go(.back, exists: always), "a")
    }

    func testSkipsPlacesThatHaveGoneBothWays() {
        var h = history("a", "gone", "b")
        let exists: (String) -> Bool = { $0 != "gone" }
        XCTAssertEqual(h.go(.back, exists: exists), "a")
        XCTAssertEqual(h.go(.forward, exists: exists), "b")
    }

    func testIsDisabledWhenEverythingBehindHasGone() {
        var h = history("gone", "b")
        let exists: (String) -> Bool = { $0 != "gone" }
        XCTAssertFalse(h.can(.back, exists: exists))
        XCTAssertNil(h.go(.back, exists: exists))
        XCTAssertEqual(h.current, "b")
    }

    func testSkipsANeighbourThatIsThePlaceAlreadyOnScreen() {
        var h = history("x", "a", "b", "a")
        XCTAssertEqual(h.go(.back, exists: { $0 != "b" }), "x")
    }

    func testKeepsOnlyTheNewestEntriesPastTheLimit() {
        var h = NavigationHistory("0", limit: 3, same: { $0 == $1 })
        for visit in ["1", "2", "3", "4"] { _ = h.visit(visit) }
        XCTAssertEqual(h.list, ["2", "3", "4"])
        XCTAssertEqual(h.position, 2)
    }

    func testStartsAgainFromAReset() {
        var h = history("a", "b")
        h.reset("c")
        XCTAssertEqual(h.list, ["c"])
        XCTAssertFalse(h.can(.back, exists: always))
    }
}

final class CommandPaletteTests: XCTestCase {
    private let resolved = Commands.resolve(Config.defaults.keybindings)

    private func rows(_ recent: [CommandId] = [], available: (CommandId) -> Bool = { _ in true }) -> [CommandPaletteRow] {
        CommandPalette.rows(prefix: resolved.prefix, bindings: resolved.bindings, recent: recent, available: available)
    }

    func testGivesEveryCommandACategoryAndALabel() {
        for command in Commands.all {
            XCTAssertFalse(command.label.isEmpty)
            XCTAssertFalse(command.category.rawValue.isEmpty)
        }
    }

    func testBindsThePaletteToTheColonCharacter() {
        XCTAssertEqual(resolved.bindings.first { $0.commandId == .openCommandPalette }?.key.key, ":")
    }

    func testListsEveryCommandButTheForwardedPrefixAndItself() {
        let ids = rows().map(\.commandId)
        XCTAssertFalse(ids.contains(.forwardPrefix))
        XCTAssertFalse(ids.contains(.openCommandPalette))
        XCTAssertTrue(ids.contains(.navigateBack))
        XCTAssertEqual(ids.count, Commands.all.count - 2)
    }

    func testTitlesARowByCategoryAndShowsItsChords() {
        let row = rows().first { $0.commandId == .addWorkspace }
        XCTAssertEqual(row?.title, "Workspace: Add Workspace…")
        XCTAssertEqual(row?.chords, ["Cmd+q f"])
        XCTAssertEqual(rows().first { $0.commandId == .navigateBack }?.chords, ["Cmd+q h"])
    }

    func testHidesWhatWouldDoNothingNow() {
        XCTAssertFalse(rows(available: { $0 != .renameAgent }).map(\.commandId).contains(.renameAgent))
    }

    func testPutsRecentlyUsedCommandsFirstMostRecentFirst() {
        let list = rows([.openSettings, .toggleSidebar])
        XCTAssertEqual(list.prefix(2).map(\.commandId), [.openSettings, .toggleSidebar])
        XCTAssertTrue(list[0].recent)
        XCTAssertFalse(list[2].recent)
    }

    func testRemembersARunCommandAtTheFrontOnceWithinTheLimit() {
        var recent: [CommandId] = []
        recent = CommandPalette.remember(recent, .openSettings)
        recent = CommandPalette.remember(recent, .toggleSidebar)
        recent = CommandPalette.remember(recent, .openSettings)
        XCTAssertEqual(recent, [.openSettings, .toggleSidebar])
        XCTAssertEqual(CommandPalette.remember([.navigateBack, .navigateForward], .openSettings, limit: 2), [.openSettings, .navigateBack])
    }

    func testMatchesASubsequenceOfTheTitleCaseInsensitively() {
        let found = CommandPalette.filter(rows(), query: "tglsdbr").map(\.commandId)
        XCTAssertTrue(found.contains(.toggleSidebar))
        XCTAssertFalse(found.contains(.openSettings))
    }

    func testMatchesTheCommandIdToo() {
        XCTAssertEqual(CommandPalette.filter(rows(), query: "refresh_repositories").first?.commandId, .refreshRepositories)
    }

    func testKeepsEverythingInOrderForAnEmptyQuery() {
        let all = rows()
        XCTAssertEqual(CommandPalette.filter(all, query: ""), all)
    }

    func testLeavesNothingForAQueryNothingMatches() {
        XCTAssertEqual(CommandPalette.filter(rows(), query: "zzzzqqq"), [])
    }
}

final class TerminalActivityTests: XCTestCase {
    private let working = TerminalActivity(status: .working, unread: nil)
    private let unread = TerminalActivity(status: .idle, unread: .idle)

    private func pane(_ id: String, _ running: Bool, _ inView: Bool = false) -> TerminalPaneObservation {
        TerminalPaneObservation(pane: id, running: running, inView: inView)
    }

    func testIsIdleAndDrawsNothingUntilSomethingRuns() {
        var panes = TerminalPanes()
        XCTAssertEqual(panes.activity, .idle)
        XCTAssertFalse(panes.observe([pane("%1", false)], workspaceVisible: false))
        XCTAssertEqual(panes.activity, .idle)
    }

    func testGoesWorkingFinishedUnseenUnreadViewedRead() {
        var panes = TerminalPanes()
        XCTAssertTrue(panes.observe([pane("%1", true)], workspaceVisible: false))
        XCTAssertEqual(panes.activity, working)
        XCTAssertTrue(panes.observe([pane("%1", false)], workspaceVisible: false))
        XCTAssertEqual(panes.activity, unread)
        XCTAssertFalse(panes.observe([pane("%1", false)], workspaceVisible: false))
        XCTAssertEqual(panes.activity, unread)
        XCTAssertFalse(panes.observe([pane("%1", false, false)], workspaceVisible: true))
        XCTAssertEqual(panes.activity, unread)
        XCTAssertTrue(panes.observe([pane("%1", false, true)], workspaceVisible: true))
        XCTAssertEqual(panes.activity, .idle)
    }

    func testIsNeverUnreadWhenItFinishesWhileBeingLookedAt() {
        var panes = TerminalPanes()
        _ = panes.observe([pane("%1", true, true)], workspaceVisible: true)
        _ = panes.observe([pane("%1", false, true)], workspaceVisible: true)
        XCTAssertEqual(panes.activity, .idle)
    }

    func testGoesBackToWorkingWhenOutputResumesAndUnreadAgainWhenItSettles() {
        var panes = TerminalPanes()
        _ = panes.observe([pane("%1", true)], workspaceVisible: false)
        _ = panes.observe([pane("%1", false)], workspaceVisible: false)
        XCTAssertEqual(panes.activity, unread)
        _ = panes.observe([pane("%1", true)], workspaceVisible: false)
        XCTAssertEqual(panes.activity, TerminalActivity(status: .working, unread: .idle))
        _ = panes.observe([pane("%1", false)], workspaceVisible: false)
        XCTAssertEqual(panes.activity, unread)
    }

    func testIsReadByReadForThePanesOnScreenOnly() {
        var panes = TerminalPanes()
        _ = panes.observe([pane("%1", true, true), pane("%2", true, false)], workspaceVisible: false)
        _ = panes.observe([pane("%1", false, true), pane("%2", false, false)], workspaceVisible: false)
        XCTAssertEqual(panes.activity, unread)
        XCTAssertFalse(panes.read())
        XCTAssertEqual(panes.activity, unread)
        XCTAssertTrue(panes.observe([pane("%1", false, true)], workspaceVisible: false))
        XCTAssertEqual(panes.activity, .idle)
    }

    func testRollsSeveralPanesUpWorkingIfAnyIsUnreadIfAnyIs() {
        var panes = TerminalPanes()
        _ = panes.observe([pane("%1", true), pane("%2", true)], workspaceVisible: false)
        _ = panes.observe([pane("%1", false), pane("%2", true)], workspaceVisible: false)
        XCTAssertEqual(panes.activity, TerminalActivity(status: .working, unread: .idle))
    }

    func testForgetsAPaneThatClosedUnreadIncluded() {
        var panes = TerminalPanes()
        _ = panes.observe([pane("%1", true)], workspaceVisible: false)
        _ = panes.observe([pane("%1", false)], workspaceVisible: false)
        XCTAssertTrue(panes.observe([], workspaceVisible: false))
        XCTAssertEqual(panes.activity, .idle)
        _ = panes.observe([pane("%3", false)], workspaceVisible: false)
        XCTAssertEqual(panes.activity, .idle)
    }

    // MARK: the model's half of seen

    private let ws = WorkspaceId(unchecked: "550e8400-e29b-41d4-a716-446655440000")

    private func model() -> AppModel {
        var app = scratchModel()
        try! app.addWorkspace(Workspace(id: ws, location: .local(path: "/dev/a"), selectedPath: "/dev/a"))
        return app
    }

    private func terminalsOf(_ app: AppModel) -> TerminalActivity? {
        app.snapshot().workspaces.first { $0.id == ws }?.terminals
    }

    func testRaisesUnreadForAWorkspaceNobodyIsLookingAtAndClearsItWhenSelected() throws {
        var app = model()
        app.setWindowFocused(true)
        app.observeTerminalActivity([WorkspaceTerminalObservation(workspaceId: ws.rawValue, panes: [pane("%1", true, true)])])
        XCTAssertEqual(terminalsOf(app), working)
        app.observeTerminalActivity([WorkspaceTerminalObservation(workspaceId: ws.rawValue, panes: [pane("%1", false, true)])])
        XCTAssertEqual(terminalsOf(app), unread)
        try app.selectContext(.workspace(ws))
        XCTAssertEqual(terminalsOf(app), .idle)
    }

    func testIsNotSeenWhileDevHubIsBehindAnotherWindowAndIsReadWhenItComesBack() throws {
        var app = model()
        app.setWindowFocused(true)
        try app.selectContext(.workspace(ws))
        app.setWindowFocused(false)
        app.observeTerminalActivity([WorkspaceTerminalObservation(workspaceId: ws.rawValue, panes: [pane("%1", true, true)])])
        app.observeTerminalActivity([WorkspaceTerminalObservation(workspaceId: ws.rawValue, panes: [pane("%1", false, true)])])
        XCTAssertEqual(terminalsOf(app), unread)
        app.setWindowFocused(true)
        XCTAssertEqual(terminalsOf(app), .idle)
    }

    func testFinishingOnScreenRaisesNothing() throws {
        var app = model()
        app.setWindowFocused(true)
        try app.selectContext(.workspace(ws))
        app.observeTerminalActivity([WorkspaceTerminalObservation(workspaceId: ws.rawValue, panes: [pane("%1", true, true)])])
        app.observeTerminalActivity([WorkspaceTerminalObservation(workspaceId: ws.rawValue, panes: [pane("%1", false, true)])])
        XCTAssertEqual(terminalsOf(app), .idle)
    }

    func testSkipsAWorkspaceItDoesNotHaveAndOnlyBumpsTheRevisionOnAChange() {
        var app = model()
        let before = app.snapshot().revision
        app.observeTerminalActivity([
            WorkspaceTerminalObservation(workspaceId: "gone", panes: [pane("%1", true)]),
            WorkspaceTerminalObservation(workspaceId: ws.rawValue, panes: [pane("%1", false)]),
        ])
        XCTAssertEqual(app.snapshot().revision, before)
    }
}

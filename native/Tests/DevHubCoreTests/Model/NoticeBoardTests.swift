// Ports the rules of apps/desktop/src/shell/toasts/toast.test.tsx,
// noticeCenter.test.tsx, alertLifetime.test.tsx and the auto-hide clock.
import XCTest
@testable import DevHubCore

final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Double
    init(_ value: Double = 1_000_000) { self.value = value }
    var now: Double { lock.withLock { value } }
    func advance(_ ms: Double) { lock.withLock { value += ms } }
}

final class NoticeBoardTests: XCTestCase {
    func failure(_ code: AppErrorCode, _ detail: String? = nil) -> AppError {
        var error = AppError.at(code)
        error.detail = detail
        return error
    }

    func board(_ clock: TestClock = TestClock()) -> NoticeBoard {
        NoticeBoard(now: { clock.now })
    }

    func testAFailureIsOneSlotAndANewerFailureReplacesIt() {
        var notices = board()
        notices.raiseFailure(failure(.workspaceUnavailable, "first"))
        notices.raiseFailure(failure(.persistenceDegraded, "second"))
        XCTAssertEqual(notices.notices.map(\.detail), ["second"])
        XCTAssertEqual(notices.center.map(\.notice.detail), ["second", "first"])
        XCTAssertEqual(notices.center.map(\.current), [true, false])
    }

    func testDoesNotPileUpWhenTheSameFailureRepeats() {
        let clock = TestClock()
        var notices = board(clock)
        for _ in 0..<5 { notices.raiseFailure(failure(.workspaceUnavailable, "again")); clock.advance(100) }
        XCTAssertEqual(notices.notices.count, 1)
        XCTAssertEqual(notices.center.count, 1)
    }

    func testStaysDismissedWhenTheSameFailureIsRaisedAgainAndComesBackAfterTheNextAction() {
        let clock = TestClock()
        var notices = board(clock)
        notices.raiseFailure(failure(.workspaceUnavailable, "one"))
        XCTAssertTrue(notices.dismissNewest())
        clock.advance(10_000)
        notices.raiseFailure(failure(.workspaceUnavailable, "in other words"))
        XCTAssertEqual(notices.notices, [])
        notices.raiseFailure(failure(.persistenceDegraded))
        XCTAssertEqual(notices.notices.count, 1)
        notices.clearFailure()
        XCTAssertEqual(notices.notices, [])
        notices.raiseFailure(failure(.workspaceUnavailable, "news again"))
        XCTAssertEqual(notices.notices.map(\.detail), ["news again"])
    }

    func testConditionsAreASlotPerSourceAndEachSourceRetractsOnlyItsOwn() {
        var notices = board()
        notices.observeCondition(source: "gh", summary: "gh is not installed.")
        notices.observeCondition(source: "machine:box", summary: "box is not answering.")
        notices.observeCondition(source: "gh", summary: "gh is not installed.")
        XCTAssertEqual(notices.notices.map(\.summary), ["gh is not installed.", "box is not answering."])
        notices.observeCondition(source: "gh", summary: nil)
        XCTAssertEqual(notices.notices.map(\.summary), ["box is not answering."])
        XCTAssertEqual(notices.center.map { NoticeBoard.entryState($0) }, ["Ongoing", "Resolved"])
    }

    func testAConditionPutAwayStaysAwayUntilItsSourceRetractsIt() {
        var notices = board()
        notices.observeCondition(source: "gh", summary: "gh is not installed.")
        notices.dismiss(appConditionIdentity("gh"))
        notices.observeCondition(source: "gh", summary: "gh is still not installed.")
        XCTAssertEqual(notices.notices, [])
        notices.observeCondition(source: "gh", summary: nil)
        notices.observeCondition(source: "gh", summary: "gh is gone again.")
        XCTAssertEqual(notices.notices.map(\.summary), ["gh is gone again."])
    }

    func testTheNextActionRetiresFailuresAndNotConditions() {
        var notices = board()
        var retired: [(String, NoticeRetirement)] = []
        notices.onRetired = { retired.append(($0, $1)) }
        notices.observeCondition(source: "gh", summary: "gh is not installed.")
        notices.raiseFailure(failure(.workspaceUnavailable))
        notices.clearFailure()
        XCTAssertEqual(notices.notices.map(\.live), [.status])
        XCTAssertEqual(retired.map(\.1), [.nextAction])
    }

    func testDismissNewestReachesTheNewestThenTheOther() {
        var notices = board()
        notices.observeCondition(source: "gh", summary: "gh")
        notices.raiseFailure(failure(.workspaceUnavailable))
        XCTAssertEqual(notices.notices.map(\.live), [.status, .alert])
        notices.dismissNewest()
        XCTAssertEqual(notices.notices.map(\.live), [.status])
        notices.dismissNewest()
        XCTAssertEqual(notices.notices, [])
        XCTAssertFalse(notices.dismissNewest())
    }

    func testHidingIsNotDismissingTheCenterKeepsItUnread() {
        var notices = board()
        var retired: [NoticeRetirement] = []
        notices.onRetired = { retired.append($1) }
        notices.raiseFailure(failure(.workspaceUnavailable))
        let identity = notices.notices[0].identity
        notices.hide(identity)
        XCTAssertEqual(notices.notices, [])
        XCTAssertEqual(notices.center.map(\.read), [false])
        XCTAssertEqual(notices.unreadCount, 1)
        XCTAssertEqual(retired, [.timeout])
        notices.raiseFailure(failure(.persistenceDegraded))
        notices.dismissNewest()
        XCTAssertEqual(notices.center.map(\.read), [true, false])
    }

    func testTheCenterIsReadOnceOpenedAndMarksWhatWasNew() {
        var notices = board()
        notices.observeCondition(source: "a", summary: "A")
        notices.observeCondition(source: "b", summary: "B")
        let keys = Set(notices.center.map(\.key))
        notices.openCenter()
        XCTAssertEqual(notices.openUnread, keys)
        XCTAssertEqual(notices.unreadCount, 0)
        // What arrives while it is open is seen as it arrives.
        notices.observeCondition(source: "c", summary: "C")
        XCTAssertEqual(notices.unreadCount, 0)
        notices.toggleCenter()
        XCTAssertFalse(notices.isCenterOpen)
    }

    func testRemovingAnEntryTakesItsToastAndClearAllEmptiesBoth() {
        var notices = board()
        notices.observeCondition(source: "a", summary: "A")
        notices.raiseFailure(failure(.workspaceUnavailable))
        let condition = notices.center.first { $0.notice.live == .status }!
        notices.remove(condition.key)
        XCTAssertEqual(notices.notices.map(\.live), [.alert])
        XCTAssertEqual(notices.center.count, 1)
        notices.clearAll()
        XCTAssertEqual(notices.notices, [])
        XCTAssertEqual(notices.center.count, 0)
    }

    func testANoticesTextIsItsSummaryAndDetail() {
        XCTAssertEqual(Notice(identity: "x", summary: "S", detail: "D", live: .alert).text, "S\nD")
        XCTAssertEqual(Notice(identity: "x", summary: "S", live: .status).text, "S")
        XCTAssertEqual(Notice.failure(failure(.settingsRefused)).actions, [.openSettings])
    }

    // MARK: The clock

    func testHidesAfterItsSecondsAndWaitsWhileThePersonIsWithIt() {
        var clock = AutoHideClock(seconds: 8, now: 0)
        XCTAssertEqual(clock.deadline, 8_000)
        clock.setHovered(true, now: 3_000)
        XCTAssertNil(clock.deadline)
        XCTAssertFalse(clock.due(at: 100_000))
        clock.setHovered(false, now: 10_000)
        // 5 s were left, and it runs on from there.
        XCTAssertEqual(clock.deadline, 15_000)
    }

    func testGivesAtLeastTwoSecondsOnceThePersonMovesAway() {
        var clock = AutoHideClock(seconds: 8, now: 0)
        clock.setFocused(true, now: 7_500)
        clock.setFocused(false, now: 9_000)
        XCTAssertEqual(clock.deadline, 11_000)
        clock.setSelected(true, now: 9_500)
        clock.setSelected(false, now: 9_600)
        XCTAssertEqual(clock.deadline, 11_600)
    }

    func testStaysForEverAtZeroAndFollowsTheSettingWhenItChanges() {
        var clock = AutoHideClock(seconds: 0, now: 0)
        XCTAssertNil(clock.deadline)
        clock.setSeconds(4, now: 1_000)
        XCTAssertEqual(clock.deadline, 5_000)
    }

    func testAlertLifetimeKeepsADismissedFailureAway() {
        var lifetime = AlertLifetime<String>(identity: { $0 })
        lifetime.raise("a")
        lifetime.dismiss()
        lifetime.raise("a")
        XCTAssertNil(lifetime.alert)
        lifetime.raise("b")
        XCTAssertEqual(lifetime.alert, "b")
        lifetime.clear()
        lifetime.raise("a")
        XCTAssertEqual(lifetime.alert, "a")
    }
}

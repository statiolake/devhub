// Port of apps/desktop/src/main/agent/{injection,activity,screenFreshness}.test.ts.

import Foundation
import XCTest
@testable import DevHubCore

private let AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"

/// A message somebody has already agreed to.
private func confirmed(_ text: String, _ id: String = "intent-1") -> AgentInjectionIntent {
    AgentInjectionIntent(id: id, text: text, state: .confirmed)
}

/// A message composed but not yet read by anybody.
private func underReview(_ text: String, _ id: String = "intent-1") -> AgentInjectionIntent {
    AgentInjectionIntent(id: id, text: text, state: .pendingReview)
}

/// Reconcile rounds on a clock the test controls, at the real cadence.
private final class Rounds {
    var now = 1_000_000.0
    let queue: AgentInjectionQueue
    init(_ queue: AgentInjectionQueue) { self.queue = queue }

    func step(_ status: TerminalAgentStatus, _ count: Int = 1, everyMs: Double = 300) -> [String?] {
        (0..<count).map { _ in
            now += everyMs
            return queue.due(AGENT, status: status, now: now)
        }
    }
}

/// Enough rounds at the real cadence to cover the settle window.
private let ENOUGH = Int((AgentInjectionQueue.idleSettleMs / 300).rounded(.up)) + 1

final class AgentInjectionQueueTests: XCTestCase {
    func testSendsNothingUntilThePromptHasBeenIdleForAWholeSecond() throws {
        let queue = AgentInjectionQueue()
        let rounds = Rounds(queue)
        try queue.queue(AGENT, confirmed("do the thing"))
        let seen = rounds.step(.idle, ENOUGH)
        let sentAt = seen.firstIndex { $0 != nil }!
        XCTAssertEqual(seen[sentAt], "do the thing")
        XCTAssertGreaterThanOrEqual(Double(sentAt + 1) * 300, AgentInjectionQueue.idleSettleMs)
    }

    func testIsNotSatisfiedByReadingsThatArriveFasterThanTheWindow() throws {
        let queue = AgentInjectionQueue()
        try queue.queue(AGENT, confirmed("do the thing"))
        XCTAssertTrue(Rounds(queue).step(.idle, 20, everyMs: 10).allSatisfy { $0 == nil })
    }

    func testIsNotSatisfiedByASingleReadingLongAfterTheLast() throws {
        let queue = AgentInjectionQueue()
        try queue.queue(AGENT, confirmed("do the thing"))
        XCTAssertNil(Rounds(queue).step(.idle, 1, everyMs: 60_000).last!)
        XCTAssertGreaterThan(AgentInjectionQueue.idleReadingsBeforeSend, 1)
    }

    func testNeverTypesIntoATurnThatIsRunning() throws {
        let queue = AgentInjectionQueue()
        try queue.queue(AGENT, confirmed("do the thing"))
        XCTAssertTrue(Rounds(queue).step(.working, 30).allSatisfy { $0 == nil })
    }

    func testNeverTypesIntoAnAgentThatHasStoppedToAskAQuestion() throws {
        let queue = AgentInjectionQueue()
        try queue.queue(AGENT, confirmed("do the thing"))
        XCTAssertTrue(Rounds(queue).step(.waiting, 30).allSatisfy { $0 == nil })
    }

    func testTypesIntoAPromptWhoseAgentHasBackgroundTasksWorkingAsIntoAnIdleOne() throws {
        let queue = AgentInjectionQueue()
        let rounds = Rounds(queue)
        try queue.queue(AGENT, confirmed("do the thing"))
        XCTAssertEqual(queue.state(AGENT, status: .background).waitingFor, .settling)
        _ = rounds.step(.idle, 2)
        XCTAssertEqual(rounds.step(.background, ENOUGH - 2).last!, "do the thing")
    }

    func testNeverTypesIntoAScreenItCannotRead() throws {
        let queue = AgentInjectionQueue()
        try queue.queue(AGENT, confirmed("do the thing"))
        XCTAssertTrue(Rounds(queue).step(.unknown, 30).allSatisfy { $0 == nil })
    }

    func testStartsTheWaitAgainWhenTheAgentStopsBeingIdle() throws {
        let queue = AgentInjectionQueue()
        let rounds = Rounds(queue)
        try queue.queue(AGENT, confirmed("do the thing"))
        _ = rounds.step(.idle, ENOUGH - 1)
        _ = rounds.step(.working)
        XCTAssertNil(rounds.step(.idle).last!)
        XCTAssertTrue(rounds.step(.idle, ENOUGH).contains { $0 != nil })
    }

    func testSendsOneTextOnceAndNotAgain() throws {
        let queue = AgentInjectionQueue()
        let rounds = Rounds(queue)
        try queue.queue(AGENT, confirmed("do the thing"))
        _ = rounds.step(.idle, ENOUGH)
        queue.sent(AGENT)
        XCTAssertTrue(rounds.step(.idle, 30).allSatisfy { $0 == nil })
    }

    func testMakesASecondTextWaitForItsOwnSettledPrompt() throws {
        let queue = AgentInjectionQueue()
        let rounds = Rounds(queue)
        try queue.queue(AGENT, confirmed("first", "one"))
        try queue.queue(AGENT, confirmed("second", "two"))
        _ = rounds.step(.idle, ENOUGH)
        queue.sent(AGENT)
        XCTAssertNil(rounds.step(.idle).last!)
        XCTAssertTrue(rounds.step(.idle, ENOUGH).contains { $0 == "second" })
    }

    func testKeepsTextThatFailedToSendWithTheReasonAndTriesAgain() throws {
        let queue = AgentInjectionQueue()
        let rounds = Rounds(queue)
        try queue.queue(AGENT, confirmed("do the thing"))
        _ = rounds.step(.idle, ENOUGH)
        queue.failed(AGENT, reason: "the session went away")
        XCTAssertEqual(queue.state(AGENT, status: .idle).lastResult, .failed(reason: "the session went away"))
        XCTAssertEqual(queue.state(AGENT, status: .idle).queued, 1)
        XCTAssertTrue(rounds.step(.idle, ENOUGH).contains { $0 == "do the thing" })
    }

    func testSaysWhyItIsHoldingTextInTheAgentsOwnTerms() throws {
        let queue = AgentInjectionQueue()
        XCTAssertEqual(queue.state(AGENT, status: .idle).waitingFor, .nothingQueued)
        try queue.queue(AGENT, confirmed("do the thing"))
        XCTAssertEqual(queue.state(AGENT, status: .working).waitingFor, .agentBusy)
        XCTAssertEqual(queue.state(AGENT, status: .waiting).waitingFor, .agentAsking)
        XCTAssertEqual(queue.state(AGENT, status: .unknown).waitingFor, .agentUnreadable)
        XCTAssertEqual(queue.state(AGENT, status: .idle).waitingFor, .settling)
    }

    func testHandsBackWhatAnAgentThatEndedWasNeverTold() throws {
        let queue = AgentInjectionQueue()
        try queue.queue(AGENT, confirmed("first", "one"))
        try queue.queue(AGENT, confirmed("second", "two"))
        XCTAssertEqual(queue.forget(AGENT).map(\.text), ["first", "second"])
        XCTAssertEqual(queue.state(AGENT, status: .idle).queued, 0)
    }

    func testRefusesEmptyTextRatherThanQueueingABareEnter() {
        XCTAssertThrowsError(try AgentInjectionQueue().queue(AGENT, confirmed("   \n ")))
    }

    func testNeverSendsAMessageNobodyHasAgreedToHoweverIdleThePrompt() throws {
        let queue = AgentInjectionQueue()
        try queue.queue(AGENT, underReview("implement the Issue"))
        XCTAssertTrue(Rounds(queue).step(.idle, 30).allSatisfy { $0 == nil })
        XCTAssertEqual(queue.state(AGENT, status: .idle).waitingFor, .awaitingReview)
    }

    func testSendsItOnceThePromptSettlesWhenTheWordingWasAgreedFirst() throws {
        let queue = AgentInjectionQueue()
        let rounds = Rounds(queue)
        try queue.queue(AGENT, underReview("draft"))
        _ = try queue.confirm(AGENT, intentId: "intent-1", text: "edited by hand")
        XCTAssertTrue(rounds.step(.idle, ENOUGH).contains { $0 == "edited by hand" })
    }

    func testSendsOnTheNextRoundWhenThePromptSettledFirst() throws {
        let queue = AgentInjectionQueue()
        let rounds = Rounds(queue)
        try queue.queue(AGENT, underReview("draft"))
        XCTAssertTrue(rounds.step(.idle, 30).allSatisfy { $0 == nil })
        _ = try queue.confirm(AGENT, intentId: "intent-1", text: "edited by hand")
        XCTAssertEqual(rounds.step(.idle).last!, "edited by hand")
    }

    func testSendsTheWordingThatCameBackFromTheSheetNotTheDraft() throws {
        let queue = AgentInjectionQueue()
        let rounds = Rounds(queue)
        try queue.queue(AGENT, underReview("the rendered template"))
        _ = try queue.confirm(AGENT, intentId: "intent-1", text: "what the person typed instead")
        XCTAssertEqual(rounds.step(.idle, ENOUGH).last!, "what the person typed instead")
    }

    func testRefusesToConfirmEmptyWording() throws {
        let queue = AgentInjectionQueue()
        try queue.queue(AGENT, underReview("draft"))
        XCTAssertThrowsError(try queue.confirm(AGENT, intentId: "intent-1", text: "  "))
    }

    func testDropsACancelledMessageAndSaysItWasCancelled() throws {
        let queue = AgentInjectionQueue()
        try queue.queue(AGENT, underReview("draft"))
        XCTAssertTrue(queue.cancel(AGENT, intentId: "intent-1"))
        XCTAssertEqual(queue.state(AGENT, status: .idle).queued, 0)
        XCTAssertEqual(queue.state(AGENT, status: .idle).lastResult, .cancelled)
        XCTAssertTrue(Rounds(queue).step(.idle, 30).allSatisfy { $0 == nil })
    }

    func testSaysAMessageWentWhichAnEmptyQueueOnItsOwnDoesNot() throws {
        let queue = AgentInjectionQueue()
        let rounds = Rounds(queue)
        try queue.queue(AGENT, confirmed("do the thing"))
        _ = rounds.step(.idle, ENOUGH)
        queue.sent(AGENT)
        XCTAssertEqual(queue.state(AGENT, status: .idle).lastResult, .sent)
    }

    func testClearsTheLastOutcomeWhenSomethingNewIsQueued() throws {
        let queue = AgentInjectionQueue()
        try queue.queue(AGENT, underReview("draft"))
        _ = queue.cancel(AGENT, intentId: "intent-1")
        try queue.queue(AGENT, underReview("another", "intent-2"))
        XCTAssertNil(queue.state(AGENT, status: .idle).lastResult)
    }

    func testHandsBackAMessageThatWasStillUnderReviewWhenTheAgentEnded() throws {
        let queue = AgentInjectionQueue()
        try queue.queue(AGENT, underReview("implement the Issue"))
        XCTAssertEqual(queue.forget(AGENT), [AgentInjectionIntent(id: "intent-1", text: "implement the Issue", state: .pendingReview)])
        XCTAssertFalse(try queue.confirm(AGENT, intentId: "intent-1", text: "too late"))
        XCTAssertFalse(queue.cancel(AGENT, intentId: "intent-1"))
    }
}

final class AgentActivityReaderTests: XCTestCase {
    func screen(_ agentId: String, _ title: String) -> AgentScreen { AgentScreen(agentId: agentId, screen: "", oscTitle: title) }

    func testSaysNothingWhileTheTitleIsEmpty() {
        let reader = AgentActivityReader()
        XCTAssertNil(reader.activity(screen("a", "")))
        XCTAssertNil(reader.activity(screen("a", "   ")))
    }

    func testTakesATitleTheAgentSetAsTheAgentsOwnWord() {
        XCTAssertEqual(AgentActivityReader().activity(screen("a", "Reading agentReconciler.ts")), "Reading agentReconciler.ts")
    }

    func testReadsARunningAgentsTitleAsAWordNotAsABaseline() {
        XCTAssertEqual(AgentActivityReader().activity(screen("restored", "Running the tests")), "Running the tests")
    }

    func testFallsSilentWhenTheAgentClearsItsTitle() {
        let reader = AgentActivityReader()
        _ = reader.activity(screen("a", "Reading agentReconciler.ts"))
        XCTAssertNil(reader.activity(screen("a", "")))
    }

    func testKeepsEachAgentsWordToItself() {
        let reader = AgentActivityReader()
        _ = reader.activity(screen("a", "Reading agentReconciler.ts"))
        XCTAssertEqual(reader.activity(screen("b", "Running the tests")), "Running the tests")
        XCTAssertEqual(reader.showing("a"), "Reading agentReconciler.ts")
    }

    func testReReportsTheLastWordForARoundThatReadNothing() {
        let reader = AgentActivityReader()
        _ = reader.activity(screen("a", "Reading agentReconciler.ts"))
        XCTAssertEqual(reader.showing("a"), "Reading agentReconciler.ts")
    }

    func testHasNoWordForAnAgentItHasNeverRead() {
        XCTAssertNil(AgentActivityReader().showing("a"))
    }

    func testForgetsAnAgentThatEnded() {
        let reader = AgentActivityReader()
        _ = reader.activity(screen("a", "Reading agentReconciler.ts"))
        reader.forget("a")
        XCTAssertNil(reader.showing("a"))
    }
}

/// A clock the test moves by hand, in milliseconds.
final class HandClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Double
    init(_ ms: Double) { value = ms }
    func set(_ ms: Double) { lock.withLock { value = ms } }
    var now: Double { lock.withLock { value } }
}

final class AgentScreenFreshnessTests: XCTestCase {
    let agent = "agent-1"

    func testReadsAnAgentItHasNeverSeen() {
        XCTAssertTrue(AgentScreenFreshness(clock: { 0 }).shouldCapture(agent, marker: "100"))
    }

    func testStopsReadingAnAgentThatHasWrittenNothingSinceTheSecondEnded() {
        let clock = HandClock(100_500)
        let freshness = AgentScreenFreshness(clock: { clock.now })
        freshness.captured(agent, marker: "100")
        XCTAssertTrue(freshness.shouldCapture(agent, marker: "100"))
        clock.set(101_200)
        freshness.captured(agent, marker: "100")
        XCTAssertFalse(freshness.shouldCapture(agent, marker: "100"))
        clock.set(200_000)
        XCTAssertFalse(freshness.shouldCapture(agent, marker: "100"))
    }

    func testReadsAgainAsSoonAsTheAgentWrites() {
        let clock = HandClock(101_200)
        let freshness = AgentScreenFreshness(clock: { clock.now })
        freshness.captured(agent, marker: "100")
        XCTAssertFalse(freshness.shouldCapture(agent, marker: "100"))
        XCTAssertTrue(freshness.shouldCapture(agent, marker: "101"))
    }

    func testReadsEveryRoundWhileAMarkerItCannotCompareIsAllItIsGiven() {
        let freshness = AgentScreenFreshness(clock: { 500_000 })
        freshness.captured(agent, marker: nil)
        XCTAssertTrue(freshness.shouldCapture(agent, marker: nil))
        XCTAssertTrue(freshness.shouldCapture(agent, marker: "400"))
    }

    func testKeepsEachAgentsAnswerToItself() {
        let clock = HandClock(101_200)
        let freshness = AgentScreenFreshness(clock: { clock.now })
        freshness.captured(agent, marker: "100")
        XCTAssertFalse(freshness.shouldCapture(agent, marker: "100"))
        XCTAssertTrue(freshness.shouldCapture("agent-2", marker: "100"))
    }

    func testForgetsAnAgentThatEndedSoAReusedIdIsReadAfresh() {
        let clock = HandClock(101_200)
        let freshness = AgentScreenFreshness(clock: { clock.now })
        freshness.captured(agent, marker: "100")
        XCTAssertFalse(freshness.shouldCapture(agent, marker: "100"))
        freshness.forget(agent)
        XCTAssertTrue(freshness.shouldCapture(agent, marker: "100"))
    }
}

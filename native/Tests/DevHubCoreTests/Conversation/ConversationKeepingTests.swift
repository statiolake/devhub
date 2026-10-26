// Ports of apps/desktop/src/main/agent/conversation/{drafts,limitResume,
// cacheKeeper,cacheKeeper.session}.test.ts: what DevHub keeps for a GUI Agent
// across a restart, and what it decides from the conversation alone.

import Foundation
import XCTest
@testable import DevHubCore

/// A directory of the test's own, removed when it ends.
func scratchDirectory(_ name: String, _ test: XCTestCase) -> String {
    let path = FileManager.default.temporaryDirectory.appendingPathComponent("devhub-\(name)-\(UUID().uuidString)").path
    try? FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
    test.addTeardownBlock { try? FileManager.default.removeItem(atPath: path) }
    return path
}

private func readJson(_ path: String) throws -> JsonValue {
    try JsonValue.parse(try String(contentsOfFile: path, encoding: .utf8))
}

// MARK: - drafts.test.ts

final class AgentDraftsTests: XCTestCase {
    private var path = ""
    private let agents = Guarded<Set<String>>(["agent-1", "agent-2"])

    override func setUp() {
        path = "\(scratchDirectory("drafts", self))/devhub/drafts.json"
    }

    /// A DevHub starting: the store read back from the file.
    private func started() throws -> AgentDrafts {
        let agents = self.agents
        let loaded = try AgentDrafts.load(path) { agents.with { $0 } }
        XCTAssertNil(loaded.refused)
        return loaded.drafts
    }

    func testStartsWithNoneWhenThereIsNoFile() throws {
        XCTAssertEqual(try started().get("agent-1"), "")
        XCTAssertFalse(FileManager.default.fileExists(atPath: path))
    }

    func testGivesBackAfterARestartWhatItWasLastToldPerAgent() throws {
        let drafts = try started()
        drafts.set("agent-1", "fix the")
        drafts.set("agent-1", "fix the build")
        drafts.set("agent-2", "look at\n\nthe tests")
        let again = try started()
        XCTAssertEqual(again.get("agent-1"), "fix the build")
        XCTAssertEqual(again.get("agent-2"), "look at\n\nthe tests")
    }

    func testKeepsNoDraftOnceItIsEmptiedAsWhenItIsSent() throws {
        let drafts = try started()
        drafts.set("agent-1", "fix the build")
        drafts.set("agent-1", "")
        XCTAssertEqual(try started().get("agent-1"), "")
        XCTAssertEqual(try readJson(path), ["version": 1, "drafts": [:]])
    }

    func testDropsTheDraftOfAnAgentThatWasClosed() throws {
        let drafts = try started()
        drafts.set("agent-1", "one")
        drafts.set("agent-2", "two")
        agents.with { _ = $0.remove("agent-1") }
        try drafts.prune()
        XCTAssertEqual(drafts.get("agent-1"), "")
        let again = try started()
        XCTAssertEqual(again.get("agent-1"), "")
        XCTAssertEqual(again.get("agent-2"), "two")
    }

    func testDropsAtLoadTheDraftOfAnAgentThatWentAwayWhileDevHubWasNotRunning() throws {
        try started().set("agent-1", "one")
        agents.with { _ = $0.remove("agent-1") }
        XCTAssertEqual(try started().get("agent-1"), "")
        XCTAssertEqual(try readJson(path).objectValue?["drafts"], [:])
    }

    func testDoesNotKeepAReportThatArrivesAfterItsAgentWentAway() throws {
        let drafts = try started()
        agents.with { _ = $0.remove("agent-1") }
        drafts.set("agent-1", "too late")
        XCTAssertEqual(drafts.get("agent-1"), "")
        XCTAssertFalse(FileManager.default.fileExists(atPath: path))
    }

    func testMovesAFileItCannotReadAsideStartsEmptyAndSaysSo() throws {
        try started().set("agent-1", "one")
        try "{ not json".write(toFile: path, atomically: true, encoding: .utf8)
        let agents = self.agents
        let loaded = try AgentDrafts.load(path) { agents.with { $0 } }
        XCTAssertEqual(loaded.drafts.get("agent-1"), "")
        XCTAssertTrue(loaded.refused?.contains("\(path).corrupt") ?? false)
        XCTAssertEqual(try String(contentsOfFile: "\(path).corrupt", encoding: .utf8), "{ not json")
        XCTAssertFalse(FileManager.default.fileExists(atPath: path))
    }

    func testRefusesAFileWhoseDraftsAreNotText() throws {
        try started().set("agent-1", "one")
        try json(["version": 1, "drafts": ["agent-1": 3]]).write(toFile: path, atomically: true, encoding: .utf8)
        let agents = self.agents
        let loaded = try AgentDrafts.load(path) { agents.with { $0 } }
        XCTAssertTrue(loaded.refused?.contains("the draft of agent-1 is not text") ?? false, loaded.refused ?? "")
    }

    func testReadsTheFileTheTsAppWrites() throws {
        try FileManager.default.createDirectory(
            atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        try "{\"version\":1,\"drafts\":{\"agent-2\":\"from TS\"}}\n".write(
            toFile: path, atomically: true, encoding: .utf8)
        let drafts = try started()
        XCTAssertEqual(drafts.get("agent-2"), "from TS")
        drafts.set("agent-1", "from Swift")
        XCTAssertEqual(
            try String(contentsOfFile: path, encoding: .utf8),
            "{\"version\":1,\"drafts\":{\"agent-2\":\"from TS\",\"agent-1\":\"from Swift\"}}\n")
    }
}

// MARK: - limitResume.test.ts

private let NOW: Double = 1_800_000_000_000

private func ready(_ turn: TurnState) -> ConversationEvent { .state(.ready(turn: turn)) }

private func turnEnd(_ id: String, _ resetsAt: Double?) -> ConversationEvent {
    .entry(.turnEnd(TurnEndEntry(id: EntryId(id), outcome: .failed, limit: LimitStop(resetsAt: resetsAt))))
}

private func limitedTurn(_ id: String, _ resetsAt: Double?) -> [ConversationEvent] {
    [ready(.running), turnEnd(id, resetsAt), ready(.none)]
}

/// A resumer watching a conversation that is folded as the test goes.
private final class Watching {
    let clock = TurnedClock(NOW)
    let records = MemoryRecords()
    var shownLast: [LimitResume?] = []
    let dueCount = Guarded(0)
    var resumer: LimitResumer!
    var transcript = EMPTY_TRANSCRIPT
    var offset = 0

    init(_ settings: LimitResumeSettings = RESUME_ON) {
        let dueCount = self.dueCount
        resumer = LimitResumer(
            LimitResumeOptions(settings: { settings }, record: records.slot(), clock: clock),
            show: { [unowned self] in shownLast.append($0) }, due: { dueCount.with { $0 += 1 } })
    }

    func see(_ events: [ConversationEvent]) throws {
        transcript = try applyEvents(transcript, events)
        offset += 100
        try resumer.observe(transcript, offset: offset)
    }

    var shown: LimitResume? { shownLast.last ?? nil }
    var due: Int { dueCount.with { $0 } }
}

final class LimitResumerTests: XCTestCase {
    func testIsResumedAfterItsResetWithTheMargin() throws {
        let watching = Watching()
        try watching.see(limitedTurn("t1", NOW + 3_600_000))
        let at = NOW + 3_600_000 + RESET_MARGIN_MS
        XCTAssertEqual(watching.shown, .scheduled(at: at))
        XCTAssertEqual(watching.records.get("agent"), LimitResumeRecord(entry: "t1", since: 100, at: at))
        watching.clock.advance(at - NOW)
        XCTAssertEqual(watching.due, 1)
        XCTAssertEqual(try watching.resumer.take(), "続けて")
        XCTAssertNil(watching.shown)
        XCTAssertNil(watching.records.get("agent")?.at)
    }

    func testIsNotResumedWhenItsResetHasAlreadyPassedAsItIsSeen() throws {
        let watching = Watching()
        try watching.see(limitedTurn("t1", NOW - 1))
        XCTAssertEqual(watching.shown, .unscheduled(reason: "the limit had already reset when DevHub read it"))
        XCTAssertEqual(watching.clock.pending, 0)
    }

    func testLearnsItsResetAfterItFirstStoodAndIsResumedThen() throws {
        let watching = Watching()
        try watching.see(limitedTurn("t1", nil))
        guard case .unscheduled? = watching.shown else { return XCTFail("\(String(describing: watching.shown))") }
        try watching.see([turnEnd("t1", NOW + 60_000)])
        XCTAssertEqual(watching.shown, .scheduled(at: NOW + 60_000 + RESET_MARGIN_MS))
    }

    func testIsOverOnceTheCliIsStartedAgainOnItsSession() throws {
        let watching = Watching()
        try watching.see(limitedTurn("t1", NOW + 60_000))
        try watching.see([
            .restarted,
            .entry(.notice(NoticeEntry(id: "restarted:1", level: .info, text: "Session restarted"))),
        ])
        XCTAssertNil(watching.shown)
        XCTAssertEqual(watching.clock.pending, 0)
        XCTAssertEqual(watching.records.get("agent")?.entry, "t1")
        XCTAssertNil(watching.records.get("agent")?.at)
    }

    func testIsNeverWrittenWhenSettingsTurnedItOffBeforeItWasDue() throws {
        let settings = Guarded(RESUME_ON)
        let clock = TurnedClock(NOW)
        let records = MemoryRecords()
        let resumer = LimitResumer(
            LimitResumeOptions(settings: { settings.with { $0 } }, record: records.slot(), clock: clock),
            show: { _ in }, due: {})
        try resumer.observe(try applyEvents(EMPTY_TRANSCRIPT, limitedTurn("t1", NOW + 60_000)), offset: 100)
        settings.with { $0.enabled = false }
        clock.advance(60_000 + RESET_MARGIN_MS)
        XCTAssertNil(try resumer.take())
        XCTAssertNil(records.get("agent")?.at)
    }

    func testIsReadBackAsWrittenAndARecordThatIsNotOneIsRefused() throws {
        let path = "\(scratchDirectory("limit-resumes", self))/limit-resumes.json"
        let agents: @Sendable () -> Set<String> = { ["agent-1"] }
        let first = try AgentRecords.load(path, LIMIT_RESUME_RECORDS, accounted: agents)
        first.records.set("agent-1", LimitResumeRecord(entry: "turn:1", since: 42, at: 7))
        let again = try AgentRecords.load(path, LIMIT_RESUME_RECORDS, accounted: agents)
        XCTAssertEqual(again.records.get("agent-1"), LimitResumeRecord(entry: "turn:1", since: 42, at: 7))

        try json(["version": 1, "resumes": ["agent-1": ["at": "soon"]]]).write(
            toFile: path, atomically: true, encoding: .utf8)
        let refused = try AgentRecords.load(path, LIMIT_RESUME_RECORDS, accounted: agents)
        XCTAssertTrue(
            refused.refused?.contains("the resume of agent-1 is not an entry, an offset and a time") ?? false)
        XCTAssertNil(refused.records.get("agent-1"))
    }
}

// MARK: - cacheKeeper.test.ts

private let ON = CacheKeepSettings(enabled: true, leadSeconds: 60, minTokens: 20_000)
private let START: Double = 1_000_000
private let TTL_MS: Double = 300_000

private func idle(_ expiresAt: Double?, contextTokens: Double = 50_000, _ more: (inout Transcript) -> Void = { _ in })
    -> Transcript
{
    var transcript = EMPTY_TRANSCRIPT
    transcript.state = .ready(turn: .none)
    transcript.usage = Usage(
        contextTokens: contextTokens,
        promptCache: PromptCache(
            ttlSeconds: 300, ttlKnown: true, expiresAt: expiresAt, hitRatio: nil, requests: 1, misses: 0,
            recacheTokens: nil))
    more(&transcript)
    return transcript
}

private let COMPACTION = TranscriptEntry.compaction(
    CompactionEntry(id: "compaction:1", trigger: "manual", preTokens: 50_000, postTokens: 3_000))

final class CacheKeeperTests: XCTestCase {
    func testCompactIsDueLeadSecondsBeforeExpiryForAnIdleLargeWarmConversation() {
        let due = compactDue(idle(START + TTL_MS), ON)
        XCTAssertEqual(due?.expiresAt, START + TTL_MS)
        XCTAssertEqual(due?.at, START + TTL_MS - 60_000)
    }

    func testCompactIsNeverDueWhileOffBusySmallColdOrJustCompacted() {
        let warm = START + TTL_MS
        XCTAssertNil(compactDue(idle(warm), CACHE_KEEP_OFF))
        XCTAssertNil(compactDue(idle(nil), ON))
        XCTAssertNil(compactDue(idle(warm, contextTokens: 10_000), ON))
        XCTAssertNil(compactDue(idle(warm) { $0.state = .ready(turn: .running) }, ON))
        XCTAssertNil(compactDue(idle(warm) { $0.compacting = true }, ON))
        XCTAssertNil(
            compactDue(
                idle(warm) {
                    $0.pending = [PendingMessage(id: "held:1", text: "hi", images: [], failure: nil, editing: false)]
                }, ON))
        XCTAssertNil(compactDue(idle(warm) { $0.entries = [COMPACTION] }, ON))
    }

    private func keeper(_ settings: CacheKeepSettings = ON) -> (keeper: CacheKeeper, clock: TurnedClock, due: Guarded<Int>) {
        let clock = TurnedClock(START)
        let due = Guarded(0)
        return (CacheKeeper(settings: { settings }, clock: clock, due: { due.with { $0 += 1 } }), clock, due)
    }

    func testFiresOnceLeadSecondsBeforeTheCacheExpires() {
        let (k, clock, due) = keeper()
        let transcript = idle(START + TTL_MS)
        k.observe(transcript)
        clock.advance(TTL_MS - 60_001)
        XCTAssertEqual(due.with { $0 }, 0)
        clock.advance(1)
        XCTAssertEqual(due.with { $0 }, 1)
        XCTAssertTrue(k.take(transcript))
        // The same warm period does not fire again.
        k.observe(transcript)
        clock.advance(TTL_MS)
        XCTAssertEqual(due.with { $0 }, 1)
        XCTAssertFalse(k.take(transcript))
    }

    func testIsCalledOffWhenThePersonStartsATurn() {
        let (k, clock, due) = keeper()
        k.observe(idle(START + TTL_MS))
        clock.advance(60_000)
        k.observe(idle(START + TTL_MS) { $0.state = .ready(turn: .running) })
        clock.advance(TTL_MS)
        XCTAssertEqual(due.with { $0 }, 0)
    }

    func testSkipsWhenTheAgentIsBusyAtTheDeadline() {
        let (k, clock, due) = keeper()
        k.observe(idle(START + TTL_MS))
        clock.advance(TTL_MS - 60_000)
        XCTAssertEqual(due.with { $0 }, 1)
        XCTAssertFalse(k.take(idle(START + TTL_MS) { $0.state = .ready(turn: .running) }))
    }

    func testRearmsForANewWarmPeriodAfterANewResponse() {
        let (k, clock, due) = keeper()
        k.observe(idle(START + TTL_MS))
        clock.advance(120_000)
        let later = START + 120_000 + TTL_MS
        k.observe(idle(later))
        clock.advance(TTL_MS - 120_000 - 60_000)
        XCTAssertEqual(due.with { $0 }, 0)
        clock.advance(120_000)
        XCTAssertEqual(due.with { $0 }, 1)
        XCTAssertTrue(k.take(idle(later)))
    }

    func testDoesNothingWhenTheTimerComesLateAfterASleep() {
        let (k, clock, due) = keeper()
        let transcript = idle(START + TTL_MS)
        k.observe(transcript)
        // The Mac slept through the deadline: the clock jumps past expiry.
        clock.jump(to: START + TTL_MS + 10_000)
        clock.advance(TTL_MS)
        XCTAssertGreaterThan(due.with { $0 }, 0)
        XCTAssertFalse(k.take(transcript))
    }

    func testDoesNothingForACacheSeenAlreadyExpired() {
        let (k, clock, due) = keeper()
        let transcript = idle(START - 1_000)
        k.observe(transcript)
        clock.advance(0)
        XCTAssertEqual(due.with { $0 }, 1)
        XCTAssertFalse(k.take(transcript))
    }

    func testDoesNothingOnceStopped() {
        let (k, clock, due) = keeper()
        k.observe(idle(START + TTL_MS))
        k.stop()
        clock.advance(TTL_MS)
        XCTAssertEqual(due.with { $0 }, 0)
    }

    func testStaysOffWhileTheSettingIsOff() {
        let (k, clock, due) = keeper(CACHE_KEEP_OFF)
        k.observe(idle(START + TTL_MS))
        clock.advance(TTL_MS)
        XCTAssertEqual(due.with { $0 }, 0)
    }
}

// MARK: - cacheKeeper.session.test.ts

final class CacheKeeperSessionTests: XCTestCase {
    private let lines = Fixtures.text("conversation", "claude-session.capture.ndjson")
        .components(separatedBy: "\n").filter { !$0.isEmpty && !$0.hasPrefix("#") }

    /// The time the CLI stamped on the line, if it stamped one.
    private func stamp(_ line: String) -> Double? {
        guard let range = line.range(of: #""timestamp":"([^"]+)""#, options: .regularExpression) else { return nil }
        let text = line[range].dropFirst(#""timestamp":""#.count).dropLast()
        return parseISOTime(String(text))
    }

    /// The capture played, the clock following its stamps; every transcript observed.
    private func play(_ keeper: CacheKeeper, _ clock: TurnedClock) throws -> Transcript {
        let adapter = ClaudeAdapter(bootId: "replay")
        for text in lines {
            let line = String(text.dropFirst(2))
            if let at = stamp(line), at > clock.now() { clock.jump(to: at) }
            if text.hasPrefix("> ") { _ = try adapter.sent(line) } else { _ = try adapter.received(line) }
            keeper.observe(adapter.transcript)
        }
        return adapter.transcript
    }

    private func start(_ settings: @escaping @Sendable () -> CacheKeepSettings) -> (
        keeper: CacheKeeper, clock: TurnedClock, due: Guarded<Int>
    ) {
        let clock = TurnedClock(lines.lazy.compactMap { self.stamp(String($0.dropFirst(2))) }.first!)
        let due = Guarded(0)
        return (CacheKeeper(settings: settings, clock: clock, due: { due.with { $0 += 1 } }), clock, due)
    }

    func testReadsTheOneHourTtlOffTheStreamAndAContextAboveTheMinimum() throws {
        let (keeper, clock, _) = start { ON }
        let transcript = try play(keeper, clock)
        let cache = transcript.usage?.promptCache
        XCTAssertEqual(cache?.ttlSeconds, 3600)
        XCTAssertEqual(cache?.ttlKnown, true)
        XCTAssertGreaterThan(cache?.expiresAt ?? 0, clock.now())
        XCTAssertGreaterThanOrEqual(transcript.usage?.contextTokens ?? 0, 20_000)
        XCTAssertEqual(transcript.state, .ready(turn: .none))
    }

    func testFiresAMinuteBeforeTheHourRunsOutOnceAndTakesIt() throws {
        let (keeper, clock, due) = start { ON }
        let transcript = try play(keeper, clock)
        let expiresAt = try XCTUnwrap(transcript.usage?.promptCache?.expiresAt)
        XCTAssertEqual(keeper.dueAt(), expiresAt - 60_000)
        clock.advance(expiresAt - 60_001 - clock.now())
        XCTAssertEqual(due.with { $0 }, 0)
        clock.advance(1)
        XCTAssertEqual(due.with { $0 }, 1)
        XCTAssertTrue(keeper.take(transcript))
        clock.advance(3_600_000)
        XCTAssertEqual(due.with { $0 }, 1)
    }

    func testArmsWhenTheSettingIsTurnedOnWhileTheConversationSitsIdle() throws {
        let settings = Guarded(CACHE_KEEP_OFF)
        let (keeper, clock, due) = start { settings.with { $0 } }
        let transcript = try play(keeper, clock)
        XCTAssertNil(keeper.dueAt())
        settings.with { $0 = ON }
        keeper.reconsider()
        let expiresAt = try XCTUnwrap(transcript.usage?.promptCache?.expiresAt)
        XCTAssertEqual(keeper.dueAt(), expiresAt - 60_000)
        clock.advance(expiresAt - 60_000 - clock.now())
        XCTAssertEqual(due.with { $0 }, 1)
        XCTAssertTrue(keeper.take(transcript))
    }

    func testDisarmsWhenTheSettingIsTurnedOffAgain() throws {
        let settings = Guarded(ON)
        let (keeper, clock, due) = start { settings.with { $0 } }
        _ = try play(keeper, clock)
        settings.with { $0 = CACHE_KEEP_OFF }
        keeper.reconsider()
        XCTAssertNil(keeper.dueAt())
        clock.advance(7_200_000)
        XCTAssertEqual(due.with { $0 }, 0)
    }
}

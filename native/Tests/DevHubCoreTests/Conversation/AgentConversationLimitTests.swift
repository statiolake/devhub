// Port of apps/desktop/src/main/agent/conversation/conversation.test.ts (second half):
// a turn a usage limit stopped, and the CLI asleep after the compaction
// before the cache expires.

import Foundation
import XCTest
@testable import DevHubCore

/// When the five-hour window resets, in epoch seconds as the CLI says it.
private let RESETS: Double = 1_800_000_000
private let DUE = RESETS * 1000 + RESET_MARGIN_MS
/// An hour before the reset.
private let BEFORE = RESETS * 1000 - 3_600_000

/// What the CLI prints when a limit stops the turn under way; nil, a refusal that names no reset.
private func printLimit(_ host: FakeHost, _ resetsAt: Double?) {
    var info: JsonObject = ["status": "rejected"]
    if let resetsAt { info["resetsAt"] = .number(resetsAt) }
    info["rateLimitType"] = "five_hour"
    host.print(json(["type": "rate_limit_event", "rate_limit_info": .object(info), "session_id": "s-1"]))
    host.print(
        json([
            "type": "assistant",
            "message": [
                "id": "msg_limit", "role": "assistant", "content": [["type": "text", "text": "You've hit your limit"]],
            ],
            "parent_tool_use_id": nil, "session_id": "s-1", "error": "rate_limit",
        ]))
    host.print(
        json([
            "type": "result", "subtype": "success", "is_error": true, "duration_ms": 100,
            "result": "You've hit your limit", "session_id": "s-1",
        ]))
}

/// The user messages written to the CLI, with whom they were written for.
private func written(_ host: FakeHost) -> [String] {
    host.inLog.compactMap { record in
        guard let message = (try? JsonValue.parse(record.line))?.objectValue, message["type"] == "user" else {
            return nil
        }
        let origin = message["devhub_origin"]?.stringValue ?? "undefined"
        let content = message["message"]?.objectValue?["content"]?.stringValue ?? ""
        return "\(origin) \(content)"
    }
}

final class AgentConversationLimitTests: XCTestCase {
    /// One DevHub's conversation on `host`, going on after a limit as `settings` say.
    private func following(
        _ host: FakeHost, _ clock: TurnedClock, _ records: MemoryRecords, _ settings: LimitResumeSettings = RESUME_ON
    ) async throws -> AgentConversation {
        let conversation = conversationOn(
            host, boot: "boot",
            limits: LimitResumeOptions(settings: { settings }, record: records.slot(), clock: clock))
        try await conversation.start()
        await settle(conversation, host)
        return conversation
    }

    /// A conversation whose first turn a limit stopped.
    private func stopped(_ settings: LimitResumeSettings = RESUME_ON, resetsAt: Double? = RESETS) async throws -> (
        host: FakeHost, cli: AnsweringCli, clock: TurnedClock, records: MemoryRecords, conversation: AgentConversation
    ) {
        let host = FakeHost()
        let cli = AnsweringCli(host)
        let clock = TurnedClock(BEFORE)
        let records = MemoryRecords()
        let conversation = try await following(host, clock, records, settings)
        cli.hold = true
        try await conversation.submit("go", images: [])
        await settle(conversation, host)
        printLimit(host, resetsAt)
        await settle(conversation, host)
        return (host, cli, clock, records, conversation)
    }

    private func resume(_ conversation: AgentConversation) async -> LimitResume? {
        await conversation.reading().transcript.limitResume
    }

    func testIsGoneOnWithOnceTheLimitHasResetByAMessageWrittenForThePerson() async throws {
        let (host, _, clock, records, conversation) = try await stopped()
        var shown = await resume(conversation)
        XCTAssertEqual(shown, .scheduled(at: DUE))
        XCTAssertEqual(records.get("agent")?.entry, "turn:1")
        XCTAssertEqual(records.get("agent")?.at, DUE)

        clock.advance(DUE - BEFORE - 1)
        await settle(conversation, host)
        XCTAssertEqual(written(host), ["person go"])

        clock.advance(1)
        await settle(conversation, host)
        XCTAssertEqual(written(host), ["person go", "after-limit 続けて"])
        shown = await resume(conversation)
        XCTAssertNil(shown)
        XCTAssertNil(records.get("agent")?.at)
        let entries = await conversation.reading().transcript.entries
        let users: [UserEntry] = entries.compactMap { $0.userEntry }
        XCTAssertEqual(users.map(\.text), ["go", "続けて"])
        XCTAssertEqual(users.map(\.origin), [.person, .afterLimit])
        await conversation.stop()
    }

    func testWritesTheWordsSettingsGive() async throws {
        let (host, _, clock, _, conversation) = try await stopped(
            LimitResumeSettings(enabled: true, message: "Please continue"))
        clock.advance(DUE - BEFORE)
        await settle(conversation, host)
        XCTAssertEqual(written(host).last, "after-limit Please continue")
        await conversation.stop()
    }

    func testIsCancelledByThePersonsCancelAndNothingIsWritten() async throws {
        let (host, _, clock, records, conversation) = try await stopped()
        try await conversation.cancelLimitResume()
        let shown = await resume(conversation)
        XCTAssertNil(shown)
        XCTAssertEqual(clock.pending, 0)
        XCTAssertNil(records.get("agent")?.at)
        clock.advance(DUE - BEFORE)
        await settle(conversation, host)
        XCTAssertEqual(written(host), ["person go"])
        await conversation.stop()
    }

    func testIsCancelledByThePersonsOwnWords() async throws {
        let (host, _, clock, _, conversation) = try await stopped()
        try await conversation.submit("never mind", images: [])
        await settle(conversation, host)
        let shown = await resume(conversation)
        XCTAssertNil(shown)
        XCTAssertEqual(clock.pending, 0)
        clock.advance(DUE - BEFORE)
        await settle(conversation, host)
        XCTAssertEqual(written(host), ["person go", "person never mind"])
        await conversation.stop()
    }

    func testIsCancelledByATurnTheAgentStartsOnItsOwn() async throws {
        let (host, _, clock, _, conversation) = try await stopped()
        host.print(
            json([
                "type": "assistant",
                "message": [
                    "id": "msg_own", "role": "assistant",
                    "content": [["type": "text", "text": "A background task finished."]],
                ],
                "parent_tool_use_id": nil, "session_id": "s-1",
            ]))
        await settle(conversation, host)
        let shown = await resume(conversation)
        XCTAssertNil(shown)
        XCTAssertEqual(clock.pending, 0)
        clock.advance(DUE - BEFORE)
        await settle(conversation, host)
        XCTAssertEqual(written(host), ["person go"])
        await conversation.stop()
    }

    func testStopsTimingWhenTheConversationIsNoLongerFollowedAndKeepsWhatItDecided() async throws {
        let (_, _, clock, records, conversation) = try await stopped()
        await conversation.stop()
        XCTAssertEqual(clock.pending, 0)
        XCTAssertEqual(records.get("agent")?.at, DUE)
    }

    func testSurvivesARestartOfDevHubAtTheSameTime() async throws {
        let (host, _, _, records, conversation) = try await stopped()
        await conversation.stop()

        let clock = TurnedClock(BEFORE + 60_000)
        let again = try await following(host, clock, records)
        let shown = await resume(again)
        XCTAssertEqual(shown, .scheduled(at: DUE))
        clock.advance(DUE - BEFORE - 60_000)
        await settle(again, host)
        XCTAssertEqual(written(host), ["person go", "after-limit 続けて"])
        await again.stop()
    }

    func testIsWrittenSoonAfterARestartOfDevHubWhenItsTimePassedMeanwhileOnce() async throws {
        let (host, _, _, records, conversation) = try await stopped()
        await conversation.stop()

        let late = DUE + 3_600_000
        let clock = TurnedClock(late)
        let again = try await following(host, clock, records)
        var shown = await resume(again)
        XCTAssertEqual(shown, .scheduled(at: late + SOONEST_MS))
        clock.advance(SOONEST_MS)
        await settle(again, host)
        XCTAssertEqual(written(host), ["person go", "after-limit 続けて"])
        await again.stop()

        let third = try await following(host, TurnedClock(late + 60_000), records)
        shown = await resume(third)
        XCTAssertNil(shown)
        await third.stop()
    }

    func testStaysCancelledAcrossARestartOfDevHub() async throws {
        let (host, _, _, records, conversation) = try await stopped()
        try await conversation.cancelLimitResume()
        await conversation.stop()
        let clock = TurnedClock(BEFORE)
        let again = try await following(host, clock, records)
        let shown = await resume(again)
        XCTAssertNil(shown)
        XCTAssertEqual(clock.pending, 0)
        await again.stop()
    }

    func testIsNotResumedForAnEarlierStopTheReplayPassesOnItsWay() async throws {
        let (host, _, clock, records, conversation) = try await stopped()
        try await conversation.submit("try again", images: [])
        await settle(conversation, host)
        printLimit(host, RESETS + 3600)
        await settle(conversation, host)
        let second = (RESETS + 3600) * 1000 + RESET_MARGIN_MS
        var shown = await resume(conversation)
        XCTAssertEqual(shown, .scheduled(at: second))
        await conversation.stop()

        let restarted = TurnedClock(clock.now())
        let again = try await following(host, restarted, records)
        shown = await resume(again)
        XCTAssertEqual(shown, .scheduled(at: second))
        XCTAssertEqual(restarted.pending, 1)
        restarted.advance(second - restarted.now())
        await settle(again, host)
        XCTAssertEqual(written(host), ["person go", "person try again", "after-limit 続けて"])
        await again.stop()
    }

    func testSaysSoAndWritesNothingWhenTheCliDidNotSayWhenTheLimitResets() async throws {
        let (host, _, clock, _, conversation) = try await stopped(RESUME_ON, resetsAt: nil)
        var shown = await resume(conversation)
        XCTAssertEqual(shown, .unscheduled(reason: "the CLI did not say when the limit resets"))
        XCTAssertEqual(clock.pending, 0)
        try await conversation.cancelLimitResume()
        shown = await resume(conversation)
        XCTAssertNil(shown)
        clock.advance(DUE - BEFORE)
        await settle(conversation, host)
        XCTAssertEqual(written(host), ["person go"])
        await conversation.stop()
    }

    func testDoesNothingWhenSettingsTurnItOff() async throws {
        let (_, _, clock, _, conversation) = try await stopped(RESUME_OFF)
        let shown = await resume(conversation)
        XCTAssertNil(shown)
        XCTAssertEqual(clock.pending, 0)
        await conversation.stop()
    }

    func testSaysWhyWhenTheMessageCouldNotBeWrittenAndDoesNotTryAgain() async throws {
        let (host, _, clock, records, conversation) = try await stopped()
        host.refuseWrite = true
        clock.advance(DUE - BEFORE)
        await settle(conversation, host)
        var shown = await resume(conversation)
        XCTAssertEqual(shown, .failed(failure: "the fake host has ended"))
        XCTAssertNil(records.get("agent")?.at)
        XCTAssertEqual(clock.pending, 0)
        clock.advance(3_600_000)
        await settle(conversation, host)
        XCTAssertEqual(written(host), ["person go"])
        try await conversation.cancelLimitResume()
        shown = await resume(conversation)
        XCTAssertNil(shown)
        await conversation.stop()
    }
}

final class AgentConversationSleepTests: XCTestCase {
    private let KEEP = CacheKeepSettings(enabled: true, leadSeconds: 60, minTokens: 20_000)
    /// A response that wrote 30,000 tokens to the 5-minute cache.
    private let WARM: JsonValue = [
        "input_tokens": 10, "cache_creation_input_tokens": 30_000, "cache_read_input_tokens": 0, "output_tokens": 10,
        "cache_creation": ["ephemeral_5m_input_tokens": 30_000, "ephemeral_1h_input_tokens": 0],
    ]

    /// One DevHub's conversation on `host`, keeping the cache on `clock`.
    private func following(_ host: FakeHost, _ clock: TurnedClock) async throws -> AgentConversation {
        let keep = KEEP
        let conversation = conversationOn(
            host, boot: "boot", cacheKeeping: CacheKeeping(settings: { keep }, clock: clock))
        try await conversation.start()
        await settle(conversation, host)
        return conversation
    }

    /// A conversation of one turn whose cache is warm, the clock up to its compaction.
    private func warm() async throws -> (
        host: FakeHost, cli: AnsweringCli, conversation: AgentConversation, compact: () async -> Void
    ) {
        let host = FakeHost()
        let cli = AnsweringCli(host)
        cli.usage = WARM
        let clock = TurnedClock(Date().timeIntervalSince1970 * 1000)
        let conversation = try await following(host, clock)
        try await conversation.submit("first", images: [])
        await settle(conversation, host)
        let compact = {
            clock.advance(241_000)
            await settle(conversation, host)
        }
        return (host, cli, conversation, compact)
    }

    private func said(_ host: FakeHost) -> [String] {
        host.inLog.compactMap { record in
            guard let sent = (try? JsonValue.parse(record.line))?.objectValue, sent["type"] == "user" else { return nil }
            return sent["message"]?.objectValue?["content"]?.stringValue
        }
    }

    func testStopsTheCliOnceTheCompactionEndsAndStartsItAgainOnTheSameSessionForTheNextMessage() async throws {
        let (host, _, conversation, compact) = try await warm()
        await compact()
        XCTAssertEqual(said(host), ["first", "/compact"])
        XCTAssertEqual(host.sleeps, [[SLEEP_MARK]])
        XCTAssertEqual(host.restarts, [])
        try await conversation.submit("again", images: [])
        await settle(conversation, host)
        XCTAssertEqual(host.restarts, [FakeHost.Restart(args: ["--resume", "s-1"], mark: [RESTART_MARK])])
        XCTAssertEqual(said(host), ["first", "/compact", "again"])
        let transcript = await conversation.reading().transcript
        XCTAssertEqual(transcript.session.sessionId, "s-1")
        XCTAssertEqual(transcript.state, .ready(turn: .none))
        await conversation.stop()
    }

    func testIsAsleepForADevHubThatAttachesAgainWhichStartsItAgainForACommand() async throws {
        let (host, _, conversation, compact) = try await warm()
        await compact()
        await conversation.stop()
        let again = try await following(host, TurnedClock(Date().timeIntervalSince1970 * 1000))
        XCTAssertEqual(host.restarts, [])
        try await again.command(.send(text: "later", images: [], origin: .person))
        await settle(again, host)
        XCTAssertEqual(host.restarts.count, 1)
        XCTAssertEqual(said(host), ["first", "/compact", "later"])
        await again.stop()
    }

    func testKeepsTheCliUpWhenAMessageCameInDuringTheCompaction() async throws {
        let (host, cli, conversation, compact) = try await warm()
        cli.hold = true
        await compact()
        try await conversation.submit("meanwhile", images: [])
        cli.hold = false
        endTurn(host)
        await settle(conversation, host)
        XCTAssertEqual(said(host), ["first", "/compact", "meanwhile"])
        XCTAssertEqual(host.sleeps, [])
        await conversation.stop()
    }

    func testKeepsTheCliUpWhileAnMcpSignInRuns() async throws {
        let (host, _, conversation, compact) = try await warm()
        try await conversation.showSignIn(
            McpSignIn(server: "docs", phase: .running, output: "", callback: nil, failure: nil))
        await compact()
        XCTAssertEqual(said(host), ["first", "/compact"])
        XCTAssertEqual(host.sleeps, [])
        await conversation.stop()
    }
}

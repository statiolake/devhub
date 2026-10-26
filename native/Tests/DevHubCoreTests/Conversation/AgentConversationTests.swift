// Port of apps/desktop/src/main/agent/conversation/conversation.test.ts (first half)
//
// One conversation, followed live and attached again after a restart.
//
// The host here is a fake with the real contract's shape — a journal that
// grows, an `in.log` that records the offset each write followed — and a
// scripted CLI behind it that prints the permission fixture's lines one
// exchange at a time, checking each line DevHub writes against the one the
// fixture recorded. The adapter is the real Claude adapter.

import Foundation
import XCTest
@testable import DevHubCore

/// Every event the conversation published, in order.
final class Recording: @unchecked Sendable {
    private let lock = NSLock()
    private var _events: [(revision: Int, event: ConversationEvent)] = []
    var events: [(revision: Int, event: ConversationEvent)] { lock.withLock { _events } }
    var publish: ConversationPublish { { [self] revision, event in lock.withLock { _events.append((revision, event)) } } }
}

func conversationOn(
    _ host: any ConversationHost, boot: String = "boot-a", publish: @escaping ConversationPublish = { _, _ in },
    limits: LimitResumeOptions = resumeOff(), cacheKeeping: CacheKeeping = .off
) -> AgentConversation {
    AgentConversation(
        host: host, adapter: ClaudeAdapter(bootId: boot), publish: publish, limits: limits, cacheKeeping: cacheKeeping)
}

func entryIds(_ conversation: AgentConversation) async -> [String] {
    await conversation.reading().transcript.entries.map(\.id.raw)
}

func said(_ conversation: AgentConversation) async -> [String] {
    await conversation.reading().transcript.entries.compactMap { $0.userEntry?.text }
}

func pendingTexts(_ conversation: AgentConversation) async -> [String] {
    await conversation.reading().transcript.pending.map(\.text)
}

let SEND_PWD = ConversationCommand.send(text: "Run pwd with Bash", images: [], origin: .person)

final class AgentConversationTests: XCTestCase {
    /// The permission fixture, lived through: greeted, asked, allowed.
    func liveTurn() async throws -> (host: FakeHost, conversation: AgentConversation, recording: Recording) {
        let host = FakeHost()
        let cli = ScriptedCli(host)
        let recording = Recording()
        let conversation = conversationOn(host, publish: recording.publish)
        try await conversation.start()
        await settle(conversation, host)
        try await conversation.command(SEND_PWD)
        await settle(conversation, host)
        let requests = await conversation.reading().transcript.requests.map(\.id)
        XCTAssertEqual(requests, ["perm-1"])
        try await conversation.command(.answer(request: "perm-1", answer: .choice(choiceId: "allow", text: nil)))
        await settle(conversation, host)
        XCTAssertEqual(cli.remaining, 0)
        return (host, conversation, recording)
    }

    // MARK: a conversation followed live

    func testGreetsTheCliTakesItsLinesAndDevHubsInTheirOrderAndEndsIdle() async throws {
        let (host, conversation, _) = try await liveTurn()
        let reading = await conversation.reading()
        XCTAssertNil(reading.lost)
        XCTAssertEqual(reading.transcript.state, .ready(turn: .none))
        XCTAssertEqual(reading.transcript.requests, [])
        XCTAssertEqual(
            reading.transcript.entries.map(\.id.raw),
            ["user:00000000-0000-4000-8000-0000000000a1", "assistant:msg_01:0", "tool:toolu_01", "assistant:msg_02:0", "turn:1"])
        // Each write names how far into the journal the conversation was.
        let after = { (text: String) in host.journal.first { $0.line.contains(text) }!.offset }
        XCTAssertEqual(
            host.inLog.map(\.afterOffset),
            [0, after(#""commands""#), after(#""subtype":"init""#), after("can_use_tool"), after(#""type":"result""#)])
        await conversation.stop()
    }

    func testPublishesEveryEventNumberedAndTheyFoldToTheTranscriptItHolds() async throws {
        let (_, conversation, recording) = try await liveTurn()
        let events = recording.events
        XCTAssertEqual(events.map(\.revision), Array(1...events.count))
        let folded = try applyEvents(EMPTY_TRANSCRIPT, events.map(\.event))
        let snapshot = await conversation.snapshot()
        XCTAssertEqual(folded, snapshot.transcript)
        XCTAssertEqual(snapshot.revision, events.count)
        await conversation.stop()
    }

    // MARK: a conversation attached again after DevHub restarts

    func testReplaysToTheTranscriptTheLiveConversationHadWithoutGreetingTheCliAgain() async throws {
        let (host, conversation, _) = try await liveTurn()
        let live = await conversation.reading().transcript
        await conversation.stop()
        let writes = host.inLog.count

        let again = conversationOn(host, boot: "boot-b")
        try await again.start()
        await settle(again, host)
        let replayed = await again.reading().transcript
        XCTAssertEqual(replayed, live)
        XCTAssertEqual(host.inLog.count, writes)
        await again.stop()
    }

    func testReplaysARequestAsStillOpenWhenDevHubHadNotAnsweredIt() async throws {
        let host = FakeHost()
        _ = ScriptedCli(host)
        let conversation = conversationOn(host)
        try await conversation.start()
        await settle(conversation, host)
        try await conversation.command(SEND_PWD)
        await settle(conversation, host)
        await conversation.stop()

        let again = conversationOn(host, boot: "boot-b")
        try await again.start()
        await settle(again, host)
        let requests = await again.reading().transcript.requests.map(\.id)
        XCTAssertEqual(requests, ["perm-1"])
        await again.stop()
    }

    // MARK: a command

    func testACommandThatCouldNotBeWrittenIsRefusedAndLeavesNoTrace() async throws {
        let host = FakeHost()
        _ = ScriptedCli(host)
        let conversation = conversationOn(host)
        try await conversation.start()
        await settle(conversation, host)
        let before = await conversation.snapshot()
        host.refuseWrite = true
        do {
            try await conversation.command(SEND_PWD)
            XCTFail("it was written")
        } catch {
            XCTAssertTrue(error is HostLinkFailure, "\(error)")
        }
        let after = await conversation.snapshot()
        XCTAssertEqual(after, before)
        await conversation.stop()
    }

    // MARK: a setting chosen

    func testASettingWritesTheLinesThatSetItAndTakesThemBackAsSentSoTheClisAnswerIsExpected() async throws {
        let host = FakeHost()
        let conversation = conversationOn(host)
        try await conversation.start()
        await settle(conversation, host)
        try await conversation.configure(.model, "opus")
        XCTAssertEqual(
            try JsonValue.parse(host.inLog.last!.line),
            [
                "type": "control_request", "request_id": "boot-a:2",
                "request": ["subtype": "set_model", "model": "opus"],
            ])
        host.print(json(["type": "control_response", "response": ["subtype": "success", "request_id": "boot-a:2"]]))
        await settle(conversation, host)
        let model = await conversation.reading().transcript.session.model.current
        XCTAssertEqual(model, "opus")
        await conversation.stop()
    }

    // MARK: a line printed while DevHub's write is still in flight

    func testALinePrintedWhileAWriteIsInFlightIsFedOnlyAfterThatWriteWasTakenBackAsSent() async throws {
        let host = FakeHost()
        let conversation = conversationOn(host)
        try await conversation.start()
        await settle(conversation, host)
        // The CLI answers inside the write, before the write has returned: the
        // journal has the answer before the caller could have called `sent`.
        host.slowWrites = true
        host.onWrite = { line in
            let requestId = (try? JsonValue.parse(line))?.objectValue?["request_id"] ?? nil
            host.print(json(["type": "control_response", "response": ["subtype": "success", "request_id": requestId]]))
        }
        try await conversation.configure(.mode, "plan")
        await settle(conversation, host)
        let transcript = await conversation.reading().transcript
        XCTAssertNotEqual(transcript.state.phase, "broken")
        XCTAssertEqual(transcript.session.mode.current, "plan")
        await conversation.stop()
    }

    // MARK: a line the adapter cannot read

    func testALineTheAdapterCannotReadBreaksTheConversationShownAndNoFurtherInputTaken() async throws {
        let host = FakeHost()
        let recording = Recording()
        let conversation = conversationOn(host, publish: recording.publish)
        try await conversation.start()
        await settle(conversation, host)
        host.print(#"{"type":"assistant","message":{"id":"m","content":"not an array"}}"#)
        await settle(conversation, host)
        let state = await conversation.reading().transcript.state
        XCTAssertEqual(
            state,
            .broken(ConversationFailure(code: .protocolMismatch, detail: "assistant.message.content: expected an array")))
        XCTAssertEqual(recording.events.last?.event, .state(state))
        let refusal = await drawnAs { try await conversation.command(.interrupt) }
        XCTAssertEqual(refusal?.kind, .stopped)
        XCTAssertTrue(refusal?.reason.contains("stopped taking input: assistant.message.content") ?? false)
        await conversation.stop()
    }

    // MARK: a journal stream that is lost

    func testALostStreamIsReadAsLostAndAttachingAgainContinuesFromWhereItStopped() async throws {
        let host = FakeHost()
        let conversation = conversationOn(host)
        host.failAfter = 1
        host.print(json(["type": "system", "subtype": "init", "session_id": "s", "cwd": "/w", "model": "m"]))
        host.print(json(["type": "hologram"]))
        try await conversation.start()
        await settle(conversation, host)
        var reading = await conversation.reading()
        XCTAssertEqual(reading.lost?.code, .streamLost)
        XCTAssertEqual(reading.transcript.session.sessionId, "s")
        XCTAssertEqual(reading.transcript.entries, [])

        await conversation.reattach()
        await settle(conversation, host)
        reading = await conversation.reading()
        XCTAssertNil(reading.lost)
        // The second line, once — neither lost nor repeated.
        XCTAssertEqual(reading.transcript.entries.map(\.kind), ["notice"])
        await conversation.stop()
    }

    // MARK: a host that could not be opened

    struct NoHome: Error, CustomStringConvertible {
        var description: String { "the machine has no home" }
    }

    func testAHostThatCouldNotBeOpenedIsThisAgentsFailureReadFromItsConversation() async throws {
        let conversation = conversationOn(openedLater { throw NoHome() })
        try await conversation.start()
        await settle(conversation)
        let crashed = await conversation.reading().crashed
        XCTAssertEqual(crashed.map { "\($0)" }, "the machine has no home")
        await conversation.stop()
    }

    func testAHostIsOpenedOnceByTheFirstThingThatNeedsIt() async throws {
        let host = FakeHost()
        let opened = Guarded(0)
        let conversation = conversationOn(
            openedLater {
                opened.with { $0 += 1 }
                return host
            })
        try await conversation.start()
        await settle(conversation, host)
        host.print(json(["type": "hologram"]))
        await settle(conversation, host)
        XCTAssertEqual(opened.with { $0 }, 1)
        let entries = await conversation.reading().transcript.entries
        XCTAssertEqual(entries.count, 1)
        await conversation.stop()
    }

    // MARK: a failure that is neither the host's nor the protocol's

    struct OwnBug: Error, CustomStringConvertible {
        var description: String { "a bug of DevHub's own" }
    }

    func testAFailureNeitherTheHostsNorTheProtocolsStopsTheConversationAndIsReadAsThisAgentsFailure() async throws {
        let host = FakeHost()
        host.sentLogFailure = OwnBug()
        let conversation = conversationOn(host)
        try await conversation.start()
        await settle(conversation, host)
        let reading = await conversation.reading()
        XCTAssertTrue(reading.crashed is OwnBug)
        // It does not start again on its own, and it takes no input.
        await conversation.reattach()
        do {
            try await conversation.command(.interrupt)
            XCTFail("it took the command")
        } catch {
            XCTAssertEqual("\(error)", "a bug of DevHub's own")
        }
        await conversation.stop()
    }

    // MARK: a reply the protocol demands

    let HOOK = json(["type": "control_request", "request_id": "c1", "request": ["subtype": "hook_callback"]])

    func testADemandedReplyIsNotWrittenAgainWhenTheLineThatDemandedItIsReplayed() async throws {
        let host = FakeHost()
        let live = conversationOn(host)
        try await live.start()
        await settle(live, host)
        host.print(HOOK)
        await settle(live, host)
        await live.stop()
        let written = host.inLog.count

        let again = conversationOn(host, boot: "boot-b")
        try await again.start()
        await settle(again, host)
        XCTAssertEqual(host.inLog.count, written)
        await again.stop()
    }

    func testADemandedReplyIsWrittenWhenDevHubStoppedBeforeItAnswered() async throws {
        let host = FakeHost()
        let live = conversationOn(host)
        try await live.start()
        await settle(live, host)
        await live.stop()
        // Printed while no DevHub was following: nobody has answered it yet.
        host.print(json(["type": "control_request", "request_id": "c2", "request": ["subtype": "hook_callback"]]))

        let again = conversationOn(host, boot: "boot-b")
        try await again.start()
        await settle(again, host)
        let response = try JsonValue.parse(host.inLog.last!.line).objectValue?["response"]?.objectValue
        XCTAssertEqual(response?["subtype"], "error")
        XCTAssertEqual(response?["request_id"], "c2")
        await again.stop()
    }

    func testADemandedReplyIsWrittenAtOnce() async throws {
        let host = FakeHost()
        let conversation = conversationOn(host)
        try await conversation.start()
        await settle(conversation, host)
        host.print(HOOK)
        await settle(conversation, host)
        let reply = try JsonValue.parse(host.inLog.last!.line).objectValue
        XCTAssertEqual(reply?["type"], "control_response")
        XCTAssertEqual(reply?["response"]?.objectValue?["subtype"], "error")
        XCTAssertEqual(reply?["response"]?.objectValue?["request_id"], "c1")
        await conversation.stop()
    }

    func testStartingTwiceIsRefused() async throws {
        let host = FakeHost()
        let conversation = conversationOn(host)
        try await conversation.start()
        do {
            try await conversation.start()
            XCTFail("it started twice")
        } catch {
            XCTAssertTrue(error is ConversationMisuse)
        }
        await conversation.stop()
    }
}

/// `turns`: a conversation with an answering CLI, the person having said each of `texts`.
func turns(_ texts: [String], version: String = "2.1.282") async throws -> (
    host: FakeHost, conversation: AgentConversation, cli: AnsweringCli
) {
    let host = FakeHost()
    let cli = AnsweringCli(host, version: version)
    let conversation = conversationOn(host)
    try await conversation.start()
    await settle(conversation, host)
    for text in texts {
        try await conversation.submit(text, images: [])
        await settle(conversation, host)
    }
    return (host, conversation, cli)
}

final class AgentConversationRewindTests: XCTestCase {
    func testGoesBackToBeforeAnEarlierMessageAndReplaysToTheSameAfterARestartOfDevHub() async throws {
        let (host, conversation, _) = try await turns(["first", "second", "third"])
        let targets = await rewindTargets(conversation.reading().transcript)
        XCTAssertEqual(targets, ["user:u1", "user:u2", "user:u3"])

        let outcome = try await conversation.rewind("user:u2")
        XCTAssertEqual(outcome, .rewound)
        await settle(conversation, host)
        XCTAssertEqual(
            host.restarts,
            [
                FakeHost.Restart(
                    args: ["--resume", "s-1", "--resume-session-at", "a1"],
                    mark: [json(["type": "devhub_rewind", "message": "user:u2"])])
            ])
        var ids = await entryIds(conversation)
        XCTAssertEqual(ids, ["user:u1", "assistant:msg_1:0", "turn:1"])
        try await conversation.submit("second, better", images: [])
        await settle(conversation, host)
        ids = await entryIds(conversation)
        XCTAssertEqual(ids, ["user:u1", "assistant:msg_1:0", "turn:1", "user:u4", "assistant:msg_4:0", "turn:4"])
        let live = await conversation.reading().transcript
        await conversation.stop()

        let writes = host.inLog.count
        let again = conversationOn(host, boot: "boot-b")
        try await again.start()
        await settle(again, host)
        let replayed = await again.reading().transcript
        XCTAssertEqual(replayed, live)
        XCTAssertEqual(host.inLog.count, writes)
        await again.stop()
    }

    func testRefusesWhileATurnRunsSayingToStopItFirstAndWritesNothing() async throws {
        let (host, conversation, cli) = try await turns(["first", "second"])
        cli.hold = true
        try await conversation.submit("third", images: [])
        await settle(conversation, host)
        let writes = host.inLog.count
        let refusal = await drawnAs { _ = try await conversation.rewind("user:u1") }
        XCTAssertEqual(refusal?.kind, .refused)
        XCTAssertTrue(refusal?.reason.contains("Stop it before rewinding.") ?? false)
        XCTAssertEqual(host.inLog.count, writes)
        XCTAssertEqual(host.restarts, [])
        await conversation.stop()
    }

    func testRefusesWhenTheCliCannotTakeTurnsBack() async throws {
        let (host, conversation, _) = try await turns(["first", "second"], version: "2.1.0")
        let refusal = await drawnAs { _ = try await conversation.rewind("user:u2") }
        XCTAssertEqual(refusal?.kind, .refused)
        XCTAssertTrue(refusal?.reason.contains("This Agent's CLI cannot take turns back") ?? false)
        XCTAssertEqual(host.restarts, [])
        await conversation.stop()
    }

    func testRefusesWhileMessagesOfThePersonsAreHeld() async throws {
        let (host, conversation, cli) = try await turns(["first"])
        cli.hold = true
        try await conversation.submit("second", images: [])
        await settle(conversation, host)
        try await conversation.submit("held", images: [])
        // Its write fails as the turn ends: idle, with a message held.
        host.refuseWrite = true
        endTurn(host)
        await settle(conversation, host)
        let pending = await conversation.reading().transcript.pending
        XCTAssertEqual(pending.count, 1)
        let refusal = await drawnAs { _ = try await conversation.rewind("user:u1") }
        XCTAssertEqual(refusal?.kind, .refused)
        XCTAssertTrue(refusal?.reason.contains("Send or remove them before rewinding.") ?? false)
        await conversation.stop()
    }

    func testIsTheRewindsFailureWhenTheHostDoesNotStartTheCliAgainAndLeavesTheConversationUsable() async throws {
        let (host, conversation, _) = try await turns(["first", "second"])
        host.refuseRestart = true
        do {
            _ = try await conversation.rewind("user:u2")
            XCTFail("it rewound")
        } catch {
            XCTAssertEqual("\(error)", "the fake host did not start its CLI again")
        }
        var ids = await entryIds(conversation)
        XCTAssertTrue(ids.contains("user:u2"))
        try await conversation.submit("third", images: [])
        await settle(conversation, host)
        ids = await entryIds(conversation)
        XCTAssertTrue(ids.contains("user:u3"))
        await conversation.stop()
    }

    func testHoldsThePersonsWordsWhileTheCliIsStartedAgainAndRefusesEveryOtherInput() async throws {
        let (host, conversation, _) = try await turns(["first", "second"])
        // The host takes the restart, but no new CLI answers yet.
        let answer = host.onWrite
        host.onWrite = { _ in }
        let rewind = Task { try await conversation.rewind("user:u2") }
        await settle(conversation, host)
        let refusal = await drawnAs { try await conversation.command(.interrupt) }
        XCTAssertEqual(refusal?.kind, .refused)
        XCTAssertTrue(refusal?.reason.contains("The conversation is being taken back.") ?? false)
        try await conversation.submit("meanwhile", images: [])
        let held = await pendingTexts(conversation)
        XCTAssertEqual(held, ["meanwhile"])
        // The new CLI answers the greeting it was sent: the rewind is over, and
        // the held message is written.
        host.onWrite = answer
        answer(host.inLog.last!.line)
        let outcome = try await rewind.value
        XCTAssertEqual(outcome, .rewound)
        await settle(conversation, host)
        let pending = await conversation.reading().transcript.pending
        XCTAssertEqual(pending, [])
        let words = await said(conversation)
        XCTAssertEqual(words, ["first", "meanwhile"])
        await conversation.stop()
    }

    func testRejectsWhenTheConversationStopsBeforeTheCliHasTakenTheTurnsBack() async throws {
        let (host, conversation, _) = try await turns(["first", "second"])
        host.onWrite = { _ in }
        let rewind = Task { try await conversation.rewind("user:u2") }
        await settle(conversation, host)
        await conversation.stop()
        let refusal = await drawnAs(rewind)
        XCTAssertEqual(refusal?.kind, .stopped)
        XCTAssertEqual(refusal?.reason, "The conversation stopped before the CLI had taken the turns back.")
    }

    // MARK: restarting a conversation its CLI stopped

    func testStartsTheCliAgainOnTheSameSessionOnceItWasSignedOutAndTakesInputAgain() async throws {
        let (host, conversation, _) = try await turns(["first"])
        host.print(
            json([
                "type": "assistant",
                "message": [
                    "id": "msg_auth", "role": "assistant",
                    "content": [["type": "text", "text": "Invalid API key · Please run /login"]],
                ],
                "parent_tool_use_id": nil, "session_id": "s-1", "error": "authentication_failed",
            ]))
        endTurn(host)
        await settle(conversation, host)
        var state = await conversation.reading().transcript.state
        guard case .broken(let failure) = state else { return XCTFail("\(state)") }
        XCTAssertEqual(failure.code, .notSignedIn)
        try await conversation.restart()
        await settle(conversation, host)
        XCTAssertEqual(host.restarts, [FakeHost.Restart(args: ["--resume", "s-1"], mark: [RESTART_MARK])])
        state = await conversation.reading().transcript.state
        XCTAssertEqual(state, .ready(turn: .none))
        try await conversation.submit("again", images: [])
        await settle(conversation, host)
        let words = await said(conversation)
        XCTAssertEqual(words, ["first", "again"])
        await conversation.stop()
    }

    func testARestartIsRefusedSayingWhyOnceDevHubStoppedReadingTheJournal() async throws {
        let (host, conversation, _) = try await turns(["first"])
        host.print(#"{"type":"assistant","message":{"id":"m","content":"not an array"}}"#)
        await settle(conversation, host)
        let refusal = await drawnAs { try await conversation.restart() }
        XCTAssertEqual(refusal?.kind, .stopped)
        XCTAssertTrue(
            refusal?.reason.contains("cannot follow a CLI started again: assistant.message.content") ?? false,
            refusal?.reason ?? "")
        XCTAssertEqual(host.restarts, [])
        await conversation.stop()
    }

    // MARK: going on with another session

    func testGoingOnWithAnotherSessionRefusesWhileATurnRuns() async throws {
        let (host, conversation, cli) = try await turns(["first"])
        cli.hold = true
        try await conversation.submit("second", images: [])
        await settle(conversation, host)
        let refusal = await drawnAs { try await conversation.resumeSession("s-other", history: []) }
        XCTAssertEqual(refusal?.kind, .refused)
        XCTAssertTrue(refusal?.reason.contains("Stop it before going on with another session.") ?? false)
        XCTAssertEqual(host.restarts, [])
        await conversation.stop()
    }

    func testGoingOnWithAnotherSessionRejectsAsStoppedWhenItStopsBeforeTheCliIsOnTheOtherSession() async throws {
        let (host, conversation, _) = try await turns(["first"])
        host.onWrite = { _ in }
        let resumed = Task { try await conversation.resumeSession("s-other", history: []) }
        await settle(conversation, host)
        await conversation.stop()
        let refusal = await drawnAs(resumed)
        XCTAssertEqual(refusal?.kind, .stopped)
        XCTAssertTrue(
            refusal?.reason.contains("The conversation stopped before it went on with session s-other") ?? false)
    }
}

final class AgentConversationHeldTests: XCTestCase {
    func testAreWrittenOnePerTurnAsEachTurnEndsAsThePersonLeftThem() async throws {
        let (host, conversation, cli) = try await turns(["first"])
        cli.hold = true
        try await conversation.submit("second", images: [])
        await settle(conversation, host)
        let writes = host.inLog.count
        try await conversation.submit("third", images: [])
        try await conversation.submit("fourth", images: [])
        try await conversation.submit("fifth", images: [])
        XCTAssertEqual(host.inLog.count, writes)
        var pending = await pendingTexts(conversation)
        XCTAssertEqual(pending, ["third", "fourth", "fifth"])

        let held = await conversation.reading().transcript.pending
        try await conversation.editPending(held[0].id, text: "third, reworded")
        try await conversation.removePending(held[1].id)
        pending = await pendingTexts(conversation)
        XCTAssertEqual(pending, ["third, reworded", "fifth"])

        endTurn(host)
        await settle(conversation, host)
        var words = await said(conversation)
        XCTAssertEqual(words, ["first", "second", "third, reworded"])
        pending = await pendingTexts(conversation)
        XCTAssertEqual(pending, ["fifth"])
        endTurn(host)
        await settle(conversation, host)
        words = await said(conversation)
        XCTAssertEqual(words, ["first", "second", "third, reworded", "fifth"])
        pending = await pendingTexts(conversation)
        XCTAssertEqual(pending, [])
        await conversation.stop()
    }

    func testKeepTheImagesAttachedToThemThroughAChangeOfTheirWordsAndAreWrittenWithThem() async throws {
        let (host, conversation, cli) = try await turns(["first"])
        cli.hold = true
        try await conversation.submit("second", images: [])
        await settle(conversation, host)
        let image = ImageRef(mediaType: "image/png", source: .data(base64: "AAAA"), label: "shot.png")
        try await conversation.submit("look at this", images: [image])
        let held = await conversation.reading().transcript.pending[0]
        XCTAssertEqual(held.images, [image])
        try await conversation.editPending(held.id, text: "look at this one")
        let edited = await conversation.reading().transcript.pending[0]
        XCTAssertEqual(edited.images, [image])
        let writes = host.inLog.count
        endTurn(host)
        await settle(conversation, host)
        let written = try JsonValue.parse(host.inLog[writes].line)
        XCTAssertEqual(
            written.objectValue?["message"]?.objectValue?["content"],
            [
                ["type": "image", "source": ["type": "base64", "media_type": "image/png", "data": "AAAA"]],
                ["type": "text", "text": "look at this one"],
            ])
        await conversation.stop()
    }

    func testIsWrittenIntoTheRunningTurnWhenThePersonSaysNow() async throws {
        let (host, conversation, cli) = try await turns(["first"])
        cli.hold = true
        try await conversation.submit("second", images: [])
        await settle(conversation, host)
        try await conversation.submit("steer this way", images: [])
        let held = await conversation.reading().transcript.pending[0]
        try await conversation.sendPendingNow(held.id)
        let last = try JsonValue.parse(host.inLog.last!.line).objectValue
        XCTAssertEqual(last?["type"], "user")
        XCTAssertEqual(last?["priority"], "next")
        XCTAssertEqual(last?["message"]?.objectValue?["content"], "steer this way")
        let pending = await pendingTexts(conversation)
        XCTAssertEqual(pending, [])
        await settle(conversation, host)
        let words = await said(conversation)
        XCTAssertTrue(words.contains("steer this way"))
        await conversation.stop()
    }

    func testStaysHeldSayingWhyWhenItsWriteFailsAndIsWrittenWhenThePersonTriesAgain() async throws {
        let (host, conversation, cli) = try await turns(["first"])
        cli.hold = true
        try await conversation.submit("second", images: [])
        await settle(conversation, host)
        try await conversation.submit("third", images: [])
        host.refuseWrite = true
        endTurn(host)
        await settle(conversation, host)
        let held = await conversation.reading().transcript.pending[0]
        XCTAssertEqual(held.text, "third")
        XCTAssertEqual(held.failure, "the fake host has ended")
        try await conversation.sendPendingNow(held.id)
        await settle(conversation, host)
        let pending = await pendingTexts(conversation)
        XCTAssertEqual(pending, [])
        let words = await said(conversation)
        XCTAssertTrue(words.contains("third"))
        await conversation.stop()
    }

    func testIsNotWrittenWhileThePersonEditsItAndIsWrittenAsSavedOnceTheyDo() async throws {
        let (host, conversation, cli) = try await turns(["first"])
        cli.hold = true
        try await conversation.submit("second", images: [])
        await settle(conversation, host)
        try await conversation.submit("third", images: [])
        let third = await conversation.reading().transcript.pending[0]
        try await conversation.startEditingPending(third.id)
        let editing = await conversation.reading().transcript.pending[0].editing
        XCTAssertTrue(editing)
        let messages = { host.inLog.filter { (try? JsonValue.parse($0.line))?.objectValue?["type"] == "user" } }
        let writes = messages().count
        endTurn(host)
        await settle(conversation, host)
        XCTAssertEqual(messages().count, writes)
        var pending = await pendingTexts(conversation)
        XCTAssertEqual(pending, ["third"])
        let refusal = await drawnAs { try await conversation.sendPendingNow(third.id) }
        XCTAssertEqual(refusal?.kind, .refused)
        XCTAssertTrue(refusal?.reason.contains("being edited") ?? false)

        try await conversation.editPending(third.id, text: "third, reworded")
        await settle(conversation, host)
        let words = await said(conversation)
        XCTAssertEqual(words, ["first", "second", "third, reworded"])
        pending = await pendingTexts(conversation)
        XCTAssertEqual(pending, [])
        await conversation.stop()
    }

    func testIsWrittenUnchangedOnceThePersonGivesTheEditUpOrTheViewLetsGoOfIt() async throws {
        let (host, conversation, cli) = try await turns(["first"])
        cli.hold = true
        try await conversation.submit("second", images: [])
        await settle(conversation, host)
        try await conversation.submit("third", images: [])
        try await conversation.submit("fourth", images: [])
        let held = await conversation.reading().transcript.pending
        try await conversation.startEditingPending(held[0].id)
        try await conversation.startEditingPending(held[1].id)
        endTurn(host)
        await settle(conversation, host)
        var pending = await pendingTexts(conversation)
        XCTAssertEqual(pending, ["third", "fourth"])

        try await conversation.stopEditingPending(held[0].id)
        await settle(conversation, host)
        var words = await said(conversation)
        XCTAssertEqual(words, ["first", "second", "third"])
        endTurn(host)
        await settle(conversation, host)
        pending = await pendingTexts(conversation)
        XCTAssertEqual(pending, ["fourth"])

        await conversation.stopEditingAll()
        await settle(conversation, host)
        words = await said(conversation)
        XCTAssertEqual(words, ["first", "second", "third", "fourth"])
        await conversation.stop()
    }

    func testSaysAHeldMessageIsGoneWhenItWasAlreadyWritten() async throws {
        let (host, conversation, cli) = try await turns(["first"])
        cli.hold = true
        try await conversation.submit("second", images: [])
        await settle(conversation, host)
        try await conversation.submit("third", images: [])
        let held = await conversation.reading().transcript.pending[0]
        try await conversation.removePending(held.id)
        let refusal = await drawnAs { try await conversation.editPending(held.id, text: "x") }
        XCTAssertEqual(refusal?.kind, .refused)
        XCTAssertTrue(refusal?.reason.contains("That message is no longer waiting") ?? false)
        await conversation.stop()
    }
}

// Port of apps/desktop/src/main/agent/conversation/codex/adapter.test.ts (4/4):
// taking back the last turn, the captures, /resume, restarting the session,
// MCP results, images, the model list, the MCP servers, usage limits, and
// DevHub's own instructions.

import XCTest
@testable import DevHubCore

private func turn2(_ status: String, startedAt: String = "null", completedAt: String = "null", durationMs: String = "null")
    -> String
{
    #"{"id":"turn-2","items":[],"itemsView":"notLoaded","status":"\#(status)","error":null,"startedAt":\#(startedAt),"completedAt":\#(completedAt),"durationMs":\#(durationMs)}"#
}

final class CodexRewindTests: XCTestCase {
    /// A thread past one whole turn, "go", with both approvals accepted.
    func oneTurn() throws -> CodexHarness {
        let harness = try codexReady()
        try harness.send("go")
        for line in codexFixture("turn.handwritten.ndjson") {
            for event in try harness.receive(line).events {
                if case .requestOpened(let request) = event {
                    try harness.command(.answer(request: request.id, answer: .choice(choiceId: "accept", text: nil)))
                }
            }
        }
        return harness
    }

    let user = "\(CODEX_MAIN)/item-user"
    func reverted(_ id: Int = 6) -> String {
        #"{"id":\#(id),"result":{"thread":{"id":"\#(CODEX_MAIN)","turns":[]},"turnsBackwardsCursor":null,"itemsBackwardsCursor":null}}"#
    }

    func testIsOfferedOnAPaginatedThreadAndRevertsTheThreadToBeforeTheMessagesTurn() throws {
        let harness = try oneTurn()
        XCTAssertTrue(harness.transcript.session.canRewind)
        XCTAssertEqual(harness.transcript.state, .ready(turn: .none))
        try harness.rewind(user)
        XCTAssertEqual(
            harness.written.last, #"{"id":6,"method":"thread/revert","params":{"threadId":"\#(CODEX_MAIN)","beforeTurnId":"turn-1"}}"#)
        XCTAssertEqual(harness.transcript.state, .ready(turn: .rewinding))
        try harness.receive(#"{"method":"thread/reverted","params":{"threadId":"\#(CODEX_MAIN)"}}"#)
        try harness.receive(reverted())
        XCTAssertEqual(harness.transcript.entries, [])
        XCTAssertEqual(harness.transcript.state, .ready(turn: .none))
        // And the next message starts a turn on the reverted thread.
        try harness.send("go, differently")
        assertMatches(
            harness.lastWrite(),
            j(#"{"id":7,"method":"turn/start","params":{"threadId":"\#(CODEX_MAIN)","clientUserMessageId":"devhub-person-1"}}"#))
    }

    func testSaysSoWhenAppServerRefusesAndDropsNothing() throws {
        let harness = try oneTurn()
        let before = harness.transcript.entries
        try harness.rewind(user)
        try harness.receive(#"{"id":6,"error":{"code":-32600,"message":"thread/revert only supports paginated threads"}}"#)
        XCTAssertEqual(Array(harness.transcript.entries.prefix(before.count)), before)
        let notice = harness.transcript.entries.last?.noticeEntry
        XCTAssertEqual(notice?.level, .error)
        XCTAssertEqual(notice?.text, "codex 0.156.1 did not take back the last turn: thread/revert only supports paginated threads")
        XCTAssertEqual(harness.transcript.state, .ready(turn: .none))
    }

    func testIsNotOfferedOnALegacyThreadAndRefusedIfAsked() throws {
        let harness = CodexHarness()
        try harness.start()
        for line in codexFixture("handshake.handwritten.ndjson") {
            try harness.receive(line.replacingOccurrences(of: #""historyMode":"paginated""#, with: #""historyMode":"legacy""#))
        }
        XCTAssertFalse(harness.transcript.session.canRewind)
        try harness.send("go")
        try harness.receive(codexFixture("turn.handwritten.ndjson")[2])
        assertThrowsMatching("cannot take back a turn of this thread") { _ = try harness.adapter.rewind(EntryId(self.user)) }
    }

    func testRefusesAMessageThatIsNotARewindTarget() throws {
        let harness = try oneTurn()
        assertThrowsMatching("is not a message the conversation can be rewound to now") {
            _ = try harness.adapter.rewind(EntryId("\(CODEX_MAIN)/item-say"))
        }
    }

    func testRevertsToBeforeAnEarlierTurnAndEveryTurnFromItOnGoes() throws {
        let harness = try oneTurn()
        try harness.send("more")
        try harness.receive(#"{"id":6,"result":{"turn":\#(turn2("inProgress", startedAt: "1790000010"))}}"#)
        try harness.receive(
            #"{"method":"turn/started","params":{"threadId":"\#(CODEX_MAIN)","turn":\#(turn2("inProgress", startedAt: "1790000010"))}}"#)
        try harness.receive(
            #"{"method":"item/completed","params":{"threadId":"\#(CODEX_MAIN)","turnId":"turn-2","completedAtMs":0,"item":{"type":"userMessage","id":"item-more","clientId":"devhub-person-1","content":[{"type":"text","text":"more","text_elements":[]}]}}}"#
        )
        try harness.receive(
            #"{"method":"turn/completed","params":{"threadId":"\#(CODEX_MAIN)","turn":\#(turn2("completed", startedAt: "1790000010", completedAt: "1790000011"))}}"#
        )
        XCTAssertEqual(rewindTargets(harness.transcript), [EntryId(user), EntryId("\(CODEX_MAIN)/item-more")])
        try harness.rewind(user)
        XCTAssertEqual(
            harness.written.last, #"{"id":7,"method":"thread/revert","params":{"threadId":"\#(CODEX_MAIN)","beforeTurnId":"turn-1"}}"#)
        try harness.receive(reverted(7))
        XCTAssertEqual(harness.transcript.entries, [])
        XCTAssertEqual(harness.transcript.state, .ready(turn: .none))
    }

    func testShowsAMessageAsSendingFromItsWriteUntilItsItemComesBack() throws {
        let harness = try oneTurn()
        try harness.send("more")
        XCTAssertEqual(
            harness.transcript.sending, [SendingMessage(id: "devhub-person-1", text: "more", images: [], origin: .person)])
        try harness.receive(
            #"{"method":"item/completed","params":{"threadId":"\#(CODEX_MAIN)","turnId":"turn-2","completedAtMs":0,"item":{"type":"userMessage","id":"item-more","clientId":"devhub-person-1","content":[{"type":"text","text":"more","text_elements":[]}]}}}"#
        )
        XCTAssertEqual(harness.transcript.sending, [])
        XCTAssertEqual(harness.transcript.entries.last?.userEntry?.text, "more")
    }

    func testLetsGoOfASendingMessageWhoseTurnAppServerRefused() throws {
        let harness = try oneTurn()
        try harness.send("more")
        try harness.receive(#"{"id":6,"error":{"code":-32600,"message":"no"}}"#)
        XCTAssertEqual(harness.transcript.sending, [])
    }

    func testIsWorkingFromAMessagesWriteUntilTheEndOfItsTurnWhichAnswersItEvenWhenItsItemNeverCameBack() throws {
        let harness = try oneTurn()
        try harness.send("more")
        XCTAssertEqual(conversationStatus(harness.transcript), .working)
        try harness.receive(#"{"id":6,"result":{"turn":\#(turn2("inProgress"))}}"#)
        try harness.receive(#"{"method":"turn/started","params":{"threadId":"\#(CODEX_MAIN)","turn":\#(turn2("inProgress"))}}"#)
        try harness.receive(
            #"{"method":"turn/completed","params":{"threadId":"\#(CODEX_MAIN)","turn":\#(turn2("completed", durationMs: "3"))}}"#)
        XCTAssertEqual(harness.transcript.sending, [])
        XCTAssertEqual(conversationStatus(harness.transcript), .idle)
        XCTAssertEqual(
            harness.transcript.entries.suffix(2).map { each in
                each.userEntry.map { "user(\($0.origin.rawValue)): \($0.text)" } ?? each.kind
            },
            ["user(person): more", "turn-end"])
    }

    func testShowsTheConversationCompactingWhileItsContextCompactionItemRunsAndTheDividerOnceDone() throws {
        let harness = try oneTurn()
        try harness.send("more")
        try harness.receive(#"{"id":6,"result":{"turn":\#(turn2("inProgress"))}}"#)
        try harness.receive(#"{"method":"turn/started","params":{"threadId":"\#(CODEX_MAIN)","turn":\#(turn2("inProgress"))}}"#)
        func compaction(_ method: String) -> String {
            #"{"method":"\#(method)","params":{"threadId":"\#(CODEX_MAIN)","turnId":"turn-2","startedAtMs":0,"completedAtMs":0,"item":{"type":"contextCompaction","id":"item-compact"}}}"#
        }
        try harness.receive(compaction("item/started"))
        XCTAssertTrue(harness.transcript.compacting)
        XCTAssertNotEqual(harness.transcript.entries.last?.kind, "compaction")
        try harness.receive(compaction("item/completed"))
        XCTAssertFalse(harness.transcript.compacting)
        XCTAssertEqual(harness.transcript.entries.last?.compactionEntry?.id, EntryId("\(CODEX_MAIN)/item-compact"))
        XCTAssertEqual(conversationStatus(harness.transcript), .working)
    }

    func testReplaysToTheSameRewoundTranscriptAndWritesNothing() throws {
        let live = try oneTurn()
        try live.rewind(user)
        try live.receive(reverted())
        try live.send("again")
        let replayed = try CodexHarness.replaying(live)
        XCTAssertEqual(replayed.written, [])
        XCTAssertEqual(replayed.transcript, live.transcript)
    }
}

final class CodexCaptureTests: XCTestCase {
    func testASignedOutAppServerStopsNamingCodexAndItsVersion() throws {
        let transcript = try codexPlayed("signed-out.capture.ndjson").transcript
        XCTAssertEqual(transcript.session.agentVersion, "0.156.1")
        XCTAssertEqual(
            transcript.state,
            .broken(
                ConversationFailure(
                    code: .notSignedIn,
                    detail:
                        "codex 0.156.1 is not signed in. Sign in with `codex login` in a terminal on this Agent's machine, then try again."
                )))
        XCTAssertEqual(transcript.entries, [])
    }

    func testAGreetingPlaysToOneCompletedTurn() throws {
        let transcript = try codexPlayed("codex-greeting.capture.ndjson").transcript
        XCTAssertEqual(transcript.state, .ready(turn: .none))
        XCTAssertEqual(
            transcript.entries.map { entry -> String in
                switch entry {
                case .user(let user): return "user: \(user.text)"
                case .assistant(let assistant):
                    return "assistant: "
                        + assistant.blocks.map { block in
                            if case .text(let markdown) = block { return markdown }
                            if case .thinking = block { return "thinking" }
                            return "plan"
                        }.joined(separator: "|")
                case .turnEnd(let end): return "turn-end: \(end.outcome.rawValue)"
                default: return entry.kind
                }
            },
            ["user: Hello! Please reply with a one-line greeting.", "assistant: Hello! 👋", "turn-end: completed"])
    }

    func testKeepsAcrossAReplayTheSettingsTheTurnWasStartedWith() throws {
        let session = try codexPlayed("codex-greeting.capture.ndjson").transcript.session
        XCTAssertEqual(session.agentVersion, "0.156.1")
        XCTAssertEqual(session.sessionId, "00000000-0000-7000-8000-000000000006")
        XCTAssertEqual(session.model.current, "gpt-6-luna")
        XCTAssertEqual(session.effort.current, "low")
        XCTAssertEqual(session.mode.current, "read-only")
    }

    func testKeepsThePrimaryAndSecondaryWindowsTheirResetsSentInSecondsReadAsMilliseconds() throws {
        let usage = try codexPlayed("codex-greeting.capture.ndjson").transcript.usage
        XCTAssertEqual(
            usage?.rateLimits,
            [
                RateLimit(window: "5-hour", durationMinutes: 300, usedPercent: 0, resetsAt: 1_790_313_079_000),
                RateLimit(window: "7-day", durationMinutes: 10_080, usedPercent: 17, resetsAt: 1_790_593_906_000),
            ])
        XCTAssertEqual(usage?.inputTokens, 21669)
        XCTAssertEqual(usage?.outputTokens, 8)
        XCTAssertEqual(usage?.contextWindow, 258_400)
    }
}

final class CodexResumeSessionTests: XCTestCase {
    let other = "00000000-0000-7000-8000-0000000000b2"

    /// The handshake's thread/start answer, as the answer to a resume of `other` with one past turn.
    func resumedAnswer(_ id: Int) -> JsonValue {
        var start = j(codexFixture("handshake.handwritten.ndjson")[2])
        start = setting(start, ["result", "thread", "id"], .string(other))
        start = setting(
            start, ["result", "thread", "turns"],
            j(
                #"[{"id":"other-turn","items":[{"type":"userMessage","id":"other-user","clientId":null,"content":[{"type":"text","text":"elsewhere","text_elements":[]}]}],"itemsView":"full","status":"completed","error":null,"startedAt":null,"completedAt":null,"durationMs":5}]"#
            ))
        return .object(JsonObject([("id", .number(Double(id))), ("result", start["result"]!)]))
    }

    func resume(_ harness: CodexHarness) throws {
        guard case .write(let lines) = try harness.adapter.resumeSession(other, history: []) else {
            return XCTFail("a restart for a resume")
        }
        for line in lines { try harness.write(line) }
    }

    func turn(_ status: String, durationMs: String = "null") -> String {
        #"{"id":"t-1","items":[],"itemsView":"full","status":"\#(status)","error":null,"startedAt":null,"completedAt":null,"durationMs":\#(durationMs)}"#
    }

    func testResumesTheOtherThreadOnTheSameAppServerAndDrawsItInPlaceOfThisOne() throws {
        let harness = try codexReady()
        try harness.send("here")
        try harness.receive(#"{"id":\#(harness.lastWrite()["id"]!.jsonText),"result":{"turn":\#(turn("inProgress"))}}"#)
        try harness.receive(#"{"method":"turn/started","params":{"threadId":"\#(CODEX_MAIN)","turn":\#(turn("inProgress"))}}"#)
        try harness.receive(
            #"{"method":"turn/completed","params":{"threadId":"\#(CODEX_MAIN)","turn":\#(turn("completed", durationMs: "1"))}}"#)
        let before = harness.written.count
        try resume(harness)
        let asked = harness.writesSince(before)[0]
        let id = Int(asked["id"]!.numberValue!)
        XCTAssertEqual(
            harness.written[before], #"{"id":\#(id),"method":"thread/resume","params":{"threadId":"\#(other)","cwd":"\#(CODEX_CWD)"}}"#)
        XCTAssertEqual(harness.transcript.state, .ready(turn: .rewinding))
        try harness.receive(resumedAnswer(id))
        XCTAssertEqual(codexOutline(harness.transcript), ["user(person): elsewhere", "turn-end completed 5ms"])
        XCTAssertEqual(harness.transcript.session.sessionId, other)
        XCTAssertEqual(harness.transcript.state, .ready(turn: .none))
        // The next turn is on the other thread.
        try harness.send("go on")
        assertMatches(harness.lastWrite(), j(#"{"method":"turn/start","params":{"threadId":"\#(other)"}}"#))
    }

    func testSaysSoAndStaysOnThisThreadWhenAppServerRefusesTheOther() throws {
        let harness = try codexReady()
        let before = harness.written.count
        try resume(harness)
        let id = harness.writesSince(before)[0]["id"]!.jsonText
        try harness.receive(#"{"id":\#(id),"error":{"code":-32600,"message":"no rollout found"}}"#)
        XCTAssertEqual(harness.transcript.state, .ready(turn: .none))
        XCTAssertEqual(harness.transcript.session.sessionId, CODEX_MAIN)
        XCTAssertEqual(
            codexOutline(harness.transcript), ["notice(error): codex 0.156.1 did not go on with that thread: no rollout found"])
    }

    func testOffersResumeAsDevHubsOwnPicker() throws {
        XCTAssertEqual(try codexReady().transcript.session.commands.first { $0.name == "resume" }?.route, .resume)
    }

    func testTakesNoHistoryAndIsRefusedWhileATurnRuns() throws {
        let harness = try codexReady()
        assertThrowsMatching("takes no history") { _ = try harness.adapter.resumeSession(self.other, history: ["{}"]) }
        try harness.send("here")
        assertThrowsMatching("not idle") { _ = try harness.adapter.resumeSession(self.other, history: []) }
    }
}

final class CodexRestartTests: XCTestCase {
    func turn(_ status: String) -> String {
        #"{"id":"t-1","items":[],"itemsView":"full","status":"\#(status)","error":null,"startedAt":null,"completedAt":null,"durationMs":null}"#
    }

    /// A turn running on the main thread, with the person's message in it.
    func running() throws -> CodexHarness {
        let harness = try codexReady()
        try harness.send("here")
        try harness.receive(#"{"id":\#(harness.lastWrite()["id"]!.jsonText),"result":{"turn":\#(turn("inProgress"))}}"#)
        try harness.receive(#"{"method":"turn/started","params":{"threadId":"\#(CODEX_MAIN)","turn":\#(turn("inProgress"))}}"#)
        return harness
    }

    func testStopsAThreadWhoseTurnTheProviderRefusedAsUnauthorizedAndARestartGoesOnFromIt() throws {
        let harness = try running()
        try harness.receive(
            #"{"method":"turn/completed","params":{"threadId":"\#(CODEX_MAIN)","turn":{"id":"t-1","items":[],"itemsView":"notLoaded","status":"failed","error":{"message":"Your access token could not be refreshed.","codexErrorInfo":"unauthorized","additionalDetails":null},"startedAt":null,"completedAt":null,"durationMs":null}}}"#
        )
        guard case .broken(let failure) = harness.transcript.state else { return XCTFail("not broken") }
        XCTAssertEqual(failure.code, .notSignedIn)
        XCTAssertTrue(
            failure.detail.contains("said: “Your access token could not be refreshed.”. Sign in with `codex login`"),
            failure.detail)
        // Stopped, it reads nothing but a new server's start.
        XCTAssertEqual(try harness.adapter.restart(), RestartPlan(session: [], mark: [RESTART_MARK]))
        let before = harness.written.count
        try harness.receive(RESTART_MARK)
        XCTAssertEqual(harness.transcript.state, .ready(turn: .rewinding))
        let written = harness.writesSince(before)
        XCTAssertEqual(written.count, 1)
        XCTAssertEqual(written[0]["method"], "initialize")
    }

    func testStartsAppServerAgainWithTheRestartMarkBetweenTheTwo() throws {
        let harness = try running()
        XCTAssertEqual(try harness.adapter.restart(), RestartPlan(session: [], mark: [RESTART_MARK]))
        XCTAssertEqual(harness.transcript.state, .ready(turn: .running))
    }

    func testKeepsTheThreadDrawnUnderAQuietDividerGreetsTheNewServerAfreshAndResumesTheSameThreadOnIt() throws {
        let harness = try running()
        let drawn = codexOutline(harness.transcript)
        let before = harness.written.count
        let step = try harness.receive(RESTART_MARK)
        XCTAssertTrue(step.events.contains(.restarted))
        XCTAssertEqual(codexOutline(harness.transcript), drawn + ["notice(info): \(RESTARTED)"])
        XCTAssertEqual(harness.transcript.sending, [])
        XCTAssertEqual(harness.transcript.state, .ready(turn: .rewinding))
        let initialize = harness.writesSince(before)[0]
        XCTAssertEqual(initialize["method"], "initialize")

        let handshake = codexFixture("handshake.handwritten.ndjson").map { j($0) }
        func answer(_ asked: JsonValue, _ index: Int) throws {
            try harness.receive(setting(handshake[index], ["id"], asked["id"]!))
        }
        try answer(initialize, 0)
        let next = harness.writesSince(before + 1)
        XCTAssertEqual(next[0], j(#"{"method":"initialized"}"#))
        XCTAssertEqual(next[1]["method"], "account/read")
        try answer(next[1], 1)
        let resumed = harness.lastWrite()
        XCTAssertEqual(
            harness.written.last,
            #"{"id":\#(resumed["id"]!.jsonText),"method":"thread/resume","params":{"threadId":"\#(CODEX_MAIN)","cwd":"\#(CODEX_CWD)"}}"#)
        // app-server hands the thread back with its past, which is drawn already.
        let opened = setting(
            setting(handshake[2], ["id"], resumed["id"]!), ["result", "thread", "turns"],
            j(
                #"[{"id":"t-1","items":[{"type":"userMessage","id":"past-user","clientId":null,"content":[{"type":"text","text":"here","text_elements":[]}]}],"itemsView":"full","status":"interrupted","error":null,"startedAt":null,"completedAt":null,"durationMs":5}]"#
            ))
        try harness.receive(opened)
        // The same thread, not drawn a second time.
        XCTAssertEqual(codexOutline(harness.transcript), drawn + ["notice(info): \(RESTARTED)"])
        XCTAssertEqual(harness.transcript.session.sessionId, CODEX_MAIN)
        XCTAssertEqual(harness.transcript.state, .ready(turn: .none))
        // The new server is asked for its models and skills again.
        XCTAssertEqual(
            harness.writesSince(before).map { $0["method"]?.stringValue },
            ["initialize", "initialized", "account/read", "thread/resume", "model/list", "skills/list"])
        try harness.send("go on")
        assertMatches(harness.lastWrite(), j(#"{"method":"turn/start","params":{"threadId":"\#(CODEX_MAIN)"}}"#))
    }

    func testNamesARequestOfTheNewServerApartFromTheOldOnesWithTheSameId() throws {
        let harness = try codexReady()
        let ask =
            #"{"id":7,"method":"item/tool/requestUserInput","params":{"threadId":"\#(CODEX_MAIN)","turnId":"t-1","itemId":"ask","isBlocking":true,"autoResolutionMs":null,"questions":[{"id":"lang","header":"Language","question":"Which language?","isOther":true,"isSecret":false,"options":[{"label":"TypeScript","description":"the usual"}]}]}}"#
        try harness.receive(ask)
        let first = harness.transcript.requests[0]
        try harness.receive(RESTART_MARK)
        XCTAssertEqual(harness.transcript.requests, [])
        try harness.receive(ask)
        XCTAssertNotEqual(harness.transcript.requests[0].id, first.id)
    }

    func testOffersRestartAsDevHubsOwnCommand() throws {
        let command = try codexReady().transcript.session.commands.first { $0.name == "restart" }
        XCTAssertEqual(command?.trigger, .slash)
        XCTAssertEqual(command?.route, .restart)
    }
}

final class CodexMiscTests: XCTestCase {
    func testKeepsAnMCPToolsTextAndImagesInOrderAsTheCallsOutput() throws {
        let harness = try codexReady()
        try harness.send("go")
        try harness.receive(
            #"{"method":"item/completed","params":{"threadId":"\#(CODEX_MAIN)","turnId":"turn-1","completedAtMs":0,"item":{"type":"mcpToolCall","id":"item-mcp","server":"browser","tool":"screenshot","status":"completed","arguments":{"tabId":1},"result":{"content":[{"type":"text","text":"Captured."},{"type":"image","data":"AAAA","mimeType":"image/png"}],"structuredContent":null,"_meta":null},"error":null,"durationMs":5}}}"#
        )
        let tool = try harness.tool("\(CODEX_MAIN)/item-mcp")
        XCTAssertEqual(tool.title, "browser · screenshot")
        XCTAssertEqual(
            tool.output,
            [.text("Captured."), .image(ImageRef(mediaType: "image/png", source: .data(base64: "AAAA"), label: "image"))])
    }

    func testImagesGoToAppServerAsDataURLsAfterTheWordsAndTheMessageIsSendingWithThem() throws {
        let harness = try codexReady()
        try harness.send(
            "what is this?", images: [ImageRef(mediaType: "image/png", source: .data(base64: "AAAA"), label: "shot.png")])
        assertMatches(
            harness.lastWrite(),
            j(
                #"{"method":"turn/start","params":{"input":[{"type":"text","text":"what is this?","text_elements":[]},{"type":"image","url":"data:image/png;base64,AAAA"}]}}"#
            ))
        XCTAssertEqual(
            harness.transcript.sending,
            [
                SendingMessage(
                    id: "devhub-person-0", text: "what is this?",
                    images: [ImageRef(mediaType: "image/png", source: .url("data:image/png;base64,AAAA"), label: "image")],
                    origin: .person)
            ])
    }

    func testDevHubsOwnInstructionsGoWithThreadStartForTheDevhubSkill() throws {
        let harness = CodexHarness(
            CodexAdapterOptions(
                clientVersion: "0.1.0", cwd: CODEX_CWD, resumeThreadId: nil, developerInstructions: "read SKILL.md"))
        let lines = codexFixture("handshake.handwritten.ndjson")
        try harness.start()
        try harness.receive(lines[0])
        try harness.receive(lines[1])
        XCTAssertEqual(
            harness.written.last,
            #"{"id":2,"method":"thread/start","params":{"cwd":"\#(CODEX_CWD)","developerInstructions":"read SKILL.md"}}"#)
    }
}

final class CodexModelListTests: XCTestCase {
    func model(_ name: String, _ hidden: Bool, _ efforts: [String]) -> String {
        let supported = efforts.map { #"{"reasoningEffort":"\#($0)","description":"\#($0)"}"# }.joined(separator: ",")
        return #"{"id":"\#(name)","model":"\#(name)","upgrade":null,"upgradeInfo":null,"availabilityNux":null,"displayName":"\#(name) (label)","description":"","modelSpecialty":null,"hidden":\#(hidden),"supportedReasoningEfforts":[\#(supported)],"defaultReasoningEffort":"\#(efforts[0])","inputModalities":["text"],"supportsPersonality":false,"multiAgentVersion":null,"additionalSpeedTiers":[],"serviceTiers":[],"defaultServiceTier":null,"availableAccessPrograms":null,"isDefault":false}"#
    }
    var shown: String { model("shown-model", false, ["low", "high"]) }
    var hidden: String { model("older-model", true, ["medium", "xhigh"]) }

    /// A resumed thread on `thread`, its handshake answered up to `model/list`.
    func resumedOn(_ thread: String) throws -> CodexHarness {
        let harness = CodexHarness(CodexAdapterOptions(clientVersion: "0.1.0", cwd: CODEX_CWD, resumeThreadId: CODEX_MAIN))
        try harness.start()
        let lines = codexFixture("handshake.handwritten.ndjson")
        try harness.receive(lines[0])
        try harness.receive(lines[1])
        try harness.receive(setting(setting(j(lines[2]), ["result", "model"], .string(thread)), ["result", "reasoningEffort"], .null))
        return harness
    }

    func testListsHiddenModelsTooAndOffersTheThreadsOwnHiddenModelWithItsEfforts() throws {
        let harness = try resumedOn("older-model")
        XCTAssertEqual(harness.written[harness.written.count - 2], #"{"id":3,"method":"model/list","params":{"includeHidden":true}}"#)
        try harness.receive(#"{"id":3,"result":{"data":[\#(shown),\#(hidden)],"nextCursor":null}}"#)
        let session = harness.transcript.session
        XCTAssertEqual(
            session.model,
            Setting(
                current: "older-model",
                choices: [
                    SettingChoice(id: "shown-model", label: "shown-model", detail: "shown-model (label)"),
                    SettingChoice(id: "older-model", label: "older-model", detail: "older-model (label)"),
                ]))
        XCTAssertEqual(
            session.effort,
            Setting(
                current: "medium",
                choices: [
                    SettingChoice(id: "medium", label: "medium", builtInDefault: true),
                    SettingChoice(id: "xhigh", label: "xhigh"),
                ]))
    }

    func testOffersNoHiddenModelTheThreadIsNotOn() throws {
        let harness = try resumedOn("shown-model")
        try harness.receive(#"{"id":3,"result":{"data":[\#(shown),\#(hidden)],"nextCursor":null}}"#)
        XCTAssertEqual(
            harness.transcript.session.model.choices,
            [SettingChoice(id: "shown-model", label: "shown-model", detail: "shown-model (label)")])
    }

    func testReadsEveryPageOfTheListBeforeItNamesTheThreadsModel() throws {
        let harness = try resumedOn("older-model")
        try harness.receive(#"{"id":3,"result":{"data":[\#(shown)],"nextCursor":"page-2"}}"#)
        XCTAssertEqual(harness.written.last, #"{"id":5,"method":"model/list","params":{"includeHidden":true,"cursor":"page-2"}}"#)
        XCTAssertNil(harness.transcript.session.effort.unchangeable)
        try harness.receive(#"{"id":5,"result":{"data":[\#(hidden)],"nextCursor":null}}"#)
        let session = harness.transcript.session
        XCTAssertEqual(session.model.current, "older-model")
        XCTAssertEqual(session.effort.choices.map(\.id), ["medium", "xhigh"])
    }

    func testIsAChoiceOfItsOwnWhenTheListDoesNotNameItAndSaysWhyItsEffortCantBeChanged() throws {
        let harness = try resumedOn("retired-model")
        try harness.receive(#"{"id":3,"result":{"data":[\#(shown),\#(hidden)],"nextCursor":null}}"#)
        let session = harness.transcript.session
        XCTAssertEqual(session.model.current, "retired-model")
        XCTAssertEqual(session.model.choices[0], SettingChoice(id: "retired-model", label: "retired-model"))
        XCTAssertEqual(session.effort.choices, [])
        XCTAssertTrue(session.effort.unchangeable?.contains("retired-model") ?? false)
    }

    func testSaysWhyNeitherTheModelNorTheEffortCanBeChangedWhenTheListFailed() throws {
        let harness = try resumedOn("shown-model")
        try harness.receive(#"{"id":3,"error":{"code":-32603,"message":"catalog unavailable"}}"#)
        let session = harness.transcript.session
        XCTAssertEqual(session.model.current, "shown-model")
        XCTAssertEqual(session.model.choices, [])
        XCTAssertTrue(session.model.unchangeable?.contains("catalog unavailable") ?? false)
        XCTAssertTrue(session.effort.unchangeable?.contains("catalog unavailable") ?? false)
    }
}

final class CodexMcpServerTests: XCTestCase {
    /// One `McpServerStatus` as `mcpServerStatus/list` names it, with the fields the panel does not read.
    func server(_ fields: JsonObject) -> JsonValue {
        var base: JsonObject = [
            "runtimeStatus": nil, "pluginId": nil, "httpOrigin": nil, "serverInfo": nil, "serverCapabilities": nil,
            "tools": [:], "toolsError": nil, "resources": [], "resourceTemplates": [], "authStatus": "unsupported",
        ]
        for (key, value) in fields { base[key] = value }
        return .object(base)
    }

    func testAsksForThemWithTheDocumentedMcpServerStatusListForTheThreadFollowingEveryPage() throws {
        let harness = try codexReady()
        try harness.command(.mcp(.refresh))
        let first = harness.lastWrite()
        XCTAssertEqual(first["method"], "mcpServerStatus/list")
        XCTAssertEqual(harness.written.last, #"{"id":5,"method":"mcpServerStatus/list","params":{"detail":"toolsAndAuthOnly","threadId":"\#(CODEX_MAIN)"}}"#)
        try harness.receive(
            .object([
                "id": first["id"]!,
                "result": ["data": [server(["name": "docs", "runtimeStatus": "connected"])], "nextCursor": "page-2"],
            ]))
        XCTAssertNil(harness.transcript.mcp.servers)
        let second = harness.lastWrite()
        XCTAssertEqual(second["params"], j(#"{"detail":"toolsAndAuthOnly","threadId":"\#(CODEX_MAIN)","cursor":"page-2"}"#))
        try harness.receive(
            .object([
                "id": second["id"]!,
                "result": [
                    "data": [
                        server([
                            "name": "linear", "runtimeStatus": "authenticationRequired", "authStatus": "notLoggedIn",
                            "pluginId": "linear@openai-curated",
                        ]),
                        server(["name": "broken", "runtimeStatus": "failed", "toolsError": "connection refused"]),
                        server(["name": "later", "authStatus": "notLoggedIn"]),
                        server(["name": "off", "runtimeStatus": "disabled"]),
                    ],
                    "nextCursor": nil,
                ],
            ]))
        XCTAssertEqual(
            harness.transcript.mcp.servers,
            [
                McpServer(name: "docs", status: .connected, said: "connected", error: nil, source: nil, actions: [.reconnect]),
                McpServer(
                    name: "linear", status: .needsSignIn, said: "authenticationRequired", error: nil,
                    source: "plugin linear@openai-curated", actions: [.signIn, .reconnect]),
                McpServer(
                    name: "broken", status: .failed, said: "failed", error: "connection refused", source: nil,
                    actions: [.reconnect]),
                McpServer(
                    name: "later", status: .needsSignIn, said: "notLoggedIn", error: nil, source: nil,
                    actions: [.signIn, .reconnect]),
                McpServer(name: "off", status: .disabled, said: "disabled", error: nil, source: nil, actions: []),
            ])
        // Nothing about them in the conversation itself.
        XCTAssertEqual(harness.transcript.entries, [])
    }

    func listing(_ servers: [JsonObject]) throws -> CodexHarness {
        let harness = try codexReady()
        try harness.command(.mcp(.refresh))
        try harness.receive(
            .object(["id": harness.lastWrite()["id"]!, "result": ["data": .array(servers.map(server)), "nextCursor": nil]]))
        return harness
    }

    func testReconnectsWithTheDocumentedConfigMcpServerReloadEveryServerWorkingUntilItIsAnswered() throws {
        let harness = try listing([["name": "docs", "runtimeStatus": "connected"], ["name": "broken", "runtimeStatus": "failed"]])
        try harness.command(.mcp(.act(action: .reconnect, server: "broken")))
        let reload = harness.lastWrite()
        XCTAssertEqual(harness.written.last, #"{"id":\#(reload["id"]!.jsonText),"method":"config/mcpServer/reload"}"#)
        XCTAssertEqual(
            harness.transcript.mcp.working,
            [McpWork(server: "docs", action: .reconnect), McpWork(server: "broken", action: .reconnect)])
        try harness.receive(#"{"id":\#(reload["id"]!.jsonText),"result":{}}"#)
        XCTAssertEqual(harness.transcript.mcp.working, [])
        XCTAssertEqual(harness.lastWrite()["method"], "mcpServerStatus/list")
    }

    func testOffersNoEnablingOrDisablingWhichCodexKeepsInItsConfig() throws {
        let harness = try listing([["name": "off", "runtimeStatus": "disabled"]])
        assertThrowsMatching("enable is not offered for the MCP server off now") {
            try harness.command(.mcp(.act(action: .enable, server: "off")))
        }
    }

    func testSaysARefusedRequestInThePanelUntilThePersonMakesTheNextOne() throws {
        let harness = try listing([["name": "broken", "runtimeStatus": "failed"]])
        try harness.command(.mcp(.act(action: .reconnect, server: "broken")))
        try harness.receive(
            #"{"id":\#(harness.lastWrite()["id"]!.jsonText),"error":{"code":-32603,"message":"failed to refresh MCP servers: boom"}}"#)
        XCTAssertEqual(harness.transcript.mcp.failure, "Reconnecting the MCP servers failed: failed to refresh MCP servers: boom")
        XCTAssertEqual(harness.transcript.mcp.working, [])
        try harness.command(.mcp(.act(action: .reconnect, server: "broken")))
        XCTAssertNil(harness.transcript.mcp.failure)
    }
}

final class CodexUsageLimitTurnTests: XCTestCase {
    let resets: Double = 1_790_003_600

    /// A turn started by "go": its answer, its start and the message, as app-server gives them.
    func started() throws -> CodexHarness {
        let harness = try codexReady()
        try harness.send("go")
        for line in codexFixture("turn.handwritten.ndjson").prefix(4) { try harness.receive(line) }
        return harness
    }

    func limits(_ usedPercent: Int) -> String {
        let reached = usedPercent >= 100 ? #""rate_limit_reached""# : "null"
        return #"{"method":"account/rateLimits/updated","params":{"rateLimits":{"limitId":"codex","limitName":null,"normalModelSlug":null,"primary":{"usedPercent":\#(usedPercent),"windowDurationMins":300,"resetsAt":1790003600},"secondary":{"usedPercent":20,"windowDurationMins":10080,"resetsAt":1790003699},"credits":null,"individualLimit":null,"spendControlReached":null,"planType":null,"rateLimitReachedType":\#(reached)}}}"#
    }

    func failed(_ codexErrorInfo: String) -> String {
        #"{"method":"turn/completed","params":{"threadId":"\#(CODEX_MAIN)","turn":{"id":"turn-1","items":[],"itemsView":"notLoaded","status":"failed","error":{"message":"You've hit your usage limit.","codexErrorInfo":\#(codexErrorInfo),"additionalDetails":null},"startedAt":null,"completedAt":null,"durationMs":null}}}"#
    }

    func lastEnd(_ harness: CodexHarness) -> TurnEndEntry? {
        harness.transcript.entries.last { $0.kind == "turn-end" }?.turnEndEntry
    }

    func testEndsWithTheLimitResetWhenTheUsedUpWindowResets() throws {
        let harness = try started()
        try harness.receive(limits(100))
        try harness.receive(failed(#""usageLimitExceeded""#))
        XCTAssertEqual(lastEnd(harness)?.outcome, .failed)
        XCTAssertEqual(lastEnd(harness)?.limit, LimitStop(resetsAt: resets * 1000))
    }

    func testLearnsTheResetFromTheRateLimitsCodexReportsAfterTheTurn() throws {
        let harness = try started()
        try harness.receive(limits(60))
        try harness.receive(failed(#""usageLimitExceeded""#))
        XCTAssertEqual(lastEnd(harness)?.limit, LimitStop(resetsAt: nil))
        try harness.receive(limits(100))
        XCTAssertEqual(lastEnd(harness)?.limit, LimitStop(resetsAt: resets * 1000))
    }

    func testIsNotATurnThatFailedForAnotherReason() throws {
        for info in ["null", #""serverOverloaded""#, #"{"httpConnectionFailed":{"httpStatusCode":429}}"#] {
            let harness = try started()
            try harness.receive(limits(100))
            try harness.receive(failed(info))
            XCTAssertNotNil(lastEnd(harness), info)
            XCTAssertNil(lastEnd(harness)?.limit, info)
        }
    }

    func testGoesOnWithAMessageSentForThePersonWhichSaysSo() throws {
        let harness = try started()
        try harness.receive(limits(100))
        try harness.receive(failed(#""usageLimitExceeded""#))
        try harness.send("続けて", .afterLimit)
        let clientUserMessageId = harness.lastWrite()["params"]!["clientUserMessageId"]!.stringValue!
        XCTAssertNotNil(clientUserMessageId.range(of: #"^devhub-after-limit-\d+$"#, options: .regularExpression))
        XCTAssertEqual(harness.transcript.sending.map(\.text), ["続けて"])
        XCTAssertEqual(harness.transcript.sending.map(\.origin), [.afterLimit])
        try harness.receive(
            #"{"method":"item/completed","params":{"item":{"type":"userMessage","id":"item-resume","clientId":"\#(clientUserMessageId)","content":[{"type":"text","text":"続けて","text_elements":[]}]},"threadId":"\#(CODEX_MAIN)","turnId":"turn-2","completedAtMs":1790000000000}}"#
        )
        XCTAssertEqual(try harness.user("\(CODEX_MAIN)/item-resume").origin, .afterLimit)
    }
}

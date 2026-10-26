// Port of apps/desktop/src/main/agent/conversation/claude/adapter.test.ts (3/6)

import XCTest
@testable import DevHubCore

final class ClaudeElicitationTests: XCTestCase {
    func elicit(_ adapter: ClaudeAdapter, _ request: JsonObject) throws -> PendingRequest {
        let step = try adapter.received(
            json([
                "type": "control_request", "request_id": "el-1",
                "request": .object(merged(["subtype": "elicitation", "mcp_server_name": "tickets"], request)),
            ]))
        XCTAssertEqual(step.replies, [])
        return try XCTUnwrap(adapter.transcript.requests.first)
    }

    func answered(_ adapter: ClaudeAdapter, _ answer: RequestAnswer) throws -> JsonValue {
        parsed(try carryOut(adapter, .answer(request: "el-1", answer: answer)))[0]
    }

    func testIsTheCardCodexsIs() throws {
        let request = try elicit(
            try inTurn(),
            [
                "message": "File a ticket", "mode": "form",
                "requested_schema": [
                    "type": "object",
                    "properties": ["title": ["type": "string", "title": "Title"], "count": ["type": "integer", "minimum": 1]],
                    "required": ["title"],
                ],
            ])
        XCTAssertEqual(
            request,
            PendingRequest(
                id: "el-1", entry: nil,
                subject: .elicitation(
                    server: "tickets", message: "File a ticket", url: nil,
                    fields: [
                        FormField(
                            key: "title", label: "Title", description: nil, required: true,
                            input: .text(format: nil, minLength: nil, maxLength: nil, default: nil)),
                        FormField(
                            key: "count", label: "count", description: nil, required: false,
                            input: .number(integer: true, minimum: 1, maximum: nil, default: nil)),
                    ]),
                choices: [
                    RequestChoice(id: "decline", label: "Decline", tone: .deny, takesText: false),
                    RequestChoice(id: "cancel", label: "Cancel", tone: .neutral, takesText: false),
                ]))
    }

    func testIsAcceptedByItsFormAnsweredWithTheContentTyped() throws {
        let adapter = try inTurn()
        _ = try elicit(
            adapter,
            [
                "message": "File a ticket",
                "requested_schema": [
                    "type": "object", "properties": ["title": ["type": "string"], "count": ["type": "integer"]],
                ],
            ])
        XCTAssertEqual(
            try answered(adapter, .answers(values: [("title", .one("Login fails")), ("count", .one("3"))], notes: nil)),
            [
                "type": "control_response",
                "response": [
                    "subtype": "success", "request_id": "el-1",
                    "response": ["action": "accept", "content": ["title": "Login fails", "count": 3]],
                ],
            ])
        XCTAssertEqual(adapter.transcript.requests, [])
    }

    func testWithNoSchemaIsAPlainConfirmation() throws {
        let adapter = try inTurn()
        let request = try elicit(adapter, ["message": "Go on?"])
        XCTAssertEqual(request.subject, .elicitation(server: "tickets", message: "Go on?", url: nil, fields: []))
        XCTAssertEqual(
            try answered(adapter, .answers(values: [], notes: nil))["response"]?["response"],
            ["action": "accept", "content": [:]])
    }

    func testAnswersDeclineAndCancelWithNoContent() throws {
        for action in ["decline", "cancel"] {
            let adapter = try inTurn()
            _ = try elicit(adapter, ["message": "Go on?", "requested_schema": ["type": "object", "properties": [:]]])
            XCTAssertEqual(
                try answered(adapter, .choice(choiceId: action, text: nil))["response"]?["response"],
                ["action": .string(action)])
            XCTAssertEqual(adapter.transcript.requests, [])
        }
    }

    func testOfAPageToVisitShowsThePageAndIsAcceptedWithNoContent() throws {
        let adapter = try inTurn()
        let request = try elicit(
            adapter,
            [
                "message": "Sign in to the tracker", "mode": "url", "url": "https://tracker.example.com/auth",
                "elicitation_id": "e-1",
            ])
        XCTAssertEqual(
            request.subject,
            .elicitation(
                server: "tickets", message: "Sign in to the tracker", url: "https://tracker.example.com/auth", fields: []))
        XCTAssertEqual(try answered(adapter, .answers(values: [], notes: nil))["response"]?["response"], ["action": "accept"])
    }

    func testRefusesAnAnswerItDidNotOfferAndAFormSentUnfinished() throws {
        let schema: JsonObject = [
            "message": "File a ticket",
            "requested_schema": ["type": "object", "properties": ["title": ["type": "string"]], "required": ["title"]],
        ]
        let adapter = try inTurn()
        _ = try elicit(adapter, schema)
        assertThrows(
            try adapter.encode(.answer(request: "el-1", answer: .choice(choiceId: "remember:session", text: nil))),
            "has no choice")
        let fresh = try inTurn()
        _ = try elicit(fresh, schema)
        assertThrows(
            try fresh.encode(.answer(request: "el-1", answer: .answers(values: [("title", .one(""))], notes: nil))),
            "sent unfinished")
    }

    func testClosesWhenTheCLICancelsIt() throws {
        let adapter = try inTurn()
        _ = try elicit(adapter, ["message": "Go on?"])
        _ = try adapter.received(json(["type": "control_cancel_request", "request_id": "el-1"]))
        XCTAssertEqual(adapter.transcript.requests, [])
    }

    func testOfAModeDevHubDoesNotKnowIsAMismatch() throws {
        assertThrows(try elicit(try inTurn(), ["message": "Go on?", "mode": "openai/form"]), #"control_request\.request\.mode"#)
    }
}

final class ClaudeUnreadableLineTests: XCTestCase {
    func testOfAKnownTypeInTheWrongShapeThrowsWithThePathAndTheCLIVersion() throws {
        let adapter = try inTurn()
        XCTAssertThrowsError(
            try adapter.received(json(["type": "assistant", "message": ["id": "m", "content": "not an array"]]))
        ) { error in
            XCTAssertEqual(
                error as? ProtocolMismatch,
                ProtocolMismatch(path: "assistant.message.content", expected: "an array", agentVersion: "2.1.0"))
        }
    }

    func testThatIsNotJSONThrows() throws {
        assertThrows(try (try inTurn()).received("{half a line"), "line: expected a line of JSON")
    }

    func testLeavesTheAdapterSpent() throws {
        let adapter = try inTurn()
        XCTAssertThrowsError(try adapter.received("nope")) { XCTAssertTrue($0 is ProtocolMismatch) }
        assertThrows(try adapter.received(result()), "spent")
        assertThrows(try adapter.sent("{}"), "spent")
        assertThrows(try adapter.encode(.interrupt), "spent")
    }

    func testIncludesADeltaForABlockThatNeverStarted() throws {
        let adapter = try inTurn()
        _ = try adapter.received(stream(["type": "message_start", "message": ["id": "m"]]))
        assertThrows(
            try adapter.received(
                stream(["type": "content_block_delta", "index": 3, "delta": ["type": "text_delta", "text": "x"]])),
            #"stream_event\.event\(content_block_delta\)\.index: expected a block that started"#)
    }

    func testIncludesABlockWithNoMessageAroundIt() throws {
        let adapter = try inTurn()
        assertThrows(
            try adapter.received(
                stream(["type": "content_block_start", "index": 0, "content_block": ["type": "text", "text": ""]])),
            "expected a message_start before it")
    }

    func testIncludesALineInInLogThatDevHubWouldNeverHaveWritten() throws {
        assertThrows(try (try inTurn()).sent(json(["type": "assistant"])), #"sent line\.type"#)
    }
}

final class ClaudeWithoutPartialMessagesTests: XCTestCase {
    func testArrivesWholeAndFinalFromItsCompleteMessageAlone() throws {
        let adapter = try inTurn()
        _ = try adapter.received(assistantLine("m", [["type": "thinking", "thinking": "hmm"]]))
        _ = try adapter.received(assistantLine("m", [["type": "text", "text": "Done."]]))
        XCTAssertEqual(
            try entry(adapter, "assistant:m:0"),
            .assistant(
                AssistantEntry(id: "assistant:m:0", blocks: [.thinking(text: "hmm"), .text(markdown: "Done.")], streaming: false)))
    }
}

/// A real session, scrubbed (see the capture's header): what the CLI printed
/// and what DevHub wrote, in the order they happened. Where it and the
/// hand-written fixtures disagree, the capture is right.
final class ClaudeCapturedSessionTests: XCTestCase {
    let lines = fixture("claude-session.capture.ndjson")

    func played(_ upTo: Int? = nil) throws -> ClaudeAdapter {
        let adapter = ClaudeAdapter(bootId: "replay")
        try play(adapter, Array(lines.prefix(upTo ?? lines.count)))
        return adapter
    }

    func testPlaysThroughToAnIdleConversation() throws {
        let transcript = try played().transcript
        XCTAssertEqual(transcript.state, .ready(turn: .none))
        XCTAssertEqual(
            transcript.entries.compactMap(\.turnEndEntry).map(\.outcome),
            [.completed, .completed, .completed, .completed, .completed])
        XCTAssertEqual(transcript.entries.filter { $0.kind == "notice" }, [])
        XCTAssertEqual(transcript.entries.compactMap(\.userEntry).map(\.origin), [.person, .person, .person, .person])
    }

    func testDrawsNoThinkingTheAPIWithheld() throws {
        for case .assistant(let assistant) in try played().transcript.entries {
            XCTAssertGreaterThan(assistant.blocks.count, 0)
            for case .thinking(let text) in assistant.blocks { XCTAssertNotEqual(text, "") }
        }
    }

    func testHangsABackgroundSubagentsWorkUnderTheAgentCall() throws {
        let adapter = ClaudeAdapter(bootId: "replay")
        let asked = try XCTUnwrap(lines.firstIndex { $0.line.contains(#""subtype":"can_use_tool""#) })
        try play(adapter, Array(lines[...asked]))
        let agent = try XCTUnwrap(adapter.transcript.entries.compactMap(\.toolEntry).first { $0.tool == "Agent" })
        XCTAssertEqual(agent.spawns?.label, "general-purpose")
        XCTAssertEqual(agent.spawns?.state, .running)
        let request = try XCTUnwrap(adapter.transcript.requests.first)
        let bash = try XCTUnwrap(adapter.transcript.entries.first { $0.id == request.entry }?.toolEntry)
        XCTAssertEqual(bash.tool, "Bash")
        XCTAssertEqual(bash.parent, agent.id)
        XCTAssertEqual(bash.status, .running)
        XCTAssertTrue(request.choices.map(\.id).contains("allow"))
        // The turn that started it has already ended; the request is still owed an answer.
        XCTAssertEqual(adapter.transcript.state, .ready(turn: .none))
        XCTAssertEqual(conversationStatus(adapter.transcript), .waiting)

        try play(adapter, Array(lines[(asked + 1)...]))
        let transcript = adapter.transcript
        XCTAssertEqual(transcript.requests, [])
        XCTAssertEqual(transcript.entries.first { $0.id == bash.id }?.toolEntry?.status, .succeeded)
        XCTAssertEqual(transcript.entries.first { $0.id == agent.id }?.toolEntry?.spawns?.state, .completed)
    }

    func testReadsATurnTheCLIStartsByItselfAsRunning() throws {
        let own = try XCTUnwrap(
            lines.lastIndex {
                $0.line.contains(#""type":"message_start""#) && $0.line.contains(#""parent_tool_use_id":null"#)
            })
        let adapter = ClaudeAdapter(bootId: "replay")
        try play(adapter, Array(lines[...own]))
        XCTAssertEqual(adapter.transcript.state, .ready(turn: .running))
    }

    func testDrawsTheMarkdownAndRunsTheBashCallToItsOutput() throws {
        let transcript = try played().transcript
        let texts = transcript.entries.compactMap(\.assistantEntry).flatMap { entry in
            entry.blocks.compactMap { block -> String? in
                if case .text(let markdown) = block { return markdown }
                return nil
            }
        }
        XCTAssertTrue(texts[0].contains("| Key | Value |"))
        XCTAssertTrue(texts[0].contains("```typescript"))
        let tool = try XCTUnwrap(transcript.entries.compactMap(\.toolEntry).first)
        XCTAssertEqual(tool.tool, "Bash")
        XCTAssertEqual(tool.title, "Bash: pwd")
        XCTAssertEqual(tool.status, .succeeded)
        // The captured result carries Bash's own account (stdout apart).
        XCTAssertEqual(
            tool.output, [.command(exitCode: nil, output: "/home/testuser/project", stderr: nil, interrupted: false)])
    }

    func testKnowsTheModeFromTheHandshakeBeforeTheFirstTurnNamesIt() throws {
        let transcript = try played(2).transcript
        XCTAssertEqual(transcript.state, .ready(turn: .none))
        XCTAssertEqual(transcript.session.mode.current, "default")
    }

    func testNamesTheModelByTheChoiceTheCLIResolvedItFrom() throws {
        let firstTurn = try XCTUnwrap(lines.firstIndex { $0.line.contains(#""subtype":"init""#) })
        let session = try played(firstTurn + 1).transcript.session
        XCTAssertEqual(session.agentVersion, "2.1.281")
        XCTAssertEqual(session.cwd, "/home/testuser/project")
        // Haiku, reported by its full name, is the "haiku" choice — and has no effort to choose.
        XCTAssertEqual(session.model.current, "haiku")
        XCTAssertEqual(session.effort, Setting(current: nil, choices: []))
    }

    func testOffersEveryEffortLevelAModelSupports() throws {
        let adapter = try played(2)
        _ = try adapter.received(initLine(["model": "claude-sonnet-5"]))
        let session = adapter.transcript.session
        XCTAssertEqual(session.model.current, "sonnet")
        XCTAssertEqual(session.effort.choices.map(\.id), ["low", "medium", "high", "xhigh", "max"])
    }
}

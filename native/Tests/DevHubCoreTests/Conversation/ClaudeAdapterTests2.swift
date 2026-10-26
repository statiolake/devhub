// Port of apps/desktop/src/main/agent/conversation/claude/adapter.test.ts (2/6)

import XCTest
@testable import DevHubCore

private func ack(_ requestId: String) -> String { controlResponse(requestId) }

final class ClaudeInterruptTests: XCTestCase {
    func testWritesAnInterruptControlRequest() throws {
        let adapter = try inTurn()
        XCTAssertEqual(
            parsed(try adapter.encode(.interrupt)),
            [["type": "control_request", "request_id": "boot:1", "request": ["subtype": "interrupt"]]])
    }

    func testEndsTheRunningToolInterruptedAndTheTurnInterrupted() throws {
        let adapter = try inTurn()
        _ = try adapter.received(assistantLine("m", [toolUse("toolu_1", "Bash", ["command": "sleep 100"])]))
        try carryOut(adapter, .interrupt)
        _ = try adapter.received(ack("boot:1"))
        _ = try adapter.received(toolResult("toolu_1", "[Request interrupted by user for tool use]", true))
        _ = try adapter.received(result(["subtype": "error_during_execution", "is_error": true, "errors": []]))
        XCTAssertEqual(try toolOf(adapter, "tool:toolu_1").status, .interrupted)
        XCTAssertEqual(adapter.transcript.entries.last?.turnEndEntry?.outcome, .interrupted)
        XCTAssertEqual(conversationStatus(adapter.transcript), .idle)
    }

    func testDoesNotReachIntoTheNextTurn() throws {
        let adapter = try inTurn()
        try carryOut(adapter, .interrupt)
        _ = try adapter.received(result(["subtype": "error_during_execution", "is_error": true]))
        try carryOut(adapter, send("again"))
        _ = try adapter.received(echo("again", "u2"))
        _ = try adapter.received(result(["is_error": true, "subtype": "error_max_turns", "errors": ["Reached max turns"]]))
        let end = try XCTUnwrap(adapter.transcript.entries.last?.turnEndEntry)
        XCTAssertEqual(end.outcome, .failed)
        XCTAssertEqual(end.detail, "Reached max turns")
    }
}

final class ClaudeSettingsTests: XCTestCase {
    func testChangeTheModelWithSetModelOnceTheCLIAgrees() throws {
        let adapter = try inTurn()
        let lines = try configure(adapter, .model, "opus")
        XCTAssertEqual(
            parsed(lines),
            [["type": "control_request", "request_id": "boot:1", "request": ["subtype": "set_model", "model": "opus"]]])
        XCTAssertEqual(adapter.transcript.session.model.current, "claude-sonnet-5")
        _ = try adapter.received(ack("boot:1"))
        XCTAssertEqual(adapter.transcript.session.model.current, "opus")
    }

    func testChangeTheModeWithSetPermissionMode() throws {
        let adapter = try inTurn()
        let lines = try configure(adapter, .mode, "plan")
        XCTAssertEqual(parsed(lines)[0]["request"], ["subtype": "set_permission_mode", "mode": "plan"])
        _ = try adapter.received(ack("boot:1"))
        XCTAssertEqual(adapter.transcript.session.mode.current, "plan")
    }

    func testShowARefusalAsAnErrorNoticeAndLeaveTheSetting() throws {
        let adapter = try inTurn()
        try configure(adapter, .model, "nonsense")
        _ = try adapter.received(controlResponse("boot:1", error: "Unknown model nonsense"))
        XCTAssertEqual(adapter.transcript.session.model.current, "claude-sonnet-5")
        let notice = try XCTUnwrap(adapter.transcript.entries.last?.noticeEntry)
        XCTAssertEqual(notice.level, .error)
        XCTAssertEqual(notice.text, "set_model was refused: Unknown model nonsense")
    }

    func testChangeTheEffortWithTheEffortCommandAsAMessage() throws {
        let adapter = try inTurn()
        let lines = try configure(adapter, .effort, "high")
        XCTAssertEqual(parsed(lines)[0]["message"], ["role": "user", "content": "/effort high"])
        XCTAssertEqual(adapter.transcript.session.effort.current, "high")
    }

    func testFollowAModeChangeTheCLIReportsByItself() throws {
        let adapter = try inTurn()
        _ = try adapter.received(json(["type": "system", "subtype": "status", "status": .null, "permissionMode": "plan"]))
        XCTAssertEqual(adapter.transcript.session.mode.current, "plan")
    }

    func testRefuseAResponseToARequestDevHubNeverMade() throws {
        let adapter = try inTurn()
        assertThrows(
            try adapter.received(ack("x:9")), #"control_response\.response\.request_id: expected a request DevHub made"#)
    }
}

final class ClaudeTurnEndTests: XCTestCase {
    func testRecordsAFailedTurnWithTheCLIsOwnWords() throws {
        let adapter = try inTurn()
        _ = try adapter.received(
            result(["subtype": "error_during_execution", "is_error": true, "errors": ["API Error: 500", "gave up"]]))
        let end = try XCTUnwrap(adapter.transcript.entries.last?.turnEndEntry)
        XCTAssertEqual(end.outcome, .failed)
        XCTAssertEqual(end.detail, "API Error: 500\ngave up")
        XCTAssertEqual(conversationStatus(adapter.transcript), .error)
    }

    func testFallsBackToTheResultTextAsTheDetail() throws {
        let adapter = try inTurn()
        _ = try adapter.received(result(["is_error": true, "result": "Credit balance is too low"]))
        XCTAssertEqual(adapter.transcript.entries.last?.turnEndEntry?.detail, "Credit balance is too low")
    }

    func testShowsAnAPIErrorTheAssistantMessageStandsFor() throws {
        let adapter = try inTurn()
        // Any error but the one that means "not signed in".
        _ = try adapter.received(
            assistantLine("m", [["type": "text", "text": "API Error: Rate limit reached"]], nil, ["error": "rate_limit"]))
        let notice = try XCTUnwrap(adapter.transcript.entries.last?.noticeEntry)
        XCTAssertEqual(notice.level, .error)
        XCTAssertEqual(notice.text, "The API refused the request: rate_limit")
        XCTAssertEqual(adapter.transcript.state, .ready(turn: .running))
    }
}

final class ClaudeCannotWorkTests: XCTestCase {
    func testIsNotSignedInWhenTheAPIRefusesItAsUnauthenticated() throws {
        let adapter = try inTurn()
        _ = try adapter.received(
            assistantLine(
                "m", [["type": "text", "text": "Invalid API key · Please run /login"]], nil,
                ["error": "authentication_failed"]))
        XCTAssertEqual(
            adapter.transcript.state,
            .broken(
                ConversationFailure(
                    code: .notSignedIn,
                    detail:
                        "claude said: “Invalid API key · Please run /login”. Sign in with `claude auth login` (or `/login` in claude) in a terminal on this Agent's machine, then try again."
                )))
        // The turn still ends, and the conversation stays broken past it.
        _ = try adapter.received(result(["is_error": true, "result": "Invalid API key"]))
        XCTAssertEqual(adapter.transcript.state.phase, "broken")
        // What the CLI said is still in the transcript, in its own words.
        XCTAssertEqual(
            adapter.transcript.entries.first { $0.kind == "assistant" }?.assistantEntry?.blocks,
            [.text(markdown: "Invalid API key · Please run /login")])
    }

    func testGoesOnAfterARestartOnceSignedOut() throws {
        let adapter = try inTurn()
        _ = try adapter.received(
            assistantLine("m", [["type": "text", "text": "OAuth token has expired"]], nil, ["error": "authentication_failed"]))
        _ = try adapter.received(result(["is_error": true, "result": "OAuth token has expired"]))
        XCTAssertEqual(adapter.transcript.state.phase, "broken")
        XCTAssertEqual(try adapter.restart(), RestartPlan(session: ["--resume", SESSION], mark: [RESTART_MARK]))
        let step = try adapter.received(RESTART_MARK)
        XCTAssertEqual(adapter.transcript.state, .ready(turn: .rewinding))
        XCTAssertEqual(parsed(step.replies).map { $0["type"] }, ["control_request"])
        XCTAssertEqual(parsed(step.replies)[0]["request"]?["subtype"], "initialize")
        for line in step.replies { _ = try adapter.sent(line) }
        let initialize = try XCTUnwrap(parsed(step.replies)[0]["request_id"]?.stringValue)
        _ = try adapter.received(controlResponse(initialize, ["commands": [], "models": []]))
        XCTAssertEqual(adapter.transcript.state, .ready(turn: .none))
    }

    func testRefusedTheConversationWhenItRefusesTheHandshake() throws {
        let adapter = ClaudeAdapter(bootId: "boot")
        for line in try adapter.opening() { _ = try adapter.sent(line) }
        _ = try adapter.received(controlResponse("boot:1", error: "unsupported protocol"))
        XCTAssertEqual(
            adapter.transcript.state,
            .broken(ConversationFailure(code: .refused, detail: "claude refused the handshake: unsupported protocol")))
    }
}

final class ClaudeSystemEventTests: XCTestCase {
    func testShowAnAPIRetryAsAWarning() throws {
        let adapter = try inTurn()
        _ = try adapter.received(
            json([
                "type": "system", "subtype": "api_retry", "attempt": 2, "max_retries": 10, "retry_delay_ms": 4000,
                "error_status": 529,
            ]))
        let notice = try XCTUnwrap(adapter.transcript.entries.last?.noticeEntry)
        XCTAssertEqual(notice.level, .warning)
        XCTAssertEqual(notice.text, "The API request failed (529); retrying in 4s (attempt 2 of 10)")
    }

    func testShowABackgroundTasksEndOnTheCallThatStartedIt() throws {
        let adapter = try inTurn()
        _ = try adapter.received(
            assistantLine("m", [toolUse("toolu_bg", "Bash", ["command": "npm test", "run_in_background": true])]))
        _ = try adapter.received(
            json([
                "type": "system", "subtype": "task_notification", "tool_use_id": "toolu_bg", "status": "completed",
                "summary": "npm test finished",
            ]))
        XCTAssertEqual(
            try toolOf(adapter, "tool:toolu_bg").background, BackgroundTask(state: .completed, summary: "npm test finished"))
        XCTAssertEqual(adapter.transcript.entries.filter { $0.kind == "notice" }, [])
    }

    func testMarkAFailedSubagentFailed() throws {
        let adapter = try inTurn()
        _ = try adapter.received(
            assistantLine("m", [toolUse("toolu_t", "Agent", ["description": "d", "prompt": "p", "subagent_type": "general"])]))
        _ = try adapter.received(
            json([
                "type": "system", "subtype": "task_notification", "tool_use_id": "toolu_t", "status": "failed",
                "summary": "crashed",
            ]))
        XCTAssertEqual(try toolOf(adapter, "tool:toolu_t").spawns?.state, .failed)
    }
}

final class ClaudeUnknownTests: XCTestCase {
    func testIsAWarningNoticeCarryingTheRawEventOncePerKind() throws {
        let adapter = try inTurn()
        let raw: JsonValue = ["type": "hologram", "payload": 1]
        _ = try adapter.received(json(raw))
        _ = try adapter.received(json(["type": "hologram", "payload": 2]))
        let notices = adapter.transcript.entries.compactMap(\.noticeEntry)
        XCTAssertEqual(notices.count, 1)
        XCTAssertNil(notices[0].parent)
        XCTAssertEqual(notices[0].level, .warning)
        XCTAssertEqual(notices[0].text, #"claude 2.1.0 printed a "hologram" event DevHub does not know"#)
        XCTAssertEqual(notices[0].raw, raw)
        XCTAssertEqual(conversationStatus(adapter.transcript), .working)
    }

    func testCoversStreamEventsDeltasAndContentBlocks() throws {
        let adapter = try inTurn()
        _ = try adapter.received(stream(["type": "message_start", "message": ["id": "m"]]))
        _ = try adapter.received(stream(["type": "content_block_start", "index": 0, "content_block": ["type": "text", "text": ""]]))
        _ = try adapter.received(stream(["type": "content_block_delta", "index": 0, "delta": ["type": "sparkle_delta"]]))
        _ = try adapter.received(stream(["type": "novel_event"]))
        _ = try adapter.received(assistantLine("m", [["type": "text", "text": ""], ["type": "hologram_block"]]))
        XCTAssertEqual(
            adapter.transcript.entries.compactMap(\.noticeEntry).map(\.text),
            [
                #"claude 2.1.0 printed a "delta/sparkle_delta" event DevHub does not know"#,
                #"claude 2.1.0 printed a "stream_event/novel_event" event DevHub does not know"#,
                #"claude 2.1.0 printed a "content/hologram_block" event DevHub does not know"#,
            ])
    }

    func testIsForASystemEventAQuietReportOncePerSubtype() throws {
        let adapter = try inTurn()
        let raw: JsonObject = ["type": "system", "subtype": "weather", "forecast": "sunny", "session_id": "s"]
        _ = try adapter.received(json(.object(raw)))
        _ = try adapter.received(json(.object(merged(raw, ["forecast": "rain"]))))
        let notices = adapter.transcript.entries.compactMap(\.noticeEntry)
        XCTAssertEqual(notices.count, 1)
        XCTAssertEqual(notices[0].level, .info)
        XCTAssertEqual(notices[0].text, #"claude 2.1.0 reported "weather""#)
        XCTAssertEqual(notices[0].raw, .object(raw))
    }

    func testStillBreaksTheConversationForASystemEventWithoutASubtype() throws {
        let adapter = try inTurn()
        XCTAssertThrowsError(try adapter.received(json(["type": "system", "session_id": "s"]))) {
            XCTAssertTrue($0 is ProtocolMismatch)
        }
    }

    func testIsNotRaisedForTheEventsDevHubKnowsAndDoesNotUse() throws {
        let adapter = try inTurn()
        _ = try adapter.received(json(["type": "prompt_suggestion", "suggestion": "next"]))
        _ = try adapter.received(
            json(["type": "tool_progress", "tool_use_id": "t", "tool_name": "Bash", "elapsed_time_seconds": 3]))
        _ = try adapter.received(stream(["type": "ping"]))
        // A SessionStart hook reports itself even without --include-hook-events,
        // and what it says is the owner's own configuration, not the conversation.
        _ = try adapter.received(
            json(["type": "system", "subtype": "hook_started", "hook_id": "h", "hook_name": "SessionStart:startup"]))
        _ = try adapter.received(json(["type": "system", "subtype": "hook_progress", "hook_id": "h"]))
        _ = try adapter.received(json(["type": "system", "subtype": "hook_response", "hook_id": "h", "output": "private"]))
        XCTAssertEqual(adapter.transcript.entries.filter { $0.kind == "notice" }, [])
    }

    func testIncludesAControlRequestDevHubDoesNotServe() throws {
        let adapter = try inTurn()
        let step = try adapter.received(
            json([
                "type": "control_request", "request_id": "cli-7",
                "request": ["subtype": "hook_callback", "callback_id": "h"],
            ]))
        XCTAssertEqual(
            parsed(step.replies),
            [
                [
                    "type": "control_response",
                    "response": [
                        "subtype": "error", "request_id": "cli-7",
                        "error": #"DevHub does not serve the control request "hook_callback""#,
                    ],
                ]
            ])
        XCTAssertEqual(adapter.transcript.entries.last?.noticeEntry?.level, .warning)
        XCTAssertEqual(try adapter.sent(step.replies[0]).events, [])
    }
}

// Port of apps/desktop/src/main/agent/conversation/claude/adapter.test.ts (5/6)

import XCTest
@testable import DevHubCore

/// `json({ ...JSON.parse(line), ...fields })`.
func withFields(_ line: String, _ fields: JsonObject) -> String {
    json(.object(merged((try? JsonValue.parse(line))?.objectValue ?? [:], fields)))
}

func historyOf(_ name: String) throws -> [String] {
    try claudeHistoryLines(session: SESSION, text: Fixtures.text("conversation", name))
}

private func spawnStates(_ adapter: ClaudeAdapter) -> [String] {
    adapter.transcript.entries.compactMap { each in
        guard let tool = each.toolEntry, let spawns = tool.spawns else { return nil }
        return "\(tool.id) \(spawns.state.rawValue)"
    }
}

private let launched: JsonObject = ["tool_use_result": ["isAsync": true, "status": "async_launched", "agentId": "agent-1"]]

final class ClaudeSubagentEndTests: XCTestCase {
    // `claude-session-background-agents.handwritten.jsonl` is HAND-WRITTEN,
    // shaped from what claude 2.1.x writes: background Agent calls whose
    // results only say they launched (`toolUseResult.status`
    // "async_launched"), a foreground one whose result is its end, and the
    // ends of two background ones as `<task-notification>`s — one a meta user
    // message naming the call, one a queued command naming only the task.
    // One background subagent's end is recorded nowhere.
    func resumed() throws -> ClaudeAdapter {
        let adapter = ClaudeAdapter(bootId: "boot")
        for line in try historyOf("claude-session-background-agents.handwritten.jsonl") { _ = try adapter.received(line) }
        return adapter
    }

    func testIsReadBackFromASessionFileAsRecordedOrUnknownNeverRunning() throws {
        let adapter = try resumed()
        XCTAssertEqual(
            spawnStates(adapter),
            ["tool:toolu_a completed", "tool:toolu_b unknown", "tool:toolu_c completed", "tool:toolu_d failed"])
        // A notification is nobody's words: no bubble, no notice.
        XCTAssertEqual(adapter.transcript.entries.compactMap(\.userEntry).map(\.text), ["Survey A to D", "And D?"])
        XCTAssertEqual(adapter.transcript.entries.filter { $0.kind == "notice" }, [])
    }

    func testIsTakenFromANotificationThatNamesOnlyTheTaskABackgroundCallLaunched() throws {
        let adapter = try inTurn()
        _ = try adapter.received(
            assistantLine("m", [toolUse("toolu_bg", "Agent", ["description": "d", "prompt": "p", "subagent_type": "general"])]))
        _ = try adapter.received(withFields(toolResult("toolu_bg", "Async agent launched"), launched))
        XCTAssertEqual(spawnStates(adapter), ["tool:toolu_bg running"])
        _ = try adapter.received(
            json([
                "type": "system", "subtype": "task_notification", "task_id": "agent-1", "status": "completed",
                "summary": "done",
            ]))
        XCTAssertEqual(spawnStates(adapter), ["tool:toolu_bg completed"])
    }

    func testIsUnknownOnceTheCLIRunningItIsReplaced() throws {
        let adapter = try inTurn()
        _ = try adapter.received(
            assistantLine("m", [toolUse("toolu_bg", "Agent", ["description": "d", "prompt": "p", "subagent_type": "general"])]))
        _ = try adapter.received(withFields(toolResult("toolu_bg", "Async agent launched"), launched))
        _ = try adapter.received(result())
        try carryOut(adapter, send("next"))
        _ = try adapter.received(echo("next", "u-next"))
        _ = try adapter.received(result())
        _ = try adapter.received(json(["type": "devhub_rewind", "message": "user:u-next"]))
        XCTAssertEqual(spawnStates(adapter), ["tool:toolu_bg unknown"])
    }
}

final class ClaudeResumedHistoryTests: XCTestCase {
    // The lines `claudeHistoryLines` makes of the hand-written session file
    // (`claude-session-file.handwritten.jsonl`), put before the CLI's own.
    func resumed() throws -> ClaudeAdapter {
        let adapter = ClaudeAdapter(bootId: "boot")
        for line in try historyOf("claude-session-file.handwritten.jsonl") { _ = try adapter.received(line) }
        return adapter
    }

    func testDrawsThePastAsTheSameEntriesALiveTurnMakes() throws {
        let adapter = try resumed()
        let u2 = try XCTUnwrap(try entry(adapter, "user:u2").userEntry)
        XCTAssertEqual(u2.text, "List the files in src")
        XCTAssertEqual(u2.origin, .person)
        XCTAssertEqual(try entry(adapter, "user:u6").userEntry?.text, "Now read main.ts")
        let tools = adapter.transcript.entries.compactMap(\.toolEntry)
        XCTAssertEqual(tools.count, 1)
        XCTAssertEqual(tools[0].status, .succeeded)
        guard case .command(_, let output, _, _)? = tools[0].output?.first else { return XCTFail("no command output") }
        XCTAssertEqual(output, "main.ts")
        XCTAssertEqual(
            adapter.transcript.entries.compactMap(\.assistantEntry).flatMap(\.blocks),
            [
                .thinking(text: "Use ls."), .text(markdown: "There is one file: main.ts."),
                .text(markdown: "It is empty."),
            ])
        XCTAssertTrue(adapter.transcript.entries.allSatisfy { !($0.assistantEntry?.streaming ?? false) })
        // Nothing of the past is a notice: it is what was said, not news.
        XCTAssertEqual(adapter.transcript.entries.filter { $0.kind == "notice" }, [])
    }

    func testIsOnTheModelItWasSavedWith() throws {
        let adapter = try resumed()
        XCTAssertEqual(adapter.transcript.session.model.current, "claude-sonnet-5")
        XCTAssertNil(adapter.transcript.session.effort.current)
    }

    func testIsNoTurnRunningNow() throws {
        let adapter = try resumed()
        XCTAssertEqual(adapter.transcript.state.phase, "connecting")
        _ = try adapter.received(initLine())
        XCTAssertEqual(adapter.transcript.state, .ready(turn: .none))
    }
}

final class ClaudeRewindTests: XCTestCase {
    func text(_ words: String) -> JsonValue { ["type": "text", "text": .string(words)] }

    /// Two whole turns, "first" and "second", on a CLI that can resume at a message.
    func twoTurns(_ version: String = "2.1.282") throws -> ClaudeAdapter {
        let adapter = ClaudeAdapter(bootId: "boot")
        _ = try adapter.received(initLine(["claude_code_version": .string(version)]))
        try carryOut(adapter, send("first"))
        _ = try adapter.received(echo("first", "u1"))
        _ = try adapter.received(assistantLine("msg_1", [text("one")], nil, ["uuid": "a1"]))
        _ = try adapter.received(result())
        try carryOut(adapter, send("second"))
        _ = try adapter.received(echo("second", "u2"))
        _ = try adapter.received(assistantLine("msg_2", [text("two")], nil, ["uuid": "a2"]))
        _ = try adapter.received(result())
        return adapter
    }

    func restartPlan(_ plan: RewindPlan) throws -> RestartPlan {
        guard case .restart(let restart) = plan else {
            XCTFail("not a restart")
            throw AdapterRefusal("not a restart")
        }
        return restart
    }

    func testStartsTheCLIAgainOnTheSessionCutShortAndDropsTheTurnWhenTheMarkComesBack() throws {
        let adapter = try twoTurns()
        XCTAssertTrue(adapter.transcript.session.canRewind)
        let plan = try restartPlan(try adapter.rewind("user:u2"))
        XCTAssertEqual(
            plan,
            RestartPlan(
                session: ["--resume", SESSION, "--resume-session-at", "a1"],
                mark: [json(["type": "devhub_rewind", "message": "user:u2"])]))
        // Nothing changes until the host says the CLI was started again.
        XCTAssertTrue(ids(adapter).contains("user:u2"))
        let step = try adapter.received(plan.mark[0])
        XCTAssertTrue(step.events.contains(.rewound(from: "user:u2")))
        XCTAssertEqual(ids(adapter), ["user:u1", "assistant:msg_1:0", "turn:1"])
        XCTAssertEqual(adapter.transcript.state, .ready(turn: .rewinding))
        // The new CLI is greeted, as a reply: once, and not again on a replay.
        let greetings = parsed(step.replies)
        XCTAssertEqual(greetings.count, 1)
        XCTAssertEqual(greetings[0]["type"], "control_request")
        XCTAssertEqual(greetings[0]["request"], ["subtype": "initialize"])
        let requestId = try XCTUnwrap(greetings[0]["request_id"]?.stringValue)
        XCTAssertNotNil(requestId.range(of: #"^boot:\d+$"#, options: .regularExpression))
        for line in step.replies { _ = try adapter.sent(line) }
        _ = try adapter.received(controlResponse(requestId, ["commands": [], "models": []]))
        XCTAssertEqual(adapter.transcript.state, .ready(turn: .none))

        try carryOut(adapter, send("second, again"))
        _ = try adapter.received(echo("second, again", "u3"))
        XCTAssertEqual(try entry(adapter, "user:u3").userEntry?.text, "second, again")
        // And that message is the one to take back next, from the same anchor.
        _ = try adapter.received(result())
        XCTAssertEqual(
            try restartPlan(try adapter.rewind("user:u3")).session, ["--resume", SESSION, "--resume-session-at", "a1"])
    }

    func testStartsAFreshSessionWhenTheMessageWasTheFirst() throws {
        let adapter = ClaudeAdapter(bootId: "boot")
        _ = try adapter.received(initLine(["claude_code_version": "2.1.282"]))
        try carryOut(adapter, send("first"))
        _ = try adapter.received(echo("first", "u1"))
        _ = try adapter.received(result())
        XCTAssertEqual(try restartPlan(try adapter.rewind("user:u1")).session, [])
    }

    func testResumesAtTheLastMessageOfAResumedSessionsPast() throws {
        let adapter = ClaudeAdapter(bootId: "boot")
        let history = try historyOf("claude-session-file.handwritten.jsonl")
        for line in history { _ = try adapter.received(line) }
        _ = try adapter.received(initLine(["claude_code_version": "2.1.282"]))
        try carryOut(adapter, send("next"))
        _ = try adapter.received(echo("next", "u9"))
        _ = try adapter.received(result())
        let last = try XCTUnwrap(parsed([try XCTUnwrap(history.last)])[0]["record"]?["uuid"]?.stringValue)
        XCTAssertEqual(
            try restartPlan(try adapter.rewind("user:u9")).session, ["--resume", SESSION, "--resume-session-at", last])
    }

    func testIsNotOfferedByACLITooOldToResumeAtAMessage() throws {
        let adapter = try twoTurns("2.1.222")
        XCTAssertFalse(adapter.transcript.session.canRewind)
        assertThrows(
            try adapter.rewind("user:u2"),
            #"claude 2\.1\.222 cannot take back a turn: resuming at a message needs 2\.1\.223 or later"#)
    }

    func testGoesBackToBeforeAnEarlierMessageToo() throws {
        let adapter = try twoTurns()
        XCTAssertEqual(rewindTargets(adapter.transcript), ["user:u1", "user:u2"])
        let plan = try restartPlan(try adapter.rewind("user:u1"))
        // The first message has nothing before it: a fresh session.
        XCTAssertEqual(plan.session, [])
        _ = try adapter.received(plan.mark[0])
        XCTAssertEqual(adapter.transcript.entries, [])

        let three = try twoTurns()
        try carryOut(three, send("third"))
        _ = try three.received(echo("third", "u3"))
        _ = try three.received(result())
        let cut = try restartPlan(try three.rewind("user:u2"))
        XCTAssertEqual(cut.session, ["--resume", SESSION, "--resume-session-at", "a1"])
        _ = try three.received(cut.mark[0])
        XCTAssertEqual(ids(three), ["user:u1", "assistant:msg_1:0", "turn:1"])
    }

    func testRefusesAMessageThatIsNotARewindTargetNow() throws {
        let adapter = try twoTurns()
        try carryOut(adapter, send("third"))
        _ = try adapter.received(echo("third", "u3"))
        assertThrows(try adapter.rewind("user:u1"), "user:u1 is not a message the conversation can be rewound to now")
    }

    func testRefusesAMarkForAMessageThatIsNotInTheConversation() throws {
        let adapter = try twoTurns()
        assertThrows(
            try adapter.received(json(["type": "devhub_rewind", "message": "user:nope"])), "user:nope, which is not an entry")
    }
}

final class ClaudeMidTurnMessageTests: XCTestCase {
    func testIsQueuedForTheTurnsNextStepAndOneBetweenTurnsStartsOne() throws {
        let adapter = ClaudeAdapter(bootId: "boot")
        _ = try adapter.received(initLine())
        let idle = try adapter.encode(send("go"))
        XCTAssertNil(parsed(idle)[0]["priority"])
        try carryOut(adapter, send("go"))
        _ = try adapter.received(echo("go", "u1"))
        let midTurn = parsed(try adapter.encode(send("and also this")))[0]
        XCTAssertEqual(midTurn["type"], "user")
        XCTAssertEqual(midTurn["priority"], "next")
        XCTAssertEqual(midTurn["message"]?["content"], "and also this")
        // It is the person's like any other once the CLI takes it.
        try carryOut(adapter, send("and also this"))
        _ = try adapter.received(echo("and also this", "u2"))
        let user = try XCTUnwrap(try entry(adapter, "user:u2").userEntry)
        XCTAssertEqual(user.origin, .person)
        XCTAssertTrue(user.rewindable)
    }

    func testASubagentTakesNoMessageFromThePerson() throws {
        let adapter = ClaudeAdapter(bootId: "boot")
        _ = try adapter.received(initLine())
        assertThrows(try adapter.encode(.instruct(subagent: "tool:toolu_1", text: "look deeper")), "no way to say something to a subagent")
    }
}

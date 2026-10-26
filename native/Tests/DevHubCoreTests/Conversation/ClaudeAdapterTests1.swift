// Port of apps/desktop/src/main/agent/conversation/claude/adapter.test.ts (1/6)
//
// Claude's stream-json, read into the normalized conversation and written
// back from DevHub's commands. The fixtures are whole turns in the order the
// lines happened, shared with the TS app; the rest are single lines around a
// state built from them.

import XCTest
@testable import DevHubCore

final class ClaudeAdapterHandshakeTests: XCTestCase {
    func testOpensWithAnInitializeRequestNamedByThisBoot() throws {
        let adapter = ClaudeAdapter(bootId: "boot-a")
        XCTAssertEqual(
            parsed(try adapter.opening()),
            [["type": "control_request", "request_id": "boot-a:1", "request": ["subtype": "initialize"]]])
    }

    func testWritesTheSameLinesThePermissionFixtureRecorded() throws {
        let adapter = ClaudeAdapter(bootId: "boot-a")
        let recorded = fixture("claude-permission-turn.ndjson").filter { $0.side == .sent }
        XCTAssertEqual(try adapter.opening(), [recorded[0].line])
    }

    func testIsConnectingUntilTheCLISaysItIsUp() throws {
        let adapter = ClaudeAdapter(bootId: "boot")
        XCTAssertEqual(adapter.transcript.state, .connecting)
        _ = try adapter.received(initLine())
        XCTAssertEqual(adapter.transcript.state, .ready(turn: .none))
    }

    func testIsReadyOnTheInitializeResponseToo() throws {
        let fresh = ClaudeAdapter(bootId: "boot")
        for line in try fresh.opening() { _ = try fresh.sent(line) }
        _ = try fresh.received(controlResponse("boot:1", ["commands": [], "models": []]))
        XCTAssertEqual(fresh.transcript.state, .ready(turn: .none))
    }

    func testLearnsTheSessionFromSystemInit() throws {
        let adapter = ClaudeAdapter(bootId: "boot")
        _ = try adapter.received(initLine())
        let session = adapter.transcript.session
        XCTAssertEqual(session.sessionId, SESSION)
        XCTAssertEqual(session.cwd, "/home/testuser/project")
        XCTAssertEqual(session.agentVersion, "2.1.0")
        XCTAssertEqual(session.model.current, "claude-sonnet-5")
        XCTAssertEqual(session.mode.current, "default")
        XCTAssertTrue(session.mode.choices.map(\.id).contains("acceptEdits"))
        XCTAssertEqual(
            session.commands,
            [
                slash("review"), slash("model", "", nil, .model), slash("effort", "", nil, .effort),
                slash("permissions", "", nil, .mode), DEVHUB_RESUME, DEVHUB_RESTART, DEVHUB_MCP,
            ])
    }
}

final class ClaudePermissionFixtureTests: XCTestCase {
    let lines = fixture("claude-permission-turn.ndjson")

    func played() throws -> ClaudeAdapter {
        let adapter = ClaudeAdapter(bootId: "boot-a")
        try play(adapter, lines)
        return adapter
    }

    private let fixtureUsage = Usage(
        inputTokens: 1500, outputTokens: 80, cachedInputTokens: 1200, costUsd: 0.0123,
        rateLimits: [RateLimit(window: "5-hour", durationMinutes: 300, usedPercent: 25, resetsAt: 1_800_000_000_000)])

    func testEndsInOneIdleTranscript() throws {
        let adapter = try played()
        XCTAssertEqual(
            adapter.transcript.entries,
            [
                .user(
                    UserEntry(
                        id: "user:00000000-0000-4000-8000-0000000000a1", text: "Run pwd with Bash", origin: .person,
                        rewindable: true)),
                .assistant(
                    AssistantEntry(
                        id: "assistant:msg_01:0",
                        blocks: [.thinking(text: "The user wants pwd."), .text(markdown: "I'll run `pwd`.")],
                        streaming: false)),
                .tool(
                    ToolEntry(
                        id: "tool:toolu_01", tool: "Bash", title: "Bash: pwd",
                        input: ["command": "pwd", "description": "Print the working directory"], status: .succeeded,
                        output: [.text("/home/testuser/project")])),
                .assistant(
                    AssistantEntry(
                        id: "assistant:msg_02:0", blocks: [.text(markdown: "You are in `/home/testuser/project`.")],
                        streaming: false)),
                .turnEnd(TurnEndEntry(id: "turn:1", outcome: .completed, usage: fixtureUsage, durationMs: 4210)),
            ])
        XCTAssertEqual(adapter.transcript.requests, [])
        XCTAssertEqual(adapter.transcript.state, .ready(turn: .none))
        XCTAssertEqual(conversationStatus(adapter.transcript), .idle)
    }

    func testCarriesTheCommandsAndModelsTheInitializeResponseListed() throws {
        let session = try played().transcript.session
        XCTAssertEqual(
            session.commands,
            [
                slash("review", "Review a pull request", "<pr>"), slash("model", "Set the AI model", nil, .model),
                slash("compact", "Compact the conversation", "[instructions]"), slash("init"), DEVHUB_RESUME,
                DEVHUB_RESTART, DEVHUB_MCP,
            ])
        // This handshake names no `resolvedModel`, so no choice is known to be
        // the session's model: it is a choice of its own.
        XCTAssertEqual(
            session.model,
            Setting(
                current: "claude-sonnet-5",
                choices: [
                    SettingChoice(id: "claude-sonnet-5", label: "claude-sonnet-5", resolved: "claude-sonnet-5"),
                    SettingChoice(id: "default", label: "default", detail: "Default"),
                    SettingChoice(id: "sonnet", label: "sonnet", detail: "Sonnet"),
                ]))
    }

    func testKeepsTheUsageOfTheConversation() throws {
        XCTAssertEqual(try played().transcript.usage, fixtureUsage)
    }

    func testStreamsTheAssistantMessageBlockByBlockBeforeItIsFinal() throws {
        let adapter = ClaudeAdapter(bootId: "boot-a")
        let upToSecondDelta = try XCTUnwrap(lines.firstIndex { $0.line.contains(#"`pwd`."}}"#) })
        try play(adapter, Array(lines[...upToSecondDelta]))
        XCTAssertEqual(
            try entry(adapter, "assistant:msg_01:0"),
            .assistant(
                AssistantEntry(
                    id: "assistant:msg_01:0",
                    blocks: [.thinking(text: "The user wants pwd."), .text(markdown: "I'll run `pwd`.")], streaming: true)))
        XCTAssertEqual(adapter.transcript.state, .ready(turn: .running))
        XCTAssertEqual(conversationStatus(adapter.transcript), .working)
    }

    func testSendsTheTextOfADeltaAsADelta() throws {
        let events = try play(ClaudeAdapter(bootId: "boot-a"), lines)
        XCTAssertTrue(events.contains(.textDelta(entry: "assistant:msg_01:0", block: 1, text: "I'll run ")))
    }

    func testShowsTheToolRunningFromTheMomentItsBlockStarts() throws {
        let adapter = ClaudeAdapter(bootId: "boot-a")
        let toolStart = try XCTUnwrap(lines.firstIndex { $0.line.contains(#""content_block_start","index":2"#) })
        try play(adapter, Array(lines[...toolStart]))
        let tool = try toolOf(adapter, "tool:toolu_01")
        XCTAssertEqual(tool.status, .running)
        XCTAssertEqual(tool.title, "Bash")
        XCTAssertEqual(tool.input, .object(JsonObject()))
    }

    func testWaitsOnThePermissionRequestUntilDevHubAnswers() throws {
        let adapter = ClaudeAdapter(bootId: "boot-a")
        let asked = try XCTUnwrap(lines.firstIndex { $0.line.contains("can_use_tool") })
        try play(adapter, Array(lines[...asked]))
        XCTAssertEqual(
            adapter.transcript.requests,
            [
                PendingRequest(
                    id: "perm-1", entry: "tool:toolu_01",
                    subject: .tool(
                        tool: "Bash", title: "Bash: pwd",
                        input: ["command": "pwd", "description": "Print the working directory"], reason: nil),
                    choices: [
                        RequestChoice(id: "allow", label: "Allow once", tone: .allow, takesText: false),
                        RequestChoice(id: "suggestion:0", label: "Always allow Bash(pwd)", tone: .allow, takesText: false),
                        RequestChoice(id: "deny", label: "Deny", tone: .deny, takesText: true),
                    ])
            ])
        XCTAssertEqual(conversationStatus(adapter.transcript), .waiting)
        let answer = try adapter.encode(.answer(request: "perm-1", answer: .choice(choiceId: "allow", text: nil)))
        XCTAssertEqual(answer, [lines[asked + 1].line])
        XCTAssertEqual(adapter.transcript.requests.count, 1)
        _ = try adapter.sent(answer[0])
        XCTAssertEqual(adapter.transcript.requests, [])
    }

    func testWritesTheUserMessageTheFixtureRecorded() throws {
        let adapter = ClaudeAdapter(bootId: "boot-a")
        XCTAssertEqual(
            try adapter.encode(send("Run pwd with Bash")),
            [try XCTUnwrap(lines.first { $0.side == .sent && $0.line.contains(#""type":"user""#) }).line])
    }

    func testFoldsToTheSameTranscriptWhetherReplayedOrFollowedLive() throws {
        let live = ClaudeAdapter(bootId: "boot-a")
        let liveEvents = try play(live, lines)
        let replayed = ClaudeAdapter(bootId: "boot-b")
        try play(replayed, lines)
        XCTAssertEqual(replayed.transcript, live.transcript)
        XCTAssertGreaterThan(liveEvents.count, 0)
    }
}

final class ClaudeSubagentFixtureTests: XCTestCase {
    func played() throws -> ClaudeAdapter {
        let adapter = ClaudeAdapter(bootId: "boot")
        try play(adapter, fixture("claude-subagent-turn.ndjson"))
        return adapter
    }

    func testHangsTheSubagentsMessagesUnderTheTaskCall() throws {
        let transcript = try played().transcript
        XCTAssertEqual(
            childrenOf(transcript, nil).map(\.id.raw),
            ["user:00000000-0000-4000-8000-0000000000c1", "tool:toolu_task", "assistant:msg_11:0", "turn:1"])
        XCTAssertEqual(
            childrenOf(transcript, "tool:toolu_task").map(\.id.raw),
            ["assistant:msg_s1:0", "tool:toolu_grep", "assistant:msg_s2:0"])
    }

    func testDescribesTheSubagentAndFollowsItsLifecycle() throws {
        let adapter = try played()
        let task = try toolOf(adapter, "tool:toolu_task")
        XCTAssertEqual(task.tool, "Task")
        XCTAssertEqual(task.title, "Task: Find the reducer")
        XCTAssertEqual(task.status, .succeeded)
        XCTAssertEqual(task.spawns?.label, "Explore")
        XCTAssertEqual(task.spawns?.prompt, "Look for applyEvent")
        XCTAssertEqual(task.spawns?.model, "haiku")
        XCTAssertEqual(task.spawns?.state, .completed)
        let grep = try toolOf(adapter, "tool:toolu_grep")
        XCTAssertEqual(grep.parent, "tool:toolu_task")
        XCTAssertEqual(grep.title, "Grep: applyEvent")
        XCTAssertEqual(grep.status, .succeeded)
        XCTAssertEqual(grep.output, [.text("src/model/conversation.ts")])
    }

    func testMarksTheSubagentRunningWhileItsTaskRuns() throws {
        let adapter = ClaudeAdapter(bootId: "boot")
        let lines = fixture("claude-subagent-turn.ndjson")
        try play(adapter, Array(lines[...(try XCTUnwrap(lines.firstIndex { $0.line.contains("task_started") }))]))
        XCTAssertEqual(try toolOf(adapter, "tool:toolu_task").spawns?.state, .running)
    }

    func testKeepsTheOriginDevHubWrote() throws {
        let user = try XCTUnwrap(try entry(try played(), "user:00000000-0000-4000-8000-0000000000c1").userEntry)
        XCTAssertEqual(user.origin, .injection)
        XCTAssertEqual(user.text, "Find the reducer")
    }

    func testDoesNotRepeatTheSubagentsPromptAsAUserMessage() throws {
        XCTAssertEqual(try played().transcript.entries.filter { $0.kind == "user" }.count, 1)
    }

    func testTakesTheModeSystemInitReports() throws {
        XCTAssertEqual(try played().transcript.session.mode.current, "acceptEdits")
    }
}

final class ClaudeContextUsageTests: XCTestCase {
    func withUsage(_ messageId: String, _ parent: String?, _ model: String, _ usage: JsonObject) -> String {
        json([
            "type": "assistant",
            "message": [
                "id": .string(messageId), "role": "assistant", "model": .string(model),
                "content": [["type": "text", "text": "ok"]], "usage": .object(usage),
            ],
            "parent_tool_use_id": parent.map(JsonValue.string) ?? .null, "session_id": .string(SESSION),
        ])
    }

    func testIsTheLatestTopLevelMessagesTokensAgainstTheWindowOfItsModel() throws {
        let adapter = try inTurn()
        _ = try adapter.received(
            withUsage(
                "m1", nil, "claude-example-1",
                ["input_tokens": 10, "cache_creation_input_tokens": 1000, "cache_read_input_tokens": 20_000, "output_tokens": 90]))
        // Known as soon as the message is: before the turn has ended.
        XCTAssertEqual(adapter.transcript.usage?.contextTokens, 21_100)
        XCTAssertNil(adapter.transcript.usage?.contextWindow)
        _ = try adapter.received(
            result([
                "modelUsage": [
                    "claude-example-1": ["contextWindow": 200_000], "claude-example-small": ["contextWindow": 100_000],
                ]
            ]))
        XCTAssertEqual(adapter.transcript.usage?.contextTokens, 21_100)
        XCTAssertEqual(adapter.transcript.usage?.contextWindow, 200_000)
    }
}

final class ClaudeUserMessageTests: XCTestCase {
    func testWritesTheTextMarkedWithWhoMadeTheAgentSayIt() throws {
        let adapter = ClaudeAdapter(bootId: "boot")
        let lines = try adapter.encode(send("/review 12", .injection))
        XCTAssertEqual(
            parsed(lines),
            [
                [
                    "type": "user", "message": ["role": "user", "content": "/review 12"], "parent_tool_use_id": .null,
                    "session_id": "", "devhub_origin": "injection",
                ]
            ])
    }

    func testAppearWhenTheCLITakesThemInATurnUnderWayFromTheWrite() throws {
        let adapter = ClaudeAdapter(bootId: "boot")
        _ = try adapter.received(initLine())
        try carryOut(adapter, send("hello"))
        XCTAssertEqual(adapter.transcript.entries, [])
        XCTAssertEqual(adapter.transcript.state, .ready(turn: .running))
        _ = try adapter.received(echo("hello", "u1"))
        let user = try XCTUnwrap(try entry(adapter, "user:u1").userEntry)
        XCTAssertEqual(user.text, "hello")
        XCTAssertEqual(user.origin, .person)
        XCTAssertEqual(adapter.transcript.state, .ready(turn: .running))
    }

    func testAreMatchedToWhatDevHubSentInOrder() throws {
        let adapter = ClaudeAdapter(bootId: "boot")
        _ = try adapter.received(initLine())
        try carryOut(adapter, send("same", .injection))
        try carryOut(adapter, send("same"))
        _ = try adapter.received(echo("same", "u1"))
        _ = try adapter.received(echo("same", "u2"))
        XCTAssertEqual(try entry(adapter, "user:u1").userEntry?.origin, .injection)
        XCTAssertEqual(try entry(adapter, "user:u2").userEntry?.origin, .person)
    }

    func testThatDevHubDidNotSendAreNotThePersons() throws {
        func playing(_ adapter: ClaudeAdapter) throws -> [[String]] {
            _ = try adapter.received(initLine())
            try carryOut(adapter, send("go"))
            _ = try adapter.received(echo("go", "u-go"))
            _ = try adapter.received(echo("A message another session sent to this one.", "u9"))
            return adapter.transcript.entries.map { each in
                if case .user(let user) = each { return [user.text, user.origin.rawValue] }
                return [each.kind]
            }
        }
        let drawn = [["go", "person"], ["A message another session sent to this one.", "other"]]
        XCTAssertEqual(try playing(ClaudeAdapter(bootId: "boot")), drawn)
        // A replay feeds the journal and `in.log` back through the same path.
        XCTAssertEqual(try playing(ClaudeAdapter(bootId: "boot")), drawn)
    }

    func testReadBackFromASessionFileAreThePersons() throws {
        let adapter = ClaudeAdapter(bootId: "boot")
        _ = try adapter.received(
            json([
                "type": "devhub_history",
                "record": ["type": "user", "uuid": "u1", "message": ["role": "user", "content": "an earlier message"]],
            ]))
        XCTAssertEqual(adapter.transcript.entries.count, 1)
        XCTAssertEqual(adapter.transcript.entries[0].userEntry?.text, "an earlier message")
        XCTAssertEqual(adapter.transcript.entries[0].userEntry?.origin, .person)
    }
}

final class ClaudeToolCallTests: XCTestCase {
    func testEndFailedWhenTheResultIsAnError() throws {
        let adapter = try inTurn()
        _ = try adapter.received(assistantLine("m", [toolUse("toolu_1", "Read", ["file_path": "src/x.ts"])]))
        _ = try adapter.received(toolResult("toolu_1", "File does not exist.", true))
        let tool = try toolOf(adapter, "tool:toolu_1")
        XCTAssertEqual(tool.title, "Read: src/x.ts")
        XCTAssertEqual(tool.status, .failed)
        XCTAssertEqual(tool.output, [.text("File does not exist.")])
    }

    func testRefuseAResultForAToolCallNobodyMade() throws {
        let adapter = try inTurn()
        XCTAssertThrowsError(try adapter.received(toolResult("toolu_ghost", "x"))) { error in
            XCTAssertTrue(error is ProtocolMismatch)
        }
    }

    func testKeepTextAndToolCallsOfOneMessageInOrder() throws {
        let adapter = try inTurn()
        _ = try adapter.received(
            assistantLine(
                "m",
                [
                    ["type": "text", "text": "First."], toolUse("toolu_1", "Bash", ["command": "ls"]),
                    ["type": "text", "text": "Then."],
                ]))
        XCTAssertEqual(Array(ids(adapter).dropFirst()), ["assistant:m:0", "tool:toolu_1", "assistant:m:2"])
    }
}

final class ClaudePermissionRequestTests: XCTestCase {
    func testOfferAllowingOnceEachSuggestionAndDenying() throws {
        let adapter = try askingForBash()
        let request = try XCTUnwrap(adapter.transcript.requests.first)
        guard case .tool(_, _, _, let reason) = request.subject else { return XCTFail("not a tool request") }
        XCTAssertEqual(reason, "rm is not in the allow list")
        XCTAssertEqual(
            request.choices.map(\.label), ["Allow once", "Always allow Bash(rm -rf build)", "Switch to acceptEdits", "Deny"])
    }

    func testCarryAChosenSuggestionBackAsThePermissionUpdate() throws {
        let adapter = try askingForBash()
        let lines = try adapter.encode(.answer(request: "perm", answer: .choice(choiceId: "suggestion:0", text: nil)))
        XCTAssertEqual(
            parsed(lines),
            [
                [
                    "type": "control_response",
                    "response": [
                        "subtype": "success", "request_id": "perm",
                        "response": [
                            "behavior": "allow", "updatedInput": ["command": "rm -rf build"],
                            "updatedPermissions": [
                                [
                                    "type": "addRules", "rules": [["toolName": "Bash", "ruleContent": "rm -rf build"]],
                                    "behavior": "allow", "destination": "localSettings",
                                ]
                            ],
                        ],
                    ],
                ]
            ])
    }

    func testDenyWithThePersonsWordsAndTheCallEndsDenied() throws {
        let adapter = try askingForBash()
        let lines = try carryOut(adapter, .answer(request: "perm", answer: .choice(choiceId: "deny", text: "use make clean")))
        XCTAssertEqual(parsed(lines)[0]["response"]?["response"], ["behavior": "deny", "message": "use make clean"])
        XCTAssertEqual(adapter.transcript.requests, [])
        _ = try adapter.received(toolResult("toolu_1", "use make clean", true))
        XCTAssertEqual(try toolOf(adapter, "tool:toolu_1").status, .denied)
    }

    func testDenyWithAStockSentenceWhenThePersonGaveNone() throws {
        let adapter = try askingForBash()
        let lines = try adapter.encode(.answer(request: "perm", answer: .choice(choiceId: "deny", text: nil)))
        XCTAssertTrue(parsed(lines)[0]["response"]?["response"]?["message"]?.stringValue?.contains("denied") ?? false)
    }

    func testCloseWhenTheCLICancelsThem() throws {
        let adapter = try askingForBash()
        _ = try adapter.received(json(["type": "control_cancel_request", "request_id": "perm"]))
        XCTAssertEqual(adapter.transcript.requests, [])
    }

    func testIgnoreACancelForARequestAlreadyAnswered() throws {
        let adapter = try askingForBash()
        try carryOut(adapter, .answer(request: "perm", answer: .choice(choiceId: "allow", text: nil)))
        XCTAssertEqual(try adapter.received(json(["type": "control_cancel_request", "request_id": "perm"])).events, [])
    }

    func testRefuseAnAnswerToARequestNotPendingOrAChoiceNotOffered() throws {
        let adapter = try askingForBash()
        assertThrows(try adapter.encode(.answer(request: "nope", answer: .choice(choiceId: "allow", text: nil))), "not pending")
        assertThrows(
            try adapter.encode(.answer(request: "perm", answer: .choice(choiceId: "sometimes", text: nil))), "did not offer")
    }

    private let questionsInput: JsonObject = [
        "questions": [
            [
                "question": "Which database?", "header": "Database",
                "options": [["label": "SQLite", "description": "a file"], ["label": "Postgres", "description": "a server"]],
                "multiSelect": false,
            ],
            [
                "question": "Which features?", "header": "Features",
                "options": [["label": "Auth", "description": ""], ["label": "Search", "description": ""]],
                "multiSelect": true,
            ],
        ]
    ]

    func testAskAskUserQuestionsQuestionsAndAnswerWithTheChosenOptions() throws {
        let adapter = try inTurn()
        let input = questionsInput
        _ = try adapter.received(assistantLine("m", [toolUse("toolu_q", "AskUserQuestion", input)]))
        _ = try adapter.received(
            canUseTool("q", ["tool_name": "AskUserQuestion", "input": .object(input), "tool_use_id": "toolu_q"]))
        let request = try XCTUnwrap(adapter.transcript.requests.first)
        XCTAssertEqual(request.entry, "tool:toolu_q")
        guard case .question(let questions) = request.subject else { return XCTFail("not a question") }
        XCTAssertEqual(
            questions[0],
            Question(
                id: "Which database?", header: "Database", text: "Which database?",
                options: [
                    QuestionOption(label: "SQLite", description: "a file"),
                    QuestionOption(label: "Postgres", description: "a server"),
                ], multiSelect: false, allowsOther: true))
        XCTAssertEqual(questions[1].id, "Which features?")
        XCTAssertTrue(questions[1].multiSelect)
        XCTAssertEqual(request.choices, [RequestChoice(id: "deny", label: "Decline", tone: .deny, takesText: true)])
        let lines = try adapter.encode(
            .answer(
                request: "q",
                answer: .answers(
                    values: [("Which database?", .one("SQLite")), ("Which features?", .many(["Auth", "Search"]))],
                    notes: nil)))
        var updated = input
        updated["answers"] = ["Which database?": "SQLite", "Which features?": "Auth, Search"]
        XCTAssertEqual(parsed(lines)[0]["response"]?["response"], ["behavior": "allow", "updatedInput": .object(updated)])
    }

    func testCarryANoteOnEachAnswerAsClaudesAnnotation() throws {
        let adapter = try inTurn()
        let input: JsonObject = [
            "questions": [
                [
                    "question": "Which database?", "header": "Database",
                    "options": [["label": "Postgres", "description": ""], ["label": "SQLite", "description": ""]],
                    "multiSelect": false,
                ]
            ]
        ]
        _ = try adapter.received(assistantLine("m", [toolUse("toolu_q", "AskUserQuestion", input)]))
        _ = try adapter.received(
            canUseTool("q", ["tool_name": "AskUserQuestion", "input": .object(input), "tool_use_id": "toolu_q"]))
        let lines = try adapter.encode(
            .answer(
                request: "q",
                answer: .answers(
                    values: [("Which database?", .one("SQLite"))],
                    notes: ["Which database?": "answered via devhub CLI by Coordinator"])))
        var updated = input
        updated["answers"] = ["Which database?": "SQLite"]
        updated["annotations"] = ["Which database?": ["notes": "answered via devhub CLI by Coordinator"]]
        XCTAssertEqual(parsed(lines)[0]["response"]?["response"], ["behavior": "allow", "updatedInput": .object(updated)])
    }

    func testKeepEachOptionsPreview() throws {
        let adapter = try inTurn()
        let input: JsonObject = [
            "questions": [
                [
                    "question": "Which layout?", "header": "Layout",
                    "options": [
                        ["label": "Sidebar", "description": "", "preview": "+------+----+\n| menu | .. |\n+------+----+"],
                        ["label": "Tabs", "description": ""],
                    ],
                    "multiSelect": false,
                ]
            ]
        ]
        _ = try adapter.received(assistantLine("m", [toolUse("toolu_q", "AskUserQuestion", input)]))
        _ = try adapter.received(
            canUseTool("q", ["tool_name": "AskUserQuestion", "input": .object(input), "tool_use_id": "toolu_q"]))
        guard case .question(let questions) = adapter.transcript.requests[0].subject else { return XCTFail() }
        XCTAssertEqual(questions[0].options[0].label, "Sidebar")
        XCTAssertEqual(questions[0].options[0].preview, "+------+----+\n| menu | .. |\n+------+----+")
        XCTAssertEqual(questions[0].options[1].label, "Tabs")
        XCTAssertNil(questions[0].options[1].preview)
    }

    func testAreRefusedInAMalformedShape() throws {
        let adapter = try inTurn()
        assertThrows(
            try adapter.received(canUseTool("p", ["tool_name": 7, "input": [:]])),
            #"control_request\.request\.tool_name: expected a string \(CLI 2\.1\.0\)"#)
    }
}

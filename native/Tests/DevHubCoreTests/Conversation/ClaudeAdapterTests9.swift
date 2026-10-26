// Port of apps/desktop/src/main/agent/conversation/claude/adapter.test.ts (9/12)

import XCTest
@testable import DevHubCore

func system(_ subtype: String, _ fields: JsonObject = [:]) -> String {
    json(.object(merged(["type": "system", "subtype": .string(subtype), "session_id": .string(SESSION)], fields)))
}

func notices(_ adapter: ClaudeAdapter) -> [[String]] {
    adapter.transcript.entries.compactMap(\.noticeEntry).map { [$0.level.rawValue, $0.text] }
}

func pastRecord(_ adapter: ClaudeAdapter, _ record: JsonObject) throws {
    _ = try adapter.received(json(["type": "devhub_history", "record": .object(record)]))
}

final class ClaudeOtherSystemEventTests: XCTestCase {
    func testAreDrawnAsWhatEachSaysOrLeftOutByARule() throws {
        let adapter = try inTurn()
        for line in [
            system("turn_duration", ["durationMs": 1200, "messageCount": 4]),
            system("thinking_tokens", ["tokens": 10]),
            system("bridge_status", ["content": "Remote Control on", "url": "https://example.com/x"]),
            system(
                "stop_hook_summary",
                [
                    "hookCount": 1, "hookInfos": [["command": "true", "durationMs": 3]], "hookErrors": [],
                    "preventedContinuation": false, "hasOutput": false, "level": "info",
                ]),
            system("away_summary", ["content": "You were away; the tests were fixed."]),
            system("informational", ["content": "Auto-update installed.", "level": "info"]),
            system("informational", ["content": "Low disk space.", "level": "warning"]),
            system(
                "model_refusal_no_fallback",
                ["content": "The model declined to answer.", "level": "error", "apiRefusalExplanation": "policy"]),
            system(
                "stop_hook_summary",
                [
                    "hookCount": 1, "hookInfos": [], "hookErrors": ["lint failed"], "preventedContinuation": true,
                    "stopReason": "fix lint", "hasOutput": true, "level": "warning",
                ]),
        ] { _ = try adapter.received(line) }
        XCTAssertEqual(
            notices(adapter),
            [
                ["info", "While you were away: You were away; the tests were fixed."], ["info", "Auto-update installed."],
                ["warning", "Low disk space."], ["error", "The model declined to answer. (policy)"],
                ["warning", "A stop hook failed: lint failed"],
            ])
    }

    func testDrawAChangeTheCLIMadeToTheRepository() throws {
        let adapter = try inTurn()
        func vcs(_ fields: JsonObject) -> String {
            system("vcs_state_changed", merged(["cwd": "/home/testuser/project", "uuid": "u-vcs"], fields))
        }
        for line in [
            vcs(["kind": "push", "branch": "main"]), vcs(["kind": "commit", "branch": "feature"]),
            vcs(["kind": "merge", "branch": "main"]), vcs(["kind": "rebase", "branch": "topic"]), vcs(["kind": "commit"]),
            vcs(["kind": "stash", "branch": "main"]), vcs(["kind": "tag"]),
        ] { _ = try adapter.received(line) }
        XCTAssertEqual(
            notices(adapter),
            [
                ["info", "Pushed main"], ["info", "Committed on feature"], ["info", "Merged into main"], ["info", "Rebased topic"],
                ["info", "Committed"], ["info", "Changed the repository (stash) on main"],
                ["info", "Changed the repository (tag)"],
            ])
    }

    func testDrawARepositoryChangeReadBackFromASessionFileTheSameWay() throws {
        let adapter = ClaudeAdapter(bootId: "boot")
        try pastRecord(
            adapter,
            ["type": "system", "subtype": "vcs_state_changed", "kind": "push", "branch": "main", "cwd": "/home/testuser/project"])
        XCTAssertEqual(notices(adapter), [["info", "Pushed main"]])
    }

    func testBreakTheConversationForARepositoryChangeThatDoesNotSayItsKind() throws {
        let adapter = try inTurn()
        XCTAssertThrowsError(try adapter.received(system("vcs_state_changed", ["branch": "main"]))) {
            XCTAssertTrue($0 is ProtocolMismatch)
        }
    }

    func testDrawALocalCommandTheCLIRanAsThatCommandAndItsOutput() throws {
        let adapter = try inTurn()
        _ = try adapter.received(
            system(
                "local_command", ["content": "<command-name>/cost</command-name>\n<command-args></command-args>", "level": "info"]))
        _ = try adapter.received(
            system("local_command", ["content": "<local-command-stdout>Total cost: $0.10</local-command-stdout>", "level": "info"]))
        let commands = adapter.transcript.entries.compactMap(\.commandEntry)
        XCTAssertEqual(commands.map(\.line), ["/cost"])
        XCTAssertEqual(commands.map(\.output), ["Total cost: $0.10"])
        XCTAssertEqual(notices(adapter), [])
    }

    func testEndATaskNamedOnlyByItsIdByTheCallTaskStartedTiedItTo() throws {
        let adapter = try inTurn()
        _ = try adapter.received(
            assistantLine("m", [toolUse("toolu_bg", "Bash", ["command": "npm run watch", "run_in_background": true])]))
        _ = try adapter.received(system("task_started", ["task_id": "b7", "tool_use_id": "toolu_bg", "description": "watch"]))
        _ = try adapter.received(system("task_notification", ["task_id": "b7", "status": "stopped", "summary": "stopped"]))
        XCTAssertEqual(try toolOf(adapter, "tool:toolu_bg").background, BackgroundTask(state: .failed, summary: "stopped"))
    }

    func testRunOnFromACommandsResultThatNamesItsBackgroundTask() throws {
        for input: JsonObject in [
            ["command": "npm run watch", "run_in_background": true],
            // One that outran its timeout and was moved to the background.
            ["command": "npm run build"],
        ] {
            let adapter = try inTurn()
            _ = try adapter.received(assistantLine("msg_bg", [toolUse("toolu_bg", "Bash", input)]))
            _ = try adapter.received(
                resultOf(
                    "toolu_bg", "Moved to the background with ID: b5",
                    toolUseResult: ["stdout": "", "stderr": "", "interrupted": false, "backgroundTaskId": "b5"]))
            let tool = try toolOf(adapter, "tool:toolu_bg")
            XCTAssertEqual(tool.status, .succeeded)
            XCTAssertEqual(tool.background, BackgroundTask(state: .running, summary: nil))
            _ = try adapter.received(
                system("task_notification", ["task_id": "b5", "status": "completed", "summary": "build finished"]))
            XCTAssertEqual(
                try toolOf(adapter, "tool:toolu_bg").background, BackgroundTask(state: .completed, summary: "build finished"))
        }
    }

    func testEndABackgroundCommandReadBackFromASessionFile() throws {
        let adapter = ClaudeAdapter(bootId: "boot")
        try pastRecord(
            adapter,
            [
                "type": "assistant", "uuid": "a1",
                "message": [
                    "id": "m1", "role": "assistant",
                    "content": [toolUse("toolu_bg", "Bash", ["command": "sleep 9", "run_in_background": true])],
                ],
            ])
        try pastRecord(
            adapter,
            [
                "type": "user", "uuid": "u1",
                "message": [
                    "role": "user",
                    "content": [
                        ["type": "tool_result", "tool_use_id": "toolu_bg", "content": "Running in the background with ID: b9"]
                    ],
                ],
                "tool_use_result": ["stdout": "", "stderr": "", "interrupted": false, "backgroundTaskId": "b9"],
            ])
        try pastRecord(
            adapter,
            [
                "type": "user", "uuid": "u2",
                "message": [
                    "role": "user",
                    "content":
                        "<task-notification>\n<task-id>b9</task-id>\n<status>completed</status>\n<summary>sleep ended</summary>\n</task-notification>",
                ],
            ])
        XCTAssertEqual(try toolOf(adapter, "tool:toolu_bg").background, BackgroundTask(state: .completed, summary: "sleep ended"))
    }
}

final class ClaudeTeammateTests: XCTestCase {
    var said = 0

    func spawned() throws -> ClaudeAdapter {
        let adapter = try inTurn()
        _ = try adapter.received(
            assistantLine(
                "m", [toolUse("toolu_tm", "Agent", ["description": "research", "prompt": "look into it", "subagent_type": "general"])]))
        _ = try adapter.received(
            withFields(
                toolResult("toolu_tm", "Spawned successfully."),
                [
                    "tool_use_result": [
                        "status": "teammate_spawned", "prompt": "look into it", "teammate_id": "researcher@team",
                        "agent_id": "researcher@team", "name": "researcher", "team_name": "team",
                    ]
                ]))
        return adapter
    }

    func says(_ adapter: ClaudeAdapter, _ body: String, from: String = "researcher") throws {
        said += 1
        _ = try adapter.received(
            echo(
                "<teammate-message teammate_id=\"\(from)\" color=\"blue\" summary=\"a note\">\n\(body)\n</teammate-message>",
                "u-\(said)"))
    }

    func state(_ adapter: ClaudeAdapter) throws -> SubagentState? { try toolOf(adapter, "tool:toolu_tm").spawns?.state }

    func testRunsOnceSpawnedNotCompletedByItsSpawnCallsResult() throws {
        XCTAssertEqual(try state(try spawned()), .running)
    }

    func testIsIdleFailedOrDoneAsItsSignalsSay() throws {
        let adapter = try spawned()
        try says(adapter, json(["type": "idle_notification", "from": "researcher", "idleReason": "available", "timestamp": "t"]))
        XCTAssertEqual(try state(adapter), .idle)
        try says(adapter, json(["type": "shutdown_approved", "from": "researcher", "requestId": "r", "timestamp": "t"]))
        XCTAssertEqual(try state(adapter), .completed)
        let failing = try spawned()
        try says(
            failing,
            json([
                "type": "idle_notification", "from": "researcher", "idleReason": "failed", "failureReason": "crashed",
                "timestamp": "t",
            ]))
        XCTAssertEqual(try state(failing), .failed)
    }

    func testDrawsWhatItSaysAsAQuietLineFromIt() throws {
        let adapter = try spawned()
        try says(adapter, "Found the cause in parser.ts.")
        try says(adapter, json(["type": "idle_notification", "from": "researcher", "idleReason": "available", "timestamp": "t"]))
        let drawn: [[String]] = adapter.transcript.entries.compactMap { each in
            if let user = each.userEntry { return ["user", user.text] }
            if let notice = each.noticeEntry { return ["notice", notice.text] }
            return nil
        }
        XCTAssertEqual(drawn, [["user", "go"], ["notice", "From researcher: Found the cause in parser.ts."]])
    }

    func testIsUnknownWhenReadBackFromASessionFileWithNothingAfterItsSpawn() throws {
        let adapter = ClaudeAdapter(bootId: "boot")
        try pastRecord(
            adapter,
            [
                "type": "assistant", "uuid": "a1",
                "message": [
                    "id": "m1", "role": "assistant",
                    "content": [toolUse("toolu_tm", "Agent", ["description": "research", "prompt": "p"])],
                ],
            ])
        try pastRecord(
            adapter,
            [
                "type": "user", "uuid": "u1",
                "message": ["role": "user", "content": [["type": "tool_result", "tool_use_id": "toolu_tm", "content": "Spawned."]]],
                "tool_use_result": ["status": "teammate_spawned", "name": "researcher", "teammate_id": "researcher@team"],
            ])
        XCTAssertEqual(try state(adapter), .unknown)
    }
}

final class ClaudeTodoWriteTests: XCTestCase {
    func testCarriesThePlanItSets() throws {
        let adapter = try inTurn()
        _ = try adapter.received(
            assistantLine(
                "m",
                [
                    toolUse(
                        "toolu_todo", "TodoWrite",
                        [
                            "todos": [
                                ["content": "Read the code", "status": "completed", "activeForm": "Reading the code"],
                                ["content": "Fix the bug", "status": "in_progress", "activeForm": "Fixing the bug"],
                                ["content": "Run the tests", "status": "pending", "activeForm": "Running the tests"],
                            ]
                        ])
                ]))
        let tool = try toolOf(adapter, "tool:toolu_todo")
        XCTAssertEqual(tool.title, "TodoWrite: 1 of 3 done")
        XCTAssertEqual(
            tool.plan,
            [
                PlanStep(text: "Read the code", status: .completed), PlanStep(text: "Fixing the bug", status: .inProgress),
                PlanStep(text: "Run the tests", status: .pending),
            ])
    }
}

final class ClaudeWholePastTests: XCTestCase {
    func testDrawsWhatWasLiveBesideTheMessages() throws {
        let adapter = ClaudeAdapter(bootId: "boot")
        for line in try historyOf("claude-session-resume-complete.handwritten.jsonl") { _ = try adapter.received(line) }
        let drawn: [String] = adapter.transcript.entries.map { each in
            switch each {
            case .user(let u): return "user: \(u.text)"
            case .assistant(let a):
                return "assistant: " + a.blocks.map { if case .text(let m) = $0 { return m }; return "" }.joined()
            case .notice(let n): return "notice(\(n.level.rawValue)): \(n.text)"
            case .command(let c): return "command: \(c.line ?? "undefined") -> \(c.output ?? "undefined")"
            case .compaction(let c):
                return "compaction: \(c.trigger ?? "undefined") \(c.preTokens.map(JsonValue.javaScriptNumber) ?? "undefined")"
            default: return each.kind
            }
        }
        XCTAssertEqual(
            drawn,
            [
                "user: Start on the docs", "assistant: Working on it.", "user: also check the changelog",
                "notice(info): Attached notes.md",
                "notice(info): Changed outside the conversation: /home/testuser/project/src/x.ts",
                "notice(info): While you were away: The docs were checked.", "command: /cost -> Total cost: $0.01",
                "compaction: manual 1200", "user: Go on", "assistant: Done.",
            ])
    }

    func testDrawsACompactionLiveAsTheSameDivider() throws {
        let adapter = try inTurn()
        _ = try adapter.received(
            json([
                "type": "system", "subtype": "compact_boundary", "session_id": .string(SESSION),
                "compact_metadata": ["trigger": "auto", "pre_tokens": 150000],
            ]))
        let compaction = try XCTUnwrap(adapter.transcript.entries.last?.compactionEntry)
        XCTAssertEqual(compaction.trigger, "auto")
        XCTAssertEqual(compaction.preTokens, 150000)
    }
}

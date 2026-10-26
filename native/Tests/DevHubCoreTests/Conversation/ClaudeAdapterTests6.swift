// Port of apps/desktop/src/main/agent/conversation/claude/adapter.test.ts (6/9)

import XCTest
@testable import DevHubCore

final class ClaudeResumeSessionTests: XCTestCase {
    let OTHER = "00000000-0000-4000-8000-0000000000a1"

    func oneTurn() throws -> ClaudeAdapter {
        let adapter = ClaudeAdapter(bootId: "boot")
        _ = try adapter.received(initLine())
        try carryOut(adapter, send("first"))
        _ = try adapter.received(echo("first", "u1"))
        _ = try adapter.received(assistantLine("msg_1", [["type": "text", "text": "one"]], nil, ["uuid": "a1"]))
        _ = try adapter.received(result())
        return adapter
    }

    func history() throws -> [String] {
        try claudeHistoryLines(session: OTHER, text: Fixtures.text("conversation", "claude-session-file.handwritten.jsonl"))
    }

    func testStartsTheCLIAgainOnTheOtherSessionWithItsPastInTheMark() throws {
        let adapter = try oneTurn()
        let history = try history()
        let plan = try adapter.resumeSession(OTHER, history: history)
        XCTAssertEqual(
            plan,
            .restart(
                RestartPlan(
                    session: ["--resume", OTHER], mark: [json(["type": "devhub_resume", "session": .string(OTHER)])] + history)))
        // Nothing changes until the host puts the mark in the journal.
        XCTAssertEqual(try entry(adapter, "user:u1").userEntry?.text, "first")
        guard case .restart(let restart) = plan else { return XCTFail() }
        let step = try adapter.received(restart.mark[0])
        XCTAssertTrue(step.events.contains(.sessionSwitched(session: OTHER)))
        XCTAssertEqual(adapter.transcript.entries, [])
        XCTAssertEqual(adapter.transcript.session.sessionId, OTHER)
        XCTAssertEqual(adapter.transcript.state, .ready(turn: .rewinding))
        let greetings = parsed(step.replies)
        XCTAssertEqual(greetings.count, 1)
        XCTAssertEqual(greetings[0]["request"], ["subtype": "initialize"])
        for line in restart.mark.dropFirst() { _ = try adapter.received(line) }
        XCTAssertEqual(try entry(adapter, "user:u2").userEntry?.text, "List the files in src")
        for line in step.replies { _ = try adapter.sent(line) }
        _ = try adapter.received(
            controlResponse(try XCTUnwrap(greetings[0]["request_id"]?.stringValue), ["commands": [], "models": []]))
        XCTAssertEqual(adapter.transcript.state, .ready(turn: .none))
        // The other session's past is where an edit cuts now.
        XCTAssertFalse(adapter.transcript.entries.contains { $0.id == "user:u1" })
    }

    func testOffersResumeAsDevHubsOwnPicker() throws {
        XCTAssertEqual(try oneTurn().transcript.session.commands.first { $0.name == "resume" }?.route, .resume)
    }

    func testIsRefusedWhileATurnRuns() throws {
        let adapter = ClaudeAdapter(bootId: "boot")
        _ = try adapter.received(initLine())
        try carryOut(adapter, send("first"))
        _ = try adapter.received(echo("first", "u1"))
        assertThrows(try adapter.resumeSession(OTHER, history: []), "not idle")
    }
}

final class ClaudeRestartTests: XCTestCase {
    func testStartsTheCLIAgainOnTheSessionItIsOn() throws {
        let adapter = try inTurn()
        XCTAssertEqual(try adapter.restart(), RestartPlan(session: ["--resume", SESSION], mark: [RESTART_MARK]))
        // Nothing changes until the host puts the mark in the journal.
        XCTAssertEqual(adapter.transcript.state, .ready(turn: .running))
    }

    func testStartsACLIThatHasNamedNoSessionYetOnANewOne() throws {
        XCTAssertEqual(try ClaudeAdapter(bootId: "boot").restart(), RestartPlan(session: [], mark: [RESTART_MARK]))
    }

    func testKeepsTheConversationStopsWhatTheCLIHadGoingAndGreetsTheNewCLI() throws {
        let adapter = try askingForBash()
        let step = try adapter.received(RESTART_MARK)
        XCTAssertTrue(step.events.contains(.restarted))
        let transcript = adapter.transcript
        XCTAssertEqual(try entry(adapter, "user:u-go").userEntry?.text, "go")
        XCTAssertEqual(try toolOf(adapter, "tool:toolu_1").status, .interrupted)
        XCTAssertEqual(transcript.requests, [])
        let notice = try XCTUnwrap(transcript.entries.last?.noticeEntry)
        XCTAssertEqual(notice.level, .info)
        XCTAssertEqual(notice.text, RESTARTED)
        XCTAssertEqual(transcript.session.sessionId, SESSION)
        XCTAssertEqual(transcript.state, .ready(turn: .rewinding))
        XCTAssertEqual(
            parsed(step.replies), [["type": "control_request", "request_id": "boot:1", "request": ["subtype": "initialize"]]])
        for line in step.replies { _ = try adapter.sent(line) }
        _ = try adapter.received(controlResponse("boot:1", ["commands": [], "models": []]))
        XCTAssertEqual(adapter.transcript.state, .ready(turn: .none))
        // The new CLI offers the commands again, DevHub's own with them.
        XCTAssertEqual(adapter.transcript.session.commands.first { $0.name == "restart" }, DEVHUB_RESTART)
    }
}

/// A tool_result for `toolUseId`, with its content as the CLI gives it and the tool's own account.
func resultOf(_ toolUseId: String, _ content: JsonValue, isError: Bool = false, toolUseResult: JsonValue? = nil) -> String {
    var line: JsonObject = [
        "type": "user",
        "message": [
            "role": "user",
            "content": [["type": "tool_result", "tool_use_id": .string(toolUseId), "content": content, "is_error": .bool(isError)]],
        ],
        "parent_tool_use_id": .null, "session_id": .string(SESSION),
    ]
    if let toolUseResult { line["tool_use_result"] = toolUseResult }
    return json(.object(line))
}

func called(_ name: String, _ input: JsonObject) throws -> ClaudeAdapter {
    let adapter = try inTurn()
    _ = try adapter.received(assistantLine("msg_t", [toolUse("toolu_t", name, input)]))
    return adapter
}

let PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"

final class ClaudeToolOutputTests: XCTestCase {
    func output(_ adapter: ClaudeAdapter) throws -> ToolOutput? { try toolOf(adapter, "tool:toolu_t").output }
    func change(_ adapter: ClaudeAdapter) throws -> [FileDiff]? { try toolOf(adapter, "tool:toolu_t").change }

    func testIsAnEditsChangeFromItsInputThenTheCLIsPatch() throws {
        let adapter = try called(
            "Edit",
            ["file_path": "/home/testuser/project/src/x.ts", "old_string": "const a = 1;", "new_string": "const a = 2;"])
        XCTAssertEqual(
            try change(adapter),
            [FileDiff(path: "/home/testuser/project/src/x.ts", unifiedDiff: "@@\n-const a = 1;\n+const a = 2;")])
        _ = try adapter.received(
            resultOf(
                "toolu_t", "The file has been updated.",
                toolUseResult: [
                    "filePath": "/home/testuser/project/src/x.ts", "oldString": "const a = 1;", "newString": "const a = 2;",
                    "structuredPatch": [
                        ["oldStart": 3, "oldLines": 1, "newStart": 3, "newLines": 1, "lines": ["-const a = 1;", "+const a = 2;"]]
                    ],
                ]))
        XCTAssertEqual(
            try change(adapter),
            [FileDiff(path: "/home/testuser/project/src/x.ts", unifiedDiff: "@@ -3,1 +3,1 @@\n-const a = 1;\n+const a = 2;")])
        // The result's words stay its output; the change is not repeated there.
        XCTAssertEqual(try output(adapter), [.text("The file has been updated.")])
    }

    func testIsAnEditsChangeFromItsInputWhenTheCLIGaveNoPatch() throws {
        let edit = try called("Edit", ["file_path": "src/x.ts", "old_string": "a\nb", "new_string": "c"])
        _ = try edit.received(resultOf("toolu_t", "The file has been updated."))
        XCTAssertEqual(try change(edit), [FileDiff(path: "src/x.ts", unifiedDiff: "@@\n-a\n-b\n+c")])
        let multi = try called(
            "MultiEdit",
            [
                "file_path": "src/y.ts",
                "edits": [["old_string": "one", "new_string": "1"], ["old_string": "two", "new_string": "2"]],
            ])
        _ = try multi.received(resultOf("toolu_t", "Applied 2 edits."))
        XCTAssertEqual(try change(multi), [FileDiff(path: "src/y.ts", unifiedDiff: "@@\n-one\n+1\n@@\n-two\n+2")])
        let write = try called("Write", ["file_path": "notes.md", "content": "# Notes\nhi"])
        _ = try write.received(
            resultOf(
                "toolu_t", "File created.",
                toolUseResult: ["type": "create", "filePath": "notes.md", "content": "# Notes\nhi", "structuredPatch": []]))
        XCTAssertEqual(try change(write), [FileDiff(path: "notes.md", unifiedDiff: "@@\n+# Notes\n+hi")])
    }

    func testIsAFailedEditsOwnWordsBesideTheChangeItMeantToMake() throws {
        let adapter = try called("Edit", ["file_path": "src/x.ts", "old_string": "a", "new_string": "b"])
        _ = try adapter.received(
            resultOf(
                "toolu_t", "String to replace not found in file.", isError: true,
                toolUseResult: "Error: String to replace not found in file."))
        XCTAssertEqual(try output(adapter), [.text("String to replace not found in file.")])
        // What it meant to change is still what the call was.
        XCTAssertEqual(try change(adapter), [FileDiff(path: "src/x.ts", unifiedDiff: "@@\n-a\n+b")])
    }

    func testIsACommandsOutputWithStderrApart() throws {
        let adapter = try called("Bash", ["command": "make"])
        _ = try adapter.received(
            resultOf(
                "toolu_t", "built\nwarning: old",
                toolUseResult: ["stdout": "built", "stderr": "warning: old", "interrupted": true, "isImage": false]))
        XCTAssertEqual(try output(adapter), [.command(exitCode: nil, output: "built", stderr: "warning: old", interrupted: true)])
    }

    func testIsAFailedCommandsExitCodeAndOutput() throws {
        let adapter = try called("Bash", ["command": "npm test"])
        _ = try adapter.received(
            resultOf("toolu_t", "Exit code 2\n1 test failed", isError: true, toolUseResult: "Error: Exit code 2\n1 test failed"))
        XCTAssertEqual(try output(adapter), [.command(exitCode: 2, output: "1 test failed", stderr: nil, interrupted: false)])
        XCTAssertEqual(try toolOf(adapter, "tool:toolu_t").status, .failed)
    }

    func testIsOutputTooLargeForTheConversation() throws {
        let adapter = try called("Bash", ["command": "cat big.log"])
        _ = try adapter.received(
            resultOf(
                "toolu_t",
                "<persisted-output>\nOutput too large (60KB). Full output saved to: /home/testuser/.claude/out/abc.txt\n\nPreview (first 2KB):\nline 1\nline 2\n</persisted-output>",
                toolUseResult: [
                    "stdout": "line 1\nline 2\n…", "stderr": "", "interrupted": false,
                    "persistedOutputPath": "/home/testuser/.claude/out/abc.txt", "persistedOutputSize": 61440,
                ]))
        XCTAssertEqual(
            try output(adapter),
            [
                .persisted(
                    note: "Output too large (60KB). Full output saved to: /home/testuser/.claude/out/abc.txt",
                    path: "/home/testuser/.claude/out/abc.txt", preview: "line 1\nline 2")
            ])
    }

    func testKeepsAnImageAndAToolReferenceInOrder() throws {
        let adapter = try called("mcp__browser__screenshot", ["tabId": 1])
        _ = try adapter.received(
            resultOf(
                "toolu_t",
                [
                    ["type": "text", "text": "Captured the page."],
                    ["type": "image", "source": ["type": "base64", "media_type": "image/png", "data": .string(PNG)]],
                    ["type": "tool_reference", "tool_name": "mcp__browser__click"],
                ], toolUseResult: [["type": "text", "text": "Captured the page."]]))
        XCTAssertEqual(
            try output(adapter),
            [
                .text("Captured the page."),
                .image(ImageRef(mediaType: "image/png", source: .data(base64: PNG), label: "image")),
                .reference(name: "mcp__browser__click"),
            ])
        XCTAssertEqual(adapter.transcript.entries.filter { $0.kind == "notice" }, [])
    }

    func testSaysOnceThatAToolResultHeldABlockDevHubDoesNotKnow() throws {
        let adapter = try called("Read", ["file_path": "a.bin"])
        _ = try adapter.received(resultOf("toolu_t", [["type": "text", "text": "read"], ["type": "hologram", "data": "…"]]))
        let notices = adapter.transcript.entries.compactMap(\.noticeEntry)
        XCTAssertEqual(notices.map(\.level), [.warning])
        XCTAssertEqual(notices.map(\.text), [#"claude 2.1.0 printed a "tool_result/hologram" event DevHub does not know"#])
        XCTAssertEqual(try output(adapter), [.text("read")])
    }

    func testReadsAResultWhoseOwnAccountIsTheErrorsWordsAsNoLaunch() throws {
        let adapter = try called("Agent", ["description": "look", "prompt": "look"])
        _ = try adapter.received(
            resultOf("toolu_t", "User rejected the call.", isError: true, toolUseResult: "User rejected the call."))
        let tool = try toolOf(adapter, "tool:toolu_t")
        XCTAssertEqual(tool.status, .failed)
        XCTAssertEqual(tool.spawns?.state, .failed)
    }
}

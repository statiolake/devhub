// Port of apps/desktop/src/main/agent/conversation/claude/adapter.test.ts (11/12)

import XCTest
@testable import DevHubCore

private let QUESTIONS: [JsonValue] = [
    [
        "question": "Which database?", "header": "Database",
        "options": [["label": "SQLite", "description": "a file"], ["label": "Postgres", "description": "a server"]],
        "multiSelect": false,
    ],
    [
        "question": "Which features?", "header": "Features",
        "options": [
            ["label": "Auth, SSO", "description": ""], ["label": "Search", "description": ""],
            ["label": "Export", "description": ""],
        ],
        "multiSelect": true,
    ],
    [
        "question": "Which name?", "header": "Name",
        "options": [["label": "devhub", "description": ""], ["label": "hub", "description": ""]], "multiSelect": false,
    ],
]

/// What the CLI records of the answer: the questions, each answer by its text, and a note.
private let RECORDED: JsonValue = [
    "questions": .array(QUESTIONS),
    "answers": [
        "Which database?": "Postgres", "Which features?": "Auth, SSO, Search, and CSV, too", "Which name?": "workbench",
    ],
    "annotations": ["Which database?": ["notes": "the one we run already"]],
]

private let ANSWER = TranscriptEntry.answer(
    AnswerEntry(
        id: "answer:toolu_q",
        answers: [
            QuestionAnswer(
                header: "Database", question: "Which database?", chosen: ["Postgres"], written: nil,
                notes: "the one we run already", secret: false),
            QuestionAnswer(
                header: "Features", question: "Which features?", chosen: ["Auth, SSO", "Search"], written: "and CSV, too",
                notes: nil, secret: false),
            QuestionAnswer(header: "Name", question: "Which name?", chosen: [], written: "workbench", notes: nil, secret: false),
        ]))

private func answered(_ toolUseResult: JsonValue) -> String {
    resultOf("toolu_q", "User has answered your questions.", toolUseResult: toolUseResult)
}

final class ClaudeAskUserQuestionAnswerTests: XCTestCase {
    func asking() throws -> ClaudeAdapter {
        let adapter = try inTurn()
        _ = try adapter.received(assistantLine("m", [toolUse("toolu_q", "AskUserQuestion", ["questions": .array(QUESTIONS)])]))
        return adapter
    }

    func testIsThePersonsMessageAfterTheCallReadFromWhatTheCLIRecorded() throws {
        let adapter = try asking()
        _ = try adapter.received(
            canUseTool(
                "q", ["tool_name": "AskUserQuestion", "input": ["questions": .array(QUESTIONS)], "tool_use_id": "toolu_q"]))
        try carryOut(
            adapter,
            .answer(
                request: "q",
                answer: .answers(
                    values: [
                        ("Which database?", .one("Postgres")), ("Which features?", .many(["Auth, SSO", "Search", "and CSV, too"])),
                        ("Which name?", .one("workbench")),
                    ], notes: nil)))
        _ = try adapter.received(answered(RECORDED))
        let entries = adapter.transcript.entries
        XCTAssertEqual(entries.last, ANSWER)
        XCTAssertEqual(entries[entries.count - 2].id, "tool:toolu_q")
    }

    func testIsDrawnTheSameByAReplay() throws {
        let adapter = try asking()
        _ = try adapter.received(answered(RECORDED))
        XCTAssertEqual(try entry(adapter, "answer:toolu_q"), ANSWER)
    }

    func testIsDrawnTheSameFromAResumedSessionsFile() throws {
        let adapter = ClaudeAdapter(bootId: "boot")
        try pastRecord(
            adapter,
            [
                "type": "assistant", "uuid": "a1",
                "message": [
                    "id": "m1", "role": "assistant",
                    "content": [toolUse("toolu_q", "AskUserQuestion", ["questions": .array(QUESTIONS)])],
                ],
            ])
        try pastRecord(
            adapter,
            [
                "type": "user", "uuid": "u1",
                "message": [
                    "role": "user",
                    "content": [["type": "tool_result", "tool_use_id": "toolu_q", "content": "User has answered your questions."]],
                ],
                "tool_use_result": RECORDED,
            ])
        XCTAssertEqual(try entry(adapter, "answer:toolu_q"), ANSWER)
    }

    func testTakesAMultiSelectAnswerTheCLIRecordedAsAList() throws {
        let adapter = try asking()
        _ = try adapter.received(
            answered(["questions": [QUESTIONS[1]], "answers": ["Which features?": ["Search", "Export"]]]))
        let answer = try XCTUnwrap(try entry(adapter, "answer:toolu_q").answerEntry)
        XCTAssertEqual(answer.answers.map(\.chosen), [["Search", "Export"]])
        XCTAssertEqual(answer.answers.map(\.written), [nil])
    }

    func testIsNotDrawnForQuestionsThePersonDeclined() throws {
        let adapter = try asking()
        _ = try adapter.received(toolResult("toolu_q", "The user declined.", true))
        XCTAssertEqual(adapter.transcript.entries.map(\.kind), ["user", "tool"])
    }

    func testBreaksTheConversationWhenAnAnsweredCallsRecordCarriesNoAnswers() throws {
        let adapter = try asking()
        assertThrows(try adapter.received(answered(["questions": .array(QUESTIONS)])), #"user\.tool_use_result\.answers"#)
    }
}

final class ClaudeQuestionPreviewTests: XCTestCase {
    let LINES = fixture("claude-question-previews.handwritten.ndjson")
    var ASKING: Int { LINES.firstIndex { $0.line.contains("can_use_tool") }! }
    var CALL: FixtureLine { LINES.first { $0.line.hasPrefix(#"{"type":"assistant""#) && $0.line.contains("toolu_q1") }! }
    var RESULT: FixtureLine { LINES.first { $0.line.contains("tool_use_result") }! }
    var previews: [String?] {
        let asked = (try? JsonValue.parse(CALL.line))?["message"]?["content"]?.arrayValue?.first?["input"]?["questions"]
        return asked?.arrayValue?.first?["options"]?.arrayValue?.map { $0["preview"]?.stringValue } ?? []
    }

    func previewsOf(_ questions: [Question]) -> [[String?]] { questions.map { $0.options.map(\.preview) } }

    func askedOfCall(_ adapter: ClaudeAdapter) throws -> [[String: [String?]]] {
        try XCTUnwrap(try toolOf(adapter, "tool:toolu_q1").asked).map { asked in
            ["previews": asked.question.options.map(\.preview), "chosen": asked.answer.chosen]
        }
    }

    var RECORD: [[String: [String?]]] { [["previews": previews, "chosen": ["タブ"]], ["previews": [nil, nil], "chosen": ["自動"]]] }

    func testHandsTheCardEveryOptionsPreviewAsWritten() throws {
        XCTAssertTrue(previews.allSatisfy { $0?.contains("\n│") ?? false })
        let adapter = ClaudeAdapter(bootId: "boot")
        try play(adapter, Array(LINES[...ASKING]))
        let request = try XCTUnwrap(adapter.transcript.requests.first)
        guard case .question(let questions) = request.subject else { return XCTFail("not a question") }
        XCTAssertEqual(previewsOf(questions), [previews, [nil, nil]])
        // Before the answer, the call keeps no record of it.
        XCTAssertNil(try toolOf(adapter, "tool:toolu_q1").asked)
    }

    func testKeepsWhatWasAskedAndChosenOnTheCallOnceAnswered() throws {
        let adapter = ClaudeAdapter(bootId: "boot")
        try play(adapter, LINES)
        XCTAssertEqual(try askedOfCall(adapter), RECORD)
        XCTAssertEqual(try entry(adapter, "answer:toolu_q1").answerEntry?.answers.map(\.chosen), [["タブ"], ["自動"]])
    }

    func testKeepsTheSameRecordInAResumedSessionsFile() throws {
        let adapter = ClaudeAdapter(bootId: "boot")
        for line in [CALL.line, RESULT.line] {
            try pastRecord(adapter, try XCTUnwrap(try JsonValue.parse(line).objectValue))
        }
        XCTAssertEqual(try askedOfCall(adapter), RECORD)
    }
}

final class ClaudeDenialTests: XCTestCase {
    func denied(_ fields: JsonObject) -> String {
        json(
            .object(
                merged(
                    [
                        "type": "system", "subtype": "permission_denied", "session_id": .string(SESSION), "tool_name": "Bash",
                        "decision_reason_type": "classifier", "decision_reason": "[Modify Shared Resources]",
                        "message": "The classifier judged that this command changes a shared resource.",
                    ], fields)))
    }

    /// `inTurn`, with an Agent call launched in the background as agent-x.
    func withBackgroundAgent() throws -> ClaudeAdapter {
        let adapter = try inTurn()
        _ = try adapter.received(
            assistantLine("m", [toolUse("toolu_agent", "Agent", ["description": "Survey", "prompt": "survey it", "subagent_type": "general"])]))
        _ = try adapter.received(
            withFields(
                toolResult("toolu_agent", "Async agent launched"),
                ["tool_use_result": ["isAsync": true, "status": "async_launched", "agentId": "agent-x"]]))
        return adapter
    }

    func testIsSaidOnTheCallByWhoRefusedItAndWhy() throws {
        let adapter = try inTurn()
        _ = try adapter.received(assistantLine("m", [toolUse("toolu_1", "Bash", ["command": "git push"])]))
        _ = try adapter.received(denied(["tool_use_id": "toolu_1"]))
        _ = try adapter.received(toolResult("toolu_1", "Permission denied.", true))
        let tool = try toolOf(adapter, "tool:toolu_1")
        XCTAssertEqual(tool.status, .denied)
        XCTAssertEqual(
            tool.denial,
            Denial(
                summary: "Denied by auto mode: Modify Shared Resources",
                detail: "The classifier judged that this command changes a shared resource."))
        XCTAssertEqual(adapter.transcript.entries.map(\.kind), ["user", "tool"])
    }

    func testIsSaidOnASubagentsOwnCallWhereThatCallIsDrawn() throws {
        let adapter = try withBackgroundAgent()
        _ = try adapter.received(assistantLine("m2", [toolUse("toolu_inner", "Bash", ["command": "rm -rf shared"])], "toolu_agent"))
        _ = try adapter.received(denied(["tool_use_id": "toolu_inner", "agent_id": "agent-x"]))
        let tool = try toolOf(adapter, "tool:toolu_inner")
        XCTAssertEqual(tool.parent, "tool:toolu_agent")
        XCTAssertEqual(tool.denial?.summary, "Denied by auto mode: Modify Shared Resources")
        XCTAssertEqual(adapter.transcript.entries.filter { $0.kind == "notice" }, [])
    }

    func testIsALineInTheSubagentsTranscriptWhenItsCallIsNotDrawn() throws {
        let adapter = try withBackgroundAgent()
        _ = try adapter.received(denied(["tool_use_id": "toolu_unseen", "agent_id": "agent-x"]))
        let notices = adapter.transcript.entries.compactMap(\.noticeEntry)
        XCTAssertEqual(notices.map(\.parent), ["tool:toolu_agent"])
        XCTAssertEqual(notices.map(\.level), [.info])
        XCTAssertEqual(notices.map(\.text), ["Bash: Denied by auto mode: Modify Shared Resources"])
    }

    func testIsALineInTheConversationOnlyWhenItNamesNeitherACallNorASubagent() throws {
        let adapter = try inTurn()
        _ = try adapter.received(
            denied([
                "tool_use_id": "toolu_unseen", "agent_id": "agent-unknown", "decision_reason_type": "rule",
                "decision_reason": "Bash(git push:*)",
            ]))
        let notices = adapter.transcript.entries.compactMap(\.noticeEntry)
        XCTAssertEqual(notices.map(\.parent), [nil])
        XCTAssertEqual(notices.map(\.text), ["Bash: Denied by a permission rule: Bash(git push:*)"])
    }
}

// Port of apps/desktop/src/main/agent/conversation/claude/adapter.test.ts (8/9)

import XCTest
@testable import DevHubCore

final class ClaudeTurnByResultTests: XCTestCase {
    func status(_ fields: JsonObject) -> String {
        json(.object(merged(["type": "system", "subtype": "status", "session_id": .string(SESSION)], fields)))
    }

    func boundary(_ metadata: JsonObject) -> String {
        json([
            "type": "system", "subtype": "compact_boundary", "session_id": .string(SESSION),
            "compact_metadata": .object(metadata),
        ])
    }

    func localResult(_ command: String, _ text: String = "") -> String {
        result(["num_turns": 0, "result": .string(text), "total_cost_usd": 0, "local_command": .string(command)])
    }

    func say(_ adapter: ClaudeAdapter, _ text: String) throws { try carryOut(adapter, send(text)) }

    /// Each line received, with the Agent's status after it.
    func statuses(_ adapter: ClaudeAdapter, _ lines: [String]) throws -> [ConversationAgentStatus] {
        try lines.map { line in
            _ = try adapter.received(line)
            return conversationStatus(adapter.transcript)
        }
    }

    func outline(_ adapter: ClaudeAdapter) -> [String] {
        func n(_ value: Double?) -> String { value.map(JsonValue.javaScriptNumber) ?? "undefined" }
        return adapter.transcript.entries.map { each in
            switch each {
            case .command(let c):
                return "command: \(c.line ?? "undefined")\(c.output.map { " -> \($0)" } ?? "")\(c.failed ? " (failed)" : "")"
            case .user(let u): return "user(\(u.origin.rawValue)): \(u.text)"
            case .compaction(let c): return "compaction: \(c.trigger ?? "undefined") \(n(c.preTokens)) -> \(n(c.postTokens))"
            case .turnEnd(let t): return "turn-end \(t.outcome.rawValue)"
            case .notice(let notice): return "notice(\(notice.level.rawValue)): \(notice.text)"
            default: return each.kind
            }
        }
    }

    func ready() throws -> ClaudeAdapter {
        let adapter = ClaudeAdapter(bootId: "boot")
        _ = try adapter.received(initLine())
        return adapter
    }

    func testIsWorkingFromTheWriteOfCompactAndIdleAtTheResult() throws {
        let adapter = try ready()
        try say(adapter, "/compact")
        XCTAssertEqual(conversationStatus(adapter.transcript), .working)
        XCTAssertFalse(adapter.transcript.compacting)
        _ = try adapter.received(initLine())
        _ = try adapter.received(status(["status": "compacting"]))
        XCTAssertTrue(adapter.transcript.compacting)
        XCTAssertEqual(conversationStatus(adapter.transcript), .working)
        _ = try adapter.received(boundary(["trigger": "manual", "pre_tokens": 90000, "post_tokens": 12000]))
        XCTAssertFalse(adapter.transcript.compacting)
        XCTAssertEqual(
            try statuses(adapter, [status(["status": .null, "compact_result": "success"]), localResult("compact")]),
            [.working, .idle])
        XCTAssertEqual(adapter.transcript.sending, [])
        XCTAssertEqual(outline(adapter), ["compaction: manual 90000 -> 12000", "command: /compact", "turn-end completed"])
    }

    func testTakesAnEchoedCompactAsTheCommand() throws {
        let adapter = try ready()
        try say(adapter, "/compact keep the plan")
        _ = try adapter.received(
            echo(
                "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>keep the plan</command-args>",
                "u-compact"))
        XCTAssertEqual(adapter.transcript.sending, [])
        XCTAssertEqual(
            try statuses(
                adapter,
                [status(["status": "compacting"]), boundary(["trigger": "manual", "pre_tokens": 5000]), localResult("compact")]),
            [.working, .working, .idle])
        XCTAssertEqual(
            outline(adapter),
            ["command: /compact keep the plan", "compaction: manual 5000 -> undefined", "turn-end completed"])
    }

    func testSaysACompactionThatFailed() throws {
        let adapter = try ready()
        try say(adapter, "/compact")
        _ = try adapter.received(status(["status": "compacting"]))
        _ = try adapter.received(
            status(["status": .null, "compact_result": "failed", "compact_error": "The summary was too long."]))
        XCTAssertFalse(adapter.transcript.compacting)
        _ = try adapter.received(localResult("compact"))
        XCTAssertEqual(conversationStatus(adapter.transcript), .idle)
        XCTAssertEqual(
            outline(adapter),
            [
                "notice(error): Compacting the conversation failed: The summary was too long.", "command: /compact",
                "turn-end completed",
            ])
    }

    func testShowsAnAutomaticCompactionInsideATurn() throws {
        let adapter = try inTurn()
        _ = try adapter.received(status(["status": "compacting"]))
        XCTAssertTrue(adapter.transcript.compacting)
        _ = try adapter.received(result())
        XCTAssertFalse(adapter.transcript.compacting)
        XCTAssertEqual(conversationStatus(adapter.transcript), .idle)
    }

    func testIsIdleAfterEachLocalCommand2_1_284AnswersWithoutAnEcho() throws {
        let adapter = ClaudeAdapter(bootId: "boot")
        var seen: [ConversationAgentStatus] = []
        for each in fixture("claude-local-command-2.1.284.handwritten.ndjson") {
            if each.side == .sent { _ = try adapter.sent(each.line) } else { _ = try adapter.received(each.line) }
            seen.append(conversationStatus(adapter.transcript))
        }
        XCTAssertEqual(adapter.transcript.sending, [])
        XCTAssertEqual(
            outline(adapter),
            [
                "command: /compact -> Error: Nothing to compact yet. (failed)", "turn-end completed",
                "command: /usage -> Current session: 1% used.", "turn-end completed",
                "notice(info): Context cleared: the model starts afresh from here.", "command: /clear", "turn-end completed",
            ])
        XCTAssertEqual(
            seen,
            [.unknown, .idle, .idle] + [.working, .working, .working, .idle] + [.working, .working, .working, .idle]
                + [.working, .working, .working, .idle])
    }

    func testDrawsACommandTheCLINamesNowhereAsSent() throws {
        let adapter = try ready()
        try say(adapter, "/context")
        _ = try adapter.received(initLine())
        _ = try adapter.received(localResult("context", "12k of 200k tokens."))
        XCTAssertEqual(conversationStatus(adapter.transcript), .idle)
        XCTAssertEqual(outline(adapter), ["command: /context -> 12k of 200k tokens.", "turn-end completed"])
    }

    func testIsIdleAfterAnUnknownCommandTheCLIHandsToTheModel() throws {
        let echoed = try ready()
        try say(echoed, "/nope")
        XCTAssertEqual(
            try statuses(
                echoed,
                [
                    initLine(), echo("/nope", "u-nope"), assistantLine("msg_n", [["type": "text", "text": "No such command."]]),
                    result(["num_turns": 1, "result": "No such command."]),
                ]),
            [.working, .working, .working, .idle])
        XCTAssertEqual(outline(echoed), ["user(person): /nope", "assistant", "turn-end completed"])

        let silent = try ready()
        try say(silent, "/nope")
        XCTAssertEqual(
            try statuses(
                silent,
                [
                    initLine(), assistantLine("msg_n", [["type": "text", "text": "No such command."]]),
                    result(["num_turns": 1, "result": "No such command."]),
                ]),
            [.working, .working, .idle])
        XCTAssertEqual(outline(silent), ["assistant", "command: /nope", "turn-end completed"])
    }

    func testIsIdleAfterAPromptTheModelAnsweredAndOneTheCLIAnsweredWithoutEcho() throws {
        let adapter = try ready()
        try say(adapter, "hello")
        XCTAssertEqual(
            try statuses(
                adapter, [echo("hello", "u-hello"), assistantLine("msg_h", [["type": "text", "text": "Hi."]]), result()]),
            [.working, .working, .idle])
        try say(adapter, "and again")
        XCTAssertEqual(try statuses(adapter, [result(["is_error": true, "subtype": "error"])]), [.error])
        XCTAssertEqual(adapter.transcript.sending, [])
        XCTAssertEqual(
            outline(adapter),
            ["user(person): hello", "assistant", "turn-end completed", "user(person): and again", "turn-end failed"])
    }

    func testAnswersTwoSendsInARowInOrderWhenOnlyTheSecondIsEchoed() throws {
        let adapter = try ready()
        try say(adapter, "/compact")
        try say(adapter, "then this")
        XCTAssertEqual(adapter.transcript.sending.map(\.text), ["/compact", "then this"])
        XCTAssertEqual(
            try statuses(
                adapter,
                [status(["status": "compacting"]), boundary(["trigger": "manual", "pre_tokens": 3000]), localResult("compact")]),
            [.working, .working, .working])
        XCTAssertEqual(adapter.transcript.sending.map(\.text), ["then this"])
        XCTAssertEqual(
            try statuses(
                adapter, [echo("then this", "u-then"), assistantLine("msg_t", [["type": "text", "text": "Done."]]), result()]),
            [.working, .working, .idle])
        XCTAssertEqual(
            outline(adapter),
            [
                "compaction: manual 3000 -> undefined", "command: /compact", "turn-end completed", "user(person): then this",
                "assistant", "turn-end completed",
            ])
    }

    func testAnswersEveryMessageUpToTheLastOneATurnTookIn() throws {
        let adapter = try ready()
        try say(adapter, "/compact")
        try say(adapter, "meanwhile")
        XCTAssertEqual(try statuses(adapter, [echo("meanwhile", "u-mean"), localResult("compact")]), [.working, .idle])
        XCTAssertEqual(adapter.transcript.sending, [])
        XCTAssertEqual(outline(adapter), ["user(person): meanwhile", "command: /compact", "turn-end completed"])
    }

    func testReplaysTheSameWayFromTheJournal() throws {
        let live = try ready()
        let received = [
            status(["status": "compacting"]), boundary(["trigger": "manual", "pre_tokens": 1000]), localResult("compact"),
        ]
        let written = try carryOut(live, send("/compact"))
        for line in received { _ = try live.received(line) }
        let replayed = try ready()
        for line in written { _ = try replayed.sent(line) }
        for line in received { _ = try replayed.received(line) }
        XCTAssertEqual(replayed.transcript, live.transcript)
    }
}

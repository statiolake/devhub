// The harness of apps/desktop/src/main/agent/conversation/codex/adapter.test.ts.
//
// The fixtures in `Fixtures/codex/` are the TS app's
// (`codex/fixtures/`, written from the vendored protocol types, two of them
// scrubbed real captures; see their README). The harness drives the adapter
// the way the conversation does: every line it writes — the opening, an
// encoded command, a reply — goes back through `sent` once written, and every
// event is folded with the one fold.

import Foundation
import XCTest
@testable import DevHubCore

let CODEX_MAIN = "00000000-0000-7000-8000-00000000000a"
let CODEX_CHILD = "00000000-0000-7000-8000-00000000000b"
let CODEX_CWD = "/home/testuser/project"

/// A Codex fixture's non-empty lines.
func codexFixture(_ name: String) -> [String] {
    Fixtures.text("codex", name).components(separatedBy: "\n").filter { !$0.isEmpty }
}

let CODEX_OPTIONS = CodexAdapterOptions(clientVersion: "0.1.0", cwd: CODEX_CWD, resumeThreadId: nil)

/// JSON text, parsed; a test's own literal, so a typo is the test's failure.
func j(_ text: String, file: StaticString = #filePath, line: UInt = #line) -> JsonValue {
    do {
        return try JsonValue.parse(text)
    } catch {
        XCTFail("not JSON: \(error): \(text)", file: file, line: line)
        return .null
    }
}

/// `value` with `path` set to `new`, as a test edits a fixture's parsed line.
func setting(_ value: JsonValue, _ path: [String], _ new: JsonValue) -> JsonValue {
    guard let key = path.first else { return new }
    var object = value.objectValue ?? JsonObject()
    object[key] = setting(object[key] ?? .null, Array(path.dropFirst()), new)
    return .object(object)
}

/// `toMatchObject`: every key `expected` names is in `actual` and matches;
/// arrays match element by element.
func jsonMatches(_ actual: JsonValue?, _ expected: JsonValue) -> Bool {
    switch (actual, expected) {
    case (.object(let have)?, .object(let want)):
        return want.allSatisfy { key, value in jsonMatches(have[key], value) }
    case (.array(let have)?, .array(let want)):
        return have.count == want.count && zip(have, want).allSatisfy { jsonMatches($0, $1) }
    case (let have?, _):
        return have == expected
    case (nil, _):
        return false
    }
}

func assertMatches(
    _ actual: JsonValue?, _ expected: JsonValue, file: StaticString = #filePath, line: UInt = #line
) {
    XCTAssertTrue(
        jsonMatches(actual, expected), "\(actual?.jsonText ?? "undefined") does not match \(expected.jsonText)",
        file: file, line: line)
}

final class CodexHarness {
    let adapter: CodexAdapter
    var transcript = EMPTY_TRANSCRIPT
    var written: [String] = []
    var received: [String] = []
    var events: [ConversationEvent] = []

    init(_ options: CodexAdapterOptions = CODEX_OPTIONS) {
        adapter = CodexAdapter(options)
    }

    @discardableResult
    private func fold(_ step: AdapterStep) throws -> AdapterStep {
        for event in step.events {
            transcript = try applyEvent(transcript, event)
            events.append(event)
        }
        for line in step.replies { try write(line) }
        return step
    }

    /// A line reached app-server's stdin: it is written, and then the adapter hears of it.
    func write(_ line: String) throws {
        written.append(line)
        try fold(adapter.sent(line))
    }

    func start() throws {
        for line in try adapter.opening() { try write(line) }
    }

    @discardableResult
    func receive(_ text: String) throws -> AdapterStep {
        received.append(text)
        return try fold(adapter.received(text))
    }

    @discardableResult
    func receive(_ value: JsonValue) throws -> AdapterStep {
        try receive(value.jsonText)
    }

    func command(_ command: ConversationCommand) throws {
        for line in try adapter.encode(command) { try write(line) }
    }

    func send(_ text: String, _ origin: SentOrigin = .person, images: [ImageRef] = []) throws {
        try command(.send(text: text, images: images, origin: origin))
    }

    /// Takes back the turns from a message on, as the conversation does with a plan to write.
    func rewind(_ message: String) throws {
        guard case .write(let lines) = try adapter.rewind(EntryId(message)) else {
            throw AdapterRefusal("Codex planned a restart for a rewind")
        }
        for line in lines { try write(line) }
    }

    func configure(_ which: SettingName, _ id: String) throws {
        try fold(adapter.configure(which, id))
    }

    /// The written lines since `from`, parsed.
    func writesSince(_ from: Int) -> [JsonValue] {
        written[from...].map { (try? JsonValue.parse($0)) ?? .null }
    }

    func lastWrite() -> JsonValue {
        (try? JsonValue.parse(written.last ?? "")) ?? .null
    }

    func entry(_ id: String, file: StaticString = #filePath, line: UInt = #line) throws -> TranscriptEntry {
        guard let found = transcript.entries.first(where: { $0.id.raw == id }) else {
            XCTFail("no entry \(id)", file: file, line: line)
            throw AdapterRefusal("no entry \(id)")
        }
        return found
    }

    func tool(_ id: String, file: StaticString = #filePath, line: UInt = #line) throws -> ToolEntry {
        guard let tool = try entry(id, file: file, line: line).toolEntry else {
            XCTFail("\(id) is not a tool entry", file: file, line: line)
            throw AdapterRefusal("\(id) is not a tool entry")
        }
        return tool
    }

    func user(_ id: String, file: StaticString = #filePath, line: UInt = #line) throws -> UserEntry {
        guard let user = try entry(id, file: file, line: line).userEntry else {
            XCTFail("\(id) is not a user entry", file: file, line: line)
            throw AdapterRefusal("\(id) is not a user entry")
        }
        return user
    }

    /// Replays what `live` wrote and heard into a fresh adapter, as a new DevHub does from the journals.
    static func replaying(_ live: CodexHarness, _ options: CodexAdapterOptions = CODEX_OPTIONS) throws -> CodexHarness {
        let replayed = CodexHarness(options)
        for line in live.written {
            for event in try replayed.adapter.sent(line).events {
                replayed.transcript = try applyEvent(replayed.transcript, event)
            }
        }
        for line in live.received { try replayed.receive(line) }
        return replayed
    }
}

/// A conversation past its handshake, ready for a first turn.
func codexReady() throws -> CodexHarness {
    let harness = CodexHarness()
    try harness.start()
    for line in codexFixture("handshake.handwritten.ndjson") { try harness.receive(line) }
    return harness
}

/// One line per entry, indented under its parent: what the transcript says, readably.
func codexOutline(_ transcript: Transcript, _ parent: EntryId? = nil, _ depth: Int = 0) -> [String] {
    childrenOf(transcript, parent).flatMap { entry -> [String] in
        let pad = String(repeating: "  ", count: depth)
        let line: String
        switch entry {
        case .user(let user):
            line = "user(\(user.origin.rawValue)): \(user.text)"
        case .answer(let answer):
            line = "answer: " + answer.answers.map { each in
                "\(each.header)=\(each.secret ? "(secret)" : (each.chosen + (each.written.map { ["\"\($0)\""] } ?? [])).joined(separator: "|"))"
            }.joined(separator: ", ")
        case .assistant(let assistant):
            line = "assistant\(assistant.streaming ? "(streaming)" : ""): " + assistant.blocks.map { block in
                switch block {
                case .text(let markdown): return markdown
                case .thinking(let text): return "[thinking] \(text)"
                case .plan(let steps): return "[plan] " + steps.map { "\($0.text)=\($0.status.rawValue)" }.joined(separator: ", ")
                }
            }.joined(separator: " | ")
        case .tool(let tool):
            var text = "tool \(tool.tool) \"\(tool.title)\" \(tool.status.rawValue)"
            if let change = tool.change {
                text += " -> " + change.map(\.path).joined(separator: ",")
            } else if let output = tool.output {
                text += " -> " + output.map { part -> String in
                    switch part {
                    case .command(_, let output, _, _): return JsonValue.string(output).jsonText
                    case .text(let text): return JsonValue.string(text).jsonText
                    case .image: return JsonValue.string("image").jsonText
                    case .reference: return JsonValue.string("reference").jsonText
                    case .persisted: return JsonValue.string("persisted").jsonText
                    }
                }.joined(separator: " + ")
            }
            if let spawns = tool.spawns { text += " spawns \(spawns.label)/\(spawns.state.rawValue)" }
            line = text
        case .notice(let notice):
            line = "notice(\(notice.level.rawValue)): \(notice.text)"
        case .command(let command):
            line = "command: \(command.line ?? "") -> \(command.output ?? "")"
        case .compaction(let compaction):
            line = "compaction \(compaction.trigger ?? "-")"
        case .turnEnd(let end):
            line = "turn-end \(end.outcome.rawValue) \(end.durationMs.map(JsonValue.javaScriptNumber) ?? "-")ms"
        }
        return ["\(pad)\(line)"] + codexOutline(transcript, entry.id, depth + 1)
    }
}

/// A Codex capture played into a fresh adapter: `> ` lines DevHub wrote, `< ` lines app-server printed.
func codexPlayed(_ name: String, _ adapter: CodexAdapter = CodexAdapter(CODEX_OPTIONS)) throws -> CodexAdapter {
    for line in Fixtures.text("codex", name).components(separatedBy: "\n") {
        if line.hasPrefix("> ") {
            _ = try adapter.sent(String(line.dropFirst(2)))
        } else if line.hasPrefix("< ") {
            _ = try adapter.received(String(line.dropFirst(2)))
        }
    }
    return adapter
}

/// `toThrow(/pattern/)`.
func assertThrowsMatching(
    _ pattern: String, file: StaticString = #filePath, line: UInt = #line, _ work: () throws -> Void
) {
    do {
        try work()
        XCTFail("it did not throw /\(pattern)/", file: file, line: line)
    } catch {
        let message = "\(error)"
        XCTAssertNotNil(
            message.range(of: pattern, options: .regularExpression), "\(message) does not match /\(pattern)/",
            file: file, line: line)
    }
}

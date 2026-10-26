// What the conversation tests share: the TS app's fixtures, and the helpers
// of apps/desktop/src/main/agent/conversation/claude/adapter.test.ts.

import Foundation
import XCTest
@testable import DevHubCore

enum Fixtures {
    /// `Tests/DevHubCoreTests/Fixtures/<area>/<name>`, read from the source tree.
    static func url(_ area: String, _ name: String) -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // Conversation
            .deletingLastPathComponent()  // DevHubCoreTests
            .appendingPathComponent("Fixtures").appendingPathComponent(area).appendingPathComponent(name)
    }

    static func text(_ area: String, _ name: String) -> String {
        (try? String(contentsOf: url(area, name), encoding: .utf8)) ?? ""
    }
}

enum Side { case sent, received }

struct FixtureLine {
    let side: Side
    let line: String
}

/// A conversation fixture: `> ` lines DevHub wrote, `< ` lines the CLI printed, `#` comments.
func fixture(_ name: String) -> [FixtureLine] {
    Fixtures.text("conversation", name)
        .components(separatedBy: "\n")
        .filter { !$0.isEmpty && !$0.hasPrefix("#") }
        .map { text in
            if text.hasPrefix("> ") { return FixtureLine(side: .sent, line: String(text.dropFirst(2))) }
            if text.hasPrefix("< ") { return FixtureLine(side: .received, line: String(text.dropFirst(2))) }
            fatalError("fixture \(name) has a line that is neither \"> \" nor \"< \": \(text)")
        }
}

@discardableResult
func play(_ adapter: ProtocolAdapter, _ lines: [FixtureLine]) throws -> [ConversationEvent] {
    var events: [ConversationEvent] = []
    for each in lines {
        let step = each.side == .sent ? try adapter.sent(each.line) : try adapter.received(each.line)
        events += step.events
    }
    return events
}

func json(_ value: JsonValue) -> String { value.jsonText }

/// `{ ...base, ...extra }`.
func merged(_ base: JsonObject, _ extra: JsonObject) -> JsonObject {
    var result = base
    for (key, value) in extra { result[key] = value }
    return result
}

/// Choose a setting, and write whatever lines it takes, as the caller does.
@discardableResult
func configure(_ adapter: ProtocolAdapter, _ which: SettingName, _ id: String) throws -> [String] {
    let step = try adapter.configure(which, id)
    for line in step.replies { _ = try adapter.sent(line) }
    return step.replies
}

/// Send what `encode` makes of a command, as the caller does once the write succeeds.
@discardableResult
func carryOut(_ adapter: ProtocolAdapter, _ command: ConversationCommand) throws -> [String] {
    let lines = try adapter.encode(command)
    for line in lines { _ = try adapter.sent(line) }
    return lines
}

func send(_ text: String, _ origin: SentOrigin = .person, images: [ImageRef] = []) -> ConversationCommand {
    .send(text: text, images: images, origin: origin)
}

func entry(_ adapter: ProtocolAdapter, _ id: String, file: StaticString = #filePath, line: UInt = #line) throws
    -> TranscriptEntry
{
    guard let found = adapter.transcript.entries.first(where: { $0.id.raw == id }) else {
        XCTFail("no entry \(id); have \(adapter.transcript.entries.map(\.id.raw).joined(separator: ", "))", file: file, line: line)
        throw AdapterRefusal("no entry \(id)")
    }
    return found
}

func toolOf(_ adapter: ProtocolAdapter, _ id: String, file: StaticString = #filePath, line: UInt = #line) throws
    -> ToolEntry
{
    guard let tool = try entry(adapter, id, file: file, line: line).toolEntry else {
        XCTFail("\(id) is not a tool entry", file: file, line: line)
        throw AdapterRefusal("\(id) is not a tool entry")
    }
    return tool
}

func ids(_ adapter: ProtocolAdapter) -> [String] { adapter.transcript.entries.map(\.id.raw) }

let SESSION = "00000000-0000-4000-8000-000000000009"

func initLine(_ fields: JsonObject = [:]) -> String {
    json(
        .object(
            merged(
                [
                    "type": "system", "subtype": "init", "session_id": .string(SESSION), "cwd": "/home/testuser/project",
                    "model": "claude-sonnet-5", "permissionMode": "default",
                    "slash_commands": ["review", "model", "effort", "permissions", "login", "logout"],
                    "claude_code_version": "2.1.0",
                ], fields)))
}

func echo(_ text: String, _ uuid: String) -> String {
    json([
        "type": "user", "message": ["role": "user", "content": .string(text)], "parent_tool_use_id": .null,
        "session_id": .string(SESSION), "uuid": .string(uuid),
    ])
}

func assistantLine(_ messageId: String, _ content: [JsonValue], _ parent: String? = nil, _ extra: JsonObject = [:])
    -> String
{
    json(
        .object(
            merged(
                [
                    "type": "assistant", "message": ["id": .string(messageId), "role": "assistant", "content": .array(content)],
                    "parent_tool_use_id": parent.map(JsonValue.string) ?? .null, "session_id": .string(SESSION),
                ], extra)))
}

func toolUse(_ id: String, _ name: String, _ input: JsonObject) -> JsonValue {
    ["type": "tool_use", "id": .string(id), "name": .string(name), "input": .object(input)]
}

func toolResult(_ toolUseId: String, _ content: String, _ isError: Bool = false) -> String {
    json([
        "type": "user",
        "message": [
            "role": "user",
            "content": [
                ["type": "tool_result", "tool_use_id": .string(toolUseId), "content": .string(content), "is_error": .bool(isError)]
            ],
        ],
        "parent_tool_use_id": .null, "session_id": .string(SESSION),
    ])
}

func stream(_ event: JsonValue, _ parent: String? = nil) -> String {
    json([
        "type": "stream_event", "event": event, "parent_tool_use_id": parent.map(JsonValue.string) ?? .null,
        "session_id": .string(SESSION),
    ])
}

func canUseTool(_ id: String, _ request: JsonObject) -> String {
    json(["type": "control_request", "request_id": .string(id), "request": .object(merged(["subtype": "can_use_tool"], request))])
}

func result(_ fields: JsonObject = [:]) -> String {
    json(
        .object(
            merged(
                [
                    "type": "result", "subtype": "success", "is_error": false, "duration_ms": 100, "result": "done",
                    "session_id": .string(SESSION), "total_cost_usd": 0.5,
                    "usage": ["input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 2],
                ], fields)))
}

func controlResponse(_ requestId: String, _ response: JsonValue? = nil, error: String? = nil) -> String {
    if let error {
        return json([
            "type": "control_response",
            "response": ["subtype": "error", "request_id": .string(requestId), "error": .string(error)],
        ])
    }
    var inner: JsonObject = ["subtype": "success", "request_id": .string(requestId)]
    if let response { inner["response"] = response }
    return json(["type": "control_response", "response": .object(inner)])
}

/// An adapter past the handshake, in a turn started by "go".
func inTurn(_ bootId: String = "boot") throws -> ClaudeAdapter {
    let adapter = ClaudeAdapter(bootId: bootId, now: { 1_000 })
    _ = try adapter.received(initLine())
    try carryOut(adapter, send("go"))
    _ = try adapter.received(echo("go", "u-go"))
    return adapter
}

/// `inTurn`, with a Bash call whose permission request `perm` is pending.
func askingForBash() throws -> ClaudeAdapter {
    let adapter = try inTurn()
    _ = try adapter.received(assistantLine("msg_1", [toolUse("toolu_1", "Bash", ["command": "rm -rf build"])]))
    _ = try adapter.received(
        canUseTool(
            "perm",
            [
                "tool_name": "Bash", "input": ["command": "rm -rf build"], "tool_use_id": "toolu_1",
                "decision_reason": "rm is not in the allow list",
                "permission_suggestions": [
                    [
                        "type": "addRules", "rules": [["toolName": "Bash", "ruleContent": "rm -rf build"]],
                        "behavior": "allow", "destination": "localSettings",
                    ],
                    ["type": "setMode", "mode": "acceptEdits", "destination": "session"],
                ],
            ]))
    return adapter
}

/// The JSON of each line, parsed: what `lines.map(JSON.parse)` compares.
func parsed(_ lines: [String]) -> [JsonValue] {
    lines.map { (try? JsonValue.parse($0)) ?? .null }
}

func assertThrows<T>(
    _ expression: @autoclosure () throws -> T, _ pattern: String, file: StaticString = #filePath, line: UInt = #line
) {
    XCTAssertThrowsError(try expression(), file: file, line: line) { error in
        let message = "\(error)"
        XCTAssertNotNil(
            message.range(of: pattern, options: .regularExpression), "\(message) does not match /\(pattern)/",
            file: file, line: line)
    }
}

func slash(_ name: String, _ description: String = "", _ hint: String? = nil, _ route: SlashRoute = .message) -> SlashCommand {
    SlashCommand(trigger: .slash, name: name, description: description, argumentHint: hint, route: route)
}

let DEVHUB_RESUME = slash("resume", "Go on with an earlier session in this Workspace", nil, .resume)
let DEVHUB_RESTART = slash(
    "restart", "Restart the session: start the CLI again, reconnecting its MCP servers", nil, .restart)
let DEVHUB_MCP = slash("mcp", "MCP servers: how each stands, reconnect, enable or disable, sign in", nil, .mcp)

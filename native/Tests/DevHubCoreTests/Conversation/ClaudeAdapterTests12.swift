// Port of apps/desktop/src/main/agent/conversation/claude/adapter.test.ts (12/12)

import XCTest
@testable import DevHubCore

final class ClaudeSendMessageWakeTests: XCTestCase {
    /// Launch in the background, fail, wake it with SendMessage, work, finish.
    func playing(_ adapter: ClaudeAdapter) throws -> [String] {
        var seen: [String] = []
        func look() throws {
            let agent = try toolOf(adapter, "tool:toolu_agent")
            let send = adapter.transcript.entries.first { $0.id == "tool:toolu_send" }?.toolEntry
            seen.append(
                [
                    "agent \(agent.spawns!.state.rawValue)",
                    "send \(send?.status.rawValue ?? "-")/\(send?.background?.state.rawValue ?? "-")",
                    "bar \(adapter.transcript.backgroundTasks.map { $0.call?.raw ?? "-" }.joined(separator: ","))",
                ].joined(separator: " "))
        }
        _ = try adapter.received(
            assistantLine(
                "m1",
                [
                    toolUse(
                        "toolu_agent", "Agent",
                        ["description": "Survey", "prompt": "survey it", "subagent_type": "general", "run_in_background": true])
                ]))
        _ = try adapter.received(
            withFields(
                toolResult("toolu_agent", "Async agent launched"),
                ["tool_use_result": ["isAsync": true, "status": "async_launched", "agentId": "agent-x"]]))
        _ = try adapter.received(
            system(
                "task_notification",
                ["task_id": "agent-x", "tool_use_id": "toolu_agent", "status": "failed", "summary": "It stopped."]))
        try look()
        _ = try adapter.received(assistantLine("m2", [toolUse("toolu_send", "SendMessage", ["to": "agent-x", "message": "try again"])]))
        _ = try adapter.received(
            system(
                "task_started",
                ["task_id": "agent-x", "tool_use_id": "toolu_send", "task_type": "local_agent", "description": "Survey"]))
        _ = try adapter.received(
            system(
                "background_tasks_changed",
                ["tasks": [["task_id": "agent-x", "task_type": "local_agent", "description": "Survey"]]]))
        _ = try adapter.received(toolResult("toolu_send", "Message sent."))
        try look()
        _ = try adapter.received(
            system("task_progress", ["task_id": "agent-x", "tool_use_id": "toolu_send", "description": "Survey"]))
        try look()
        _ = try adapter.received(
            system(
                "task_notification",
                ["task_id": "agent-x", "tool_use_id": "toolu_send", "status": "completed", "summary": "Done this time."]))
        _ = try adapter.received(system("background_tasks_changed", ["tasks": []]))
        try look()
        return seen
    }

    let STATES = [
        "agent failed send -/- bar ",
        "agent running send succeeded/- bar tool:toolu_agent",
        "agent running send succeeded/- bar tool:toolu_agent",
        "agent completed send succeeded/- bar ",
    ]

    func testIsTheSubagentTheAgentCallStartedAndTheSendMessageCallOnlyAMessage() throws {
        XCTAssertEqual(try playing(try inTurn()), STATES)
    }

    func testReadsTheSameInAReplay() throws {
        _ = try playing(try inTurn())
        XCTAssertEqual(try playing(try inTurn()), STATES)
    }
}

final class ClaudeMcpTests: XCTestCase {
    let SLACK = "plugin:slack:slack"

    /// The handshake answered; returns what the answer had DevHub write.
    @discardableResult
    func handshake(_ adapter: ClaudeAdapter) throws -> [JsonValue] {
        for line in try adapter.opening() { _ = try adapter.sent(line) }
        let step = try adapter.received(controlResponse("boot:1", ["commands": [], "models": []]))
        for line in step.replies { _ = try adapter.sent(line) }
        return parsed(step.replies)
    }

    func status(_ requestId: String, _ servers: [JsonValue]) -> String {
        controlResponse(requestId, ["mcpServers": .array(servers)])
    }

    /// The person's MCP request, written; the control request it was.
    func request(_ adapter: ClaudeAdapter, _ mcp: McpRequest) throws -> JsonValue {
        let lines = try adapter.encode(.mcp(mcp))
        XCTAssertEqual(lines.count, 1)
        _ = try adapter.sent(lines[0])
        return parsed(lines)[0]
    }

    /// Up, with the status request answered with `servers`.
    func reporting(_ servers: [JsonValue]) throws -> ClaudeAdapter {
        let adapter = ClaudeAdapter(bootId: "boot")
        try handshake(adapter)
        _ = try adapter.received(status("boot:2", servers))
        return adapter
    }

    func testAsksHowTheyStandAsSoonAsTheCLIIsUp() throws {
        let adapter = ClaudeAdapter(bootId: "boot")
        XCTAssertEqual(
            try handshake(adapter), [["type": "control_request", "request_id": "boot:2", "request": ["subtype": "mcp_status"]]])
        XCTAssertNil(adapter.transcript.mcp.servers)
    }

    func testReadsEachServersStatusSourceAndFailure() throws {
        let adapter = try reporting([
            ["name": "playwright", "status": "connected", "scope": "user"],
            ["name": .string(SLACK), "status": "needs-auth", "scope": "plugin"],
            ["name": "db", "status": "failed", "error": "HTTP 503", "scope": "project"],
            ["name": "slow", "status": "pending", "scope": "local"], ["name": "off", "status": "disabled", "scope": "user"],
            ["name": "odd", "status": "sleeping"],
        ])
        XCTAssertEqual(
            adapter.transcript.mcp.servers,
            [
                McpServer(name: "playwright", status: .connected, said: "connected", error: nil, source: "user", actions: [.reconnect, .disable]),
                McpServer(
                    name: SLACK, status: .needsSignIn, said: "needs-auth", error: nil, source: "plugin",
                    actions: [.signIn, .reconnect, .disable]),
                McpServer(name: "db", status: .failed, said: "failed", error: "HTTP 503", source: "project", actions: [.reconnect, .disable]),
                McpServer(name: "slow", status: .connecting, said: "pending", error: nil, source: "local", actions: [.disable]),
                McpServer(name: "off", status: .disabled, said: "disabled", error: nil, source: "user", actions: [.enable]),
                McpServer(name: "odd", status: .unknown, said: "sleeping", error: nil, source: nil, actions: [.reconnect, .disable]),
            ])
    }

    func testSaysNothingAboutThemInTheConversation() throws {
        let adapter = try reporting([["name": .string(SLACK), "status": "needs-auth"]])
        _ = try adapter.received(
            initLine([
                "mcp_servers": [["name": .string(SLACK), "status": "failed", "error": "HTTP 503"]],
                "plugin_errors": [["plugin": "broken", "type": "dependency", "message": "needs x@2"]],
            ]))
        XCTAssertEqual(adapter.transcript.entries, [])
        XCTAssertEqual(adapter.transcript.mcp.pluginErrors, [PluginError(plugin: "broken", message: "needs x@2")])
    }

    func testKeepsThemUpToDate() throws {
        let adapter = try reporting([["name": .string(SLACK), "status": "pending", "scope": "plugin"]])
        _ = try adapter.received(initLine(["mcp_servers": [["name": .string(SLACK), "status": "failed", "error": "HTTP 503"]]]))
        let server = try XCTUnwrap(adapter.transcript.mcp.servers?.first)
        XCTAssertEqual(adapter.transcript.mcp.servers?.count, 1)
        XCTAssertEqual(server.name, SLACK)
        XCTAssertEqual(server.status, .failed)
        XCTAssertEqual(server.error, "HTTP 503")
        XCTAssertEqual(server.source, "plugin")
        try carryOut(adapter, send("hi"))
        _ = try adapter.received(echo("hi", "u1"))
        let ended = try adapter.received(result())
        let asked = parsed(ended.replies)
        XCTAssertEqual(asked.count, 1)
        XCTAssertEqual(asked[0]["request"], ["subtype": "mcp_status"])
        for line in ended.replies { _ = try adapter.sent(line) }
        _ = try adapter.received(
            status(try XCTUnwrap(asked[0]["request_id"]?.stringValue), [["name": .string(SLACK), "status": "connected", "scope": "plugin"]]))
        XCTAssertEqual(adapter.transcript.mcp.servers?.first?.status, .connected)
    }

    func testAsksAgainWhenThePanelAsks() throws {
        XCTAssertEqual(try request(try reporting([]), .refresh)["request"], ["subtype": "mcp_status"])
    }

    func testReconnectsAServerWithMcpReconnect() throws {
        let adapter = try reporting([["name": "db", "status": "failed"]])
        let sent = try request(adapter, .act(action: .reconnect, server: "db"))
        XCTAssertEqual(sent["request"], ["subtype": "mcp_reconnect", "serverName": "db"])
        XCTAssertEqual(adapter.transcript.mcp.working, [McpWork(server: "db", action: .reconnect)])
        let answered = try adapter.received(controlResponse(try XCTUnwrap(sent["request_id"]?.stringValue), [:]))
        XCTAssertEqual(adapter.transcript.mcp.working, [])
        XCTAssertEqual(parsed(answered.replies).map { $0["request"] }, [["subtype": "mcp_status"]])
    }

    func testEnablesAndDisablesAServerWithMcpToggle() throws {
        let adapter = try reporting([["name": "on", "status": "connected"], ["name": "off", "status": "disabled"]])
        XCTAssertEqual(
            try request(adapter, .act(action: .disable, server: "on"))["request"],
            ["subtype": "mcp_toggle", "serverName": "on", "enabled": false])
        XCTAssertEqual(
            try request(adapter, .act(action: .enable, server: "off"))["request"],
            ["subtype": "mcp_toggle", "serverName": "off", "enabled": true])
        XCTAssertEqual(
            adapter.transcript.mcp.working, [McpWork(server: "on", action: .disable), McpWork(server: "off", action: .enable)])
    }

    func testRefusesAnActionItDoesNotOfferForThatServerNow() throws {
        let adapter = try reporting([["name": "off", "status": "disabled"]])
        assertThrows(
            try adapter.encode(.mcp(.act(action: .reconnect, server: "off"))), "reconnect is not offered for the MCP server off now")
        assertThrows(
            try adapter.encode(.mcp(.act(action: .disable, server: "nowhere"))),
            "disable is not offered for the MCP server nowhere now")
    }

    func testSaysARefusedRequestInThePanelUntilTheNextOne() throws {
        let adapter = try reporting([["name": "db", "status": "failed"]])
        let first = try request(adapter, .act(action: .reconnect, server: "db"))
        _ = try adapter.received(controlResponse(try XCTUnwrap(first["request_id"]?.stringValue), error: "Server not found: db"))
        XCTAssertEqual(adapter.transcript.mcp.failure, "Reconnecting db failed: Server not found: db")
        XCTAssertEqual(adapter.transcript.mcp.working, [])
        XCTAssertEqual(adapter.transcript.entries, [])
        _ = try request(adapter, .act(action: .reconnect, server: "db"))
        XCTAssertNil(adapter.transcript.mcp.failure)
    }

    func testSaysARefusedStatusRequestInThePanel() throws {
        let adapter = ClaudeAdapter(bootId: "boot")
        try handshake(adapter)
        _ = try adapter.received(controlResponse("boot:2", error: "unknown subtype"))
        XCTAssertEqual(adapter.transcript.mcp.failure, "Listing the MCP servers failed: unknown subtype")
        XCTAssertEqual(adapter.transcript.entries, [])
    }

    func testRefusesAServerReportedWithoutItsStatus() throws {
        let adapter = ClaudeAdapter(bootId: "boot")
        try handshake(adapter)
        XCTAssertThrowsError(try adapter.received(status("boot:2", [["name": .string(SLACK)]]))) {
            XCTAssertTrue($0 is ProtocolMismatch)
        }
    }
}

final class ClaudeUndrawnAgentCallTests: XCTestCase {
    /// The shape seen: the Agent call that started "agent-old" is not in what
    /// DevHub read (it came before the history drawn, or a rewind cut it), and
    /// SendMessage wakes the subagent, whose messages name that call.
    func lines() -> [String] {
        [
            assistantLine("m1", [toolUse("toolu_send", "SendMessage", ["to": "agent-old", "message": "one more thing"])]),
            system(
                "task_started",
                ["task_id": "agent-old", "tool_use_id": "toolu_send", "task_type": "local_agent", "description": "Survey"]),
            toolResult("toolu_send", "Message sent."),
            stream(["type": "message_start", "message": ["id": "s1"]], "toolu_earlier"),
            stream(["type": "content_block_start", "index": 0, "content_block": ["type": "text", "text": ""]], "toolu_earlier"),
            stream(
                ["type": "content_block_delta", "index": 0, "delta": ["type": "text_delta", "text": "Looking again."]],
                "toolu_earlier"),
            assistantLine(
                "s1", [["type": "text", "text": "Looking again."], toolUse("toolu_sub_bash", "Bash", ["command": "ls"])],
                "toolu_earlier"),
            json([
                "type": "user",
                "message": [
                    "role": "user",
                    "content": [["type": "tool_result", "tool_use_id": "toolu_sub_bash", "content": "a.txt", "is_error": false]],
                ],
                "parent_tool_use_id": "toolu_earlier", "session_id": .string(SESSION),
            ]),
            assistantLine("s2", [["type": "text", "text": "Found it."]], "toolu_earlier"),
            system(
                "task_notification",
                ["task_id": "agent-old", "tool_use_id": "toolu_send", "status": "completed", "summary": "Found it."]),
            result(),
        ]
    }

    func played() throws -> ClaudeAdapter {
        let adapter = try inTurn()
        for line in lines() { _ = try adapter.received(line) }
        return adapter
    }

    func testDrawsThatCallWhereItsSubagentIsFirstHeardOf() throws {
        let adapter = try played()
        let earlier = try toolOf(adapter, "tool:toolu_earlier")
        XCTAssertNil(earlier.parent)
        XCTAssertEqual(earlier.tool, "Agent")
        XCTAssertEqual(earlier.title, "Agent: A subagent started earlier in this session")
        XCTAssertEqual(earlier.status, .succeeded)
        XCTAssertEqual(earlier.spawns?.label, "A subagent started earlier in this session")
        XCTAssertEqual(earlier.spawns?.state, .unknown)
        XCTAssertEqual(
            childrenOf(adapter.transcript, "tool:toolu_earlier").map(\.id.raw),
            ["assistant:s1:0", "tool:toolu_sub_bash", "assistant:s2:0"])
        XCTAssertEqual(try toolOf(adapter, "tool:toolu_sub_bash").status, .succeeded)
        XCTAssertEqual(
            childrenOf(adapter.transcript, nil).map(\.id.raw), ["user:u-go", "tool:toolu_send", "tool:toolu_earlier", "turn:1"])
        XCTAssertNotEqual(adapter.transcript.state.phase, "broken")
    }

    func testReadsTheSameInAReplay() throws {
        XCTAssertEqual(try played().transcript, try played().transcript)
    }
}

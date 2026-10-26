// The Codex adapter in a whole conversation (WP5's `AgentConversation`) on
// the fake host: the handshake, turns, a rewind carried out by the request
// Codex has for it (`RewindPlan.write`), `/resume` the same way, a restart by
// the host — and a new DevHub on the same journal replaying to the same
// transcript, writing nothing. What the TS app's rewind, resumeSession and
// restartSession tests prove of Claude through a real host, for Codex.

import Foundation
import XCTest
@testable import DevHubCore

/// A fake `codex app-server` behind the fake host: it answers the handshake
/// from the fixture, and each message with one turn of one answer.
private final class FakeAppServer: @unchecked Sendable {
    private let lock = NSRecursiveLock()
    private var turns = 0
    private var thread = CODEX_MAIN

    init(_ host: FakeHost) {
        let handshake = codexFixture("handshake.handwritten.ndjson").map { j($0) }
        host.onWrite = { [self] line in
            guard case .object(let message)? = try? JsonValue.parse(line), case .string(let method)? = message["method"]
            else { return }
            let id = message["id"] ?? .null
            func answer(_ result: JsonValue) {
                host.print(JsonValue.object(JsonObject([("id", id), ("result", result)])).jsonText)
            }
            lock.withLock {
                switch method {
                case "initialize": answer(handshake[0]["result"]!)
                case "account/read": answer(handshake[1]["result"]!)
                case "thread/start": answer(handshake[2]["result"]!)
                case "thread/resume":
                    thread = message["params"]?["threadId"]?.stringValue ?? CODEX_MAIN
                    answer(setting(handshake[2], ["result", "thread", "id"], .string(thread))["result"]!)
                case "model/list": answer(handshake[4]["result"]!)
                case "skills/list": answer(handshake[5]["result"]!)
                case "thread/revert":
                    answer(j(#"{"thread":{"id":"\#(thread)","turns":[]},"turnsBackwardsCursor":null,"itemsBackwardsCursor":null}"#))
                case "turn/start":
                    turns += 1
                    let turn = "turn-\(turns)"
                    let clientId = message["params"]?["clientUserMessageId"]?.stringValue ?? ""
                    let text = message["params"]?["input"]?.arrayValue?.first?["text"]?.stringValue ?? ""
                    func turnJson(_ status: String) -> String {
                        #"{"id":"\#(turn)","items":[],"itemsView":"notLoaded","status":"\#(status)","error":null,"startedAt":null,"completedAt":null,"durationMs":\#(status == "completed" ? "1" : "null")}"#
                    }
                    answer(j(#"{"turn":\#(turnJson("inProgress"))}"#))
                    host.print(#"{"method":"turn/started","params":{"threadId":"\#(thread)","turn":\#(turnJson("inProgress"))}}"#)
                    host.print(
                        #"{"method":"item/completed","params":{"threadId":"\#(thread)","turnId":"\#(turn)","completedAtMs":0,"item":{"type":"userMessage","id":"u-\#(turns)","clientId":"\#(clientId)","content":[{"type":"text","text":\#(JsonValue.quoted(text)),"text_elements":[]}]}}}"#
                    )
                    host.print(
                        #"{"method":"item/completed","params":{"threadId":"\#(thread)","turnId":"\#(turn)","completedAtMs":0,"item":{"type":"agentMessage","id":"a-\#(turns)","text":"answer \#(turns)","phase":null,"memoryCitation":null,"delivery":null,"questions":null}}}"#
                    )
                    host.print(#"{"method":"turn/completed","params":{"threadId":"\#(thread)","turn":\#(turnJson("completed"))}}"#)
                default:
                    break
                }
            }
        }
    }
}

private func codexConversation(_ host: FakeHost, resume thread: String? = nil) -> AgentConversation {
    AgentConversation(
        host: host,
        adapter: guiConversationAdapter(
            .codex, profileArgs: thread.map { ["resume", $0] } ?? [], bootId: "boot", cwd: CODEX_CWD,
            clientVersion: "0.1.0"),
        publish: { _, _ in }, limits: resumeOff())
}

final class CodexConversationTests: XCTestCase {
    func talked(_ host: FakeHost) async throws -> AgentConversation {
        _ = FakeAppServer(host)
        let conversation = codexConversation(host)
        try await conversation.start()
        await settle(conversation, host)
        for text in ["one", "two"] {
            try await conversation.submit(text, images: [])
            await settle(conversation, host)
        }
        return conversation
    }

    func outline(_ conversation: AgentConversation) async -> [String] {
        codexOutline(await conversation.reading().transcript)
    }

    func testGreetsAppServerTalksAndANewDevHubReplaysToTheSameWritingNothing() async throws {
        let host = FakeHost()
        let conversation = try await talked(host)
        let drawn = await outline(conversation)
        XCTAssertEqual(
            drawn,
            [
                "user(person): one", "assistant: answer 1", "turn-end completed 1ms", "user(person): two",
                "assistant: answer 2", "turn-end completed 1ms",
            ])
        // What the conversation wrote is what the TS app writes, in order.
        XCTAssertEqual(
            host.inLog.map { (try? JsonValue.parse($0.line))?["method"]?.stringValue ?? "reply" },
            ["initialize", "initialized", "account/read", "thread/start", "model/list", "skills/list", "turn/start", "turn/start"])
        let live = await conversation.reading().transcript
        await conversation.stop()
        let writes = host.inLog.count

        let again = codexConversation(host)
        try await again.start()
        await settle(again, host)
        let replayed = await again.reading().transcript
        XCTAssertEqual(replayed, live)
        XCTAssertEqual(host.inLog.count, writes)
        await again.stop()
    }

    func testRewindsByThreadRevertAndANewDevHubReplaysToTheRewoundTranscript() async throws {
        let host = FakeHost()
        let conversation = try await talked(host)
        let second = EntryId("\(CODEX_MAIN)/u-2")
        let outcome = try await conversation.rewind(second)
        await settle(conversation, host)
        XCTAssertEqual(outcome, .rewound)
        XCTAssertEqual(
            host.inLog.last.flatMap { try? JsonValue.parse($0.line) },
            j(#"{"id":7,"method":"thread/revert","params":{"threadId":"\#(CODEX_MAIN)","beforeTurnId":"turn-2"}}"#))
        let rewound = await outline(conversation)
        XCTAssertEqual(rewound, ["user(person): one", "assistant: answer 1", "turn-end completed 1ms"])
        XCTAssertEqual(host.restarts, [])
        let live = await conversation.reading().transcript
        await conversation.stop()

        let again = codexConversation(host)
        try await again.start()
        await settle(again, host)
        let replayed = await again.reading().transcript
        XCTAssertEqual(replayed, live)
        await again.stop()
    }

    func testGoesOnWithAnotherThreadOnTheSameAppServer() async throws {
        let host = FakeHost()
        let conversation = try await talked(host)
        let other = "00000000-0000-7000-8000-0000000000b2"
        try await conversation.resumeSession(other, history: [])
        await settle(conversation, host)
        let transcript = await conversation.reading().transcript
        XCTAssertEqual(transcript.session.sessionId, other)
        XCTAssertEqual(transcript.entries, [])
        XCTAssertEqual(transcript.state, .ready(turn: .none))
        XCTAssertEqual(host.restarts, [])
        try await conversation.submit("there", images: [])
        await settle(conversation, host)
        XCTAssertEqual(
            host.inLog.last.flatMap { try? JsonValue.parse($0.line) }?["params"]?["threadId"], .string(other))
        await conversation.stop()
    }

    func testRestartsAppServerOnTheSameThreadUnderAQuietDivider() async throws {
        let host = FakeHost()
        let conversation = try await talked(host)
        try await conversation.restart()
        await settle(conversation, host)
        XCTAssertEqual(host.restarts, [FakeHost.Restart(args: [], mark: [RESTART_MARK])])
        let transcript = await conversation.reading().transcript
        XCTAssertEqual(codexOutline(transcript).last, "notice(info): \(RESTARTED)")
        XCTAssertEqual(transcript.state, .ready(turn: .none))
        XCTAssertEqual(transcript.session.sessionId, CODEX_MAIN)
        // The new server was greeted and handed the thread already drawn.
        let methods = host.inLog.map { (try? JsonValue.parse($0.line))?["method"]?.stringValue ?? "reply" }
        XCTAssertEqual(
            Array(methods.suffix(6)),
            ["initialize", "initialized", "account/read", "thread/resume", "model/list", "skills/list"])
        await conversation.stop()

        let again = codexConversation(host)
        try await again.start()
        await settle(again, host)
        let replayed = await again.reading().transcript.entries
        XCTAssertEqual(replayed, transcript.entries)
        await again.stop()
    }

    func testAResumedLaunchResumesTheThreadItsArgvEndedWith() async throws {
        let host = FakeHost()
        _ = FakeAppServer(host)
        let conversation = codexConversation(host, resume: "t-earlier")
        try await conversation.start()
        await settle(conversation, host)
        XCTAssertEqual(
            host.inLog.map(\.line).first { $0.contains("thread/resume") },
            #"{"id":2,"method":"thread/resume","params":{"threadId":"t-earlier","cwd":"\#(CODEX_CWD)"}}"#)
        let session = await conversation.reading().transcript.session.sessionId
        XCTAssertEqual(session, "t-earlier")
        await conversation.stop()
    }
}

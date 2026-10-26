// Ports of apps/desktop/src/main/agent/conversation/{rewind,restartSession,
// resumeSession}.test.ts: end to end on this machine — the real host, the
// fake agent playing a Claude that is started again
// (Fixtures/agent-conversation, from apps/desktop/test/fixtures/agent-conversation),
// the real Claude adapter and conversation, and a second DevHub attaching to
// what the first left.

import Foundation
import XCTest
@testable import DevHubCore

private func agentFixture(_ name: String) -> String { Fixtures.url("agent-conversation", name).path }

/// The conversation as a reader follows it: words, calls and DevHub's notices.
private func lines(_ transcript: Transcript, tools: Bool = true) -> [String] {
    transcript.entries.flatMap { entry -> [String] in
        switch entry {
        case .user(let user): return ["> \(user.text)"]
        case .assistant(let assistant):
            return assistant.blocks.compactMap { block in
                if case .text(let markdown) = block { return "< \(markdown)" }
                return nil
            }
        case .tool(let tool): return tools ? ["\(tool.tool) \(tool.status.rawValue)"] : []
        case .notice(let notice): return tools ? ["-- \(notice.text)"] : []
        default: return []
        }
    }
}

private func idle(_ transcript: Transcript) -> Bool { transcript.state == .ready(turn: .none) }

private func turnsEnded(_ count: Int) -> (Transcript) -> Bool {
    { transcript in idle(transcript) && transcript.entries.filter { $0.turnEndEntry != nil }.count == count }
}

private func until(
    _ conversation: AgentConversation, file: StaticString = #filePath, line: UInt = #line,
    _ done: (Transcript) -> Bool
) async throws {
    for _ in 0..<400 {
        if done(await conversation.reading().transcript) { return }
        try await Task.sleep(nanoseconds: 25_000_000)
    }
    let reading = await conversation.reading()
    XCTFail(
        "the conversation did not get there: \(lines(reading.transcript)) \(reading.transcript.state) lost \(String(describing: reading.lost)) crashed \(String(describing: reading.crashed))",
        file: file, line: line)
    throw CancellationError()
}

final class ConversationThroughHostTests: HostTestCase {
    private var environment: [String] = []

    /// What the host and the CLIs it starts read (`FAKE_AGENT_*`), until the test ends.
    private func export(_ values: [String: String]) {
        for (name, value) in values {
            setenv(name, value, 1)
            environment.append(name)
        }
    }

    override func tearDown() {
        super.tearDown()
        for name in environment { unsetenv(name) }
        environment = []
    }

    private func hosted(_ link: HostLink, _ profile: GuiAgentProfile) -> any ConversationHost {
        hostOn(link) { session in
            let cli = guiAgentCli(profile, session: session)
            return RestartedCLI(file: cli.file, args: cli.args)
        }
    }

    private func start(_ profile: GuiAgentProfile, _ env: [String: String]) throws -> String {
        let directory = try stateDirectory()
        export(env)
        let cli = guiAgentCli(profile)
        try startHost(directory, [cli.file] + cli.args)
        return directory
    }

    /// A second DevHub on what the first left: the same transcript, nothing written.
    private func replays(_ directory: String, _ profile: GuiAgentProfile, to live: Transcript) async throws {
        let link = self.link(directory)
        let written = try await link.sentLog().count
        let again = AgentConversation(
            host: hosted(link, profile), adapter: ClaudeAdapter(bootId: "boot-b"), publish: { _, _ in },
            limits: resumeOff())
        try await again.start()
        try await until(again) { $0.entries.count == live.entries.count }
        let replayed = await again.reading().transcript
        XCTAssertEqual(replayed, live)
        let after = try await link.sentLog().count
        XCTAssertEqual(after, written)
        await again.stop()
    }

    /// Until the CLI started again has been greeted and asked how its MCP
    /// servers stand: the replies its first answer demands, written before
    /// anything of the person's (see the native fixtures' heads).
    private func untilGreeted(_ directory: String) async throws {
        let link = self.link(directory)
        for _ in 0..<400 {
            let sent = try await link.sentLog().map(\.line)
            if sent.count >= 2, sent[sent.count - 2].contains(#""initialize""#), sent[sent.count - 1].contains("mcp_status") {
                return
            }
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        XCTFail("the CLI started again was not greeted")
        throw CancellationError()
    }

    func testRewindStartsTheFakeClaudeAgainAtTheCutAndANewDevHubReplaysToTheSame() async throws {
        // A resumed launch, as Continue in GUI makes: its record already picks
        // a session, which the rewind's must replace rather than follow.
        let profile = GuiAgentProfile(kind: .claude, command: "/bin/sh", args: [FAKE_AGENT, "--resume", "the launch's session"])
        let directory = try start(
            profile,
            [
                "FAKE_AGENT_SCRIPT": agentFixture("claude-rewind.first.ndjson"),
                "FAKE_AGENT_REWIND_SCRIPT": agentFixture("claude-rewind.rewound.ndjson"),
            ])
        let conversation = AgentConversation(
            host: hosted(link(directory), profile), adapter: ClaudeAdapter(bootId: "boot-a"), publish: { _, _ in },
            limits: resumeOff())
        try await conversation.start()
        try await until(conversation, idle)
        for (index, text) in ["Say one", "Say two", "Say three"].enumerated() {
            try await conversation.submit(text, images: [])
            try await until(conversation, turnsEnded(index + 1))
        }
        let transcript = await conversation.reading().transcript
        let targets = transcript.entries.compactMap(\.userEntry).filter { rewindTargets(transcript).contains($0.id) }
        XCTAssertEqual(targets.map(\.text), ["Say one", "Say two", "Say three"])

        let outcome = try await conversation.rewind(targets[1].id)
        XCTAssertEqual(outcome, .rewound)
        var said = await lines(conversation.reading().transcript, tools: false)
        XCTAssertEqual(said, ["> Say one", "< One."])
        try await until(conversation, idle)
        try await untilGreeted(directory)
        try await conversation.submit("Say four", images: [])
        try await until(conversation, turnsEnded(2))
        said = await lines(conversation.reading().transcript, tools: false)
        XCTAssertEqual(said, ["> Say one", "< One.", "> Say four", "< Four."])
        let live = await conversation.reading().transcript
        await conversation.stop()

        try await replays(directory, profile, to: live)
    }

    func testRestartStopsTheFakeClaudeMidTurnStartsItAgainOnTheSameSessionAndANewDevHubReplaysToTheSame()
        async throws
    {
        let session = "00000000-0000-4000-8000-0000000000e5"
        let profile = GuiAgentProfile(kind: .claude, command: "/bin/sh", args: [FAKE_AGENT])
        let directory = try start(
            profile,
            [
                "FAKE_AGENT_SCRIPT": agentFixture("claude-restart.first.ndjson"),
                // Started again on any other session, the fake exits instead.
                "FAKE_AGENT_RESUME_SCRIPT": agentFixture("claude-restart.restarted.ndjson"),
                "FAKE_AGENT_RESUME_SESSION": session,
            ])
        let conversation = AgentConversation(
            host: hosted(link(directory), profile), adapter: ClaudeAdapter(bootId: "boot-a"), publish: { _, _ in },
            limits: resumeOff())
        try await conversation.start()
        try await until(conversation, idle)
        let say = { (text: String) in
            try await conversation.command(.send(text: text, images: [], origin: .person))
        }
        try await say("Say one")
        try await until(conversation) { idle($0) && lines($0).contains("< One.") }
        try await say("Keep going")
        try await until(conversation) { lines($0).contains("Bash running") }

        try await conversation.restart()
        let restarted = await conversation.reading().transcript
        XCTAssertEqual(restarted.session.sessionId, session)
        XCTAssertEqual(restarted.state, .ready(turn: .none))
        XCTAssertEqual(lines(restarted), ["> Say one", "< One.", "> Keep going", "Bash interrupted", "-- \(RESTARTED)"])
        try await untilGreeted(directory)

        try await say("Go on")
        try await until(conversation) { idle($0) && lines($0).last == "< Going on." }
        let live = await conversation.reading().transcript
        XCTAssertEqual(live.session.sessionId, session)
        XCTAssertEqual(Array(lines(live).suffix(3)), ["-- \(RESTARTED)", "> Go on", "< Going on."])
        await conversation.stop()

        try await replays(directory, profile, to: live)
    }

    func testResumeStartsTheFakeClaudeAgainOnTheOtherSessionDrawsItsPastAndANewDevHubReplaysToTheSame()
        async throws
    {
        let other = "00000000-0000-4000-8000-0000000000a1"
        let profile = GuiAgentProfile(kind: .claude, command: "/bin/sh", args: [FAKE_AGENT])
        let directory = try start(
            profile,
            [
                "FAKE_AGENT_SCRIPT": agentFixture("claude-resume.first.ndjson"),
                "FAKE_AGENT_RESUME_SCRIPT": agentFixture("claude-resume.resumed.ndjson"),
            ])
        let conversation = AgentConversation(
            host: hosted(link(directory), profile), adapter: ClaudeAdapter(bootId: "boot-a"), publish: { _, _ in },
            limits: resumeOff())
        try await conversation.start()
        try await until(conversation, idle)
        try await conversation.command(.send(text: "Say one", images: [], origin: .person))
        try await until(conversation, turnsEnded(1))

        let history = try claudeHistoryLines(
            session: other, text: Fixtures.text("conversation", "claude-session-file.handwritten.jsonl"))
        try await conversation.resumeSession(other, history: history)
        let resumed = await conversation.reading().transcript
        XCTAssertEqual(resumed.session.sessionId, other)
        XCTAssertFalse(lines(resumed, tools: false).contains("> Say one"))
        XCTAssertTrue(lines(resumed, tools: false).contains("> List the files in src"))
        try await untilGreeted(directory)

        try await conversation.command(.send(text: "Go on", images: [], origin: .person))
        try await until(conversation) { idle($0) && lines($0, tools: false).last == "< Going on." }
        let live = await conversation.reading().transcript
        XCTAssertEqual(Array(lines(live, tools: false).suffix(2)), ["> Go on", "< Going on."])
        await conversation.stop()

        try await replays(directory, profile, to: live)
    }
}

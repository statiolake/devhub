// Ports of apps/desktop/src/main/shell/agentLaunchPresentation.test.ts (the
// GUI launches) and machineRouting.test.ts's GUI cases, and tests of the GUI
// half of agentWiring.ts that the TS app covers only through its pages and
// main-process integration: the conversation made on first ask and kept, the
// round's reading of it, an injection sent as the queue's, Restart session's
// failures named, the ending said once the row has gone, the MCP sign-in's
// refusals, the usage readout fed from a conversation, and `--tell`'s view
// of a conversation (appController.ts `tellPorts().conversation`).
//
// The conversations here run on WP5's `FakeHost` with a scripted Claude
// (`AnsweringCli`), behind the wiring's own `link` seam; the end-to-end case
// at the bottom runs the real host script with the fake agent under it, the
// way a tmux session would.

import Foundation
import XCTest
@testable import DevHubCore

let GUI_WORKSPACE = "00000000-0000-4000-8000-0000000000d1"
let GUI_AGENT = "550e8400-e29b-41d4-a716-4466554400d0"

/// A host's files on a `FakeHost`: the conversation's link and the ending.
final class FakeLink: GuiHostLink, @unchecked Sendable {
    let host: FakeHost
    private let lock = NSLock()
    private var _ending: HostEnding = .exited(code: 0, stderrTail: "")
    private var _endingFailure: HostLinkFailure?
    private var _clis: [RestartedCLI] = []

    init(_ host: FakeHost) { self.host = host }

    var ending: HostEnding {
        get { lock.withLock { _ending } }
        set { lock.withLock { _ending = newValue } }
    }
    var endingFailure: HostLinkFailure? {
        get { lock.withLock { _endingFailure } }
        set { lock.withLock { _endingFailure = newValue } }
    }
    var clis: [RestartedCLI] { lock.withLock { _clis } }

    func lines(from fromOffset: Int, cancel: CancellationFlag) -> AsyncThrowingStream<JournalLine, Error> {
        host.lines(from: fromOffset, cancel: cancel)
    }
    func write(_ line: String, afterOffset: Int) async throws { try await host.write(line, afterOffset: afterOffset) }
    func restart(_ cli: RestartedCLI, mark: [String]) async throws {
        lock.withLock { _clis.append(cli) }
        if cli.file == "sleep" {
            try await host.sleep(mark: mark)
        } else {
            try await host.restart(session: cli.args, mark: mark)
        }
    }
    func sentLog() async throws -> [SentRecord] { try await host.sentLog() }
    func ending() async throws -> HostEnding {
        if let failure = endingFailure { throw failure }
        return ending
    }
}

/// The sessions a launch was handed, and nothing started.
final class RecordingSessions: GuiAgentSessions, @unchecked Sendable {
    let launched = Recorder<AgentLaunchSpec>()
    var failure: Error?
    func launchGuiSession(_ spec: AgentLaunchSpec) async throws {
        if let failure { throw failure }
        launched.add(spec)
    }
}

/// One GUI Agent in one Workspace, its conversation on a fake host.
final class GuiRig {
    let home: String
    let model: WiringModel
    let sessions = RecordingSessions()
    let reports = Recorder<String>()
    let host = FakeHost()
    let link: FakeLink
    let cli: AnsweringCli
    let wiring: GuiAgentWiring
    let records = MemoryRecords()

    init(kind: AgentProfileKind = .claude, presentation: AgentPresentation = .gui, name: String = "Claude") {
        home = NSTemporaryDirectory() + "devhub-gui-\(UUID().uuidString)"
        try! FileManager.default.createDirectory(atPath: home, withIntermediateDirectories: true)
        model = WiringModel([TerminalAgentWorkspace(id: GUI_WORKSPACE, root: "/srv/api", agents: [
            TerminalAgentRecord(
                id: GUI_AGENT, displayName: name,
                profile: TerminalAgentProfile(kind: kind, command: kind.rawValue, args: ["--model", "opus"], env: ["EXAMPLE": "1"]),
                presentation: presentation),
        ])])
        link = FakeLink(host)
        cli = AnsweringCli(host)
        let home = self.home
        let link = self.link
        let reports = self.reports
        wiring = GuiAgentWiring(GuiAgentWiringOptions(
            sessions: sessions, model: model, machineRuntime: { _ in LocalRuntime(home: { home }) },
            report: { reports.add($0) }, clientVersion: "0.0.0-test", profileTag: "0123456789ab",
            resumeAfterLimit: { RESUME_OFF }, limitResumes: records, clock: TurnedClock(0),
            link: { _, _ in link }, log: { _ in }))
    }

    deinit { try? FileManager.default.removeItem(atPath: home) }

    var directory: String { "\(home)/.devhub/agents-0123456789ab/\(GUI_AGENT)" }

    var agent: TerminalAgentRecord { model.workspaces()[0].agents[0] }

    func conversation() async throws -> AgentConversation { try await wiring.of(GUI_AGENT) }

    /// Until the conversation is idle and nothing is under way.
    func idle() async throws -> AgentConversation {
        let conversation = try await conversation()
        for _ in 0..<400 {
            await settle(conversation, host)
            if await conversation.reading().transcript.state == .ready(turn: .none) { return conversation }
        }
        XCTFail("the conversation did not become idle")
        return conversation
    }
}

private func profile(_ kind: AgentProfileKind) throws -> AgentProfile {
    try AgentProfile.create(
        id: kind.rawValue, displayName: kind == .claude ? "Claude" : "Codex", kind: kind, command: kind.rawValue,
        args: ["--model", "opus"], env: [("EXAMPLE", "1")], presentation: .gui)
}

private func thrown(_ body: () async throws -> Void) async -> Error? {
    do {
        try await body()
        return nil
    } catch {
        return error
    }
}

final class GuiAgentLaunchTests: XCTestCase {
    func testRunsClaudeInStructuredModeUnderTheHostInADirectoryMadeForItFirst() async throws {
        let rig = GuiRig()
        let result = await rig.wiring.launch(
            workspaceId: WorkspaceId(unchecked: GUI_WORKSPACE), agentId: AgentId(unchecked: GUI_AGENT), profile: try profile(.claude),
            root: "/srv/api")
        XCTAssertEqual(result, .started)
        var isDirectory: ObjCBool = false
        XCTAssertTrue(FileManager.default.fileExists(atPath: rig.directory, isDirectory: &isDirectory) && isDirectory.boolValue)
        let spec = try XCTUnwrap(rig.sessions.launched.all.first)
        XCTAssertEqual(spec.target, AgentTerminalTarget(machine: .local, agentId: GUI_AGENT, workspaceId: GUI_WORKSPACE, root: "/srv/api"))
        XCTAssertEqual(spec.command, AgentSessionCommand(
            file: "/bin/sh",
            args: ["-c", HOST_SCRIPT, HOST_NAME, rig.directory, "claude", "--model", "opus"] + CLAUDE_STRUCTURED_FLAGS,
            env: ["EXAMPLE": "1"]))
    }

    func testRunsCodexsAppServerUnderTheHostAfterTheProfilesOwnArguments() async throws {
        let rig = GuiRig(kind: .codex, name: "Codex")
        let result = await rig.wiring.launch(
            workspaceId: WorkspaceId(unchecked: GUI_WORKSPACE), agentId: AgentId(unchecked: GUI_AGENT), profile: try profile(.codex),
            root: "/srv/api")
        XCTAssertEqual(result, .started)
        XCTAssertEqual(rig.sessions.launched.all.first?.command, AgentSessionCommand(
            file: "/bin/sh", args: ["-c", HOST_SCRIPT, HOST_NAME, rig.directory, "codex", "--model", "opus", "app-server"],
            env: ["EXAMPLE": "1"]))
    }

    func testGivesClaudeTheDevhubSkillsDirectoryWhereThereIsOne() async throws {
        let rig = GuiRig()
        let skill = DevhubSkill(userDataPath: "/Users/person/Library/Application Support/DevHub")
        let wiring = GuiAgentWiring(GuiAgentWiringOptions(
            sessions: rig.sessions, model: rig.model, machineRuntime: { [home = rig.home] _ in LocalRuntime(home: { home }) },
            report: { _ in }, clientVersion: "0.0.0-test", profileTag: "0123456789ab", resumeAfterLimit: { RESUME_OFF },
            limitResumes: rig.records, devhubSkill: { _ in skill }))
        _ = await wiring.launch(
            workspaceId: WorkspaceId(unchecked: GUI_WORKSPACE), agentId: AgentId(unchecked: GUI_AGENT), profile: try profile(.claude),
            root: "/srv/api")
        let args = try XCTUnwrap(rig.sessions.launched.all.first?.command.args)
        XCTAssertEqual(Array(args[4...7]), ["claude", "--model", "opus", "--add-dir=\(skill.root)"])
    }

    func testALaunchTheSessionsRefuseSaysWhatThePortCalledIt() async throws {
        let rig = GuiRig()
        rig.sessions.failure = portFailure(.timedOut, detail: "tmux did not answer in 5 s")
        let result = await rig.wiring.launch(
            workspaceId: WorkspaceId(unchecked: GUI_WORKSPACE), agentId: AgentId(unchecked: GUI_AGENT), profile: try profile(.claude),
            root: "/srv/api")
        let expected = agentPortRefusal(portFailure(.timedOut, detail: "tmux did not answer in 5 s"))
        XCTAssertEqual(result, .failed(code: expected.code, detail: expected.detail ?? "tmux did not answer in 5 s"))
        XCTAssertNotEqual(expected.code, .agentRuntimeUnavailable)
    }

    func testRefusesALaunchIntoAWorkspaceThatIsNoLongerOpen() async throws {
        let rig = GuiRig()
        let result = await rig.wiring.launch(
            workspaceId: WorkspaceId(unchecked: "00000000-0000-4000-8000-0000000000ff"), agentId: AgentId(unchecked: GUI_AGENT),
            profile: try profile(.claude), root: "/srv/api")
        guard case let .failed(_, detail) = result else { return XCTFail("\(result)") }
        XCTAssertEqual(detail, "the Workspace this Agent belongs to is no longer open")
        XCTAssertTrue(rig.sessions.launched.all.isEmpty)
    }
}

final class GuiAgentConversationTests: XCTestCase {
    func testMakesTheConversationOnFirstAskAndHandsOutTheSameOneAfter() async throws {
        let rig = GuiRig()
        let first = try await rig.conversation()
        let again = try await rig.wiring.of(GUI_AGENT)
        XCTAssertTrue(first === again)
        let registered = await rig.wiring.registry.get(GUI_AGENT)
        XCTAssertTrue(registered === first)
    }

    func testATerminalAgentHasNoConversation() async throws {
        let rig = GuiRig(presentation: .tui)
        let error = await thrown { _ = try await rig.wiring.of(GUI_AGENT) }
        XCTAssertEqual("\(error!)", "Claude is a terminal Agent, so it has no conversation")
        let tell = try await rig.wiring.conversation(AgentId(unchecked: GUI_AGENT))
        XCTAssertNil(tell)
    }

    func testAnAgentTheModelDoesNotHaveHasNoConversation() async throws {
        let rig = GuiRig()
        let error = await thrown { _ = try await rig.wiring.of("00000000-0000-4000-8000-0000000000aa") }
        XCTAssertEqual("\(error!)", "there is no Agent 00000000-0000-4000-8000-0000000000aa")
    }

    func testTheRoundReadsTheConversationAsItWouldAScreen() async throws {
        let rig = GuiRig()
        _ = try await rig.idle()
        let reading = await rig.wiring.reading(machine: .local, agent: rig.agent, root: "/srv/api")
        XCTAssertEqual(reading.status, .idle)
        XCTAssertNil(reading.failure)
    }

    func testSendsAnInjectionAsTheQueuesNotThePersons() async throws {
        let rig = GuiRig()
        let conversation = try await rig.idle()
        try await rig.wiring.send(agentId: GUI_AGENT, text: "Look at issue 7")
        await settle(conversation, rig.host)
        let transcript = await conversation.reading().transcript
        let user = try XCTUnwrap(transcript.entries.compactMap(\.userEntry).first)
        XCTAssertEqual(user.text, "Look at issue 7")
        XCTAssertEqual(user.origin, .injection)
        let session = try await rig.wiring.session(GUI_AGENT)
        XCTAssertEqual(session, "s-1")
    }

    func testARestartTheHostCouldNotDoIsTheConversationStoppingInItsOwnWords() async throws {
        let rig = GuiRig()
        _ = try await rig.idle()
        rig.host.refuseRestart = true
        let error = await thrown { try await rig.wiring.restart(AgentId(unchecked: GUI_AGENT)) }
        let named = try XCTUnwrap(error as? NamedFailure)
        XCTAssertEqual(named.code, .conversationStopped)
        XCTAssertEqual(named.wire.detail, "DevHub could not start the CLI again: the fake host did not start its CLI again")
    }

    func testARestartStartsTheCliAgainOnItsSession() async throws {
        let rig = GuiRig()
        let conversation = try await rig.idle()
        try await conversation.submit("Say one", images: [])
        await settle(conversation, rig.host)
        try await rig.wiring.restart(AgentId(unchecked: GUI_AGENT))
        let cli = try XCTUnwrap(rig.link.clis.last)
        XCTAssertEqual(cli.file, "claude")
        XCTAssertEqual(Array(cli.args.prefix(4)), ["--model", "opus", "--resume", "s-1"])
    }

    func testAnEndingDevHubDidNotCauseIsSaidOnceTheRowIsGoneAndTheFilesGoWithIt() async throws {
        let rig = GuiRig()
        _ = try await rig.idle()
        try FileManager.default.createDirectory(atPath: rig.directory, withIntermediateDirectories: true)
        rig.link.ending = .exited(code: 1, stderrTail: "  Error: not logged in\n")
        await rig.wiring.ended(machine: .local, agent: rig.agent)
        XCTAssertEqual(rig.reports.all, ["The claude of “Claude” exited with code 1: Error: not logged in"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: rig.directory))
        let left = await rig.wiring.registry.get(GUI_AGENT)
        XCTAssertNil(left)
    }

    func testAStopDevHubMadeIsNotNews() async throws {
        let rig = GuiRig()
        _ = try await rig.idle()
        rig.link.ending = .vanished(stderrTail: "")
        rig.wiring.stopping(GUI_AGENT, true)
        await rig.wiring.ended(machine: .local, agent: rig.agent)
        rig.wiring.stopping(GUI_AGENT, false)
        XCTAssertEqual(rig.reports.all, [])
    }

    func testAnEndingThatCannotBeReadIsSaidAsSuch() async throws {
        let rig = GuiRig()
        rig.link.endingFailure = HostLinkFailure(.hostGone, "the files are gone")
        await rig.wiring.ended(machine: .local, agent: rig.agent)
        XCTAssertEqual(rig.reports.all, ["DevHub could not read how “Claude” ended: the files are gone"])
    }

    func testSaysHowACliEndedOnlyWhenItWasNotTheWayAConversationEnds() {
        XCTAssertNil(GuiAgentWiring.endingSentence(name: "A", kind: "claude", ending: .exited(code: 0, stderrTail: "bye")))
        XCTAssertEqual(
            GuiAgentWiring.endingSentence(name: "A", kind: "codex", ending: .exited(code: 137, stderrTail: " ")),
            "The codex of “A” exited with code 137")
        XCTAssertEqual(
            GuiAgentWiring.endingSentence(name: "A", kind: "claude", ending: .hostFailed(stderrTail: "exec: claude: not found")),
            "The claude of “A” could not be started: exec: claude: not found")
        XCTAssertEqual(
            GuiAgentWiring.endingSentence(name: "A", kind: "claude", ending: .vanished(stderrTail: "")),
            "The session of “A” was ended outside DevHub")
    }

    func testRefusesASignInToAServerThePanelDoesNotOffer() async throws {
        let rig = GuiRig()
        _ = try await rig.idle()
        let error = await thrown { try await rig.wiring.signIn(GUI_AGENT, server: "linear") }
        XCTAssertEqual(errorWire(error!).code, .conversationRefused)
        XCTAssertEqual(errorWire(error!).detail, "Claude offers no sign-in to an MCP server named linear now.")
        let input = await thrown { try rig.wiring.signInInput(GUI_AGENT, text: "y") }
        XCTAssertEqual(errorWire(input!).detail, "No MCP sign-in is running.")
        // Nothing to dismiss is nothing done.
        try await rig.wiring.dismissSignIn(GUI_AGENT)
    }

    func testFeedsTheUsageReadoutFromAConversationsRateLimits() async throws {
        let rig = GuiRig()
        let limits = UsageLimits()
        let published = Recorder<UsageLimitsWire>()
        let stop = await rig.wiring.feedUsageLimits(limits, kind: { _ in .claude }, publish: { published.add($0) })
        let conversation = try await rig.idle()
        let line = Fixtures.text("conversation", "claude-session.capture.ndjson")
            .split(separator: "\n").map(String.init).first { $0.contains("rate_limit_event") }!
        rig.host.print(String(line.dropFirst(2)))
        await settle(conversation, rig.host)
        XCTAssertFalse(published.all.isEmpty)
        let claude = limits.wire().clis.first { $0.cli == .claude }
        XCTAssertNotNil(claude?.windows)
        stop()
    }
}

final class ConversationForTellTests: XCTestCase {
    func testReadsTheConversationAsAgentReadReadsIt() async throws {
        let rig = GuiRig()
        let conversation = try await rig.idle()
        let found = try await rig.wiring.conversation(AgentId(unchecked: GUI_AGENT))
        let tell = try XCTUnwrap(found)
        let idleTurn = await tell.turn()
        XCTAssertEqual(idleTurn, "none")
        try await tell.submit("Say one")
        await settle(conversation, rig.host)
        let entries = await tell.entries()
        XCTAssertEqual(entries.map(\.kind), ["user", "assistant", "turn-end"])
        XCTAssertEqual(entries.first, .user(id: entries[0].id, text: "Say one"))
        XCTAssertEqual(entries[1], .assistant(id: entries[1].id, texts: ["answer 1"]))
        let requests = await tell.requests()
        XCTAssertEqual(requests, [])
    }

    func testWordsTheTurnAsTheTsServiceDoes() {
        XCTAssertEqual(ConversationForTell.turn(.connecting), "connecting")
        XCTAssertEqual(ConversationForTell.turn(.ready(turn: .running)), "running")
        XCTAssertEqual(ConversationForTell.turn(.ready(turn: .rewinding)), "rewinding")
        XCTAssertEqual(ConversationForTell.turn(.broken(ConversationFailure(code: .refused, detail: "x"))), "broken")
    }

    func testMapsEveryEntryKindToItsFields() {
        let entries: [TranscriptEntry] = [
            .answer(AnswerEntry(id: "a", answers: [QuestionAnswer(header: "H", question: "Which?", chosen: ["One"], written: "more", notes: nil, secret: false)])),
            .command(CommandEntry(id: "c", line: "/model sonnet", output: "Set", failed: false)),
            .tool(ToolEntry(id: "t", parent: nil, tool: "Bash", title: "Bash: ls", input: .null, status: .succeeded, output: nil,
                spawns: nil, background: nil, outsideSandbox: false, plan: nil, change: nil)),
            .notice(NoticeEntry(id: "n", level: .info, text: "Compacted")),
            .compaction(CompactionEntry(id: "k", trigger: "auto", preTokens: nil, postTokens: nil)),
            .turnEnd(TurnEndEntry(id: "e", outcome: .failed, detail: "boom")),
        ]
        XCTAssertEqual(entries.map(ConversationForTell.entry), [
            .answer(id: "a", answers: [TellQuestionAnswer(question: "Which?", chosen: ["One"], written: "more")]),
            .command(id: "c", line: "/model sonnet", output: "Set"),
            .tool(id: "t", tool: "Bash", title: "Bash: ls", status: "succeeded"),
            .notice(id: "n", text: "Compacted"),
            .compaction(id: "k"),
            .turnEnd(id: "e", outcome: "failed", detail: "boom"),
        ])
    }

    func testMapsEveryRequestSubjectAndAnAnswer() {
        let question = Question(
            id: "q1", header: "Pick", text: "Which one?", options: [QuestionOption(label: "A", description: "first", preview: "x")],
            multiSelect: true, allowsOther: false)
        let requests = [
            PendingRequest(id: "r1", entry: nil, subject: .tool(tool: "Edit", title: "Edit: a.ts", input: .null, reason: nil), choices: []),
            PendingRequest(id: "r2", entry: nil, subject: .command(command: "rm -rf x", cwd: "/", reason: nil), choices: []),
            PendingRequest(id: "r3", entry: nil, subject: .fileChange(files: [FileDiff(path: "/a.ts", unifiedDiff: "")]), choices: []),
            PendingRequest(id: "r4", entry: nil, subject: .question(questions: [question]), choices: []),
            PendingRequest(id: "r5", entry: nil, subject: .elicitation(server: "linear", message: "Sign in?", url: nil, fields: []), choices: []),
        ]
        XCTAssertEqual(requests.map(ConversationForTell.request), [
            TellPendingRequest(id: "r1", subject: .tool(tool: "Edit", title: "Edit: a.ts")),
            TellPendingRequest(id: "r2", subject: .command(command: "rm -rf x")),
            TellPendingRequest(id: "r3", subject: .fileChange(paths: ["/a.ts"])),
            TellPendingRequest(id: "r4", subject: .question([TellQuestion(
                id: "q1", header: "Pick", text: "Which one?", options: [TellQuestionOption(label: "A", description: "first")],
                multiSelect: true, allowsOther: false)])),
            TellPendingRequest(id: "r5", subject: .elicitation(server: "linear", message: "Sign in?")),
        ])
        let answer = ConversationForTell.answer(TellRequestAnswer(
            values: [(id: "q1", value: .many(["A"])), (id: "q2", value: .one("free"))], notes: [(id: "q1", note: "by agent B")]))
        XCTAssertEqual(answer, .answers(values: [("q1", .many(["A"])), ("q2", .one("free"))], notes: ["q1": "by agent B"]))
    }
}

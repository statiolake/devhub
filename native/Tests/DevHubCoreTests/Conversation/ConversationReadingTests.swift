// Ports of apps/desktop/src/main/agent/conversation/{reading,pathLinks}.test.ts
// and apps/desktop/src/model/claudeDefaults.test.ts, with the registry, the
// view's command wire and Claude's settings files on a real disk.

import Foundation
import XCTest
@testable import DevHubCore

// MARK: - reading.test.ts

private let RUNNING: [ConversationEvent] = [
    .state(.ready(turn: .running)),
    .entry(.tool(ToolEntry(id: "tool:1", tool: "Bash", title: "Bash: npm test", input: [:], status: .running))),
]

private struct HomeDidNotAnswer: Error, CustomStringConvertible {
    var description: String { "home() did not answer" }
}

final class ConversationObservationTests: XCTestCase {
    private func reading(_ transcript: Transcript, lost: HostLinkFailure? = nil, crashed: Error? = nil)
        -> ConversationReading
    {
        ConversationReading(transcript: transcript, lost: lost, crashed: crashed, autoCompactAt: nil)
    }

    func testIsItsStatusAndActivityWithNothingWrong() throws {
        XCTAssertEqual(
            observeConversation(reading(try applyEvents(EMPTY_TRANSCRIPT, RUNNING))),
            ConversationObservation(status: .working, activity: "Bash: npm test", failure: nil))
    }

    func testIsUnknownWhileConnectingAsAScreenNobodyHasRead() {
        XCTAssertEqual(
            observeConversation(reading(EMPTY_TRANSCRIPT)),
            ConversationObservation(status: .unknown, activity: nil, failure: nil))
    }

    func testIsUnknownAndSaysTheHostIsLostWhileTheJournalCannotBeFollowed() throws {
        let lost = HostLinkFailure(.streamLost, "the journal stopped", offset: 120)
        XCTAssertEqual(
            observeConversation(reading(try applyEvents(EMPTY_TRANSCRIPT, RUNNING), lost: lost)),
            ConversationObservation(
                status: .unknown, activity: nil,
                failure: AgentRefusal(code: "conversation_host_lost", detail: "the journal stopped")))
    }

    func testIsAnErrorSayingWhatWentWrongWhenDevHubCouldNotFollowItAtAll() throws {
        XCTAssertEqual(
            observeConversation(reading(try applyEvents(EMPTY_TRANSCRIPT, RUNNING), crashed: HomeDidNotAnswer())),
            ConversationObservation(
                status: .error, activity: nil,
                failure: AgentRefusal(code: "conversation_failed", detail: "home() did not answer")))
    }

    func testIsAnErrorWithTheMismatchInDevHubsOwnWordsOnceBroken() throws {
        let transcript = try applyEvents(
            EMPTY_TRANSCRIPT,
            RUNNING + [
                .state(
                    .broken(
                        ConversationFailure(
                            code: .protocolMismatch, detail: "assistant.message.content: expected an array")))
            ])
        XCTAssertEqual(
            observeConversation(reading(transcript)),
            ConversationObservation(
                status: .error, activity: nil,
                failure: AgentRefusal(
                    code: "conversation_protocol_mismatch", detail: "assistant.message.content: expected an array")))
    }

    func testCarriesWhenDevHubWillCompactWithThePromptCache() {
        var transcript = EMPTY_TRANSCRIPT
        transcript.state = .ready(turn: .none)
        transcript.usage = Usage(
            promptCache: PromptCache(
                ttlSeconds: 300, ttlKnown: true, expiresAt: 10, hitRatio: nil, requests: 1, misses: 0,
                recacheTokens: nil))
        let observed = observeConversation(
            ConversationReading(transcript: transcript, lost: nil, crashed: nil, autoCompactAt: 5))
        XCTAssertEqual(observed.promptCache?.autoCompactAt, 5)
        XCTAssertEqual(observed.promptCache?.expiresAt, 10)
    }

    func testNamesEachBrokenCodeAsTheAgentsFailure() {
        XCTAssertEqual(agentFailureCode(.protocolMismatch), "conversation_protocol_mismatch")
        XCTAssertEqual(agentFailureCode(.notSignedIn), "conversation_not_signed_in")
        XCTAssertEqual(agentFailureCode(.refused), "conversation_refused")
    }
}

// MARK: - pathLinks.test.ts

/// A machine whose programs run here, for real, with its home where the test says.
private final class TestPathMachine: PathLinkMachine, @unchecked Sendable {
    let root: String
    let calls = Guarded(0)
    /// The next answer, instead of running the program.
    let canned = Guarded<MachineResult?>(nil)
    private let local = LocalMachine()

    init(_ root: String) { self.root = root }

    var whereSuffix: String { " on test-host" }

    func home() async throws -> String { root }

    func exec(_ argv: [String], stdin: Data?, timeout: Double, limits: MachineLimits) async throws -> MachineResult {
        calls.with { $0 += 1 }
        if let answer = canned.with({ answer -> MachineResult? in
            defer { answer = nil }
            return answer
        }) {
            return answer
        }
        return try await local.exec(argv, stdin: stdin, timeout: timeout, limits: limits)
    }
}

final class PathLinksTests: XCTestCase {
    private var root = ""

    override func setUpWithError() throws {
        root = scratchDirectory("path-links", self)
        let files = FileManager.default
        try files.createDirectory(atPath: "\(root)/src", withIntermediateDirectories: true)
        _ = files.createFile(atPath: "\(root)/src/a.ts", contents: Data())
        _ = files.createFile(atPath: "\(root)/notes with space.md", contents: Data())
        try files.createSymbolicLink(atPath: "\(root)/link.ts", withDestinationPath: "\(root)/src/a.ts")
    }

    func testAnswersEachPathWithItsFileAbsoluteOrNil() async throws {
        let answers = try await resolvePathCandidates(
            TestPathMachine(root), cwd: root,
            [
                "\(root)/src/a.ts", "src/a.ts", "./src/../src/a.ts", "~/src/a.ts", "src/missing.ts", "src",
                "link.ts", "notes with space.md",
            ])
        XCTAssertEqual(
            answers,
            [
                "\(root)/src/a.ts", "\(root)/src/a.ts", "\(root)/src/a.ts", "\(root)/src/a.ts", nil,
                // A folder is not a file to open.
                nil, "\(root)/link.ts", "\(root)/notes with space.md",
            ])
    }

    func testAsksTheMachineOnceForABatchAndInPiecesForALongOne() async throws {
        let host = TestPathMachine(root)
        _ = try await resolvePathCandidates(host, cwd: root, ["src/a.ts", "b.ts"])
        XCTAssertEqual(host.calls.with { $0 }, 1)
        let many = (0..<600).map { "f\($0).ts" }
        let answers = try await resolvePathCandidates(host, cwd: root, many)
        XCTAssertEqual(answers.count, 600)
        XCTAssertTrue(answers.allSatisfy { $0 == nil })
        XCTAssertEqual(host.calls.with { $0 }, 1 + 3)
    }

    func testRefusesARelativePathWhenTheConversationNamedNoDirectory() async {
        do {
            _ = try await resolvePathCandidates(TestPathMachine(root), cwd: nil, ["src/a.ts"])
            XCTFail("it resolved")
        } catch {
            XCTAssertTrue("\(error)".contains("relative"))
        }
    }

    func testSaysInTheMachinesWordsWhenTheMachineCouldNotAnswer() async {
        let host = TestPathMachine(root)
        host.canned.with {
            $0 = MachineResult(code: 127, signal: nil, stdout: Data(), stderr: Data("sh: not found".utf8))
        }
        do {
            _ = try await resolvePathCandidates(host, cwd: root, ["src/a.ts"])
            XCTFail("it resolved")
        } catch {
            XCTAssertTrue("\(error)".contains("on test-host"))
            XCTAssertTrue("\(error)".contains("sh: not found"))
        }
    }

    func testPutsTheCaretAtALineAndColumn() throws {
        XCTAssertEqual(
            try fileSelection(wire: ["kind": "line", "line": 12, "column": 5]), FileSelection(line: 12, column: 5))
    }

    func testSelectsARangeOfLinesWholeTheLastToItsEnd() throws {
        XCTAssertEqual(
            try fileSelection(wire: ["kind": "lines", "from": 12, "to": 20]),
            FileSelection(line: 12, column: 1, end: ControlPosition(line: 20, column: 9_007_199_254_740_991)))
    }

    func testLeavesTheCaretAloneWhenThereIsNoRange() throws {
        XCTAssertNil(try fileSelection(wire: nil))
    }

    func testRefusesAnythingElse() {
        XCTAssertThrowsError(try fileSelection(wire: ["kind": "line", "line": 0, "column": 1]))
        XCTAssertThrowsError(try fileSelection(wire: ["kind": "lines", "from": 5, "to": 2]))
        XCTAssertThrowsError(try fileSelection(wire: "12"))
    }
}

// MARK: - claudeDefaults.test.ts

final class ClaudeDefaultsTests: XCTestCase {
    private let NOTHING = ClaudeDefaultInputs()
    private let OPUS = "claude-opus-5-5"

    func testTheModelIsTheAccountsDefaultWhenNothingSetsOne() {
        XCTAssertEqual(claudeModelDefault(NOTHING), CliDefault(source: .builtIn))
    }

    func testTheModelIsTheUserSettingsModel() {
        XCTAssertEqual(
            claudeModelDefault(ClaudeDefaultInputs(settings: [.user: ["model": "opus"]])),
            CliDefault(value: "opus", source: .layer(.user)))
    }

    func testTakesManagedThenLocalThenProjectSettingsOverTheUsers() {
        var settings: [ClaudeSettingsLayer: JsonValue] = [
            .user: ["model": "haiku"], .project: ["model": "sonnet"], .local: ["model": "opus"],
        ]
        XCTAssertEqual(
            claudeModelDefault(ClaudeDefaultInputs(settings: settings)), CliDefault(value: "opus", source: .layer(.local)))
        settings[.managed] = ["model": "claude-x"]
        XCTAssertEqual(
            claudeModelDefault(ClaudeDefaultInputs(settings: settings)),
            CliDefault(value: "claude-x", source: .layer(.managed)))
    }

    func testTakesAnthropicModelOverTheSettingsAndModelFlagOverBoth() {
        var inputs = ClaudeDefaultInputs(settings: [.managed: ["model": "haiku"]], env: ["ANTHROPIC_MODEL": "sonnet"])
        XCTAssertEqual(claudeModelDefault(inputs), CliDefault(value: "sonnet", source: .environment))
        inputs.args = ["--model=opus"]
        XCTAssertEqual(claudeModelDefault(inputs), CliDefault(value: "opus", source: .argument))
    }

    func testTheEffortIsTheModelsOwnDefaultWhenNothingSetsOne() {
        XCTAssertEqual(claudeEffortDefault(NOTHING, OPUS), CliDefault(value: "medium", source: .builtIn))
        XCTAssertEqual(claudeEffortDefault(NOTHING, "claude-opus-4-7").value, "xhigh")
        XCTAssertEqual(claudeEffortDefault(NOTHING, "claude-sonnet-4-6").value, "high")
        XCTAssertEqual(claudeEffortDefault(NOTHING, nil), CliDefault(source: .builtIn))
    }

    func testIsTheLevelSavedForTheModelBeforeTheTopLevelOne() {
        let settings: [ClaudeSettingsLayer: JsonValue] = [
            .user: ["effortLevel": "low", "modelSettings": [.init(stringLiteral: OPUS): ["effortLevel": "xhigh"]]]
        ]
        let inputs = ClaudeDefaultInputs(settings: settings)
        XCTAssertEqual(claudeEffortDefault(inputs, OPUS), CliDefault(value: "xhigh", source: .layer(.user)))
        // Its 1M context window is the same model.
        XCTAssertEqual(claudeEffortDefault(inputs, "\(OPUS)[1m]").value, "xhigh")
        XCTAssertEqual(claudeEffortDefault(inputs, "claude-haiku-4-5"), CliDefault(value: "low", source: .layer(.user)))
    }

    func testTakesEffortFlagOverTheSettingsAndTheEnvironmentOverBoth() {
        var inputs = ClaudeDefaultInputs(settings: [.user: ["effortLevel": "low"]], args: ["--effort", "high"])
        XCTAssertEqual(claudeEffortDefault(inputs, OPUS), CliDefault(value: "high", source: .argument))
        inputs.env = ["CLAUDE_CODE_EFFORT_LEVEL": "max"]
        XCTAssertEqual(claudeEffortDefault(inputs, OPUS), CliDefault(value: "max", source: .environment))
        inputs.env = ["CLAUDE_CODE_EFFORT_LEVEL": "auto"]
        XCTAssertEqual(claudeEffortDefault(inputs, OPUS), CliDefault(value: "medium", source: .environment))
    }

    func testAFlagsValueIsTheLastOneGivenSpelledEitherWay() {
        XCTAssertEqual(argumentValue(["--model", "a", "--model=b"], "--model"), "b")
        XCTAssertNil(argumentValue(["--model"], "--model"))
        XCTAssertNil(argumentValue(["--models", "x"], "--model"))
    }

    func testSetsTheModelAndKeepsEveryOtherKey() throws {
        let text = json(["theme": "dark", "model": "haiku"])
        XCTAssertEqual(try JsonValue.parse(try withUserDefault(text, .model, "opus")), ["theme": "dark", "model": "opus"])
    }

    func testMakesAFileThatIsNotThere() throws {
        XCTAssertEqual(try withUserDefault(nil, .model, "opus"), "{\n  \"model\": \"opus\"\n}\n")
    }

    func testSavesAnEffortForItsModelKeepingWhatIsSavedForItAndOthers() throws {
        let text = json([
            "modelSettings": [
                "claude-opus-5-5": ["autoCompactWindow": "auto"], "claude-haiku-4-5": ["effortLevel": "low"],
            ]
        ])
        XCTAssertEqual(
            try JsonValue.parse(try withUserDefault(text, .effort, "high", model: "claude-opus-5-5[1m]")),
            [
                "modelSettings": [
                    "claude-opus-5-5": ["autoCompactWindow": "auto", "effortLevel": "high"],
                    "claude-haiku-4-5": ["effortLevel": "low"],
                ]
            ])
    }

    func testSavesAnEffortForNoModelAsTheTopLevelLevel() throws {
        XCTAssertEqual(try JsonValue.parse(try withUserDefault("{}", .effort, "low")), ["effortLevel": "low"])
    }

    func testRefusesMaxWhichIsASessionsOnlyAndAFileItCannotRead() {
        XCTAssertThrowsError(try withUserDefault("{}", .effort, "max")) { XCTAssertTrue("\($0)".contains("max")) }
        XCTAssertThrowsError(try withUserDefault("{ nope", .model, "opus")) {
            XCTAssertTrue("\($0)".contains("not valid JSON"))
        }
        XCTAssertThrowsError(try withUserDefault("[]", .model, "opus")) {
            XCTAssertTrue("\($0)".contains("not a JSON object"))
        }
    }

    func testAModelsBuiltInEffortIsNoneWithoutAModel() {
        XCTAssertNil(builtInEffort(nil))
    }

    func testPrettyJsonIsJavaScriptsWithAnIndentOfTwo() throws {
        let value: JsonValue = ["a": [1, ["b": []], [:]], "c": "d", "e": [:]]
        XCTAssertEqual(
            value.jsonText(indent: 2),
            "{\n  \"a\": [\n    1,\n    {\n      \"b\": []\n    },\n    {}\n  ],\n  \"c\": \"d\",\n  \"e\": {}\n}")
    }
}

// MARK: - claude/defaults.ts, on this machine's disk

final class ClaudeDefaultsFilesTests: XCTestCase {
    func testReadsTheLayersAndWritesTheUserSettingsWhole() async throws {
        let home = scratchDirectory("claude-defaults", self)
        let root = "\(home)/project"
        let config = "\(home)/config"
        try FileManager.default.createDirectory(atPath: "\(root)/.claude", withIntermediateDirectories: true)
        try json(["model": "sonnet"]).write(toFile: "\(root)/.claude/settings.json", atomically: true, encoding: .utf8)
        // A file that does not parse sets nothing.
        try "{ nope".write(toFile: "\(root)/.claude/settings.local.json", atomically: true, encoding: .utf8)
        let runtime = LocalRuntime()
        let profile = ClaudeProfileFacts(env: ["CLAUDE_CONFIG_DIR": config], args: [])

        var defaults = try await readClaudeDefaults(runtime, profile: profile, root: root, model: "claude-opus-5-5")
        XCTAssertEqual(defaults.model, CliDefault(value: "sonnet", source: .layer(.project)))
        XCTAssertEqual(defaults.effort, CliDefault(value: "medium", source: .builtIn))

        try await writeClaudeDefault(runtime, profile: profile, .effort, "high", model: "claude-opus-5-5")
        try await writeClaudeDefault(runtime, profile: profile, .model, "opus", model: nil)
        XCTAssertEqual(
            try JsonValue.parse(try String(contentsOfFile: "\(config)/settings.json", encoding: .utf8)),
            ["modelSettings": ["claude-opus-5-5": ["effortLevel": "high"]], "model": "opus"])
        let left = try FileManager.default.contentsOfDirectory(atPath: config)
        XCTAssertEqual(left, ["settings.json"])

        defaults = try await readClaudeDefaults(runtime, profile: profile, root: root, model: "claude-opus-5-5")
        XCTAssertEqual(defaults.model, CliDefault(value: "sonnet", source: .layer(.project)))
        XCTAssertEqual(defaults.effort, CliDefault(value: "high", source: .layer(.user)))
        XCTAssertFalse(userSettingsDecide(defaults.model.source))
        XCTAssertTrue(userSettingsDecide(defaults.effort.source))
        XCTAssertEqual(sourceWords(defaults.model.source), "this project's .claude/settings.json")
    }
}

// MARK: - registry.ts and the view's command wire

final class ConversationRegistryTests: XCTestCase {
    func testOpensOneConversationPerAgentAndTagsItsEventsWithTheAgent() async throws {
        let registry = ConversationRegistry()
        let heard = Guarded<[String]>([])
        let off = await registry.onEvent { agentId, revision, _ in heard.with { $0.append("\(agentId)#\(revision)") } }
        let host = FakeHost()
        let made = Guarded(0)
        let first = try await registry.open("agent-1") { publish in
            made.with { $0 += 1 }
            return conversationOn(host, publish: publish)
        }
        let again = try await registry.open("agent-1") { publish in
            made.with { $0 += 1 }
            return conversationOn(host, publish: publish)
        }
        XCTAssertTrue(first === again)
        XCTAssertEqual(made.with { $0 }, 1)
        await settle(first, host)
        host.print(json(["type": "hologram"]))
        await settle(first, host)
        let revision = await first.snapshot().revision
        XCTAssertEqual(heard.with { $0 }.last, "agent-1#\(revision)")

        off()
        host.print(json(["type": "hologram"]))
        await settle(first, host)
        XCTAssertEqual(heard.with { $0 }.last, "agent-1#\(revision)")

        await registry.close("agent-1")
        let gone = await registry.get("agent-1")
        XCTAssertNil(gone)
    }

    func testCarriesOutTheViewsCommandsByTheCallTheyName() async throws {
        let (host, conversation, cli) = try await turns(["first"])
        cli.hold = true
        try await conversation.perform(.send(text: "second", images: []))
        await settle(conversation, host)
        try await conversation.perform(.send(text: "third", images: []))
        let held = await conversation.reading().transcript.pending[0]
        try await conversation.perform(.editPending(held.id, text: "third, reworded"))
        let pending = await pendingTexts(conversation)
        XCTAssertEqual(pending, ["third, reworded"])
        try await conversation.perform(.removePending(held.id))
        try await conversation.perform(.interrupt)
        XCTAssertEqual(try JsonValue.parse(host.inLog.last!.line).objectValue?["type"], "control_request")
        let attachment = await conversation.attachment(draft: "typing")
        XCTAssertEqual(attachment.draft, "typing")
        let snapshot = await conversation.snapshot()
        XCTAssertEqual(attachment.revision, snapshot.revision)
        do {
            try await conversation.perform(.mcp(.act(action: .signIn, server: "docs")))
            XCTFail("a sign-in went to the CLI")
        } catch {
            XCTAssertTrue(error is ConversationCommandRefused)
        }
        let image = ImageRef(mediaType: "image/png", source: .file(path: "/tmp/x.png"), label: "x.png")
        do {
            try await conversation.perform(.send(text: "look", images: [image]))
            XCTFail("an image by path was sent")
        } catch {
            XCTAssertTrue(error is AttachedImageRefused, "\(error)")
        }
        await conversation.stop()
    }

    func testNamesEachCommandAsTheWireDoes() {
        XCTAssertEqual(ConversationCommandWire.startEditingPending("p").kind, "start-editing-pending")
        XCTAssertEqual(ConversationCommandWire.cancelLimitResume.kind, "cancel-limit-resume")
        XCTAssertEqual(ConversationCommandWire.setSetting(.model, id: "opus").kind, "set-setting")
    }
}

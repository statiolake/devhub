// Port of the listing, preview and history cases of
// apps/desktop/src/main/agent/conversation/resume.test.ts. (Its argv cases
// and its fold of a session file are SessionArgsToolTitlePromptCacheTests,
// WP5; its terminal-session cases TerminalAgentSessionTests, WP3.)
//
// The listing scripts run for real, under `sh`, against files and a fake
// `codex` made in a temporary directory.

import Foundation
import XCTest
@testable import DevHubCore

private let SESSION_ID = "00000000-0000-4000-8000-00000000000a"
private let CLAUDE = SessionProfile(kind: .claude, command: "claude", args: [], env: [:])
private let CODEX = SessionProfile(kind: .codex, command: "codex", args: [], env: [:])

/// The parts of a machine these read: its home, a realpath that is the path
/// itself, a file read, and `exec` run here for real — each replaceable.
private final class FakeResumeRuntime: MachineRuntime, @unchecked Sendable {
    let local: LocalRuntime
    var readText: ((String, Int) async throws -> String)?
    var execute: ((ExecRequest) async throws -> ExecResult)?

    init(home: String) {
        let path = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin"
        local = LocalRuntime(environment: { ["PATH": path] }, home: { home })
    }

    var id: RuntimeId { local.id }
    var `where`: String { "" }
    func home() async throws -> String { try await local.home() }
    func environment() async throws -> [String: String] { try await local.environment() }
    func exec(_ request: ExecRequest) async throws -> ExecResult {
        if let execute { return try await execute(request) }
        return try await local.exec(request)
    }
    func spawnPty(_ launch: PtyLaunch) throws -> any PseudoTerminal { try local.spawnPty(launch) }
    func spawnStream(_ request: StreamRequest) throws -> any ByteStream { try local.spawnStream(request) }
    func resolveProgram(_ configured: String, searchPath: String) async -> ProgramResolution {
        await local.resolveProgram(configured, searchPath: searchPath)
    }
    func tmuxProgram(_ configured: String, searchPath: String) async -> TmuxProgram {
        await local.tmuxProgram(configured, searchPath: searchPath)
    }
    func userTmuxConfig(_ localPath: String) async -> UserTmuxConfig { await local.userTmuxConfig(localPath) }
    func scratchDirectory() async throws -> String { try await local.scratchDirectory() }
    func stat(_ path: String) async throws -> FileKind { try await local.stat(path) }
    func readTextFile(_ path: String, maxBytes: Int) async throws -> String {
        if let readText { return try await readText(path, maxBytes) }
        return try await local.readTextFile(path, maxBytes: maxBytes)
    }
    func writeTextFile(_ path: String, text: String, mode: Int) async throws {
        try await local.writeTextFile(path, text: text, mode: mode)
    }
    func writeNewTextFile(_ path: String, text: String, mode: Int) async throws -> Bool {
        try await local.writeNewTextFile(path, text: text, mode: mode)
    }
    func readdir(_ path: String) async throws -> [DirEntry] { try await local.readdir(path) }
    func removeTree(_ path: String) async throws { try await local.removeTree(path) }
    func makeDirectory(_ path: String) async throws { try await local.makeDirectory(path) }
    func realpath(_ path: String) async throws -> String { path }
    func commandFromHere(_ command: MachineCommand) async throws -> MachineCommand { command }
    func forwardLoopbackPort(_ port: Int) async throws -> LoopbackForward { try await local.forwardLoopbackPort(port) }
    var cadence: RuntimeCadence { local.cadence }
    func resumed() {}
    func reading() -> RuntimeReading { local.reading() }
}

private func write(_ path: String, _ text: String) throws {
    try FileManager.default.createDirectory(
        atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try Data(text.utf8).write(to: URL(fileURLWithPath: path))
}

private func touch(_ path: String, _ seconds: Double) throws {
    try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: seconds)], ofItemAtPath: path)
}

private func lines(_ records: [String]) -> String { records.joined(separator: "\n") }

private let FIXTURE = Fixtures.text("conversation", "claude-session-file.handwritten.jsonl")

final class ResumeScriptsTests: XCTestCase {
    func testIsByteIdenticalToTheTSApps() throws {
        // What Node evaluates resume.ts's script templates to.
        guard case .object(let scripts) = try JsonValue.parse(Fixtures.text("conversation", "resume-scripts.json")) else {
            return XCTFail("no scripts")
        }
        XCTAssertEqual(ResumeScripts.tail, scripts["TAIL_SCRIPT"]?.stringValue)
        XCTAssertEqual(ResumeScripts.codexRolloutTail, scripts["CODEX_ROLLOUT_TAIL_SCRIPT"]?.stringValue)
        XCTAssertEqual(ResumeScripts.claudeListing, scripts["CLAUDE_LISTING_SCRIPT"]?.stringValue)
        XCTAssertEqual(ResumeScripts.codexListing, scripts["CODEX_LISTING_SCRIPT"]?.stringValue)
    }

    func testAScopeIsCheckedAsAPageSaidIt() throws {
        XCTAssertEqual(try SessionScope(checking: "here"), .here)
        XCTAssertEqual(try SessionScope(checking: "everywhere"), .everywhere)
        assertThrowsMatching("is not a scope of sessions") { _ = try SessionScope(checking: "elsewhere") }
    }
}

final class ClaudeHistoryOnAMachineTests: XCTestCase {
    let scratch = ScratchDirectories()
    override func tearDown() { scratch.removeAll() }

    func testResumesASessionTooLargeToReadBackSayingItsHistoryIsNotDrawn() async throws {
        let runtime = FakeResumeRuntime(home: "/home/testuser")
        runtime.readText = { _, _ in String(repeating: "x", count: 33 * 1024 * 1024) }
        let history = try await claudeHistory(runtime, CLAUDE, root: "/work/project", session: "big")
        XCTAssertEqual(
            history.map { try? JsonValue.parse($0) },
            [
                j(
                    #"{"type":"devhub_history","record":{"type":"system","subtype":"informational","level":"warning","content":"This session's file is larger than DevHub reads back (32 MiB), so its earlier conversation is not drawn here. The CLI has all of it."}}"#
                )
            ])
    }

    func testIsRefusedWithThePathWhenTheSessionIsNotThere() async throws {
        let home = scratch.make("history")
        let runtime = FakeResumeRuntime(home: home)
        let failure = await drawnAs { _ = try await claudeHistory(runtime, CLAUDE, root: "/work/project", session: "missing-session") }
        XCTAssertEqual(failure?.code, "conversation_not_resumable")
        XCTAssertTrue(
            failure?.reason.contains("\(home)/.claude/projects/-work-project/missing-session.jsonl") ?? false,
            failure?.reason ?? "")
    }

    func testReadsTheSessionFileBackAsItsHistory() async throws {
        let home = scratch.make("history")
        try write("\(home)/.claude/projects/-work-project/\(SESSION_ID).jsonl", FIXTURE)
        let history = try await claudeHistory(
            FakeResumeRuntime(home: home), CLAUDE, root: "/work/project", session: SESSION_ID)
        XCTAssertEqual(history, try claudeHistoryLines(session: SESSION_ID, text: FIXTURE))
        XCTAssertFalse(history.isEmpty)
    }
}

final class SessionListingTests: XCTestCase {
    let scratch = ScratchDirectories()
    var dir = ""
    override func setUp() { dir = scratch.make("resume") }
    override func tearDown() { scratch.removeAll() }

    func testReadsClaudesSessionsOfThatDirectoryNewestFirstTitled() async throws {
        let project = "\(dir)/.claude/projects/-work-my-project"
        try write("\(project)/\(SESSION_ID).jsonl", FIXTURE)
        try write(
            "\(project)/second.jsonl",
            lines([
                #"{"type":"user","uuid":"x1","isMeta":true,"message":{"content":"meta"}}"#,
                #"{"type":"user","uuid":"x2","timestamp":"2026-09-21T08:00:00.000Z","message":{"content":[{"type":"text","text":"Second\n  session"}]}}"#,
            ]))
        // A session nobody wrote in is not offered, as Claude's own /resume does.
        try write("\(project)/empty.jsonl", "")
        try touch("\(project)/\(SESSION_ID).jsonl", 1_000)
        try touch("\(project)/second.jsonl", 2_000)
        try touch("\(project)/empty.jsonl", 3_000)

        let sessions = try await listPastSessions(FakeResumeRuntime(home: dir), CLAUDE, root: "/work/my.project")
        XCTAssertEqual(
            sessions,
            [
                PastSession(
                    id: "second", title: "Second session", updatedAt: parseISOTime("2026-09-21T08:00:00.000Z"),
                    cwd: "/work/my.project", resumableHere: true),
                PastSession(
                    id: SESSION_ID, title: "List and read the source files",
                    updatedAt: parseISOTime("2026-09-20T10:03:01.000Z"), cwd: "/home/testuser/project",
                    // The branch its last line was on.
                    branch: "main", resumableHere: true),
            ])
    }

    func testReadsEveryProjectsSessionsWhenAskedForAllOfThemAndSaysWhichCanGoOnHere() async throws {
        let projects = "\(dir)/.claude/projects"
        func session(_ cwd: String, _ text: String, _ stamp: String) -> String {
            #"{"type":"user","uuid":"x","cwd":"\#(cwd)","timestamp":"\#(stamp)","message":{"content":"\#(text)"}}"#
        }
        try write("\(projects)/-work-mine/m1.jsonl", session("/work/mine", "Mine", "2026-09-20T00:00:00.000Z"))
        try write("\(projects)/-work-other/o1.jsonl", session("/work/other", "Other's", "2026-09-22T00:00:00.000Z"))
        try touch("\(projects)/-work-mine/m1.jsonl", 1_000)
        try touch("\(projects)/-work-other/o1.jsonl", 2_000)

        let everywhere = try await listPastSessions(
            FakeResumeRuntime(home: dir), CLAUDE, root: "/work/mine", scope: .everywhere)
        XCTAssertEqual(
            everywhere,
            [
                PastSession(
                    id: "o1", title: "Other's", updatedAt: parseISOTime("2026-09-22T00:00:00.000Z"), cwd: "/work/other",
                    resumableHere: false),
                PastSession(
                    id: "m1", title: "Mine", updatedAt: parseISOTime("2026-09-20T00:00:00.000Z"), cwd: "/work/mine",
                    resumableHere: true),
            ])
        let here = try await listPastSessions(FakeResumeRuntime(home: dir), CLAUDE, root: "/work/mine")
        XCTAssertEqual(here.map(\.id), ["m1"])
    }

    func testTitlesAClaudeSessionByTheNameAPersonGaveItElseByClaudesTitleElseByItsFirstPrompt() async throws {
        let project = "\(dir)/.claude/projects/-work-titles"
        let prompt = #"{"type":"user","uuid":"u1","timestamp":"2026-09-20T00:00:00.000Z","message":{"content":"The first prompt"}}"#
        func aiTitle(_ text: String) -> String { #"{"type":"ai-title","aiTitle":"\#(text)","sessionId":"s"}"# }
        func customTitle(_ text: String) -> String { #"{"type":"custom-title","customTitle":"\#(text)","sessionId":"s"}"# }
        let files: [(String, [String])] = [
            // Renamed twice, and Claude titled it again after: the latest name.
            (
                "named",
                [
                    prompt, aiTitle("Generated one"), customTitle("Given name"), customTitle("Given name, renamed"),
                    aiTitle("Generated two"),
                ]
            ),
            // Never renamed: Claude's latest title.
            ("generated", [prompt, aiTitle("Generated one"), aiTitle("Generated two")]),
            // Neither: the first prompt.
            ("bare", [prompt]),
        ]
        var age = 0.0
        for (id, records) in files {
            try write("\(project)/\(id).jsonl", lines(records))
            age += 1_000
            try touch("\(project)/\(id).jsonl", age)
        }
        let titles = try await listPastSessions(FakeResumeRuntime(home: dir), CLAUDE, root: "/work/titles").map {
            [$0.id, $0.title]
        }
        XCTAssertEqual(
            titles,
            [["bare", "The first prompt"], ["generated", "Generated two"], ["named", "Given name, renamed"]])
    }

    func testHasNoneForADirectoryClaudeNeverRanIn() async throws {
        let none = try await listPastSessions(FakeResumeRuntime(home: dir), CLAUDE, root: "/work/elsewhere")
        XCTAssertEqual(none, [])
    }

    func testAsksCodexsAppServerHoldingItsInputOpenUntilItHasAnswered() async throws {
        let codex = "\(dir)/codex"
        let requests = "\(dir)/requests"
        // A fake that answers the list a moment later — in JSON spaced the way
        // another serializer spaces it — and at end of input quits without
        // answering what is still in flight — which is what app-server does,
        // and why the input has to stay open.
        try write(
            codex,
            #"""
            #!/bin/sh
            [ "$*" = "-c a=b app-server" ] || { echo "argv: $*" >&2; exit 2; }
            while IFS= read -r line; do
            	printf '%s\n' "$line" >>"\#(requests)"
            	case $line in
            	*'"initialize"'*) printf '%s\n' '{"id":1,"result":{"userAgent":"fake"}}' ;;
            	*'"thread/list"'*) { sleep 0.3; printf '%s\n' '{"method":"note","params":{}}' '{"id": 2, "result": {"data":[{"id":"t-new","preview":"Fix it","name":"Named","updatedAt":20,"cwd":"/work/project","gitInfo":{"sha":null,"branch":"feature/128-wip","originUrl":null}},{"id":"t-old","preview":"First\nmessage","name":null,"updatedAt":10,"cwd":"/work/elsewhere"}],"nextCursor":null,"backwardsCursor":null}}'; } & pending=$! ;;
            	esac
            done
            [ -z "$pending" ] || kill "$pending" 2>/dev/null

            """#)
        chmod(codex, 0o755)
        let sessions = try await listPastSessions(
            FakeResumeRuntime(home: dir), SessionProfile(kind: .codex, command: codex, args: ["-c", "a=b"], env: [:]),
            root: "/work/project")
        XCTAssertEqual(
            sessions,
            [
                PastSession(
                    id: "t-new", title: "Named", updatedAt: 20_000, cwd: "/work/project", branch: "feature/128-wip",
                    resumableHere: true),
                PastSession(id: "t-old", title: "First message", updatedAt: 10_000, cwd: "/work/elsewhere", resumableHere: true),
            ])
        let asked = try String(contentsOfFile: requests, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n").map { try JsonValue.parse($0) }
        XCTAssertEqual(asked.map { $0["method"]?.stringValue }, ["initialize", "initialized", "thread/list"])
        XCTAssertEqual(asked[2]["params"], j(#"{"cwd":"/work/project","limit":50,"sortKey":"updated_at"}"#))
        // Spelled as the TS app spells them.
        XCTAssertEqual(
            try String(contentsOfFile: requests, encoding: .utf8).components(separatedBy: "\n")[2],
            #"{"id":2,"method":"thread/list","params":{"cwd":"/work/project","limit":50,"sortKey":"updated_at"}}"#)
    }

    func testSaysWhatWasBeingAskedWhenTheMachineGivesNoAnswerAtAll() async throws {
        let runtime = FakeResumeRuntime(home: dir)
        runtime.execute = { _ in throw Said("terminal runtime timed out") }
        let failure = await drawnAs { _ = try await listPastSessions(runtime, CODEX, root: "/work/project") }
        XCTAssertEqual(failure?.code, "sessions_unreadable")
        XCTAssertEqual(failure?.reason, "codex app-server did not list its threads: terminal runtime timed out")
    }

    func testSaysTheMachinesWordsWhenItAnswersClaudesListingWithAFailure() async throws {
        let runtime = FakeResumeRuntime(home: dir)
        runtime.execute = { _ in ExecResult(code: 71, signal: nil, stdout: Data(), stderr: Data("cd: permission denied".utf8)) }
        let failure = await drawnAs { _ = try await listPastSessions(runtime, CLAUDE, root: "/work/project") }
        XCTAssertEqual(failure?.code, "sessions_unreadable")
        XCTAssertTrue(failure?.reason.contains("DevHub could not list Claude's sessions in") ?? false)
        XCTAssertTrue(failure?.reason.hasSuffix(": cd: permission denied") ?? false)
    }

    func testSaysWhatCodexSaidWhenItRefusesOrThatItEndedWithoutAnswering() throws {
        func refusal(_ work: () throws -> Void) -> ConversationError? {
            do {
                try work()
            } catch let failure as ConversationError {
                return failure
            } catch {
                XCTFail("\(error)")
            }
            return nil
        }
        let refused = refusal {
            _ = try parseCodexListing(
                "{\"id\":1,\"result\":{}}\n{\"id\":2,\"error\":{\"code\":-32600,\"message\":\"no such cwd\"}}\n", stderr: "")
        }
        XCTAssertEqual(refused?.code, "sessions_unreadable")
        XCTAssertEqual(refused?.reason, "codex did not list its threads: no such cwd (-32600)")
        let ended = refusal { _ = try parseCodexListing("", stderr: "error: not logged in\n") }
        XCTAssertEqual(ended?.code, "sessions_unreadable")
        XCTAssertEqual(ended?.reason, "codex app-server ended without listing its threads: error: not logged in")
        XCTAssertEqual(
            refusal { _ = try parseCodexListing("", stderr: "") }?.reason, "codex app-server ended without listing its threads.")
    }
}

final class SessionPreviewTests: XCTestCase {
    let scratch = ScratchDirectories()
    var dir = ""
    override func setUp() { dir = scratch.make("preview") }
    override func tearDown() { scratch.removeAll() }

    func testIsTheLastMessagesOfAClaudeSessionReadFromTheEndOfItsFile() async throws {
        let filler = #"{"type":"progress","data":"\#(String(repeating: "x", count: 300_000))"}"#
        try write("\(dir)/.claude/projects/-work-project/\(SESSION_ID).jsonl", "\(filler)\n\(FIXTURE)")
        let preview = try await previewPastSession(FakeResumeRuntime(home: dir), CLAUDE, id: SESSION_ID, cwd: "/work/project")
        XCTAssertEqual(preview.last, PreviewLine(role: .agent, text: "It is empty."))
        XCTAssertTrue(preview.contains { $0.role == .person })
        XCTAssertLessThanOrEqual(preview.count, 6)
    }

    func testIsTheLastMessagesOfACodexRolloutFoundByItsThreadId() async throws {
        func line(_ type: String, _ message: String) -> String {
            #"{"type":"event_msg","payload":{"type":"\#(type)","message":"\#(message)"}}"#
        }
        try write(
            "\(dir)/.codex/sessions/2026/09/20/rollout-2026-09-20T10-00-00-t-1.jsonl",
            lines([
                #"{"type":"session_meta","payload":{"id":"t-1"}}"#, line("user_message", "Fix the title"),
                #"{"type":"response_item","payload":{"type":"reasoning"}}"#, line("agent_message", "Fixed."),
            ]))
        let preview = try await previewPastSession(FakeResumeRuntime(home: dir), CODEX, id: "t-1", cwd: "/work/project")
        XCTAssertEqual(
            preview,
            [PreviewLine(role: .person, text: "Fix the title"), PreviewLine(role: .agent, text: "Fixed.")])
    }

    func testSaysItCouldNotReadTheSessionsEndAsItsOwnFailureWhenTheFileIsNotThere() async throws {
        let failure = await drawnAs {
            _ = try await previewPastSession(FakeResumeRuntime(home: self.dir), CLAUDE, id: SESSION_ID, cwd: "/work/project")
        }
        XCTAssertEqual(failure?.code, "sessions_unreadable")
        XCTAssertTrue(failure?.reason.contains("DevHub could not read the end of session \(SESSION_ID)") ?? false)
    }

    func testRefusesAnIdThatIsNotOneBeforeAskingTheMachine() async throws {
        let runtime = FakeResumeRuntime(home: dir)
        runtime.execute = { _ in
            XCTFail("the machine was asked")
            throw Said("asked")
        }
        do {
            _ = try await previewPastSession(runtime, CLAUDE, id: "../x", cwd: "/work/project")
            XCTFail("it did not refuse")
        } catch {
            XCTAssertTrue("\(error)".contains("not a session id"))
        }
    }

    func testPreviewsLeaveOutWhatNobodyWroteAndShortenLongMessages() {
        let long = String(repeating: "a", count: 700)
        let text = lines([
            "cut off line",
            #"{"type":"user","isMeta":true,"message":{"content":"meta"}}"#,
            #"{"type":"user","isSidechain":true,"message":{"content":"side"}}"#,
            #"{"type":"user","isCompactSummary":true,"message":{"content":"summary"}}"#,
            #"{"type":"user","message":{"content":"  "}}"#,
            #"{"type":"assistant","message":{"content":[{"type":"text","text":"\#(long)"},{"type":"tool_use"}]}}"#,
        ])
        let preview = claudePreview(text)
        XCTAssertEqual(preview.count, 1)
        XCTAssertEqual(preview[0].role, .agent)
        XCTAssertEqual(preview[0].text, String(repeating: "a", count: 599) + "…")
        XCTAssertEqual(codexPreview("{}\n{\"type\":\"event_msg\",\"payload\":{\"type\":\"other\",\"message\":\"x\"}}"), [])
    }
}

// Port of the terminal-session half of
// apps/desktop/src/main/agent/conversation/resume.test.ts: the one spelling of
// a resume, the CLI's argv for a session, the session of a terminal Agent
// (Claude's record of its process, the Codex rollout its process holds open,
// through /proc and through lsof), and the thread a pane's Codex holds open.

import Foundation
import XCTest
@testable import DevHubCore

final class ResumeSpellingTests: XCTestCase {
    func testIsTheTerminalModesArgumentsAndReadsBackFromTheEndOfAnArgv() throws {
        XCTAssertEqual(try TerminalAgentCommand.resumeArgs(.claude, session: "s1"), ["--resume", "s1"])
        XCTAssertEqual(try TerminalAgentCommand.resumeArgs(.codex, session: "t1"), ["resume", "t1"])
        XCTAssertEqual(TerminalAgentCommand.resumedSession(.claude, args: ["--model", "x", "--resume", "s1"]), "s1")
        XCTAssertEqual(TerminalAgentCommand.resumedSession(.codex, args: ["-c", "a=b", "resume", "t1"]), "t1")
        XCTAssertNil(TerminalAgentCommand.resumedSession(.claude, args: ["--model", "x"]))
        XCTAssertNil(TerminalAgentCommand.resumedSession(.codex, args: ["--resume", "t1"]))
        XCTAssertNil(TerminalAgentCommand.resumedSession(.cursor, args: ["--resume", "s1"]))
        XCTAssertThrowsError(try TerminalAgentCommand.resumeArgs(.cursor, session: "s"))
    }

    func testReplacesEveryArgumentThatPicksASessionRatherThanAddingToThem() throws {
        XCTAssertEqual(
            try TerminalAgentCommand.withSession(.claude, args: ["--model", "x", "--resume", "old", "--verbose"], session: ["--resume", "new"]),
            ["--model", "x", "--verbose", "--resume", "new"]
        )
        XCTAssertEqual(
            try TerminalAgentCommand.withSession(
                .claude,
                args: ["--continue", "-r", "a", "--resume=b", "--resume-session-at", "m1", "--resume-session-at=m2", "--resume-drops-turn", "-c", "--model", "x"],
                session: ["--resume", "s", "--resume-session-at", "m3"]
            ),
            ["--model", "x", "--resume", "s", "--resume-session-at", "m3"]
        )
        XCTAssertEqual(try TerminalAgentCommand.withSession(.codex, args: ["-c", "a=b", "resume", "old"], session: ["resume", "new"]), ["-c", "a=b", "resume", "new"])
        XCTAssertEqual(try TerminalAgentCommand.withSession(.codex, args: ["resume", "--last", "-m", "x"], session: ["resume", "t"]), ["-m", "x", "resume", "t"])
    }

    func testStartsANewSessionWhenNothingPicksOne() throws {
        XCTAssertEqual(try TerminalAgentCommand.withSession(.claude, args: ["--resume", "old", "--model", "x"], session: []), ["--model", "x"])
    }

    func testIsWhatALaunchResumingASessionRunsWhichReadsItsSessionBack() throws {
        let args = try TerminalAgentCommand.withSession(.claude, args: ["--resume", "old"], session: try TerminalAgentCommand.resumeArgs(.claude, session: "new"))
        XCTAssertEqual(args, ["--resume", "new"])
        XCTAssertEqual(TerminalAgentCommand.resumedSession(.claude, args: args), "new")
    }

    func testAKindWithNoSessionsPicksNone() {
        XCTAssertThrowsError(try TerminalAgentCommand.withSession(.custom, args: ["--resume", "x"], session: []))
    }
}

final class PaneProcessesScriptTests: XCTestCase {
    /// The script is the TS app's, byte for byte (extracted from the
    /// template literal in `resume.ts` once, by evaluating it).
    func testIsByteIdenticalToTheTSApps() throws {
        let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Fixtures/Tmux/pane-processes-script.sh")
        XCTAssertEqual(TerminalAgentSessionLookup.paneProcessesScript, try String(contentsOf: fixture, encoding: .utf8))
    }
}

/// A process the test started, to stand for an Agent's pane.
private final class Panes: @unchecked Sendable {
    private var processes: [Process] = []

    /// A pane running `command` under a shell that does not exec it, as a
    /// profile's wrapper would. Ready once the command has touched `ready`.
    func start(_ command: String, in dir: String) throws -> Int {
        let ready = Path.join(dir, "ready-\(processes.count)")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", "\(command); :"]
        var env = ProcessInfo.processInfo.environment
        env["READY"] = ready
        process.environment = env
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        processes.append(process)
        for _ in 0..<400 {
            if FileManager.default.fileExists(atPath: ready) { return Int(process.processIdentifier) }
            usleep(25_000)
        }
        throw Said("the pane never became ready")
    }

    func killAll() {
        for process in processes where process.isRunning {
            // Everything under the pane goes too: its group is the test's, so
            // it is reached through `pkill -P`.
            _ = runSync("/usr/bin/pkill", ["-KILL", "-P", String(process.processIdentifier)])
            kill(process.processIdentifier, SIGKILL)
        }
        processes = []
    }
}

final class TerminalAgentSessionLookupTests: XCTestCase {
    let scratch = ScratchDirectories()
    private let panes = Panes()
    var dir = ""

    override func setUp() { dir = scratch.make("terminal-session") }
    override func tearDown() {
        panes.killAll()
        scratch.removeAll()
    }

    func runtime() -> LocalRuntime {
        let home = dir
        return LocalRuntime(environment: { ["PATH": ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin"] }, home: { home })
    }

    func session(_ kind: AgentProfileKind, _ pid: Int, files: TerminalAgentSessionLookup.FilesWay = .auto) async throws -> String {
        try await TerminalAgentSessionLookup.terminalSession(runtime(), kind: kind, profileEnv: [:], panePid: pid, files: files)
    }

    func refusal(_ kind: AgentProfileKind, _ pid: Int, runtime: (any MachineRuntime)? = nil) async -> TerminalAgentSessionLookupError? {
        do {
            _ = try await TerminalAgentSessionLookup.terminalSession(runtime ?? self.runtime(), kind: kind, profileEnv: [:], panePid: pid)
            XCTFail("it did not fail")
        } catch let failure as TerminalAgentSessionLookupError {
            return failure
        } catch {
            XCTFail("\(error)")
        }
        return nil
    }

    /// A fake `claude` that keeps Claude's record of its process the way
    /// 2.1.282 does: `<config>/sessions/<its pid>.json`, naming its session.
    func fakeClaude(_ session: String) throws -> String {
        let script = Path.join(dir, "claude-\(session)")
        try Data("""
        #!/bin/sh
        mkdir -p "$CLAUDE_CONFIG_DIR/sessions"
        printf '{"pid":%s,"sessionId":"%s","cwd":"/w","kind":"interactive"}' $$ "\(session)" >"$CLAUDE_CONFIG_DIR/sessions/$$.json"
        : >"$READY"
        exec sleep 30

        """.utf8).write(to: URL(fileURLWithPath: script))
        chmod(script, 0o755)
        return "CLAUDE_CONFIG_DIR='\(Path.join(dir, ".claude"))' '\(script)'"
    }

    /// A fake `codex` that holds its rollouts open as the TUI does while it
    /// writes a thread.
    func fakeCodex(_ thread: String, subagent: String? = nil, source: Any = "cli", firstLine: String? = nil, zombie: Bool = false) throws -> String {
        let day = Path.join(dir, ".codex", "sessions", "2026", "09", "26")
        try FileManager.default.createDirectory(atPath: day, withIntermediateDirectories: true)
        func rollout(_ id: String, _ source: Any, _ line: String? = nil) throws -> String {
            let path = Path.join(day, "rollout-2026-09-26T10-00-00-\(id).jsonl")
            let text: String
            if let line {
                text = line
            } else {
                let json = try JSONSerialization.data(withJSONObject: ["type": "session_meta", "payload": ["id": id, "source": source, "cwd": "/w"]], options: [.sortedKeys])
                text = String(decoding: json, as: UTF8.self) + "\n"
            }
            try Data(text.utf8).write(to: URL(fileURLWithPath: path))
            return path
        }
        let main = try rollout(thread, source, firstLine)
        let side = try subagent.map { try rollout($0, ["subagent": ["thread_spawn": [String: String]()]]) }
        let script = Path.join(dir, "codex-\(thread)")
        try Data("""
        #!/bin/sh
        exec 3<'\(main)'
        \(side.map { "exec 4<'\($0)'" } ?? "")
        : >"$READY"
        \(zombie ? "exec perl -e 'fork or exit 0; sleep 30'" : "exec sleep 30")

        """.utf8).write(to: URL(fileURLWithPath: script))
        chmod(script, 0o755)
        return "'\(script)'"
    }

    var hasLsof: Bool { ["/usr/bin/lsof", "/usr/sbin/lsof"].contains { FileManager.default.fileExists(atPath: $0) } }

    func testIsClaudesRecordOfTheProcessUnderTheAgentsPaneEachPaneItsOwn() async throws {
        let first = try panes.start(try fakeClaude("s-first"), in: dir)
        let second = try panes.start(try fakeClaude("s-second"), in: dir)
        let one = try await session(.claude, first)
        let two = try await session(.claude, second)
        XCTAssertEqual(one, "s-first")
        XCTAssertEqual(two, "s-second")
    }

    func testFollowsClaudesRecordWhenTheSessionChangesUnderARunningClaude() async throws {
        let running = try panes.start(try fakeClaude("s-before"), in: dir)
        let agent = Path.join(dir, "agent")
        try FileManager.default.createDirectory(atPath: agent, withIntermediateDirectories: true)
        try Data("{\"session_id\":\"s-before\",\"source\":\"startup\"}".utf8).write(to: URL(fileURLWithPath: Path.join(agent, "claude-session")))
        let sessions = Path.join(dir, ".claude", "sessions")
        let record = try FileManager.default.contentsOfDirectory(atPath: sessions)[0]
        var kept = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: Path.join(sessions, record)))) as! [String: Any]
        kept["sessionId"] = "s-continued"
        try JSONSerialization.data(withJSONObject: kept).write(to: URL(fileURLWithPath: Path.join(sessions, record)))
        let found = try await session(.claude, running)
        XCTAssertEqual(found, "s-continued")
    }

    func testIsRefusedSayingWhereDevHubLookedWhenNoProcessOfThePaneHasClaudesRecord() async throws {
        let quiet = try panes.start(": >\"$READY\"; exec sleep 30", in: dir)
        guard case .notResumable(let detail)? = await refusal(.claude, quiet) else { return XCTFail("not refused as not resumable") }
        XCTAssertNotNil(detail.range(of: #"no process of its pane \(pid [0-9]+\) has Claude's record of it in .*sessions\. .*no longer running in the pane, or when it is a version too old to keep one"#, options: .regularExpression), detail)
    }

    func testSaysItCouldNotReadThePanesProcessesAsItsOwnFailureWhenTheMachineDoesNotAnswer() async {
        let silent = SilentRuntime(home: dir)
        let failure = await refusal(.claude, 1, runtime: silent)
        XCTAssertEqual(failure?.code, "sessions_unreadable")
        XCTAssertTrue(failure?.description.contains("DevHub could not read the processes of the terminal Agent's pane (pid 1): ") ?? false, "\(String(describing: failure))")
        XCTAssertTrue(failure?.description.contains("terminal runtime timed out") ?? false)
    }

    func testSaysClaudesRecordIsNotWhatDevHubReadsWhenItNamesNoSession() async throws {
        let sessions = Path.join(dir, ".claude", "sessions")
        let running = try panes.start("mkdir -p '\(sessions)'; printf '{\"pid\":%s}' $$ >'\(sessions)'/$$.json; : >\"$READY\"; exec sleep 30", in: dir)
        let failure = await refusal(.claude, running)
        XCTAssertEqual(failure?.code, "sessions_unreadable")
        XCTAssertTrue(failure?.description.hasSuffix("names no sessionId") ?? false, "\(String(describing: failure))")
    }

    func testIsTheCodexThreadTheAgentsProcessHoldsOpenEachPaneItsOwnNeverASubagents() async throws {
        let first = try panes.start(try fakeCodex("t-first", subagent: "t-helper"), in: dir)
        let second = try panes.start(try fakeCodex("t-second"), in: dir)
        let one = try await session(.codex, first)
        let two = try await session(.codex, second)
        XCTAssertEqual(one, "t-first")
        XCTAssertEqual(two, "t-second")
    }

    func testIsRefusedWhenTheAgentsCodexHoldsNoThreadOpenYet() async throws {
        let quiet = try panes.start(": >\"$READY\"; exec sleep 30", in: dir)
        let failure = await refusal(.codex, quiet)
        XCTAssertTrue(failure?.description.contains("has no thread open yet") ?? false)
    }

    func testIsTheThreadTheAgentsCodexHoldsOpenAsLsofListsItAsOnMacOS() async throws {
        try XCTSkipUnless(hasLsof, "no lsof on this machine")
        let first = try panes.start(try fakeCodex("t-first", subagent: "t-helper"), in: dir)
        let second = try panes.start(try fakeCodex("t-second"), in: dir)
        let one = try await session(.codex, first, files: .lsof)
        let two = try await session(.codex, second, files: .lsof)
        XCTAssertEqual(one, "t-first")
        XCTAssertEqual(two, "t-second")
    }

    func testIsFoundPastAProcessUnderThePaneThatHasExitedAndIsNotReaped() async throws {
        try XCTSkipUnless(hasLsof, "no lsof on this machine")
        try XCTSkipUnless(FileManager.default.fileExists(atPath: "/usr/bin/perl"), "no perl on this machine")
        let running = try panes.start(try fakeCodex("t-past-zombie", zombie: true), in: dir)
        try await zombieUnder(running)
        let viaLsof = try await session(.codex, running, files: .lsof)
        let viaProc = try await session(.codex, running)
        XCTAssertEqual(viaLsof, "t-past-zombie")
        XCTAssertEqual(viaProc, "t-past-zombie")
    }

    func testIsAThreadBegunElsewhereAndResumedInTheTUI() async throws {
        let resumed = try panes.start(try fakeCodex("t-from-gui", source: "vscode"), in: dir)
        let found = try await session(.codex, resumed)
        XCTAssertEqual(found, "t-from-gui")
    }

    func testIsTheThreadARolloutsNameSaysWhileCodexIsStillWritingItsFirstLine() async throws {
        let writing = try panes.start(try fakeCodex("t-writing", firstLine: "{\"type\":\"session_meta\",\"payload\":{\"id\":\"t-wr"), in: dir)
        let found = try await session(.codex, writing)
        XCTAssertEqual(found, "t-writing")
    }

    func testSaysWhatWasInThePaneWhenItHasNoThread() async throws {
        let quiet = try panes.start(": >\"$READY\"; exec sleep 30", in: dir)
        let failure = await refusal(.codex, quiet)
        XCTAssertEqual(failure?.code, "conversation_not_resumable")
        XCTAssertNotNil(failure?.description.range(of: #"No process in the pane is Codex.*Processes looked at: .*sleep \([0-9]+\)"#, options: .regularExpression), "\(String(describing: failure))")
    }

    /// Until a process under `pid` has exited and is not reaped.
    func zombieUnder(_ pid: Int) async throws {
        for _ in 0..<200 {
            let table = runSync("/bin/ps", ["-A", "-o", "pid=", "-o", "ppid=", "-o", "stat="]).stdout
            let rows = table.components(separatedBy: "\n").map { $0.split(separator: " ").map(String.init) }.filter { $0.count == 3 }
            var under: Set<Int> = [pid]
            var grew = true
            while grew {
                grew = false
                for row in rows {
                    if let each = Int(row[0]), let parent = Int(row[1]), under.contains(parent), !under.contains(each) {
                        under.insert(each)
                        grew = true
                    }
                }
            }
            if rows.contains(where: { Int($0[0]).map(under.contains) == true && $0[2].hasPrefix("Z") }) { return }
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        throw Said("no process under \(pid) became a zombie")
    }
}

/// A machine that never answers a command.
private final class SilentRuntime: MachineRuntime, @unchecked Sendable {
    let base: LocalRuntime
    init(home: String) { base = LocalRuntime(home: { home }) }
    var id: RuntimeId { .local }
    var `where`: String { "" }
    var cadence: RuntimeCadence { localCadence }
    func home() async throws -> String { try await base.home() }
    func environment() async throws -> [String: String] { ["PATH": "/usr/bin:/bin"] }
    func exec(_ request: ExecRequest) async throws -> ExecResult { throw Said("terminal runtime timed out") }
    func spawnPty(_ launch: PtyLaunch) throws -> any PseudoTerminal { try base.spawnPty(launch) }
    func spawnStream(_ request: StreamRequest) throws -> any ByteStream { try base.spawnStream(request) }
    func resolveProgram(_ configured: String, searchPath: String) async -> ProgramResolution { await base.resolveProgram(configured, searchPath: searchPath) }
    func tmuxProgram(_ configured: String, searchPath: String) async -> TmuxProgram { await base.tmuxProgram(configured, searchPath: searchPath) }
    func userTmuxConfig(_ localPath: String) async -> UserTmuxConfig { .none }
    func scratchDirectory() async throws -> String { NSTemporaryDirectory() }
    func stat(_ path: String) async throws -> FileKind { try await base.stat(path) }
    func readTextFile(_ path: String, maxBytes: Int) async throws -> String { try await base.readTextFile(path, maxBytes: maxBytes) }
    func writeTextFile(_ path: String, text: String, mode: Int) async throws { try await base.writeTextFile(path, text: text, mode: mode) }
    func writeNewTextFile(_ path: String, text: String, mode: Int) async throws -> Bool { try await base.writeNewTextFile(path, text: text, mode: mode) }
    func readdir(_ path: String) async throws -> [DirEntry] { try await base.readdir(path) }
    func removeTree(_ path: String) async throws { try await base.removeTree(path) }
    func makeDirectory(_ path: String) async throws { try await base.makeDirectory(path) }
    func realpath(_ path: String) async throws -> String { try await base.realpath(path) }
    func commandFromHere(_ command: MachineCommand) async throws -> MachineCommand { command }
    func forwardLoopbackPort(_ port: Int) async throws -> LoopbackForward { try await base.forwardLoopbackPort(port) }
    func resumed() {}
    func reading() -> RuntimeReading { base.reading() }
}

final class CodexPaneThreadTests: XCTestCase {
    func record(_ pid: Int, _ path: String, _ mtime: Int, _ meta: Any) -> String {
        let line: String
        if let text = meta as? String {
            line = text
        } else {
            line = String(decoding: try! JSONSerialization.data(withJSONObject: meta), as: UTF8.self)
        }
        return "codex\t\(pid)\t\(mtime)\t\(path)\n\(line)\n"
    }

    func meta(_ id: String, _ source: Any) -> [String: Any] { ["type": "session_meta", "payload": ["id": id, "source": source]] }
    func at(_ id: String) -> String { "/u/.codex/sessions/2026/10/22/rollout-2026-10-22T09-00-00-\(id).jsonl" }

    func testIsTheOneWrittenLastNeverASubagentsHoweverItIsSpelled() throws {
        let records = try TerminalAgentSessionLookup.parsePaneRecords(
            "proc\t10\t\tcodex\n\n"
                + record(10, at("a"), 100, meta("a", "cli"))
                + record(10, at("b"), 300, meta("b", ["subAgent": "review"]))
                + record(10, at("c"), 250, meta("c", "subagent_compact"))
                + record(10, at("d"), 200, meta("d", "appServer"))
        )
        XCTAssertEqual(try TerminalAgentSessionLookup.codexPaneThread(records, where: "pane pid 9"), "d")
    }

    func testTakesAReadableRolloutOverOneOnlyItsNameSays() throws {
        let records = try TerminalAgentSessionLookup.parsePaneRecords(record(10, at("old"), 100, meta("old", "cli")) + record(10, at("new"), 200, ""))
        XCTAssertEqual(try TerminalAgentSessionLookup.codexPaneThread(records, where: "pane pid 9"), "old")
    }

    func testSaysWhichProcessesItLookedAtWhatItPassedOverAndWhyLsofCouldNotSay() throws {
        let records = try TerminalAgentSessionLookup.parsePaneRecords(
            "proc\t9\t\tzsh\n\n"
                + "proc\t10\t\t/opt/homebrew/bin/codex\n\n"
                + record(10, at("h"), 100, meta("h", ["subagent": [String: String]()]))
                + "note\t\t\tlsof exited 1 listing the files of processes 9,10\n\n"
        )
        XCTAssertThrowsError(try TerminalAgentSessionLookup.codexPaneThread(records, where: "pane pid 9")) { error in
            let text = "\(error)"
            XCTAssertNotNil(text.range(of: #"has no thread open yet.*Processes looked at: zsh \(9\), /opt/homebrew/bin/codex \(10\)\. Rollouts open but not taken: .*rollout-2026-10-22T09-00-00-h\.jsonl \(a subagent's\)\. lsof exited 1"#, options: .regularExpression), text)
        }
    }

    func testRefusesARecordItDidNotAskFor() {
        XCTAssertThrowsError(try TerminalAgentSessionLookup.parsePaneRecords("odd\t1\t\tx\n\n"))
        XCTAssertThrowsError(try TerminalAgentSessionLookup.parsePaneRecords("proc\t1\t\tx\n"))
    }
}

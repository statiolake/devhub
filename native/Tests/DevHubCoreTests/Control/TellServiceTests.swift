// Port of apps/desktop/src/main/cli/tell/service.test.ts.
//
// The TypeScript test's TellFakePorts, rebuilt here exactly, driven through the
// scenarios in Fixtures/control/tell-service.json — which the TypeScript
// `TellService` itself ran against the same fakes. Every answer must match
// to the byte: the sentence, the `--json` data (key order included), and
// every call the service made on the app.

import Foundation
import XCTest
@testable import DevHubCore

// MARK: - The fixture's shapes, read

private func string(_ value: WireJSON?) -> String? { value?.stringValue }

private func agent(_ json: WireJSON) -> TellAgent {
    TellAgent(
        id: json["id"]!.stringValue!, name: json["name"]!.stringValue!, workspaceId: json["workspaceId"]!.stringValue!,
        profileId: json["profileId"]!.stringValue!, kind: json["kind"]!.stringValue!,
        presentation: TellPresentation(rawValue: json["presentation"]!.stringValue!)!, status: json["status"]!.stringValue!,
        unread: string(json["unread"]), activity: string(json["activity"]))
}

private func workspace(_ json: WireJSON) -> TellWorkspace {
    TellWorkspace(
        id: json["id"]!.stringValue!, name: json["name"]!.stringValue!, root: json["root"]!.stringValue!,
        machine: json["machine"]!.stringValue!, scratch: json["scratch"]!.boolValue!, selected: json["selected"]!.boolValue!,
        branch: string(json["branch"]), worktreeOf: string(json["worktreeOf"]), repositoryUrl: string(json["repositoryUrl"]),
        issue: string(json["issue"]), container: string(json["container"]),
        agents: json["agents"]!.arrayValue!.map(agent))
}

private func pane(_ json: WireJSON) -> TellTerminalPane {
    TellTerminalPane(
        window: json["window"]!.stringValue!, windowIndex: json["windowIndex"]!.integerValue!,
        windowName: json["windowName"]!.stringValue!, windowActive: json["windowActive"]!.boolValue!,
        pane: json["pane"]!.stringValue!, paneIndex: json["paneIndex"]!.integerValue!, active: json["active"]!.boolValue!,
        left: json["left"]!.integerValue!, top: json["top"]!.integerValue!, width: json["width"]!.integerValue!,
        height: json["height"]!.integerValue!, cwd: json["cwd"]!.stringValue!, command: json["command"]!.stringValue!,
        title: json["title"]!.stringValue!, dead: json["dead"]!.boolValue!)
}

private func editorPane(_ json: WireJSON) -> TellEditorPane {
    TellEditorPane(pane: pane(json), session: json["session"]!.stringValue!, argv: string(json["argv"]))
}

/// `TranscriptEntry` (model/conversation.ts) as the fields `agent read` reads.
private func entry(_ json: WireJSON) -> TellTranscriptEntry {
    let id = json["id"]!.stringValue!
    switch json["kind"]!.stringValue! {
    case "user": return .user(id: id, text: json["text"]!.stringValue!)
    case "answer":
        return .answer(
            id: id,
            answers: json["answers"]!.arrayValue!.map {
                TellQuestionAnswer(
                    question: $0["question"]!.stringValue!, chosen: $0["chosen"]!.arrayValue!.map { $0.stringValue! },
                    written: string($0["written"]))
            })
    case "command": return .command(id: id, line: string(json["line"]), output: string(json["output"]))
    case "assistant":
        return .assistant(
            id: id,
            texts: json["blocks"]!.arrayValue!.filter { $0["kind"] == "text" }.map { $0["markdown"]!.stringValue! })
    case "tool":
        return .tool(
            id: id, tool: json["tool"]!.stringValue!, title: json["title"]!.stringValue!, status: json["status"]!.stringValue!)
    case "notice": return .notice(id: id, text: json["text"]!.stringValue!)
    case "compaction": return .compaction(id: id)
    case "turn-end": return .turnEnd(id: id, outcome: json["outcome"]!.stringValue!, detail: string(json["detail"]))
    default: fatalError("\(json)")
    }
}

private func question(_ json: WireJSON) -> TellQuestion {
    TellQuestion(
        id: json["id"]!.stringValue!, header: json["header"]!.stringValue!, text: json["text"]!.stringValue!,
        options: json["options"]!.arrayValue!.map {
            TellQuestionOption(label: $0["label"]!.stringValue!, description: $0["description"]!.stringValue!)
        }, multiSelect: json["multiSelect"]!.boolValue!, allowsOther: json["allowsOther"]!.boolValue!)
}

private func request(_ json: WireJSON) -> TellPendingRequest {
    let subject = json["subject"]!
    let id = json["id"]!.stringValue!
    switch subject["kind"]!.stringValue! {
    case "tool": return TellPendingRequest(id: id, subject: .tool(tool: subject["tool"]!.stringValue!, title: subject["title"]!.stringValue!))
    case "command": return TellPendingRequest(id: id, subject: .command(command: subject["command"]!.stringValue!))
    case "file-change":
        return TellPendingRequest(id: id, subject: .fileChange(paths: subject["files"]!.arrayValue!.map { $0["path"]!.stringValue! }))
    case "question": return TellPendingRequest(id: id, subject: .question(subject["questions"]!.arrayValue!.map(question)))
    case "elicitation":
        return TellPendingRequest(
            id: id, subject: .elicitation(server: subject["server"]!.stringValue!, message: subject["message"]!.stringValue!))
    default: fatalError("\(json)")
    }
}

// MARK: - The TypeScript test's fakes

private actor TellFakeConversation: TellConversation {
    var submitted: [String] = []
    var answered: [String] = []
    var interrupted = 0
    var pending: [TellPendingRequest]
    var state: String
    var log: [TellTranscriptEntry]

    init(_ json: WireJSON) {
        pending = json["pending"]!.arrayValue!.map(request)
        state = json["turn"]!.stringValue!
        log = json["log"]!.arrayValue!.map(entry)
    }

    func entries() -> [TellTranscriptEntry] { log }
    func requests() -> [TellPendingRequest] { pending }
    func turn() -> String { state }
    func submit(_ text: String) { submitted.append(text) }
    func interrupt() { interrupted += 1 }
    func answer(_ request: String, _ answer: TellRequestAnswer) {
        answered.append(WireJSON.object([(key: "request", value: .string(request)), (key: "answer", value: answer.json)]).compact)
    }
    func setPending(_ requests: [TellPendingRequest]) { pending = requests }
    func append(_ entry: TellTranscriptEntry) { log.append(entry) }
}

private actor TellFakePorts: TellPorts {
    var calls: [String] = []
    var queued: [String] = []
    var conversations: [String: TellFakeConversation] = [:]
    var polls = 0
    var idleAfter: Int?
    var spaces: [TellWorkspace]
    var terminals: [String: [TellTerminalPane]] = [:]
    var editor: [TellEditorPane] = []

    init(_ world: WireJSON) {
        spaces = world["workspaces"]!.arrayValue!.map(workspace)
        for (id, conversation) in world["conversations"]!.objectValue! {
            conversations[id] = TellFakeConversation(conversation)
        }
    }

    func workspaces() -> [TellWorkspace] {
        polls += 1
        if let idleAfter, polls >= idleAfter {
            return spaces.map { each in
                guard each.id == "w1" else { return each }
                var idle = each
                idle.agents = [
                    TellAgent(
                        id: "aaaa1111-0000", name: "Claude 1", workspaceId: "w1", profileId: "claude", kind: "claude",
                        presentation: .gui, status: "idle")
                ]
                return idle
            }
        }
        return spaces
    }

    func profiles() -> [(id: String, kind: String)] { [("claude", "claude"), ("codex", "codex")] }

    func openWorkspace(path: String, machine: String, worktree: String?) -> String {
        calls.append("open \(path) \(machine) \(worktree ?? "-")")
        return "w1"
    }

    func createAgent(workspaceId: String, profileId: String, presentation: TellPresentation?) -> String {
        calls.append("create \(workspaceId) \(profileId) \(presentation?.rawValue ?? "-")")
        return "new-agent"
    }

    func renameAgent(_ agentId: String, name: String) { calls.append("rename \(agentId) \(name)") }
    func queueText(_ agentId: String, text: String) { queued.append("\(agentId) <- \(text)") }

    func assignIssue(_ request: IssueAssignRequest) -> (workspaceId: String, agentId: String?) {
        calls.append("assign \(request.json.compact)")
        return ("w1", request.editorOnly ? nil : "issue-agent")
    }

    func conversation(_ agentId: String) -> (any TellConversation)? { conversations[agentId] }

    func commands() -> [TellPaletteCommand] {
        [
            TellPaletteCommand(id: "next_agent", label: "Next agent", category: "Navigate", available: true),
            TellPaletteCommand(id: "close_selection", label: "Close", category: "Agent", available: false),
        ]
    }

    func runCommand(_ id: String) -> Bool {
        calls.append("run \(id)")
        return id == "next_agent"
    }

    func focusWorkspace(_ workspaceId: String) { calls.append("focus-workspace \(workspaceId)") }
    func focusAgent(_ agentId: String) { calls.append("focus-agent \(agentId)") }
    func notify(_ text: String) { calls.append("notify \(text)") }

    func agentTerminal(_ agentId: String) -> TellTerminal {
        guard let panes = terminals[agentId] else { return TellTerminal(agentId: agentId, workspaceId: "w1", session: nil) }
        return TellTerminal(
            agentId: agentId, workspaceId: "w1",
            session: TellTerminal.Session(
                id: agentId, name: "tm-\(agentId)", open: true, visible: true, focused: false,
                tmux: TellTerminal.Live(tmux: "/opt/homebrew/bin/tmux", socket: "/private/tmp/tmux-501/devhub", panes: panes)))
    }

    func openAgentTerminal(_ agentId: String, command: String?, focus: Bool) -> Bool {
        let request = WireJSON.object(dropping: [("command", .optional(command)), ("focus", .bool(focus))])
        calls.append("open-terminal \(agentId) \(request.compact)")
        if terminals[agentId] != nil { return false }
        terminals[agentId] = [
            TellTerminalPane(
                window: "@1", windowIndex: 0, windowName: "zsh", windowActive: true, pane: "%7", paneIndex: 7, active: true,
                left: 0, top: 0, width: 160, height: 48, cwd: "/src/app", command: "zsh", title: "host", dead: false)
        ]
        return true
    }

    func closeAgentTerminal(_ agentId: String) -> Bool {
        calls.append("close-terminal \(agentId)")
        return terminals.removeValue(forKey: agentId) != nil
    }

    func editorPanes(_ agentId: String) -> [TellEditorPane] {
        calls.append("editor-panes \(agentId)")
        return editor
    }

    func bringPane(_ agentId: String, pane: String, focus: Bool) -> Bool {
        calls.append("bring \(agentId) \(pane) \(focus)")
        let moved = editor.first { $0.pane.pane == pane }!
        editor.removeAll { $0.pane.pane == pane }
        let existing = terminals[agentId]
        terminals[agentId] = (existing ?? []) + [moved.pane]
        return existing == nil
    }

    func apply(_ step: WireJSON) async {
        switch step["op"]!.stringValue! {
        case "pushWorkspace": spaces.append(workspace(step["workspace"]!))
        case "terminals": terminals[step["agent"]!.stringValue!] = step["panes"]!.arrayValue!.map(pane)
        case "editor": editor = step["panes"]!.arrayValue!.map(editorPane)
        case "pending": await conversations["aaaa1111-0000"]!.setPending(step["requests"]!.arrayValue!.map(request))
        case "appendLog": await conversations["aaaa1111-0000"]!.append(entry(step["entry"]!))
        case "idleAfter": idleAfter = polls + step["polls"]!.integerValue!
        default: fatalError("\(step)")
        }
    }
}

private actor TellFakeClock: TellClock {
    var time = 0.0
    func now() -> Double { time }
    func sleep(milliseconds: Int) { time += Double(milliseconds) }
}

final class TellServiceTests: XCTestCase {
    func testEveryScenarioAnswersAsTheTypeScriptServiceAnswered() async throws {
        let scenarios = try WP7Fixtures.json("control/tell-service.json").arrayValue!
        XCTAssertGreaterThan(scenarios.count, 20)
        var runs = 0
        for scenario in scenarios {
            let name = scenario["name"]!.stringValue!
            let ports = TellFakePorts(scenario["world"]!)
            let clock = TellFakeClock()
            let service = TellService(ports: ports, clock: clock)
            var outputs = scenario["outputs"]!.arrayValue![...]
            for step in scenario["steps"]!.arrayValue! {
                guard step["op"] == "run" else {
                    await ports.apply(step)
                    continue
                }
                runs += 1
                let expected = outputs.removeFirst()
                let command = try TellCommand(json: step["command"])
                let label = "\(name): \(step["command"]!.compact) \(step["origin"]?.compact ?? "") \(step["machine"]?.compact ?? "")"
                do {
                    let answer = try await service.run(
                        command, caller: TellCaller.from(origin: string(step["origin"]), machine: string(step["machine"])))
                    XCTAssertEqual(answer.message, expected["message"]?.stringValue, label)
                    XCTAssertEqual(answer.data.compact, expected["data"]?.stringValue, label)
                } catch {
                    XCTAssertEqual("\(error)", expected["error"]?.stringValue, label)
                }
                let calls = await ports.calls
                XCTAssertEqual(calls, expected["calls"]!.arrayValue!.map { $0.stringValue! }, label)
                let queued = await ports.queued
                XCTAssertEqual(queued, expected["queued"]!.arrayValue!.map { $0.stringValue! }, label)
                let conversation = await ports.conversations["aaaa1111-0000"]!
                let submitted = await conversation.submitted
                XCTAssertEqual(submitted, expected["submitted"]!.arrayValue!.map { $0.stringValue! }, label)
                let answered = await conversation.answered
                XCTAssertEqual(answered, expected["answered"]!.arrayValue!.map { $0.stringValue! }, label)
                let interrupted = await conversation.interrupted
                XCTAssertEqual(interrupted, expected["interrupted"]!.integerValue, label)
                let now = await clock.time
                XCTAssertEqual(now, expected["now"]!.numberValue, label)
            }
        }
        XCTAssertGreaterThan(runs, 80)
    }

    func testReadsTheCallerOutOfDevHubOriginOrItsMachineAlone() {
        XCTAssertEqual(
            TellCaller.fromOrigin("local\tscratch\tbbbb2222-0000"),
            TellCaller(machine: "local", agentId: "bbbb2222-0000", workspaceId: nil))
        XCTAssertEqual(TellCaller.fromOrigin("ssh:box\tw1\tnone"), TellCaller(machine: "ssh:box", agentId: nil, workspaceId: "w1"))
        XCTAssertNil(TellCaller.fromOrigin(nil))
        XCTAssertNil(TellCaller.fromOrigin("garbage"))
        XCTAssertEqual(
            TellCaller.from(origin: nil, machine: "ssh:box"),
            TellCaller(machine: "ssh:box", agentId: nil, workspaceId: nil, paneless: true))
        XCTAssertEqual(TellCaller.from(origin: "ssh:box\tw1\tnone", machine: "ssh:other"), TellCaller.fromOrigin("ssh:box\tw1\tnone"))
        XCTAssertNil(TellCaller.from(origin: nil, machine: nil))
        XCTAssertNil(TellCaller.from(origin: nil, machine: ""))
    }

    func testBuildsAnAnswerFromOptionNumbers() throws {
        let database = TellQuestion(
            id: "Which database?", header: "Database", text: "Which database?",
            options: [TellQuestionOption(label: "Postgres"), TellQuestionOption(label: "SQLite", description: "small")],
            multiSelect: false, allowsOther: true)
        XCTAssertEqual(
            try TellWords.questionAnswer([database], options: [], text: "MySQL", note: "n").json.compact,
            #"{"kind":"answers","values":{"Which database?":"MySQL"},"notes":{"Which database?":"n"}}"#)
        XCTAssertThrowsError(try TellWords.questionAnswer([database], options: [3], text: nil, note: "n")) {
            XCTAssertTrue("\($0)".contains("2 options"))
        }
        XCTAssertThrowsError(try TellWords.questionAnswer([database], options: [1, 2], text: nil, note: "n")) {
            XCTAssertTrue("\($0)".contains("one answer"))
        }
        XCTAssertThrowsError(try TellWords.questionAnswer([database], options: [], text: nil, note: "n")) {
            XCTAssertTrue("\($0)".contains("no answer"))
        }
        var second = database
        second.id = "Q2"
        second.header = "Q2"
        second.multiSelect = true
        XCTAssertEqual(
            try TellWords.questionAnswer([database, second], options: [1, 3, 4], text: nil, note: "n").json["values"],
            ["Which database?": "Postgres", "Q2": ["Postgres", "SQLite"]])
        XCTAssertEqual(
            TellWords.answeredBy(nil, workspaces: []), "answered via devhub CLI by a terminal outside any agent")
    }

    func testNamesCornersSidesTheMiddleAndTheWhole() {
        func pane(_ id: String, _ left: Int, _ top: Int, _ width: Int, _ height: Int) -> TellTerminalPane {
            TellTerminalPane(
                window: "@1", windowIndex: 0, windowName: "zsh", windowActive: true, pane: id, paneIndex: 0, active: true,
                left: left, top: top, width: width, height: height, cwd: "/", command: "zsh", title: "", dead: false)
        }
        let whole = pane("%1", 0, 0, 100, 40)
        XCTAssertEqual(TellWords.paneWhere(whole, window: [whole]), "whole")
        let grid = [pane("%1", 0, 0, 33, 20), pane("%2", 34, 0, 33, 20), pane("%3", 68, 0, 32, 20), pane("%4", 0, 21, 100, 19)]
        XCTAssertEqual(grid.map { TellWords.paneWhere($0, window: grid) }, ["top-left", "top-middle", "top-right", "bottom"])
        let nine = (0..<3).flatMap { row in (0..<3).map { column in pane("%\(row)\(column)", column * 10, row * 10, 9, 9) } }
        XCTAssertEqual(TellWords.paneWhere(nine[4], window: nine), "middle")
        XCTAssertEqual(TellWords.paneWhere(nine[3], window: nine), "middle-left")
    }

    func testQuotesAShellWordOnlyWhenItHasTo() throws {
        let fixture = try WP7Fixtures.json("control/json.json")
        for entry in fixture["shellWords"]!.arrayValue! {
            XCTAssertEqual(TellWords.shellWord(entry["w"]!.stringValue!), entry["quoted"]!.stringValue!)
        }
    }
}

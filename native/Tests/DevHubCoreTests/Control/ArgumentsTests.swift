// Port of apps/desktop/src/main/cli/devhubCli.test.ts (the parser half),
// goto.test.ts and tell/command.test.ts — and every case the fixtures list,
// whose expectations are what the TypeScript parser itself produced.

import XCTest
@testable import DevHubCore

extension DevhubCommand {
    var kind: String {
        switch self {
        case .usage: return "usage"
        case .activate: return "activate"
        case .openStdin: return "open-stdin"
        case .invalid: return "invalid"
        case .open: return "open"
        case .addAgent: return "add-agent"
        case .installExtensions: return "install-extensions"
        case .uninstallExtensions: return "uninstall-extensions"
        case .listExtensions: return "list-extensions"
        case .version: return "version"
        case .metrics: return "metrics"
        case .tell: return "tell"
        }
    }
}

private func told(_ argv: String...) throws -> TellCommand {
    switch TellArguments.parse(argv) {
    case let .tell(command, _): return command
    case let .invalid(message): throw TellRefusal(message)
    }
}

private func refusal(_ argv: String...) -> String {
    if case let .invalid(message) = TellArguments.parse(argv) { return message }
    return "<parsed>"
}

final class DevhubArgumentsTests: XCTestCase {
    func testUsageIsTheTypeScriptCLIsVerbatim() throws {
        XCTAssertEqual(devhubUsage, try WP7Fixtures.text("control/usage.txt"))
        XCTAssertEqual(tellUsage, try WP7Fixtures.text("control/tell-usage.txt"))
        XCTAssertTrue(devhubUsage.contains("bring DevHub to the front"))
        XCTAssertTrue(devhubUsage.contains("devhub -  "))
        XCTAssertTrue(devhubUsage.contains("devhub --tell <subcommand>"))
    }

    /// Every argv the fixture lists, from five callers and with and without a
    /// wait marker: the same command, the same refusal, the same request
    /// bytes as the TypeScript CLI.
    func testEveryCommandLineAsksWhatTheTypeScriptCLIAsks() throws {
        let cases = try WP7Fixtures.json("control/cli-requests.json").arrayValue!
        XCTAssertGreaterThan(cases.count, 300)
        for entry in cases {
            let argv = entry["argv"]!.arrayValue!.map { $0.stringValue! }
            var environment: [String: String] = [:]
            for (key, value) in entry["env"]!.objectValue! { environment[key] = value.stringValue! }
            let marker = entry["marker"]!.stringValue
            let label = "\(argv) \(environment) \(marker ?? "-")"
            let parsed = DevhubArguments.parse(argv)
            XCTAssertEqual(parsed.kind, entry["kind"]!.stringValue!, label)
            if let message = entry["invalid"]!.stringValue {
                XCTAssertEqual(parsed, .invalid(message), label)
            }
            let caller = CallerContext(environment: environment)
            switch entry["request"]! {
            case .null:
                XCTAssertNil(try DevhubArguments.request(for: parsed, cwd: "/work/a", home: "/home/d", waitMarkerPath: marker, caller: caller), label)
            case let .string(expected):
                let request = try DevhubArguments.request(
                    for: parsed, cwd: "/work/a", home: "/home/d", waitMarkerPath: marker, caller: caller)
                XCTAssertEqual(request?.json.compact, expected, label)
                // And the app reads it back as itself.
                XCTAssertEqual(try ControlRequest.parse(expected), request, label)
            default:
                XCTAssertThrowsError(
                    try DevhubArguments.request(for: parsed, cwd: "/work/a", home: "/home/d", waitMarkerPath: marker, caller: caller)
                ) { error in
                    XCTAssertEqual("\(error)", entry["request"]!["throws"]!.stringValue!)
                }
            }
        }
    }

    func testTakesALonePathAnAgentAndEverythingAfterDoubleDashForTheAgent() {
        XCTAssertEqual(DevhubArguments.parse(["src/main.ts"]), .open(path: "src/main.ts", position: nil, wait: false))
        XCTAssertEqual(DevhubArguments.parse(["--agent", "claude"]), .addAgent(profileId: "claude", args: []))
        XCTAssertEqual(
            DevhubArguments.parse(["--agent", "claude", "--", "--help", "-p", "hi"]),
            .addAgent(profileId: "claude", args: ["--help", "-p", "hi"]))
        XCTAssertEqual(DevhubArguments.parse([]), .activate)
        XCTAssertEqual(DevhubArguments.parse(["-"]), .openStdin(wait: false))
        XCTAssertEqual(DevhubArguments.parse(["--wait", "-"]), .openStdin(wait: true))
        XCTAssertEqual(
            DevhubArguments.parse(["--wait", "-g", "a.ts:9:2"]),
            .open(path: "a.ts", position: FilePosition(line: 9, column: 2), wait: true))
    }

    func testHasNoRequestToSendForAPipeItHasNotReadYet() {
        XCTAssertThrowsError(try DevhubArguments.request(for: .openStdin(wait: false), cwd: "/work", home: "/home/d")) { error in
            XCTAssertTrue("\(error)".contains("spooled to a file"))
        }
    }

    func testCallerContextSaysNothingAboutAnOriginItWasNotGiven() {
        XCTAssertEqual(CallerContext(environment: [:]), CallerContext())
        XCTAssertEqual(CallerContext(environment: ["DEVHUB_ORIGIN": "", "DEVHUB_MACHINE": ""]), CallerContext())
        XCTAssertEqual(
            CallerContext(environment: ["DEVHUB_ORIGIN": "local\tw\tnone", "DEVHUB_MACHINE": "local"]),
            CallerContext(origin: "local\tw\tnone", machine: "local"))
    }

    func testMakesAWorkspaceSpelledAsARelativePathAbsoluteAndNothingElse() {
        XCTAssertEqual(DevhubArguments.expandWorkspacePath(".", cwd: "/srv/app", home: "/home/d"), "/srv/app")
        XCTAssertEqual(DevhubArguments.expandWorkspacePath("../lib", cwd: "/srv/app", home: "/home/d"), "/srv/lib")
        XCTAssertEqual(DevhubArguments.expandWorkspacePath("~/x", cwd: "/srv/app", home: "/home/d"), "/home/d/x")
        XCTAssertEqual(DevhubArguments.expandWorkspacePath("scratch", cwd: "/srv", home: "/home/d"), "scratch")
        XCTAssertEqual(DevhubArguments.expandWorkspacePath("w1", cwd: "/srv", home: "/home/d"), "w1")
        XCTAssertEqual(DevhubArguments.expandWorkspacePath("/abs", cwd: "/srv", home: "/home/d"), "/abs")
    }

    func testPutsPipedTextWhereDashStood() {
        XCTAssertEqual(
            DevhubArguments.withStdinText(.agentSend(agent: "a", text: "-"), "long\nmessage\n"),
            .agentSend(agent: "a", text: "long\nmessage"))
        XCTAssertEqual(
            DevhubArguments.withStdinText(.agentNew(TellAgentNew(workspace: "w", prompt: "-")), "p"),
            .agentNew(TellAgentNew(workspace: "w", prompt: "p")))
        XCTAssertEqual(
            DevhubArguments.withStdinText(.issueAssign(TellIssueAssign(url: "u", prompt: "-")), "x\r\n"),
            .issueAssign(TellIssueAssign(url: "u", prompt: "x\r")))
        XCTAssertEqual(
            DevhubArguments.withStdinText(.agentSend(agent: "a", text: "hi"), "ignored"), .agentSend(agent: "a", text: "hi"))
    }

    // MARK: goto.ts

    func testReadsFileLineColumnAsTheTypeScriptCLIDoes() throws {
        XCTAssertEqual(try GotoSpec.parse("src/main.ts:42:7").position, FilePosition(line: 42, column: 7))
        XCTAssertEqual(try GotoSpec.parse("src/main.ts:42").position, FilePosition(line: 42, column: 1))
        XCTAssertNil(try GotoSpec.parse("src/main.ts").position)
        XCTAssertEqual(try GotoSpec.parse("/w/odd:name/a.ts:3:4").path, "/w/odd:name/a.ts")
        for bad in ["a.ts:", "a.ts:0", "a.ts:-3", "a.ts:2.5", "a.ts:3:0", "12"] {
            XCTAssertThrowsError(try GotoSpec.parse(bad)) { error in
                XCTAssertTrue("\(error)".contains("FILE:LINE"), bad)
            }
        }
        for entry in try WP7Fixtures.json("control/goto.json").arrayValue! {
            let spec = entry["spec"]!.stringValue!
            if let result = entry["result"] {
                let parsed = try GotoSpec.parse(spec)
                XCTAssertEqual(parsed.path, result["path"]!.stringValue!, spec)
                if let position = result["position"] {
                    XCTAssertEqual(
                        parsed.position,
                        FilePosition(line: position["line"]!.integerValue!, column: position["column"]!.integerValue!), spec)
                } else {
                    XCTAssertNil(parsed.position, spec)
                }
            } else {
                XCTAssertThrowsError(try GotoSpec.parse(spec), spec) { error in
                    XCTAssertEqual("\(error)", entry["error"]!.stringValue!)
                }
            }
        }
    }
}

final class TellArgumentsTests: XCTestCase {
    /// Every argv the fixture lists: the same command, byte for byte as JSON,
    /// or the same refusal.
    func testEveryTellCommandLineParsesAsTheTypeScriptParserParsesIt() throws {
        let cases = try WP7Fixtures.json("control/tell-arguments.json").arrayValue!
        XCTAssertGreaterThan(cases.count, 80)
        for entry in cases {
            let argv = entry["argv"]!.arrayValue!.map { $0.stringValue! }
            switch TellArguments.parse(argv) {
            case let .tell(command, json):
                XCTAssertEqual(command.json.compact, entry["command"]?.stringValue, "\(argv)")
                XCTAssertEqual(json, entry["json"]?.boolValue, "\(argv)")
            case let .invalid(message):
                XCTAssertEqual(message, entry["invalid"]?.stringValue, "\(argv)")
            }
        }
    }

    /// And the app's side: every value off the socket, accepted as the same
    /// command or refused with the same sentence.
    func testEveryTellCommandOffTheSocketIsReadAsTheTypeScriptAppReadsIt() throws {
        let cases = try WP7Fixtures.json("control/tell-from-socket.json").arrayValue!
        for entry in cases {
            let value = entry["value"]!
            do {
                let command = try TellCommand(json: value)
                XCTAssertEqual(command.json.compact, entry["command"]?.stringValue, value.compact)
            } catch {
                XCTAssertEqual("\(error)", entry["error"]?.stringValue, value.compact)
            }
        }
    }

    func testReadsHelpTheListingsAndWorkspaceOpen() throws {
        XCTAssertEqual(try told(), .help)
        XCTAssertEqual(try told("help"), .help)
        XCTAssertEqual(TellArguments.parse(["--json", "agents"]), .tell(.agents(workspace: nil), json: true))
        XCTAssertEqual(try told("agents", "--workspace=~/src/app"), .agents(workspace: "~/src/app"))
        XCTAssertEqual(
            try told("workspace", "open", ".", "--worktree", "12-fix-login"),
            .workspaceOpen(path: ".", worktree: "12-fix-login"))
        XCTAssertTrue(refusal("workspace", "close", ".").contains("open"))
        XCTAssertTrue(refusal("workspace", "open").contains("<path>"))
    }

    func testReadsAgentNewAndIssueAssign() throws {
        XCTAssertEqual(
            try told("agent", "new", "--workspace", "w1", "--profile", "claude", "--name", "API fix", "--prompt", "fix it", "--gui"),
            .agentNew(TellAgentNew(workspace: "w1", profile: "claude", name: "API fix", prompt: "fix it", presentation: .gui)))
        XCTAssertTrue(refusal("agent", "new", "--workspace", "w", "--gui", "--tui").contains("--gui"))
        XCTAssertEqual(
            try told("issue", "assign", "https://github.com/o/r/issues/123", "--branch", "123-fix-login-timeout", "--prompt-extra", "keep it small"),
            .issueAssign(TellIssueAssign(url: "https://github.com/o/r/issues/123", branch: "123-fix-login-timeout", prompt: "keep it small")))
        XCTAssertEqual(
            try told("issue", "assign", "u", "--root", "--editor-only", "--repo", "~/r"),
            .issueAssign(TellIssueAssign(url: "u", repo: "~/r", place: .root, editorOnly: true)))
        XCTAssertTrue(refusal("issue", "assign", "u", "--root", "--worktree").contains("--root"))
    }

    func testReadsThePerAgentSubcommandsAndNeverAPermissionAnswer() throws {
        XCTAssertEqual(try told("agent", "read", "a1", "--last", "5", "--since", "e9"), .agentRead(agent: "a1", last: 5, since: "e9"))
        XCTAssertEqual(try told("agent", "send", "a1", "please", "--also", "this"), .agentSend(agent: "a1", text: "please --also this"))
        XCTAssertEqual(
            try told("agent", "wait", "a1"),
            .agentWait(agent: "a1", until: .any, timeoutSeconds: TellCommand.defaultWaitSeconds))
        XCTAssertEqual(
            try told("agent", "answer", "a1", "r1", "--option", "2", "--option", "3"),
            .agentAnswer(agent: "a1", request: "r1", options: [2, 3], text: nil))
        XCTAssertTrue(refusal("agent", "answer", "a1", "r1", "--allow").contains("permission"))
        XCTAssertTrue(refusal("agent", "answer", "a1", "r1", "--deny").contains("permission"))
        XCTAssertTrue(refusal("launch-missiles").contains("not a --tell subcommand"))
    }

    func testTerminalIsAlwaysYourOwn() throws {
        XCTAssertEqual(try told("terminal", "open"), .terminalOpen(command: nil, focus: false))
        XCTAssertEqual(
            try told("terminal", "open", "--command", "npm run dev", "--focus"), .terminalOpen(command: "npm run dev", focus: true))
        XCTAssertEqual(try told("terminal", "show"), .terminalStatus)
        XCTAssertEqual(try told("terminal", "bring", "%7", "--focus"), .terminalBring(pane: "%7", focus: true))
        XCTAssertTrue(refusal("terminal", "bring", "ws-1:0.1").contains("%7"))
        XCTAssertTrue(refusal("terminal", "resolve", "right").contains("open, status (or show), close, panes, bring"))
        XCTAssertTrue(tellUsage.contains("terminal open [--command <cmd>] [--focus]"))
        XCTAssertTrue(tellUsage.contains("terminal bring <pane> [--focus]"))
        XCTAssertFalse(tellUsage.contains("terminal resolve"))
        XCTAssertFalse(tellUsage.contains("--split"))
        XCTAssertThrowsError(try TellCommand(json: ["verb": "terminal-open", "focus": "yes"])) { error in
            XCTAssertTrue("\(error)".contains("focus"))
        }
    }

    func testDevhubTellIsHandedEverythingAfterTellAsTyped() {
        XCTAssertEqual(
            DevhubArguments.parse(["--tell", "--json", "agent", "send", "a1", "--force=yes"]),
            .tell(.agentSend(agent: "a1", text: "--force=yes"), json: true))
        XCTAssertEqual(
            DevhubArguments.parse(["--tell", "agent", "answer", "a", "r", "--allow"]),
            .invalid("--tell: permission prompts are answered in DevHub, by the person, and never from the command line."))
    }
}

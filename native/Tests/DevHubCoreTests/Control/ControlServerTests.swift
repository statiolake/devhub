// Port of apps/desktop/src/main/cli/controlServer.test.ts, over a real unix
// socket, and every request line the fixture lists read as the TypeScript
// server reads it (Fixtures/control/control-requests.json).

import Foundation
import XCTest
@testable import DevHubCore

/// Handlers that record what they were asked and answer as the TypeScript
/// test's do.
final class RecordingHandlers: ControlHandlers, @unchecked Sendable {
    private let lock = NSLock()
    private var _calls: [String] = []
    private var _people = 0

    var calls: [String] { lock.withLock { _calls } }
    var peopleStarted: Int { lock.withLock { _people } }
    func record(_ call: String) { lock.withLock { _calls.append(call) } }

    func personStarted() async { lock.withLock { _people += 1 } }

    func activate() async throws -> String {
        record("activate")
        return "DevHub is in front."
    }

    func open(_ request: ControlOpenRequest) async throws -> String {
        var line = "open \(request.path) \(request.cwd)"
        if let machine = request.machine { line += " on=\(machine)" }
        if let position = request.position { line += " @\(position.line):\(position.column)" }
        if let marker = request.waitMarkerPath { line += " wait=\(marker)" }
        record(line)
        if request.path == "/srv/api" { throw ControlServerTests.Named(summary: "The workspace is unavailable.", detail: "/srv/api is not there any more.") }
        return "opened \(request.path)"
    }

    func waitEnded(_ waitMarkerPath: String) async throws -> String {
        record("wait-ended \(waitMarkerPath)")
        return "back where it was"
    }

    func addAgent(profileId: String, args: [String], cwd: String) async throws -> String {
        record("agent \(profileId) [\(args.joined(separator: " "))] \(cwd)")
        if profileId == "nowhere" { throw DevhubFailure("an agent needs a workspace") }
        return "agent \(profileId) started"
    }

    func version() async throws -> String { "DevHub 0.1.0 (native)" }

    func metrics() async throws -> String {
        record("metrics")
        return #"{"processes":[]}"#
    }

    func tell(_ command: TellCommand, origin: String?, machine: String?) async throws -> TellAnswer {
        record("tell \(command.verb)\(origin.map { " from=\($0)" } ?? "")")
        if case .agentAnswer = command { throw TellRefusal("only questions") }
        return TellAnswer(message: "2 agents", data: ["agents": ["a", "b"]])
    }

    func installCli() async throws -> String { "installed" }

    func resolveRemote(machine: String, attempt: Int) async throws -> RemoteResolution {
        record("resolve \(machine) #\(attempt)")
        switch machine {
        case "ssh:asleep": return .refused(message: "DevHub cannot reach asleep.", retry: true)
        case "ssh:vax": return .refused(message: "DevHub supports Linux and macOS hosts, and vax reports VMS.", retry: false)
        case "ssh:boom": throw DevhubFailure("something nobody wrote a case for")
        default:
            return .endpoint(
                RemoteEndpointAnswer(
                    port: 51234, connectionToken: "0123456789abcdef", extensionHostEnv: [("SSH_AUTH_SOCK", "/tmp/agent.7")]))
        }
    }

    func terminalProfile(machine: String, root: String?, workspace: String?) async throws -> TerminalProfileAnswer {
        record("profile \(machine) \(root ?? "scratch")\(workspace.map { " for \($0)" } ?? "")")
        if root == "/work/gone" { throw DevhubFailure("no DevHub workspace is rooted at /work/gone") }
        return TerminalProfileAnswer(
            file: "/usr/bin/tmux", args: ["-L", "devhub", "attach-session", "-t", "ws-abc"],
            env: ["TERMINFO": "/home/dev/.devhub-server/tmux/3.7c/terminfo"])
    }
}

/// One line in, everything the server wrote back, read to end of file.
func askRaw(_ socketPath: String, _ line: String, split: Bool = false) async throws -> String {
    try await UnixStream.offload {
        let fd = try UnixStream.connect(socketPath)
        defer { UnixStream.close(fd) }
        if split {
            let bytes = Array(line.utf8)
            try UnixStream.write(fd, Array(bytes.prefix(12)))
            Thread.sleep(forTimeInterval: 0.02)
            try UnixStream.write(fd, Array(bytes.dropFirst(12)))
        } else {
            try UnixStream.write(fd, line)
        }
        var buffer: [UInt8] = []
        while true {
            let chunk = try UnixStream.read(fd)
            if chunk.isEmpty { break }
            buffer += chunk
        }
        return String(decoding: buffer, as: UTF8.self)
    }
}

final class ControlServerTests: XCTestCase {
    struct Named: NamedFailureText {
        let summary: String
        let detail: String?
    }

    var directory = ""
    var socketPath = ""
    var server: ControlServer?
    var handlers = RecordingHandlers()

    override func setUp() async throws {
        directory = try wp7SocketDirectory("control")
        socketPath = directory + "/c.sock"
        handlers = RecordingHandlers()
        server = try await ControlServer.start(socketPath: socketPath, handlers: handlers)
    }

    override func tearDown() async throws {
        server?.close()
        wp7RemoveDirectory(directory)
    }

    func ask(_ value: WireJSON) async throws -> WireJSON {
        let raw = try await askRaw(socketPath, value.compact + "\n")
        XCTAssertTrue(raw.hasSuffix("\n"))
        XCTAssertEqual(raw.filter { $0 == "\n" }.count, 1, "one line, then the connection closes")
        return try WireJSON.parse(String(raw.dropLast()))
    }

    func expect(_ request: WireJSON, _ expected: WireJSON, file: StaticString = #filePath, line: UInt = #line) async throws {
        let answer = try await ask(request)
        XCTAssertEqual(answer, expected, file: file, line: line)
    }

    func testIsReadableByItsOwnerAndNobodyElse() throws {
        XCTAssertEqual(try wp7Permissions(socketPath), 0o600)
    }

    func testAnswersABareActivateAndAnOpenWithOneLineAndCloses() async throws {
        try await expect(["kind": "activate"], ["ok": true, "message": "DevHub is in front."])
        try await expect(
            ["kind": "open", "path": "/work/a/f.txt", "cwd": "/work/a"],
            ["ok": true, "message": "opened /work/a/f.txt"])
        XCTAssertEqual(handlers.calls, ["activate", "open /work/a/f.txt /work/a"])
    }

    func testCarriesTheMachinePositionAndWaitMarkerOfAnOpenThroughToTheHandler() async throws {
        _ = try await ask(["kind": "open", "path": "/srv/app/f.txt", "cwd": "/srv/app", "machine": "ssh:build-host"])
        _ = try await ask([
            "kind": "open", "path": "/work/a/f.txt", "cwd": "/work/a", "position": ["line": 42, "column": 7],
        ])
        _ = try await ask([
            "kind": "open", "path": "/work/a/COMMIT_EDITMSG", "cwd": "/work/a",
            "waitMarkerPath": "/tmp/devhub-wait-abc/marker",
        ])
        XCTAssertEqual(handlers.calls, [
            "open /srv/app/f.txt /srv/app on=ssh:build-host",
            "open /work/a/f.txt /work/a @42:7",
            "open /work/a/COMMIT_EDITMSG /work/a wait=/tmp/devhub-wait-abc/marker",
        ])
    }

    func testRefusesWhatIsNotAPlaceAMachineOrAMarkerBeforeAnyHandlerSeesIt() async throws {
        let machine = try await ask(["kind": "open", "path": "/work/a/f.txt", "cwd": "/work/a", "machine": 7])
        XCTAssertEqual(machine["ok"], false)
        XCTAssertEqual(machine["message"], "machine must be a non-empty string")
        let marker = try await ask(["kind": "wait-ended", "waitMarkerPath": "marker"])
        XCTAssertEqual(marker["message"], "waitMarkerPath must be an absolute path")
        for position: WireJSON in [["line": 0, "column": 1], ["line": 1, "column": 0], ["line": 2.5, "column": 1], ["line": "3", "column": 1]] {
            let answer = try await ask(["kind": "open", "path": "/work/a/f.txt", "cwd": "/work/a", "position": position])
            XCTAssertEqual(answer["ok"], false)
            XCTAssertTrue(answer["message"]!.stringValue!.contains("whole number from 1 up"))
        }
        XCTAssertEqual(handlers.calls, [])
    }

    func testCarriesTheEndOfAWaitAndAnAgentsArgumentsAndReportsARefusal() async throws {
        try await expect(
            ["kind": "wait-ended", "waitMarkerPath": "/tmp/devhub-wait-abc/marker"],
            ["ok": true, "message": "back where it was"])
        _ = try await ask(["kind": "add-agent", "profileId": "claude", "args": ["--help", "--", "-x"], "cwd": "/work/a"])
        try await expect(
            ["kind": "add-agent", "profileId": "nowhere", "args": [], "cwd": "/tmp"],
            ["ok": false, "message": "an agent needs a workspace"])
        XCTAssertEqual(handlers.calls, [
            "wait-ended /tmp/devhub-wait-abc/marker", "agent claude [--help -- -x] /work/a", "agent nowhere [] /tmp",
        ])
    }

    func testAnswersExtensionsWithTheSentenceThatTheNativeAppHasNone() async throws {
        let install = try await ask([
            "kind": "install-extensions", "targets": ["publisher.name"], "force": true, "cwd": "/work/a",
        ])
        XCTAssertEqual(install, ["ok": false, "message": .string(NativeUnavailable.extensions)])
        let listed = try await ask(["kind": "list-extensions", "showVersions": true])
        XCTAssertEqual(listed["message"]?.stringValue, NativeUnavailable.extensions)
        // A malformed one is still refused for what is wrong with it.
        try await expect(
            ["kind": "list-extensions", "showVersions": "yes"],
            ["ok": false, "message": "showVersions must be a boolean"])
        let devcontainer = try await ask([
            "kind": "dev-container-configs",
            "window": ["scheme": "file", "authority": "", "path": "/work/a", "fsPath": "/work/a"],
        ])
        XCTAssertEqual(devcontainer["message"]?.stringValue, NativeUnavailable.devContainers)
    }

    func testAnswersVersionMetricsAndTellWithTheirSentenceAndData() async throws {
        try await expect(["kind": "version"], ["ok": true, "message": "DevHub 0.1.0 (native)"])
        try await expect(["kind": "metrics"], ["ok": true, "message": #"{"processes":[]}"#])
        let raw = try await askRaw(
            socketPath, #"{"kind":"tell","command":{"verb":"agents"},"origin":"local\tscratch\tA1"}"# + "\n")
        XCTAssertEqual(raw, #"{"ok":true,"message":"2 agents","data":{"agents":["a","b"]}}"# + "\n")
        let refused = try await ask([
            "kind": "tell", "command": ["verb": "agent-answer", "agent": "a", "request": "r", "options": [1]],
        ])
        XCTAssertEqual(refused, ["ok": false, "message": "only questions"])
        let garbage = try await ask(["kind": "tell", "command": ["verb": "rm -rf"]])
        XCTAssertEqual(garbage["ok"], false)
        XCTAssertEqual(handlers.calls, ["metrics", "tell agents from=local\tscratch\tA1", "tell agent-answer"])
    }

    func testRefusesARequestItDoesNotUnderstand() async throws {
        let unknown = try await ask(["kind": "eval"])
        XCTAssertEqual(unknown, ["ok": false, "message": "unknown control request: eval"])
        try await expect(
            ["kind": "open", "path": "f.txt", "cwd": "/work"],
            ["ok": false, "message": "path must be an absolute path"])
        let garbage = try await askRaw(socketPath, "not json\n")
        XCTAssertTrue(garbage.hasPrefix(#"{"ok":false,"message":"#), garbage)
    }

    func testWaitsForAWholeLineBeforeAnswering() async throws {
        let raw = try await askRaw(socketPath, #"{"kind":"install-cli"}"# + "\n", split: true)
        XCTAssertEqual(raw, #"{"ok":true,"message":"installed"}"# + "\n")
    }

    func testRefusesARequestTooLargeToBeOne() async throws {
        let raw = try await askRaw(socketPath, String(repeating: "x", count: 70_000))
        XCTAssertEqual(raw, #"{"ok":false,"message":"the request is too large"}"# + "\n")
    }

    func testAnswersAPingFromTheServerItself() async throws {
        try await expect(["kind": "ping"], ["ok": true, "message": "DevHub is running."])
        let answers = await ControlClient.socketAnswers(socketPath)
        XCTAssertTrue(answers)
        XCTAssertEqual(handlers.peopleStarted, 0)
    }

    func testTakesOverASocketFileACrashedRunLeftBehindAndRefusesALiveOne() async throws {
        let error = await wp7Caught { try await ControlServer.start(socketPath: self.socketPath, handlers: RecordingHandlers()) }
        XCTAssertTrue("\(error!)".contains("already listening"), "\(error!)")
        server?.close()
        server = nil
        _ = FileManager.default.createFile(atPath: socketPath, contents: Data())
        server = try await ControlServer.start(socketPath: socketPath, handlers: handlers)
        let installed = try await ask(["kind": "install-cli"])
        XCTAssertEqual(installed["ok"], true)
    }

    func testAnswersATerminalProfileWithTheArgvAsData() async throws {
        let answer = try await ask(["kind": "terminal-profile", "machine": "local", "root": "/work/a"])
        XCTAssertEqual(answer["profile"], [
            "file": "/usr/bin/tmux", "args": ["-L", "devhub", "attach-session", "-t", "ws-abc"],
            "env": ["TERMINFO": "/home/dev/.devhub-server/tmux/3.7c/terminfo"],
        ])
        XCTAssertEqual(answer["message"], "/usr/bin/tmux -L devhub attach-session -t ws-abc")
        _ = try await ask(["kind": "terminal-profile", "machine": "local", "root": nil])
        _ = try await ask(["kind": "terminal-profile", "machine": "local", "root": "/Users/dev", "workspace": "ssh://build/srv/app"])
        let missing = try await ask(["kind": "terminal-profile", "root": "/srv/app"])
        XCTAssertTrue(missing["message"]!.stringValue!.contains("machine"))
        try await expect(
            ["kind": "terminal-profile", "machine": "local", "root": "/work/gone"],
            ["ok": false, "message": "no DevHub workspace is rooted at /work/gone"])
        XCTAssertEqual(handlers.calls, [
            "profile local /work/a", "profile local scratch", "profile local /Users/dev for ssh://build/srv/app",
            "profile local /work/gone",
        ])
    }

    // MARK: resolving where a remote workbench connects

    func testResolvesARemoteAsDataAndSaysWhetherAskingAgainCouldHelp() async throws {
        let endpoint = await ControlAnswering.answer(#"{"kind":"resolve-remote","machine":"ssh:build-box","attempt":3}"#, handlers: handlers)
        XCTAssertEqual(
            endpoint.line,
            #"{"ok":true,"message":"127.0.0.1:51234","remote":{"port":51234,"connectionToken":"0123456789abcdef","extensionHostEnv":{"SSH_AUTH_SOCK":"/tmp/agent.7"}}}"#
                + "\n")
        let asleep = await ControlAnswering.answer(#"{"kind":"resolve-remote","machine":"ssh:asleep","attempt":1}"#, handlers: handlers)
        XCTAssertEqual(asleep.line, #"{"ok":false,"message":"DevHub cannot reach asleep.","retry":true}"# + "\n")
        let vax = await ControlAnswering.answer(#"{"kind":"resolve-remote","machine":"ssh:vax","attempt":1}"#, handlers: handlers)
        XCTAssertEqual(vax.retry, false)
        let boom = await ControlAnswering.answer(#"{"kind":"resolve-remote","machine":"ssh:boom","attempt":1}"#, handlers: handlers)
        XCTAssertEqual(boom.line, #"{"ok":false,"message":"something nobody wrote a case for","retry":true}"# + "\n")
        for line in [
            #"{"kind":"resolve-remote","machine":"","attempt":1}"#, #"{"kind":"resolve-remote","machine":"ssh:a","attempt":-1}"#,
            #"{"kind":"resolve-remote","machine":"ssh:a","attempt":1.5}"#, #"{"kind":"resolve-remote","machine":"ssh:a","attempt":"3"}"#,
            #"{"kind":"resolve-remote","machine":"ssh:a"}"#,
        ] {
            let response = await ControlAnswering.answer(line, handlers: handlers)
            XCTAssertFalse(response.ok, line)
        }
        XCTAssertEqual(handlers.calls, ["resolve ssh:build-box #3", "resolve ssh:asleep #1", "resolve ssh:vax #1", "resolve ssh:boom #1"])
    }

    // MARK: a command the person typed

    func testWhatAPersonTypedStartsAnOperationAndWhatDevHubAsksDoesNot() async {
        let typed: [String] = [
            #"{"kind":"activate"}"#, #"{"kind":"open","path":"/src/api","cwd":"/src"}"#,
            #"{"kind":"add-agent","profileId":"claude","args":[],"cwd":"/src"}"#,
            #"{"kind":"install-extensions","targets":["a.b"],"force":false,"cwd":"/src"}"#,
            #"{"kind":"uninstall-extensions","ids":["a.b"],"force":false}"#, #"{"kind":"list-extensions","showVersions":false}"#,
            #"{"kind":"version"}"#, #"{"kind":"metrics"}"#, #"{"kind":"install-cli"}"#,
        ]
        for line in typed {
            let recording = RecordingHandlers()
            _ = await ControlAnswering.answer(line, handlers: recording)
            XCTAssertEqual(recording.peopleStarted, 1, line)
        }
        let machinery: [String] = [
            #"{"kind":"ping"}"#, #"{"kind":"wait-ended","waitMarkerPath":"/src/.wait"}"#,
            #"{"kind":"resolve-remote","machine":"ssh:build-box","attempt":1}"#,
            #"{"kind":"terminal-profile","machine":"local","root":null}"#, #"{"kind":"tell","command":{"verb":"agents"}}"#,
        ]
        for line in machinery {
            let recording = RecordingHandlers()
            _ = await ControlAnswering.answer(line, handlers: recording)
            XCTAssertEqual(recording.peopleStarted, 0, line)
        }
    }

    // MARK: a refusal the devhub command prints

    func testPrintsANamedFailureAsItsTitleAndItsDetailAndAnyOtherAsItsMessage() async {
        let named = await ControlAnswering.answer(#"{"kind":"open","path":"/srv/api","cwd":"/srv"}"#, handlers: handlers)
        XCTAssertEqual(named.message, "The workspace is unavailable. /srv/api is not there any more.")
        XCTAssertEqual(controlFailureText(Named(summary: "fatal: repository 'x' not found", detail: nil)), "fatal: repository 'x' not found")
        XCTAssertEqual(controlFailureText(DevhubFailure("boom")), "boom")
    }

    // MARK: every request line, as the TypeScript server reads it

    func testEveryRequestLineIsReadAsTheTypeScriptServerReadsIt() throws {
        let cases = try WP7Fixtures.json("control/control-requests.json").arrayValue!
        XCTAssertGreaterThan(cases.count, 70)
        for entry in cases {
            let line = entry["line"]!.stringValue!
            if let expected = entry["request"]?.stringValue {
                let request = try ControlRequest.parse(line)
                let want = try WireJSON.parse(expected)
                XCTAssertTrue(request.json.sameValue(as: want), "\(line)\n  \(request.json.compact)\n  \(expected)")
            } else {
                XCTAssertThrowsError(try ControlRequest.parse(line), line) { error in
                    let message = entry["error"]!.stringValue!
                    if message != "<json>" { XCTAssertEqual("\(error)", message, line) }
                }
            }
        }
    }

    func testAResponseReadsBackAsItWasWritten() throws {
        let typeScript =
            #"{"ok":true,"message":"x","devContainers":{"configs":[],"current":null},"buildLog":"/l","data":{"a":1}}"#
        let response = try ControlResponse.parse(typeScript)
        XCTAssertEqual(response.data, ["a": 1])
        XCTAssertEqual(response.other.map(\.key), ["devContainers", "buildLog"])
        XCTAssertTrue(response.json.sameValue(as: try WireJSON.parse(typeScript)))
    }
}

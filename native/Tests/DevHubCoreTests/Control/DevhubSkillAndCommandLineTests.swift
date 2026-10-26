// Port of apps/desktop/src/main/agent/devhubSkill.test.ts, and the
// `devhub` command run end to end (devhubCli.test.ts's cold start, and the
// rest of `main`) against a control server on a real socket.

import Foundation
import XCTest
@testable import DevHubCore

final class DevhubSkillTests: XCTestCase {
    let skill = DevhubSkill(userDataPath: "/Users/me/Library/Application Support/DevHub")

    func testLivesInDevHubsOwnDirectoryWhereClaudesAddDirFindsSkills() {
        XCTAssertEqual(skill.root, "/Users/me/Library/Application Support/DevHub/devhub/agent-skill")
        XCTAssertEqual(
            skill.skillFile, "/Users/me/Library/Application Support/DevHub/devhub/agent-skill/.claude/skills/devhub/SKILL.md")
        XCTAssertEqual(skill.cli, "/Users/me/Library/Application Support/DevHub/devhub/agent-skill/bin/devhub")
    }

    func testTheSkillTextIsTheTypeScriptTemplatesByteForByte() throws {
        XCTAssertEqual(DevhubSkill.text(cli: skill.cli), try WP7Fixtures.text("control/skill.md"))
        XCTAssertEqual(skill.codexInstructions, try WP7Fixtures.text("control/codex-instructions.txt"))
        let text = DevhubSkill.text(cli: skill.cli)
        XCTAssertTrue(text.hasPrefix("---\nname: devhub\ndescription: "))
        XCTAssertTrue(text.contains("\"\(skill.cli)\" --tell agents"))
        XCTAssertTrue(text.contains("右のターミナル"))
        XCTAssertFalse(text.contains("terminal resolve"))
    }

    func testAddsItselfToAClaudeProfilesArgumentsAfterThePersonsOwnOnce() {
        let skilled = DevhubSkill.arguments(kind: "claude", args: ["--model", "opus"], skill: skill)
        XCTAssertEqual(skilled, ["--model", "opus", "--add-dir=\(skill.root)"])
        XCTAssertEqual(DevhubSkill.arguments(kind: "claude", args: skilled, skill: skill).count, 3)
        XCTAssertEqual(DevhubSkill.arguments(kind: "codex", args: ["app-server"], skill: skill), ["app-server"])
        XCTAssertEqual(DevhubSkill.arguments(kind: "claude", args: [], skill: nil), [])
    }

    func testWritesTheSkillAndItsLauncherPrivately() throws {
        let scratch = try wp7SocketDirectory("skill")
        defer { wp7RemoveDirectory(scratch) }
        let written = DevhubSkill(userDataPath: scratch)
        try written.write(launcher: "#!/bin/sh\nexec devhub \"$@\"\n")
        XCTAssertEqual(try String(contentsOfFile: written.skillFile, encoding: .utf8), DevhubSkill.text(cli: written.cli))
        XCTAssertEqual(try wp7Permissions(written.skillFile), 0o600)
        XCTAssertEqual(try wp7Permissions(written.cli), 0o700)
        XCTAssertEqual(try wp7Permissions(written.root + "/bin"), 0o700)
        // Written again on every start, over the last one.
        try written.write(launcher: "#!/bin/sh\n")
        XCTAssertEqual(try String(contentsOfFile: written.cli, encoding: .utf8), "#!/bin/sh\n")
    }
}

/// A process's world, captured.
final class CapturedIO: DevhubIO, @unchecked Sendable {
    private let lock = NSLock()
    private var _out: [String] = []
    private var _err: [String] = []
    let environment: [String: String]
    let cwd: String
    let home = "/home/d"
    let temporaryDirectory: String
    let stdin: String?

    init(environment: [String: String], cwd: String = "/work/a", temporaryDirectory: String, stdin: String? = nil) {
        self.environment = environment
        self.cwd = cwd
        self.temporaryDirectory = temporaryDirectory
        self.stdin = stdin
    }

    var out: [String] { lock.withLock { _out } }
    var err: [String] { lock.withLock { _err } }
    func out(_ text: String) { lock.withLock { _out.append(text) } }
    func err(_ text: String) { lock.withLock { _err.append(text) } }
    var stdinIsTerminal: Bool { stdin == nil }
    func readStdin() -> String { stdin ?? "" }
    func spoolStdin(to path: String) throws {
        let fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        guard fd >= 0 else { throw UnixStream.Failure(operation: "open", code: errno, path: path) }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        handle.write(Data((stdin ?? "").utf8))
        try handle.close()
    }
}

/// Handlers that answer each request with what it asked, and delete a
/// `--wait` marker shortly after an open names one (the editor closing).
final class EchoHandlers: ControlHandlers, @unchecked Sendable {
    private let lock = NSLock()
    private var _requests: [String] = []
    var requests: [String] { lock.withLock { _requests } }
    func record(_ request: ControlRequest) { lock.withLock { _requests.append(request.json.compact) } }

    func personStarted() async {}
    func activate() async throws -> String {
        record(.activate)
        return "DevHub is in front."
    }
    func open(_ request: ControlOpenRequest) async throws -> String {
        record(.open(request))
        if let marker = request.waitMarkerPath {
            Task {
                try? await Task.sleep(for: .milliseconds(300))
                unlink(marker)
            }
        }
        return "Opened \(request.path)."
    }
    func waitEnded(_ waitMarkerPath: String) async throws -> String {
        record(.waitEnded(waitMarkerPath: waitMarkerPath))
        return "back"
    }
    func addAgent(profileId: String, args: [String], cwd: String) async throws -> String {
        record(.addAgent(profileId: profileId, args: args, cwd: cwd))
        throw DevhubFailure("there is no agent profile called '\(profileId)'. Configured profiles: claude.")
    }
    func version() async throws -> String { "DevHub 0.1.0 (native)" }
    func metrics() async throws -> String { "{}" }
    func tell(_ command: TellCommand, origin: String?, machine: String?) async throws -> TellAnswer {
        record(.tell(command, origin: origin, machine: machine))
        if case .notify = command { throw TellRefusal("this Mac does not show notifications.") }
        if case .commands = command { return TellAnswer(message: "x", data: .array([1])) }
        return TellAnswer(message: "2 agents", data: ["ok": false, "agents": ["a", "b"]])
    }
    func installCli() async throws -> String { "installed" }
    func resolveRemote(machine: String, attempt: Int) async throws -> RemoteResolution { .refused(message: "no", retry: false) }
    func terminalProfile(machine: String, root: String?, workspace: String?) async throws -> TerminalProfileAnswer {
        TerminalProfileAnswer(file: "tmux", args: [], env: [:])
    }
}

/// A launcher whose `open` brings a control server up after a moment: the
/// shape of every real cold start — connect, fail, launch, wait, ask.
struct LateServerLauncher: DevhubLauncher {
    let socketPath: String
    let handlers: EchoHandlers
    let started: StartedServer

    final class StartedServer: @unchecked Sendable {
        private let lock = NSLock()
        private var _server: ControlServer?
        var server: ControlServer? {
            get { lock.withLock { _server } }
            set { lock.withLock { _server = newValue } }
        }
    }

    var description: String { "the test's late DevHub" }
    func cannotStart(_ reason: String) -> String { "could not start: \(reason)" }
    func open() async throws -> Never {
        try await Task.sleep(for: .milliseconds(300))
        started.server = try await ControlServer.start(socketPath: socketPath, handlers: handlers)
        while true { try await Task.sleep(for: .seconds(3600)) }
    }
    func answers() async -> Bool { await ControlClient.socketAnswers(socketPath) }
    func pause(milliseconds: Int) async throws { try await Task.sleep(for: .milliseconds(milliseconds)) }
    func now() -> Double { Date().timeIntervalSince1970 * 1000 }
}

final class DevhubCommandLineTests: XCTestCase {
    var directory = ""
    var socketPath = ""
    var handlers = EchoHandlers()
    var server: ControlServer?

    override func setUp() async throws {
        directory = try wp7SocketDirectory("cli")
        socketPath = directory + "/c.sock"
        handlers = EchoHandlers()
    }

    override func tearDown() async throws {
        server?.close()
        wp7RemoveDirectory(directory)
    }

    func startServer() async throws {
        server = try await ControlServer.start(socketPath: socketPath, handlers: handlers)
    }

    func io(_ environment: [String: String] = [:], stdin: String? = nil) -> CapturedIO {
        var env = ["DEVHUB_CONTROL_SOCKET": socketPath, "DEVHUB_LAUNCH_COMMAND": #"["/bin/false"]"#]
        for (key, value) in environment { env[key] = value }
        return CapturedIO(environment: env, temporaryDirectory: directory, stdin: stdin)
    }

    func testPrintsUsageAndRefusesWithASentenceAndTheHint() async {
        let usage = CapturedIO(environment: [:], temporaryDirectory: directory)
        let printed = await DevhubCommandLine.run(["--help"], io: usage)
        XCTAssertEqual(printed, 0)
        XCTAssertEqual(usage.out, [devhubUsage])
        let bad = CapturedIO(environment: [:], temporaryDirectory: directory)
        let refused = await DevhubCommandLine.run(["--isntall-extension", "a.b"], io: bad)
        XCTAssertEqual(refused, 2)
        XCTAssertEqual(bad.err, ["devhub: devhub does not know the option '--isntall-extension'.\n\(devhubHint)"])
        let tellHelp = CapturedIO(environment: [:], temporaryDirectory: directory)
        let help = await DevhubCommandLine.run(["--tell", "help"], io: tellHelp)
        XCTAssertEqual(help, 0)
        XCTAssertEqual(tellHelp.out, [tellUsage])
    }

    func testRefusesExtensionsInTheNativeApp() async {
        let captured = CapturedIO(environment: [:], temporaryDirectory: directory)
        let status = await DevhubCommandLine.run(["--install-extension", "a.b"], io: captured)
        XCTAssertEqual(status, 2)
        XCTAssertEqual(captured.err, ["devhub: \(NativeUnavailable.extensions)\n\(devhubHint)"])
    }

    func testNeedsASocketToTalkToAndPrintsItsOwnVersionWithoutOne() async {
        let none = CapturedIO(environment: [:], temporaryDirectory: directory)
        let status = await DevhubCommandLine.run(["notes.md"], io: none)
        XCTAssertEqual(status, 1)
        XCTAssertTrue(none.err[0].hasPrefix("DEVHUB_CONTROL_SOCKET is not set."))
        let version = CapturedIO(environment: [:], temporaryDirectory: directory)
        let printed = await DevhubCommandLine.run(["--version"], io: version)
        XCTAssertEqual(printed, 0)
        XCTAssertEqual(version.out, [DevHubVersion.description])
    }

    func testRefusesALauncherThatDoesNotRecordHowToStartDevHub() async {
        let captured = CapturedIO(environment: ["DEVHUB_CONTROL_SOCKET": socketPath], temporaryDirectory: directory)
        let status = await DevhubCommandLine.run(["--version"], io: captured)
        XCTAssertEqual(status, 1)
        XCTAssertTrue(captured.err[0].hasPrefix("DEVHUB_LAUNCH_COMMAND is not set"))
    }

    func testOpensAFileAndPrintsTheAnswerCarryingThePanesOrigin() async throws {
        try await startServer()
        let captured = io(["DEVHUB_ORIGIN": "local\tw1\tnone"])
        let status = await DevhubCommandLine.run(["-g", "notes.md:3"], io: captured)
        XCTAssertEqual(status, 0)
        XCTAssertEqual(captured.out, ["Opened /work/a/notes.md."])
        XCTAssertEqual(handlers.requests, [
            #"{"kind":"open","path":"/work/a/notes.md","cwd":"/work/a","origin":"local\tw1\tnone","position":{"line":3,"column":1}}"#
        ])
    }

    func testReportsARefusalOnStderrWithAFailingStatus() async throws {
        try await startServer()
        let captured = io()
        let status = await DevhubCommandLine.run(["--agent", "gpt"], io: captured)
        XCTAssertEqual(status, 1)
        XCTAssertEqual(captured.out, [])
        XCTAssertEqual(captured.err, ["there is no agent profile called 'gpt'. Configured profiles: claude."])
    }

    func testPrintsATellsDataAsJSONWithOkFirst() async throws {
        try await startServer()
        let captured = io()
        let status = await DevhubCommandLine.run(["--tell", "--json", "agents"], io: captured)
        XCTAssertEqual(status, 0)
        // `{ ok: true, ...data }`: the data's own `ok` takes the first place's value.
        XCTAssertEqual(captured.out, ["{\n  \"ok\": false,\n  \"agents\": [\n    \"a\",\n    \"b\"\n  ]\n}"])
        let array = io()
        _ = await DevhubCommandLine.run(["--tell", "--json", "commands"], io: array)
        XCTAssertEqual(array.out, ["{\n  \"ok\": true,\n  \"data\": [\n    1\n  ]\n}"])
        let text = io()
        _ = await DevhubCommandLine.run(["--tell", "agents"], io: text)
        XCTAssertEqual(text.out, ["2 agents"])
        let refused = io()
        let failed = await DevhubCommandLine.run(["--tell", "--json", "notify", "hi"], io: refused)
        XCTAssertEqual(failed, 1)
        XCTAssertEqual(refused.out, [#"{"ok":false,"error":"this Mac does not show notifications."}"#])
        XCTAssertEqual(refused.err, ["this Mac does not show notifications."])
    }

    func testReadsTellTextFromStdinWhereDashStands() async throws {
        try await startServer()
        let terminal = io()
        let refused = await DevhubCommandLine.run(["--tell", "agent", "send", "a", "-"], io: terminal)
        XCTAssertEqual(refused, 2)
        XCTAssertEqual(terminal.err, ["devhub: '-' reads the text from what is piped in, and nothing is."])
        let piped = io(stdin: "long\nmessage\n")
        let status = await DevhubCommandLine.run(["--tell", "agent", "send", "a", "-"], io: piped)
        XCTAssertEqual(status, 0)
        XCTAssertEqual(handlers.requests.last, #"{"kind":"tell","command":{"verb":"agent-send","agent":"a","text":"long\nmessage"}}"#)
    }

    func testWaitsUntilTheEditorDeletesTheMarkerThenSaysTheWaitEnded() async throws {
        try await startServer()
        let captured = io()
        let started = Date()
        let status = await DevhubCommandLine.run(["--wait", "COMMIT_EDITMSG"], io: captured)
        XCTAssertEqual(status, 0)
        XCTAssertGreaterThan(Date().timeIntervalSince(started), 0.25)
        // Nothing on stdout: this is somebody's EDITOR.
        XCTAssertEqual(captured.out, [])
        let requests = handlers.requests
        XCTAssertEqual(requests.count, 2)
        let open = try WireJSON.parse(requests[0])
        let marker = try XCTUnwrap(open["waitMarkerPath"]?.stringValue)
        XCTAssertTrue(marker.hasPrefix(directory + "/devhub-wait-"))
        XCTAssertEqual(requests[1], ControlRequest.waitEnded(waitMarkerPath: marker).json.compact)
        // The marker's directory is gone again.
        XCTAssertFalse(FileManager.default.fileExists(atPath: (marker as NSString).deletingLastPathComponent))
    }

    func testAWaitThatOutlivesDevHubFails() async throws {
        try await startServer()
        let captured = io()
        let running = server
        let quitting = Task {
            try await Task.sleep(for: .milliseconds(150))
            running?.close()
        }
        // The fake deletes the marker after 300 ms; the server is gone at 150.
        let status = await DevhubCommandLine.run(["--wait", "f.txt"], io: captured)
        _ = await quitting.result
        XCTAssertEqual(status, 1)
        XCTAssertTrue(captured.err[0].hasPrefix("DevHub is not listening on \(socketPath)"), captured.err[0])
    }

    func testStartsDevHubWaitsForItAndThenOpensWhatWasPipedIn() async throws {
        let started = LateServerLauncher.StartedServer()
        let launcher = LateServerLauncher(socketPath: socketPath, handlers: handlers, started: started)
        let world = DevhubCommandLine.World(launcher: { _, _, _ in launcher })
        let captured = io(stdin: "hello from the pipe")
        let status = await DevhubCommandLine.run(["-"], io: captured, world: world)
        defer { started.server?.close() }
        XCTAssertEqual(status, 0, "\(captured.err)")
        let open = try WireJSON.parse(try XCTUnwrap(handlers.requests.first))
        XCTAssertEqual(open["kind"], "open")
        let path = try XCTUnwrap(open["path"]?.stringValue)
        XCTAssertTrue(path.hasPrefix(directory + "/devhub-stdin-"))
        // Read before the launch, so the pipe cannot be lost to a cold start.
        XCTAssertEqual(try String(contentsOfFile: path, encoding: .utf8), "hello from the pipe")
    }

    func testSaysWhenDevHubCannotBeStarted() async throws {
        let captured = io(["DEVHUB_LAUNCH_COMMAND": #"["/bin/sh","-c","exit 3"]"#])
        let status = await DevhubCommandLine.run(["notes.md"], io: captured)
        XCTAssertEqual(status, 1)
        XCTAssertEqual(
            captured.err,
            [
                "DevHub is not running, and it could not be started: /bin/sh exited with status 3\nThe 'devhub' launcher starts DevHub with /bin/sh -c exit 3. If DevHub has moved, run \"DevHub: Install 'devhub' command in PATH\" from DevHub's command palette again."
            ])
    }

    func testOnAHostThereIsNothingToStart() async throws {
        let captured = io(["DEVHUB_MACHINE": "ssh:box"])
        let status = await DevhubCommandLine.run(["notes.md"], io: captured)
        XCTAssertEqual(status, 1)
        XCTAssertTrue(captured.err[0].hasPrefix("DevHub is not listening on \(socketPath).\nDevHub runs on the machine"))
    }
}

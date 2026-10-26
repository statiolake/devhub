// Port of apps/desktop/test/terminal/tmux.real.test.ts: the tmux runtime
// against a real tmux server.
//
// Each case gets its own socket, its own home and its own `TMUX_TMPDIR`, and
// kills its server afterwards, so nothing here can touch the developer's own
// tmux. The whole class is skipped on a machine with no tmux in the places the
// TS suite looked (`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`).
//
// These are the tests that prove the property the whole runtime exists for: a
// session DevHub created is still there later, and a session it did not create
// is never touched.
//
// Left to the packages that own them: the GUI Agent host cases ("a GUI Agent's
// host in its tmux session", "a GUI Agent across a restart of DevHub") need
// the conversation host and `wireAgents`' GUI half, which are WP5's.

import Foundation
import XCTest
@testable import DevHubCore

/// The tmux these tests run, or nothing on a machine that has none.
let realTmux: String? = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"]
    .first { FileManager.default.isExecutableFile(atPath: $0) }

private let workspaceShell = ["/bin/zsh", "/bin/bash", "/bin/sh"].first { FileManager.default.isExecutableFile(atPath: $0) }!

/// This machine, wearing another machine's name.
///
/// Everything it does still happens here — the tmux is the real one on this
/// machine — but its `id` says `ssh:`, which is the one thing the adapter
/// branches on. That is exactly the seam under test: what DevHub does
/// *differently* on a machine that is not the one it runs on.
final class NamedMachine: MachineRuntime, @unchecked Sendable {
    let here: LocalRuntime
    let id: RuntimeId
    let `where`: String

    init(_ id: RuntimeId, where: String, environment: [String: String]) {
        self.here = LocalRuntime(environment: { environment })
        self.id = id
        self.where = `where`
    }

    func home() async throws -> String { try await here.home() }
    func environment() async throws -> [String: String] { try await here.environment() }
    func exec(_ request: ExecRequest) async throws -> ExecResult { try await here.exec(request) }
    func spawnPty(_ launch: PtyLaunch) throws -> any PseudoTerminal { try here.spawnPty(launch) }
    func spawnStream(_ request: StreamRequest) throws -> any ByteStream { try here.spawnStream(request) }
    func resolveProgram(_ configured: String, searchPath: String) async -> ProgramResolution { await here.resolveProgram(configured, searchPath: searchPath) }
    func tmuxProgram(_ configured: String, searchPath: String) async -> TmuxProgram { await here.tmuxProgram(configured, searchPath: searchPath) }
    func userTmuxConfig(_ localPath: String) async -> UserTmuxConfig { await here.userTmuxConfig(localPath) }
    func scratchDirectory() async throws -> String { try await here.scratchDirectory() }
    func stat(_ path: String) async throws -> FileKind { try await here.stat(path) }
    func readTextFile(_ path: String, maxBytes: Int) async throws -> String { try await here.readTextFile(path, maxBytes: maxBytes) }
    func writeTextFile(_ path: String, text: String, mode: Int) async throws { try await here.writeTextFile(path, text: text, mode: mode) }
    func writeNewTextFile(_ path: String, text: String, mode: Int) async throws -> Bool { try await here.writeNewTextFile(path, text: text, mode: mode) }
    func readdir(_ path: String) async throws -> [DirEntry] { try await here.readdir(path) }
    func removeTree(_ path: String) async throws { try await here.removeTree(path) }
    func makeDirectory(_ path: String) async throws { try await here.makeDirectory(path) }
    func realpath(_ path: String) async throws -> String { try await here.realpath(path) }
    func commandFromHere(_ command: MachineCommand) async throws -> MachineCommand { try await here.commandFromHere(command) }
    func forwardLoopbackPort(_ port: Int) async throws -> LoopbackForward { try await here.forwardLoopbackPort(port) }
    var cadence: RuntimeCadence { here.cadence }
    func resumed() { here.resumed() }
    func reading() -> RuntimeReading { here.reading() }
}

private nonisolated(unsafe) var realSequence = 0
private let realSequenceLock = NSLock()

private func nextSequence() -> Int {
    realSequenceLock.withLock {
        realSequence += 1
        return realSequence
    }
}

private func realpathOf(_ path: String) -> String {
    URL(fileURLWithPath: path).resolvingSymlinksInPath().path
}

/// One case's world: its home, its runtime, its socket and the directory tmux
/// puts that socket in.
final class RealFixture: @unchecked Sendable {
    let home: String
    let runtime: TmuxTerminalRuntime
    let socket: SocketName
    let cancel = CancellationToken()
    /// What every process this case starts is given: the run's environment
    /// with its own `TMUX_TMPDIR`, and no `TMUX` of the developer's.
    let environment: [String: String]
    private let runLog: String?

    init(home: String, runtime: TmuxTerminalRuntime, socket: SocketName, environment: [String: String], runLog: String?) {
        self.home = home
        self.runtime = runtime
        self.socket = socket
        self.environment = environment
        self.runLog = runLog
    }

    /// How many tmux processes this fixture's runtime has started so far.
    func tmuxRuns() -> Int {
        guard let runLog, let attributes = try? FileManager.default.attributesOfItem(atPath: runLog) else { return 0 }
        return (attributes[.size] as? NSNumber)?.intValue ?? 0
    }

    var deadline: OperationDeadline { OperationDeadline.within(runtime.timeoutMs) }

    func listSessions(_ on: SocketName? = nil) async throws -> [SessionInfo] {
        try await runtime.listSessions(on ?? socket, cancel: cancel, deadline: deadline)
    }

    func runTmux(_ args: [String]) async throws -> TmuxOutput {
        try await runtime.runTmux(socket, args, cancel: cancel, deadline: deadline)
    }

    func serverOption(_ option: String) async throws -> String {
        let output = try await runTmux(["show-options", "-gqv", option])
        return String(decoding: output.stdout, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// A tmux client started from outside the runtime under test.
    @discardableResult
    func outside(_ args: [String], configured: Bool = true) throws -> String {
        // Not Foundation's `Process`: a tmux client that starts a server
        // leaves that server holding what `Process` watches for its exit (see
        // `SpawnedChild`), and the wait would outlast the case.
        let child = try SpawnedChild.spawn(
            executable: realTmux!,
            args: ["-u"] + (configured ? ["-f", "/dev/null"] : []) + ["-L", socket.rawValue] + args,
            env: environment, cwd: home, pipeStdin: false
        )
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 65_536)
        while true {
            let count = buffer.withUnsafeMutableBytes { read(child.stdout, $0.baseAddress, $0.count) }
            if count < 0 && errno == EINTR { continue }
            if count <= 0 { break }
            data.append(contentsOf: buffer[0..<count])
        }
        close(child.stdout)
        close(child.stderr)
        let exited = DispatchSemaphore(value: 0)
        let status = ExitBox()
        child.whenExited { code, _ in
            status.code = code
            exited.signal()
        }
        exited.wait()
        if status.code != 0 {
            throw Said("tmux \(args.joined(separator: " ")) exited \(String(describing: status.code))")
        }
        return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// One variable of a session's environment, as tmux will hand it to a pane.
    func sessionEnvironment(_ session: String, _ name: String) -> String? {
        // `unknown variable` is tmux's answer to "this session sets no such
        // variable", and that is the answer being asked for.
        guard let output = try? outside(["show-environment", "-t", session, name]) else { return nil }
        return output.hasPrefix("\(name)=") ? String(output.dropFirst(name.count + 1)) : nil
    }

    func sessionOrigin(_ session: String) -> String? { sessionEnvironment(session, "DEVHUB_ORIGIN") }

    /// The id of a session's pane, as tmux names it (`%3`).
    func paneId(_ session: String) throws -> String {
        try outside(["display-message", "-p", "-t", session, "#{pane_id}"])
    }

    func paneTitle(_ session: String) throws -> String {
        try outside(["display-message", "-p", "-t", session, "#{pane_title}"], configured: false)
    }

    func windowSize(_ session: String) throws -> String {
        try outside(["display-message", "-p", "-t", session, "#{window-size}"], configured: false)
    }

    /// What the session itself says about its status bar — empty when it
    /// says nothing, which is how "DevHub declared nothing here" is spelled.
    func sessionStatus(_ session: String) throws -> String {
        try outside(["show-options", "-t", session, "-v", "status"], configured: false)
    }

    /// What the session ends up with, inherited values included.
    func effectiveStatus(_ session: String) throws -> String {
        try outside(["show-options", "-t", session, "-A", "-v", "status"], configured: false)
    }

    func sessionNames() throws -> [String] {
        try outside(["list-sessions", "-F", "#{session_name}"], configured: false)
            .split(separator: "\n").map(String.init)
    }

    func workspaceSession(_ root: String) -> String {
        "ws-\(TmuxMarkers.workspaceDigest(root: root).prefix(20))"
    }

    func sessions(_ machine: RuntimeId = .local) -> AgentSessions {
        let runtime = self.runtime
        return AgentSessions(runtimeFor: { asked in
            // These suites run against one real tmux on this machine, so the
            // per-machine lookup has one entry. It is asserted rather than
            // ignored: a test that asked about another machine and got this
            // one's tmux would be a green test about nothing.
            guard asked == machine else { throw Said("asked about \(asked.rawValue), not \(machine.rawValue)") }
            return runtime
        })
    }

    /// Stop the server and take the socket file with it: tmux never unlinks
    /// one, so this is the only thing that removes it.
    func killServer() {
        _ = try? outside(["kill-server"], configured: false)
        if let directory = socketDirectory {
            try? FileManager.default.removeItem(atPath: Path.join(directory, socket.rawValue))
        }
    }

    var socketDirectory: String? {
        guard let root = environment["TMUX_TMPDIR"] else { return nil }
        return Path.join(root, "tmux-\(getuid())")
    }
}

final class ExitBox: @unchecked Sendable {
    var code: Int32?
}

/// What a pane wrote, once it has written it. The pane writes beside the file
/// and renames it into place (`published`), so the file exists only once it is
/// whole.
private func paneWrote(_ path: String, file: StaticString = #filePath, line: UInt = #line) async throws -> String {
    for _ in 0..<100 {
        if let data = FileManager.default.contents(atPath: path) { return String(decoding: data, as: UTF8.self) }
        try await Task.sleep(nanoseconds: 50_000_000)
    }
    throw Said("the pane never wrote \(path)")
}

/// A pane's shell writing `value` to `path` whole, for `paneWrote` to read.
private func published(_ value: String, _ path: String) -> String {
    "printf '%s' \(value) > \"\(path).part\" && mv \"\(path).part\" \"\(path)\""
}

private func poll(_ timeoutSeconds: Double = 5, _ condition: () async throws -> Bool) async throws -> Bool {
    let deadline = Date().addingTimeInterval(timeoutSeconds)
    while Date() < deadline {
        if try await condition() { return true }
        try await Task.sleep(nanoseconds: 50_000_000)
    }
    return try await condition()
}

private let sleeper = AgentSessionCommand(file: "/bin/sh", args: ["-c", "sleep 30"], env: [:])

class RealTmuxCase: XCTestCase {
    var fixtures: [RealFixture] = []
    var socketRoots: [String] = []
    var homes: [String] = []

    override func setUpWithError() throws {
        try XCTSkipIf(realTmux == nil, "no tmux on this machine")
    }

    /// A run's own socket directory, under `/tmp` where a socket's path is
    /// short enough, and never tmux's shared one there.
    func makeSocketRoot(_ label: String) -> String {
        let path = "/tmp/dh\(label.prefix(8))\(getpid())-\(nextSequence())"
        try! FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        socketRoots.append(path)
        return realpathOf(path)
    }

    func fixture(
        _ label: String,
        environment extra: [String: String] = [:],
        counting: Bool = false,
        host: RuntimeId? = nil,
        paneBinDirectory: String? = nil,
        home existing: String? = nil
    ) throws -> RealFixture {
        let sequence = nextSequence()
        let home: String
        if let existing {
            home = existing
        } else {
            let made = Path.join(NSTemporaryDirectory(), "dh-tmux-\(label)-\(UUID().uuidString.prefix(8))")
            try FileManager.default.createDirectory(atPath: made, withIntermediateDirectories: true)
            home = realpathOf(made)
            homes.append(home)
        }
        let socket = try SocketName("dh\(label)\(getpid())\(sequence)")
        var environment = ProcessInfo.processInfo.environment
        environment.removeValue(forKey: "TMUX")
        environment.removeValue(forKey: "TMUX_PANE")
        environment["TMUX_TMPDIR"] = makeSocketRoot(label)
        for (key, value) in extra { environment[key] = value }

        var tmuxPath = realTmux!
        var runLog: String?
        if counting {
            // What an operation costs is not how long one command takes but
            // how many processes it starts; this shim is how a test counts.
            let log = Path.join(home, "tmux-runs")
            let shim = Path.join(home, "counting-tmux")
            try "#!/bin/sh\nprintf 'x' >> '\(log)'\nexec '\(realTmux!)' \"$@\"\n".write(toFile: shim, atomically: true, encoding: .utf8)
            chmod(shim, 0o755)
            tmuxPath = shim
            runLog = log
        }
        let frozen = environment
        let machine: (any MachineRuntime)? = host.map { id in
            NamedMachine(id, where: " on build.example.com", environment: frozen)
        }
        let runtime = TmuxTerminalRuntime(TmuxTerminalRuntimeOptions(
            context: RuntimeLaunchContext(home: home, environment: frozen),
            tmux: .resolved(ResolvedExecutable(path: tmuxPath, basename: "tmux")),
            shell: ResolvedExecutable(path: workspaceShell, basename: (workspaceShell as NSString).lastPathComponent),
            tmuxArgs: [],
            effectiveSocketName: socket.rawValue,
            paneBinDirectory: paneBinDirectory,
            timeoutMs: 10_000,
            // Scratch stays inside the case's home, never in the OS temp
            // directory's shared space.
            bootstrapDirectory: home,
            // The one user tmux config, where DevHub's config directory would
            // put it. A path and never a search: "there is no such file" is the
            // ordinary case rather than a failure.
            userTmuxConfigSource: Path.join(home, "config", "tmux.conf"),
            host: machine ?? LocalRuntime(environment: { frozen }),
            log: { _ in }
        ))
        let created = RealFixture(home: home, runtime: runtime, socket: socket, environment: frozen, runLog: runLog)
        fixtures.append(created)
        return created
    }

    func userConfig(_ test: RealFixture, _ text: String) throws {
        try FileManager.default.createDirectory(atPath: Path.join(test.home, "config"), withIntermediateDirectories: true)
        try text.write(toFile: Path.join(test.home, "config", "tmux.conf"), atomically: true, encoding: .utf8)
    }

    func directory(_ test: RealFixture, _ name: String) throws -> String {
        let path = Path.join(test.home, name)
        try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        return realpathOf(path)
    }

    /// Every server this case started is stopped, and the socket file is gone.
    override func tearDown() {
        var started: [(String?, String)] = []
        while let current = fixtures.popLast() {
            current.killServer()
            started.append((current.socketDirectory, current.socket.rawValue))
        }
        for (directory, socket) in started {
            guard let directory else { continue }
            XCTAssertFalse(FileManager.default.fileExists(atPath: Path.join(directory, socket)), "socket \(socket) left in \(directory)")
        }
        for path in homes { try? FileManager.default.removeItem(atPath: path) }
        for path in socketRoots {
            chmod(path, 0o700)
            try? FileManager.default.removeItem(atPath: path)
        }
        homes = []
        socketRoots = []
        super.tearDown()
    }
}

final class TmuxRealTests: RealTmuxCase {
    /// The isolation itself, asserted once rather than assumed everywhere.
    func testPutsItsSocketsInTheRunsOwnDirectoryNotTheSharedOne() async throws {
        let test = try fixture("isolated")
        _ = try await test.runtime.ensure(.localScratch)
        let shared = "/tmp/tmux-\(getuid())"
        XCTAssertNotEqual(test.socketDirectory, shared)
        XCTAssertTrue(FileManager.default.fileExists(atPath: Path.join(test.socketDirectory!, test.socket.rawValue)))
        XCTAssertFalse(FileManager.default.fileExists(atPath: Path.join(shared, test.socket.rawValue)))
    }

    func testAdoptsAnAbsentSocketByCreatingExactlyOneMarkedScratch() async throws {
        let test = try fixture("absent")
        try userConfig(test, "set-option -g @devhub-test-user-config home\n")

        let _v1 = try await test.runtime.preflight(test.socket).state
        XCTAssertEqual(_v1, .targetAbsent)
        _ = try await test.runtime.ensure(.localScratch)

        let preflight = try await test.runtime.preflight(test.socket)
        XCTAssertEqual(preflight.state, .markedSessions)
        XCTAssertEqual(preflight.ownedSessionCount, 1)
        XCTAssertEqual(preflight.unknownSessionCount, 0)

        let sessions = try await test.listSessions()
        XCTAssertEqual(sessions.count, 1)
        XCTAssertEqual(sessions[0].name, TmuxMarkers.scratchSession)
        XCTAssertEqual(sessions[0].context, "global")
        XCTAssertTrue(TmuxMarkers.isMarked(sessions[0].marking, expectedGlobalRoot: test.home))

        // The viewer's own tmux config is sourced by the bootstrap, so their
        // key bindings and options are the ones they already have.
        let userConfig = try await test.runTmux(["show-options", "-gqv", "@devhub-test-user-config"])
        XCTAssertEqual(String(decoding: userConfig.stdout, as: UTF8.self), "home\n")
    }

    // MARK: the config the running server is running

    func testAppliesAConfigThatWasWrittenAfterTheServerStarted() async throws {
        let test = try fixture("configlate")
        _ = try await test.runtime.ensure(.localScratch)
        let _v2 = try await test.serverOption("@devhub-test-user-config")
        XCTAssertEqual(_v2, "")

        try userConfig(test, "set-option -g @devhub-test-user-config late\n")
        _ = try await test.runtime.ensure(.localScratch)

        let _v3 = try await test.serverOption("@devhub-test-user-config")
        XCTAssertEqual(_v3, "late")
    }

    func testReAppliesTheConfigWhenItChangesUnderTheRunningServer() async throws {
        let test = try fixture("configedit")
        try userConfig(test, "set-option -g @devhub-test-user-config first\n")
        _ = try await test.runtime.ensure(.localScratch)
        let _v4 = try await test.serverOption("@devhub-test-user-config")
        XCTAssertEqual(_v4, "first")

        try userConfig(test, "set-option -g @devhub-test-user-config second\n")
        _ = try await test.runtime.ensure(.localScratch)

        let _v5 = try await test.serverOption("@devhub-test-user-config")
        XCTAssertEqual(_v5, "second")
    }

    /// The digest is what makes that not a `source-file` per attach.
    func testLeavesAnUnchangedConfigAloneRatherThanSourcingItAgain() async throws {
        let test = try fixture("configsame")
        try userConfig(test, "set-option -g @devhub-test-user-config once\n")
        _ = try await test.runtime.ensure(.localScratch)
        _ = try await test.runTmux(["set-option", "-g", "@devhub-test-user-config", "touched"])

        _ = try await test.runtime.ensure(.localScratch)

        let _v6 = try await test.serverOption("@devhub-test-user-config")
        XCTAssertEqual(_v6, "touched")
    }

    /// tmux runs *none* of a file it cannot parse, so the failure has to be
    /// visible — and it stays refused on the next attach.
    func testRefusesAndSaysSoWhenTheConfigDoesNotParse() async throws {
        let test = try fixture("configbroken")
        try userConfig(test, "set-option -g @devhub-test-user-config good\nnot-a-tmux-command\n")

        for _ in 0..<2 {
            do {
                _ = try await test.runtime.ensure(.localScratch)
                XCTFail("a config that does not parse was accepted")
            } catch {
                XCTAssertTrue("\(error)".contains("not-a-tmux-command"), "\(error)")
            }
        }
    }

    func testDeclaresRGBOnTheServerItCreatesSoColourIsNotQuantised() async throws {
        let test = try fixture("truecolor")
        _ = try await test.runtime.ensure(.localScratch)
        let features = try await test.runTmux(["show-options", "-gqv", "terminal-features"])
        XCTAssertTrue(String(decoding: features.stdout, as: UTF8.self).contains("*:RGB"))
    }

    func testLeavesNoneOfItsOwnBootstrapVariablesInTheServersEnvironment() async throws {
        let test = try fixture("bootenv")
        _ = try await test.runtime.ensure(.localScratch)
        let environment = String(decoding: try await test.runTmux(["show-environment", "-g"]).stdout, as: UTF8.self)
        XCTAssertFalse(environment.contains("DEVHUB_BOOTSTRAP_ROOT"))
        XCTAssertFalse(environment.contains("DEVHUB_USER_TMUX_CONFIG"))
    }

    func testCountsAForeignSessionNeverNamesItAndNeverKillsIt() async throws {
        let test = try fixture("foreign-count")
        _ = try await test.runtime.ensure(.localScratch)
        _ = try await test.runTmux(["new-session", "-d", "-s", "foreign", "-c", test.home])

        let preflight = try await test.runtime.preflight(test.socket)
        XCTAssertEqual(preflight.state, .markedSessions)
        XCTAssertEqual(preflight.ownedSessionCount, 1)
        XCTAssertEqual(preflight.unknownSessionCount, 1)

        let inventory = try await test.runtime.inspectOwnedSessions(test.socket)
        XCTAssertEqual(inventory.sessions, [.scratch(sessionName: TmuxMarkers.scratchSession)])
        XCTAssertEqual(inventory.unknownSessionCount, 1)

        try await test.runtime.closeOwnedSession(test.socket, .scratch(sessionName: TmuxMarkers.scratchSession))
        // The unknown session is somebody else's work.
        let _v7 = try await test.listSessions().map(\.name)
        XCTAssertEqual(_v7, ["foreign"])

        // Releasing an already released record is complete, not an error.
        try await test.runtime.closeOwnedSession(test.socket, .scratch(sessionName: TmuxMarkers.scratchSession))
    }

    func testRecreatesAScratchThatDisappearedFromAServerItOwns() async throws {
        let test = try fixture("recreate")
        _ = try await test.runtime.ensure(.localScratch)
        // Scratch must not be the server's last session: tmux ends a server
        // whose last session goes.
        try test.outside(["new-session", "-d", "-s", "keeps-it-up"])
        _ = try await test.runTmux(["kill-session", "-t", TmuxMarkers.scratchSession])
        // A marker alone is not ownership: the exact session has to be there.
        _ = try await test.runtime.ensure(.localScratch)
        let _v8 = try await test.listSessions().contains { TmuxMarkers.isMarked($0.marking, expectedGlobalRoot: test.home) }
        XCTAssertTrue(_v8)
    }

    func testCreatesAndClosesAWorkspaceSessionByItsOwnDigestName() async throws {
        let test = try fixture("workspace")
        let root = try directory(test, "workspace")
        let workspaceId = "00000000-0000-4000-8000-000000000042"
        let target = TerminalTarget.workspace(machine: .local, workspaceId: workspaceId, root: root)
        _ = try await test.runtime.ensure(target)

        let sessions = try await test.listSessions()
        XCTAssertEqual(sessions.count, 2)
        let session = sessions.first { $0.name == test.workspaceSession(root) }
        XCTAssertEqual(session?.context, "workspace")
        XCTAssertEqual(session?.workspaceId, workspaceId)
        XCTAssertEqual(session?.root, root)

        // Asking again is idempotent: the same workspace is the same session.
        _ = try await test.runtime.ensure(target)
        let _v9 = try await test.listSessions().count
        XCTAssertEqual(_v9, 2)

        try await test.runtime.closeWorkspace(WorkspaceTerminalTarget(machine: .local, workspaceId: workspaceId, root: root))
        let _v10 = try await test.listSessions().map(\.name)
        XCTAssertEqual(_v10, [TmuxMarkers.scratchSession])
    }

    /// Closing a workspace on purpose ends its work, all of it — and only its.
    func testTakesAWorkspacesAgentsWithItWhenTheWorkspaceIsClosed() async throws {
        let test = try fixture("closeagents")
        let root = try directory(test, "workspace")
        let workspaceId = "00000000-0000-4000-8000-000000000044"
        let agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9"
        let otherRoot = try directory(test, "other")
        let otherId = "00000000-0000-4000-8000-000000000045"

        let sessions = test.sessions()
        _ = try await test.runtime.ensure(.localScratch)
        _ = try await test.runtime.ensure(.workspace(machine: .local, workspaceId: workspaceId, root: root))
        _ = try await test.runtime.ensure(.workspace(machine: .local, workspaceId: otherId, root: otherRoot))
        try await sessions.launch(AgentLaunchSpec(
            target: AgentTerminalTarget(machine: .local, agentId: agentId, workspaceId: workspaceId, root: root),
            command: sleeper
        ))
        let _v11 = try await test.listSessions().count
        XCTAssertEqual(_v11, 4)

        // What an explicit close does, in the order the app does it: the
        // Agents first, then the workspace's own terminal.
        try await sessions.terminate(.local, agentId: agentId)
        try await test.runtime.closeWorkspace(WorkspaceTerminalTarget(machine: .local, workspaceId: workspaceId, root: root))

        let _v12 = try await test.listSessions().map(\.name).sorted()
        XCTAssertEqual(_v12, [TmuxMarkers.scratchSession, test.workspaceSession(otherRoot)].sorted())
        let _v13 = try await sessions.list(.local)
        XCTAssertEqual(_v13, [])
    }

    /// What a close ends, a quit keeps: a second runtime on the same socket
    /// finds everything, including which Agent belongs to which workspace.
    func testLeavesItsSessionsOnTheSocketForTheNextLaunchToAdopt() async throws {
        let test = try fixture("quitkeeps")
        let root = try directory(test, "workspace")
        let workspaceId = "00000000-0000-4000-8000-000000000046"
        let agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab0"
        _ = try await test.runtime.ensure(.localScratch)
        _ = try await test.runtime.ensure(.workspace(machine: .local, workspaceId: workspaceId, root: root))
        try await test.sessions().launch(AgentLaunchSpec(
            target: AgentTerminalTarget(machine: .local, agentId: agentId, workspaceId: workspaceId, root: root),
            command: sleeper
        ))

        // A fresh runtime on the same socket is what the next launch is.
        let adopted = TmuxTerminalRuntime(TmuxTerminalRuntimeOptions(
            context: RuntimeLaunchContext(home: test.home, environment: test.environment),
            tmux: .resolved(ResolvedExecutable(path: realTmux!, basename: "tmux")),
            shell: ResolvedExecutable(path: workspaceShell, basename: "sh"),
            effectiveSocketName: test.socket.rawValue,
            timeoutMs: 10_000,
            bootstrapDirectory: test.home,
            host: LocalRuntime(environment: { [environment = test.environment] in environment }),
            log: { _ in }
        ))
        let after = try await adopted.listSessions(test.socket, cancel: test.cancel, deadline: test.deadline)
        XCTAssertEqual(
            after.map(\.name).sorted(),
            [TmuxMarkers.scratchSession, TmuxNames.agentSession(agentId: agentId), test.workspaceSession(root)].sorted()
        )
        let listed = try await AgentSessions(runtimeFor: { _ in adopted }).list(.local)
        XCTAssertEqual(listed.map(\.agentId), [agentId])
        XCTAssertEqual(listed.map(\.workspaceId), [workspaceId])
        // The activity marker is tmux's clock, so it is asserted by shape.
        XCTAssertNotNil(listed.first?.activity.flatMap { $0.allSatisfy(\.isNumber) && !$0.isEmpty ? $0 : nil })
    }

    func testReportsWhatAWorkspaceTerminalWouldDestroy() async throws {
        let test = try fixture("inspect")
        let root = try directory(test, "workspace")
        let target = TerminalTarget.workspace(machine: .local, workspaceId: "00000000-0000-4000-8000-000000000043", root: root)
        _ = try await test.runtime.ensure(target)
        // A session that is only a shell is clean; nothing would be lost.
        let inspection = try await test.runtime.inspect(target)
        XCTAssertEqual(inspection.extraPanes, .clean)
        XCTAssertEqual(inspection.extraWindows, .clean)
    }

    func testCostsTheSameNumberOfTmuxProcessesWhateverTheSessionCount() async throws {
        let test = try fixture("processes", counting: true)
        var targets: [TerminalTarget] = []
        for index in 0..<8 {
            let root = try directory(test, "workspace-\(index)")
            targets.append(.workspace(machine: .local, workspaceId: "00000000-0000-4000-8000-00000000005\(index)", root: root))
        }
        _ = try await test.runtime.ensure(.localScratch)
        for target in targets { _ = try await test.runtime.ensure(target) }

        // Attaching to one that is already there takes a fixed five commands
        // whatever the count is; the fifth reads which config the server runs.
        let attachStart = test.tmuxRuns()
        _ = try await test.runtime.ensure(targets[0])
        XCTAssertEqual(test.tmuxRuns() - attachStart, 5)

        // An inspection reads the inventory and then both of its listings,
        // the windows and the panes sharing one command.
        let inspectStart = test.tmuxRuns()
        let inspection = try await test.runtime.inspect(targets[0])
        XCTAssertEqual(inspection.extraPanes, .clean)
        XCTAssertEqual(test.tmuxRuns() - inspectStart, 2)

        // And a reconcile round is one client.
        let listStart = test.tmuxRuns()
        _ = try await test.runtime.listAgents()
        XCTAssertEqual(test.tmuxRuns() - listStart, 1)
    }

    func testReadsThreeAgentsAndOneOfTheirScreensInOneProcess() async throws {
        let test = try fixture("roundcost", counting: true)
        let sessions = test.sessions()
        let agentIds = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa61", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa62", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa63"]
        let workspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb61"
        _ = try await test.runtime.ensure(.localScratch)
        for agentId in agentIds {
            try await sessions.launch(AgentLaunchSpec(
                target: AgentTerminalTarget(machine: .local, agentId: agentId, workspaceId: workspaceId, root: test.home),
                command: sleeper
            ))
        }

        let roundStart = test.tmuxRuns()
        let round = try await sessions.round(.local, captureIds: [agentIds[1]])
        XCTAssertEqual(test.tmuxRuns() - roundStart, 1)
        XCTAssertEqual(round.live.map(\.agentId).sorted(), agentIds.sorted())
        XCTAssertEqual(Array(round.screens.keys), [agentIds[1]])

        // And a round that needs no screen is still exactly one.
        let idleStart = test.tmuxRuns()
        let _v14 = try await sessions.round(.local, captureIds: []).screens.count
        XCTAssertEqual(_v14, 0)
        XCTAssertEqual(test.tmuxRuns() - idleStart, 1)
    }

    func testReadsTheAgentsBehindOneWhoseSessionWasKilledFromOutside() async throws {
        let test = try fixture("deadsession", counting: true)
        let sessions = test.sessions()
        let agentIds = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa71", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa72", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa73"]
        let workspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb71"
        _ = try await test.runtime.ensure(.localScratch)
        for agentId in agentIds {
            try await sessions.launch(AgentLaunchSpec(
                target: AgentTerminalTarget(machine: .local, agentId: agentId, workspaceId: workspaceId, root: test.home),
                command: sleeper
            ))
        }
        // An Agent DevHub still knows about whose session is gone, asked about
        // in the middle of the batch.
        try test.outside(["kill-session", "-t", TmuxNames.agentSession(agentId: agentIds[1])])

        let roundStart = test.tmuxRuns()
        let round = try await sessions.round(.local, captureIds: agentIds)
        XCTAssertEqual(test.tmuxRuns() - roundStart, 1)
        XCTAssertEqual(round.live.map(\.agentId).sorted(), [agentIds[0], agentIds[2]].sorted())
        // And the Agents on either side of it were both read.
        XCTAssertEqual(round.screens.keys.sorted(), [agentIds[0], agentIds[2]].sorted())
        XCTAssertNil(round.screens[agentIds[1]])
    }

    func testKeepsARootThatContainsANewlineWholeInTheInventory() async throws {
        let test = try fixture("newline-root")
        let root = try directory(test, "two\nlines")
        let target = TerminalTarget.workspace(machine: .local, workspaceId: "00000000-0000-4000-8000-000000000044", root: root)
        _ = try await test.runtime.ensure(target)

        let created = try await test.listSessions().first { $0.root == root }
        XCTAssertNotNil(created)
        XCTAssertEqual(created?.context, "workspace")
        // And the identity it read back is the one an attach accepts.
        _ = try await test.runtime.ensure(target)
    }

    /// The fact a pane needs in order for `devhub <file>` to mean "here",
    /// read out of a real tmux rather than out of the argv DevHub composed.
    func testGivesEverySessionItCreatesItsOwnDevhubOrigin() async throws {
        let test = try fixture("origin")
        let workspaceId = "00000000-0000-4000-8000-0000000000a1"
        let root = test.home
        _ = try await test.runtime.ensure(.workspace(machine: .local, workspaceId: workspaceId, root: root))

        XCTAssertEqual(test.sessionOrigin(TmuxMarkers.scratchSession), "local\tscratch\tnone")
        XCTAssertEqual(test.sessionOrigin(test.workspaceSession(root)), "local\t\(workspaceId)\tnone")
    }

    func testGivesAnAgentsSessionItsWorkspacesWindowAndItsOwnId() async throws {
        let test = try fixture("origin-agent")
        let workspaceId = "00000000-0000-4000-8000-0000000000a2"
        let agentId = "00000000-0000-4000-8000-0000000000b2"
        _ = try await test.runtime.ensure(.localScratch)
        try await test.runtime.launchAgent(AgentTerminalTarget(machine: .local, agentId: agentId, workspaceId: workspaceId, root: test.home), command: sleeper)

        XCTAssertEqual(test.sessionOrigin(TmuxNames.agentSession(agentId: agentId)), "local\t\(workspaceId)\t\(agentId)")
    }

    func testNamesThePidOfAnAgentsCommandAndOnlyForThatAgent() async throws {
        let test = try fixture("agent-pane-pid")
        let workspaceId = "00000000-0000-4000-8000-0000000000a4"
        let agentId = "00000000-0000-4000-8000-0000000000b4"
        let pidFile = Path.join(test.home, "pid")
        _ = try await test.runtime.ensure(.localScratch)
        try await test.runtime.launchAgent(
            AgentTerminalTarget(machine: .local, agentId: agentId, workspaceId: workspaceId, root: test.home),
            command: AgentSessionCommand(file: "/bin/sh", args: ["-c", "echo $$ >'\(pidFile)'; exec sleep 30"], env: [:])
        )
        let record = OwnedSessionRecord.agent(agentId: agentId, workspaceId: workspaceId, sessionName: TmuxNames.agentSession(agentId: agentId))
        let pid = try await test.runtime.agentPanePid(record)
        let wrote = try await poll {
            (try? String(contentsOfFile: pidFile, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) == String(pid)
        }
        XCTAssertTrue(wrote)
        _ = await assertThrowsPortAsync(.conflict) {
            _ = try await test.runtime.agentPanePid(.agent(agentId: "00000000-0000-4000-8000-0000000000b5", workspaceId: workspaceId, sessionName: TmuxNames.agentSession(agentId: agentId)))
        }
    }

    /// Restart Session for a terminal Agent: the pane's process is replaced by
    /// the command given, in the same session and pane, with the profile's
    /// variables — and only for the session that is this Agent's.
    func testRespawnsAnAgentsCommandInItsOwnPaneKeepingTheSession() async throws {
        let test = try fixture("agent-respawn")
        let workspaceId = "00000000-0000-4000-8000-0000000000a6"
        let agentId = "00000000-0000-4000-8000-0000000000b6"
        let pidFile = Path.join(test.home, "pid")
        let target = AgentTerminalTarget(machine: .local, agentId: agentId, workspaceId: workspaceId, root: test.home)
        _ = try await test.runtime.ensure(.localScratch)
        try await test.runtime.launchAgent(target, command: AgentSessionCommand(file: "/bin/sh", args: ["-c", "exec sleep 30"], env: [:]))
        let record = OwnedSessionRecord.agent(agentId: agentId, workspaceId: workspaceId, sessionName: TmuxNames.agentSession(agentId: agentId))
        let before = try await test.runtime.agentPanePid(record)
        let paneBefore = try test.paneId(record.sessionName)

        try await test.runtime.respawnAgent(target, command: AgentSessionCommand(
            file: "/bin/sh",
            args: ["-c", "echo \"$$ $AGENT_OWN_VARIABLE\" >'\(pidFile)'; exec sleep 30"],
            env: ["AGENT_OWN_VARIABLE": "again"]
        ))

        let after = try await test.runtime.agentPanePid(record)
        XCTAssertNotEqual(after, before)
        let wrote = try await poll {
            (try? String(contentsOfFile: pidFile, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) == "\(after) again"
        }
        XCTAssertTrue(wrote)
        XCTAssertEqual(try test.paneId(record.sessionName), paneBefore)
        let listed = try await test.runtime.listAgents().filter {
            if case .agent(let id, _, _) = $0.record { return id == agentId }
            return false
        }
        XCTAssertEqual(listed.count, 1)
        var other = target
        other.workspaceId = "00000000-0000-4000-8000-0000000000a7"
        _ = await assertThrowsPortAsync(.conflict) {
            try await test.runtime.respawnAgent(other, command: AgentSessionCommand(file: "/bin/sh", args: ["-c", "exec sleep 30"], env: [:]))
        }
        let _v15 = try await test.runtime.agentPanePid(record)
        XCTAssertEqual(_v15, after)
    }

    /// An Agent profile's own variables sit beside the origin, never over it.
    func testDoesNotLetAnAgentProfilesEnvironmentTakeTheOriginsName() async throws {
        let test = try fixture("origin-agent-env")
        let workspaceId = "00000000-0000-4000-8000-0000000000a3"
        let agentId = "00000000-0000-4000-8000-0000000000b3"
        _ = try await test.runtime.ensure(.localScratch)
        try await test.runtime.launchAgent(
            AgentTerminalTarget(machine: .local, agentId: agentId, workspaceId: workspaceId, root: test.home),
            command: AgentSessionCommand(file: "/bin/sh", args: ["-c", "sleep 30"], env: ["AGENT_OWN_VARIABLE": "yes"])
        )
        let session = TmuxNames.agentSession(agentId: agentId)
        XCTAssertEqual(test.sessionOrigin(session), "local\t\(workspaceId)\t\(agentId)")
        XCTAssertEqual(test.sessionEnvironment(session, "AGENT_OWN_VARIABLE"), "yes")
    }

    /// The machine is half of the origin.
    func testNamesTheMachineTheSessionIsOnNotTheMachineDevHubIsOn() async throws {
        let test = try fixture("origin-remote", host: .ssh("build.example.com"))
        _ = try await test.runtime.ensure(.scratch(machine: .ssh("build.example.com")))
        XCTAssertEqual(test.sessionOrigin(TmuxMarkers.scratchSession), "ssh:build.example.com\tscratch\tnone")
    }

    /// Read out of a **pane**: what the process in the pane actually got.
    func testPutsDevHubsOwnBinDirectoryInFrontOfAPanesPathOnAMachineThatIsNotThisOne() async throws {
        let remote = RuntimeId.ssh("build.example.com")
        let test = try fixture("pane-path", host: remote, paneBinDirectory: "/home/dev/.devhub/terminal/bin-abcdef")
        let written = Path.join(test.home, "pane-path")
        _ = try await test.runtime.ensure(.scratch(machine: remote))
        try await test.runtime.launchAgent(
            AgentTerminalTarget(machine: remote, agentId: "00000000-0000-4000-8000-0000000000c1", workspaceId: "00000000-0000-4000-8000-0000000000a4", root: test.home),
            command: AgentSessionCommand(file: "/bin/sh", args: ["-c", "\(published("\"$PATH\"", written)); sleep 30"], env: [:])
        )
        let path = try await paneWrote(written)
        XCTAssertTrue(path.hasPrefix("/home/dev/.devhub/terminal/bin-abcdef:"), path)
        // In *front* of, and not instead of.
        XCTAssertTrue(path.contains(test.environment["PATH"]!), path)
    }

    /// On this machine `devhub` is whatever the person installed on their
    /// own PATH, and DevHub does not get to put a second one in front of it.
    func testLeavesThisMachinesPanesPathExactlyAsTheServers() async throws {
        let test = try fixture("pane-path-local")
        let written = Path.join(test.home, "pane-path")
        _ = try await test.runtime.ensure(.localScratch)
        try await test.runtime.launchAgent(
            AgentTerminalTarget(machine: .local, agentId: "00000000-0000-4000-8000-0000000000c2", workspaceId: "00000000-0000-4000-8000-0000000000a5", root: test.home),
            command: AgentSessionCommand(file: "/bin/sh", args: ["-c", "\(published("\"$PATH\"", written)); sleep 30"], env: [:])
        )
        let _v16 = try await paneWrote(written)
        XCTAssertEqual(_v16, test.environment["PATH"])
        // And the session states no PATH of its own.
        XCTAssertNil(test.sessionEnvironment(TmuxMarkers.scratchSession, "PATH"))
    }

    func testRefusesAServerWhoseMarkerIsNotDevHubsAndLeavesItAlone() async throws {
        let test = try fixture("wrong-marker")
        try test.outside(["new-session", "-d", "-s", "foreign", "-c", test.home])
        try test.outside(["set-option", "-g", "@devhub-protocol", "999"])

        let _v17 = try await test.runtime.preflight(test.socket).state
        XCTAssertEqual(_v17, .wrongMarker)
        _ = await assertThrowsPortAsync(.conflict) { _ = try await test.runtime.ensure(.localScratch) }
        _ = await assertThrowsPortAsync(.conflict) { _ = try await test.runtime.inspectOwnedSessions(test.socket) }
        let _v18 = try await test.listSessions().map(\.name)
        XCTAssertEqual(_v18, ["foreign"])
    }

    func testTreatsALiveServerWithNoMarkerAsForeignNotAsAbsent() async throws {
        let test = try fixture("no-marker")
        try test.outside(["new-session", "-d", "-s", "foreign", "-c", test.home])
        let _v19 = try await test.runtime.preflight(test.socket).state
        XCTAssertEqual(_v19, .wrongMarker)
    }

    /// A `TMUX_TMPDIR` deep enough that the socket does not fit in a socket
    /// address used to reach the person as a conflict with another DevHub.
    func testNamesASocketPathTooLongForASocketAddressInsteadOfAConflict() async throws {
        let root = makeSocketRoot("toolong")
        let deep = Path.join(root, String(repeating: "a", count: 90))
        try FileManager.default.createDirectory(atPath: deep, withIntermediateDirectories: false)
        let test = try fixture("toolong", environment: ["TMUX_TMPDIR": deep])
        let socketPath = Path.join(realpathOf(deep), "tmux-\(getuid())", test.socket.rawValue)
        XCTAssertGreaterThan(socketPath.utf8.count, 103)
        let detail = "\(socketPath) is \(socketPath.utf8.count) bytes; macOS allows 103 and Linux 107. Set TMUX_TMPDIR to a shorter directory."
        let round = await assertThrowsPortAsync(.socketPathTooLong) { _ = try await test.runtime.agentRound([]) }
        XCTAssertEqual(round?.detail, detail)
        let preflight = await assertThrowsPortAsync(.socketPathTooLong) { _ = try await test.runtime.preflight(test.socket) }
        XCTAssertEqual(preflight?.detail, detail)
        // Bringing a server up is refused the same way.
        let ensure = await assertThrowsPortAsync(.socketPathTooLong) { _ = try await test.runtime.ensure(.localScratch) }
        XCTAssertEqual(ensure?.detail, detail)
    }

    func testNamesASocketDirectoryItMayNotCreateInsteadOfAConflict() async throws {
        // The superuser may create a directory anywhere, so there is nothing
        // to be refused.
        try XCTSkipIf(getuid() == 0, "a directory is never locked to the superuser")
        let root = makeSocketRoot("locked")
        let locked = Path.join(root, "locked")
        try FileManager.default.createDirectory(atPath: locked, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o500])
        defer { chmod(locked, 0o700) }
        let test = try fixture("locked", environment: ["TMUX_TMPDIR": locked])
        let detail = "tmux could not use its socket: couldn't create directory \(Path.join(realpathOf(locked), "tmux-\(getuid())")) (Permission denied)"
        let round = await assertThrowsPortAsync(.socketUnusable) { _ = try await test.runtime.agentRound([]) }
        XCTAssertEqual(round?.detail, detail)
        let ensure = await assertThrowsPortAsync(.socketUnusable) { _ = try await test.runtime.ensure(.localScratch) }
        XCTAssertEqual(ensure?.detail, detail)
    }

    func testNeverClaimsAScratchATrustedUserConfigCreatedFirst() async throws {
        let test = try fixture("foreign-scratch")
        let scratch = TmuxMarkers.scratchSession
        try userConfig(test, [
            "new-session -d -s \(scratch) -c \"$DEVHUB_BOOTSTRAP_ROOT\"",
            "set-option -t \(scratch) @devhub-context foreign",
            "set-option -t \(scratch) @devhub-workspace-id foreign",
            "set-option -t \(scratch) @devhub-root /foreign",
            "",
        ].joined(separator: "\n"))

        // The ownership transaction is one command sequence, so the duplicate
        // new-session stops it before the global marker is ever committed.
        _ = await assertThrowsPortAsync(.conflict) { _ = try await test.runtime.ensure(.localScratch) }
        let sessions = try await test.listSessions()
        XCTAssertEqual(sessions.count, 1)
        XCTAssertEqual(sessions.first?.name, scratch)
        XCTAssertEqual(sessions.first?.context, "foreign")
        XCTAssertEqual(sessions.first?.root, "/foreign")
        let marker = try await test.runTmux(["show-options", "-gqv", "@devhub-protocol"])
        XCTAssertNotEqual(String(decoding: marker.stdout, as: UTF8.self), "1\n")
    }

    func testFollowsASocketChangeOnceTheTransitionCommitsIt() async throws {
        let test = try fixture("rebind")
        _ = try await test.runtime.ensure(.localScratch)
        let rebound = try SocketName("dhrebind\(getpid())\(nextSequence())")
        defer {
            _ = try? RealFixture(home: test.home, runtime: test.runtime, socket: rebound, environment: test.environment, runLog: nil).killServer()
        }

        // A transition holds the gate: inventory the old socket, adopt the new
        // one, then commit the effective name.
        let permit = try await test.runtime.beginTransition()
        do {
            let inventory = try await test.runtime.transitionInspectOwnedSessions(test.socket, cancel: test.cancel)
            XCTAssertEqual(inventory.sessions.count, 1)
            let _v20 = try await test.runtime.transitionPreflight(rebound, cancel: test.cancel).state
            XCTAssertEqual(_v20, .targetAbsent)
            try await test.runtime.transitionEnsureOnSocket(rebound, .localScratch, cancel: test.cancel)
            test.runtime.setEffectiveSocket(rebound)
        } catch {
            permit.release()
            throw error
        }
        permit.release()

        // Ordinary operations now go to the new socket without being told.
        _ = try await test.runtime.ensure(.localScratch)
        let _v21 = try await test.listSessions(rebound).contains { $0.name == TmuxMarkers.scratchSession }
        XCTAssertTrue(_v21)
        // The sessions on the socket being left behind are still there.
        let _v22 = try await test.listSessions().contains { $0.name == TmuxMarkers.scratchSession }
        XCTAssertTrue(_v22)
    }

    func testAnswersAHealthRecheckFromTheLiveSocket() async throws {
        let test = try fixture("health")
        let _v23 = await test.runtime.recheckHealth()
        XCTAssertTrue(_v23)
        _ = try await test.runtime.ensure(.localScratch)
        let _v24 = await test.runtime.recheckHealth()
        XCTAssertTrue(_v24)
    }

    /// An Agent's session ends exactly when its command does, and nothing has
    /// to be told about it.
    func testEndsAnAgentSessionWhenTheAgentsOwnCommandExits() async throws {
        let test = try fixture("agentexit")
        let sessions = test.sessions()
        let agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"
        let workspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1"
        _ = try await test.runtime.ensure(.localScratch)
        try await sessions.launch(AgentLaunchSpec(
            target: AgentTerminalTarget(machine: .local, agentId: agentId, workspaceId: workspaceId, root: test.home),
            command: sleeper
        ))

        let live = try await sessions.list(.local)
        XCTAssertEqual(live.map(\.agentId), [agentId])
        XCTAssertEqual(live.map(\.workspaceId), [workspaceId])
        let session = try await test.listSessions().first { $0.name == TmuxNames.agentSession(agentId: agentId) }
        XCTAssertNotNil(session)
        XCTAssertTrue(session.map { TmuxMarkers.isMarked($0.marking, expectedGlobalRoot: test.home) } ?? false)
        XCTAssertEqual(session?.agentId, agentId)

        // Kill the Agent's process, not its session.
        try test.outside(["send-keys", "-t", TmuxNames.agentSession(agentId: agentId), "C-c"])
        let gone = try await poll(10) { try await !sessions.list(.local).contains { $0.agentId == agentId } }
        XCTAssertTrue(gone, "the Agent session outlived its command")
        let _v25 = try await sessions.list(.local)
        XCTAssertEqual(_v25, [])
    }

    func testCarriesTheProfilesEnvironmentIntoTheAgentsPane() async throws {
        let test = try fixture("agentenv")
        let sessions = test.sessions()
        let agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2"
        let marker = Path.join(test.home, "agent-env.txt")
        _ = try await test.runtime.ensure(.localScratch)
        try await sessions.launch(AgentLaunchSpec(
            target: AgentTerminalTarget(machine: .local, agentId: agentId, workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", root: test.home),
            command: AgentSessionCommand(file: "/bin/sh", args: ["-c", "\(published("\"$DEVHUB_TEST_VALUE\"", marker)); sleep 30"], env: ["DEVHUB_TEST_VALUE": "carried"])
        ))
        let _v26 = try await paneWrote(marker)
        XCTAssertEqual(_v26, "carried")

        // Terminating is the exact-record kill, and it takes the pane with it.
        try await sessions.terminate(.local, agentId: agentId)
        let _v27 = try await sessions.list(.local)
        XCTAssertEqual(_v27, [])
    }

    func testReadsAnAgentsOwnScreenAndTitleAndOnlyThatAgents() async throws {
        let test = try fixture("agentcap")
        let sessions = test.sessions()
        let agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4"
        let other = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5"
        _ = try await test.runtime.ensure(.localScratch)
        try await sessions.launch(AgentLaunchSpec(
            target: AgentTerminalTarget(machine: .local, agentId: agentId, workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4", root: test.home),
            // Print a line, set an OSC 2 title, then stay alive.
            command: AgentSessionCommand(file: "/bin/sh", args: ["-c", "printf 'on the screen\\n'; printf '\\033]2;a title\\007'; sleep 30"], env: [:])
        ))
        let titled = try await poll(10) {
            !(try await sessions.round(.local, captureIds: [agentId]).screens[agentId]?.oscTitle.isEmpty ?? true)
        }
        XCTAssertTrue(titled, "the Agent never set a title")
        let screen = try await sessions.round(.local, captureIds: [agentId]).screens[agentId]
        XCTAssertEqual(screen?.oscTitle, "a title")
        XCTAssertTrue(screen?.screen.contains("on the screen") ?? false)

        // Asking about an Agent whose session is not there answers with no
        // screen at all rather than with somebody else's pane.
        let missing = try await sessions.round(.local, captureIds: [other])
        XCTAssertNil(missing.screens[other])
        XCTAssertEqual(missing.live.map(\.agentId), [agentId])
    }

    /// `ensure` creates a terminal, because a terminal is a place. An Agent is
    /// a process, so the same call must refuse.
    func testRefusesToResurrectAnAgentWhoseSessionHasEnded() async throws {
        let test = try fixture("agentgone")
        _ = try await test.runtime.ensure(.localScratch)
        do {
            _ = try await test.runtime.ensure(.agent(machine: .local, agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3", root: test.home))
            XCTFail("an ended Agent was brought back as an empty shell")
        } catch {}
    }

    /// A server left by a DevHub from before `@devhub-agent-id` existed.
    func testAdoptsItsOwnSessionsFromBeforeTheAgentIdMarkerExisted() async throws {
        let test = try fixture("premarker")
        let workspaceId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1"
        let agentId = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1"
        let scratch = TmuxMarkers.scratchSession

        try test.outside(["new-session", "-d", "-s", scratch, "-c", test.home])
        try test.outside(["set-option", "-g", "@devhub-protocol", "1"])
        for (option, value) in [("@devhub-context", "global"), ("@devhub-workspace-id", "global"), ("@devhub-root", test.home)] {
            try test.outside(["set-option", "-t", scratch, option, value])
        }
        let workspaceSession = test.workspaceSession(test.home)
        try test.outside(["new-session", "-d", "-s", workspaceSession, "-c", test.home])
        for (option, value) in [("@devhub-context", "workspace"), ("@devhub-workspace-id", workspaceId), ("@devhub-root", test.home)] {
            try test.outside(["set-option", "-t", workspaceSession, option, value])
        }

        // An absent agent-id marker reads as `none`.
        for session in try await test.listSessions() {
            XCTAssertTrue(TmuxMarkers.isMarked(session.marking, expectedGlobalRoot: test.home), session.name)
        }

        _ = try await test.runtime.ensure(.localScratch)
        _ = try await test.runtime.ensure(.workspace(machine: .local, workspaceId: workspaceId, root: test.home))
        try await test.runtime.launchAgent(AgentTerminalTarget(machine: .local, agentId: agentId, workspaceId: workspaceId, root: test.home), command: sleeper)

        let live = try await test.runtime.listAgents(cancel: test.cancel)
        XCTAssertTrue(live.map(\.record.sessionName).contains(TmuxNames.agentSession(agentId: agentId)))

        // Adopting them must not have replaced or renamed anything.
        let after = try await test.listSessions().map(\.name)
        XCTAssertTrue(after.contains(scratch))
        XCTAssertTrue(after.contains(workspaceSession))
    }

    /// Queued text reaches a real pane, and only once its prompt has settled.
    ///
    /// The Agent here is a script rather than Claude Code: it prints the very
    /// screen the fixtures captured from a real one, then waits on input and
    /// writes down exactly what arrived — real tmux, real `send-keys`, real
    /// bracketed paste, the real detector and the real queue. Perl rather than
    /// the TS suite's Python: it is on every machine this runs on.
    func testTypesQueuedTextIntoAnAgentOnceItsPromptHasSettled() async throws {
        try XCTSkipUnless(FileManager.default.isExecutableFile(atPath: "/usr/bin/perl"), "no perl for the fake agent")
        let test = try fixture("inject")
        let sessions = test.sessions()
        let detector = AgentStatusDetector()
        let queue = AgentInjectionQueue()
        let agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5"
        let workspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5"
        let landed = Path.join(test.home, "received.txt")
        let screenFile = Path.join(test.home, "screen.txt")
        let script = Path.join(test.home, "fake-agent.pl")
        try DetectFixture.claude["CLAUDE_IDLE"]!.screen.write(toFile: screenFile, atomically: true, encoding: .utf8)
        try #"""
        use strict; use warnings; use Time::HiRes qw(time sleep);
        # A TUI puts its terminal in raw mode; a cooked one would have the line
        # discipline turn the carriage returns into newlines.
        system("stty raw -echo");
        binmode STDIN; binmode STDOUT; $| = 1;
        open(my $in, '<', $ARGV[0]) or die; binmode $in; local $/; print <$in>; close $in;
        my $buf = ''; my $end = time + 25; my ($closed, $enter);
        while (time < $end) {
            my $rin = ''; vec($rin, fileno(STDIN), 1) = 1;
            if (select(my $rout = $rin, undef, undef, 0.05) > 0) {
                my $n = sysread(STDIN, my $chunk, 65536);
                last unless $n;
                $buf .= $chunk;
                if (!defined $closed && index($buf, "\e[201~") >= 0) { $closed = time; }
                elsif (defined $closed && index($chunk, "\r") >= 0) { $enter = time; last; }
            }
        }
        my $gap = (defined $closed && defined $enter) ? int(($enter - $closed) * 1000) : -1;
        open(my $out, '>', "$ARGV[1].part") or die; binmode $out;
        print $out $buf . "\n--GAP--" . $gap; close $out;
        rename("$ARGV[1].part", $ARGV[1]);
        sleep 30;
        """#.write(toFile: script, atomically: true, encoding: .utf8)
        _ = try await test.runtime.ensure(.localScratch)
        try await sessions.launch(AgentLaunchSpec(
            target: AgentTerminalTarget(machine: .local, agentId: agentId, workspaceId: workspaceId, root: test.home),
            command: AgentSessionCommand(file: "/usr/bin/perl", args: [script, screenFile, landed], env: [:])
        ))

        let text = "First line.\nSecond line, which must not submit on its own."
        try queue.queue(agentId, AgentInjectionIntent(id: "intent-1", text: text, state: .confirmed))

        var sends = 0
        var firstIdleAt = 0.0
        var sentAt = 0.0
        for _ in 0..<80 {
            if let screen = try await sessions.round(.local, captureIds: [agentId]).screens[agentId] {
                let status = detector.status(kind: "claude", screen: screen)
                let now = Date().timeIntervalSince1970 * 1000
                if status == .idle && firstIdleAt == 0 { firstIdleAt = now }
                if let due = queue.due(agentId, status: status, now: now) {
                    try await sessions.inject(.local, agentId: agentId, workspaceId: workspaceId, text: due)
                    queue.sent(agentId)
                    sends += 1
                    sentAt = Date().timeIntervalSince1970 * 1000
                }
            }
            if FileManager.default.fileExists(atPath: landed) { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }

        // The prompt had to look free for a whole second before anything went
        // into it — the real clock, not a count of rounds.
        XCTAssertGreaterThanOrEqual(sentAt - firstIdleAt, AgentInjectionQueue.idleSettleMs)
        XCTAssertTrue(FileManager.default.fileExists(atPath: landed))
        let received = String(decoding: FileManager.default.contents(atPath: landed) ?? Data(), as: UTF8.self)
        // Wrapped as a paste.
        XCTAssertTrue(received.contains("\u{1b}[200~"))
        XCTAssertTrue(received.contains("\u{1b}[201~"))
        XCTAssertTrue(received.contains("First line."))
        XCTAssertTrue(received.contains("Second line, which must not submit on its own."))
        // A line break inside a paste travels as a carriage return.
        XCTAssertTrue(received.unicodeScalars.map(String.init).joined().contains("First line.\rSecond line") || received.contains("First line.\rSecond line"))
        XCTAssertEqual(sends, 1)
        // And the Return came well after the paste finished: Codex's window
        // for a paste is 120ms (`PASTE_ENTER_SUPPRESS_WINDOW`).
        let gap = Int(received.components(separatedBy: "--GAP--").last ?? "") ?? -1
        XCTAssertGreaterThan(gap, 120)
    }

    /// The gate itself, against the states a real Agent actually passes through.
    func testHoldsTextBackWhileAnAgentIsBusyOrAsking() throws {
        let queue = AgentInjectionQueue()
        let agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6"
        try queue.queue(agentId, AgentInjectionIntent(id: "intent-1", text: "do the thing", state: .confirmed))
        for _ in 0..<30 {
            XCTAssertNil(queue.due(agentId, status: .working))
            XCTAssertNil(queue.due(agentId, status: .waiting))
            XCTAssertNil(queue.due(agentId, status: .unknown))
        }
        XCTAssertEqual(queue.state(agentId, status: .waiting).waitingFor, .agentAsking)
    }

    /// The size latch an earlier build left behind, cleared on the next open.
    func testFreesAWindowAnOlderBuildPinnedToAFixedSize() async throws {
        let test = try fixture("windowsize")
        let target = TerminalTarget.workspace(machine: .local, workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4", root: test.home)
        _ = try await test.runtime.ensure(.localScratch)
        _ = try await test.runtime.ensure(target)
        let session = test.workspaceSession(test.home)

        // Exactly what the old build did on every client resize.
        try test.outside(["resize-window", "-t", session, "-x", "80", "-y", "24"], configured: false)
        XCTAssertEqual(try test.windowSize(session), "manual")

        // The path every open takes.
        _ = try await test.runtime.ensure(target)
        XCTAssertEqual(try test.windowSize(session), "latest")
    }

    /// An Agent's pane starts with nothing in its title; a workspace session
    /// is left alone, because tmux names the person's windows after it.
    func testGivesAnAgentABlankPaneTitleAndLeavesAWorkspacesAlone() async throws {
        let test = try fixture("panetitle")
        let agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3"
        let workspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3"
        _ = try await test.runtime.ensure(.localScratch)
        _ = try await test.runtime.ensure(.workspace(machine: .local, workspaceId: workspaceId, root: test.home))
        try await test.sessions().launch(AgentLaunchSpec(
            target: AgentTerminalTarget(machine: .local, agentId: agentId, workspaceId: workspaceId, root: test.home),
            command: sleeper
        ))
        XCTAssertEqual(try test.paneTitle(TmuxNames.agentSession(agentId: agentId)), "")
        // tmux's own default, untouched: the host name it gives every pane.
        XCTAssertNotEqual(try test.paneTitle(test.workspaceSession(test.home)), "")
    }

    /// An Agent session is not a tmux the user drives, so it carries no status
    /// bar; the sessions the user does drive are left as their config made them.
    func testTurnsTheStatusBarOffForAnAgentAndLeavesItAloneElsewhere() async throws {
        let test = try fixture("agentstatus")
        let agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7"
        let workspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb7"
        _ = try await test.runtime.ensure(.localScratch)
        _ = try await test.runtime.ensure(.workspace(machine: .local, workspaceId: workspaceId, root: test.home))
        try await test.sessions().launch(AgentLaunchSpec(
            target: AgentTerminalTarget(machine: .local, agentId: agentId, workspaceId: workspaceId, root: test.home),
            command: sleeper
        ))
        XCTAssertEqual(try test.sessionStatus(TmuxNames.agentSession(agentId: agentId)), "off")
        XCTAssertEqual(try test.sessionStatus(TmuxMarkers.scratchSession), "")
        XCTAssertEqual(try test.sessionStatus(test.workspaceSession(test.home)), "")
        XCTAssertEqual(try test.effectiveStatus(TmuxMarkers.scratchSession), "on")
    }

    /// The rule is stated wherever ownership is proven, not only at creation.
    func testTakesTheStatusBarOffAnAgentSessionAnOlderBuildCreated() async throws {
        let test = try fixture("agentmigrate")
        let agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8"
        let workspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb8"
        _ = try await test.runtime.ensure(.localScratch)
        try await test.sessions().launch(AgentLaunchSpec(
            target: AgentTerminalTarget(machine: .local, agentId: agentId, workspaceId: workspaceId, root: test.home),
            command: sleeper
        ))
        let session = TmuxNames.agentSession(agentId: agentId)
        try test.outside(["set-option", "-t", session, "status", "on"], configured: false)
        XCTAssertEqual(try test.sessionStatus(session), "on")

        _ = try await test.runtime.ensure(.agent(machine: .local, agentId: agentId, workspaceId: workspaceId, root: test.home))
        XCTAssertEqual(try test.sessionStatus(session), "off")
    }
}

/// What DevHub puts on a machine that is not the one it runs on: this
/// machine wearing an `ssh:` id, because that id is the whole of what the
/// adapter branches on.
final class TmuxRealRemoteTests: RealTmuxCase {
    let remote = RuntimeId.ssh("build.example.com")

    // Scratch is the app's own terminal and the app runs on one machine.
    func testBringsAServerUpWithNoScratchSessionOnIt() async throws {
        let test = try fixture("remote-scratch", host: remote)
        let root = try directory(test, "api")
        _ = try await test.runtime.ensure(.workspace(machine: remote, workspaceId: "00000000-0000-4000-8000-0000000000c1", root: root))
        XCTAssertFalse(try test.sessionNames().contains(TmuxMarkers.scratchSession))
        XCTAssertEqual(try test.sessionNames().count, 1)
    }

    func testStillKeepsOneOnTheMachineDevHubIsRunningOn() async throws {
        let test = try fixture("local-scratch")
        _ = try await test.runtime.ensure(.localScratch)
        XCTAssertEqual(try test.sessionNames(), [TmuxMarkers.scratchSession])
    }

    /// The launch creates the session and the attach finds it.
    func testCreatesAnAgentsSessionThereAndThenAttachesToIt() async throws {
        let test = try fixture("remote-agent", host: remote)
        let root = try directory(test, "api")
        let workspaceId = "00000000-0000-4000-8000-0000000000c2"
        let agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaac2"
        let sessions = test.sessions(remote)
        try await sessions.launch(AgentLaunchSpec(
            target: AgentTerminalTarget(machine: remote, agentId: agentId, workspaceId: workspaceId, root: root),
            command: sleeper
        ))
        XCTAssertEqual(try test.sessionNames(), [TmuxNames.agentSession(agentId: agentId)])
        let _v28 = try await sessions.list(remote).map(\.agentId)
        XCTAssertEqual(_v28, [agentId])
        _ = try await test.runtime.ensure(.agent(machine: remote, agentId: agentId, workspaceId: workspaceId, root: root))
        XCTAssertEqual(try test.sessionNames(), [TmuxNames.agentSession(agentId: agentId)])
    }
}

/// An editor terminal's pane and an Agent's terminal: the `join-pane` and
/// `move-window` helpers C-06 is built on.
final class TmuxRealPaneTerminalTests: RealTmuxCase {
    let ws = "550e8400-e29b-41d4-a716-446655440000"
    let terminal = "11111111-1111-4111-8111-111111111111"

    func editorWithTwoWindows(_ label: String) async throws -> (RealFixture, String, [String], PaneTerminalTarget) {
        let test = try fixture(label)
        let root = test.home
        _ = try await test.runtime.ensure(.workspace(machine: .local, workspaceId: ws, root: root))
        let session = test.workspaceSession(root)
        try test.outside(["split-window", "-t", session])
        try test.outside(["new-window", "-t", session])
        let panes = try test.outside(["list-panes", "-s", "-t", session, "-F", "#{pane_id}"]).split(separator: "\n").map(String.init)
        return (test, session, panes, PaneTerminalTarget(machine: .local, terminalId: terminal, workspaceId: ws, root: root))
    }

    func testListsTheEditorsPanesWithWhatRunsInFrontAndBringsThem() async throws {
        let (test, session, panes, target) = try await editorWithTwoWindows("bring")
        let (first, second, third) = (panes[0], panes[1], panes[2])
        try test.outside(["send-keys", "-t", first, "exec sleep 600", "Enter"])
        var listed = try await test.runtime.workspacePanes()
        for _ in 0..<50 {
            if listed.first(where: { $0.pane.paneId == first })?.argv == "sleep 600" { break }
            try await Task.sleep(nanoseconds: 50_000_000)
            listed = try await test.runtime.workspacePanes()
        }
        XCTAssertEqual(listed.map { [$0.pane.sessionName, $0.pane.paneId] }, panes.map { [session, $0] })
        XCTAssertEqual(listed.first { $0.pane.paneId == first }?.argv, "sleep 600")

        // A fresh terminal: the pane takes the place of its new shell.
        try await test.runtime.launchTerminal(target)
        try await test.runtime.joinIntoTerminal(target, paneId: first, replace: true)
        let _v29 = try await test.runtime.paneTerminals().map { [$0.pane.paneId, $0.pane.command] }
        XCTAssertEqual(_v29, [[first, "sleep"]])
        // An open one: the pane is added, and the window it leaves goes.
        try await test.runtime.joinIntoTerminal(target, paneId: third, replace: false)
        let _v30 = try await test.runtime.paneTerminals().map(\.pane.paneId).sorted()
        XCTAssertEqual(_v30, [first, third].sorted())
        let _v31 = try await test.runtime.workspacePanes().map(\.pane.paneId)
        XCTAssertEqual(_v31, [second])
        // Only an editor's pane is brought: not one of the terminal's own.
        do {
            try await test.runtime.joinIntoTerminal(target, paneId: first, replace: false)
            XCTFail("a terminal's own pane was brought into it")
        } catch {}
    }

    func testMovesTheTerminalsWindowsToTheEditorsSessionRunning() async throws {
        let (test, session, panes, target) = try await editorWithTwoWindows("move")
        try await test.runtime.launchTerminal(target)
        try await test.runtime.joinIntoTerminal(target, paneId: panes[0], replace: true)
        try test.outside(["new-window", "-t", "tm-\(terminal)"])
        try await test.runtime.moveTerminalToWorkspace(target)
        let _v32 = try await test.runtime.paneTerminals()
        XCTAssertEqual(_v32, [])
        XCTAssertTrue(try test.outside(["list-panes", "-s", "-t", session, "-F", "#{pane_id}"]).split(separator: "\n").map(String.init).contains(panes[0]))
        // With no editor session left, the move makes one to move into.
        try test.outside(["kill-session", "-t", session])
        try await test.runtime.launchTerminal(target)
        try await test.runtime.moveTerminalToWorkspace(target)
        let _v33 = try await test.runtime.paneTerminals()
        XCTAssertEqual(_v33, [])
        XCTAssertEqual(try test.outside(["list-windows", "-t", session, "-F", "#{window_id}"]).split(separator: "\n").count, 2)
    }
}

/// The WP3 acceptance case: one private `-L` server, a `ws-`, an `ag-` and a
/// `tm-` session carrying their markers, a sweep that keeps what is accounted
/// for and closes what is not, and pane activity read from the live panes.
final class TmuxRealAcceptanceTests: RealTmuxCase {
    func testCreatesMarkedSessionsSweepsAndReadsPaneActivity() async throws {
        let test = try fixture("accept")
        let root = try directory(test, "repo")
        let workspaceId = "00000000-0000-4000-8000-0000000000d1"
        let kept = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaad1"
        let orphan = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaad2"
        let terminalId = "11111111-1111-4111-8111-1111111111d1"

        _ = try await test.runtime.ensure(.localScratch)
        _ = try await test.runtime.ensure(.workspace(machine: .local, workspaceId: workspaceId, root: root))
        let sessions = test.sessions()
        for agentId in [kept, orphan] {
            try await sessions.launch(AgentLaunchSpec(
                target: AgentTerminalTarget(machine: .local, agentId: agentId, workspaceId: workspaceId, root: root),
                command: sleeper
            ))
        }
        try await test.runtime.launchTerminal(PaneTerminalTarget(machine: .local, terminalId: terminalId, workspaceId: workspaceId, root: root))

        // Every one of them carries DevHub's markers.
        let listed = try await test.listSessions()
        let names = Set(listed.map(\.name))
        XCTAssertTrue(names.isSuperset(of: [
            TmuxMarkers.scratchSession,
            test.workspaceSession(root),
            TmuxNames.agentSession(agentId: kept),
            TmuxNames.agentSession(agentId: orphan),
            TmuxNames.terminalSession(terminalId: terminalId),
        ]), "\(names)")
        for session in listed {
            XCTAssertTrue(TmuxMarkers.isMarked(session.marking, expectedGlobalRoot: test.home), session.name)
        }
        let marked = try await test.runtime.markedSessions()
        XCTAssertTrue(marked.contains(.agent(agentId: kept, workspaceId: workspaceId, sessionName: TmuxNames.agentSession(agentId: kept))))
        XCTAssertTrue(marked.contains(.terminal(terminalId: terminalId, workspaceId: workspaceId, sessionName: TmuxNames.terminalSession(terminalId: terminalId))))

        // The sweep: the model knows the workspace, one Agent and the terminal;
        // the other Agent's session is nobody's and goes.
        let accounting = SweepAccounting(workspaces: [workspaceId], agents: [kept], terminals: [terminalId])
        let unaccounted = SessionSweep.unaccountedSessions(marked, accounted: accounting)
        // The Scratch anchor is swept too: nothing accounts for it.
        XCTAssertEqual(Set(unaccounted), [
            .agent(agentId: orphan, workspaceId: workspaceId, sessionName: TmuxNames.agentSession(agentId: orphan)),
            .scratch(sessionName: TmuxMarkers.scratchSession),
        ])
        for record in unaccounted { try await test.runtime.closeMarkedSession(record) }
        let afterSweep = Set(try await test.listSessions().map(\.name))
        XCTAssertFalse(afterSweep.contains(TmuxNames.agentSession(agentId: orphan)))
        XCTAssertFalse(afterSweep.contains(TmuxMarkers.scratchSession))
        XCTAssertTrue(afterSweep.contains(TmuxNames.agentSession(agentId: kept)))
        XCTAssertTrue(afterSweep.contains(TmuxNames.terminalSession(terminalId: terminalId)))
        XCTAssertTrue(afterSweep.contains(test.workspaceSession(root)))

        // Pane activity, read from the live panes in one round: the
        // workspace's shell is idle at its prompt, and then running once
        // something is in front of it; the Agent terminal is listed beside it.
        let shell = (workspaceShell as NSString).lastPathComponent
        var tracker = PaneActivityTracker()
        let quiet = try await test.runtime.terminalPanes()
        XCTAssertEqual(quiet.terminals, [TerminalSessionSample(terminalId: terminalId, workspaceId: workspaceId)])
        XCTAssertEqual(quiet.panes.map(\.workspaceId), [workspaceId])
        let pane = try XCTUnwrap(quiet.panes.first)
        let atPrompt = tracker.observe(quiet.panes, nowMs: Date().timeIntervalSince1970 * 1000, idleSeconds: 0, configuredShell: shell)
        XCTAssertEqual(atPrompt.map(\.running), [false])

        try test.outside(["send-keys", "-t", pane.pane, "exec sleep 600", "Enter"])
        let running = try await poll(10) {
            try await test.runtime.terminalPanes().panes.first?.command == "sleep"
        }
        XCTAssertTrue(running)
        let busy = try await test.runtime.terminalPanes()
        let verdicts = tracker.observe(busy.panes, nowMs: Date().timeIntervalSince1970 * 1000, idleSeconds: 0, configuredShell: shell)
        XCTAssertEqual(verdicts, [PaneVerdict(workspaceId: workspaceId, pane: pane.pane, running: true, inView: pane.inView)])
    }
}

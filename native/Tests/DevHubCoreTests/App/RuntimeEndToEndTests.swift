// The whole runtime (`DevHubRuntime.start`) on a profile of its own, in the
// self-test's world (`SelfTestWorld`), with no window: a Workspace opened, a
// GUI Agent on the stand-in Claude that answers a message with a streamed
// reply and asks for a permission, the CLIs' defaults saved where Claude and
// Codex read them, and the editor area's session ending by itself. What
// `DevHub --self-test` then drives through the window on a Mac.
//
// Needs tmux, git and python3; skipped without them.

import Foundation
import XCTest
@testable import DevHubCore

/// The window, as a recorder.
final class EndToEndShell: AppShell, @unchecked Sendable {
    private let lock = NSLock()
    private var snapshots: [AppSnapshotWire] = []
    private var errors: [AppError] = []
    private var modals: [ModalRequest] = []

    var latest: AppSnapshotWire? { lock.withLock { snapshots.last } }
    var failures: [AppError] { lock.withLock { errors } }
    var questions: [ModalRequest] { lock.withLock { modals } }

    func publishSnapshot(_ snapshot: AppSnapshotWire) async { lock.withLock { snapshots.append(snapshot) } }
    func publishError(_ error: AppError) async { lock.withLock { errors.append(error) } }
    func publishCondition(source: String, summary: String?, reason: String) async {}
    func bringToFront() async {}
    func placeKeyboardOnSurface() async {}
    func notify(_ text: String) async throws {}
    func runCommand(_ id: CommandId) async -> Bool { false }
    func openModal(_ request: ModalRequest) async { lock.withLock { modals.append(request) } }
    func quit() async {}
}

@MainActor
final class RuntimeEndToEndTests: XCTestCase {
    private func until(_ seconds: Double, _ condition: () async -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if await condition() { return true }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        return await condition()
    }

    private static func tool(_ name: String) -> String? {
        let path = ProcessInfo.processInfo.environment["PATH"] ?? ""
        return (path.split(separator: ":").map { "\($0)/\(name)" } + ["/usr/bin/\(name)"])
            .first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    /// One conversation, followed as the view follows it.
    final class Following: @unchecked Sendable {
        private let lock = NSLock()
        private var follower: ConversationFollower

        init(_ agentId: String) { follower = ConversationFollower(agentId: agentId) }

        func attached(_ attachment: ConversationAttachment) throws { try lock.withLock { try follower.attached(attachment) } }
        func take(_ update: ConversationUpdate) { lock.withLock { _ = try? follower.take(update) } }
        var transcript: Transcript { lock.withLock { follower.transcript } }
        var words: String { String(describing: transcript.entries) }
    }

    /// The runtime in a world of its own; `cleanup` takes both down.
    struct Running {
        let world: SelfTestWorld
        let runtime: DevHubRuntime
        let shell: EndToEndShell
        let tmux: String
        var controller: AppController { runtime.controller }

        func tmuxSays(_ args: [String]) -> String {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: tmux)
            process.arguments = ["-L", world.locations.tmuxSocketName] + args
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = FileHandle.nullDevice
            try? process.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            return String(decoding: data, as: UTF8.self)
        }

        func cleanup() async {
            await runtime.shutdown()
            _ = tmuxSays(["kill-server"])
            try? FileManager.default.removeItem(atPath: world.home)
            try? FileManager.default.removeItem(atPath: world.scratchRoot)
        }
    }

    private func start() async throws -> Running {
        guard let tmux = Self.tool("tmux"), let git = Self.tool("git"), let python = SelfTestWorld.findPython() else {
            throw XCTSkip("needs tmux, git and python3")
        }
        // Short: the control socket's path must fit `sun_path`.
        let id = String(UUID().uuidString.prefix(6))
        let world = try SelfTestWorld.make(home: "/tmp/dh-e2e-\(id)", scratchRoot: "/tmp/dh-e2e-\(id)-scratch", python: python, git: git)
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = "\(world.bin):\(environment["PATH"] ?? "/usr/bin:/bin")"
        let shell = EndToEndShell()
        let runtime = try await DevHubRuntime.start(
            RuntimeEnvironment(
                locations: world.locations, appExecutable: "/bin/false", cliExecutable: "/bin/false", processEnvironment: environment),
            app: shell)
        await runtime.controller.shellReady()
        let settled = await until(20) { shell.latest?.readiness == .ready }
        XCTAssertTrue(settled, "the runtime did not become ready")
        return Running(world: world, runtime: runtime, shell: shell, tmux: tmux)
    }

    private func open(_ running: Running, _ path: String) async throws -> WorkspaceWire? {
        try await running.controller.openFolder(path, machine: "local")
        let opened = await until(20) { running.shell.latest?.workspaces.contains { $0.root == path } == true }
        XCTAssertTrue(opened, "\(path) did not open: \(running.shell.latest?.workspaces.map(\.root) ?? [])")
        return running.shell.latest?.workspaces.first { $0.root == path }
    }

    func testTheRuntimeRunsGuiAgentsOnTheStandIns() async throws {
        let running = try await start()
        let world = running.world
        let shell = running.shell
        let controller = running.controller
        let config = await controller.config
        XCTAssertEqual(config?.general.workbench, "terminal")
        XCTAssertEqual(config?.agentProfiles.map(\.id), [SelfTestWorld.claudeProfile, SelfTestWorld.codexProfile])

        // A Workspace on alpha.
        guard let workspace = try await open(running, world.alpha) else { return await running.cleanup() }

        // A GUI Agent on the stand-in Claude.
        guard let transport = await controller.conversationTransport() else { return XCTFail("there is no conversation transport") }
        let updates = transport.updates()
        let agentId = try await controller.createAgent(workspaceId: workspace.id, profileId: SelfTestWorld.claudeProfile, presentation: .gui)
        let following = Following(agentId)
        let listening = Task {
            for await update in updates { following.take(update) }
        }
        defer { listening.cancel() }
        try following.attached(try await transport.attach(agentId))
        let ready = await until(20) { following.transcript.state == .ready(turn: .none) }
        XCTAssertTrue(ready, "the conversation did not become idle: \(following.transcript.state); failures \(shell.failures.map(\.summary)); log \(world.fakeLog().map(\.line))")
        XCTAssertEqual(following.transcript.session.model.choices.map(\.id).contains("opus"), true, "the models are \(following.transcript.session.model.choices.map(\.id))")

        try await transport.command(agentId, .send(text: "Hello from the test", images: []))
        let replied = await until(20) { following.words.contains("The end of the fake reply") && following.transcript.state == .ready(turn: .none) }
        XCTAssertTrue(replied, "no reply: \(following.words.suffix(600)) state \(following.transcript.state)")
        XCTAssertTrue(world.fakeLog().contains { $0.cli == "claude" && $0.line.contains("Hello from the test") }, "the stand-in never read the message")

        try await transport.command(agentId, .send(text: "Ask me for permission", images: []))
        let asked = await until(20) { !following.transcript.requests.isEmpty }
        XCTAssertTrue(asked, "no permission request: \(following.words.suffix(600))")
        if let request = following.transcript.requests.first {
            XCTAssertEqual(request.choices.first?.id, "allow")
            try await transport.command(agentId, .answer(request: request.id, answer: .choice(choiceId: "allow", text: nil)))
            let answered = await until(20) { following.words.contains("Permission answer: allow") }
            XCTAssertTrue(answered, "the stand-in did not hear the answer: \(following.words.suffix(600))")
            XCTAssertTrue(following.transcript.requests.isEmpty)
        }

        // Make default: Claude's user settings.
        let claudeDefaults = try await transport.cliDefaults(agentId, model: nil)
        XCTAssertNotNil(claudeDefaults, "Claude has no defaults to offer")
        try await transport.setCliDefault(agentId, .model, value: "opus", model: nil)
        let settings = (try? String(contentsOfFile: Path.join(world.claudeConfig, "settings.json"), encoding: .utf8)) ?? ""
        XCTAssertTrue(settings.contains("\"model\"") && settings.contains("opus"), "settings.json is \(settings)")

        // And Codex's config.toml.
        let codexId = try await controller.createAgent(workspaceId: workspace.id, profileId: SelfTestWorld.codexProfile, presentation: .gui)
        let codex = Following(codexId)
        let codexStream = transport.updates()
        let codexUpdates = Task { for await update in codexStream { codex.take(update) } }
        defer { codexUpdates.cancel() }
        _ = codexUpdates
        try codex.attached(try await transport.attach(codexId))
        let codexReady = await until(20) { codex.transcript.state == .ready(turn: .none) }
        XCTAssertTrue(codexReady, "Codex did not become idle: \(codex.transcript.state); log \(world.fakeLog().filter { $0.cli == "codex" }.map(\.line))")
        let listed = await until(10) { codex.transcript.session.model.choices.map(\.id) == ["gpt-5.5-codex", "gpt-5.5-mini"] }
        XCTAssertTrue(listed, "Codex's models are \(codex.transcript.session.model); log \(world.fakeLog().filter { $0.cli == "codex" }.map(\.line))")
        try await transport.setCliDefault(codexId, .model, value: "gpt-5.5-mini", model: nil)
        let toml = (try? String(contentsOfFile: Path.join(world.codexHome, "config.toml"), encoding: .utf8)) ?? ""
        XCTAssertTrue(toml.contains("model = \"gpt-5.5-mini\""), "config.toml is \(toml)")

        await running.cleanup()
    }
    /// The editor area's terminal of one Workspace, attached as its view attaches.
    final class EditorClient: @unchecked Sendable {
        private let lock = NSLock()
        private var bytes = Data()
        private var ended: TerminalExitReason?
        private var receipt: TerminalAttachReceipt?
        private var typed = 0
        let transport: TerminalAttachTransport
        let key: String

        init(_ transport: TerminalAttachTransport, _ key: String) {
            self.transport = transport
            self.key = key
        }

        var text: String { lock.withLock { String(decoding: bytes, as: UTF8.self) } }
        var exit: TerminalExitReason? { lock.withLock { ended } }

        func attach() async throws {
            let transport = self.transport
            let made = try await transport.attach(surfaceKey: key, viewLabel: "editor", size: TerminalSize(cols: 100, rows: 30)) { [weak self] frame in
                guard let self else { return false }
                switch frame {
                case let .output(_, sequence, data):
                    self.lock.withLock { self.bytes.append(data) }
                    if let identity = self.identity { try? transport.acknowledge(identity, sequence: sequence) }
                case let .exited(_, _, reason):
                    self.lock.withLock { self.ended = reason }
                default: break
                }
                return true
            }
            lock.withLock { receipt = made }
        }

        var identity: TerminalRequestIdentity? { lock.withLock { receipt?.identity(viewLabel: "editor") } }

        func type(_ text: String) throws {
            guard let identity else { throw DevhubFailure("not attached") }
            let next = lock.withLock { () -> Int in
                typed += 1
                return typed
            }
            try transport.input(identity, sequence: next, Data(text.utf8))
        }

        func detach() throws {
            guard let identity else { return }
            try transport.detach(identity)
        }
    }

    /// Terminal mode's `exit` (`EditorTerminalExits`, as the window wires it):
    /// a Workspace with nothing to lose closes; one with an Agent asks, and
    /// kept, gets a fresh `ws-` session; Scratch starts over; a tmux detach
    /// attaches again; DevHub letting go itself is not an exit at all.
    @MainActor
    func testTheEditorTerminalEndingByItselfClosesTheWorkspaceOrStartsItOver() async throws {
        let running = try await start()
        let world = running.world
        let shell = running.shell
        let controller = running.controller
        let runtime = running.runtime
        guard let alpha = try await open(running, world.alpha), let beta = try await open(running, world.beta),
              let scratchId = shell.latest?.scratchWorkspaceId
        else { return await running.cleanup() }
        _ = try await controller.createAgent(workspaceId: alpha.id, profileId: SelfTestWorld.claudeProfile, presentation: .gui)
        let agentUp = await until(20) { shell.latest?.workspace(alpha.id)?.agents.isEmpty == false }
        XCTAssertTrue(agentUp, "the Agent did not start")

        var questions: [ModalRequest] = []
        var asking = false
        var restarted: [String] = []
        var ended: [String] = []
        let exits = EditorTerminalExits(EditorTerminalExitsOptions(
            standing: { await controller.closeStanding($0) },
            closable: { await controller.closable($0) },
            asking: { asking },
            sessionAlive: { id in
                guard let target = await controller.editorTerminalTarget(id) else { throw TerminalFailure(.staleTarget) }
                return try await runtime.surfaces.sessionExists(target)
            },
            close: { id in
                asking = true
                Task { @MainActor in
                    if let question = await controller.requestCloseWorkspace(id) { questions.append(question) } else { asking = false }
                }
            },
            restart: { restarted.append($0) },
            log: nil, now: nil, setTimer: nil))
        runtime.surfaces.attachments.onEndedByItself = { key, _ in
            let id = String(key.dropFirst(TerminalSurfaceKeys.workspacePrefix.count))
            Task { @MainActor in
                ended.append(id)
                await exits.ended(id)
            }
        }
        func client(_ workspaceId: String) async throws -> EditorClient {
            let client = EditorClient(runtime.transport, TerminalSurfaceKeys.workspace(workspaceId))
            try await client.attach()
            let prompt = await until(10) { !client.text.isEmpty }
            XCTAssertTrue(prompt, "\(workspaceId)'s terminal drew nothing")
            return client
        }

        // beta: nothing to lose, so `exit` closes it.
        let betaTerminal = try await client(beta.id)
        try betaTerminal.type("exit\r")
        let closed = await until(15) { shell.latest?.workspace(beta.id) == nil }
        XCTAssertTrue(closed, "exit did not close beta (ended \(ended), questions \(questions))")
        XCTAssertEqual(betaTerminal.exit, .eof)
        XCTAssertTrue(questions.isEmpty, "closing beta asked \(questions)")
        XCTAssertTrue(restarted.isEmpty, "closing beta started \(restarted) over")

        // alpha: its Agent is something to lose, so it asks; kept, it starts over.
        let alphaTerminal = try await client(alpha.id)
        try alphaTerminal.type("exit\r")
        let asked = await until(15) { !questions.isEmpty }
        XCTAssertTrue(asked, "exit in alpha asked nothing (ended \(ended))")
        if case let .closeConfirmation(_, purpose)? = questions.first, case .workspaceClose = purpose {} else {
            XCTFail("exit in alpha asked \(questions)")
        }
        XCTAssertNotNil(shell.latest?.workspace(alpha.id), "alpha closed without its answer")
        XCTAssertTrue(restarted.isEmpty, "alpha started over before its answer")
        asking = false // Kept: the question was cancelled.
        let over = await until(10) { restarted == [alpha.id] }
        XCTAssertTrue(over, "kept, alpha did not start over: \(restarted)")
        let again = try await client(alpha.id)
        let fresh = running.tmuxSays(["list-sessions", "-F", "#{session_name}"])
        XCTAssertTrue(fresh.split(separator: "\n").contains { $0.hasPrefix("ws-") }, "no ws- session after the restart: \(fresh)")

        // A tmux detach: the session runs on, so the view attaches again.
        let clients = running.tmuxSays(["list-clients", "-F", "#{client_tty}"]).split(separator: "\n").map(String.init)
        XCTAssertEqual(clients.count, 1, "clients: \(clients)")
        if let tty = clients.first { _ = running.tmuxSays(["detach-client", "-t", tty]) }
        let reattach = await until(10) { restarted == [alpha.id, alpha.id] }
        XCTAssertTrue(reattach, "a detach was not attached again: \(restarted)")
        XCTAssertEqual(again.exit, .eof)
        XCTAssertNotNil(shell.latest?.workspace(alpha.id))

        // Scratch never closes: it starts over.
        let scratchTerminal = try await client(scratchId)
        try scratchTerminal.type("exit\r")
        let scratchOver = await until(10) { restarted.last == scratchId }
        XCTAssertTrue(scratchOver, "Scratch did not start over: \(restarted)")
        XCTAssertEqual(questions.count, 1)

        // DevHub letting go of a client is not an exit.
        let mine = try await client(alpha.id)
        let before = ended
        try mine.detach()
        try? await Task.sleep(nanoseconds: 800_000_000)
        XCTAssertEqual(ended, before, "DevHub's own detach was taken for an exit")
        exits.dispose()
        await running.cleanup()
    }
}

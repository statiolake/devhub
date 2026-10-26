// Port of apps/desktop/src/main/editor/managedNeovim.test.ts
//
// The managed Neovim's lifecycle, with tmux, the disk and Neovim faked:
// which jump starts a server, which reuses one, which adopts one a previous
// DevHub left running, and what is cleaned up when one dies or its Workspace
// closes. `RealNeovimTests` runs the RPC against a real Neovim, and the tmux
// half against a real tmux.

import Foundation
import XCTest
@testable import DevHubCore

private let workspaceTarget = WorkspaceTerminalTarget(
    machine: .local, workspaceId: "6f1c2d3e-4a5b-4c6d-8e7f-001122334455", root: "/src/widget")
private let directory = "/run/devhub/nvim"
private let socket = "\(directory)/\(ManagedNeovimSockets.socketName(workspaceTarget.workspaceId))"

/// A Neovim's end of the connection, recording what it was asked.
private actor FakeNeovimRPC: NeovimRPC {
    let pane: String?
    var calls: [(method: String, params: [MsgpackValue])] = []
    var closed = false
    var blocking = 0
    private var listeners: [@Sendable () -> Void] = []

    init(pane: String?) { self.pane = pane }

    func request(_ method: String, _ params: [MsgpackValue]) async throws -> MsgpackValue {
        if closed { throw NeovimConnectionError("closed") }
        calls.append((method, params))
        if method == "nvim_get_mode" {
            let isBlocking = blocking > 0
            if isBlocking { blocking -= 1 }
            return ["mode": "n", "blocking": .bool(isBlocking)]
        }
        if method == "nvim_exec_lua", params.first == .string(paneLua) {
            return pane.map(MsgpackValue.string) ?? .nil
        }
        return .nil
    }

    func onClose(_ listener: @escaping @Sendable () -> Void) {
        if closed { listener() } else { listeners.append(listener) }
    }

    var isClosed: Bool { closed }

    /// Neovim exiting: the connection closes from its side.
    func exit() {
        closed = true
        let all = listeners
        listeners.removeAll()
        for listener in all { listener() }
    }

    func close() { exit() }

    func setBlocking(_ count: Int) { blocking = count }

    func opens() -> [[MsgpackValue]] {
        calls.filter { $0.method == "nvim_exec_lua" && $0.params.first == .string(openFileLua) }
            .map { $0.params[1].arrayValue ?? [] }
    }

    func methods() -> [String] { calls.map(\.method) }
}

/// tmux, the socket directory and Neovim, together: a pane started with
/// `--listen <socket>` makes a server listening there, unless `failStart`
/// says Neovim dies first.
private actor NeovimWorld {
    var panes: [String: EditorPaneState] = [:]
    var files: Set<String> = []
    /// Who is listening on each socket path.
    var listening: [String: FakeNeovimRPC] = [:]
    var log: [String] = []
    var next = 1
    var failStart = false
    var nvim: String? = "/opt/homebrew/bin/nvim"

    func open(_ target: WorkspaceTerminalTarget, _ argv: [String]) -> String {
        let paneId = "%\(next)"
        next += 1
        log.append("open \(target.workspaceId) \(argv.joined(separator: " ")) -> \(paneId)")
        if failStart {
            panes[paneId] = .dead
            return paneId
        }
        panes[paneId] = .alive
        let socket = argv[argv.firstIndex(of: "--listen")! + 1]
        files.insert(socket)
        listening[socket] = FakeNeovimRPC(pane: paneId)
        return paneId
    }

    func state(_ paneId: String) -> EditorPaneState { panes[paneId] ?? .gone }

    func activate(_ paneId: String) { log.append("activate \(paneId)") }

    func kill(_ paneId: String) async {
        log.append("kill \(paneId)")
        panes[paneId] = nil
        for (path, server) in listening where server.pane == paneId {
            listening[path] = nil
            await server.exit()
        }
    }

    func exists(_ path: String) -> Bool { files.contains(path) }

    func remove(_ path: String) {
        if files.remove(path) != nil { log.append("rm \(path)") }
    }

    func connect(_ path: String) async throws -> any NeovimRPC {
        if let server = listening[path], await !server.isClosed { return server }
        throw UnixStream.Failure(operation: "connect", code: files.contains(path) ? ECONNREFUSED : ENOENT, path: path)
    }

    func resolveNvim() throws -> String {
        guard let nvim else { throw ManagedNeovimError("nvim was not found in /usr/bin, /bin.") }
        return nvim
    }

    func server() -> FakeNeovimRPC? { listening[socket] }

    func clearLog() { log.removeAll() }
    func setFailStart() { failStart = true }
    func setNoNvim() { nvim = nil }
    func addFile(_ path: String) { files.insert(path) }
    func setPane(_ pane: String, _ state: EditorPaneState?) { panes[pane] = state }
    func listen(_ path: String, _ server: FakeNeovimRPC?) { listening[path] = server }
}

private struct NeovimFakePanes: EditorPanes {
    let world: NeovimWorld
    func open(_ target: WorkspaceTerminalTarget, argv: [String]) async throws -> String {
        await world.open(target, argv)
    }
    func state(_ target: WorkspaceTerminalTarget, paneId: String) async throws -> EditorPaneState {
        await world.state(paneId)
    }
    func activate(_ target: WorkspaceTerminalTarget, paneId: String) async throws {
        await world.activate(paneId)
    }
    func kill(_ target: WorkspaceTerminalTarget, paneId: String) async throws {
        await world.kill(paneId)
    }
}

private struct NeovimFakeFiles: NeovimFiles {
    let world: NeovimWorld
    func exists(_ path: String) async -> Bool { await world.exists(path) }
    func remove(_ path: String) async throws { await world.remove(path) }
    func ensurePrivateDirectory(_ path: String) async throws {}
}

private func make(_ world: NeovimWorld) -> ManagedNeovims {
    ManagedNeovims(
        panes: NeovimFakePanes(world: world),
        nvim: { try await world.resolveNvim() },
        socketDirectory: directory,
        connect: { path in try await world.connect(path) },
        files: NeovimFakeFiles(world: world),
        startTimeout: .milliseconds(200),
        poll: .milliseconds(1))
}

final class ManagedNeovimsTests: XCTestCase {
    // MARK: the first jump into a Workspace

    func testStartsNeovimInANewWindowOfItsSessionBringsItForwardAndOpensTheFile() async throws {
        let world = NeovimWorld()
        let neovims = make(world)
        let started = try await neovims.open(workspaceTarget, NeovimOpen(path: "/src/widget/a b.ts", line: 12, column: 4))
        XCTAssertTrue(started)
        let log = await world.log
        XCTAssertEqual(log, [
            "open \(workspaceTarget.workspaceId) /opt/homebrew/bin/nvim --listen \(socket) -> %1",
            "activate %1",
        ])
        let opens = await world.server()?.opens()
        XCTAssertEqual(opens, [["/src/widget/a b.ts", 12, 4, nil]])
        let pane = await neovims.paneOf(workspaceTarget.workspaceId)
        XCTAssertEqual(pane, "%1")
    }

    func testSaysWhichNvimIsMissingAndStartsNothing() async throws {
        let world = NeovimWorld()
        await world.setNoNvim()
        let error = await wp7Caught { try await make(world).open(workspaceTarget, NeovimOpen(path: "/src/widget/a.ts")) }
        XCTAssertTrue("\(error!)".contains("nvim was not found"))
        let log = await world.log
        XCTAssertEqual(log, [])
    }

    func testSaysSoWhenNeovimExitsBeforeItOpensItsSocketAndLeavesNoPane() async throws {
        let world = NeovimWorld()
        await world.setFailStart()
        let error = await wp7Caught { try await make(world).open(workspaceTarget, NeovimOpen(path: "/src/widget/a.ts")) }
        XCTAssertEqual(
            "\(error!)",
            "Neovim (/opt/homebrew/bin/nvim) exited before it opened its socket. Run it in a terminal to see why — a configuration error is the usual reason."
        )
        let log = await world.log
        XCTAssertTrue(log.contains("kill %1"))
        let panes = await world.panes
        XCTAssertTrue(panes.isEmpty)
    }

    func testSaysSoWhenNeovimNeverOpensItsSocketWithinTheBound() async throws {
        let world = NeovimWorld()
        let neovims = ManagedNeovims(
            panes: NeovimFakePanes(world: world), nvim: { "/usr/bin/nvim" }, socketDirectory: directory,
            connect: { _ in throw UnixStream.Failure(operation: "connect", code: ECONNREFUSED) },
            files: NeovimFakeFiles(world: world), startTimeout: .milliseconds(20), poll: .milliseconds(1))
        let error = await wp7Caught { try await neovims.open(workspaceTarget, NeovimOpen(path: "/a")) }
        XCTAssertEqual(
            "\(error!)",
            "Neovim (/usr/bin/nvim) did not open its socket within 0.02 seconds; it is still running in its tmux window.")
    }

    func testStartsOneNeovimForTwoJumpsThatArriveTogether() async throws {
        let world = NeovimWorld()
        let neovims = make(world)
        async let first = neovims.open(workspaceTarget, NeovimOpen(path: "/src/widget/a.ts"))
        async let second = neovims.open(workspaceTarget, NeovimOpen(path: "/src/widget/b.ts"))
        let results = try await [first, second]
        XCTAssertEqual(results.sorted { $0 && !$1 }, [true, false])
        let log = await world.log
        XCTAssertEqual(log.filter { $0.hasPrefix("open") }.count, 1)
        let opened = await world.server()?.opens().map { $0[0].stringValue ?? "" }
        XCTAssertEqual(Set(opened ?? []), ["/src/widget/a.ts", "/src/widget/b.ts"])
    }

    func testRunsJumpsInTheOrderTheyArrived() async throws {
        let world = NeovimWorld()
        let neovims = make(world)
        try await neovims.open(workspaceTarget, NeovimOpen(path: "/src/widget/0.ts"))
        await withTaskGroup(of: Void.self) { group in
            for index in 1...5 {
                group.addTask { _ = try? await neovims.open(workspaceTarget, NeovimOpen(path: "/src/widget/\(index).ts")) }
                try? await Task.sleep(for: .milliseconds(2))
            }
        }
        let opened = await world.server()?.opens().map { $0[0].stringValue ?? "" }
        XCTAssertEqual(opened?.first, "/src/widget/0.ts")
        XCTAssertEqual(opened?.count, 6)
    }

    // MARK: a jump while that Neovim is alive

    func testGoesToItAndBringsItsPaneForwardAgain() async throws {
        let world = NeovimWorld()
        let neovims = make(world)
        try await neovims.open(workspaceTarget, NeovimOpen(path: "/src/widget/a.ts"))
        await world.clearLog()
        let started = try await neovims.open(workspaceTarget, NeovimOpen(path: "/src/widget/b.ts", line: 3))
        XCTAssertFalse(started)
        let log = await world.log
        XCTAssertEqual(log, ["activate %1"])
        let opens = await world.server()?.opens()
        XCTAssertEqual(opens?[1], ["/src/widget/b.ts", 3, nil, nil])
    }

    func testDismissesABlockingPromptBeforeAskingItToOpenAnything() async throws {
        let world = NeovimWorld()
        let neovims = make(world)
        try await neovims.open(workspaceTarget, NeovimOpen(path: "/src/widget/a.ts"))
        let found = await world.server()
        let server = try XCTUnwrap(found)
        await server.setBlocking(1)
        try await neovims.open(workspaceTarget, NeovimOpen(path: "/src/widget/b.ts"))
        let calls = await server.calls
        let methods = calls.map(\.method)
        let input = try XCTUnwrap(methods.lastIndex(of: "nvim_input"))
        XCTAssertEqual(calls[input].params, ["<Esc>"])
        XCTAssertGreaterThan(methods.lastIndex(of: "nvim_exec_lua")!, input)
    }

    func testGivesUpDismissingAfterThreeTriesAndStillOpens() async throws {
        let world = NeovimWorld()
        let neovims = make(world)
        try await neovims.open(workspaceTarget, NeovimOpen(path: "/src/widget/a.ts"))
        let found = await world.server()
        let server = try XCTUnwrap(found)
        await server.setBlocking(10)
        try await neovims.open(workspaceTarget, NeovimOpen(path: "/src/widget/b.ts"))
        let methods = await server.methods()
        XCTAssertEqual(methods.filter { $0 == "nvim_input" }.count, 3)
        let opens = await server.opens()
        XCTAssertEqual(opens.count, 2)
    }

    // MARK: a jump after that Neovim has gone

    func testStartsANewOneInANewWindowOnceItExited() async throws {
        let world = NeovimWorld()
        let neovims = make(world)
        try await neovims.open(workspaceTarget, NeovimOpen(path: "/src/widget/a.ts", waitMarkerPath: "/tmp/wait-1"))
        await world.addFile("/tmp/wait-1")
        await world.clearLog()
        // `:q`: the pane closes and the connection with it.
        await world.setPane("%1", nil)
        await world.server()?.exit()
        await world.listen(socket, nil)
        // Heard at once: the socket and the wait marker it held are cleaned up
        // without waiting for the next jump.
        let forgotten = await wp7Eventually { await neovims.paneOf(workspaceTarget.workspaceId) == nil }
        XCTAssertTrue(forgotten)
        let markerGone = await wp7Eventually { await !world.exists("/tmp/wait-1") }
        XCTAssertTrue(markerGone)
        let started = try await neovims.open(workspaceTarget, NeovimOpen(path: "/src/widget/b.ts"))
        XCTAssertTrue(started)
        let log = await world.log
        XCTAssertEqual(log.filter { $0.hasPrefix("open") }, [
            "open \(workspaceTarget.workspaceId) /opt/homebrew/bin/nvim --listen \(socket) -> %2"
        ])
    }

    func testDoesNotTrustAConnectionWhosePaneHasGone() async throws {
        let world = NeovimWorld()
        let neovims = make(world)
        try await neovims.open(workspaceTarget, NeovimOpen(path: "/src/widget/a.ts"))
        await world.setPane("%1", nil)
        let started = try await neovims.open(workspaceTarget, NeovimOpen(path: "/src/widget/b.ts"))
        XCTAssertTrue(started)
        let pane = await neovims.paneOf(workspaceTarget.workspaceId)
        XCTAssertEqual(pane, "%2")
    }

    func testKillsAPaneRemainOnExitKeptInsteadOfLeavingItInTheWindowList() async throws {
        let world = NeovimWorld()
        let neovims = make(world)
        try await neovims.open(workspaceTarget, NeovimOpen(path: "/src/widget/a.ts"))
        await world.setPane("%1", .dead)
        try await neovims.open(workspaceTarget, NeovimOpen(path: "/src/widget/b.ts"))
        let log = await world.log
        XCTAssertTrue(log.contains("kill %1"))
        let pane = await neovims.paneOf(workspaceTarget.workspaceId)
        XCTAssertEqual(pane, "%2")
    }

    func testUnlinksAStaleSocketWithNothingListeningAndStartsOnItsPath() async throws {
        let world = NeovimWorld()
        await world.addFile(socket)
        let started = try await make(world).open(workspaceTarget, NeovimOpen(path: "/src/widget/a.ts"))
        XCTAssertTrue(started)
        let log = await world.log
        XCTAssertEqual(log.first, "rm \(socket)")
        let opens = await world.server()?.opens()
        XCTAssertEqual(opens?.count, 1)
    }

    // MARK: a DevHub that restarted under a running Neovim

    func testAdoptsItByItsSocketAndItsOwnTmuxPaneAndStartsNothing() async throws {
        let world = NeovimWorld()
        await world.addFile(socket)
        await world.setPane("%7", .alive)
        await world.listen(socket, FakeNeovimRPC(pane: "%7"))
        let neovims = make(world)
        let started = try await neovims.open(workspaceTarget, NeovimOpen(path: "/src/widget/a.ts"))
        XCTAssertFalse(started)
        let log = await world.log
        XCTAssertEqual(log, ["activate %7"])
        let pane = await neovims.paneOf(workspaceTarget.workspaceId)
        XCTAssertEqual(pane, "%7")
    }

    func testStillUsesOneWhosePaneIsNotThisWorkspacesWithoutBringingAnythingForward() async throws {
        let world = NeovimWorld()
        await world.addFile(socket)
        await world.listen(socket, FakeNeovimRPC(pane: "%99"))
        let neovims = make(world)
        let started = try await neovims.open(workspaceTarget, NeovimOpen(path: "/src/widget/a.ts"))
        XCTAssertFalse(started)
        let log = await world.log
        XCTAssertEqual(log, [])
        let opens = await world.server()?.opens()
        XCTAssertEqual(opens?.count, 1)
    }

    func testAdoptsAServerThatCannotNameItsPane() async throws {
        let world = NeovimWorld()
        await world.addFile(socket)
        await world.listen(socket, FakeNeovimRPC(pane: nil))
        let neovims = make(world)
        let started = try await neovims.open(workspaceTarget, NeovimOpen(path: "/src/widget/a.ts"))
        XCTAssertFalse(started)
        let pane = await neovims.paneOf(workspaceTarget.workspaceId)
        XCTAssertNil(pane)
        // Alive for as long as its connection is: the next jump reuses it.
        let again = try await neovims.open(workspaceTarget, NeovimOpen(path: "/src/widget/b.ts"))
        XCTAssertFalse(again)
    }

    // MARK: the end of a managed Neovim

    func testGoesWithItsWorkspaceThePaneKilledTheSocketUnlinkedItsMarkersDeleted() async throws {
        let world = NeovimWorld()
        let neovims = make(world)
        try await neovims.open(workspaceTarget, NeovimOpen(path: "/src/widget/a.ts", waitMarkerPath: "/tmp/wait-2"))
        await world.addFile("/tmp/wait-2")
        try await neovims.close(workspaceTarget)
        let log = await world.log
        XCTAssertTrue(log.contains("kill %1"))
        let socketThere = await world.exists(socket)
        let markerThere = await world.exists("/tmp/wait-2")
        XCTAssertFalse(socketThere)
        XCTAssertFalse(markerThere)
        let pane = await neovims.paneOf(workspaceTarget.workspaceId)
        XCTAssertNil(pane)
    }

    func testClosesOneAPreviousDevHubLeftRunningFoundByItsSocket() async throws {
        let world = NeovimWorld()
        await world.addFile(socket)
        await world.setPane("%7", .alive)
        await world.listen(socket, FakeNeovimRPC(pane: "%7"))
        try await make(world).close(workspaceTarget)
        let log = await world.log
        XCTAssertTrue(log.contains("kill %7"))
        let socketThere = await world.exists(socket)
        XCTAssertFalse(socketThere)
    }

    func testIsNotKilledByDevHubQuittingTheConnectionIsLetGoAndThePaneLeftRunning() async throws {
        let world = NeovimWorld()
        let neovims = make(world)
        try await neovims.open(workspaceTarget, NeovimOpen(path: "/src/widget/a.ts"))
        await neovims.dispose()
        let log = await world.log
        XCTAssertFalse(log.contains("kill %1"))
        let state = await world.panes["%1"]
        XCTAssertEqual(state, .alive)
    }

    // MARK: where the sockets go

    func testIsOneShortStableNamePerWorkspace() throws {
        let name = ManagedNeovimSockets.socketName(workspaceTarget.workspaceId)
        XCTAssertEqual(name.count, 17)
        XCTAssertTrue(name.hasSuffix(".sock"))
        XCTAssertTrue(name.prefix(12).allSatisfy { $0.isHexDigit && !$0.isUppercase })
        XCTAssertEqual(name, ManagedNeovimSockets.socketName(workspaceTarget.workspaceId))
        XCTAssertNotEqual(ManagedNeovimSockets.socketName("another"), name)
        // The same names the TypeScript app gives, so either adopts the other's.
        let fixture = try WP7Fixtures.json("editor/sockets.json")
        for entry in fixture["names"]!.arrayValue! {
            XCTAssertEqual(ManagedNeovimSockets.socketName(entry["id"]!.stringValue!), entry["name"]!.stringValue!)
        }
    }

    func testFallsBackToAShorterDirectoryWhenASocketPathWouldNotFit() throws {
        let long = "/Users/\(String(repeating: "x", count: 80))/Library/Application Support/DevHub/devhub/nvim"
        XCTAssertEqual(try ManagedNeovimSockets.directory(for: [long, "/var/folders/T/devhub-nvim-501"]), "/var/folders/T/devhub-nvim-501")
        XCTAssertEqual(try ManagedNeovimSockets.directory(for: ["/short"]), "/short")
        XCTAssertThrowsError(try ManagedNeovimSockets.directory(for: [long])) { error in
            XCTAssertTrue("\(error)".contains("103"))
        }
        XCTAssertEqual(
            ManagedNeovimSockets.candidates(userDataDirectory: "/U/Library/Application Support/DevHub", temporaryDirectory: "/var/T", uid: 501),
            ["/U/Library/Application Support/DevHub/devhub/nvim", "/var/T/devhub-nvim-501"])
    }

    func testOpenFileLuaIsTheTypeScriptAppsByteForByte() throws {
        XCTAssertEqual(openFileLua, try WP7Fixtures.text("editor/open-file.lua"))
    }

    func testEditorPaneCommandsAreTheTypeScriptAppsTmuxArgv() {
        XCTAssertEqual(
            EditorPaneCommands.newWindow(session: "ws-abc", root: "/src/widget", argv: ["/bin/nvim", "--listen", "/s.sock"]),
            ["new-window", "-P", "-F", "#{pane_id}", "-t", "ws-abc:", "-c", "/src/widget", "--", "/bin/nvim", "--listen", "/s.sock"])
        XCTAssertEqual(EditorPaneCommands.activate(paneId: "%3"), ["select-window", "-t", "%3", ";", "select-pane", "-t", "%3"])
        XCTAssertTrue(EditorPaneCommands.isPaneId("%12"))
        XCTAssertFalse(EditorPaneCommands.isPaneId("%"))
        XCTAssertFalse(EditorPaneCommands.isPaneId("12"))
        XCTAssertFalse(EditorPaneCommands.isPaneId("%1a"))
    }
}

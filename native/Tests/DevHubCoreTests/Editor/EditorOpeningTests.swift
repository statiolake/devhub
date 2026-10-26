// The terminal-mode open flow of appController.ts (`openFromCli`,
// `openFromConversation`, `openInManagedNeovim`, `waitEndedFromCli`) with the
// model and tmux faked, and a port of openFromFinder.test.ts.

import Foundation
import XCTest
@testable import DevHubCore

/// The model, as the open flow sees it, recording what it was asked to do.
private actor OpeningHost: EditorOpenHost {
    struct Selection: Equatable, Sendable {
        var context: String
        var presentation: String
    }

    var current = Selection(context: "workspace:other", presentation: "full")
    var calls: [String] = []
    var workspaces: [RoutableWorkspace] = []
    var places: [String: EditorPlace] = [:]
    var agents: [String: (name: String, workspaceId: String)] = [:]
    var gone: Set<String> = []
    let scratch = EditorPlace(workspaceId: "scratch-id", root: "/scratch/20261026")

    func selection() -> Selection { current }
    func pathMachine(_ machine: String) throws -> any PathMachine {
        guard machine == "local" else { throw ManagedNeovimError("DevHub has no connection to \(machine)") }
        return LocalPathMachine()
    }
    func whereOnMachine(_ machine: String) -> String { machine == "local" ? "" : " on \(machine.dropFirst(4))" }
    func routableWorkspaces() -> [RoutableWorkspace] { workspaces }
    func place(root: String, machine: String) throws -> EditorPlace {
        guard let place = places[root] else { throw ManagedNeovimError("no workspace is rooted at \(root)") }
        return place
    }
    func scratchPlace() -> EditorPlace { scratch }
    func runningAgentName(_ agentId: String) -> String? { agents[agentId]?.name }
    func agentPlace(_ agentId: String) throws -> (workspaceId: String, machine: String) {
        guard let agent = agents[agentId] else { throw ManagedNeovimError("no Agent \(agentId) is open") }
        return (agent.workspaceId, "local")
    }
    func openFolder(_ path: String, machine: String) {
        calls.append("open-folder \(path) \(machine)")
    }
    func showScratch() {
        calls.append("show-scratch")
        current = Selection(context: "workspace:scratch-id", presentation: "full")
    }
    func select(workspaceId: String, besideAgent agentId: String?) {
        calls.append("select \(workspaceId)\(agentId.map { " beside \($0)" } ?? "")")
        current = Selection(context: "workspace:\(workspaceId)", presentation: agentId == nil ? "full" : "beside")
    }
    func keyboardToEditorArea() { calls.append("keyboard") }
    func bringToFront() { calls.append("front") }
    func personStartedAction() { calls.append("person") }
    func stillExists(_ selection: Selection) -> Bool { !gone.contains(selection.context) }
    func restore(_ selection: Selection) {
        calls.append("restore \(selection.context) \(selection.presentation)")
        current = selection
    }

    func setUp(workspaces: [RoutableWorkspace], places: [EditorPlace], agents: [String: (String, String)]) {
        self.workspaces = workspaces
        for place in places { self.places[place.root] = place }
        for (id, agent) in agents { self.agents[id] = (agent.0, agent.1) }
    }
    func move(to selection: Selection) { current = selection }
    func remove(_ context: String) { gone.insert(context) }
    func clear() { calls.removeAll() }
}

/// A Neovim per socket, started by a fake tmux: the smallest world in which
/// `ManagedNeovims` starts one and reuses it.
private actor OpeningNeovim: NeovimRPC {
    var opens: [[MsgpackValue]] = []
    var closed = false
    func request(_ method: String, _ params: [MsgpackValue]) async throws -> MsgpackValue {
        if method == "nvim_get_mode" { return ["mode": "n", "blocking": false] }
        if method == "nvim_exec_lua", params.first == .string(openFileLua) { opens.append(params[1].arrayValue ?? []) }
        return .nil
    }
    func onClose(_ listener: @escaping @Sendable () -> Void) {}
    var isClosed: Bool { closed }
    func close() { closed = true }
}

private actor OpeningTmux: EditorPanes, NeovimFiles {
    var servers: [String: OpeningNeovim] = [:]
    var panes: [String: String] = [:]
    var log: [String] = []
    var next = 1

    func open(_ target: WorkspaceTerminalTarget, argv: [String]) -> String {
        let pane = "%\(next)"
        next += 1
        log.append("new-window \(target.workspaceId) \(target.root)")
        servers[argv[2]] = OpeningNeovim()
        panes[pane] = argv[2]
        return pane
    }
    func state(_ target: WorkspaceTerminalTarget, paneId: String) -> EditorPaneState { panes[paneId] == nil ? .gone : .alive }
    func activate(_ target: WorkspaceTerminalTarget, paneId: String) { log.append("activate \(paneId)") }
    func kill(_ target: WorkspaceTerminalTarget, paneId: String) {
        log.append("kill \(paneId)")
        panes[paneId] = nil
    }
    func exists(_ path: String) -> Bool { servers[path] != nil }
    func remove(_ path: String) {}
    func ensurePrivateDirectory(_ path: String) {}
    func connect(_ path: String) throws -> any NeovimRPC {
        guard let server = servers[path] else { throw UnixStream.Failure(operation: "connect", code: ENOENT, path: path) }
        return server
    }
    func opened() async -> [String] {
        var all: [String] = []
        for server in servers.values {
            for open in await server.opens { all.append(open.map { "\($0)" }.joined(separator: " ")) }
        }
        return all
    }
}

private struct TmuxPanes: EditorPanes {
    let tmux: OpeningTmux
    func open(_ target: WorkspaceTerminalTarget, argv: [String]) async throws -> String { await tmux.open(target, argv: argv) }
    func state(_ target: WorkspaceTerminalTarget, paneId: String) async throws -> EditorPaneState {
        await tmux.state(target, paneId: paneId)
    }
    func activate(_ target: WorkspaceTerminalTarget, paneId: String) async throws { await tmux.activate(target, paneId: paneId) }
    func kill(_ target: WorkspaceTerminalTarget, paneId: String) async throws { await tmux.kill(target, paneId: paneId) }
}

private struct TmuxFiles: NeovimFiles {
    let tmux: OpeningTmux
    func exists(_ path: String) async -> Bool { await tmux.exists(path) }
    func remove(_ path: String) async throws {}
    func ensurePrivateDirectory(_ path: String) async throws {}
}

final class EditorOpeningTests: XCTestCase {
    var scratch = ""
    private var host = OpeningHost()
    private var tmux = OpeningTmux()
    private var opening: EditorOpening<OpeningHost>!

    override func setUp() async throws {
        scratch = try localRealpath(try wp7SocketDirectory("opening"))
        try FileManager.default.createDirectory(atPath: scratch + "/alpha/src", withIntermediateDirectories: true)
        _ = FileManager.default.createFile(atPath: scratch + "/alpha/src/a.ts", contents: Data("x\n".utf8))
        _ = FileManager.default.createFile(atPath: scratch + "/loose.md", contents: Data())
        host = OpeningHost()
        tmux = OpeningTmux()
        let tmux = self.tmux
        await host.setUp(
            workspaces: [
                RoutableWorkspace(workspaceId: "alpha", root: scratch + "/alpha", machine: "local", agents: ["agent-1"]),
                RoutableWorkspace(workspaceId: "box", root: "/srv/app", machine: "ssh:box"),
            ],
            places: [
                EditorPlace(workspaceId: "alpha", root: scratch + "/alpha"),
                EditorPlace(
                    workspaceId: "box", root: "/srv/app", supported: false,
                    unsupportedReason: EditorPlace.unsupportedSentence(onSSHHost: true)),
            ],
            agents: ["agent-1": ("Claude 1", "alpha")])
        let neovims = ManagedNeovims(
            panes: TmuxPanes(tmux: tmux), nvim: { "/usr/bin/nvim" }, socketDirectory: "/run/nvim",
            connect: { path in try await tmux.connect(path) }, files: TmuxFiles(tmux: tmux), poll: .milliseconds(1))
        opening = EditorOpening(host: host, neovims: neovims)
    }

    override func tearDown() {
        wp7RemoveDirectory(scratch)
    }

    func testOpensAFileInTheContainingWorkspacesNewNeovimAndSaysWhy() async throws {
        let said = try await opening.openFromCli(
            ControlOpenRequest(path: scratch + "/alpha/src/a.ts", cwd: scratch, position: ControlPosition(line: 3, column: 2)))
        XCTAssertEqual(
            said,
            "\(scratch)/alpha/src/a.ts at line 3, column 2, is open in a new Neovim in the workspace at \(scratch)/alpha: it is the open workspace that contains it."
        )
        let calls = await host.calls
        XCTAssertEqual(calls, ["select alpha", "keyboard", "front"])
        let log = await tmux.log
        XCTAssertEqual(log, ["new-window alpha \(scratch)/alpha", "activate %1"])
        let opened = await tmux.opened()
        XCTAssertEqual(opened, ["string(\"\(scratch)/alpha/src/a.ts\") int(3) int(2) nil"])
        // Again: its Neovim, not a new one.
        let again = try await opening.openFromCli(ControlOpenRequest(path: scratch + "/alpha/src/a.ts", cwd: scratch))
        XCTAssertTrue(again.contains("is open in its Neovim in the workspace at"), again)
    }

    func testAFileNoWorkspaceContainsGoesToScratch() async throws {
        let said = try await opening.openFromCli(ControlOpenRequest(path: scratch + "/loose.md", cwd: scratch))
        XCTAssertEqual(
            said, "\(scratch)/loose.md is open in a new Neovim in Scratch (/scratch/20261026): no open workspace contains it.")
        let calls = await host.calls
        XCTAssertEqual(calls, ["show-scratch", "keyboard", "front"])
    }

    func testAnAgentsPaneGetsTheFileBesideIt() async throws {
        let said = try await opening.openFromCli(
            ControlOpenRequest(path: scratch + "/loose.md", cwd: scratch, origin: "local\talpha\tagent-1"))
        XCTAssertEqual(
            said,
            "\(scratch)/loose.md is open in a new Neovim in the workspace at \(scratch)/alpha, beside the Agent Claude 1: it is the Agent this terminal belongs to."
        )
        let calls = await host.calls
        XCTAssertEqual(calls.first, "select alpha beside agent-1")
    }

    func testAFolderBecomesAWorkspaceAndRefusesALineOrAWait() async throws {
        let said = try await opening.openFromCli(ControlOpenRequest(path: scratch + "/alpha", cwd: scratch))
        XCTAssertEqual(said, "\(scratch)/alpha is open in DevHub.")
        let calls = await host.calls
        XCTAssertEqual(calls, ["open-folder \(scratch)/alpha local", "front"])
        let line = await wp7Caught {
            try await self.opening.openFromCli(
                ControlOpenRequest(path: self.scratch + "/alpha", cwd: "/", position: ControlPosition(line: 1, column: 1)))
        }
        XCTAssertEqual("\(line!)", "\(scratch)/alpha is a folder, and a line and column belong to a file.")
        let wait = await wp7Caught {
            try await self.opening.openFromCli(ControlOpenRequest(path: self.scratch + "/alpha", cwd: "/", waitMarkerPath: "/tmp/m"))
        }
        XCTAssertEqual("\(wait!)", "\(scratch)/alpha is a folder, and --wait waits for an editor to be closed.")
    }

    func testRefusesWhatTerminalModeCannotServeYet() async throws {
        let container = await wp7Caught {
            try await self.opening.openFromCli(ControlOpenRequest(path: "/w/a.ts", cwd: "/w", machine: "container:abc"))
        }
        XCTAssertEqual("\(container!)", "Terminal mode does not support Workspaces whose editor is in a dev container yet.")
        // A file of a served Workspace, from a pane whose origin names the host's.
        let ssh = await wp7Caught {
            try await self.opening.openFromCli(
                ControlOpenRequest(path: self.scratch + "/loose.md", cwd: "/", origin: "ssh:box\tbox\tnone"))
        }
        XCTAssertEqual("\(ssh!)", "Terminal mode does not support Workspaces on SSH hosts yet.")
        let log = await tmux.log
        XCTAssertEqual(log, [])
    }

    func testAWaitGoesBackWhereItCameFromOnlyWhileNothingMoved() async throws {
        let before = await host.current
        _ = try await opening.openFromCli(ControlOpenRequest(path: scratch + "/alpha/src/a.ts", cwd: "/", waitMarkerPath: "/tmp/w1"))
        let back = try await opening.waitEnded("/tmp/w1")
        XCTAssertEqual(back, "The wait is over; DevHub is back where it was.")
        let restored = await host.current
        XCTAssertEqual(restored, before)
        let endedW1 = try await opening.waitEnded("/tmp/w1")
        XCTAssertEqual(endedW1, "The wait is over; DevHub stayed where it was.")

        _ = try await opening.openFromCli(ControlOpenRequest(path: scratch + "/alpha/src/a.ts", cwd: "/", waitMarkerPath: "/tmp/w2"))
        await host.remove(before.context)
        let endedW2 = try await opening.waitEnded("/tmp/w2")
        XCTAssertEqual(endedW2, "The wait is over; what was selected before it is gone.")

        _ = try await opening.openFromCli(ControlOpenRequest(path: scratch + "/alpha/src/a.ts", cwd: "/", waitMarkerPath: "/tmp/w3"))
        await host.move(to: .init(context: "agent:elsewhere", presentation: "full"))
        let endedW3 = try await opening.waitEnded("/tmp/w3")
        XCTAssertEqual(endedW3, "The wait is over; DevHub stayed where it was.")
    }

    func testAConversationLinkOpensBesideItsAgentAndRefusesAFileThatHasGone() async throws {
        try await opening.openFromConversation(agentId: "agent-1", path: scratch + "/loose.md", selection: FileSelection(line: 2, column: 1))
        let calls = await host.calls
        XCTAssertEqual(calls, ["person", "select alpha beside agent-1", "keyboard", "front"])
        let gone = await wp7Caught {
            try await self.opening.openFromConversation(agentId: "agent-1", path: self.scratch + "/nothing.ts", selection: nil)
        }
        XCTAssertEqual("\(gone!)", "File not found: \(scratch)/nothing.ts It is no longer there.")
        let folder = await wp7Caught {
            try await self.opening.openFromConversation(agentId: "agent-1", path: self.scratch + "/alpha", selection: nil)
        }
        XCTAssertEqual("\(folder!)", "File not found: \(scratch)/alpha \(scratch)/alpha is a folder, not a file to open.")
        let stranger = await wp7Caught {
            try await self.opening.openFromConversation(agentId: "nobody", path: self.scratch + "/loose.md", selection: nil)
        }
        XCTAssertEqual("\(stranger!)", "no Agent nobody is open")
    }

    func testTheSentencesWords() {
        XCTAssertEqual(EditorOpening<OpeningHost>.at(nil), "")
        XCTAssertEqual(EditorOpening<OpeningHost>.at(FileSelection(line: 4, column: 9)), " at line 4, column 9,")
        XCTAssertEqual(EditorOpening<OpeningHost>.because(.origin), "it is the window this terminal belongs to.")
    }
}

final class FinderOpensTests: XCTestCase {
    private actor Recorder {
        var opened: [String] = []
        var failures: [String] = []
        var running = 0
        var overlapped = false
        func open(_ path: String) async throws {
            running += 1
            if running > 1 { overlapped = true }
            try await Task.sleep(for: .milliseconds(5))
            running -= 1
            if path.hasSuffix("bad") { throw ManagedNeovimError("cannot open \(path)") }
            opened.append(path)
        }
        func fail(_ error: Error) { failures.append("\(error)") }
    }

    func testIsTheDevhubPathEntryPointAskingForNoPositionWaitOrMachine() async throws {
        let asked = WP7Counter()
        let open = FinderOpens.finderOpen { request in
            XCTAssertEqual(request, ControlOpenRequest(path: "/Users/me/notes.md", cwd: "/Users/me"))
            asked.increment()
            return "ok"
        }
        try await open("/Users/me/notes.md")
        XCTAssertEqual(asked.value, 1)
    }

    func testHoldsPathsUntilSomethingCanOpenThemThenOpensThemInOrderOneAtATime() async throws {
        let opens = FinderOpens()
        let recorder = Recorder()
        await opens.offer("/a")
        await opens.offer("/b")
        let queued = await opens.queued
        XCTAssertEqual(queued, 2)
        try await opens.answer(with: { try await recorder.open($0) }, report: { await recorder.fail($0) })
        await opens.offer("/c-bad")
        await opens.offer("/d")
        await opens.settled()
        let opened = await recorder.opened
        XCTAssertEqual(opened, ["/a", "/b", "/d"])
        let failures = await recorder.failures
        XCTAssertEqual(failures, ["cannot open /c-bad"])
        let overlapped = await recorder.overlapped
        XCTAssertFalse(overlapped)
        let error = await wp7Caught { try await opens.answer(with: { _ in }, report: { _ in }) }
        XCTAssertEqual("\(error!)", "DevHub already has something answering Finder opens")
    }

    func testNormalisesTheDecomposedPathsMacOSHandsOut() async throws {
        let opens = FinderOpens()
        let recorder = Recorder()
        try await opens.answer(with: { try await recorder.open($0) }, report: { await recorder.fail($0) })
        await opens.offer("/Users/me/Cafe\u{301}.md")
        await opens.settled()
        let opened = await recorder.opened
        XCTAssertEqual(opened.first?.unicodeScalars.count, "/Users/me/Café.md".unicodeScalars.count)
        XCTAssertEqual(opened, ["/Users/me/Caf\u{e9}.md"])
    }
}

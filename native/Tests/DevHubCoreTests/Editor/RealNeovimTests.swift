// Port of apps/desktop/src/main/editor/neovim.real.test.ts, and the WP7
// acceptance run: a managed Neovim in a private tmux server.
//
// The RPC half of the managed Neovim against a real Neovim: the open call's
// Lua, the cursor it places, the `--wait` marker it deletes, and the
// connection closing being Neovim's exit. Then the whole lifecycle — start in
// a new window of a `ws-` session, open at a line, `--wait` ending on `:bd`,
// adoption by a DevHub that restarted, close — against real tmux and Neovim.
//
// Skipped where there is no Neovim, except where `DEVHUB_TEST_REQUIRE_NVIM=1`
// says there is one (CI installs it), so that these never pass by skipping;
// `DEVHUB_TEST_REQUIRE_TMUX=1` does the same for the lifecycle half's tmux.
// `DEVHUB_TEST_NVIM` names a Neovim that is not on the PATH (a release
// tarball unpacked somewhere); `DEVHUB_TEST_TMUX` a tmux.

import Foundation
import XCTest
@testable import DevHubCore

private func findExecutable(_ variable: String, _ name: String) -> String? {
    let environment = ProcessInfo.processInfo.environment
    if let named = environment[variable], !named.isEmpty { return named }
    return ProcessRunner.resolveExecutable(name, searchPath: environment["PATH"] ?? "")
}

private let nvim = findExecutable("DEVHUB_TEST_NVIM", "nvim")
private let tmux = findExecutable("DEVHUB_TEST_TMUX", "tmux")

/// A headless Neovim on a socket of its own, killed with the test.
private final class HeadlessNeovim: @unchecked Sendable {
    let process = Process()
    let socket: String
    let directory: String

    init() throws {
        directory = try wp7SocketDirectory("nvim-real")
        socket = directory + "/n.sock"
        process.executableURL = URL(fileURLWithPath: nvim!)
        process.arguments = ["--headless", "--clean", "--listen", socket]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
    }

    func connect() async throws -> NeovimClient {
        for _ in 0..<200 {
            if FileManager.default.fileExists(atPath: socket), let client = try? await NeovimClient.connect(socket) {
                return client
            }
            try await Task.sleep(for: .milliseconds(25))
        }
        throw ManagedNeovimError("nvim did not open its socket")
    }

    deinit {
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        wp7RemoveDirectory(directory)
    }
}

/// A program with stdio on /dev/null, waited for. On Linux, `posix_spawn` and
/// `waitpid` (see the tmux server note below); elsewhere Foundation's
/// `Process`, which learns of an exit from the kernel and is not fooled.
private func spawnAndWait(_ program: String, _ arguments: [String]) async throws -> Int32 {
    #if os(Linux)
        try await UnixStream.offload {
            var actions = posix_spawn_file_actions_t()
            posix_spawn_file_actions_init(&actions)
            defer { posix_spawn_file_actions_destroy(&actions) }
            for fd: Int32 in 0...2 {
                posix_spawn_file_actions_addopen(&actions, fd, "/dev/null", fd == 0 ? O_RDONLY : O_WRONLY, 0)
            }
            let argv = ([program] + arguments).map { strdup($0) } + [nil]
            defer { for pointer in argv { free(pointer) } }
            var pid: pid_t = 0
            let spawned = posix_spawn(&pid, program, &actions, nil, argv, environ)
            guard spawned == 0 else { throw UnixStream.Failure(operation: "posix_spawn", code: spawned, path: program) }
            var status: Int32 = 0
            while waitpid(pid, &status, 0) < 0 && errno == EINTR {}
            return (status >> 8) & 0xff
        }
    #else
        let process = Process()
        process.executableURL = URL(fileURLWithPath: program)
        process.arguments = arguments
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        return try await withCheckedThrowingContinuation { continuation in
            process.terminationHandler = { finished in continuation.resume(returning: finished.terminationStatus) }
            do {
                try process.run()
            } catch {
                continuation.resume(throwing: error)
            }
        }
    #endif
}

final class RealNeovimTests: XCTestCase {
    override func setUpWithError() throws {
        if ProcessInfo.processInfo.environment["DEVHUB_TEST_REQUIRE_NVIM"] == "1" {
            XCTAssertNotNil(nvim, "DEVHUB_TEST_REQUIRE_NVIM is set and there is no nvim")
        }
        try XCTSkipIf(nvim == nil, "no nvim (set DEVHUB_TEST_NVIM)")
    }

    // The files are named canonically (`realpath`), as DevHub names every
    // path it hands Neovim: Neovim resolves the symlinks in a buffer's name,
    // so a file under macOS's `/tmp` is `/private/tmp/…` to it.

    func testOpensAFileAtALineAndAColumnWhateverItsPathHolds() async throws {
        let server = try HeadlessNeovim()
        let client = try await server.connect()
        let scratch = SelfTestWorld.canonical(try wp7SocketDirectory("nvim-open"))
        defer { wp7RemoveDirectory(scratch) }
        let file = scratch + "/a file with 'quotes' | and spaces.ts"
        try "first\nsecond line\n日本語のテキスト\nlast\n".write(toFile: file, atomically: true, encoding: .utf8)
        _ = try await client.request("nvim_exec_lua", [.string(openFileLua), [.string(file), 3, 4, nil]])
        let name = try await client.request("nvim_buf_get_name", [0])
        XCTAssertEqual(name, .string(file))
        // Line 3, the fourth character: three characters of three bytes each in.
        let cursor = try await client.request("nvim_win_get_cursor", [0])
        XCTAssertEqual(cursor, [3, 9])
        // Past the end is the last line, not an error.
        _ = try await client.request("nvim_exec_lua", [.string(openFileLua), [.string(file), 99, nil, nil]])
        let end = try await client.request("nvim_win_get_cursor", [0])
        XCTAssertEqual(end, [4, 0])
        // A column past the line's end is the line's end.
        _ = try await client.request("nvim_exec_lua", [.string(openFileLua), [.string(file), 1, 50, nil]])
        let clamped = try await client.request("nvim_win_get_cursor", [0])
        XCTAssertEqual(clamped, [1, 4])
        await client.close()
    }

    func testOpensAFileThatIsNotThereYetAsANewBufferForIt() async throws {
        let server = try HeadlessNeovim()
        let client = try await server.connect()
        let scratch = SelfTestWorld.canonical(try wp7SocketDirectory("nvim-new"))
        defer { wp7RemoveDirectory(scratch) }
        let file = scratch + "/new.md"
        _ = try await client.request("nvim_exec_lua", [.string(openFileLua), [.string(file), nil, nil, nil]])
        let name = try await client.request("nvim_buf_get_name", [0])
        XCTAssertEqual(name, .string(file))
        await client.close()
    }

    func testDeletesAWaitMarkerWhenThatBufferIsClosed() async throws {
        let server = try HeadlessNeovim()
        let client = try await server.connect()
        let scratch = SelfTestWorld.canonical(try wp7SocketDirectory("nvim-wait"))
        defer { wp7RemoveDirectory(scratch) }
        let file = scratch + "/COMMIT_EDITMSG"
        let marker = scratch + "/wait-marker"
        try "message\n".write(toFile: file, atomically: true, encoding: .utf8)
        _ = FileManager.default.createFile(atPath: marker, contents: Data())
        _ = try await client.request("nvim_exec_lua", [.string(openFileLua), [.string(file), nil, nil, .string(marker)]])
        XCTAssertTrue(FileManager.default.fileExists(atPath: marker))
        _ = try await client.request("nvim_command", ["bdelete!"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker))
        await client.close()
    }

    func testIsHeardLeavingTheConnectionClosesWhenNeovimQuits() async throws {
        let server = try HeadlessNeovim()
        let client = try await server.connect()
        let heard = WP7Counter()
        await client.onClose { heard.increment() }
        // The request never gets its answer; Neovim is gone before it can.
        Task { _ = try? await client.request("nvim_command", ["qa!"]) }
        let ended = await wp7Eventually(5) { heard.value == 1 }
        XCTAssertTrue(ended)
        let closed = await client.isClosed
        XCTAssertTrue(closed)
    }

    // MARK: - The whole managed Neovim, in a private tmux server

    /// `EditorPanes` on a private `tmux -L` server with one `ws-` session:
    /// what WP3's tmux runtime does for the app, cut down to these four.
    private struct PrivateTmuxPanes: EditorPanes {
        let tmux: String
        let socketName: String
        let session: String

        func run(_ args: [String]) async throws -> ProcessOutput {
            try await ProcessRunner().run(tmux, ["-L", socketName, "-f", "/dev/null"] + args, timeout: 10)
        }

        func open(_ target: WorkspaceTerminalTarget, argv: [String]) async throws -> String {
            let output = try await run(EditorPaneCommands.newWindow(session: session, root: target.root, argv: argv))
            let pane = output.stdoutText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard output.succeeded, EditorPaneCommands.isPaneId(pane) else {
                throw ManagedNeovimError("new-window answered \(output.stdoutText) \(output.stderrText)")
            }
            return pane
        }

        func state(_ target: WorkspaceTerminalTarget, paneId: String) async throws -> EditorPaneState {
            let output = try await run(["list-panes", "-s", "-t", session, "-F", "#{pane_id} #{pane_dead}"])
            for line in output.stdoutText.split(separator: "\n") {
                let parts = line.split(separator: " ")
                if parts.first.map(String.init) == paneId { return parts.last == "1" ? .dead : .alive }
            }
            return .gone
        }

        func activate(_ target: WorkspaceTerminalTarget, paneId: String) async throws {
            _ = try await run(EditorPaneCommands.activate(paneId: paneId))
        }

        func kill(_ target: WorkspaceTerminalTarget, paneId: String) async throws {
            _ = try await run(EditorPaneCommands.kill(paneId: paneId))
        }
    }

    func testAManagedNeovimInAPrivateTmuxOpensAtALineWaitsForBdAndIsAdoptedAfterARestart() async throws {
        if ProcessInfo.processInfo.environment["DEVHUB_TEST_REQUIRE_TMUX"] == "1" {
            XCTAssertNotNil(tmux, "DEVHUB_TEST_REQUIRE_TMUX is set and there is no tmux")
        }
        guard let tmux else { throw XCTSkip("no tmux (set DEVHUB_TEST_TMUX)") }
        let nvim = nvim!
        let scratch = SelfTestWorld.canonical(try wp7SocketDirectory("managed"))
        defer { wp7RemoveDirectory(scratch) }
        let socketName = "dh-test-\(DevhubWait.randomHex())"
        let panes = PrivateTmuxPanes(tmux: tmux, socketName: socketName, session: "ws-test")
        // The server this starts keeps every descriptor it inherits, and on
        // Linux Foundation's `Process` learns of a child's exit through one
        // of them — so a server started through it never lets its client be
        // seen to exit. It is spawned by hand, with nothing inherited but
        // /dev/null, and waited for with `waitpid`.
        let status = try await spawnAndWait(
            tmux,
            ["-L", socketName, "-f", "/dev/null", "new-session", "-d", "-s", "ws-test", "-x", "120", "-y", "40", "-c", scratch])
        XCTAssertEqual(status, 0)
        defer { _ = try? Process.run(URL(fileURLWithPath: tmux), arguments: ["-L", socketName, "kill-server"]) }

        let file = scratch + "/notes.txt"
        try (1...30).map { "line \($0)" }.joined(separator: "\n").write(toFile: file, atomically: true, encoding: .utf8)
        let target = WorkspaceTerminalTarget(
    machine: .local, workspaceId: "ws-\(socketName)", root: scratch)
        let make = {
            ManagedNeovims(
                panes: panes, nvim: { nvim }, socketDirectory: scratch + "/nvim", startTimeout: .seconds(10))
        }
        let neovims = make()
        let marker = try DevhubWait.createMarker(temporaryDirectory: scratch)
        let first = try await neovims.open(target, NeovimOpen(path: file, line: 10, column: 3, waitMarkerPath: marker))
        XCTAssertTrue(first)
        let pane = await neovims.paneOf(target.workspaceId)
        let paneId = try XCTUnwrap(pane)
        let state = try await panes.state(target, paneId: paneId)
        XCTAssertEqual(state, .alive)

        // Ask it from the side, as a second client would.
        let socketPath = await neovims.socketPath(target.workspaceId)
        let probe = try await NeovimClient.connect(socketPath)
        let cursor = try await probe.request("nvim_win_get_cursor", [0])
        XCTAssertEqual(cursor, [10, 2])
        let name = try await probe.request("nvim_buf_get_name", [0])
        XCTAssertEqual(name, .string(file))

        // `devhub --wait` returns once the buffer is gone.
        struct LiveWorld: WaitWorld {
            let marker: String
            var socketPath: String { "/unused" }
            func markerExists() async -> Bool { FileManager.default.fileExists(atPath: marker) }
            func devhubAnswers() async -> Bool { true }
            func pause(milliseconds: Int) async throws { try await Task.sleep(for: .milliseconds(milliseconds)) }
        }
        let waiting = Task { try await DevhubWait.waitForClose(LiveWorld(marker: marker)) }
        try await Task.sleep(for: .milliseconds(300))
        _ = try await probe.request("nvim_command", ["bdelete!"])
        try await waiting.value
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker))
        await probe.close()

        // DevHub quits and comes back: the same Neovim is adopted by its
        // socket and its $TMUX_PANE, and nothing new is started.
        await neovims.dispose()
        let restarted = make()
        let second = try await restarted.open(target, NeovimOpen(path: file, line: 2))
        XCTAssertFalse(second)
        let adopted = await restarted.paneOf(target.workspaceId)
        XCTAssertEqual(adopted, paneId)

        // The Workspace closes: the pane and the socket go with it.
        try await restarted.close(target)
        let after = try await panes.state(target, paneId: paneId)
        XCTAssertEqual(after, .gone)
        XCTAssertFalse(FileManager.default.fileExists(atPath: socketPath))
    }
}

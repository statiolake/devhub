// Port of apps/desktop/src/main/editor/managedNeovim.ts
//
// The Neovim DevHub manages for each Workspace, in terminal mode.
//
// A file jump — a conversation's file link, `devhub <file>`, Finder's Open
// With — needs an editor DevHub can address. In terminal mode there is no
// workbench, so DevHub keeps one Neovim server per Workspace of its own: a
// new tmux window in the Workspace's `ws-` session running `nvim --listen
// <socket>`, opened on the first jump and reused while it lives. It is
// separate from any Neovim the person runs in the same session; two of them is
// fine. See `docs/terminal-mode.md`.
//
// # What is true, and how it is found out
//
// Every jump re-establishes the truth before acting on it, in this order:
//
// 1. **Alive** — the record's RPC connection is open and its pane is still a
//    live pane of this Workspace's session: activate the pane, open the file.
// 2. **Not known, but a server answers on the socket** — DevHub restarted
//    while Neovim went on running in tmux, which is the normal case after a
//    relaunch. The server is asked for its `$TMUX_PANE` and adopted. There is
//    no state file: the socket path is deterministic, and the pane is the
//    server's own answer.
// 3. **Dead or stale** — the connection closed, the pane is gone or dead, or
//    the socket file is there with nothing listening: the record is dropped,
//    the socket unlinked, any `--wait` markers it held deleted, and a new
//    Neovim is started in a new window.
//
// The connection is held open between jumps, and that is the death
// detector: it closing is Neovim having exited, and the record is forgotten
// then and there. A Workspace closing kills the pane (`close`); DevHub
// quitting only lets go of the connections (`dispose`), and the next DevHub
// adopts what is still running.
//
// Everything that touches tmux or the disk is a port (`EditorPanes`,
// `NeovimFiles`), so the lifecycle is tested with fakes and the tmux half
// against a real server separately. WP3's tmux runtime implements
// `EditorPanes` with `EditorPaneCommands`' argv.

import Foundation

/// What a pane DevHub started is, as tmux says it.
public enum EditorPaneState: String, Equatable, Sendable {
    case alive
    case dead
    case gone
}

/// The tmux half: the Workspace's `ws-` session, on its machine. WP3's tmux
/// runtime implements it (`openEditorWindow`, `editorPaneState`,
/// `activateEditorPane`, `killEditorPane` in the TypeScript app).
public protocol EditorPanes: Sendable {
    /// Run `argv` in a new window of the Workspace's session; its pane id.
    func open(_ target: WorkspaceTerminalTarget, argv: [String]) async throws -> String
    /// Whether `paneId` is one of this Workspace's panes, and running.
    func state(_ target: WorkspaceTerminalTarget, paneId: String) async throws -> EditorPaneState
    /// Bring the pane's window and the pane to the front of its session.
    func activate(_ target: WorkspaceTerminalTarget, paneId: String) async throws
    func kill(_ target: WorkspaceTerminalTarget, paneId: String) async throws
}

/// The tmux commands behind `EditorPanes`, as `main/terminal/tmux.ts` spells
/// them — WP3's `TmuxMarkers`, named here for what the editor does with them.
public enum EditorPaneCommands {
    /// `new-window` in a session, running `argv` directly, printing the new
    /// pane's id (`editorWindowArgs`).
    public static func newWindow(session: String, root: String, argv: [String]) -> [String] {
        TmuxMarkers.editorWindowArgs(session: session, root: root, argv: argv)
    }

    /// Bring a pane's window to the front of its session, and the pane in it.
    public static func activate(paneId: String) -> [String] {
        TmuxMarkers.activatePaneArgs(paneId)
    }

    public static func kill(paneId: String) -> [String] {
        ["kill-pane", "-t", paneId]
    }

    /// A tmux pane id, which is the only target DevHub addresses a pane by.
    public static func isPaneId(_ text: String) -> Bool {
        TmuxMarkers.isPaneId(text)
    }
}

/// `EditorPanes` on WP3's tmux runtime for the Workspace's machine: what the
/// TypeScript app's `createManagedNeovims` wires up.
public struct TmuxEditorPanes: EditorPanes {
    private let runtime: @Sendable () async throws -> TmuxTerminalRuntime

    /// `runtime` answers this machine's tmux runtime, or throws the sentence
    /// for why there is none ("there is no tmux on this Mac").
    public init(runtime: @escaping @Sendable () async throws -> TmuxTerminalRuntime) {
        self.runtime = runtime
    }

    public func open(_ target: WorkspaceTerminalTarget, argv: [String]) async throws -> String {
        try await runtime().openEditorWindow(target, argv: argv)
    }

    public func state(_ target: WorkspaceTerminalTarget, paneId: String) async throws -> EditorPaneState {
        switch try await runtime().editorPaneState(target, paneId: paneId) {
        case .alive: return .alive
        case .dead: return .dead
        case .gone: return .gone
        }
    }

    public func activate(_ target: WorkspaceTerminalTarget, paneId: String) async throws {
        try await runtime().activateEditorPane(target, paneId: paneId)
    }

    public func kill(_ target: WorkspaceTerminalTarget, paneId: String) async throws {
        try await runtime().killEditorPane(target, paneId: paneId)
    }
}

/// The disk half: sockets and wait markers.
public protocol NeovimFiles: Sendable {
    func exists(_ path: String) async -> Bool
    /// Remove a file; one that is already gone is not a failure.
    func remove(_ path: String) async throws
    /// A directory only this user can enter.
    func ensurePrivateDirectory(_ path: String) async throws
}

/// `NeovimFiles` on this machine's disk.
public struct LocalNeovimFiles: NeovimFiles {
    public init() {}

    public func exists(_ path: String) async -> Bool {
        var info = stat()
        return lstat(path, &info) == 0
    }

    public func remove(_ path: String) async throws {
        if unlink(path) != 0, errno != ENOENT {
            throw UnixStream.Failure(operation: "unlink", code: errno, path: path)
        }
    }

    public func ensurePrivateDirectory(_ path: String) async throws {
        try FileManager.default.createDirectory(
            atPath: path, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }
}

/// Where a file jump goes, in the editor's terms.
public struct NeovimOpen: Equatable, Sendable {
    /// Absolute, canonical.
    public let path: String
    /// 1-based.
    public let line: Int?
    /// 1-based, in characters.
    public let column: Int?
    /// `devhub --wait`'s marker: deleted when this buffer is closed.
    public let waitMarkerPath: String?

    public init(path: String, line: Int? = nil, column: Int? = nil, waitMarkerPath: String? = nil) {
        self.path = path
        self.line = line
        self.column = column
        self.waitMarkerPath = waitMarkerPath
    }
}

/// A failure a jump reports in a sentence.
public struct ManagedNeovimError: Error, Equatable, CustomStringConvertible, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

public enum ManagedNeovimSockets {
    /// `sun_path` is 104 bytes on macOS, NUL included; Linux allows 108.
    public static let maxSocketPathBytes = 103

    /// The socket a Workspace's managed Neovim listens on: one per Workspace,
    /// stable across DevHub restarts (which is what lets a relaunched DevHub
    /// adopt it), and short — twelve hex digits of the Workspace id's SHA-256.
    public static func socketName(_ workspaceId: String) -> String {
        "\(SHA256.hex(workspaceId).prefix(12)).sock"
    }

    /// The first of `candidates` a socket path fits under, or a failure that
    /// says why none did. A socket that silently fails to bind would be a
    /// Neovim that starts and is never reachable.
    public static func directory(for candidates: [String]) throws -> String {
        for directory in candidates {
            let path = Path.join(directory, socketName("x"))
            if path.utf8.count <= maxSocketPathBytes { return directory }
        }
        throw ManagedNeovimError(
            "No directory for Neovim's socket is short enough for a socket path (\(maxSocketPathBytes) bytes): \(candidates.joined(separator: ", ")).")
    }

    /// The two candidates the app offers, in order: DevHub's own directory
    /// (`<userData>/devhub/nvim`), then `$TMPDIR/devhub-nvim-<uid>` for a home
    /// too long for a socket address.
    public static func candidates(userDataDirectory: String, temporaryDirectory: String, uid: UInt32) -> [String] {
        [
            Path.join(userDataDirectory, "devhub", "nvim"),
            Path.join(temporaryDirectory, "devhub-nvim-\(uid)"),
        ]
    }
}

/// The one RPC call a jump makes, after the mode check: `:drop` the file (it
/// focuses a window already showing it), falling back to `:edit`; the cursor
/// where it was asked, clamped to the buffer; folds opened, the line centred;
/// and for `--wait`, autocommands that delete the marker when the buffer goes
/// or Neovim leaves. Arguments arrive as values (`...`), so nothing is
/// escaped by hand except through `fnameescape`.
///
/// Byte-identical to the TypeScript app's `OPEN_FILE_LUA`.
public let openFileLua = """

    local path, line, column, marker = ...
    local function given(value) return value ~= nil and value ~= vim.NIL end
    local escaped = vim.fn.fnameescape(path)
    if vim.fn.mode() ~= "n" then vim.cmd("stopinsert") end
    if not pcall(vim.cmd, "drop " .. escaped) then vim.cmd("edit " .. escaped) end
    if given(line) then
      local last = vim.api.nvim_buf_line_count(0)
      local row = math.max(1, math.min(line, last))
      local text = vim.api.nvim_buf_get_lines(0, row - 1, row, false)[1] or ""
      local byte = 0
      if given(column) and column > 1 then
        byte = vim.fn.byteidx(text, column - 1)
        if byte < 0 then byte = #text end
      end
      vim.api.nvim_win_set_cursor(0, { row, byte })
      vim.cmd("normal! zvzz")
    end
    if given(marker) then
      local buffer = vim.api.nvim_get_current_buf()
      local group = vim.api.nvim_create_augroup("devhub_wait_" .. tostring(vim.uv.hrtime()), { clear = true })
      local function done()
        os.remove(marker)
        pcall(vim.api.nvim_del_augroup_by_id, group)
      end
      vim.api.nvim_create_autocmd({ "BufDelete", "BufWipeout", "BufUnload" }, { group = group, buffer = buffer, once = true, callback = done })
      vim.api.nvim_create_autocmd("VimLeavePre", { group = group, once = true, callback = done })
    end

    """

/// The pane a server runs in, by its own account.
public let paneLua = "return vim.env.TMUX_PANE"

public actor ManagedNeovims {
    public typealias Connect = @Sendable (String) async throws -> any NeovimRPC

    private final class ServerRecord {
        let socketPath: String
        /// Absent for a server adopted whose pane could not be named.
        let paneId: String?
        let client: any NeovimRPC
        var waitMarkers: Set<String> = []
        /// Which record this is, for a close heard after it was replaced (an
        /// `ObjectIdentifier` could be the new record's, at the same address).
        var token: UInt64 = 0

        init(socketPath: String, paneId: String?, client: any NeovimRPC) {
            self.socketPath = socketPath
            self.paneId = paneId
            self.client = client
        }
    }

    private var records: [String: ServerRecord] = [:]
    private var nextToken: UInt64 = 1
    /// One jump at a time per Workspace: two must not start two Neovims.
    private var queues: [String: Task<Void, Never>] = [:]
    private let panes: any EditorPanes
    private let files: any NeovimFiles
    private let connect: Connect
    private let nvim: @Sendable () async throws -> String
    public let socketDirectory: String
    private let startTimeout: Duration
    private let poll: Duration
    private let onExit: (@Sendable (String) -> Void)?

    /// - Parameters:
    ///   - nvim: the `nvim` to start, resolved; throws the sentence to show
    ///     (E-09: the person's own, on the login PATH).
    ///   - socketDirectory: where the sockets go: DevHub's own, `0700`. See
    ///     `ManagedNeovimSockets.directory(for:)`.
    ///   - startTimeout: how long a new Neovim has to open its socket.
    ///   - poll: how often the socket is tried while it starts.
    ///   - onExit: told when a server's connection ends, for the log.
    public init(
        panes: any EditorPanes,
        nvim: @escaping @Sendable () async throws -> String,
        socketDirectory: String,
        connect: Connect? = nil,
        files: any NeovimFiles = LocalNeovimFiles(),
        startTimeout: Duration = .seconds(5),
        poll: Duration = .milliseconds(50),
        onExit: (@Sendable (String) -> Void)? = nil
    ) {
        self.panes = panes
        self.nvim = nvim
        self.socketDirectory = socketDirectory
        self.connect = connect ?? { path in try await NeovimClient.connect(path) }
        self.files = files
        self.startTimeout = startTimeout
        self.poll = poll
        self.onExit = onExit
    }

    public func socketPath(_ workspaceId: String) -> String {
        Path.join(socketDirectory, ManagedNeovimSockets.socketName(workspaceId))
    }

    /// The pane a Workspace's managed Neovim is in, while one is known.
    public func paneOf(_ workspaceId: String) -> String? {
        records[workspaceId]?.paneId
    }

    /// Open a file in the Workspace's managed Neovim, starting one in a new
    /// window of its session if there is none alive, and bring its pane to the
    /// front. Answers whether a new Neovim was started.
    @discardableResult
    public func open(_ target: WorkspaceTerminalTarget, _ file: NeovimOpen) async throws -> Bool {
        try await serially(target.workspaceId) { [self] in
            try await self.openNow(target, file)
        }
    }

    private func openNow(_ target: WorkspaceTerminalTarget, _ file: NeovimOpen) async throws -> Bool {
        let (record, started) = try await server(target)
        if let paneId = record.paneId {
            try await panes.activate(target, paneId: paneId)
        }
        if let marker = file.waitMarkerPath {
            record.waitMarkers.insert(marker)
        }
        try await leaveBlockingPrompt(record.client)
        _ = try await record.client.request(
            "nvim_exec_lua",
            [
                .string(openFileLua),
                .array([
                    .string(file.path),
                    .optional(file.line),
                    .optional(file.column),
                    .optional(file.waitMarkerPath),
                ]),
            ])
        return started
    }

    /// The Workspace is closing: its managed Neovim goes with it — the pane
    /// killed, the socket unlinked, its wait markers deleted. Unsaved buffers
    /// were the close confirmation's to ask about (a pane running something
    /// other than the shell counts as busy work).
    public func close(_ target: WorkspaceTerminalTarget) async throws {
        try await serially(target.workspaceId) { [self] in
            try await self.closeNow(target)
        }
    }

    private func closeNow(_ target: WorkspaceTerminalTarget) async throws {
        var record = records[target.workspaceId]
        // One DevHub has not touched since it started is still this
        // Workspace's: found the way a jump would find it.
        if record == nil {
            record = try? await adopt(target)
        }
        if let paneId = record?.paneId {
            try? await panes.kill(target, paneId: paneId)
        }
        await forget(target.workspaceId, record)
        try await files.remove(socketPath(target.workspaceId))
    }

    /// DevHub is quitting: let go of every connection and kill nothing. The
    /// servers go on running in tmux, and the next DevHub adopts them.
    public func dispose() async {
        let all = Array(records.values)
        records.removeAll()
        for record in all { await record.client.close() }
    }

    private func serially<T: Sendable>(
        _ workspaceId: String, _ work: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        let previous = queues[workspaceId]
        let next = Task<T, Error> {
            await previous?.value
            return try await work()
        }
        let settled = Task<Void, Never> { _ = try? await next.value }
        queues[workspaceId] = settled
        let result = await next.result
        if queues[workspaceId] == settled {
            queues[workspaceId] = nil
        }
        return try result.get()
    }

    /// The live server for a Workspace: known, adopted, or started now.
    private func server(_ target: WorkspaceTerminalTarget) async throws -> (ServerRecord, Bool) {
        if let known = records[target.workspaceId] {
            if try await isAlive(target, known) {
                return (known, false)
            }
            if let paneId = known.paneId {
                // A pane left dead by `remain-on-exit` would sit in the
                // person's window list for ever.
                try? await panes.kill(target, paneId: paneId)
            }
            await forget(target.workspaceId, known)
        }
        if let adopted = try await adopt(target) {
            return (adopted, false)
        }
        return (try await start(target), true)
    }

    private func isAlive(_ target: WorkspaceTerminalTarget, _ record: ServerRecord) async throws -> Bool {
        if await record.client.isClosed { return false }
        guard let paneId = record.paneId else { return true }
        return try await panes.state(target, paneId: paneId) == .alive
    }

    private static func isRefused(_ error: Error) -> Bool {
        (error as? UnixStream.Failure)?.isRefused ?? false
    }

    /// A server already listening on the Workspace's socket — DevHub restarted
    /// under it — taken back, or nothing. A socket file with nobody behind it
    /// is unlinked here, so `start` can bind the path.
    private func adopt(_ target: WorkspaceTerminalTarget) async throws -> ServerRecord? {
        let socketPath = socketPath(target.workspaceId)
        guard await files.exists(socketPath) else { return nil }
        let client: any NeovimRPC
        do {
            client = try await connect(socketPath)
        } catch {
            guard Self.isRefused(error) else { throw error }
            try await files.remove(socketPath)
            return nil
        }
        var paneId: String?
        do {
            let answer = try await client.request("nvim_exec_lua", [.string(paneLua), .array([])])
            if case let .string(pane) = answer, !pane.isEmpty { paneId = pane }
        } catch {
            await client.close()
            try await files.remove(socketPath)
            return nil
        }
        // A server on DevHub's socket is DevHub's by construction; one whose
        // pane is not this Workspace's (its window moved to another session)
        // is still used, and only not brought to the front.
        if let pane = paneId, try await panes.state(target, paneId: pane) != .alive {
            paneId = nil
        }
        return await remember(target.workspaceId, ServerRecord(socketPath: socketPath, paneId: paneId, client: client))
    }

    private func start(_ target: WorkspaceTerminalTarget) async throws -> ServerRecord {
        let socketPath = socketPath(target.workspaceId)
        try await files.ensurePrivateDirectory(socketDirectory)
        try await files.remove(socketPath)
        let nvim = try await self.nvim()
        let paneId = try await panes.open(target, argv: [nvim, "--listen", socketPath])
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: startTimeout)
        while true {
            if await files.exists(socketPath) {
                do {
                    let client = try await connect(socketPath)
                    return await remember(
                        target.workspaceId, ServerRecord(socketPath: socketPath, paneId: paneId, client: client))
                } catch {
                    guard Self.isRefused(error) else { throw error }
                }
            }
            if try await panes.state(target, paneId: paneId) != .alive {
                try? await panes.kill(target, paneId: paneId)
                throw ManagedNeovimError(
                    "Neovim (\(nvim)) exited before it opened its socket. Run it in a terminal to see why — a configuration error is the usual reason.")
            }
            if clock.now >= deadline {
                throw ManagedNeovimError(
                    "Neovim (\(nvim)) did not open its socket within \(Self.seconds(startTimeout)) seconds; it is still running in its tmux window.")
            }
            try await Task.sleep(for: poll)
        }
    }

    /// `String(ms / 1000)` as JavaScript prints it: `5`, `0.2`.
    private static func seconds(_ duration: Duration) -> String {
        let (whole, attoseconds) = duration.components
        return JavaScriptNumber.string(Double(whole) + Double(attoseconds) / 1e18)
    }

    private func remember(_ workspaceId: String, _ record: ServerRecord) async -> ServerRecord {
        record.token = nextToken
        nextToken += 1
        records[workspaceId] = record
        let token = record.token
        await record.client.onClose { [weak self] in
            Task { await self?.serverEnded(workspaceId, token) }
        }
        return record
    }

    /// The server ended — `:q`, its pane killed, a crash. Forgotten now, so the
    /// next jump starts one rather than asking a dead socket.
    private func serverEnded(_ workspaceId: String, _ token: UInt64) async {
        guard let record = records[workspaceId], record.token == token else { return }
        records[workspaceId] = nil
        await cleanUp(record)
        onExit?(workspaceId)
    }

    private func forget(_ workspaceId: String, _ record: ServerRecord?) async {
        guard let record else { return }
        if records[workspaceId] === record {
            records[workspaceId] = nil
        }
        await record.client.close()
        await cleanUp(record)
    }

    /// Its socket and every wait marker it held: nothing waits on a dead editor.
    private func cleanUp(_ record: ServerRecord) async {
        try? await files.remove(record.socketPath)
        for marker in record.waitMarkers {
            try? await files.remove(marker)
        }
        record.waitMarkers.removeAll()
    }

    /// Neovim queues RPC requests behind a blocking prompt (hit-enter,
    /// `confirm()`); one `<Esc>` dismisses it so the open is not stuck behind
    /// it. Checked a few times, because `nvim_input` is only queued.
    private func leaveBlockingPrompt(_ client: any NeovimRPC) async throws {
        for _ in 0..<3 {
            let mode = try await client.request("nvim_get_mode", [])
            guard mode["blocking"]?.boolValue == true else { return }
            _ = try await client.request("nvim_input", [.string("<Esc>")])
            try await Task.sleep(for: poll)
        }
    }
}

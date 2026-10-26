// Port of apps/desktop/src/main/cli/controlServer.ts
//
// The socket the `devhub` command talks to.
//
// One request per connection: a line of JSON in, a line of JSON out, close.
// Nothing is streamed and nothing is kept, so a client that dies mid-request
// costs one socket and no state.
//
// Every failure becomes `{ ok: false, message }` and is *printed by the CLI* —
// that is the report, not a log line nobody reads. A handler that throws is
// reported with its own message; the connection is never left hanging and the
// error is never swallowed.
//
// What the app does for each request is `ControlHandlers`, which the app's
// coordinator implements in Wave 2 (WP2's model). The requests that exist only
// for VS Code workbenches are answered here, with the sentence that the
// native app does not have them.

import Foundation

/// Longer than any request DevHub sends; short enough that nothing accumulates.
let maxControlRequestBytes = 64 * 1024

/// What the running app does for each request. Implemented by the
/// coordinator; each answer is the sentence the CLI prints, and a thrown
/// error is a refusal whose description is printed instead.
public protocol ControlHandlers: Sendable {
    /// The person started an operation: this is a command they typed. Called
    /// before it is answered, as a dispatch from the window is.
    func personStarted() async
    /// Bring DevHub to the front, and change nothing else.
    func activate() async throws -> String
    /// A folder or a file (E-07 routing, then the managed Neovim or the
    /// Workspace's editor terminal).
    func open(_ request: ControlOpenRequest) async throws -> String
    /// A `--wait` ended: its editor was closed (`WaitSelectionReturns`).
    func waitEnded(_ waitMarkerPath: String) async throws -> String
    func addAgent(profileId: String, args: [String], cwd: String) async throws -> String
    /// `DevHub <version> (native)` and the rest of what `--version` prints.
    func version() async throws -> String
    /// One reading of the app's own cost, as JSON text.
    func metrics() async throws -> String
    /// `devhub --tell`: see `TellService`.
    func tell(_ command: TellCommand, origin: String?, machine: String?) async throws -> TellAnswer
    func installCli() async throws -> String
    /// Where a workbench on `machine` connects. Answers rather than throws:
    /// whether asking again could help travels with the failure.
    func resolveRemote(machine: String, attempt: Int) async throws -> RemoteResolution
    /// The command line a terminal rooted at `root` (nil: the folderless one)
    /// attaches with, on `machine`.
    func terminalProfile(machine: String, root: String?, workspace: String?) async throws -> TerminalProfileAnswer
}

/// What `resolveRemote` answers: an endpoint, or a refusal that says whether
/// it is worth asking again.
public enum RemoteResolution: Equatable, Sendable {
    case endpoint(RemoteEndpointAnswer)
    case refused(message: String, retry: Bool)
}

/// A failure with the words a page draws it with: its title and its detail
/// (the TypeScript app's `NamedFailure`). WP2's failure algebra conforms, so
/// `devhub` prints what the window would show.
public protocol NamedFailureText: Error {
    var summary: String { get }
    var detail: String? { get }
}

/// The text of a failure, as `failureText` words it in the TypeScript app: a
/// named failure's title and detail, anything else its own message.
public func controlFailureText(_ error: Error) -> String {
    switch error {
    case let named as NamedFailureText:
        guard let detail = named.detail else { return named.summary }
        return "\(named.summary) \(detail)"
    case let error as ControlProtocolError: return error.message
    case let error as TellRefusal: return error.message
    case let error as TellCommandError: return error.message
    case let error as ManagedNeovimError: return error.message
    case let error as CustomStringConvertible: return error.description
    default: return "\(error)"
    }
}

/// The sentence for a workbench-only request in the native app.
public enum NativeUnavailable {
    public static let extensions = "Extensions are not available in the native app."
    public static let devContainers = "Dev containers are not available in the native app."
    public static let portForwards = "Port forwarding is not available in the native app."
    public static let reattach = "Reattaching an editor is not available in the native app."
}

public enum ControlAnswering {
    /// One request, answered — the whole protocol, with no socket in it.
    ///
    /// Everything the dispatch decides (which handler, what a thrown handler
    /// becomes, how a resolve's two outcomes are spelled on the wire) is a
    /// function of a line of text and a set of handlers.
    public static func answer(_ line: String, handlers: any ControlHandlers) async -> ControlResponse {
        let request: ControlRequest
        do {
            request = try ControlRequest.parse(line)
        } catch {
            return ControlResponse(ok: false, message: controlFailureText(error))
        }
        return await answer(request, handlers: handlers)
    }

    public static func answer(_ request: ControlRequest, handlers: any ControlHandlers) async -> ControlResponse {
        if typedByPerson(request) { await handlers.personStarted() }
        do {
            switch request {
            // Answered here rather than by a handler, and that is the point:
            // what is being asked is whether there is a DevHub behind this
            // socket, and an answer that depended on the app being able to do
            // something would be a different question with the same name.
            case .ping:
                return ControlResponse(ok: true, message: "DevHub is running.")
            case .activate:
                return ControlResponse(ok: true, message: try await handlers.activate())
            case let .open(open):
                return ControlResponse(ok: true, message: try await handlers.open(open))
            case let .waitEnded(marker):
                return ControlResponse(ok: true, message: try await handlers.waitEnded(marker))
            case let .addAgent(profileId, args, cwd):
                return ControlResponse(
                    ok: true, message: try await handlers.addAgent(profileId: profileId, args: args, cwd: cwd))
            case .installExtensions, .uninstallExtensions, .listExtensions:
                return ControlResponse(ok: false, message: NativeUnavailable.extensions)
            case .version:
                return ControlResponse(ok: true, message: try await handlers.version())
            case .metrics:
                return ControlResponse(ok: true, message: try await handlers.metrics())
            case let .tell(command, origin, machine):
                let answer = try await handlers.tell(command, origin: origin, machine: machine)
                return ControlResponse(ok: true, message: answer.message, data: answer.data)
            case .installCli:
                return ControlResponse(ok: true, message: try await handlers.installCli())
            case let .resolveRemote(machine, attempt):
                // A failure DevHub did not anticipate is the one case where it
                // has no opinion, and the safer of the two answers is the one
                // that lets the workbench try again.
                let resolution: RemoteResolution
                do {
                    resolution = try await handlers.resolveRemote(machine: machine, attempt: attempt)
                } catch {
                    return ControlResponse(ok: false, message: controlFailureText(error), retry: true)
                }
                switch resolution {
                case let .endpoint(remote):
                    return ControlResponse(ok: true, message: "127.0.0.1:\(remote.port)", remote: remote)
                case let .refused(message, retry):
                    return ControlResponse(ok: false, message: message, retry: retry)
                }
            case .devContainerConfigs, .devContainerBuildLog, .devContainerPorts:
                return ControlResponse(ok: false, message: NativeUnavailable.devContainers)
            case .reattachEditor:
                return ControlResponse(ok: false, message: NativeUnavailable.reattach)
            case .forwardPort:
                return ControlResponse(ok: false, message: NativeUnavailable.portForwards)
            case let .terminalProfile(machine, root, workspace):
                let profile = try await handlers.terminalProfile(machine: machine, root: root, workspace: workspace)
                return ControlResponse(
                    ok: true, message: "\(profile.file) \(profile.args.joined(separator: " "))", profile: profile)
            }
        } catch {
            return ControlResponse(ok: false, message: controlFailureText(error))
        }
    }

    /// Whether a person typed this — `devhub …` in a terminal — or DevHub's
    /// own machinery sent it. A typed command is the person's next operation,
    /// exactly as a click in the window is. A ping, a `--wait` ending, a
    /// `tell` (mostly an Agent asking) and a workbench asking for its host or
    /// its terminal are nobody's next operation.
    public static func typedByPerson(_ request: ControlRequest) -> Bool {
        switch request {
        case .activate, .open, .addAgent, .installExtensions, .uninstallExtensions, .listExtensions, .version,
            .metrics, .installCli, .reattachEditor:
            return true
        case .ping, .waitEnded, .tell, .resolveRemote, .forwardPort, .devContainerPorts, .terminalProfile,
            .devContainerConfigs, .devContainerBuildLog:
            return false
        }
    }
}

/// The listening control socket.
public final class ControlServer: Sendable {
    public let socketPath: String
    private let listener: Int32
    private let handlers: any ControlHandlers
    private let stopped = ControlServerStopFlag()

    private init(socketPath: String, listener: Int32, handlers: any ControlHandlers) {
        self.socketPath = socketPath
        self.listener = listener
        self.handlers = handlers
    }

    /// Take the socket path over, or refuse.
    ///
    /// A socket file left behind by a crash answers nothing; a socket file
    /// with a live DevHub behind it means two apps share one user-data
    /// directory, which is the state the single-instance claim exists to
    /// prevent (X-07). The first is cleared, the second is a startup failure
    /// and says so.
    static func claim(_ socketPath: String) throws {
        let directory = (socketPath as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(
            atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        if let probe = try? UnixStream.connect(socketPath) {
            UnixStream.close(probe)
            throw ControlProtocolError(
                "another DevHub is already listening on \(socketPath) — two instances cannot share one user-data directory"
            )
        }
        if unlink(socketPath) != 0 && errno != ENOENT {
            throw UnixStream.Failure(operation: "unlink", code: errno, path: socketPath)
        }
    }

    public static func start(socketPath: String, handlers: any ControlHandlers) async throws -> ControlServer {
        try await UnixStream.offload { try claim(socketPath) }
        let listener = try UnixStream.listen(socketPath)
        // Per-user, and only this user: the directory is 0700 and the socket 0600.
        _ = chmod(socketPath, 0o600)
        let server = ControlServer(socketPath: socketPath, listener: listener, handlers: handlers)
        server.acceptLoop()
        return server
    }

    private func acceptLoop() {
        let listener = self.listener
        let handlers = self.handlers
        let stopped = self.stopped
        let thread = Thread {
            while true {
                let connection = try? UnixStream.accept(listener)
                if stopped.isSet {
                    if let connection { UnixStream.close(connection) }
                    break
                }
                guard let connection else { break }
                ControlServer.serve(connection, handlers: handlers)
            }
            UnixStream.close(listener)
        }
        thread.stackSize = 1 << 20
        thread.start()
    }

    private static func serve(_ connection: Int32, handlers: any ControlHandlers) {
        let thread = Thread {
            var buffer: [UInt8] = []
            var line: String?
            while true {
                guard let chunk = try? UnixStream.read(connection), !chunk.isEmpty else { break }
                buffer.append(contentsOf: chunk)
                if buffer.count > maxControlRequestBytes {
                    let refusal = ControlResponse(ok: false, message: "the request is too large")
                    try? UnixStream.write(connection, refusal.line)
                    UnixStream.shutdownWrite(connection)
                    UnixStream.close(connection)
                    return
                }
                if let newline = buffer.firstIndex(of: 0x0A) {
                    line = String(decoding: buffer[..<newline], as: UTF8.self)
                    break
                }
            }
            guard let line else {
                UnixStream.close(connection)
                return
            }
            Task {
                let response = await ControlAnswering.answer(line, handlers: handlers)
                try? UnixStream.write(connection, response.line)
                UnixStream.shutdownWrite(connection)
                UnixStream.close(connection)
            }
        }
        thread.stackSize = 1 << 20
        thread.start()
    }

    /// Stop listening, and take the socket file away.
    public func close() {
        guard stopped.set() else { return }
        // The accept loop is woken by a connection of our own, sees the flag,
        // and closes the listener itself: closing a descriptor another thread
        // is blocked in `accept` on is not something every kernel answers.
        if let wake = try? UnixStream.connect(socketPath) { UnixStream.close(wake) }
        unlink(socketPath)
    }
}

/// A flag set once, read from any thread.
final class ControlServerStopFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false

    var isSet: Bool {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    /// Set it; false when it was already set.
    func set() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if value { return false }
        value = true
        return true
    }
}

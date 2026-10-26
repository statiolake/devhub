// Port of apps/desktop/src/main/editor/neovimRpc.ts
//
// A msgpack-rpc client for one Neovim server's socket (`:help rpc`).
//
// The managed Neovim (`ManagedNeovims`) keeps one of these open per server
// for as long as the server lives, and that is half of what it is for: the
// connection closing *is* Neovim having exited — `:q`, its pane killed, a
// crash — observed the moment it happens, with no polling and nothing spawned.
// The other half is the requests, which carry their arguments as values: a
// path with a space, a quote or a `|` in it needs no escaping, because nothing
// is parsed as a command line. That is why this is a client and not `nvim
// --server <sock> --remote-send`, which types keys into whatever mode the
// person left Neovim in.
//
// The wire is three message shapes: a request `[0, id, method, params]`, its
// response `[1, id, error, result]`, and a notification `[2, method, params]`.
// Neovim sends notifications only to a client that subscribed, and requests
// only to one that registered as a channel; this does neither, so anything it
// receives that is not a response is ignored (a request is answered with an
// error rather than left hanging on Neovim's side). Notifications are handed
// to an optional listener all the same, for a caller that subscribes later.

import Foundation

/// What a caller needs from a connection to a Neovim server.
public protocol NeovimRPC: AnyObject, Sendable {
    func request(_ method: String, _ params: [MsgpackValue]) async throws -> MsgpackValue
    /// Run once the connection has ended, or now if it already has.
    func onClose(_ listener: @escaping @Sendable () -> Void) async
    var isClosed: Bool { get async }
    func close() async
}

/// Neovim answered a request with an error (`[type, message]`).
public struct NeovimRPCError: Error, Equatable, CustomStringConvertible, Sendable {
    public let method: String
    public let detail: MsgpackValue

    public init(method: String, detail: MsgpackValue) {
        self.method = method
        self.detail = detail
    }

    public var description: String { "Neovim refused \(method): \(NeovimRPCError.describe(detail))" }

    static func describe(_ detail: MsgpackValue) -> String {
        if case let .array(items) = detail, items.count > 1, case let .string(message) = items[1] { return message }
        if case let .string(message) = detail { return message }
        return "\(detail)"
    }
}

/// The connection ended, or a request was not answered.
public struct NeovimConnectionError: Error, Equatable, CustomStringConvertible, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

/// How long one request may take before it is given up on.
public let neovimRequestTimeout: Duration = .seconds(5)

public actor NeovimClient: NeovimRPC {
    private let fd: Int32
    private let timeout: Duration
    private var nextId: Int64 = 1
    private var buffered: [UInt8] = []
    private var pending: [Int64: Pending] = [:]
    private var closeListeners: [@Sendable () -> Void] = []
    private var ended = false
    private var notificationListener: (@Sendable (String, [MsgpackValue]) -> Void)?

    private struct Pending {
        let method: String
        let continuation: CheckedContinuation<MsgpackValue, Error>
        let timer: Task<Void, Never>
    }

    private init(fd: Int32, timeout: Duration) {
        self.fd = fd
        self.timeout = timeout
    }

    /// Connect to a server's socket. Refused (`ECONNREFUSED`, `ENOENT`) is a
    /// `UnixStream.Failure` whose `isRefused` is true, which is how a caller
    /// tells a stale socket file from a live server.
    public static func connect(_ path: String, timeout: Duration = neovimRequestTimeout) async throws -> NeovimClient {
        let fd = try await UnixStream.offload { try UnixStream.connect(path) }
        let client = NeovimClient(fd: fd, timeout: timeout)
        await client.startReading()
        return client
    }

    private func startReading() {
        let (stream, continuation) = AsyncStream<[UInt8]>.makeStream()
        let fd = self.fd
        // The reader reads until end of stream (Neovim gone, or `close` shut
        // the socket down). The descriptor is closed by the actor once the
        // reader has finished, so a descriptor number is never reused under a
        // read, a write or a shutdown of this one.
        let thread = Thread {
            while true {
                guard let chunk = try? UnixStream.read(fd), !chunk.isEmpty else { break }
                continuation.yield(chunk)
            }
            continuation.finish()
        }
        thread.stackSize = 1 << 20
        thread.start()
        Task { [weak self] in
            for await chunk in stream {
                await self?.receive(chunk)
            }
            await self?.readerFinished()
        }
    }

    public var isClosed: Bool { ended }

    private var descriptorClosed = false

    private func readerFinished() {
        end(NeovimConnectionError("the connection to Neovim closed"))
        if !descriptorClosed {
            descriptorClosed = true
            UnixStream.close(fd)
        }
    }

    deinit {
        // A client dropped without `close`: its reader saw nothing yet, so
        // the descriptor is still this one's to close.
        if !descriptorClosed {
            UnixStream.shutdownBoth(fd)
        }
    }

    /// Neovim's notifications (`[2, method, params]`), for a client that has
    /// subscribed to some (`nvim_subscribe`, `rpcnotify`).
    public func onNotification(_ listener: @escaping @Sendable (String, [MsgpackValue]) -> Void) {
        notificationListener = listener
    }

    public func request(_ method: String, _ params: [MsgpackValue]) async throws -> MsgpackValue {
        if ended {
            throw NeovimConnectionError("the connection to Neovim is closed (\(method))")
        }
        let id = nextId
        nextId = nextId >= 0x7fff_ffff ? 1 : nextId + 1
        let bytes = try Msgpack.encode(.array([.int(0), .int(id), .string(method), .array(params)]))
        return try await withCheckedThrowingContinuation { continuation in
            let timeout = self.timeout
            let timer = Task { [weak self] in
                try? await Task.sleep(for: timeout)
                if Task.isCancelled { return }
                await self?.timedOut(id)
            }
            pending[id] = Pending(method: method, continuation: continuation, timer: timer)
            do {
                try UnixStream.write(fd, bytes)
            } catch {
                // A write to a peer that has gone: the reader is about to see
                // the end of the stream, and that is what answers this.
                _ = error
            }
        }
    }

    private func timedOut(_ id: Int64) {
        guard let waiting = pending.removeValue(forKey: id) else { return }
        waiting.continuation.resume(throwing: NeovimConnectionError("Neovim did not answer \(waiting.method) in time"))
    }

    public func onClose(_ listener: @escaping @Sendable () -> Void) {
        if ended {
            listener()
            return
        }
        closeListeners.append(listener)
    }

    public func close() {
        UnixStream.shutdownBoth(fd)
        end(NeovimConnectionError("the connection to Neovim was closed by DevHub"))
    }

    private func end(_ reason: NeovimConnectionError) {
        if ended { return }
        ended = true
        if !descriptorClosed { UnixStream.shutdownBoth(fd) }
        let waiting = pending
        pending.removeAll()
        for (_, request) in waiting {
            request.timer.cancel()
            request.continuation.resume(throwing: reason)
        }
        let listeners = closeListeners
        closeListeners.removeAll()
        for listener in listeners { listener() }
    }

    private func receive(_ chunk: [UInt8]) {
        if ended { return }
        buffered.append(contentsOf: chunk)
        var offset = 0
        while offset < buffered.count {
            let message: (value: MsgpackValue, length: Int)
            do {
                message = try Msgpack.decode(buffered[offset...])
            } catch MsgpackError.incomplete {
                break
            } catch {
                // Not msgpack-rpc: nothing more on this connection can be read.
                end(NeovimConnectionError("\(error)"))
                return
            }
            offset += message.length
            dispatch(message.value)
        }
        buffered.removeFirst(offset)
    }

    private func dispatch(_ message: MsgpackValue) {
        guard case let .array(parts) = message, let kind = parts.first?.intValue else { return }
        switch kind {
        case 1:
            guard parts.count >= 4, let id = parts[1].intValue, let waiting = pending.removeValue(forKey: id) else {
                return
            }
            waiting.timer.cancel()
            if parts[2].isNil {
                waiting.continuation.resume(returning: parts[3])
            } else {
                waiting.continuation.resume(throwing: NeovimRPCError(method: waiting.method, detail: parts[2]))
            }
        case 0:
            guard parts.count >= 2, let id = parts[1].intValue else { return }
            if let bytes = try? Msgpack.encode(.array([.int(1), .int(id), .string("DevHub answers no requests"), .nil])) {
                try? UnixStream.write(fd, bytes)
            }
        case 2:
            guard parts.count >= 3, let method = parts[1].stringValue else { return }
            notificationListener?(method, parts[2].arrayValue ?? [])
        default:
            return
        }
    }
}

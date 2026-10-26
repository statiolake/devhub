// Port of the attach half of apps/desktop/src/shell/terminal/TerminalSurface.tsx
// and shell/terminal/client.ts (`terminalInputChunks`, `terminalErrorSummary`):
// one terminal surface's binding to one PTY client, as the view's side of the
// frame contract in `TerminalAttachments`.
//
// The identity of a surface is its surface key, so an unrelated change never
// tears down the emulator or reconnects its PTY; a surface that is not on
// screen keeps its attachment and its scrollback while it waits its turn, and
// it does not report geometry, because a view that is not laid out measures as
// nothing.
//
// The frame contract is kept whole although there is no IPC hop: every frame
// names its attachment and carries a contiguous sequence; output is
// acknowledged once it has been *drawn* (fed to the emulator), which is what
// makes the window a real measure of what the view has consumed — a view that
// falls behind pauses the PTY instead of DevHub buffering for it; input is a
// strict gap-free sequence, chunked at the bound on whole code points.

import Foundation

/// The attach transport as a surface uses it (`TerminalClient`): WP3's
/// `TerminalSurfaces`, with the surface key resolved to its target.
public protocol TerminalAttachTransport: AnyObject, Sendable {
    func attach(surfaceKey: String, viewLabel: String, size: TerminalSize, sink: @escaping TerminalFrameSink) async throws
        -> TerminalAttachReceipt
    func input(_ identity: TerminalRequestIdentity, sequence: Int, _ bytes: Data) throws
    func resize(_ identity: TerminalRequestIdentity, _ size: TerminalSize) throws
    func acknowledge(_ identity: TerminalRequestIdentity, sequence: Int) throws
    func detach(_ identity: TerminalRequestIdentity) throws
}

/// `TerminalSurfaces` behind a surface-key resolver (`createSurfaceResolver`).
public final class SurfacesTransport: TerminalAttachTransport, @unchecked Sendable {
    public let surfaces: TerminalSurfaces
    private let resolve: @Sendable (String) async throws -> TerminalTarget?

    public init(surfaces: TerminalSurfaces, resolve: @escaping @Sendable (String) async throws -> TerminalTarget?) {
        self.surfaces = surfaces
        self.resolve = resolve
    }

    public func attach(surfaceKey: String, viewLabel: String, size: TerminalSize, sink: @escaping TerminalFrameSink) async throws
        -> TerminalAttachReceipt
    {
        guard let target = try await resolve(surfaceKey) else { throw TerminalFailure(.surfaceUnavailable) }
        return try await surfaces.attach(target: target, surfaceKey: surfaceKey, viewLabel: viewLabel, size: size, sink: sink)
    }

    public func input(_ identity: TerminalRequestIdentity, sequence: Int, _ bytes: Data) throws {
        try surfaces.input(identity, sequence: sequence, bytes)
    }

    public func resize(_ identity: TerminalRequestIdentity, _ size: TerminalSize) throws { try surfaces.resize(identity, size) }

    public func acknowledge(_ identity: TerminalRequestIdentity, sequence: Int) throws {
        try surfaces.acknowledge(identity, sequence: sequence)
    }

    public func detach(_ identity: TerminalRequestIdentity) throws { try surfaces.detach(identity) }
}

/// What the surface is drawing over its emulator.
public enum TerminalConnection: Equatable, Sendable {
    case connecting
    case connected
    /// The pane says it is not connected, why, and offers Retry.
    case disconnected(String)

    /// `Failure`'s headline over a disconnected pane.
    public static let notConnected = "The terminal session is not connected."
    /// `DETACHABLE_ERROR`.
    public static let unavailable = "The terminal connection is unavailable."
    /// What an `exited` frame says.
    public static let sessionEnded = "The terminal session disconnected. Retry to reconnect."
    /// What a renderer that could not be built says.
    public static let rendererUnavailable = "The terminal renderer is unavailable."
}

/// A timer the session sets, injected so a test owns the clock.
public protocol SurfaceClock: AnyObject {
    func after(_ milliseconds: Double, _ work: @escaping () -> Void) -> SurfaceTimer
}

public protocol SurfaceTimer: AnyObject {
    func cancel()
}

public enum TerminalInput {
    /// `MAX_INPUT_BYTES`.
    public static let maxBytes = 64 * 1024

    /// `terminalInputChunks`: keep a paste or a code point in one request
    /// whenever possible; split only at the bound, on a UTF-8 boundary.
    public static func chunks(_ bytes: Data, max: Int = maxBytes) -> [Data] {
        let value = [UInt8](bytes)
        var chunks: [Data] = []
        var offset = 0
        while offset < value.count {
            var end = min(value.count, offset + max)
            if end < value.count {
                while end > offset && (value[end] & 0xC0) == 0x80 { end -= 1 }
                if end == offset { end = min(value.count, offset + max) }
            }
            chunks.append(Data(value[offset..<end]))
            offset = end
        }
        return chunks
    }

    /// `terminalErrorSummary`: the words a caught failure is drawn as.
    public static func errorSummary(_ error: Error) -> String {
        (error as? TerminalFailure)?.summary ?? TerminalConnection.unavailable
    }
}

/// One mounted terminal surface's connection. Used on one thread (the main
/// thread in the app); frames from the PTY are handed to it through `deliver`.
public final class TerminalSurfaceSession: @unchecked Sendable {
    /// `HANDSHAKE_SILENCE_MS`: how long the handshake may go without a word.
    public static let handshakeSilenceMs = 5_000.0
    /// `MAX_HANDSHAKE_BUFFER_FRAMES` / `_BYTES`: frames that arrive before the
    /// attach answered.
    public static let maxHandshakeFrames = 8
    public static let maxHandshakeBytes = 256 * 1024

    public let surfaceKey: String
    public let viewLabel: String
    private let transport: TerminalAttachTransport
    private let clock: SurfaceClock
    /// Runs a frame's handling on the session's thread.
    private let deliver: @Sendable (@escaping @Sendable () -> Void) -> Void

    /// What to draw over the emulator.
    public var onConnection: ((TerminalConnection) -> Void)?
    /// Bytes for the emulator. Returns once they have been fed.
    public var onOutput: ((Data) -> Void)?
    /// A failure to put in the log (never on screen twice).
    public var onLog: ((String) -> Void)?

    public private(set) var connection: TerminalConnection = .connecting {
        didSet { if connection != oldValue { onConnection?(connection) } }
    }

    private var disposed = false
    private var serial = 0
    private var receipt: TerminalAttachReceipt?
    private var receiptDetached = false
    private var detachedIds: Set<String> = []
    private var nextInput = 0
    private var inputFailed = false
    private var watchdog: SurfaceTimer?
    private var started = false
    private var buffered: [TerminalFrame] = []
    private var bufferedBytes = 0
    private var lastSize: TerminalSize?

    public init(
        surfaceKey: String, viewLabel: String, transport: TerminalAttachTransport, clock: SurfaceClock,
        deliver: @escaping @Sendable (@escaping @Sendable () -> Void) -> Void
    ) {
        self.surfaceKey = surfaceKey
        self.viewLabel = viewLabel
        self.transport = transport
        self.clock = clock
        self.deliver = deliver
    }

    /// Whether the session holds a live attachment.
    public var isAttached: Bool { receipt != nil && !receiptDetached && connection == .connected }

    public var attachmentId: String? { receipt?.attachmentId }

    private func identity(_ receipt: TerminalAttachReceipt) -> TerminalRequestIdentity {
        receipt.identity(viewLabel: viewLabel)
    }

    // MARK: Attach

    /// Attach, or attach again: whatever was attached before is let go of
    /// first, exactly that handle.
    public func attach(size: TerminalSize) {
        if disposed { return }
        serial += 1
        let mine = serial
        if let previous = receipt, !receiptDetached { detachExact(previous) }
        receipt = nil
        receiptDetached = false
        nextInput = 0
        inputFailed = false
        started = false
        buffered = []
        bufferedBytes = 0
        lastSize = size
        connection = .connecting
        armWatchdog(mine)
        let deliver = self.deliver
        let sink: TerminalFrameSink = { [weak self] frame in
            guard self != nil else { return false }
            deliver { [weak self] in self?.receive(frame, serial: mine) }
            return true
        }
        let transport = self.transport
        let surfaceKey = self.surfaceKey, viewLabel = self.viewLabel
        Task { [weak self] in
            do {
                let receipt = try await transport.attach(surfaceKey: surfaceKey, viewLabel: viewLabel, size: size, sink: sink)
                deliver { [weak self] in
                    if let self {
                        self.attached(receipt, serial: mine)
                    } else {
                        try? transport.detach(receipt.identity(viewLabel: viewLabel))
                    }
                }
            } catch {
                deliver { [weak self] in self?.fail(mine, error) }
            }
        }
    }

    /// The attach answered.
    private func attached(_ newReceipt: TerminalAttachReceipt, serial mine: Int) {
        if disposed || mine != serial {
            detachExact(newReceipt)
            return
        }
        guard newReceipt.surfaceKey == surfaceKey, newReceipt.targetGeneration > 0 else {
            detachExact(newReceipt)
            fail(mine, TerminalFailure(.invalidRequest))
            return
        }
        receipt = newReceipt
        // Main answered: the wait for `started` gets a full budget of its own.
        if !started { armWatchdog(mine) }
        flushBuffered(mine)
    }

    private func flushBuffered(_ mine: Int) {
        guard started, let receipt, mine == serial else { return }
        cancelWatchdog()
        let frames = buffered
        buffered = []
        bufferedBytes = 0
        for frame in frames {
            if mine != serial || receiptDetached { return }
            process(frame, receipt: receipt, serial: mine)
        }
        if mine != serial || receiptDetached { return }
        connection = .connected
        // The size the pane missed while the handshake ran.
        if let lastSize { sendResize(lastSize) }
    }

    private func receive(_ frame: TerminalFrame, serial mine: Int) {
        if disposed || mine != serial { return }
        if watchdog != nil { armWatchdog(mine) }
        if case let .started(attachmentId, frameKey, generation, _, _) = frame {
            if let receipt, receipt.attachmentId != attachmentId || frameKey != surfaceKey || receipt.targetGeneration != generation {
                fail(mine, TerminalFailure(.wrongAttachment))
                return
            }
            started = true
            flushBuffered(mine)
            return
        }
        guard let receipt, started, connection == .connected else {
            if case let .error(_, _, error) = frame, receipt == nil {
                fail(mine, error)
                return
            }
            if buffered.count >= Self.maxHandshakeFrames { return fail(mine, TerminalFailure(.backpressure)) }
            if case let .output(_, _, bytes) = frame {
                if bufferedBytes + bytes.count > Self.maxHandshakeBytes { return fail(mine, TerminalFailure(.backpressure)) }
                bufferedBytes += bytes.count
            }
            buffered.append(frame)
            return
        }
        process(frame, receipt: receipt, serial: mine)
    }

    private func process(_ frame: TerminalFrame, receipt: TerminalAttachReceipt, serial mine: Int) {
        switch frame {
        case .started:
            return
        case let .output(attachmentId, sequence, bytes):
            guard attachmentId == receipt.attachmentId else { return fail(mine, TerminalFailure(.wrongAttachment)) }
            onOutput?(bytes)
            // Acknowledged once drawn: the window measures what the view consumed.
            if disposed || mine != serial || self.receipt != receipt || receiptDetached { return }
            do {
                try transport.acknowledge(identity(receipt), sequence: sequence)
            } catch {
                fail(mine, error)
            }
        case let .error(attachmentId, _, error):
            guard attachmentId == receipt.attachmentId else { return }
            fail(mine, error)
        case let .exited(attachmentId, _, _):
            guard attachmentId == receipt.attachmentId else { return }
            connection = .disconnected(TerminalConnection.sessionEnded)
            detachExact(receipt)
        }
    }

    private func fail(_ mine: Int, _ error: Error) {
        if disposed || mine != serial { return }
        cancelWatchdog()
        inputFailed = true
        connection = .disconnected(TerminalInput.errorSummary(error))
        if let receipt, !receiptDetached { detachExact(receipt) }
    }

    private func detachExact(_ target: TerminalAttachReceipt) {
        if detachedIds.contains(target.attachmentId) { return }
        detachedIds.insert(target.attachmentId)
        if receipt == target { receiptDetached = true }
        do {
            try transport.detach(identity(target))
        } catch {
            onLog?("[devhub] terminal \(surfaceKey): detach failed: \(TerminalInput.errorSummary(error))")
        }
    }

    // MARK: Silence

    private func armWatchdog(_ mine: Int) {
        watchdog?.cancel()
        watchdog = clock.after(Self.handshakeSilenceMs) { [weak self] in
            guard let self, mine == self.serial, !self.disposed else { return }
            self.watchdog = nil
            if self.connection == .connected { return }
            self.fail(mine, TerminalFailure(.runtimeTimedOut, summary: TerminalConnection.unavailable))
        }
    }

    private func cancelWatchdog() {
        watchdog?.cancel()
        watchdog = nil
    }

    // MARK: Input, size

    /// What the person typed, in order. Ignored while not connected.
    public func input(_ bytes: Data) {
        guard let receipt, !receiptDetached, connection == .connected, !inputFailed, !disposed else { return }
        for chunk in TerminalInput.chunks(bytes) where !chunk.isEmpty {
            nextInput += 1
            do {
                try transport.input(identity(receipt), sequence: nextInput, chunk)
            } catch {
                fail(serial, error)
                return
            }
        }
    }

    /// The host changed size. Sent only when it did, and only while attached.
    public func resize(_ size: TerminalSize) {
        guard size.isValid else { return }
        if size == lastSize, connection == .connected { return }
        lastSize = size
        guard connection == .connected else { return }
        sendResize(size)
    }

    private func sendResize(_ size: TerminalSize) {
        guard let receipt, !receiptDetached, !disposed else { return }
        do {
            try transport.resize(identity(receipt), size)
        } catch {
            fail(serial, error)
        }
    }

    /// Retry: a fresh attach at the last size.
    public func retry() {
        attach(size: lastSize ?? TerminalSize(cols: 80, rows: 24))
    }

    /// Coming back on screen is a request to use the pane: one that is
    /// disconnected reconnects once, on the transition, and on nothing else.
    public func cameOnScreen() {
        if case .disconnected = connection { retry() }
    }

    /// The view is going away: let go of exactly the handle it holds.
    public func dispose() {
        if disposed { return }
        disposed = true
        serial += 1
        cancelWatchdog()
        if let receipt, !receiptDetached { detachExact(receipt) }
        receipt = nil
    }
}

/// Real time, on the main queue.
public final class DispatchSurfaceClock: SurfaceClock {
    private let queue: DispatchQueue

    public init(queue: DispatchQueue = .main) { self.queue = queue }

    private final class Item: SurfaceTimer {
        let work: DispatchWorkItem
        init(_ work: DispatchWorkItem) { self.work = work }
        func cancel() { work.cancel() }
    }

    public func after(_ milliseconds: Double, _ work: @escaping () -> Void) -> SurfaceTimer {
        let item = DispatchWorkItem(block: work)
        queue.asyncAfter(deadline: .now() + milliseconds / 1000, execute: item)
        return Item(item)
    }
}

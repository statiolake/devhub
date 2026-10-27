// Port of apps/desktop/src/main/terminal/attachments.ts, surfaces.ts and the
// terminal error vocabulary of ipc/terminal.ts — the attach transport for
// DevHub's own terminal surfaces.
//
// A *surface* is a semantic place a terminal lives (one workspace's editor
// terminal, an Agent, an Agent's terminal); an *attachment* is one surface's
// live binding to a PTY running `tmux attach-session`, named by an unguessable
// handle and a generation. The view can only act on the attachment it was
// given: a request that names an attachment it does not own is refused rather
// than resolved to "the current one".
//
// **Who owns an attachment is the (window, surface) pair.** A window holds as
// many attachments as it has terminal surfaces, a second attach of the same
// surface supersedes only itself, and the window label is what a closing
// window releases as a group.
//
// This module owns only short-lived tmux *client* processes and their PTY
// file descriptors. Detaching kills the client; the tmux session belongs to
// the runtime and survives untouched. That is what makes a terminal outlive
// the window, and the app.
//
// **Output is coalesced here** for 5 ms before it reaches the sink, as VS
// Code's pty host does (`TerminalDataBufferer`), so a view never paints the
// intermediate states of one curses redraw; pending bytes are flushed before
// an error or an exit, so nothing a child printed appears after the news that
// it is gone.
//
// The frame contract is the TS one, kept whole although there is no IPC hop:
// output frames carry a contiguous sequence, never exceed
// `maxOutputFrameBytes`, and are metered by a cumulative-ack window — a view
// that falls behind (SwiftTerm feeding on the main thread) pauses the PTY
// instead of this process buffering for it. Input is a strict gap-free
// sequence. The sink is called on whichever queue delivered the PTY's bytes.

import Foundation

/// Why a terminal request was refused (`TerminalErrorCode`).
public enum TerminalErrorCode: String, Sendable, Equatable, CaseIterable {
    case invalidRequest = "invalid_request"
    case invalidSurface = "invalid_surface"
    case surfaceUnavailable = "surface_unavailable"
    case staleTarget = "stale_target"
    case wrongAttachment = "wrong_attachment"
    case attachmentLimit = "attachment_limit"
    case sessionUnavailable = "session_unavailable"
    case ptyUnavailable = "pty_unavailable"
    case inputTooLarge = "input_too_large"
    case invalidResize = "invalid_resize"
    case channelClosed = "channel_closed"
    case backpressure
    case runtimeUnavailable = "runtime_unavailable"
    case runtimeTimedOut = "runtime_timed_out"
    case runtimeIncompatible = "runtime_incompatible"
    case workspaceClosing = "workspace_closing"
    case workspaceRootMissing = "workspace_root_missing"
    case workspaceRootInaccessible = "workspace_root_inaccessible"
    case `internal`

    /// The stock sentence (`ERROR_SUMMARIES`), verbatim.
    public var summary: String {
        switch self {
        case .invalidRequest: return "The terminal request is invalid."
        case .invalidSurface: return "The selected terminal surface is invalid."
        case .surfaceUnavailable: return "The selected terminal surface is unavailable."
        case .staleTarget: return "The terminal target is stale."
        case .wrongAttachment: return "The terminal attachment is not owned by this view."
        case .attachmentLimit: return "This terminal surface already has an attachment."
        case .sessionUnavailable: return "The terminal session is unavailable."
        case .ptyUnavailable: return "The terminal client could not be attached."
        case .inputTooLarge: return "Terminal input exceeded the allowed size."
        case .invalidResize: return "The terminal size is invalid."
        case .channelClosed: return "The terminal view is disconnected."
        case .backpressure: return "Terminal output exceeded the view buffer."
        case .runtimeUnavailable: return "The terminal runtime is unavailable."
        case .runtimeTimedOut: return "The terminal runtime did not answer in time."
        case .runtimeIncompatible: return "This version of tmux is not supported."
        case .workspaceClosing: return "This workspace is closing."
        case .workspaceRootMissing: return "The workspace folder no longer exists."
        case .workspaceRootInaccessible: return "The workspace folder cannot be read."
        case .internal: return "The terminal runtime could not complete the request."
        }
    }
}

/// The one failure type the terminal raises.
public struct TerminalFailure: Error, Sendable, Equatable, CustomStringConvertible {
    public let code: TerminalErrorCode
    public let summary: String
    /// Why, on this side: the cause stays here, where the log can read it,
    /// and never reaches the wire. Not part of what makes two equal.
    public let cause: String?

    public static func == (left: TerminalFailure, right: TerminalFailure) -> Bool {
        left.code == right.code && left.summary == right.summary
    }

    /// How long a summary may be (`MAX_ERROR_SUMMARY_BYTES`).
    public static let maxSummaryBytes = 256

    /// - Parameter summary: a sentence that replaces the code's stock summary,
    ///   for a failure whose stock words leave out the whole diagnostic.
    public init(_ code: TerminalErrorCode, summary: String? = nil, cause: (any Error)? = nil) {
        self.code = code
        self.summary = TerminalFailure.bounded(summary ?? code.summary)
        self.cause = cause.map { String(describing: $0) }
    }

    /// Fit a summary inside the bound, on whole code points.
    static func bounded(_ summary: String) -> String {
        if summary.utf8.count <= maxSummaryBytes { return summary }
        let budget = maxSummaryBytes - "…".utf8.count
        var kept = ""
        var bytes = 0
        for scalar in summary.unicodeScalars {
            let width = String(scalar).utf8.count
            if bytes + width > budget { break }
            kept.unicodeScalars.append(scalar)
            bytes += width
        }
        return kept + "…"
    }

    public var description: String { summary }

    /// A runtime failure as the view sees it: the single place a
    /// provider-level reason is translated into the terminal vocabulary
    /// (`terminalFailureFromPort`).
    public static func from(_ failure: any Error) -> TerminalFailure {
        if let terminal = failure as? TerminalFailure { return terminal }
        guard let port = failure as? PortFailure else { return TerminalFailure(.internal, cause: failure) }
        // The port's detail, where it has one, is the sentence.
        let summary = port.detail
        switch port.code {
        case .unavailable, .socketPathTooLong, .socketUnusable: return TerminalFailure(.runtimeUnavailable, summary: summary)
        // Not "unavailable": a command that ran out of its budget says nothing
        // about whether the runtime is there — it is usually there and busy.
        case .timedOut: return TerminalFailure(.runtimeTimedOut, summary: summary)
        case .incompatible: return TerminalFailure(.runtimeIncompatible, summary: summary)
        // The workspace's own folder, not the runtime.
        case .rootMissing: return TerminalFailure(.workspaceRootMissing, summary: summary)
        case .rootInaccessible: return TerminalFailure(.workspaceRootInaccessible, summary: summary)
        case .conflict: return TerminalFailure(.sessionUnavailable, summary: summary)
        case .cancelled: return TerminalFailure(.staleTarget, summary: summary)
        case .failed: return TerminalFailure(.internal, summary: summary)
        }
    }
}

/// How an attachment ended (`ExitReason`).
public enum TerminalExitReason: String, Sendable, Equatable {
    case eof, detached, childExited
}

/// What an attachment tells its view, in order. Every frame names its
/// attachment and carries a contiguous sequence: `started` is 0, every frame
/// after it one more.
public enum TerminalFrame: Sendable, Equatable {
    case started(attachmentId: String, surfaceKey: String, targetGeneration: Int, cols: Int, rows: Int)
    case output(attachmentId: String, sequence: Int, bytes: Data)
    case error(attachmentId: String, sequence: Int, error: TerminalFailure)
    case exited(attachmentId: String, sequence: Int, reason: TerminalExitReason)

    public var sequence: Int {
        switch self {
        case .started: return 0
        case .output(_, let sequence, _), .error(_, let sequence, _), .exited(_, let sequence, _): return sequence
        }
    }

    /// `started`, `output`, `error` or `exited`, as the wire names them.
    public var type: String {
        switch self {
        case .started: return "started"
        case .output: return "output"
        case .error: return "error"
        case .exited: return "exited"
        }
    }
}

/// The view's end of one attachment.
///
/// It answers whether the frame was delivered rather than throwing, because a
/// view that has gone away is not an error to report — it is the one
/// condition under which this side stops the PTY on its own.
public typealias TerminalFrameSink = @Sendable (TerminalFrame) -> Bool

/// The identity every non-attach request must present: the surface key and
/// the window label name the owner, and the attachment id and generation name
/// the exact client it was handed. All four must match: a stale handle is
/// refused, never resolved to whatever is current.
public struct TerminalRequestIdentity: Sendable, Equatable {
    public var surfaceKey: String
    public var attachmentId: String
    public var viewLabel: String
    public var targetGeneration: Int
    public init(surfaceKey: String, attachmentId: String, viewLabel: String, targetGeneration: Int) {
        self.surfaceKey = surfaceKey
        self.attachmentId = attachmentId
        self.viewLabel = viewLabel
        self.targetGeneration = targetGeneration
    }
}

/// What an attach answers with.
public struct TerminalAttachReceipt: Sendable, Equatable {
    public var attachmentId: String
    public var surfaceKey: String
    public var targetGeneration: Int

    public func identity(viewLabel: String) -> TerminalRequestIdentity {
        TerminalRequestIdentity(surfaceKey: surfaceKey, attachmentId: attachmentId, viewLabel: viewLabel, targetGeneration: targetGeneration)
    }
}

/// A place in the in-flight ledger. Holding one is what makes an attach
/// publishable; a newer attach for the same owner or target cancels it.
public final class AttachPermit: @unchecked Sendable {
    public let cancel: CancellationToken
    private let onRelease: () -> Void
    private let lock = NSLock()
    private var released = false

    init(cancel: CancellationToken, onRelease: @escaping () -> Void) {
        self.cancel = cancel
        self.onRelease = onRelease
    }

    public func release() {
        let first: Bool = lock.withLock {
            if released { return false }
            released = true
            return true
        }
        if first { onRelease() }
    }
}

/// Everything an attach needs once its session has been verified.
public struct AttachContext: Sendable {
    public var surfaceKey: String
    /// The window this surface is mounted in: one window holds several.
    public var viewLabel: String
    /// The semantic terminal this attachment is a client of.
    public var target: TerminalTarget
    /// Where the tmux client is opened: on the machine its session is on.
    public var spawn: PtyFactory
    /// The tmux client to run, resolved against an exact marked session.
    public var file: String
    public var args: [String]
    /// The client's working directory: the launch home, never a workspace.
    public var cwd: String
    /// The environment this client runs in, whole.
    public var environment: [String: String]
    public var size: TerminalSize
    public var sink: TerminalFrameSink

    public init(
        surfaceKey: String, viewLabel: String, target: TerminalTarget, spawn: @escaping PtyFactory,
        file: String, args: [String], cwd: String, environment: [String: String],
        size: TerminalSize, sink: @escaping TerminalFrameSink
    ) {
        self.surfaceKey = surfaceKey
        self.viewLabel = viewLabel
        self.target = target
        self.spawn = spawn
        self.file = file
        self.args = args
        self.cwd = cwd
        self.environment = environment
        self.size = size
        self.sink = sink
    }
}

/// Who owns an attachment: one terminal surface inside one window.
public func surfaceOwnerKey(viewLabel: String, surfaceKey: String) -> String { "\(viewLabel)\u{0}\(surfaceKey)" }

/// The terminal transport's bounds (`ipc/terminal.ts` and `attachments.ts`).
public enum TerminalTransport {
    public static let maxOutputFrameBytes = 32 * 1024
    public static let maxOutputBufferBytes = 256 * 1024
    public static let maxInputSequence = 9_007_199_254_740_991
    public static let maxTargetGeneration = maxInputSequence
    /// Latest-wins resize, at most this often.
    public static let resizeIntervalMs = 16.0
    public static let maxInFlightFrames = 8
    public static let maxInFlightBytes = maxOutputBufferBytes
    public static let flowControlTimeoutMs = 2_000.0
    /// Output already read from the PTY but not yet sendable, bounded like
    /// the window.
    public static let maxQueuedOutputBytes = maxOutputBufferBytes
    /// How long the reads of one redraw are gathered before they become a
    /// frame: VS Code's pty host's `TerminalDataBufferer` number, under a frame
    /// at 120 Hz.
    public static let outputCoalesceMs = 5.0
}

/// A timer the attachments set, injected so a test owns the clock.
public protocol AttachmentTimer: Sendable {
    func cancel()
}

public protocol AttachmentScheduler: Sendable {
    func after(_ milliseconds: Double, _ work: @escaping @Sendable () -> Void) -> any AttachmentTimer
}

/// Real time, on a dispatch queue.
public struct DispatchAttachmentScheduler: AttachmentScheduler {
    let queue: DispatchQueue
    public init(queue: DispatchQueue = DispatchQueue(label: "devhub.attachments")) { self.queue = queue }

    final class Item: AttachmentTimer, @unchecked Sendable {
        let work: DispatchWorkItem
        init(_ work: DispatchWorkItem) { self.work = work }
        func cancel() { work.cancel() }
    }

    public func after(_ milliseconds: Double, _ work: @escaping @Sendable () -> Void) -> any AttachmentTimer {
        let item = DispatchWorkItem(block: work)
        queue.asyncAfter(deadline: .now() + .microseconds(Int(milliseconds * 1000)), execute: item)
        return Item(item)
    }
}

/// The cumulative-ack window that keeps output from running ahead of the view.
public final class FlowControl: @unchecked Sendable {
    private var pending: [(sequence: Int, bytes: Int)] = []
    private var sent = 0
    private var closed = false

    public init() {}

    public var lastSent: Int { sent }
    public var inFlightBytes: Int { pending.reduce(0) { $0 + $1.bytes } }
    public var inFlightFrames: Int { pending.count }

    /// Claim window credit for one output frame. `false` means the view has
    /// not consumed enough yet — never that the frame was dropped.
    public func reserve(_ sequence: Int, bytes: Int) throws -> Bool {
        if sequence < 1 || sequence > TerminalTransport.maxInputSequence { throw TerminalFailure(.invalidRequest) }
        if bytes > TerminalTransport.maxOutputFrameBytes { throw TerminalFailure(.backpressure) }
        if closed { throw TerminalFailure(.channelClosed) }
        if pending.count >= TerminalTransport.maxInFlightFrames || inFlightBytes + bytes > TerminalTransport.maxInFlightBytes {
            return false
        }
        pending.append((sequence, bytes))
        sent = sequence
        return true
    }

    /// Cumulative: everything up to and including `sequence` leaves the window.
    @discardableResult
    public func acknowledge(_ sequence: Int) throws -> Bool {
        if sequence < 1 || sequence > TerminalTransport.maxInputSequence { throw TerminalFailure(.invalidRequest) }
        if sequence > sent { throw TerminalFailure(.invalidRequest) }
        let completed = pending.filter { $0.sequence <= sequence }.reduce(0) { $0 + $1.bytes }
        pending.removeAll { $0.sequence <= sequence }
        return completed > 0
    }

    public func close() {
        closed = true
        pending = []
    }
}

/// One surface's live binding to a PTY. Every method runs under the
/// manager's lock, which is the TS app's single thread.
final class TerminalAttachment: @unchecked Sendable {
    let id: String
    let surfaceKey: String
    let viewLabel: String
    let target: TerminalTarget
    let targetGeneration: Int
    let flow = FlowControl()
    private let pty: any PseudoTerminal
    private let sink: TerminalFrameSink
    private let scheduler: any AttachmentScheduler
    private let lock: NSRecursiveLock
    private let onFinished: (TerminalAttachment, TerminalExitReason) -> Void
    private var sequence = 0
    private var lastInputSequence = 0
    private(set) var stopped = false
    private var queue: [Data] = []
    private var queuedBytes = 0
    private var pending: [Data] = []
    private var pendingBytes = 0
    private var coalesceTimer: (any AttachmentTimer)?
    private var backpressureTimer: (any AttachmentTimer)?
    private var resizePending: TerminalSize?
    private var resizeTimer: (any AttachmentTimer)?
    private var paused = false

    init(
        id: String, surfaceKey: String, viewLabel: String, target: TerminalTarget, targetGeneration: Int,
        pty: any PseudoTerminal, sink: @escaping TerminalFrameSink, scheduler: any AttachmentScheduler,
        lock: NSRecursiveLock, onFinished: @escaping (TerminalAttachment, TerminalExitReason) -> Void
    ) {
        self.id = id
        self.surfaceKey = surfaceKey
        self.viewLabel = viewLabel
        self.target = target
        self.targetGeneration = targetGeneration
        self.pty = pty
        self.sink = sink
        self.scheduler = scheduler
        self.lock = lock
        self.onFinished = onFinished
    }

    var pendingResize: TerminalSize? { lock.withLock { resizePending } }

    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    /// Hand the view a frame. A view that is gone ends the attachment; there
    /// is no state in which output keeps being produced for nobody.
    @discardableResult
    private func emit(_ frame: TerminalFrame) -> Bool {
        if sink(frame) { return true }
        stop(.detached)
        return false
    }

    func sendStarted(_ size: TerminalSize) throws {
        try locked {
            if !emit(.started(attachmentId: id, surfaceKey: surfaceKey, targetGeneration: targetGeneration, cols: size.cols, rows: size.rows)) {
                throw TerminalFailure(.channelClosed)
            }
        }
    }

    /// PTY output, gathered for `outputCoalesceMs` before it becomes a frame.
    /// A read that already fills a frame has nothing to wait for, so the bound
    /// is also a flush: what is pending goes out at once, tail included.
    func acceptOutput(_ bytes: Data) {
        locked {
            if stopped || bytes.isEmpty { return }
            pending.append(bytes)
            pendingBytes += bytes.count
            if pendingBytes >= TerminalTransport.maxOutputFrameBytes {
                flushPending()
                return
            }
            if coalesceTimer == nil {
                coalesceTimer = scheduler.after(TerminalTransport.outputCoalesceMs) { [weak self] in
                    guard let self else { return }
                    self.locked { self.flushPending() }
                }
            }
        }
    }

    /// Turn everything pending into frames, now. Pending bytes are taken
    /// before any of them is sent, so a failure raised while sending finds
    /// nothing left to flush and cannot recurse.
    private func flushPending() {
        coalesceTimer?.cancel()
        coalesceTimer = nil
        if pending.isEmpty { return }
        var bytes = Data(capacity: pendingBytes)
        for chunk in pending { bytes.append(chunk) }
        pending = []
        pendingBytes = 0
        sendOutput(bytes)
    }

    /// Coalesced output, split at the frame bound and metered by the window.
    private func sendOutput(_ bytes: Data) {
        var offset = 0
        while offset < bytes.count {
            let end = min(bytes.count, offset + TerminalTransport.maxOutputFrameBytes)
            let chunk = bytes.subdata(in: offset..<end)
            offset = end
            if !queue.isEmpty {
                enqueue(chunk)
                continue
            }
            if !trySend(chunk) { enqueue(chunk) }
        }
        updatePause()
    }

    private func trySend(_ chunk: Data) -> Bool {
        let next = sequence + 1
        let reserved: Bool
        do {
            reserved = try flow.reserve(next, bytes: chunk.count)
        } catch {
            // The window itself refused the frame (oversized, or closed).
            failWith(error)
            return true
        }
        if !reserved { return false }
        sequence = next
        emit(.output(attachmentId: id, sequence: next, bytes: chunk))
        return true
    }

    private func enqueue(_ chunk: Data) {
        if queuedBytes + chunk.count > TerminalTransport.maxQueuedOutputBytes {
            failWith(TerminalFailure(.backpressure))
            return
        }
        queue.append(chunk)
        queuedBytes += chunk.count
        if backpressureTimer == nil {
            // A view that stops acknowledging is not throttled forever: it is
            // disconnected.
            backpressureTimer = scheduler.after(TerminalTransport.flowControlTimeoutMs) { [weak self] in
                guard let self else { return }
                self.locked {
                    self.backpressureTimer = nil
                    self.failWith(TerminalFailure(.backpressure))
                }
            }
        }
    }

    private func drain() {
        while let chunk = queue.first {
            if !trySend(chunk) { return }
            if stopped { return }
            queue.removeFirst()
            queuedBytes -= chunk.count
        }
        backpressureTimer?.cancel()
        backpressureTimer = nil
    }

    /// The PTY is paused while output is queued, so the child blocks on a full
    /// buffer instead of this process growing one.
    private func updatePause() {
        if stopped { return }
        let shouldPause = !queue.isEmpty
        if shouldPause == paused { return }
        paused = shouldPause
        if shouldPause { pty.pause() } else { pty.resume() }
    }

    func acknowledge(_ sequence: Int) throws {
        try locked {
            if stopped { throw TerminalFailure(.wrongAttachment) }
            try flow.acknowledge(sequence)
            drain()
            updatePause()
        }
    }

    /// Input is a strict, gap-free sequence: a replayed or reordered request
    /// is impossible to mistake for the next keystroke.
    func acceptInput(_ sequence: Int, _ bytes: Data) throws {
        try locked {
            if stopped { throw TerminalFailure(.wrongAttachment) }
            if sequence != lastInputSequence + 1 { throw TerminalFailure(.invalidRequest) }
            lastInputSequence = sequence
            pty.write(bytes)
        }
    }

    /// Latest-wins resize with a floor on how often the PTY is resized.
    func requestResize(_ size: TerminalSize) throws {
        try locked {
            if stopped { throw TerminalFailure(.wrongAttachment) }
            if !size.isValid { throw TerminalFailure(.invalidResize) }
            resizePending = size
            if resizeTimer != nil { return }
            resizeTimer = scheduler.after(TerminalTransport.resizeIntervalMs) { [weak self] in
                guard let self else { return }
                self.locked {
                    self.resizeTimer = nil
                    let next = self.resizePending
                    self.resizePending = nil
                    if let next, !self.stopped { self.pty.resize(next) }
                }
            }
        }
    }

    private func failWith(_ failure: any Error) {
        if stopped { return }
        // Whatever the child printed before the failure precedes the news of it.
        flushPending()
        if stopped { return }
        let code = (failure as? TerminalFailure)?.code ?? .internal
        sequence += 1
        _ = sink(.error(attachmentId: id, sequence: sequence, error: TerminalFailure(code)))
        stop(.detached)
    }

    /// The PTY ended on its own.
    func handleExit() {
        locked {
            if stopped { return }
            finish(.eof)
        }
    }

    /// DevHub ended it: a detach, a replacement, a closed window, or quit.
    func stop(_ reason: TerminalExitReason = .detached) {
        locked {
            if stopped { return }
            finish(reason)
        }
    }

    private func finish(_ reason: TerminalExitReason) {
        // Stopped first, so the flush below cannot re-enter this through a
        // failure; then the flush, so the last of the output is out before the
        // frame that says there will be no more. What the window has no room
        // for is dropped here exactly as the queue is.
        stopped = true
        flushPending()
        resizeTimer?.cancel()
        resizeTimer = nil
        resizePending = nil
        backpressureTimer?.cancel()
        backpressureTimer = nil
        queue = []
        queuedBytes = 0
        flow.close()
        sequence += 1
        _ = sink(.exited(attachmentId: id, sequence: sequence, reason: reason))
        pty.kill()
        onFinished(self, reason)
    }
}

public final class AttachmentManager: @unchecked Sendable {
    private struct InFlight {
        let ownerKey: String
        let viewLabel: String
        let target: TerminalTarget
        let cancel: CancellationToken
    }

    /// The one lock every attachment's state is changed under: the TS app's
    /// single thread, recursive because a sink may answer synchronously.
    private let lock = NSRecursiveLock()
    private var attachments: [String: TerminalAttachment] = [:]
    private var order: [String] = []
    private var inFlight: [Int: InFlight] = [:]
    private var nextAttachKey = 1
    private var generation: Int
    private let spawn: PtyFactory?
    private let randomBytes: @Sendable (Int) -> [UInt8]
    private let scheduler: any AttachmentScheduler
    private var endedByItself: (@Sendable (String, TerminalTarget) -> Void)?

    /// A client ended on its own (`eof`): its PTY closed without DevHub
    /// stopping it — the session it showed ended (its last shell exited, it
    /// was killed), or the person detached from it with tmux's own keys.
    /// Everything DevHub ends itself — a detach, a replacement, a closed view,
    /// a close, a socket move, quit — stops the client first, as `detached`,
    /// and is not told here. Called under the attachments' lock with the
    /// surface key and the target: hop off it before doing anything.
    public var onEndedByItself: (@Sendable (_ surfaceKey: String, _ target: TerminalTarget) -> Void)? {
        get { locked { endedByItself } }
        set { locked { endedByItself = newValue } }
    }

    /// - Parameter spawn: overridden only by tests; production opens the
    ///   target machine's PTY through the attach context.
    public init(
        spawn: PtyFactory? = nil,
        randomBytes: (@Sendable (Int) -> [UInt8])? = nil,
        scheduler: (any AttachmentScheduler)? = nil
    ) {
        self.spawn = spawn
        let random = randomBytes ?? { count in
            var generator = SystemRandomNumberGenerator()
            return (0..<count).map { _ in UInt8.random(in: 0...255, using: &generator) }
        }
        self.randomBytes = random
        self.scheduler = scheduler ?? DispatchAttachmentScheduler()
        // The ledger starts somewhere unguessable, so a generation from one run
        // of the app is not a usable capability in the next. Six bytes:
        // unguessable, and still an exact integer.
        var value = 0
        for byte in random(6) { value = value * 256 + Int(byte) }
        generation = (value % TerminalTransport.maxTargetGeneration) + 1
    }

    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    public var count: Int { locked { attachments.count } }

    /// Claim the in-flight ledger for one attach. An owner — one surface of
    /// one window — has one attach at a time, so an older attach by the same
    /// owner, or for the same terminal, is superseded here, before either can
    /// publish. The superseded entry stays in the ledger until its permit is
    /// released, which is what gives its publisher a definitive stale answer.
    public func beginAttach(target: TerminalTarget, surfaceKey: String, viewLabel: String, cancel: CancellationToken) throws -> AttachPermit {
        try cancel.check()
        let ownerKey = surfaceOwnerKey(viewLabel: viewLabel, surfaceKey: surfaceKey)
        let operation = cancel.child()
        let (key, superseded): (Int, [CancellationToken]) = locked {
            let key = nextAttachKey
            nextAttachKey += 1
            let superseded = inFlight.values.filter { $0.ownerKey == ownerKey || $0.target.same(as: target) }.map(\.cancel)
            inFlight[key] = InFlight(ownerKey: ownerKey, viewLabel: viewLabel, target: target, cancel: operation)
            return (key, superseded)
        }
        for token in superseded { token.cancel() }
        return AttachPermit(cancel: operation) { [weak self] in
            guard let self else { return }
            self.locked { _ = self.inFlight.removeValue(forKey: key) }
        }
    }

    private func isCurrent(_ permit: AttachPermit) -> Bool {
        if permit.cancel.isCancelled { return false }
        return inFlight.values.contains { $0.cancel === permit.cancel }
    }

    /// Publish one resolved client as this surface's attachment.
    ///
    /// Everything from here to the receipt happens under the lock: the child
    /// is spawned, registered and given its Started frame without another
    /// attach interleaving with it.
    public func attach(_ permit: AttachPermit, _ context: AttachContext) throws -> TerminalAttachReceipt {
        try locked {
            if !isCurrent(permit) { throw TerminalFailure(.staleTarget) }
            // One attachment per surface: a surface that remounts replaces its
            // own client and nobody else's, reaped before the new PTY exists.
            for id in order {
                if let existing = attachments[id], existing.surfaceKey == context.surfaceKey { existing.stop(.detached) }
            }
            let id = randomBytes(16).map { String(format: "%02x", $0) }.joined()
            let targetGeneration = generation
            generation = generation >= TerminalTransport.maxTargetGeneration ? 1 : generation + 1
            let pty: any PseudoTerminal
            do {
                pty = try (spawn ?? context.spawn)(PtyLaunch(
                    file: context.file, args: context.args, cwd: context.cwd,
                    cols: context.size.cols, rows: context.size.rows,
                    pixelWidth: context.size.pixelWidth, pixelHeight: context.size.pixelHeight,
                    env: context.environment
                ))
            } catch {
                // The view asked for a terminal and there is none. Tell it in
                // the same shape a later failure would take, then refuse.
                _ = context.sink(.error(attachmentId: id, sequence: 0, error: TerminalFailure(.ptyUnavailable)))
                _ = context.sink(.exited(attachmentId: id, sequence: 1, reason: .childExited))
                throw (error as? TerminalFailure) ?? TerminalFailure(.ptyUnavailable, cause: error)
            }
            // Nothing may reach the view before its receipt's Started frame:
            // the PTY is held paused until Started is out.
            pty.pause()
            let attachment = TerminalAttachment(
                id: id, surfaceKey: context.surfaceKey, viewLabel: context.viewLabel,
                target: context.target, targetGeneration: targetGeneration,
                pty: pty, sink: context.sink, scheduler: scheduler, lock: lock
            ) { [weak self] finished, reason in
                guard let self else { return }
                if self.attachments[finished.id] === finished {
                    self.attachments[finished.id] = nil
                    self.order.removeAll { $0 == finished.id }
                }
                if reason == .eof, let ended = self.endedByItself {
                    ended(finished.surfaceKey, finished.target)
                }
            }
            pty.onData { [weak attachment] bytes in attachment?.acceptOutput(bytes) }
            pty.onExit { [weak attachment] _ in attachment?.handleExit() }
            attachments[id] = attachment
            order.append(id)
            try attachment.sendStarted(context.size)
            pty.resume()
            return TerminalAttachReceipt(attachmentId: id, surfaceKey: context.surfaceKey, targetGeneration: targetGeneration)
        }
    }

    public func input(_ identity: TerminalRequestIdentity, sequence: Int, _ bytes: Data) throws {
        try owned(identity).acceptInput(sequence, bytes)
    }

    public func resize(_ identity: TerminalRequestIdentity, _ size: TerminalSize) throws {
        try owned(identity).requestResize(size)
    }

    public func acknowledge(_ identity: TerminalRequestIdentity, sequence: Int) throws {
        try owned(identity).acknowledge(sequence)
    }

    /// Idempotent for the exact handle; a different handle is never inferred.
    public func detach(_ identity: TerminalRequestIdentity) throws {
        try locked {
            guard let existing = attachments[identity.attachmentId] else { return }
            if existing.surfaceKey != identity.surfaceKey || existing.viewLabel != identity.viewLabel
                || existing.targetGeneration != identity.targetGeneration {
                throw TerminalFailure(.wrongAttachment)
            }
            existing.stop(.detached)
        }
    }

    /// Every client a window holds goes, and every attach it has in flight is
    /// cancelled: a window closing.
    public func detachView(_ viewLabel: String) {
        let tokens: [CancellationToken] = locked { inFlight.values.filter { $0.viewLabel == viewLabel }.map(\.cancel) }
        for token in tokens { token.cancel() }
        locked {
            for id in order {
                if let attachment = attachments[id], attachment.viewLabel == viewLabel { attachment.stop(.detached) }
            }
        }
    }

    /// Every client of one terminal goes, before its session is closed. The
    /// session itself is the runtime's to kill, never this module's.
    public func detachTarget(_ target: TerminalTarget) {
        let tokens: [CancellationToken] = locked { inFlight.values.filter { $0.target.same(as: target) }.map(\.cancel) }
        for token in tokens { token.cancel() }
        locked {
            for id in order {
                if let attachment = attachments[id], attachment.target.same(as: target) { attachment.stop(.detached) }
            }
        }
    }

    public func detachAll() {
        let tokens: [CancellationToken] = locked { inFlight.values.map(\.cancel) }
        for token in tokens { token.cancel() }
        locked {
            for id in order { attachments[id]?.stop(.detached) }
        }
    }

    private func owned(_ identity: TerminalRequestIdentity) throws -> TerminalAttachment {
        try locked {
            guard let attachment = attachments[identity.attachmentId],
                  attachment.surfaceKey == identity.surfaceKey, attachment.viewLabel == identity.viewLabel,
                  attachment.targetGeneration == identity.targetGeneration
            else { throw TerminalFailure(.wrongAttachment) }
            return attachment
        }
    }

    /// For tests: the resize waiting to be applied to one attachment.
    func queuedResize(_ attachmentId: String) -> TerminalSize? {
        locked { attachments[attachmentId] }?.pendingResize
    }
}

/// What a client DevHub does not run itself is told to run
/// (`TerminalProfileAnswer`).
public struct TerminalProfileAnswer: Sendable, Equatable {
    public var file: String
    public var args: [String]
    public var env: [String: String]
}

/// Terminal surfaces: one view, one tmux client, one exact marked session.
///
/// Attaching resolves and verifies the exact marked session first, then runs
/// `tmux attach-session` on a PTY — so a client is only ever pointed at a
/// session DevHub has just proven it owns.
public final class TerminalSurfaces: @unchecked Sendable {
    /// The tmux adapter for one machine: a target names the machine its
    /// session is on, and there is one adapter per machine.
    private let runtimeFor: @Sendable (RuntimeId) async throws -> TmuxTerminalRuntime
    public let attachments: AttachmentManager

    public init(runtimeFor: @escaping @Sendable (RuntimeId) async throws -> TmuxTerminalRuntime, attachments: AttachmentManager = AttachmentManager()) {
        self.runtimeFor = runtimeFor
        self.attachments = attachments
    }

    public var attachmentCount: Int { attachments.count }

    /// Attach one PTY client to an already verified marked session.
    ///
    /// The operation permit excludes a socket transition for the whole of it,
    /// so the session resolved at the start is still on the socket the client
    /// is pointed at.
    public func attach(
        target: TerminalTarget,
        surfaceKey: String,
        viewLabel: String,
        size: TerminalSize,
        sink: @escaping TerminalFrameSink,
        cancel: CancellationToken = CancellationToken()
    ) async throws -> TerminalAttachReceipt {
        if !size.isValid { throw TerminalFailure(.invalidResize) }
        let permit = try attachments.beginAttach(target: target, surfaceKey: surfaceKey, viewLabel: viewLabel, cancel: cancel)
        defer { permit.release() }
        do {
            let operation = permit.cancel
            let runtime = try await runtimeFor(target.machine)
            let release = try await runtime.acquireOperation(operation)
            defer { release.release() }
            let deadline = OperationDeadline.within(runtime.timeoutMs)
            try await runtime.ensureUnlocked(target, cancel: operation)
            let sessions = try await runtime.listSessionsUnlocked(cancel: operation, deadline: deadline)
            let identity = try runtime.targetIdentity(target, sessions: sessions)
            // `ensure` only guarantees the session existed a moment ago. The
            // client is never pointed at a name; it is pointed at a session
            // whose full marker tuple was just read back.
            guard let exact = sessions.first(where: { $0.name == identity.sessionName && TmuxMarkers.sessionMatches($0.marking, identity) }) else {
                throw TerminalFailure(.sessionUnavailable)
            }
            try operation.check()
            return try attachments.attach(permit, AttachContext(
                surfaceKey: surfaceKey,
                viewLabel: viewLabel,
                target: target,
                spawn: { launch in try runtime.spawnPty(launch) },
                file: try runtime.tmuxPath(),
                args: try runtime.attachArgv(exact.name),
                // The client runs from the launch home: a workspace folder that
                // has been deleted must not make the client unusable.
                cwd: runtime.contextHome,
                environment: runtime.tmuxEnv(),
                size: size,
                sink: sink
            ))
        } catch {
            throw TerminalFailure.from(error)
        }
    }

    /// The argv that attaches a client to a target's session — for a client
    /// DevHub does not run itself. Everything that makes attaching safe still
    /// happens here: the session is ensured, the list is read back, and the
    /// full marker tuple is compared.
    public func profile(_ target: TerminalTarget, cancel: CancellationToken = CancellationToken()) async throws -> TerminalProfileAnswer {
        do {
            let runtime = try await runtimeFor(target.machine)
            let release = try await runtime.acquireOperation(cancel)
            defer { release.release() }
            let deadline = OperationDeadline.within(runtime.timeoutMs)
            try await runtime.ensureUnlocked(target, cancel: cancel)
            let sessions = try await runtime.listSessionsUnlocked(cancel: cancel, deadline: deadline)
            let identity = try runtime.targetIdentity(target, sessions: sessions)
            guard let exact = sessions.first(where: { $0.name == identity.sessionName && TmuxMarkers.sessionMatches($0.marking, identity) }) else {
                throw TerminalFailure(.sessionUnavailable)
            }
            return TerminalProfileAnswer(file: try runtime.tmuxPath(), args: try runtime.attachArgv(exact.name), env: runtime.tmuxRequires())
        } catch {
            throw TerminalFailure.from(error)
        }
    }

    /// Whether `target`'s session is there now, without making it: the
    /// session of that exact marker tuple, on the effective socket. A client
    /// that ended on its own (`AttachmentManager.onEndedByItself`) asks this
    /// to tell a session that ended from a person detaching from one that is
    /// still running.
    public func sessionExists(_ target: TerminalTarget, cancel: CancellationToken = CancellationToken()) async throws -> Bool {
        do {
            let runtime = try await runtimeFor(target.machine)
            let release = try await runtime.acquireOperation(cancel)
            defer { release.release() }
            let sessions = try await runtime.listSessionsUnlocked(cancel: cancel, deadline: .within(runtime.timeoutMs))
            let identity = try runtime.targetIdentity(target, sessions: sessions)
            return sessions.contains { $0.name == identity.sessionName && TmuxMarkers.sessionMatches($0.marking, identity) }
        } catch {
            throw TerminalFailure.from(error)
        }
    }

    public func input(_ identity: TerminalRequestIdentity, sequence: Int, _ bytes: Data) throws {
        try attachments.input(identity, sequence: sequence, bytes)
    }

    public func acknowledge(_ identity: TerminalRequestIdentity, sequence: Int) throws {
        try attachments.acknowledge(identity, sequence: sequence)
    }

    /// Resize the client PTY, and only the client PTY: under `window-size
    /// latest` the window follows the client that last used it, and an
    /// explicit `resize-window` would latch it to `manual` for good and hand a
    /// full-screen program a row the status bar is standing on.
    public func resize(_ identity: TerminalRequestIdentity, _ size: TerminalSize) throws {
        try attachments.resize(identity, size)
    }

    public func detach(_ identity: TerminalRequestIdentity) throws { try attachments.detach(identity) }
    public func detachView(_ viewLabel: String) { attachments.detachView(viewLabel) }
    public func detachAll() { attachments.detachAll() }

    /// Close one workspace's terminal for good: its clients first, then the
    /// session itself.
    public func closeWorkspace(_ target: WorkspaceTerminalTarget, cancel: CancellationToken = CancellationToken()) async throws {
        attachments.detachTarget(.workspace(target))
        try await runtimeFor(target.machine).closeWorkspace(target, cancel: cancel)
    }

    /// Close one pane terminal for good: its clients, then its session.
    public func closePaneTerminal(_ target: PaneTerminalTarget, cancel: CancellationToken = CancellationToken()) async throws {
        attachments.detachTarget(.terminal(target))
        try await runtimeFor(target.machine).closeTerminal(target, cancel: cancel)
    }
}

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
// Deviation from the TS: there is no IPC hop, so the frame sequence numbers,
// the cumulative-ack window (`FlowControl`) and the input sequence that
// protected the Electron renderer's channel are not ported. The view writes to
// the attachment directly and the sink is called on the PTY's own queue.

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

    /// How long a summary may be (`MAX_ERROR_SUMMARY_BYTES`).
    public static let maxSummaryBytes = 256

    /// - Parameter summary: a sentence that replaces the code's stock summary,
    ///   for a failure whose stock words leave out the whole diagnostic.
    public init(_ code: TerminalErrorCode, summary: String? = nil) {
        self.code = code
        self.summary = TerminalFailure.bounded(summary ?? code.summary)
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
        guard let port = failure as? PortFailure else { return TerminalFailure(.internal) }
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

/// What an attachment tells its view, in order.
public enum TerminalFrame: Sendable, Equatable {
    case started(attachmentId: String, surfaceKey: String, targetGeneration: Int, cols: Int, rows: Int)
    case output(Data)
    case error(TerminalFailure)
    case exited(TerminalExitReason)
}

/// The view's end of one attachment. It answers whether the frame was
/// delivered: a view that has gone away is the one condition under which this
/// side stops the PTY on its own.
public typealias TerminalFrameSink = @Sendable (TerminalFrame) -> Bool

/// The identity every non-attach request must present: the surface key and
/// the window label name the owner, and the attachment id and generation name
/// the exact client it was handed. All four must match.
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
    public var viewLabel: String
    public var target: TerminalTarget
    /// Where the tmux client is opened: on the machine its session is on.
    public var spawn: PtyFactory
    public var file: String
    public var args: [String]
    /// The client's working directory: the launch home, never a workspace.
    public var cwd: String
    /// The environment this client runs in, whole.
    public var environment: [String: String]
    public var size: TerminalSize
    public var sink: TerminalFrameSink
}

/// Who owns an attachment: one terminal surface inside one window.
public func surfaceOwnerKey(viewLabel: String, surfaceKey: String) -> String { "\(viewLabel)\u{0}\(surfaceKey)" }

/// How long the reads of one redraw are gathered before they become a frame.
public let outputCoalesceMs = 5.0
/// Latest-wins resize, at most this often.
public let resizeIntervalMs = 16.0
/// The largest one output frame may be.
public let maxOutputFrameBytes = 32 * 1024

final class TerminalAttachment: @unchecked Sendable {
    let id: String
    let surfaceKey: String
    let viewLabel: String
    let target: TerminalTarget
    let targetGeneration: Int
    private let pty: any PseudoTerminal
    private let sink: TerminalFrameSink
    private let onFinished: (TerminalAttachment) -> Void
    private let lock = NSLock()
    private var stopped = false
    private var pending = Data()
    private var flushScheduled = false
    private var pendingResize: TerminalSize?
    private var resizeScheduled = false
    private let queue: DispatchQueue

    init(
        id: String, surfaceKey: String, viewLabel: String, target: TerminalTarget, targetGeneration: Int,
        pty: any PseudoTerminal, sink: @escaping TerminalFrameSink, onFinished: @escaping (TerminalAttachment) -> Void
    ) {
        self.id = id
        self.surfaceKey = surfaceKey
        self.viewLabel = viewLabel
        self.target = target
        self.targetGeneration = targetGeneration
        self.pty = pty
        self.sink = sink
        self.onFinished = onFinished
        queue = DispatchQueue(label: "devhub.attachment.\(id.prefix(8))")
    }

    var isStopped: Bool { lock.withLock { stopped } }
    var queuedResize: TerminalSize? { lock.withLock { pendingResize } }

    /// Hand the view a frame. A view that is gone ends the attachment.
    private func emit(_ frame: TerminalFrame) -> Bool {
        if sink(frame) { return true }
        stop(.detached)
        return false
    }

    func sendStarted(_ size: TerminalSize) throws {
        if !emit(.started(attachmentId: id, surfaceKey: surfaceKey, targetGeneration: targetGeneration, cols: size.cols, rows: size.rows)) {
            throw TerminalFailure(.channelClosed)
        }
    }

    /// PTY output, gathered for `outputCoalesceMs` before it becomes a frame.
    /// A read that already fills a frame has nothing to wait for.
    func acceptOutput(_ bytes: Data) {
        if bytes.isEmpty { return }
        let flushNow: Bool = lock.withLock {
            if stopped { return false }
            pending.append(bytes)
            if pending.count >= maxOutputFrameBytes { return true }
            if !flushScheduled {
                flushScheduled = true
                queue.asyncAfter(deadline: .now() + .milliseconds(Int(outputCoalesceMs))) { [weak self] in self?.flushPending() }
            }
            return false
        }
        if flushNow { flushPending() }
    }

    /// Turn everything pending into frames, now. Pending bytes are taken before
    /// any of them is sent, so a failure raised while sending finds nothing
    /// left to flush.
    private func flushPending() {
        let bytes: Data = lock.withLock {
            flushScheduled = false
            let taken = pending
            pending = Data()
            return taken
        }
        var offset = 0
        while offset < bytes.count {
            let end = min(bytes.count, offset + maxOutputFrameBytes)
            if !sink(.output(bytes.subdata(in: offset..<end))) {
                stop(.detached)
                return
            }
            offset = end
        }
    }

    func acceptInput(_ bytes: Data) throws {
        if isStopped { throw TerminalFailure(.wrongAttachment) }
        pty.write(bytes)
    }

    func requestResize(_ size: TerminalSize) throws {
        if isStopped { throw TerminalFailure(.wrongAttachment) }
        if !size.isValid { throw TerminalFailure(.invalidResize) }
        let schedule: Bool = lock.withLock {
            pendingResize = size
            if resizeScheduled { return false }
            resizeScheduled = true
            return true
        }
        if schedule {
            queue.asyncAfter(deadline: .now() + .milliseconds(Int(resizeIntervalMs))) { [weak self] in
                guard let self else { return }
                let next: TerminalSize? = self.lock.withLock {
                    self.resizeScheduled = false
                    let size = self.pendingResize
                    self.pendingResize = nil
                    return self.stopped ? nil : size
                }
                if let next { self.pty.resize(next) }
            }
        }
    }

    /// The PTY ended on its own.
    func handleExit() {
        if isStopped { return }
        finish(.eof)
    }

    /// DevHub ended it: a detach, a replacement, a closed window, or quit.
    func stop(_ reason: TerminalExitReason = .detached) {
        if isStopped { return }
        finish(reason)
    }

    private func finish(_ reason: TerminalExitReason) {
        // Stopped first, so the flush below cannot re-enter this; then the
        // flush, so the last of the output is out before the frame that says
        // there will be no more.
        let first: Bool = lock.withLock {
            if stopped { return false }
            stopped = true
            pendingResize = nil
            return true
        }
        if !first { return }
        let tail: Data = lock.withLock {
            let taken = pending
            pending = Data()
            return taken
        }
        if !tail.isEmpty { _ = sink(.output(tail)) }
        _ = sink(.exited(reason))
        pty.kill()
        onFinished(self)
    }
}

public final class AttachmentManager: @unchecked Sendable {
    private struct InFlight {
        let ownerKey: String
        let viewLabel: String
        let target: TerminalTarget
        let cancel: CancellationToken
    }

    private let lock = NSLock()
    private var attachments: [String: TerminalAttachment] = [:]
    private var inFlight: [Int: InFlight] = [:]
    private var nextAttachKey = 1
    private var generation: Int
    private let spawn: PtyFactory?
    private let randomBytes: @Sendable (Int) -> [UInt8]

    /// Generations wrap here (`MAX_TARGET_GENERATION`, `Number.MAX_SAFE_INTEGER`).
    public static let maxTargetGeneration = 9_007_199_254_740_991

    /// - Parameter spawn: overridden only by tests; production opens the
    ///   target machine's PTY through the attach context.
    public init(spawn: PtyFactory? = nil, randomBytes: (@Sendable (Int) -> [UInt8])? = nil) {
        self.spawn = spawn
        let random = randomBytes ?? { count in
            var generator = SystemRandomNumberGenerator()
            return (0..<count).map { _ in UInt8.random(in: 0...255, using: &generator) }
        }
        self.randomBytes = random
        // The ledger starts somewhere unguessable, so a generation from one run
        // of the app is not a usable capability in the next.
        var value = 0
        for byte in random(6) { value = value * 256 + Int(byte) }
        generation = (value % AttachmentManager.maxTargetGeneration) + 1
    }

    public var count: Int { lock.withLock { attachments.count } }

    /// Claim the in-flight ledger for one attach. An older attach by the same
    /// owner, or for the same terminal, is superseded here, before either can
    /// publish.
    public func beginAttach(target: TerminalTarget, surfaceKey: String, viewLabel: String, cancel: CancellationToken) throws -> AttachPermit {
        try cancel.check()
        let ownerKey = surfaceOwnerKey(viewLabel: viewLabel, surfaceKey: surfaceKey)
        let operation = cancel.child()
        let (key, superseded): (Int, [CancellationToken]) = lock.withLock {
            let key = nextAttachKey
            nextAttachKey += 1
            let superseded = inFlight.values.filter { $0.ownerKey == ownerKey || $0.target.same(as: target) }.map(\.cancel)
            inFlight[key] = InFlight(ownerKey: ownerKey, viewLabel: viewLabel, target: target, cancel: operation)
            return (key, superseded)
        }
        for token in superseded { token.cancel() }
        return AttachPermit(cancel: operation) { [weak self] in
            guard let self else { return }
            self.lock.withLock { _ = self.inFlight.removeValue(forKey: key) }
        }
    }

    private func isCurrent(_ permit: AttachPermit) -> Bool {
        if permit.cancel.isCancelled { return false }
        return lock.withLock { inFlight.values.contains { $0.cancel === permit.cancel } }
    }

    /// Publish one resolved client as this surface's attachment.
    public func attach(_ permit: AttachPermit, _ context: AttachContext) throws -> TerminalAttachReceipt {
        if !isCurrent(permit) { throw TerminalFailure(.staleTarget) }
        // One attachment per surface: a surface that remounts replaces its own
        // client and nobody else's, reaped before the new PTY exists.
        let replaced = lock.withLock { attachments.values.filter { $0.surfaceKey == context.surfaceKey } }
        for existing in replaced { existing.stop(.detached) }
        let id = randomBytes(16).map { String(format: "%02x", $0) }.joined()
        let targetGeneration: Int = lock.withLock {
            let value = generation
            generation = value >= AttachmentManager.maxTargetGeneration ? 1 : value + 1
            return value
        }
        let pty: any PseudoTerminal
        do {
            pty = try (spawn ?? context.spawn)(PtyLaunch(
                file: context.file, args: context.args, cwd: context.cwd,
                cols: context.size.cols, rows: context.size.rows,
                pixelWidth: context.size.pixelWidth, pixelHeight: context.size.pixelHeight,
                env: context.environment
            ))
        } catch {
            // The view asked for a terminal and there is none: say so in the
            // same shape a later failure would take, then refuse the request.
            _ = context.sink(.error(TerminalFailure(.ptyUnavailable)))
            _ = context.sink(.exited(.childExited))
            throw (error as? TerminalFailure) ?? TerminalFailure(.ptyUnavailable)
        }
        // Nothing may reach the view before its Started frame: the PTY is held
        // paused until that is out.
        pty.pause()
        let attachment = TerminalAttachment(
            id: id, surfaceKey: context.surfaceKey, viewLabel: context.viewLabel,
            target: context.target, targetGeneration: targetGeneration,
            pty: pty, sink: context.sink
        ) { [weak self] finished in
            guard let self else { return }
            self.lock.withLock {
                if self.attachments[finished.id] === finished { self.attachments[finished.id] = nil }
            }
        }
        pty.onData { [weak attachment] bytes in attachment?.acceptOutput(bytes) }
        pty.onExit { [weak attachment] _ in attachment?.handleExit() }
        lock.withLock { attachments[id] = attachment }
        try attachment.sendStarted(context.size)
        pty.resume()
        return TerminalAttachReceipt(attachmentId: id, surfaceKey: context.surfaceKey, targetGeneration: targetGeneration)
    }

    public func input(_ identity: TerminalRequestIdentity, _ bytes: Data) throws {
        try owned(identity).acceptInput(bytes)
    }

    public func resize(_ identity: TerminalRequestIdentity, _ size: TerminalSize) throws {
        try owned(identity).requestResize(size)
    }

    /// Idempotent for the exact handle; a different handle is never inferred.
    public func detach(_ identity: TerminalRequestIdentity) throws {
        guard let existing = lock.withLock({ attachments[identity.attachmentId] }) else { return }
        if existing.surfaceKey != identity.surfaceKey || existing.viewLabel != identity.viewLabel
            || existing.targetGeneration != identity.targetGeneration {
            throw TerminalFailure(.wrongAttachment)
        }
        existing.stop(.detached)
    }

    /// Every client a window holds goes, and every attach it has in flight is
    /// cancelled: a window closing.
    public func detachView(_ viewLabel: String) {
        let (tokens, clients) = lock.withLock {
            (inFlight.values.filter { $0.viewLabel == viewLabel }.map(\.cancel),
             attachments.values.filter { $0.viewLabel == viewLabel })
        }
        for token in tokens { token.cancel() }
        for client in clients { client.stop(.detached) }
    }

    /// Every client of one terminal goes, before its session is closed.
    public func detachTarget(_ target: TerminalTarget) {
        let (tokens, clients) = lock.withLock {
            (inFlight.values.filter { $0.target.same(as: target) }.map(\.cancel),
             attachments.values.filter { $0.target.same(as: target) })
        }
        for token in tokens { token.cancel() }
        for client in clients { client.stop(.detached) }
    }

    public func detachAll() {
        let (tokens, clients) = lock.withLock { (inFlight.values.map(\.cancel), Array(attachments.values)) }
        for token in tokens { token.cancel() }
        for client in clients { client.stop(.detached) }
    }

    private func owned(_ identity: TerminalRequestIdentity) throws -> TerminalAttachment {
        guard let attachment = lock.withLock({ attachments[identity.attachmentId] }),
              attachment.surfaceKey == identity.surfaceKey, attachment.viewLabel == identity.viewLabel,
              attachment.targetGeneration == identity.targetGeneration
        else { throw TerminalFailure(.wrongAttachment) }
        return attachment
    }

    /// For tests: the resize waiting to be applied to one attachment.
    func queuedResize(_ attachmentId: String) -> TerminalSize? {
        lock.withLock { attachments[attachmentId] }?.queuedResize
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

    public func input(_ identity: TerminalRequestIdentity, _ bytes: Data) throws {
        try attachments.input(identity, bytes)
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

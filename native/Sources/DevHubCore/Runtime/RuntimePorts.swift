// Port of the failure, cancellation and deadline vocabulary of
// apps/desktop/src/main/terminal/ports.ts and main/terminal/command.ts
// (`PortFailure`, `CancellationToken`, `OperationDeadline`), and of the machine
// name of main/runtime/registry.ts (`runtimeMachine`).
//
// They live under Runtime/ rather than Tmux/ because every machine command
// DevHub runs — tmux, `ps`, the pane-process script — is bounded by them, and
// the runtime seam (`MachineRuntime`) is where they are first needed.

import Foundation

// MARK: - Which machine

/// `local`, or `ssh:<host>`: which machine a Workspace's folder, its tmux
/// server and its Agents are on (`RuntimeId` in `model/domain.ts`).
///
/// A value rather than a bare string so that the one place that knows how a
/// machine id is spelled (`RuntimeId.parse`, the port of `runtimeMachine`) is
/// the only place one is made from text.
public struct RuntimeId: Hashable, Sendable, Codable, CustomStringConvertible {
    public let rawValue: String

    private init(unchecked rawValue: String) { self.rawValue = rawValue }

    /// This machine.
    public static let local = RuntimeId(unchecked: "local")

    /// A host reached over ssh.
    public static func ssh(_ host: String) -> RuntimeId { RuntimeId(unchecked: "ssh:\(host)") }

    /// The machine an id names — the inverse of `rawValue`.
    ///
    /// A name that is not one of the two shapes is a request DevHub cannot
    /// answer, and it says so rather than falling back to this machine — which
    /// would open a shell here for a terminal over there.
    public static func parse(_ raw: String) throws -> RuntimeId {
        if raw == "local" || raw.hasPrefix("ssh:") { return RuntimeId(unchecked: raw) }
        throw RuntimeMachineUnknown(raw: raw)
    }

    public var isLocal: Bool { rawValue == "local" }
    public var description: String { rawValue }

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = try RuntimeId.parse(raw)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// `${raw} does not name a machine DevHub knows`.
public struct RuntimeMachineUnknown: Error, Sendable, Equatable, CustomStringConvertible {
    public let raw: String
    public var description: String { "\(raw) does not name a machine DevHub knows" }
}

// MARK: - PortFailure

/// Why a runtime operation could not complete (`PortErrorCode`).
public enum PortErrorCode: String, Sendable, Equatable, CaseIterable {
    case unavailable
    case conflict
    case cancelled
    case timedOut = "timed_out"
    case incompatible
    // A workspace whose directory has been renamed or deleted. Its own
    // condition, because the runtime is not the thing that is wrong: saying
    // "the runtime is unavailable" for a removed worktree sends a reader to
    // look at tmux, which is working perfectly.
    case rootMissing = "root_missing"
    case rootInaccessible = "root_inaccessible"
    // A tmux client that never reached a server, because the socket it would
    // connect through cannot be used. Never a conflict: there is no server on
    // the other end to be somebody else's. See `serverReach` in TmuxCommand.
    case socketPathTooLong = "socket_path_too_long"
    case socketUnusable = "socket_unusable"
    case failed

    /// What each kind of runtime failure is drawn as, outside an Agent's pane
    /// (`PORT_FAILURE_SHOWN_AS`): an app error code of `ipc/appShell.ts`.
    public var shownAs: String {
        switch self {
        case .unavailable, .incompatible: return "machine_unavailable"
        case .timedOut: return "machine_timed_out"
        case .cancelled: return "operation_cancelled"
        case .conflict, .failed: return "machine_command_failed"
        case .rootMissing, .rootInaccessible: return "workspace_unavailable"
        case .socketPathTooLong: return "terminal_socket_path_too_long"
        case .socketUnusable: return "terminal_socket_unusable"
        }
    }

    /// The stock summary of `shownAs` (`APP_ERROR_SUMMARY`), verbatim.
    public var shownSummary: String {
        switch shownAs {
        case "machine_unavailable": return "The machine is unavailable."
        case "machine_timed_out": return "The machine did not answer in time."
        case "operation_cancelled": return "The request was cancelled."
        case "machine_command_failed": return "The machine could not do what DevHub asked."
        case "workspace_unavailable": return "The workspace is unavailable."
        case "terminal_socket_path_too_long": return "The terminal socket path is too long."
        case "terminal_socket_unusable": return "DevHub cannot use the terminal socket."
        default: return "The machine could not do what DevHub asked."
        }
    }
}

/// A runtime failure: a code, and one optional `detail` sentence.
///
/// # What the isolation between DevHub and a foreign tmux actually protects
///
/// The rule that matters runs one way: **a session DevHub owns must not be
/// casually attachable from a bare `tmux`.** That is what the dedicated socket
/// name and the marker protocol are for, and nothing here may weaken either of
/// them — DevHub still refuses a socket it cannot prove is its own, and it
/// still never names an unmarked session.
///
/// `detail` is one short sentence naming what DevHub asked for and what it was
/// told — composed at the one place that runs tmux (`runTmux`), so what a
/// refusal says is decided once rather than at forty throw sites. A failure
/// raised for the *shape* of an answer carries its own sentence instead,
/// saying which shape rule the answer broke.
public struct PortFailure: Error, Sendable, Equatable, CustomStringConvertible {
    public let code: PortErrorCode
    /// One short sentence: what was asked for, and what it was told.
    public let detail: String?

    public init(_ code: PortErrorCode, detail: String? = nil) {
        self.code = code
        self.detail = detail
    }

    /// The detail the wire carries: the sentence, or the code in words.
    public var wireDetail: String {
        let said = detail ?? "terminal runtime \(code.rawValue.replacingOccurrences(of: "_", with: " "))"
        return said.count <= 4096 ? said : String(said.prefix(4096)) + "…"
    }

    /// `failureText` of this failure: the summary of what it is drawn as, then
    /// its detail.
    public var text: String { "\(code.shownSummary) \(wireDetail)" }

    public var description: String { text }
}

/// `portFailure(code, { detail })`.
public func portFailure(_ code: PortErrorCode, detail: String? = nil) -> PortFailure {
    PortFailure(code, detail: detail)
}

/// The one sentence a failure is said in, wherever it is said (`failureText`
/// in `model/wire.ts`): a `PortFailure`'s summary and detail, any other
/// error's own description.
public enum RuntimeFailureText {
    public static func of(_ error: any Error) -> String {
        if let port = error as? PortFailure { return port.text }
        return String(describing: error)
    }
}

// MARK: - Cancellation

/// Cooperative cancellation for one operation.
///
/// A child token is cancelled by its parent but not the reverse, which is how a
/// superseded attach cancels only its own provider work.
public final class CancellationToken: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var children: [CancellationToken] = []
    private var listeners: [@Sendable () -> Void] = []

    public init() {}

    public var isCancelled: Bool {
        lock.lock(); defer { lock.unlock() }
        return cancelled
    }

    public func cancel() {
        lock.lock()
        if cancelled { lock.unlock(); return }
        cancelled = true
        let children = self.children
        let listeners = self.listeners
        self.children = []
        self.listeners = []
        lock.unlock()
        for child in children { child.cancel() }
        for listener in listeners { listener() }
    }

    /// Run this when the operation is abandoned, or now if it already has been.
    ///
    /// Running immediately when the token is already cancelled is the whole
    /// point rather than a convenience: a caller that registered a moment too
    /// late would otherwise wait forever for an event that has been and gone.
    public func onCancelled(_ listener: @escaping @Sendable () -> Void) {
        lock.lock()
        if cancelled {
            lock.unlock()
            listener()
            return
        }
        listeners.append(listener)
        lock.unlock()
    }

    public func child() -> CancellationToken {
        let child = CancellationToken()
        lock.lock()
        if cancelled {
            lock.unlock()
            child.cancel()
            return child
        }
        children.append(child)
        lock.unlock()
        return child
    }

    /// Throws if this operation has been abandoned.
    public func check() throws {
        if isCancelled { throw portFailure(.cancelled) }
    }
}

// MARK: - Deadline

/// How long an operation may go without an answer from the provider.
///
/// It is a watchdog on *silence*, not a budget for the whole operation. The
/// distinction is the difference between a runtime that has stopped answering
/// and one that is merely being asked a lot: an attach runs a sequence of
/// commands, and on a cold start several attaches and the Agent reconciler all
/// do it at once. Every one of those commands answered in milliseconds and the
/// operation still ran past a fixed three-second budget — which reported "the
/// terminal runtime did not answer in time" about a tmux that had answered
/// every single time.
///
/// So the clock is reset by an answer, and only by an answer. A tmux that hangs
/// still trips the same watchdog in the same `timeoutMs`, and a sequence that
/// stalls halfway through trips it where it stalled.
public final class OperationDeadline: @unchecked Sendable {
    private let lock = NSLock()
    private let budget: Double
    private var expiresAt: UInt64

    private init(milliseconds: Double) {
        budget = milliseconds
        expiresAt = OperationDeadline.now() &+ OperationDeadline.nanoseconds(milliseconds)
    }

    public static func within(_ milliseconds: Double) -> OperationDeadline {
        OperationDeadline(milliseconds: milliseconds)
    }

    /// The watchdog's bound, for a timeout diagnostic to name.
    public var budgetMs: Double { budget }

    /// Milliseconds left; negative once the silence has lasted too long.
    public var remaining: Double {
        lock.lock(); defer { lock.unlock() }
        let now = OperationDeadline.now()
        return expiresAt >= now ? Double(expiresAt - now) / 1_000_000 : -Double(now - expiresAt) / 1_000_000
    }

    /// The provider answered — including one that failed, because a refusal is
    /// an answer too, and the caller that keeps going after it is not waiting
    /// on a silent runtime.
    public func answered() {
        lock.lock()
        expiresAt = OperationDeadline.now() &+ OperationDeadline.nanoseconds(budget)
        lock.unlock()
    }

    /// Cancellation wins over expiry: an abandoned operation is not a timeout.
    public func check(_ cancel: CancellationToken) throws {
        try cancel.check()
        if remaining <= 0 { throw portFailure(.timedOut) }
    }

    private static func now() -> UInt64 { DispatchTime.now().uptimeNanoseconds }
    private static func nanoseconds(_ milliseconds: Double) -> UInt64 {
        UInt64(max(0, milliseconds) * 1_000_000)
    }
}

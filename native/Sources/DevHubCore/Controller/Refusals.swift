// Ports of apps/desktop/src/main/shell/agentFailure.ts (`RefusedOperation`,
// `agentSubject`, `refusalWire`), completionRefusal.ts, cleanupDeadline.ts and
// machineConditions.ts: the rules the controller follows when something it
// asked for did not happen. Pure, so each has its tests without a window.

import Foundation

// MARK: - Who a refusal is about (agentFailure.ts)

/// A refused operation, and the thing it is about. The subject decides where
/// it is shown: an Agent's pane, a Workspace's surface, a machine's condition,
/// or — only when there is nothing to stand on — the app's alert.
public enum RefusedOperation: Equatable, Sendable {
    case agent(AgentId, code: AgentFailureCode, detail: String?)
    case workspace(WorkspaceId, code: DiagnosticCode, detail: String?)
    /// A machine that would not answer a round asked about all of its Agents:
    /// a condition, once per episode (`MachineConditions`).
    case machine(String, code: AgentFailureCode, detail: String?)
    case app(code: AppErrorCode, detail: String?)

    /// `agentSubject`: to the Agent it is about, to the machine when it is
    /// about all of them, and to the app when there is not even a machine.
    public static func agentSubject(
        _ agentId: AgentId?, code: AgentFailureCode, detail: String?, machine: String? = nil
    ) -> RefusedOperation {
        if let agentId { return .agent(agentId, code: code, detail: detail) }
        if let machine { return .machine(machine, code: code, detail: detail) }
        return .app(code: .agentRuntimeUnavailable, detail: detail)
    }

    /// `refusalWire`: the words a refused operation is answered in — the same
    /// code and sentence it was drawn with at its subject.
    public var wire: AppError {
        switch self {
        case let .app(code, detail): return NamedFailure.at(code, detail).wire
        case let .agent(_, code, detail), let .machine(_, code, detail): return NamedFailure.agent(code, detail).wire
        case let .workspace(_, code, detail):
            // A Workspace's refusal is the state of a row, not the answer to a
            // request; it is answered as the workspace being unavailable.
            return NamedFailure.at(.workspaceUnavailable, detail ?? code.rawValue).wire
        }
    }
}

/// `portRefusal`, in the model's own vocabulary: WP3's mapping of a port
/// failure onto an `AgentFailureCode`.
public func agentPortRefusal(_ error: Error) -> (code: AgentFailureCode, detail: String?) {
    let refusal = TerminalAgentCommand.portRefusal(error)
    return (AgentFailureCode(rawValue: refusal.code) ?? .tmuxCommandFailed, refusal.detail)
}

// MARK: - A refused completion (completionRefusal.ts)

public enum CompletionRefusal: Sendable {
    /// A bug in DevHub's own flow: nobody is waiting and nothing can answer it.
    case crash
    /// `publish`: drawn as an app notice, when nothing has drawn it yet.
    /// `rejection`: what the request waiting on the operation is refused with.
    case answer(publish: AppError?, rejection: Error)
}

public enum Refusals {
    /// `completionRefusal`: what becomes of a completion the coordinator refused.
    public static func completionRefusal(_ event: ProviderEvent, _ error: Error) -> CompletionRefusal {
        if case .operationFailed = event { return refusalOf(error, drawnAtSubject: true) }
        return refusalOf(error, drawnAtSubject: false)
    }

    /// `refusalOf`: the same decision for a refusal of any request.
    public static func refusalOf(_ error: Error, drawnAtSubject: Bool) -> CompletionRefusal {
        if error is InvariantViolation { return .crash }
        if error is StaleCompletion { return .answer(publish: nil, rejection: error) }
        let drawn = errorWire(error)
        var reported = drawn
        reported.reported = true
        return .answer(publish: drawnAtSubject ? nil : drawn, rejection: NamedFailure(reported))
    }
}

// MARK: - One bound per close step (cleanupDeadline.ts)

public enum CloseDeadline {
    /// Generous enough that a slow-but-working step still finishes.
    public static let stepTimeoutMs = 20_000
    /// The longest a close can legitimately take (`CLOSE_BUDGET_MS`).
    public static var budgetMs: Int { CloseStep.allCases.count * stepTimeoutMs }

    /// Which "DevHub could not confirm this" each step reports when time runs out.
    public static func timeoutDiagnostic(_ step: CloseStep) -> DiagnosticCode {
        switch step {
        case .editor: return .closeEditorUnresponsive
        case .agents: return .closeAgentsUnknown
        case .terminal: return .closeTerminalUnknown
        case .view, .worktree, .state: return .cleanupFailed
        }
    }

    /// `withCloseDeadline`: the step's answer, its failure, or `CloseTimeout`.
    public static func run<T: Sendable>(
        _ step: CloseStep, timeoutMs: Int = stepTimeoutMs, _ work: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await work() }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(timeoutMs) * 1_000_000)
                throw CloseTimeout(diagnostic: timeoutDiagnostic(step))
            }
            defer { group.cancelAll() }
            guard let first = try await group.next() else { throw CloseTimeout(diagnostic: timeoutDiagnostic(step)) }
            return first
        }
    }

    /// `sessionsLeftRunning`: what a step left behind, when what stopped it
    /// was the machine not answering. nil means "this is not that": rethrow.
    public static func sessionsLeftRunning(_ step: CloseStep, machine: String, _ error: Error) -> String? {
        guard step == .agents || step == .terminal else { return nil }
        guard let named = error as? NamedFailure, named.code == .workspaceUnavailable else { return nil }
        return "\(step == .agents ? "Agent" : "terminal") sessions on \(machine)"
    }

    /// `sessionsLeftRunningDetail`: the one sentence a completed close says.
    public static func sessionsLeftRunningDetail(_ left: [String]) -> String {
        "\(left.joined(separator: ", ")). They are marked as DevHub's on that machine's tmux "
            + "server; DevHub closes them the next time it can reach it."
    }
}

public struct CloseTimeout: Error, Equatable, Sendable, CustomStringConvertible {
    public let diagnostic: DiagnosticCode
    public init(diagnostic: DiagnosticCode) { self.diagnostic = diagnostic }
    public var description: String { "close step timed out: \(diagnostic.rawValue)" }
}

// MARK: - A machine that is not answering (machineConditions.ts)

/// One notice per episode of a machine not answering, with hysteresis: it
/// goes up on the first failed round and comes down only after enough rounds
/// in a row answered, and not before it is old enough to have been read.
public final class MachineConditions: @unchecked Sendable {
    public typealias Publish = @Sendable (_ source: String, _ summary: String?, _ reason: String) -> Void

    private struct Episode {
        let summary: String
        let raisedAt: Double
        var successes: Int
    }

    public static let successesToRetract = 2
    public static let minimumAgeMs: Double = 5_000

    public static func source(_ machine: String) -> String { "machine:\(machine)" }

    private let publish: Publish
    private let retractAfter: Int
    private let minimumAge: Double
    private let now: @Sendable () -> Double
    private let lock = NSLock()
    private var episodes: [(machine: String, episode: Episode)] = []

    public init(
        publish: @escaping Publish, successesToRetract: Int = MachineConditions.successesToRetract,
        minimumAgeMs: Double = MachineConditions.minimumAgeMs,
        now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }
    ) {
        self.publish = publish
        retractAfter = successesToRetract
        minimumAge = minimumAgeMs
        self.now = now
    }

    public var raised: [String] { lock.withLock { episodes.map(\.machine) } }

    public func failed(_ machine: String, summary: String) {
        let raise: Bool = lock.withLock {
            if let index = episodes.firstIndex(where: { $0.machine == machine }) {
                episodes[index].episode.successes = 0
                return false
            }
            episodes.append((machine, Episode(summary: summary, raisedAt: now(), successes: 0)))
            return true
        }
        if raise { publish(Self.source(machine), summary, "a reconcile round got no answer") }
    }

    public func succeeded(_ machine: String) {
        let retract: Bool = lock.withLock {
            guard let index = episodes.firstIndex(where: { $0.machine == machine }) else { return false }
            episodes[index].episode.successes += 1
            if episodes[index].episode.successes < retractAfter { return false }
            if now() - episodes[index].episode.raisedAt < minimumAge { return false }
            episodes.remove(at: index)
            return true
        }
        if retract { publish(Self.source(machine), nil, "\(retractAfter) rounds answered") }
    }

    public func forget(_ machine: String) {
        let removed: Bool = lock.withLock {
            guard let index = episodes.firstIndex(where: { $0.machine == machine }) else { return false }
            episodes.remove(at: index)
            return true
        }
        if removed { publish(Self.source(machine), nil, "the machine left the model") }
    }
}

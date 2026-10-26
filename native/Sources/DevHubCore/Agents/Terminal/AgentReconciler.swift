// Port of apps/desktop/src/main/shell/agentReconciler.ts.
//
// The loop that keeps DevHub's Agents true.
//
// tmux is not a thing DevHub can be told about: nothing pushes a session's
// death, and the only authoritative answer is the session list taken now. So
// the one honest way to know an Agent's status — and the only way to learn
// that it exited — is to keep asking, for as long as there is an Agent to ask
// about.
//
// There is one loop per machine, and nothing else reconciles on its own: a
// cadence is a fact about a link, and a single loop asking two machines would
// have to pick one number for both. The interval is read from the runtime
// *every* sleep rather than captured at construction, because a remote runtime
// recomputes it from the round trips it has just measured.
//
// The loop never overlaps itself. A round runs to its answer before the next
// one is scheduled.

import Foundation

/// The part of a machine a loop over it reads.
public protocol ReconcileHost: Sendable {
    var id: RuntimeId { get }
    var cadence: RuntimeCadence { get }
}

/// A machine's id and cadence, as a value.
public struct ReconcileHostValue: ReconcileHost {
    public let id: RuntimeId
    private let cadenceSource: @Sendable () -> RuntimeCadence
    public var cadence: RuntimeCadence { cadenceSource() }
    public init(id: RuntimeId, cadence: @escaping @Sendable () -> RuntimeCadence) {
        self.id = id
        cadenceSource = cadence
    }
    public init(_ runtime: any MachineRuntime) {
        id = runtime.id
        cadenceSource = { runtime.cadence }
    }
}

public final class AgentReconciler: @unchecked Sendable {
    public struct Options: Sendable {
        /// The machine this loop asks about, and what it is allowed to cost.
        public var host: any ReconcileHost
        /// Whether there is anything to reconcile. No Agents, no provider traffic.
        public var hasAgents: @Sendable () -> Bool
        /// One round. It returns when the model has the provider's answer.
        public var reconcile: @Sendable () async throws -> Void
        /// Where a round's failure goes. There is no other reader for it.
        public var onFailure: @Sendable (any Error) -> Void
        /// What a round is counted as in `devhub --metrics`.
        public var record: (@Sendable () -> Void)?

        public init(
            host: any ReconcileHost,
            hasAgents: @escaping @Sendable () -> Bool,
            reconcile: @escaping @Sendable () async throws -> Void,
            onFailure: @escaping @Sendable (any Error) -> Void,
            record: (@Sendable () -> Void)? = nil
        ) {
            self.host = host
            self.hasAgents = hasAgents
            self.reconcile = reconcile
            self.onFailure = onFailure
            self.record = record
        }
    }

    private let options: Options
    private let lock = NSLock()
    private var started = false
    private var stopped = false
    private var wakeContinuation: CheckedContinuation<Void, Never>?
    private var sleepNumber = 0
    private var loop: Task<Void, Never>?

    public init(_ options: Options) { self.options = options }

    public var runtimeId: RuntimeId { options.host.id }

    /// Idempotent: the loop exists once for the life of the process.
    public func start() {
        let begin: Bool = lock.withLock {
            if started || stopped { return false }
            started = true
            return true
        }
        guard begin else { return }
        loop = Task.detached { [self] in await run() }
    }

    /// Ask for the next round now instead of at the end of the interval. A
    /// hint about *when*, never a second way of learning *what*.
    public func wake() {
        let waiting: CheckedContinuation<Void, Never>? = lock.withLock {
            // Only a sleep can be ended early; a wake during a round is the
            // round that was going to happen anyway.
            let continuation = wakeContinuation
            wakeContinuation = nil
            return continuation
        }
        waiting?.resume()
    }

    public func stop() {
        lock.withLock { stopped = true }
        wake()
    }

    private var isStopped: Bool { lock.withLock { stopped } }

    private func run() async {
        while !isStopped {
            if options.hasAgents() {
                do {
                    (options.record ?? {})()
                    try await options.reconcile()
                } catch {
                    // A round that failed is a fact about the provider. The loop
                    // keeps running: the next snapshot is how a provider outage
                    // stops being one.
                    options.onFailure(error)
                }
            }
            await sleep()
        }
    }

    private func sleep() async {
        let interval = options.host.cadence.reconcileIntervalMs
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let number: Int? = lock.withLock {
                if stopped { return nil }
                sleepNumber += 1
                wakeContinuation = continuation
                return sleepNumber
            }
            guard let number else {
                continuation.resume()
                return
            }
            Task.detached { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000))
                self?.timerFired(number)
            }
        }
    }

    /// The interval ran out: end the sleep it was set for, and only that one.
    private func timerFired(_ number: Int) {
        let waiting: CheckedContinuation<Void, Never>? = lock.withLock {
            guard number == sleepNumber, let continuation = wakeContinuation else { return nil }
            wakeContinuation = nil
            return continuation
        }
        waiting?.resume()
    }
}

/// One reconciler loop per machine that has Agents on it, and no others.
///
/// `follow` is called whenever the model changes, and it is idempotent — it is
/// the only place a loop is started or stopped.
public final class AgentReconcilers: @unchecked Sendable {
    private let lock = NSLock()
    private var loops: [RuntimeId: AgentReconciler] = [:]
    private let reconcile: @Sendable (any ReconcileHost) async throws -> Void
    private let onFailure: @Sendable (any Error) -> Void
    private let record: (@Sendable () -> Void)?
    private var stopped = false

    public init(
        reconcile: @escaping @Sendable (any ReconcileHost) async throws -> Void,
        onFailure: @escaping @Sendable (any Error) -> Void,
        record: (@Sendable () -> Void)? = nil
    ) {
        self.reconcile = reconcile
        self.onFailure = onFailure
        self.record = record
    }

    /// The machines with a loop right now.
    public var machines: [RuntimeId] { lock.withLock { Array(loops.keys) } }

    /// Make the running loops exactly the ones these machines need: a machine
    /// that gained its first Agent gets a loop and its first round
    /// immediately; one that lost its last Agent has its loop stopped.
    public func follow(_ hosts: [any ReconcileHost]) {
        var toStart: [AgentReconciler] = []
        var toStop: [AgentReconciler] = []
        lock.withLock {
            if stopped { return }
            let wanted = Set(hosts.map(\.id))
            for (id, loop) in loops where !wanted.contains(id) {
                toStop.append(loop)
                loops[id] = nil
            }
            for host in hosts where loops[host.id] == nil {
                let id = host.id
                let made = LoopBox()
                let reconcile = self.reconcile
                let loop = AgentReconciler(AgentReconciler.Options(
                    host: host,
                    hasAgents: { [weak self] in
                        guard let self else { return false }
                        return self.lock.withLock { self.loops[id] } === made.loop
                    },
                    reconcile: { try await reconcile(host) },
                    onFailure: onFailure,
                    record: record
                ))
                made.loop = loop
                loops[id] = loop
                toStart.append(loop)
            }
        }
        for loop in toStop { loop.stop() }
        for loop in toStart { loop.start() }
    }

    /// Ask every live loop for its next round now.
    public func wake() {
        for loop in lock.withLock({ Array(loops.values) }) { loop.wake() }
    }

    public func stop() {
        let all: [AgentReconciler] = lock.withLock {
            stopped = true
            let all = Array(loops.values)
            loops = [:]
            return all
        }
        for loop in all { loop.stop() }
    }
}

private final class LoopBox: @unchecked Sendable {
    weak var loop: AgentReconciler?
}

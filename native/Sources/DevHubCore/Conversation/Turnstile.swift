// The two small concurrency tools the conversation code is built on: a
// turnstile (work runs one at a time, in the order it was asked for — the TS
// app's promise chain `#serial`) and a cancellation flag (the TS app's
// `CancellationToken`).

import Foundation

/// Runs async work one piece at a time, in the order it was enqueued. The
/// order is fixed when `run` is called, not when it first suspends, so two
/// calls made one after the other run in that order.
public final class Turnstile: Sendable {
    private let tail = Guarded<Task<Void, Never>?>(nil)

    public init() {}

    /// Runs `work` after everything already enqueued, and before anything enqueued later.
    public func run<T: Sendable>(_ work: @escaping @Sendable () async throws -> T) async throws -> T {
        try await enqueue(work).value
    }

    /// `run`, without waiting for it: the task that carries it.
    @discardableResult
    public func enqueue<T: Sendable>(_ work: @escaping @Sendable () async throws -> T) -> Task<T, Error> {
        tail.with { tail in
            let previous = tail
            let task = Task<T, Error> {
                await previous?.value
                return try await work()
            }
            tail = Task { _ = await task.result }
            return task
        }
    }
}

/// Said once, by whoever stops a piece of work; heard by whatever it was doing.
public final class CancellationFlag: Sendable {
    private struct State {
        var cancelled = false
        var handlers: [Int: @Sendable () -> Void] = [:]
        var next = 0
    }

    private let state = Guarded(State())

    public init() {}

    public var isCancelled: Bool { state.with { $0.cancelled } }

    public func cancel() {
        let handlers = state.with { state -> [@Sendable () -> Void] in
            guard !state.cancelled else { return [] }
            state.cancelled = true
            defer { state.handlers = [:] }
            return Array(state.handlers.values)
        }
        for handler in handlers { handler() }
    }

    /// Calls `handler` once the flag is cancelled (at once if it is); the
    /// returned closure takes the handler back.
    @discardableResult
    public func onCancel(_ handler: @escaping @Sendable () -> Void) -> @Sendable () -> Void {
        let id = state.with { state -> Int? in
            guard !state.cancelled else { return nil }
            state.next += 1
            state.handlers[state.next] = handler
            return state.next
        }
        guard let id else {
            handler()
            return {}
        }
        return { [state] in _ = state.with { $0.handlers.removeValue(forKey: id) } }
    }
}

/// Settled once, with a value or a failure; awaited by any number of tasks,
/// before or after it settles (the TS app's promise, where one is passed
/// around as a value).
public final class OneShot<Value: Sendable>: Sendable {
    private struct State {
        var result: Result<Value, Error>?
        var waiters: [CheckedContinuation<Value, Error>] = []
    }

    private let state = Guarded(State())

    public init() {}

    /// One already settled with `value`.
    public static func settled(_ value: Value) -> OneShot<Value> {
        let shot = OneShot<Value>()
        shot.resolve(value)
        return shot
    }

    public var isSettled: Bool { state.with { $0.result != nil } }

    public func resolve(_ value: Value) { settle(.success(value)) }

    public func reject(_ error: Error) { settle(.failure(error)) }

    private func settle(_ result: Result<Value, Error>) {
        let waiters = state.with { state -> [CheckedContinuation<Value, Error>] in
            guard state.result == nil else { return [] }
            state.result = result
            defer { state.waiters = [] }
            return state.waiters
        }
        for waiter in waiters { waiter.resume(with: result) }
    }

    /// Its value once it has one; throws its failure.
    public func value() async throws -> Value {
        try await withCheckedThrowingContinuation { continuation in
            let settled = state.with { state -> Result<Value, Error>? in
                if let result = state.result { return result }
                state.waiters.append(continuation)
                return nil
            }
            if let settled { continuation.resume(with: settled) }
        }
    }
}

extension OneShot where Value == Void {
    public func resolve() { resolve(()) }
}

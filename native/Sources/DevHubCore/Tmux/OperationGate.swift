// Port of `RuntimeOperationGate` in apps/desktop/src/main/terminal/tmux.ts.

import Foundation

/// Logical read/write exclusion for the one terminal owner.
///
/// An ordinary operation holds a shared permit; a socket transition holds it
/// exclusively. Waiters re-check cancellation on every wake, so an abandoned
/// operation stops waiting instead of holding the transition back.
public final class RuntimeOperationGate: @unchecked Sendable {
    private let lock = NSLock()
    private var transitionActive = false
    private var activeOperations = 0
    private var waiters: [UInt64: CheckedContinuation<Void, Never>] = [:]
    private var nextWaiter: UInt64 = 0

    /// How often a waiter looks again even if nobody woke it.
    static let pollIntervalMs = 5.0

    public init() {}

    /// A held permit; releasing it twice is releasing it once.
    public final class Permit: @unchecked Sendable {
        private let lock = NSLock()
        private var released = false
        private let onRelease: () -> Void
        init(_ onRelease: @escaping () -> Void) { self.onRelease = onRelease }
        public func release() {
            let first: Bool = lock.withLock {
                if released { return false }
                released = true
                return true
            }
            if first { onRelease() }
        }
    }

    public func acquireOperation(_ cancel: CancellationToken) async throws -> Permit {
        while true {
            try cancel.check()
            let granted: Bool = lock.withLock {
                if transitionActive { return false }
                activeOperations += 1
                return true
            }
            if granted {
                return Permit { [self] in
                    lock.withLock { activeOperations -= 1 }
                    wake()
                }
            }
            await wait(cancel)
        }
    }

    public func acquireTransition(_ cancel: CancellationToken) async throws -> Permit {
        while true {
            try cancel.check()
            let granted: Bool = lock.withLock {
                if transitionActive || activeOperations != 0 { return false }
                transitionActive = true
                return true
            }
            if granted {
                return Permit { [self] in
                    lock.withLock { transitionActive = false }
                    wake()
                }
            }
            await wait(cancel)
        }
    }

    private func wake() {
        let pending: [CheckedContinuation<Void, Never>] = lock.withLock {
            let all = Array(waiters.values)
            waiters = [:]
            return all
        }
        for waiter in pending { waiter.resume() }
    }

    private func wait(_ cancel: CancellationToken) async {
        let key: UInt64 = lock.withLock {
            nextWaiter += 1
            return nextWaiter
        }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            lock.withLock { waiters[key] = continuation }
            let resumeOnce: @Sendable () -> Void = { [weak self] in
                guard let self else { return }
                let found = self.lock.withLock { self.waiters.removeValue(forKey: key) }
                found?.resume()
            }
            cancel.onCancelled(resumeOnce)
            Task {
                try? await Task.sleep(nanoseconds: UInt64(RuntimeOperationGate.pollIntervalMs * 1_000_000))
                resumeOnce()
            }
        }
    }
}

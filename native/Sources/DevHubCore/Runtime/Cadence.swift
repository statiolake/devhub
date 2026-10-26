// Port of apps/desktop/src/main/runtime/cadence.ts, quote.ts and the local
// half of registry.ts.

import Foundation

/// What a loop over a machine is allowed to cost, as arithmetic.
///
/// The rule is one line — `clamp(8 × median round trip, 500, 3000)` — and the
/// property it exists for is that a reconcile loop spends at most an eighth of
/// the wall clock in flight, whatever the link. Past 375 ms the ceiling and the
/// duty cycle disagree and the ceiling wins.
///
/// This is deliberately *not* what the local runtime uses: a local exec has no
/// round trip to measure, and `localCadence` states this machine's numbers.
public enum Cadence {
    /// What fraction of the wall clock a reconcile loop may spend in flight.
    public static let reconcileDutyCycle = 8.0
    /// The fastest a loop over a network will ever run.
    public static let remoteReconcileFloorMs = 500.0
    /// The slowest, past which DevHub would rather be stale than give up.
    public static let remoteReconcileCeilingMs = 3_000.0

    /// How often to reconcile a machine whose commands cost `medianRoundTripMs`.
    public static func remoteReconcileIntervalMs(_ medianRoundTripMs: Double) -> Double {
        if !medianRoundTripMs.isFinite || medianRoundTripMs < 0 {
            // A median that is not a number is a measurement that went wrong,
            // and the loop still has to run — at the cheapest cadence there is.
            return remoteReconcileCeilingMs
        }
        return min(
            remoteReconcileCeilingMs,
            max(remoteReconcileFloorMs, (reconcileDutyCycle * medianRoundTripMs).rounded())
        )
    }

    /// How recently a full round must have finished for a focus to skip its
    /// own: ten seconds on this Mac.
    public static let repositoryFocusRefreshMinIntervalMs = 10_000.0
    /// The same rule for a machine across a network.
    public static let remoteRepositoryFocusRefreshMinIntervalMs = 30_000.0
    /// How long a lookup started from the picker may run before it is refused.
    public static let repositoryLookupDeadlineMs = 20_000.0
}

/// One quoting rule for the whole app.
///
/// The single-quote rule, the only POSIX quoting rule with no exceptions:
/// inside `'…'` every byte is literal, and the one byte that cannot appear is
/// the single quote itself — written by leaving the string, escaping one
/// quote, and going back in.
public enum ShellQuote {
    /// Quote one value as exactly one POSIX shell word, whatever is in it. The
    /// empty string quotes to `''` rather than to nothing.
    public static func word(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    /// Quote a whole argv into one command line.
    public static func argv(_ argv: [String]) -> String {
        argv.map(word).joined(separator: " ")
    }
}

/// The one switch on which machine a folder is on, local arm only.
///
/// One instance of this machine, because there is one of it: its counters and
/// its latency window are per-instance, so a second one would split the
/// reading `devhub --metrics` prints in half. A remote arm (`ssh:`) is WP12's.
public enum MachineRuntimes {
    public static let local = LocalRuntime()

    /// The runtime of a machine, by id.
    public static func runtime(for id: RuntimeId) throws -> any MachineRuntime {
        if id.isLocal { return local }
        throw portFailure(
            .unavailable,
            detail: "DevHub cannot reach \(id.rawValue.dropFirst("ssh:".count)) yet: SSH Workspaces run their Agents on the host's tmux in a later version of the native app."
        )
    }

    /// Every runtime that is live right now, for a reading and for shutdown.
    public static func live() -> [any MachineRuntime] { [local] }
}

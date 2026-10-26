// Port of apps/desktop/src/main/agent/activity.ts and
// main/agent/screenFreshness.ts.

import Foundation

/// What an Agent says it is doing, in its own words.
///
/// A terminal program can name itself with OSC 0 or OSC 2, and tmux keeps the
/// last such name as the pane's `#{pane_title}`. When an Agent sets it to the
/// step it is on, that one string is the Agent's own sentence about itself.
///
/// **What "no report" looks like.** An empty title, and nothing else — a rule
/// DevHub makes true: an Agent's session is created with the title blanked
/// (`createSession`), and from then on anything in it was put there by the
/// Agent. An Agent that outlived DevHub keeps whatever title it had, and that
/// reads as its word rather than as silence.
public final class AgentActivityReader: @unchecked Sendable {
    private let lock = NSLock()
    /// The word each Agent's row is showing, for a round that read nothing.
    private var current: [String: String?] = [:]

    public init() {}

    /// This Agent's word this round, or nil if it has none.
    public func activity(_ screen: AgentScreen) -> String? {
        let title = screen.oscTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let word: String? = title.isEmpty ? nil : title
        lock.withLock { current[screen.agentId] = .some(word) }
        return word
    }

    /// What this Agent's row is showing now, for a round that read nothing.
    public func showing(_ agentId: String) -> String? {
        lock.withLock { current[agentId] ?? nil }
    }

    /// An Agent that ended takes its pane's history with it.
    public func forget(_ agentId: String) {
        lock.withLock { _ = current.removeValue(forKey: agentId) }
    }
}

/// Which Agents are worth reading the screen of this round.
///
/// tmux already knows whether anything has changed: `#{window_activity}` is
/// when the pane last wrote, and the listing every round runs anyway carries
/// it for free. A pane that has not written has the screen it had.
///
/// The one thing that has to be got right is the *trailing* frame. The marker
/// has one-second resolution, so a screen read at 12:00:03.100 and a line
/// written at 12:00:03.900 both belong to second 3. So a capture only settles
/// the second it was taken in once that second is over, and until then the
/// Agent is read again.
public final class AgentScreenFreshness: @unchecked Sendable {
    /// Milliseconds since the epoch. Injected so a test owns the clock.
    public typealias Clock = @Sendable () -> Double

    private struct Settled {
        /// The marker the last capture was taken against.
        let marker: String
        /// The whole second the last capture was taken in.
        let capturedAtSecond: Double
    }

    private let lock = NSLock()
    private var settled: [String: Settled] = [:]
    private let clock: Clock

    public init(clock: Clock? = nil) {
        self.clock = clock ?? { Date().timeIntervalSince1970 * 1000 }
    }

    /// Whether this round should read the Agent's screen. A nil marker means
    /// the runtime did not report one, answered with `true`.
    public func shouldCapture(_ agentId: String, marker: String?) -> Bool {
        guard let marker else { return true }
        guard let settled = lock.withLock({ self.settled[agentId] }) else { return true }
        if settled.marker != marker { return true }
        // The marker names a second the last capture was taken *inside*, so
        // more output may have landed after it and before that second ended.
        return settled.capturedAtSecond <= (Double(marker) ?? .nan)
    }

    /// Record that the screen was read, against the marker it was read for.
    public func captured(_ agentId: String, marker: String?) {
        guard let marker else {
            // Nothing to compare a future round against, so nothing is
            // remembered: the next round asks again, as it must.
            lock.withLock { settled[agentId] = nil }
            return
        }
        let second = (clock() / 1000).rounded(.down)
        lock.withLock { settled[agentId] = Settled(marker: marker, capturedAtSecond: second) }
    }

    /// An Agent that ended. Its screen is not coming back.
    public func forget(_ agentId: String) {
        lock.withLock { settled[agentId] = nil }
    }
}

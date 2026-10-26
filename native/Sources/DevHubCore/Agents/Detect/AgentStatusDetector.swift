// Port of apps/desktop/src/main/agent/detect/detector.ts, with the slice of
// model/domain.ts it speaks (`AgentStatus`, `agentAtPrompt`, `agentIsIdle`).
//
// What an Agent is doing, decided once per reconcile round.
//
// **One source.** The screen comes from `capture-pane` on the reconcile
// cadence, never from the attached client's stream: the sidebar has to show
// every Agent's status whether or not anybody is looking at it.
//
// **Debounce.** A CLI redraws its screen many times a second, and a frame
// taken mid-redraw can show anything. So a *new* state has to be read twice in
// a row before it replaces the one the row is showing — except a reading that
// carries `visibleBlocker`: an Agent that has stopped to ask a question is the
// one thing nobody should have to wait an extra round to be told about.
//
// **What the debounce is counting.** Two *readings of the same screen*, not
// two captures. A pane that has written nothing since it was last read is not
// captured again, so a round that skips the capture says so — `unchanged` —
// and the last reading is counted again. Without that, an Agent whose screen
// settled before DevHub first looked at it stayed `unknown` for ever.

import Foundation

/// What an Agent is doing (`AgentStatus` in `model/domain.ts`), in the same
/// words. Named apart from the model's own type so that WP2's domain port can
/// adopt it (or alias it) without two definitions colliding.
public enum TerminalAgentStatus: String, Sendable, Equatable, CaseIterable {
    case working, background, waiting, idle, error, unknown

    /// Whether the reading is `idle`.
    public var isIdle: Bool { self == .idle }

    /// Whether the Agent is at a prompt that reads what is typed into it: idle,
    /// or `background` — its turn is over and it takes the next message as it
    /// would idle (`agentAtPrompt`).
    public var atPrompt: Bool { self == .idle || self == .background }
}

/// The screen of one Agent, as `capture-pane` and tmux's pane title give it.
public struct AgentScreen: DetectionInput, Sendable, Equatable {
    public var agentId: String
    public var screen: String
    public var oscTitle: String
    public var oscProgress: String
    public init(agentId: String, screen: String, oscTitle: String = "", oscProgress: String = "") {
        self.agentId = agentId
        self.screen = screen
        self.oscTitle = oscTitle
        self.oscProgress = oscProgress
    }
}

public final class AgentStatusDetector: @unchecked Sendable {
    /// How many consecutive rounds a new state needs before the row takes it.
    public static let debounceRounds = 2

    private struct Pending {
        var state: TerminalAgentStatus
        var rounds: Int
    }

    private let lock = NSLock()
    private var current: [String: TerminalAgentStatus] = [:]
    private var pending: [String: Pending] = [:]
    private var last: [String: Reading] = [:]

    public init() {}

    /// herdr's four screen states, in DevHub's vocabulary: `blocked` is
    /// `waiting`; DevHub's `error` has no screen state, because no screen says
    /// "this went wrong" — only the runtime does.
    static func statusOf(_ state: ScreenState) -> TerminalAgentStatus {
        switch state {
        case .idle: return .idle
        case .working: return .working
        case .blocked: return .waiting
        case .unknown: return .unknown
        }
    }

    /// The status for one Agent's screen this round. A kind with no manifest
    /// never reads a screen at all: its status is `unknown` for life.
    public func status(kind: String, screen: AgentScreen) -> TerminalAgentStatus {
        guard let manifest = DetectManifests.manifest(for: kind) else { return .unknown }
        let reading = DetectRules.read(manifest, screen)
        return lock.withLock {
            last[screen.agentId] = reading
            return count(screen.agentId, reading)
        }
    }

    /// This round read no screen, because the pane has not written since the
    /// last one — so the reading is the reading it already took. An Agent
    /// DevHub has never managed to read keeps the `unknown` it starts with.
    public func unchanged(_ agentId: String) -> TerminalAgentStatus {
        lock.withLock {
            guard let reading = last[agentId] else { return current[agentId] ?? .unknown }
            return count(agentId, reading)
        }
    }

    private func count(_ agentId: String, _ reading: Reading) -> TerminalAgentStatus {
        let showing = current[agentId] ?? .unknown
        // A transcript or picker overlay is the Agent's own viewer, not its
        // state. The row keeps what it had.
        if reading.skipStateUpdate { return showing }
        let next = AgentStatusDetector.statusOf(reading.state)
        if next == showing {
            pending[agentId] = nil
            return showing
        }
        if reading.visibleBlocker { return commit(agentId, next) }
        if var waiting = pending[agentId], waiting.state == next {
            waiting.rounds += 1
            pending[agentId] = waiting
            if waiting.rounds >= AgentStatusDetector.debounceRounds { return commit(agentId, next) }
            return showing
        }
        pending[agentId] = Pending(state: next, rounds: 1)
        return AgentStatusDetector.debounceRounds <= 1 ? commit(agentId, next) : showing
    }

    /// What this Agent's row is showing now, for a round that read nothing.
    public func showing(_ agentId: String) -> TerminalAgentStatus {
        lock.withLock { current[agentId] ?? .unknown }
    }

    /// An Agent that ended takes its screen history with it.
    public func forget(_ agentId: String) {
        lock.withLock {
            current[agentId] = nil
            pending[agentId] = nil
            last[agentId] = nil
        }
    }

    private func commit(_ agentId: String, _ status: TerminalAgentStatus) -> TerminalAgentStatus {
        current[agentId] = status
        pending[agentId] = nil
        return status
    }
}

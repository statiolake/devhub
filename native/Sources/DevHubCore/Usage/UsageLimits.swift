// Port of apps/desktop/src/main/shell/usageLimits.ts, with `UsageLimitsWire`
// and `UsageNoteWire` from apps/desktop/src/ipc/contract.ts.
//
// How much of Claude's and Codex's rate limits is used, app-wide.
//
// Two kinds of reading arrive here, through the one entry `observe`. DevHub
// asks each CLI's account itself, in the background (`UsageReaders`: a
// short-lived process per reading, polled), so the readout is there without a
// GUI Agent having run a turn. And the running GUI Agents report the same
// limits on their own (`Usage.rateLimits` on a conversation's `usage` event —
// Claude's `rate_limit_event`, Codex's `account/rateLimits/updated`). A limit
// belongs to the account, not to whoever read it, so every reading of one CLI
// is a reading of the same limits, and the readout keeps one reading per
// window of each CLI, in the order they were first reported.
//
// Which reading of a window is the latest is decided by the reading, not by
// when it arrived. A conversation replays its journal when DevHub starts, so
// the order readings arrive in across Agents and the reader says nothing about
// which is newer. Within one window usage only grows, and a later window
// resets later: so the reading with the later reset is newer, and between two
// with the same reset, the one with more used. A reading that does not say
// when it resets cannot be compared, and then the one that arrived last wins.
//
// Besides windows, the reader can say two things of a CLI (`note`): that the
// sign-in has no plan limits, and that the CLI's command is not on this Mac.
// Each is the reader's latest word, replaced by the next one; a reading of
// windows from the reader clears it.
//
// A CLI nothing has reported for is said to be unknown rather than zero.

import Foundation

/// The CLIs whose accounts have plan limits DevHub reads — the background
/// reader asks them, and they are the two with a GUI Agent that reports them.
public enum LimitedCli: String, CaseIterable, Sendable, Codable, Hashable {
    case claude, codex

    /// How a person reads it.
    public var displayName: String {
        switch self {
        case .claude: return "Claude"
        case .codex: return "Codex"
        }
    }
}

/// What DevHub's own reader of an account last said besides windows.
public enum UsageNote: String, Sendable, Codable, Hashable {
    /// The sign-in has no plan limits (an API key, Bedrock).
    case noPlanLimits = "no_plan_limits"
    /// The CLI's command is not on this Mac, so it cannot be asked.
    case cliNotFound = "cli_not_found"
}

/// How much of each CLI's rate limits is used. One entry per CLI with plan
/// limits, always; `windows` absent means nothing has reported one yet — not
/// that nothing is used.
public struct UsageLimitsWire: Equatable, Sendable, Codable {
    public struct Window: Equatable, Sendable, Codable {
        /// Which window, in words: a label, never read for its length.
        public var window: String
        /// How long the window is, in minutes; absent when the CLI does not say.
        public var durationMinutes: Double?
        /// 0–100.
        public var usedPercent: Double?
        /// Epoch milliseconds.
        public var resetsAt: Double?

        public init(window: String, durationMinutes: Double? = nil, usedPercent: Double? = nil, resetsAt: Double? = nil) {
            self.window = window
            self.durationMinutes = durationMinutes
            self.usedPercent = usedPercent
            self.resetsAt = resetsAt
        }
    }

    public struct Cli: Equatable, Sendable, Codable {
        public var cli: LimitedCli
        public var windows: [Window]?
        public var note: UsageNote?

        public init(cli: LimitedCli, windows: [Window]? = nil, note: UsageNote? = nil) {
            self.cli = cli
            self.windows = windows
            self.note = note
        }
    }

    public var clis: [Cli]

    public init(clis: [Cli]) { self.clis = clis }
}

/// The readout itself: the latest reading of each window of each CLI.
public final class UsageLimits: @unchecked Sendable {
    private let lock = NSLock()
    private var latest: [LimitedCli: [RateLimit]] = [:]
    private var notes: [LimitedCli: UsageNote] = [:]

    public init() {}

    /// The reader's word on a CLI besides its windows, or `nil` to take it
    /// back; whether it changed what the readout says.
    @discardableResult
    public func note(_ cli: LimitedCli, _ note: UsageNote?) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if notes[cli] == note { return false }
        notes[cli] = note
        return true
    }

    /// Take a reading of one window; whether it changed what the readout says.
    @discardableResult
    public func observe(_ cli: LimitedCli, _ reading: RateLimit) -> Bool {
        lock.lock(); defer { lock.unlock() }
        var windows = latest[cli] ?? []
        let at = windows.firstIndex { $0.window == reading.window }
        if let at {
            let current = windows[at]
            if !Self.supersedes(reading, current) { latest[cli] = windows; return false }
            if current.usedPercent == reading.usedPercent && current.resetsAt == reading.resetsAt {
                latest[cli] = windows
                return false
            }
            windows[at] = reading
        } else {
            windows.append(reading)
        }
        latest[cli] = windows
        return true
    }

    public func wire() -> UsageLimitsWire {
        lock.lock(); defer { lock.unlock() }
        return UsageLimitsWire(clis: LimitedCli.allCases.map { cli in
            let windows = latest[cli] ?? []
            return UsageLimitsWire.Cli(
                cli: cli,
                windows: windows.isEmpty ? nil : windows.map {
                    UsageLimitsWire.Window(window: $0.window, durationMinutes: $0.durationMinutes, usedPercent: $0.usedPercent, resetsAt: $0.resetsAt)
                },
                note: notes[cli]
            )
        })
    }

    static func supersedes(_ next: RateLimit, _ current: RateLimit) -> Bool {
        guard let nextReset = next.resetsAt, let currentReset = current.resetsAt else { return true }
        if nextReset != currentReset { return nextReset > currentReset }
        return (next.usedPercent ?? 0) >= (current.usedPercent ?? 0)
    }
}

/// A GUI Agent of a kind that cannot have a GUI reported a rate limit: a
/// broken rule, said as one.
public struct UsageRuleBroken: Error, Equatable, CustomStringConvertible {
    public let message: String
    public var description: String { message }
}

public enum UsageLimitsFeed {
    /// Feed one conversation `usage` event's rate limits into the readout
    /// (`usageLimitsListener`).
    ///
    /// `kind` is which CLI the Agent runs, from the model. An Agent the model
    /// no longer has (`nil`) is one whose row has already gone: its last word
    /// is not taken. Any kind but Claude and Codex is a broken rule — only they
    /// have a GUI.
    public static func agentReported(
        _ limits: UsageLimits,
        kind: AgentProfileKind?,
        rateLimits: [RateLimit]?,
        publish: (UsageLimitsWire) -> Void
    ) throws {
        guard let readings = rateLimits, !readings.isEmpty, let kind else { return }
        guard let cli = LimitedCli(rawValue: kind.rawValue) else {
            throw UsageRuleBroken(message: "a \(kind.rawValue) Agent reported a rate limit, but only Claude and Codex have a GUI")
        }
        // Every window is observed, whether or not an earlier one changed.
        let changed = readings.map { limits.observe(cli, $0) }.contains(true)
        if changed { publish(limits.wire()) }
    }

    /// Feed the background readers' word into the readout
    /// (`usageReadingListener`): each window of a reading through `observe`,
    /// exactly as a GUI Agent's; a reading of windows takes back the reader's
    /// note, and one of no plan limits is that note.
    public static func deliver(_ limits: UsageLimits, _ cli: LimitedCli, _ reading: UsageReading, publish: (UsageLimitsWire) -> Void) {
        let changed: Bool
        switch reading {
        case .noPlanLimits:
            changed = limits.note(cli, .noPlanLimits)
        case .windows(let windows):
            changed = (windows.map { limits.observe(cli, $0) } + [limits.note(cli, nil)]).contains(true)
        }
        if changed { publish(limits.wire()) }
    }

    public static func note(_ limits: UsageLimits, _ cli: LimitedCli, _ note: UsageNote, publish: (UsageLimitsWire) -> Void) {
        if limits.note(cli, note) { publish(limits.wire()) }
    }
}

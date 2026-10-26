// Port of apps/desktop/src/main/agent/injection.ts, with the slice of
// model/domain.ts it returns (`AgentInjection`, `AgentInjectionWait`,
// `AgentInjectionResult`, `NO_INJECTION`).
//
// What DevHub means to say to an Agent, and when it is safe to say it.
//
// **An intent, not a string.** What is queued is a *decision to say
// something*, and that decision has a life: it is composed from a template, it
// may still be under the person's eye in the review sheet, and only once they
// have confirmed the wording is it something DevHub is entitled to type. So an
// intent is `pendingReview` or `confirmed`, and the idle gate acts on
// `confirmed` intents only. The two waits are independent and either may
// finish first.
//
// **Only into an idle prompt.** `idle` is the one state where the Agent is
// showing a prompt box and waiting for a person to type — and `background` is
// that same prompt, with something the Agent started still working beside it.
// `working` is a turn running; `waiting` is a question that wants a keypress,
// never a sentence; `unknown` is a screen no manifest describes. Nothing is
// ever sent into those.
//
// **And only after it has settled.** One idle reading is not an idle Agent: the
// text goes only after the prompt has been continuously idle for a second, and
// watched for that second. Waiting a second longer costs nothing; typing into
// a turn that had not finished puts DevHub's words in the middle of somebody's
// work.
//
// Nothing here talks to tmux. It decides *whether* and *what*; the caller
// sends and reports back.

import Foundation

/// Why text DevHub means to send an Agent has not been sent.
public enum AgentInjectionWait: String, Sendable, Equatable {
    case nothingQueued = "nothing_queued"
    /// Composed, but nobody has agreed to the wording yet.
    case awaitingReview = "awaiting_review"
    /// The prompt is free; the queue is making sure it stays that way.
    case settling
    case agentBusy = "agent_busy"
    /// Stopped on a question. That screen wants a keypress, never a sentence.
    case agentAsking = "agent_asking"
    /// A screen no manifest describes, so no keystroke has a known meaning.
    case agentUnreadable = "agent_unreadable"
}

/// What became of the last thing DevHub meant to say to this Agent.
public enum AgentInjectionResult: Sendable, Equatable {
    case sent
    /// The person closed the review sheet. The Agent keeps running.
    case cancelled
    case failed(reason: String)
}

/// What a row shows about an Agent's queue.
public struct AgentInjection: Sendable, Equatable {
    public var queued: Int
    public var waitingFor: AgentInjectionWait
    /// How the last one ended, until the next one ends differently.
    public var lastResult: AgentInjectionResult?

    public static let none = AgentInjection(queued: 0, waitingFor: .nothingQueued, lastResult: nil)
}

/// One thing DevHub means to say, and how far along saying it is.
public struct AgentInjectionIntent: Sendable, Equatable {
    public enum State: String, Sendable, Equatable {
        /// A sentence nobody has agreed to yet: not sent however idle the
        /// Agent gets, and with no timeout.
        case pendingReview = "pending-review"
        case confirmed
    }

    /// Names this intent for the sheet that is reviewing it.
    public var id: String
    /// The wording as it stands: rendered from the template, then edited.
    public var text: String
    public var state: State

    public init(id: String, text: String, state: State) {
        self.id = id
        self.text = text
        self.state = state
    }
}

public struct InjectionRefused: Error, Equatable, CustomStringConvertible {
    public var description: String { "an Agent cannot be sent empty text" }
}

public final class AgentInjectionQueue: @unchecked Sendable {
    /// How long a prompt must have been continuously idle before anything is
    /// sent: a clock rather than a count of rounds, because what the Agent
    /// needs is *time*.
    public static let idleSettleMs = 1_000.0
    /// And it has to have been *watched* for that second, not merely dated.
    public static let idleReadingsBeforeSend = 2

    private struct Entry {
        var intents: [AgentInjectionIntent] = []
        /// When the current unbroken run of idle readings began.
        var idleSince: Double?
        /// How many idle readings that run contains.
        var idleReadings = 0
        /// What became of the last intent that stopped being queued.
        var lastResult: AgentInjectionResult?
    }

    private let lock = NSLock()
    private var entries: [String: Entry] = [:]

    public init() {}

    private static func blank(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Hold an intent for an Agent until it is both agreed and deliverable.
    /// Empty text is refused rather than queued; queueing clears whatever the
    /// last one came to.
    public func queue(_ agentId: String, _ intent: AgentInjectionIntent) throws {
        if AgentInjectionQueue.blank(intent.text) { throw InjectionRefused() }
        lock.withLock {
            var entry = entries[agentId] ?? Entry()
            entry.intents.append(intent)
            entry.lastResult = nil
            entries[agentId] = entry
        }
    }

    /// The person has read the wording — this is what they settled on.
    /// Confirming does not send: it removes the only reason `due` was refusing.
    public func confirm(_ agentId: String, intentId: String, text: String) throws -> Bool {
        if AgentInjectionQueue.blank(text) { throw InjectionRefused() }
        return lock.withLock {
            guard var entry = entries[agentId], let index = entry.intents.firstIndex(where: { $0.id == intentId }) else { return false }
            entry.intents[index] = AgentInjectionIntent(id: intentId, text: text, state: .confirmed)
            entries[agentId] = entry
            return true
        }
    }

    /// The person closed the sheet without agreeing. Nothing is sent, and the
    /// cancellation is *recorded*.
    public func cancel(_ agentId: String, intentId: String) -> Bool {
        lock.withLock {
            guard var entry = entries[agentId], let index = entry.intents.firstIndex(where: { $0.id == intentId }) else { return false }
            entry.intents.remove(at: index)
            entry.lastResult = .cancelled
            entries[agentId] = entry
            return true
        }
    }

    /// The intent under review for this Agent, if one is.
    public func pending(_ agentId: String, intentId: String) -> AgentInjectionIntent? {
        lock.withLock { entries[agentId]?.intents.first { $0.id == intentId } }
    }

    /// This round's reading, and the text that is now due — if any.
    ///
    /// The idle run is counted before the head intent's state is looked at,
    /// and that ordering is the whole of "either wait may finish first".
    public func due(_ agentId: String, status: TerminalAgentStatus, now: Double = Date().timeIntervalSince1970 * 1000) -> String? {
        lock.withLock {
            guard var entry = entries[agentId] else { return nil }
            defer { entries[agentId] = entry }
            if !status.atPrompt {
                // Any reading that is not at the prompt starts the wait over.
                entry.idleSince = nil
                entry.idleReadings = 0
                return nil
            }
            if entry.idleSince == nil { entry.idleSince = now }
            entry.idleReadings += 1
            if entry.idleReadings < AgentInjectionQueue.idleReadingsBeforeSend { return nil }
            if now - (entry.idleSince ?? now) < AgentInjectionQueue.idleSettleMs { return nil }
            guard let head = entry.intents.first, head.state == .confirmed else { return nil }
            return head.text
        }
    }

    /// The text went. Drop the intent and say so; the next one waits for the
    /// whole settle window again.
    public func sent(_ agentId: String) {
        lock.withLock {
            guard var entry = entries[agentId] else { return }
            if !entry.intents.isEmpty { entry.intents.removeFirst() }
            entry.lastResult = .sent
            entry.idleSince = nil
            entry.idleReadings = 0
            entries[agentId] = entry
        }
    }

    /// The send failed. The intent stays queued and the reason is kept.
    public func failed(_ agentId: String, reason: String) {
        lock.withLock {
            guard var entry = entries[agentId] else { return }
            entry.lastResult = .failed(reason: reason)
            entry.idleSince = nil
            entry.idleReadings = 0
            entries[agentId] = entry
        }
    }

    /// What this Agent's queue is doing, for the row to show.
    public func state(_ agentId: String, status: TerminalAgentStatus) -> AgentInjection {
        lock.withLock {
            guard let entry = entries[agentId] else { return .none }
            let waiting: AgentInjectionWait
            if let head = entry.intents.first {
                waiting = head.state == .pendingReview ? .awaitingReview : AgentInjectionQueue.waitFor(status)
            } else {
                waiting = .nothingQueued
            }
            return AgentInjection(queued: entry.intents.count, waitingFor: waiting, lastResult: entry.lastResult)
        }
    }

    /// An Agent that ended, and whatever it was never told: the undelivered
    /// intents come back so the caller can say so.
    public func forget(_ agentId: String) -> [AgentInjectionIntent] {
        lock.withLock { entries.removeValue(forKey: agentId)?.intents ?? [] }
    }

    static func waitFor(_ status: TerminalAgentStatus) -> AgentInjectionWait {
        switch status {
        case .idle, .background: return .settling
        case .working: return .agentBusy
        case .waiting: return .agentAsking
        default: return .agentUnreadable
        }
    }
}

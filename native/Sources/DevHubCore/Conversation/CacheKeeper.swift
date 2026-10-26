// Port of apps/desktop/src/main/agent/conversation/cacheKeeper.ts
//
// Compacting an idle GUI Agent's conversation just before its prompt cache
// goes cold (`[agents] auto_compact_before_cache_expiry`).
//
// The adapter works out when the main conversation's cached prefix expires
// (`Usage.promptCache.expiresAt`: the last response's time plus the TTL of
// the last cache write). A conversation left idle past that point costs a
// full re-write of its whole prefix on the next message. Sending `/compact`
// while the cache is still warm reads that prefix from cache for the summary,
// and leaves a much smaller conversation whose next re-write is cheap. The
// cache matters only when the compaction's request starts, so `lead` has to
// cover the time to get it written and sent, with margin.
//
// It fires at most once per warm period (one `expiresAt`), only while the
// Agent is fully idle — no turn, no question, nothing held, sending or
// compacting, no usage-limit resume standing — only for a conversation of at
// least `minTokens` of context, and never when the conversation has not
// moved on since its last compaction. A timer that comes late (the Mac slept)
// finds less than `MIN_REMAINING_MS` left, or the cache already cold, and
// does nothing. Anything the person does moves the conversation on, which is
// re-observed: a busy Agent at the deadline is skipped.

import Foundation

public struct CacheKeepSettings: Hashable, Sendable {
    /// `[agents] auto_compact_before_cache_expiry`.
    public var enabled: Bool
    /// `[agents] auto_compact_lead_seconds`: how long before expiry it fires.
    public var leadSeconds: Double
    /// `[agents] auto_compact_min_tokens`: smaller conversations are left alone.
    public var minTokens: Double

    public init(enabled: Bool, leadSeconds: Double, minTokens: Double) {
        self.enabled = enabled
        self.leadSeconds = leadSeconds
        self.minTokens = minTokens
    }
}

public let CACHE_KEEP_OFF = CacheKeepSettings(enabled: false, leadSeconds: 60, minTokens: 20_000)

/// With less than this left, a compaction would not start in time to read the cache.
public let MIN_REMAINING_MS: Double = 15_000

public let AUTO_COMPACT_COMMAND = "/compact"

/// When the conversation should be compacted, or nil when it should not.
public func compactDue(_ transcript: Transcript, _ settings: CacheKeepSettings) -> (expiresAt: Double, at: Double)? {
    guard settings.enabled, idleForCompaction(transcript), let expiresAt = transcript.usage?.promptCache?.expiresAt else {
        return nil
    }
    if (transcript.usage?.contextTokens ?? 0) < settings.minTokens { return nil }
    if compactedLast(transcript) { return nil }
    return (expiresAt, expiresAt - settings.leadSeconds * 1000)
}

private func idleForCompaction(_ transcript: Transcript) -> Bool {
    transcript.state == .ready(turn: .none) && transcript.requests.isEmpty && transcript.pending.isEmpty
        && transcript.sending.isEmpty && !transcript.compacting && transcript.limitResume == nil
}

/// Whether nothing was said since the conversation's last compaction.
private func compactedLast(_ transcript: Transcript) -> Bool {
    for entry in transcript.entries.reversed() {
        if entry.parent != nil { continue }
        switch entry {
        case .compaction: return true
        case .user, .assistant: return false
        default: continue
        }
    }
    return false
}

/// Not Sendable: one belongs to one conversation, which calls it from its own isolation.
public final class CacheKeeper {
    private let settings: @Sendable () -> CacheKeepSettings
    private let clock: ConversationClock
    private let due: @Sendable () -> Void
    private var armed: (expiresAt: Double, at: Double, disarm: @Sendable () -> Void)?
    /// The warm period (its `expiresAt`) already compacted for.
    private var fired: Double?
    private var latest: Transcript?
    private var stopped = false

    /// - Parameter due: the compaction is due: the conversation asks `take` in its turn.
    public init(
        settings: @escaping @Sendable () -> CacheKeepSettings, clock: ConversationClock,
        due: @escaping @Sendable () -> Void
    ) {
        self.settings = settings
        self.clock = clock
        self.due = due
    }

    /// The conversation after an event.
    public func observe(_ transcript: Transcript) {
        latest = transcript
        if stopped { return }
        guard let due = compactDue(transcript, settings()), due.expiresAt != fired else {
            disarm()
            return
        }
        if let armed, armed.expiresAt == due.expiresAt, armed.at == due.at { return }
        disarm()
        let wait = max(0, due.at - clock.now())
        armed = (due.expiresAt, due.at, clock.after(wait, self.due))
    }

    /// Whether to write `/compact` now: the conversation still qualifies, the
    /// time has come, and the cache is still warm enough. Either way the warm
    /// period's chance is used up unless the timer came early.
    public func take(_ transcript: Transcript? = nil) -> Bool {
        guard let armed, let transcript = transcript ?? latest else { return false }
        let now = clock.now()
        if armed.at > now {
            self.armed = (armed.expiresAt, armed.at, clock.after(armed.at - now, due))
            return false
        }
        self.armed = nil
        fired = armed.expiresAt
        guard let due = compactDue(transcript, settings()), due.expiresAt == armed.expiresAt else { return false }
        return armed.expiresAt - now >= MIN_REMAINING_MS
    }

    /// The settings may have changed: the last conversation seen is judged
    /// again now. Without it, turning the setting on while a conversation sat
    /// idle armed nothing until its next event — which, for an idle one, is
    /// after its cache has gone cold.
    public func reconsider() {
        if let latest { observe(latest) }
    }

    /// When the armed compaction is due, if one is.
    public func dueAt() -> Double? { armed?.at }

    public func stop() {
        stopped = true
        disarm()
    }

    private func disarm() {
        armed?.disarm()
        armed = nil
    }
}

// Port of apps/desktop/src/model/noticeCenter.ts and noticeEpisodes.ts
//
// The notice center: what the application said recently, newest first.
//
// A toast is on screen for a while and then hides itself; hiding is not
// dismissing, so what it said is kept here, where it can be read again,
// copied, and — while it is still in force — acted on. Memory only and
// bounded.
//
// Pure, so the rules are tested without a window: one entry per notice that
// reached the screen; a notice whose words moved while it stood is the same
// entry; an entry is `current` until what it reports is over and `read` once
// the person has seen it.

import Foundation

/// Anything the center can hold: what makes two notices the same notice.
public protocol IdentifiedNotice: Equatable, Sendable {
    var identity: String { get }
}

public struct CenterEntry<N: IdentifiedNotice>: Equatable, Sendable {
    /// Unique within the run, so two episodes of one notice are two rows.
    public var key: Int
    public var notice: N
    /// When it reached the screen, in ms since the epoch.
    public var at: Double
    public var read: Bool
    /// Still in force: its actions still mean something.
    public var current: Bool

    public init(key: Int, notice: N, at: Double, read: Bool, current: Bool) {
        self.key = key
        self.notice = notice
        self.at = at
        self.read = read
        self.current = current
    }
}

public enum NoticeCenter {
    /// `general.notice_seconds`: how long a toast stays up; `0` is for ever.
    public static let defaultNoticeSeconds = 8
    /// The most entries kept; the oldest goes first.
    public static let limit = 100

    /// A notice reached the screen. The newest current entry with the same
    /// identity is the same notice, so it is updated in place.
    public static func shown<N>(_ center: [CenterEntry<N>], _ notice: N, at: Double, key: Int) -> [CenterEntry<N>] {
        if let index = center.firstIndex(where: { $0.current && $0.notice.identity == notice.identity }) {
            if center[index].notice == notice { return center }
            var next = center
            next[index].notice = notice
            return next
        }
        return Array(([CenterEntry(key: key, notice: notice, at: at, read: false, current: true)] + center).prefix(limit))
    }

    /// What these entries report is over: they stay, as history, without actions.
    public static func ended<N>(_ center: [CenterEntry<N>], _ ended: (N) -> Bool) -> [CenterEntry<N>] {
        guard center.contains(where: { $0.current && ended($0.notice) }) else { return center }
        return center.map { entry in
            var copy = entry
            if entry.current && ended(entry.notice) { copy.current = false }
            return copy
        }
    }

    /// The person has seen these: one identity's current entry, or all of them.
    public static func read<N>(_ center: [CenterEntry<N>], identity: String? = nil) -> [CenterEntry<N>] {
        func matches(_ entry: CenterEntry<N>) -> Bool {
            !entry.read && (identity == nil || (entry.current && entry.notice.identity == identity))
        }
        guard center.contains(where: matches) else { return center }
        return center.map { entry in
            var copy = entry
            if matches(entry) { copy.read = true }
            return copy
        }
    }

    public static func removed<N>(_ center: [CenterEntry<N>], key: Int) -> [CenterEntry<N>] {
        center.filter { $0.key != key }
    }

    public static func unreadCount<N>(_ center: [CenterEntry<N>]) -> Int { center.filter { !$0.read }.count }
}

/// One episode, one notice — the rule from `machineConditions.ts`, moved to
/// the seam so no publisher can flap however fast it runs.
///
/// A publisher raises as often as it likes and the page hears about it once.
/// Two things end an episode: **quiet** (`quietMs` without a publish) and
/// **the page saying the notice is off screen**.
public struct NoticeEpisodes: Sendable {
    /// How long a publisher must be quiet before its next word is news again.
    public static let defaultQuietMs: Double = 5_000

    private var lastAt: [String: Double] = [:]
    private let quietMs: Double
    private let now: @Sendable () -> Double

    public init(quietMs: Double = NoticeEpisodes.defaultQuietMs, now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
        self.quietMs = quietMs
        self.now = now
    }

    /// Whether this publish is the start of an episode, and so reaches the page.
    public mutating func begins(_ identity: String) -> Bool {
        let at = now()
        let last = lastAt[identity]
        lastAt[identity] = at
        guard let last else { return true }
        return at - last >= quietMs
    }

    /// The page says this notice is no longer on screen.
    public mutating func ended(_ identity: String) { lastAt[identity] = nil }

    /// Every episode in this channel is over.
    public mutating func endedAll() { lastAt = [:] }
}

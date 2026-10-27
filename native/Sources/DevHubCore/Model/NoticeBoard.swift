// Port of apps/desktop/src/shell/notices.ts (`useAppNotices`),
// apps/desktop/src/shell/alertLifetime.ts (`useAlertLifetime`),
// apps/desktop/src/shell/toasts/autoHide.ts (`useAutoHide`), and of the
// notice center's open state in apps/desktop/src/shell/toasts/ToastsApp.tsx.
//
// What the application itself has to say, and how long it says it for. A
// notice is app-scoped by construction: about DevHub, not about one Agent and
// not about one workspace (those draw at their subject).
//
// # Slots, and why there is more than one notice
//
// Failures share one slot under the alert lifetime rule: "a newer failure
// replaces the one on screen". Conditions do not share one: each *source*
// holds its own, because two sources are two standing facts and one of them
// ending says nothing about the other. The stack on screen is every slot that
// has something to say: a condition where it first appeared, the failure slot
// moved to the newest end whenever a failure is raised.
//
// # Failures and conditions are retired differently
//
// A **failure** is about something the person just asked for, so all three
// exits apply to it, the person's next action included. A **condition** is
// not about any action (`gh` is not on the PATH, the network dropped), so it
// is retired by the person dismissing it, or by *its own source retracting
// it* — which also forgets that it was dismissed: it genuinely ended, so its
// coming back is news.
//
// # Hiding is not dismissing
//
// A toast hides itself after a while the way the person's × would put it away
// — so a repeat does not bring it straight back — but what it said is kept in
// the notice center, unread if nobody looked at it.

import Foundation

/// One sentence the application has to say, and what can be done about it.
public struct Notice: IdentifiedNotice, Hashable {
    public enum Live: String, Sendable { case alert, status }

    /// What makes two notices the same notice: the code and the subject, never
    /// the sentence.
    public var identity: String
    public var summary: String
    public var detail: String?
    public var actions: [AppErrorAction]
    /// A failure interrupts (`alert`); a condition does not (`status`).
    public var live: Live

    public init(identity: String, summary: String, detail: String? = nil, actions: [AppErrorAction] = [], live: Live) {
        self.identity = identity
        self.summary = summary
        self.detail = detail
        self.actions = actions
        self.live = live
    }

    /// `failureNotice`: the code alone is the identity on this app-scoped channel.
    public static func failure(_ error: AppError) -> Notice {
        Notice(identity: error.code.failureIdentity, summary: error.summary, detail: error.detail, actions: error.actions, live: .alert)
    }

    /// `noticeText`: what Cmd+C puts on the clipboard with nothing selected.
    public var text: String { detail.map { "\(summary)\n\($0)" } ?? summary }
}

/// Why a notice left the screen (`NoticeRetiredWire`).
public enum NoticeRetirement: String, Sendable {
    case person, timeout, source
    case nextAction = "next_action"
}

/// `useAlertLifetime`: a failure is retired by exactly three things — the
/// person dismisses it, the person starts another action, or a *different*
/// failure replaces it. Nothing that merely arrives can bring a dismissed
/// failure back.
public struct AlertLifetime<E: Equatable & Sendable>: Equatable, Sendable {
    public private(set) var alert: E?
    private var dismissed: String?
    private let identity: @Sendable (E) -> String

    public init(identity: @escaping @Sendable (E) -> String) {
        self.identity = identity
    }

    public static func == (lhs: AlertLifetime<E>, rhs: AlertLifetime<E>) -> Bool {
        lhs.alert == rhs.alert && lhs.dismissed == rhs.dismissed
    }

    /// Something failed.
    public mutating func raise(_ error: E) {
        if dismissed == identity(error) { return }
        dismissed = nil
        alert = error
    }

    /// The person started another action.
    public mutating func clear() {
        dismissed = nil
        alert = nil
    }

    /// The person put the alert away.
    public mutating func dismiss() {
        dismissed = alert.map(identity)
        alert = nil
    }
}

/// The notices' one state (`useAppNotices`), and the notice center beside it.
public struct NoticeBoard {
    /// The failures' one slot in the stack's order.
    static let failureSlot = "failure"

    private var failure = AlertLifetime<Notice>(identity: { $0.identity })
    private var conditions: [String: Notice] = [:]
    private var order: [String] = []
    private var putAwayConditions = Set<String>()
    private var failureEpisodes: NoticeEpisodes
    public private(set) var center: [CenterEntry<Notice>] = []
    private var nextKey = 0
    private let now: () -> Double
    /// Told when a notice left the screen, and by which rule.
    public var onRetired: ((String, NoticeRetirement) -> Void)?

    /// Whether the notice center is open, and which of its entries were news
    /// when it opened (marked New for as long as it stays open).
    public private(set) var openUnread: Set<Int>?

    public init(now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
        self.now = now
        failureEpisodes = NoticeEpisodes(now: now)
    }

    /// What is on screen, oldest first — so the newest is nearest the corner.
    public var notices: [Notice] {
        order.compactMap { slot in slot == Self.failureSlot ? failure.alert : conditions[slot] }
    }

    public var unreadCount: Int { NoticeCenter.unreadCount(center) }

    public var isCenterOpen: Bool { openUnread != nil }

    private mutating func record(_ notice: Notice) {
        let key = nextKey
        nextKey += 1
        var current = center
        // A newer failure replaces the one on screen, so that one is over.
        if notice.live == .alert {
            current = NoticeCenter.ended(current) { $0.live == .alert && $0.identity != notice.identity }
        }
        center = NoticeCenter.shown(current, notice, at: now(), key: key)
        if isCenterOpen { center = NoticeCenter.read(center) }
    }

    /// The application failed at something that was asked of it.
    public mutating func raiseFailure(_ error: AppError) {
        let notice = Notice.failure(error)
        // Not a failure dropped: what it would raise is already on screen.
        guard failureEpisodes.begins(notice.identity) else { return }
        if order.last != Self.failureSlot {
            order = order.filter { $0 != Self.failureSlot } + [Self.failureSlot]
        }
        let before = failure.alert
        failure.raise(notice)
        if let shown = failure.alert, shown != before || before == nil { record(shown) }
    }

    /// What a source says about a condition it watches, every time it looks;
    /// nil means it does not hold — the source retracting it.
    public mutating func observeCondition(source: String, summary: String?) {
        let identity = appConditionIdentity(source)
        guard let summary else {
            putAwayConditions.remove(identity)
            center = NoticeCenter.ended(center) { $0.identity == identity }
            if takeCondition(identity) { onRetired?(identity, .source) }
            return
        }
        if putAwayConditions.contains(identity) { return }
        let held = conditions[identity]
        if held?.summary == summary { return }
        let notice = Notice(identity: identity, summary: summary, live: .status)
        conditions[identity] = notice
        if held == nil { order.append(identity) }
        record(notice)
    }

    /// The person started another action. Retires failures, not conditions.
    public mutating func clearFailure() {
        if let retiring = failure.alert { onRetired?(retiring.identity, .nextAction) }
        failureEpisodes.endedAll()
        failure.clear()
        center = NoticeCenter.ended(center) { $0.live == .alert }
    }

    @discardableResult
    private mutating func takeCondition(_ identity: String) -> Bool {
        guard conditions.removeValue(forKey: identity) != nil else { return false }
        order.removeAll { $0 == identity }
        return true
    }

    /// Off the stack, by the person or by the clock; remembered either way.
    private mutating func putAway(_ identity: String, _ reason: NoticeRetirement) {
        let wasCondition = takeCondition(identity)
        if wasCondition { putAwayConditions.insert(identity) }
        let wasFailure = failure.alert?.identity == identity
        if wasFailure {
            failure.dismiss()
            failureEpisodes.ended(identity)
        }
        if wasCondition || wasFailure { onRetired?(identity, reason) }
    }

    /// The person looked at it (pointer or keyboard on the toast).
    public mutating func seen(_ identity: String) {
        center = NoticeCenter.read(center, identity: identity)
    }

    /// The person put one notice away: seen, and kept in the center as read.
    public mutating func dismiss(_ identity: String) {
        seen(identity)
        putAway(identity, .person)
    }

    /// Its time on screen ran out: off the stack, kept in the center.
    public mutating func hide(_ identity: String) {
        putAway(identity, .timeout)
    }

    /// `Cmd+Q D`: the newest notice put away. False when there was none.
    @discardableResult
    public mutating func dismissNewest() -> Bool {
        guard let newest = notices.last else { return false }
        dismiss(newest.identity)
        return true
    }

    /// Take one entry out of the center, and its toast off screen with it.
    public mutating func remove(_ key: Int) {
        if let entry = center.first(where: { $0.key == key }), entry.current { putAway(entry.notice.identity, .person) }
        center = NoticeCenter.removed(center, key: key)
    }

    /// Empty the center, and the stack with it.
    public mutating func clearAll() {
        for notice in notices { putAway(notice.identity, .person) }
        center = []
    }

    // MARK: The center

    /// `Cmd+Q M`: opening it is seeing everything in it; what was unread is
    /// marked New for as long as it stays open.
    public mutating func openCenter() {
        openUnread = Set(center.filter { !$0.read }.map(\.key))
        center = NoticeCenter.read(center)
    }

    public mutating func closeCenter() {
        openUnread = nil
    }

    /// `Cmd+Q M` again closes it, as a popover's own key does.
    public mutating func toggleCenter() {
        if isCenterOpen { closeCenter() } else { openCenter() }
    }

    /// `entryState`: what kind of thing an entry is, and whether it still holds.
    public static func entryState(_ entry: CenterEntry<Notice>) -> String {
        if entry.notice.live == .alert { return "Error" }
        return entry.current ? "Ongoing" : "Resolved"
    }
}

/// A toast's time on screen (`useAutoHide`): `general.notice_seconds` after it
/// appears it hides itself, `0` never. The clock stops while the person is
/// with it — the pointer over it, the keyboard in it, or words in it selected
/// — and when they leave it runs on from where it stopped, with at least
/// `resumeFloorMs` left.
public struct AutoHideClock: Equatable, Sendable {
    public static let resumeFloorMs: Double = 2_000

    public private(set) var seconds: Double
    /// What is left of the time on screen.
    public private(set) var remainingMs: Double
    public private(set) var hovered = false
    public private(set) var focused = false
    public private(set) var selected = false
    private var wasPaused = false
    /// When the clock last started running, if it is running.
    private var runningSince: Double?

    public init(seconds: Double, now: Double) {
        self.seconds = seconds
        remainingMs = seconds * 1000
        if seconds > 0 { runningSince = now }
    }

    public var paused: Bool { hovered || focused || selected }

    /// When the toast hides itself, if the clock is running; nil while it waits
    /// or for ever.
    public var deadline: Double? {
        guard seconds > 0, !paused, let since = runningSince else { return nil }
        return since + (wasPaused ? max(Self.resumeFloorMs, remainingMs) : remainingMs)
    }

    public func due(at now: Double) -> Bool { deadline.map { now >= $0 } ?? false }

    private mutating func change(_ now: Double, _ edit: (inout AutoHideClock) -> Void) {
        let before = paused
        if !before, let since = runningSince {
            // The clock ran until now.
            let budget = wasPaused ? max(Self.resumeFloorMs, remainingMs) : remainingMs
            remainingMs = budget - (now - since)
        }
        edit(&self)
        if paused {
            wasPaused = true
            runningSince = nil
        } else {
            runningSince = seconds > 0 ? now : nil
            if before && remainingMs < Self.resumeFloorMs { remainingMs = Self.resumeFloorMs }
        }
    }

    public mutating func setHovered(_ value: Bool, now: Double) { change(now) { $0.hovered = value } }
    public mutating func setFocused(_ value: Bool, now: Double) { change(now) { $0.focused = value } }
    public mutating func setSelected(_ value: Bool, now: Double) { change(now) { $0.selected = value } }

    /// A new setting starts the clock over.
    public mutating func setSeconds(_ next: Double, now: Double) {
        guard next != seconds else { return }
        seconds = next
        remainingMs = next * 1000
        wasPaused = false
        runningSince = next > 0 && !paused ? now : nil
    }
}

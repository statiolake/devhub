// Port of apps/desktop/src/shell/components/sidebar/usageRow.ts,
// apps/desktop/src/shell/usageLevel.ts, apps/desktop/src/shell/resetTime.ts
// and the data half of shell/components/sidebar/UsageLimits.tsx (the rows, the
// spoken label and the tooltip lines the Sidebar's foot draws).

import Foundation

/// How near its end a measure of use is, as every usage meter colours it: the
/// context under the composer, the Sidebar's rate-limit readout and the bars
/// in its tooltip. Quiet until it is `near` (75%), drawn in the warning ink,
/// and in the danger ink when `at` its end (90%).
public enum UsageLevel: String, Sendable, Equatable, Comparable {
    case calm, near, at

    public init(percent: Double?) {
        guard let percent, percent >= 75 else { self = .calm; return }
        self = percent < 90 ? .near : .at
    }

    var rank: Int {
        switch self {
        case .calm: return 0
        case .near: return 1
        case .at: return 2
        }
    }

    public static func < (lhs: UsageLevel, rhs: UsageLevel) -> Bool { lhs.rank < rhs.rank }
}

/// What one CLI's rate-limit row in the Sidebar says: which window it shows,
/// what that window reads now, how the row is coloured, and the caption that
/// says why when the colour is not the shown window's own.
///
/// The row shows the CLI's shortest window — the five-hour one over the
/// seven-day one — since that is the number that moves; a window of no known
/// length comes after every one whose length is known, and between those the
/// first reported is shown. A reading whose reset has passed is history: the
/// shown window reads as reset, `0% (reset)`, faded because it is inferred and
/// not read. The colour is the strictest level among every window, a reset one
/// counting as empty.
public struct UsageRow: Equatable, Sendable {
    /// The shown window's label.
    public var window: String
    /// How much of it is used now: 0 once it has reset.
    public var usedPercent: Double?
    /// When it resets, while that is known and still ahead.
    public var resetsAt: Double?
    /// Its last reading's reset has passed: it has started again since.
    public var stale: Bool
    public var level: UsageLevel
    /// Why the row is coloured, when another window than the shown one is the reason.
    public var caption: String?

    public init(window: String, usedPercent: Double?, resetsAt: Double?, stale: Bool, level: UsageLevel, caption: String?) {
        self.window = window
        self.usedPercent = usedPercent
        self.resetsAt = resetsAt
        self.stale = stale
        self.level = level
        self.caption = caption
    }

    private struct Reading {
        let window: String
        /// The window's length; a window of no known length is longer than any.
        let minutes: Double
        let usedPercent: Double?
        let resetsAt: Double?
        let stale: Bool
        let level: UsageLevel
    }

    /// What a window's last reading says of it now.
    private static func asOf(_ one: UsageLimitsWire.Window, _ now: Double) -> Reading {
        let stale = one.resetsAt.map { $0 <= now } ?? false
        let used = stale ? 0 : one.usedPercent
        return Reading(
            window: one.window,
            minutes: one.durationMinutes ?? .infinity,
            usedPercent: used,
            resetsAt: stale ? nil : one.resetsAt,
            stale: stale,
            level: UsageLevel(percent: used)
        )
    }

    public static func of(_ windows: [UsageLimitsWire.Window], now: Double) -> UsageRow? {
        let readings = windows.map { asOf($0, now) }
        var shown: Reading?
        for one in readings where shown == nil || one.minutes < shown!.minutes { shown = one }
        guard let shown else { return nil }
        var strictest = readings[0]
        for one in readings where one.level.rank > strictest.level.rank { strictest = one }
        return UsageRow(
            window: shown.window,
            usedPercent: shown.usedPercent,
            resetsAt: shown.resetsAt,
            stale: shown.stale,
            level: strictest.level,
            caption: strictest.level.rank > shown.level.rank ? caption(strictest.window, strictest.level) : nil
        )
    }

    private static func caption(_ label: String, _ level: UsageLevel) -> String {
        level == .at ? "\(label.prefix(1).uppercased())\(label.dropFirst()) limit nearly reached" : "Approaching \(label) limit"
    }
}

/// When a rate-limit window resets, as every readout of it says so.
public enum ResetTime {
    /// How near a reset is still said by the clock rather than by the date.
    static let clockHorizonMs = 12.0 * 60 * 60_000

    private static func formatter(_ template: String, _ timeZone: TimeZone, _ locale: Locale) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = timeZone
        formatter.setLocalizedDateFormatFromTemplate(template)
        return formatter
    }

    /// The time on the 24-hour clock, `16:50`, as
    /// `toLocaleTimeString(undefined, {hour: "2-digit", minute: "2-digit", hourCycle: "h23"})`.
    static func time(_ epochMs: Double, _ timeZone: TimeZone) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: Date(timeIntervalSince1970: epochMs / 1000))
    }

    /// The short date in the reader's locale, `10/3`.
    static func date(_ epochMs: Double, _ timeZone: TimeZone, _ locale: Locale) -> String {
        formatter("Md", timeZone, locale).string(from: Date(timeIntervalSince1970: epochMs / 1000))
    }

    /// The time, `16:50`, when the reset is within twelve hours of now, even
    /// past midnight; the date alone, `10/3`, when it is further off. A reset
    /// already past reads by the same distance. The Sidebar's usage row and its
    /// tooltip both use this, so one reset never reads two ways.
    public static func resetTime(_ epochMs: Double, now: Double, timeZone: TimeZone = .current, locale: Locale = .current) -> String {
        abs(epochMs - now) <= clockHorizonMs ? time(epochMs, timeZone) : date(epochMs, timeZone, locale)
    }

    /// When something timed by a reset happens, as a conversation line says it
    /// (*resuming at 16:50*): the time within twelve hours, the short date and
    /// the time further off, `10/3 16:50`.
    public static func clockTime(_ epochMs: Double, now: Double, timeZone: TimeZone = .current, locale: Locale = .current) -> String {
        let clock = time(epochMs, timeZone)
        return abs(epochMs - now) <= clockHorizonMs ? clock : "\(date(epochMs, timeZone, locale)) \(clock)"
    }

    /// How long until a rate-limit window resets, in the largest two units
    /// that say it: `in 2h 10m`, `in 3d 4h`, `in 12m`, `in under a minute`.
    public static func resetsIn(_ epochMs: Double, now: Double) -> String {
        let minutes = Int(((epochMs - now) / 60_000).rounded(.down))
        if minutes < 1 { return "in under a minute" }
        let days = minutes / (24 * 60)
        let hours = (minutes % (24 * 60)) / 60
        let rest = minutes % 60
        if days > 0 { return hours > 0 ? "in \(days)d \(hours)h" : "in \(days)d" }
        if hours > 0 { return rest > 0 ? "in \(hours)h \(rest)m" : "in \(hours)h" }
        return "in \(rest)m"
    }
}

/// The readout at the foot of the Sidebar, as data (`UsageLimits.tsx`).
///
/// One slim row per CLI that has reported: its name, a bar of how much is used
/// of its shortest window, the percentage and when that window resets,
/// `12% (until 16:50)`. A reset that is unknown has no parenthesis; one that
/// has passed reads `0% (reset)`, faded. A CLI whose sign-in has no plan limits
/// and no reading of any window has a quiet row, *No plan limits*, and no bar.
/// Nothing at all is drawn while neither CLI has anything to say.
public struct UsageReadout: Equatable, Sendable {
    public struct Row: Equatable, Sendable {
        public var cli: LimitedCli
        public var name: String
        public var shown: UsageRow
        /// `until 16:50`, `reset`, or nothing when the reset is unknown.
        public var until: String?
        /// The bar's fill, 0–100.
        public var fill: Double
        /// `12%`, or `?` when the CLI did not say.
        public var value: String
    }

    public struct Planless: Equatable, Sendable {
        public var cli: LimitedCli
        public var name: String
        public var note: String
    }

    public static let noPlanLimits = "No plan limits"

    public var rows: [Row]
    public var planless: [Planless]
    /// The accessible name: `Usage limits: Claude 12% until 20:00, 7-day limit nearly reached`.
    public var spoken: String
    /// The hover: per CLI, its name and a meter per window.
    public var tooltip: [TooltipLine]

    /// `nil` when there is nothing to draw.
    public static func of(_ limits: UsageLimitsWire, now: Double, timeZone: TimeZone = .current, locale: Locale = .current) -> UsageReadout? {
        let rows: [Row] = limits.clis.compactMap { one in
            guard let shown = UsageRow.of(one.windows ?? [], now: now) else { return nil }
            let until: String? = shown.stale ? "reset" : shown.resetsAt.map { "until \(ResetTime.resetTime($0, now: now, timeZone: timeZone, locale: locale))" }
            return Row(
                cli: one.cli,
                name: one.cli.displayName,
                shown: shown,
                until: until,
                fill: min(max(shown.usedPercent ?? 0, 0), 100),
                value: percent(shown.usedPercent)
            )
        }
        // Windows are the reading when there are any; the note is what is left.
        let planless = limits.clis.filter { one in one.note == .noPlanLimits && !rows.contains { $0.cli == one.cli } }
            .map { Planless(cli: $0.cli, name: $0.cli.displayName, note: noPlanLimits) }
        if rows.isEmpty && planless.isEmpty { return nil }
        let spoken = (rows.map { row in
            "\(row.name) \(row.value)\(row.until.map { " \($0)" } ?? "")\(row.shown.caption.map { ", \($0.lowercased())" } ?? "")"
        } + planless.map { "\($0.name) \(noPlanLimits)" }).joined(separator: ", ")
        return UsageReadout(rows: rows, planless: planless, spoken: "Usage limits: \(spoken)", tooltip: tooltipLines(limits))
    }

    static func percent(_ used: Double?) -> String {
        guard let used else { return "?" }
        return "\(Int(used.rounded(.toNearestOrAwayFromZero)))%"
    }

    /// What the tooltip says of a CLI besides its windows.
    static func noteText(_ note: UsageNote, _ cli: String) -> String {
        switch note {
        case .noPlanLimits: return "No plan limits for this \(cli) sign-in: an API key or a cloud provider"
        case .cliNotFound: return "Not read: the first \(cli) profile's command is not on this Mac"
        }
    }

    /// Per CLI, its name and a bar per window; the words about time are the
    /// tooltip's, worked out as it draws.
    static func tooltipLines(_ limits: UsageLimitsWire) -> [TooltipLine] {
        limits.clis.flatMap { one -> [TooltipLine] in
            let name = TooltipLine.fact(.init(text: one.cli.displayName, style: .name))
            let windows = one.windows ?? []
            let note: [TooltipLine] = one.note.map { [.fact(.init(text: noteText($0, one.cli.displayName), style: .note))] }
                ?? (windows.isEmpty ? [.fact(.init(text: "Not read yet", style: .note))] : [])
            return [name] + note + windows.map { .meter(.init(label: $0.window, usedPercent: $0.usedPercent, resetsAt: $0.resetsAt)) }
        }
    }
}

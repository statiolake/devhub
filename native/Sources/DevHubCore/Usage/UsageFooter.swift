// The layout half of apps/desktop/src/shell/components/sidebar/UsageLimits.tsx
// and its rules in shell/styles/shell.css (`.sidebar-usage*`): what the
// Sidebar's foot draws of a `UsageReadout`, line by line, in the column's
// quiet ink, coloured only near the limit, and how tall that is.
//
// One slim row per CLI: name, bar, percentage, when it resets; a caption under
// the bar when another window than the shown one is the reason for the colour;
// a quiet *No plan limits* row for a sign-in with none. On the rail the words
// go and the bars stay, and a sign-in with no limits has nothing. The rows
// share one grid, so every bar has the same edges whatever the width of the
// words beside it.

import Foundation

public enum UsageFooter {
    /// One drawn line of the foot.
    public enum Line: Equatable, Sendable {
        case meter(UsageReadout.Row)
        case planless(UsageReadout.Planless)
    }

    /// The column's metrics (`.sidebar-usage`): 10.5px type, 3px rows apart,
    /// 9.5px captions, padding 8 / 12 / 8 / 16, and on the rail a 20px column.
    public static let fontSize = 10.5
    public static let captionFontSize = 9.5
    public static let rowHeight = 13.0
    public static let captionHeight = 12.0
    public static let rowGap = 3.0
    public static let railRowGap = 4.0
    public static let railBarHeight = 3.0
    public static let padTop = 8.0
    public static let padBottom = 8.0
    public static let padLeading = 16.0
    public static let padTrailing = 12.0
    public static let railBarWidth = 20.0
    /// `grid-template-columns: 3.6em minmax(16px, 1fr) 2.6em minmax(0, max-content)`.
    public static let nameColumn = 3.6 * fontSize
    public static let valueColumn = 2.6 * fontSize
    public static let minBar = 16.0
    public static let columnGap = 8.0

    /// What the foot draws: every row, and on the rail only the bars.
    public static func lines(_ readout: UsageReadout?, collapsed: Bool) -> [Line] {
        guard let readout else { return [] }
        let meters = readout.rows.map(Line.meter)
        if collapsed { return meters }
        return meters + readout.planless.map(Line.planless)
    }

    /// How tall the foot is; zero when there is nothing to draw.
    public static func height(_ lines: [Line], collapsed: Bool) -> Double {
        guard !lines.isEmpty else { return 0 }
        if collapsed {
            return padTop + padBottom + Double(lines.count) * railBarHeight + Double(lines.count - 1) * railRowGap
        }
        let rows = lines.reduce(0.0) { total, line in
            if case let .meter(row) = line, row.shown.caption != nil { return total + rowHeight + captionHeight }
            return total + rowHeight
        }
        return padTop + padBottom + rows + Double(lines.count - 1) * rowGap
    }

    /// The token a row is drawn in: the column's quiet ink while calm, the
    /// warning ink near the limit, the danger ink at it.
    public static func ink(_ level: UsageLevel) -> String {
        switch level {
        case .calm: return "tertiary"
        case .near: return "waiting"
        case .at: return "danger"
        }
    }

    /// The bar's fill token: `secondary` while calm, the row's own ink otherwise.
    public static func fillInk(_ level: UsageLevel) -> String {
        level == .calm ? "secondary" : ink(level)
    }

    /// A reset that has passed is inferred, not read: the row is faded.
    public static func opacity(_ row: UsageReadout.Row) -> Double { row.shown.stale ? 0.5 : 1 }

    /// `(until 16:50)`, `(reset)`, or nothing.
    public static func resetText(_ row: UsageReadout.Row) -> String? { row.until.map { "(\($0))" } }

    /// The bar's width at a column width (`minmax(16px, 1fr)`).
    public static func barWidth(columnWidth: Double, resetWidth: Double) -> Double {
        let available = columnWidth - padLeading - padTrailing - nameColumn - valueColumn - 3 * columnGap - resetWidth
        return max(minBar, available)
    }
}

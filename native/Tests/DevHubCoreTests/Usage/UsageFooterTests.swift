// The Sidebar's usage foot (S-12): what `UsageLimits.tsx` draws, and how tall.
import XCTest
@testable import DevHubCore

final class UsageFooterTests: XCTestCase {
    let now = 1_000_000_000_000.0
    let hour = 3_600_000.0

    func readout() -> UsageReadout? {
        UsageReadout.of(UsageLimitsWire(clis: [
            .init(cli: .claude, windows: [
                .init(window: "5-hour", durationMinutes: 300, usedPercent: 12, resetsAt: now + hour),
                .init(window: "7-day", durationMinutes: 10_080, usedPercent: 80, resetsAt: now + 50 * hour),
            ]),
            .init(cli: .codex, note: .noPlanLimits),
        ]), now: now, timeZone: TimeZone(identifier: "UTC")!, locale: Locale(identifier: "en_US_POSIX"))
    }

    func testDrawsARowPerCliAndAQuietRowForASignInWithNoLimits() {
        let lines = UsageFooter.lines(readout(), collapsed: false)
        XCTAssertEqual(lines.count, 2)
        guard case let .meter(row) = lines[0], case let .planless(planless) = lines[1] else { return XCTFail("\(lines)") }
        XCTAssertEqual(row.name, "Claude")
        XCTAssertEqual(row.value, "12%")
        XCTAssertEqual(row.shown.caption, "Approaching 7-day limit")
        XCTAssertEqual(UsageFooter.ink(row.shown.level), "waiting")
        XCTAssertEqual(UsageFooter.fillInk(row.shown.level), "waiting")
        XCTAssertEqual(UsageFooter.resetText(row), "(until 02:46)")
        XCTAssertEqual(planless.note, "No plan limits")
        // Row, caption, gap, row; padding above and below.
        XCTAssertEqual(UsageFooter.height(lines, collapsed: false), 8 + 13 + 12 + 3 + 13 + 8)
    }

    func testTheRailDrawsBarsOnly() {
        let lines = UsageFooter.lines(readout(), collapsed: true)
        XCTAssertEqual(lines.count, 1)
        XCTAssertEqual(UsageFooter.height(lines, collapsed: true), 8 + 3 + 8)
    }

    func testNothingIsDrawnWhileNoCliHasAnythingToSay() {
        XCTAssertEqual(UsageFooter.lines(nil, collapsed: false), [])
        XCTAssertEqual(UsageFooter.height([], collapsed: false), 0)
        XCTAssertNil(UsageReadout.of(UsageLimitsWire(clis: [.init(cli: .claude)]), now: now))
    }

    func testAResetThatHasPassedIsFadedAndQuiet() {
        let stale = UsageReadout.of(UsageLimitsWire(clis: [
            .init(cli: .codex, windows: [.init(window: "5-hour", durationMinutes: 300, usedPercent: 95, resetsAt: now - hour)]),
        ]), now: now)!
        let row = stale.rows[0]
        XCTAssertEqual(UsageFooter.opacity(row), 0.5)
        XCTAssertEqual(UsageFooter.resetText(row), "(reset)")
        XCTAssertEqual(row.value, "0%")
        XCTAssertEqual(UsageFooter.ink(row.shown.level), "tertiary")
        XCTAssertEqual(UsageFooter.fillInk(.calm), "secondary")
        XCTAssertEqual(UsageFooter.barWidth(columnWidth: 100, resetWidth: 0), UsageFooter.minBar)
    }
}

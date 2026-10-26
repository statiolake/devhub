// Port of apps/desktop/src/shell/components/sidebar/usageRow.test.ts,
// shell/usageLevel.test.ts, shell/resetTime.test.ts,
// shell/components/sidebar/promptCacheFacts.test.ts, and the data assertions
// of shell/components/sidebar/usageLimits.test.tsx.

import Foundation
import XCTest
@testable import DevHubCore

final class UsageRowTests: XCTestCase {
    private let now = 1_000_000_000_000.0
    private let hour = 60.0 * 60 * 1000
    private let fiveHours = 5.0 * 60
    private let sevenDays = 7.0 * 24 * 60

    private func window(_ name: String, _ minutes: Double?, _ used: Double?, _ resets: Double?) -> UsageLimitsWire.Window {
        UsageLimitsWire.Window(window: name, durationMinutes: minutes, usedPercent: used, resetsAt: resets)
    }

    // MARK: a usage row

    func testShowsTheShortestWindowEvenWhenALongerOneResetsSooner() {
        let five = window("5-hour", fiveHours, 12, now + 4 * hour)
        let seven = window("7-day", sevenDays, 40, now + hour)
        XCTAssertEqual(UsageRow.of([seven, five], now: now), UsageRow(window: "5-hour", usedPercent: 12, resetsAt: now + 4 * hour, stale: false, level: .calm, caption: nil))
    }

    func testShowsTheShortestWindowAsResetWhenItsLastReadingsResetHasPassed() {
        let five = window("5-hour", fiveHours, 99, now - hour)
        let seven = window("7-day", sevenDays, 30, now + 50 * hour)
        let reset = UsageRow(window: "5-hour", usedPercent: 0, resetsAt: nil, stale: true, level: .calm, caption: nil)
        XCTAssertEqual(UsageRow.of([five, seven], now: now), reset)
        XCTAssertEqual(UsageRow.of([window("7-day", sevenDays, 95, now - 1), five], now: now), reset)
        XCTAssertNil(UsageRow.of([], now: now))
    }

    func testTakesTheStrictestColourOfEveryWindowAndNamesTheOneItComesFrom() {
        let five = window("5-hour", fiveHours, 12, now + hour)
        let near = window("7-day", sevenDays, 80, now + 9 * hour)
        let row = UsageRow.of([near, five], now: now)
        XCTAssertEqual(row?.window, "5-hour")
        XCTAssertEqual(row?.level, .near)
        XCTAssertEqual(row?.caption, "Approaching 7-day limit")
        let reset = window("5-hour", fiveHours, 91, now - hour)
        let at = window("7-day", sevenDays, 95, now + 9 * hour)
        let strict = UsageRow.of([reset, at], now: now)
        XCTAssertEqual(strict?.window, "5-hour")
        XCTAssertEqual(strict?.usedPercent, 0)
        XCTAssertEqual(strict?.stale, true)
        XCTAssertEqual(strict?.level, .at)
        XCTAssertEqual(strict?.caption, "7-day limit nearly reached")
    }

    func testSaysNoCaptionWhenTheShownWindowIsItselfTheStrictest() {
        let row = UsageRow.of([window("5-hour", fiveHours, 91, now + hour), window("7-day", sevenDays, 93, now + 50 * hour)], now: now)
        XCTAssertEqual(row?.window, "5-hour")
        XCTAssertEqual(row?.level, .at)
        XCTAssertNil(row?.caption)
    }

    func testOrdersWindowsByTheLengthDecodedWithThemNeverByTheirName() {
        let day = window("1-day", 1440, 5, now + hour)
        let session = window("session", 90, 60, now + 2 * hour)
        let secondary = window("secondary", nil, 10, nil)
        XCTAssertEqual(UsageRow.of([secondary, day, session], now: now)?.window, "session")
        XCTAssertEqual(UsageRow.of([secondary, day], now: now)?.window, "1-day")
        XCTAssertEqual(UsageRow.of([window("5-minute", nil, 1, nil), day], now: now)?.window, "1-day")
        XCTAssertEqual(UsageRow.of([window("primary", nil, 50, nil), secondary], now: now)?.window, "primary")
    }

    // MARK: usageLevel

    func testIsCalmBelow75NearTo90AndAtItsEndFrom90() {
        XCTAssertEqual(UsageLevel(percent: nil), .calm)
        XCTAssertEqual(UsageLevel(percent: 0), .calm)
        XCTAssertEqual(UsageLevel(percent: 74.9), .calm)
        XCTAssertEqual(UsageLevel(percent: 75), .near)
        XCTAssertEqual(UsageLevel(percent: 89.9), .near)
        XCTAssertEqual(UsageLevel(percent: 90), .at)
        XCTAssertEqual(UsageLevel(percent: 100), .at)
        XCTAssertEqual(UsageLevel(percent: 120), .at)
    }

    // MARK: resetTime (the zone pinned to Tokyo, the locale to en-US)

    private let tokyo = TimeZone(identifier: "Asia/Tokyo")!
    private let english = Locale(identifier: "en_US")

    /// A local moment in Tokyo (UTC+9, no daylight saving).
    private func tokyo(_ month: Int, _ day: Int, _ hour: Int, _ minute: Int = 0) -> Double {
        var components = DateComponents()
        components.year = 2026
        components.month = month
        components.day = day
        components.hour = hour
        components.minute = minute
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = tokyo
        return calendar.date(from: components)!.timeIntervalSince1970 * 1000
    }

    private func resetTime(_ at: Double, _ now: Double) -> String {
        ResetTime.resetTime(at, now: now, timeZone: tokyo, locale: english)
    }

    func testSaysTheTimeOnThe24HourClockForAResetWithin12Hours() {
        let now = tokyo(9, 27, 14, 5)
        XCTAssertEqual(resetTime(tokyo(9, 27, 16, 50), now), "16:50")
        XCTAssertEqual(resetTime(tokyo(9, 27, 23, 59), now), "23:59")
    }

    func testSaysTheTimeForAResetPastMidnightStillWithin12Hours() {
        let lateEvening = tokyo(9, 27, 21, 10)
        XCTAssertEqual(resetTime(tokyo(9, 28, 0, 0), lateEvening), "00:00")
        XCTAssertEqual(resetTime(tokyo(9, 28, 9, 9), lateEvening), "09:09")
    }

    func testSaysTheDateAloneOnceTheResetIsMoreThan12HoursAway() {
        let now = tokyo(9, 27, 14, 5)
        let lateEvening = tokyo(9, 27, 21, 10)
        XCTAssertEqual(resetTime(tokyo(9, 28, 9, 11), lateEvening), "9/28")
        XCTAssertEqual(resetTime(tokyo(9, 27, 12, 31), tokyo(9, 27, 0, 30)), "9/27")
        XCTAssertEqual(resetTime(tokyo(9, 30, 9, 18), now), "9/30")
        XCTAssertEqual(resetTime(tokyo(10, 3, 16, 50), now), "10/3")
        XCTAssertEqual(resetTime(tokyo(10, 27, 0, 0), now), "10/27")
    }

    func testWordsAResetAlreadyPastByTheSameDistance() {
        let now = tokyo(9, 27, 14, 5)
        XCTAssertEqual(resetTime(tokyo(9, 27, 2, 6), now), "02:06")
        XCTAssertEqual(resetTime(tokyo(9, 27, 2, 4), now), "9/27")
        XCTAssertEqual(resetTime(tokyo(9, 26, 9, 0), now), "9/26")
    }

    func testSaysHowLongInTheLargestTwoUnits() {
        let now = tokyo(9, 27, 14, 0)
        XCTAssertEqual(ResetTime.resetsIn(now + 30_000, now: now), "in under a minute")
        XCTAssertEqual(ResetTime.resetsIn(tokyo(9, 27, 14, 12), now: now), "in 12m")
        XCTAssertEqual(ResetTime.resetsIn(tokyo(9, 27, 16, 10), now: now), "in 2h 10m")
        XCTAssertEqual(ResetTime.resetsIn(tokyo(9, 30, 18, 0), now: now), "in 3d 4h")
    }

    func testAClockTimeSaysTheDateAndTheTimeFurtherOff() {
        let now = tokyo(9, 27, 14, 0)
        XCTAssertEqual(ResetTime.clockTime(tokyo(9, 27, 16, 50), now: now, timeZone: tokyo, locale: english), "16:50")
        XCTAssertEqual(ResetTime.clockTime(tokyo(10, 3, 16, 50), now: now, timeZone: tokyo, locale: english), "10/3 16:50")
    }

    // MARK: the usage-limits readout (UsageLimits.tsx)

    private var readoutNow: Double { tokyo(9, 25, 18, 0) }

    private func readout(_ clis: [UsageLimitsWire.Cli]) -> UsageReadout? {
        UsageReadout.of(UsageLimitsWire(clis: clis), now: readoutNow, timeZone: tokyo, locale: english)
    }

    func testDrawsNothingWhileNeitherCLIHasReported() {
        XCTAssertNil(readout([.init(cli: .claude), .init(cli: .codex)]))
    }

    func testDrawsABarPerCLIForItsShortestWindowColouredAndCaptionedByItsStrictest() {
        let now = readoutNow
        let shown = readout([
            .init(cli: .claude, windows: [window("5-hour", 300, 12, now + 2 * hour), window("7-day", 10_080, 97.6, now + 50 * hour)]),
            .init(cli: .codex),
        ])
        XCTAssertEqual(shown?.spoken, "Usage limits: Claude 12% until 20:00, 7-day limit nearly reached")
        XCTAssertEqual(shown?.rows.count, 1)
        let claude = shown?.rows.first
        XCTAssertEqual(claude?.value, "12%")
        XCTAssertEqual(claude?.until, "until 20:00")
        XCTAssertEqual(claude?.fill, 12)
        XCTAssertEqual(claude?.shown.level, .at)
        XCTAssertEqual(claude?.shown.caption, "7-day limit nearly reached")
        XCTAssertEqual(shown?.tooltip, [
            .fact(TooltipFact(text: "Claude", style: .name)),
            .meter(TooltipMeter(label: "5-hour", usedPercent: 12, resetsAt: now + 2 * hour)),
            .meter(TooltipMeter(label: "7-day", usedPercent: 97.6, resetsAt: now + 50 * hour)),
            .fact(TooltipFact(text: "Codex", style: .name)),
            .fact(TooltipFact(text: "Not read yet", style: .note)),
        ])
    }

    func testSaysQuietlyThatASignInHasNoPlanLimitsAndWhyACLIWasNotRead() {
        let shown = readout([.init(cli: .claude, note: .noPlanLimits), .init(cli: .codex, note: .cliNotFound)])
        XCTAssertEqual(shown?.spoken, "Usage limits: Claude No plan limits")
        XCTAssertEqual(shown?.rows, [])
        XCTAssertEqual(shown?.planless, [UsageReadout.Planless(cli: .claude, name: "Claude", note: "No plan limits")])
        XCTAssertEqual(shown?.tooltip, [
            .fact(TooltipFact(text: "Claude", style: .name)),
            .fact(TooltipFact(text: "No plan limits for this Claude sign-in: an API key or a cloud provider", style: .note)),
            .fact(TooltipFact(text: "Codex", style: .name)),
            .fact(TooltipFact(text: "Not read: the first Codex profile's command is not on this Mac", style: .note)),
        ])
    }

    func testDrawsTheWindowsWhenACLIHasAnyWhateverTheReadersNote() {
        let now = readoutNow
        let shown = readout([.init(cli: .claude, windows: [window("5-hour", 300, 40, now + hour)], note: .noPlanLimits), .init(cli: .codex)])
        XCTAssertEqual(shown?.rows.count, 1)
        XCTAssertEqual(shown?.planless, [])
        XCTAssertEqual(shown?.rows.first?.value, "40%")
        XCTAssertEqual(shown?.rows.first?.until, "until 19:00")
    }

    func testShowsTheShortestWindowAsResetFadedOnceItsLastReadingsResetHasPassed() {
        let now = readoutNow
        let shown = readout([
            .init(cli: .claude, windows: [window("5-hour", 300, 90, now - hour), window("7-day", 10_080, 80, now + hour)]),
            .init(cli: .codex, windows: [window("5-hour", 300, 96, now - hour)]),
        ])
        let claude = shown?.rows.first, codex = shown?.rows.last
        XCTAssertEqual(claude?.value, "0%")
        XCTAssertEqual(claude?.until, "reset")
        XCTAssertEqual(claude?.shown.stale, true)
        XCTAssertEqual(claude?.fill, 0)
        XCTAssertEqual(claude?.shown.level, .near)
        XCTAssertEqual(claude?.shown.caption, "Approaching 7-day limit")
        XCTAssertEqual(codex?.shown.level, .calm)
        XCTAssertNil(codex?.shown.caption)
        XCTAssertEqual(shown?.spoken, "Usage limits: Claude 0% reset, approaching 7-day limit, Codex 0% reset")
    }

    func testLeavesTheParenthesisOutWhenTheResetWasNotReported() {
        let shown = readout([.init(cli: .codex, windows: [window("weekly", nil, 41, nil)])])
        XCTAssertEqual(shown?.rows.first?.value, "41%")
        XCTAssertNil(shown?.rows.first?.until)
    }

    func testColoursARowByTheSharedRule() {
        let levels = [74.0, 75, 89, 90].map { used in
            readout([.init(cli: .claude, windows: [window("5-hour", 300, used, readoutNow + hour)])])?.rows.first?.shown
        }
        XCTAssertEqual(levels.map { $0?.level }, [.calm, .near, .near, .at])
        XCTAssertEqual(levels.map { $0?.caption }, [nil, nil, nil, nil])
    }

    // MARK: promptCacheFacts

    private let cache = PromptCache(ttlSeconds: 3600, ttlKnown: true, expiresAt: 10_000_000, hitRatio: 0.91, requests: 14, misses: 0, recacheTokens: 82_000)

    func testDrawsNothingWithoutACache() {
        XCTAssertEqual(PromptCacheFacts.facts(nil, now: 0), [])
    }

    func testCountsAWarmCacheDownAgainstItsTTL() {
        let fact = PromptCacheFacts.facts(cache, now: 10_000_000 - 38 * 60_000).first
        XCTAssertEqual(fact?.text, "Cache: warm · 38m left (1h TTL) · hit 91% · misses 0")
        XCTAssertEqual(fact?.tone, .unknown)
    }

    func testSaysWhenDevHubWillAutoCompactOnlyWhenItWill() {
        let now = 10_000_000.0 - 38 * 60_000
        var armed = cache
        armed.autoCompactAt = 10_000_000 - 60_000
        XCTAssertEqual(PromptCacheFacts.facts(armed, now: now).first?.text, "Cache: warm · 38m left (1h TTL) · auto-compact in 37m · hit 91% · misses 0")
        XCTAssertFalse(PromptCacheFacts.facts(cache, now: now).first?.text.contains("auto-compact") ?? true)
    }

    func testTurnsTheWaitingColourInTheLastFifthOfItsLife() {
        XCTAssertEqual(PromptCacheFacts.facts(cache, now: 10_000_000 - 5 * 60_000).first?.tone, .waiting)
    }

    func testSaysWhenTheTTLWasAssumed() {
        var assumed = cache
        assumed.ttlSeconds = 300
        assumed.ttlKnown = false
        XCTAssertTrue(PromptCacheFacts.facts(assumed, now: 10_000_000 - 45_000).first?.text.contains("45s left (5m TTL, assumed)") ?? false)
    }

    func testSaysWhatAColdCacheCostsTheNextMessage() {
        var missed = cache
        missed.misses = 2
        XCTAssertEqual(PromptCacheFacts.facts(missed, now: 10_000_001).first?.text, "Cache: cold · next message re-caches 82k tokens · hit 91% · misses 2")
        var cold = cache
        cold.expiresAt = nil
        XCTAssertTrue(PromptCacheFacts.facts(cold, now: 0).first?.text.hasPrefix("Cache: cold") ?? false)
    }

    func testRoundsTimeUpAndTokensToTheNearestUnit() {
        XCTAssertEqual(PromptCacheFacts.timeLeft(58_001), "59s")
        XCTAssertEqual(PromptCacheFacts.timeLeft(60_001), "2m")
        XCTAssertEqual(PromptCacheFacts.timeLeft(3_600_000), "1h 0m")
        XCTAssertEqual(PromptCacheFacts.tokenCount(950), "950")
        XCTAssertEqual(PromptCacheFacts.tokenCount(1_250_000), "1.3M")
    }
}

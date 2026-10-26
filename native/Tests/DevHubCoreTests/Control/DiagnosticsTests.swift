// Port of apps/desktop/src/main/diagnostics/counters.test.ts,
// rollingTally.test.ts and metrics.test.ts; the whole reading is compared
// with the one the TypeScript `metricsReport` wrote (Fixtures/control/metrics.json).

import Foundation
import XCTest
@testable import DevHubCore

/// A clock the test moves by hand, so a rate is an exact number.
final class DiagnosticsClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Double
    init(_ start: Double = 0) { value = start }
    var now: Double { lock.withLock { value } }
    func advance(_ ms: Double) { lock.withLock { value += ms } }
}

final class ActivityCountersTests: XCTestCase {
    func testReportsNothingBeforeAnythingHasHappened() {
        XCTAssertEqual(ActivityCounters(clock: { 0 }).read().counters, [])
    }

    func testCountsEachNameSeparatelyAndReportsAPerMinuteRate() {
        let clock = DiagnosticsClock(1_000)
        let counters = ActivityCounters(clock: { clock.now })
        for _ in 0..<60 { counters.record(CounterName.process("tmux")) }
        counters.record(CounterName.agentReconcileRound)
        clock.advance(30_000)
        XCTAssertEqual(
            counters.read(),
            CountersReading(elapsedMs: 30_000, counters: [
                CounterReading(name: "agent.reconcile.round", total: 1, perMinuteSinceStart: 2),
                CounterReading(name: "process.tmux", total: 60, perMinuteSinceStart: 120),
            ]))
    }

    func testSaysZeroRatherThanInfinityBeforeTheClockMovedAndNeverResets() {
        let counters = ActivityCounters(clock: { 5 })
        counters.record(CounterName.tmuxListSessions)
        XCTAssertEqual(
            counters.read(),
            CountersReading(elapsedMs: 0, counters: [CounterReading(name: "tmux.list-sessions", total: 1, perMinuteSinceStart: 0)]))
        XCTAssertEqual(counters.read(), counters.read())
    }
}

final class RollingTallyTests: XCTestCase {
    let minute = 60_000.0

    func testCountsWhatHappenedKeepsEachKeyToItselfAndForgetsTheWindowsPast() throws {
        let clock = DiagnosticsClock()
        let tally = try RollingTally(windowMs: minute, buckets: 60, clock: { clock.now })
        tally.record()
        tally.record()
        XCTAssertEqual(tally.count(), 2)
        tally.record("this-mac")
        tally.record("the-other-one")
        tally.record("the-other-one")
        XCTAssertEqual(tally.totals(), ["": 2, "this-mac": 1, "the-other-one": 2])
        clock.advance(minute + 1_000)
        XCTAssertEqual(tally.count(), 0)
        XCTAssertEqual(tally.totals().count, 0)
    }

    func testKeepsCountingAcrossTheRingComingRoundAgain() throws {
        let clock = DiagnosticsClock()
        let tally = try RollingTally(windowMs: minute, buckets: 60, clock: { clock.now })
        for _ in 0..<10 {
            for second in 0..<60 {
                if second > 0 { clock.advance(1_000) }
                tally.record()
            }
            XCTAssertEqual(tally.count(), 60)
            clock.advance(1_000)
        }
    }

    func testHoldsAFixedAmountHoweverManyEventsTimeOrKeysGoPast() throws {
        let clock = DiagnosticsClock()
        let busy = try RollingTally(windowMs: minute, buckets: 60, clock: { clock.now })
        for _ in 0..<1_000_000 { busy.record() }
        XCTAssertEqual(busy.count(), 1_000_000)
        XCTAssertEqual(busy.buckets, 60)
        XCTAssertEqual(busy.retained(), 1)

        let long = try RollingTally(windowMs: minute, buckets: 60, clock: { clock.now })
        for _ in 0..<100_000 {
            long.record()
            clock.advance(10)
        }
        XCTAssertEqual(long.retained(), long.buckets)
        XCTAssertLessThanOrEqual(long.count(), 6_000)

        let keyed = try RollingTally(windowMs: minute, buckets: 60, clock: { clock.now })
        for index in 0..<100_000 {
            keyed.record("identity-\(index)")
            clock.advance(10)
        }
        XCTAssertLessThanOrEqual(keyed.retained(), 6_000)
    }

    func testRefusesAWindowWithNoBucketsOrNoTime() {
        XCTAssertThrowsError(try RollingTally(windowMs: minute, buckets: 0)) { XCTAssertTrue("\($0)".contains("at least one")) }
        XCTAssertThrowsError(try RollingTally(windowMs: 0)) { XCTAssertTrue("\($0)".contains("needs a window")) }
    }

    func testReconcileRoundsArePerMachineOverTheLastMinute() {
        let clock = DiagnosticsClock()
        let rounds = ReconcileRounds(clock: { clock.now })
        rounds.record("local")
        rounds.record("local")
        rounds.record("ssh:box")
        XCTAssertEqual(rounds.lastMinute("local"), 2)
        XCTAssertEqual(rounds.lastMinute("ssh:box"), 1)
        clock.advance(61_000)
        XCTAssertEqual(rounds.lastMinute("local"), 0)
    }
}

final class MetricsReportTests: XCTestCase {
    func testTheReadingIsTheTypeScriptReportByteForByte() throws {
        let input = MetricsInput(
            takenAt: 1_767_323_045_678, uptimeMs: 61_000, titleBar: "hidden", workbench: "terminal",
            mainProcessCpu: (12_000, 8_000),
            processMetrics: [
                ProcessMetricInput(pid: 1, type: "Browser", cpuPercent: 2.5, memoryKb: 1000),
                ProcessMetricInput(pid: 7, type: "Tab", name: "x", cpuPercent: 5, memoryKb: 2000),
                ProcessMetricInput(pid: 9, type: "Tab", cpuPercent: 2.5, memoryKb: 3),
            ],
            views: [
                ViewIdentity(pid: 7, id: 1, surfaceKey: "workspace:hidden", onScreen: false),
                ViewIdentity(pid: 7, id: 2, surfaceKey: "workspace:shown", onScreen: true),
                ViewIdentity(pid: 9, id: 3, surfaceKey: nil, onScreen: false),
            ],
            counters: CountersReading(
                elapsedMs: 60_000, counters: [CounterReading(name: "process.tmux", total: 600, perMinuteSinceStart: 600)]),
            terminalClients: [TerminalClientReading(tty: "/dev/ttys003", session: "ws-abc")],
            runtimes: [
                RuntimeReading(
                    id: "local", connected: true, masterPid: nil, medianRoundTripMs: 1.5, reconcileIntervalMs: 2000,
                    execsLastMinute: 90, muxSessionsHeld: 0, muxSessionsWaiting: 0, muxFallbacks: 0,
                    loginEnvironmentNames: ["PATH"], lastFailure: nil),
                RuntimeReading(
                    id: "ssh:box", connected: false, masterPid: 4242, medianRoundTripMs: 40, reconcileIntervalMs: 5000,
                    execsLastMinute: 7, muxSessionsHeld: 2, muxSessionsWaiting: 1, muxFallbacks: 3, loginEnvironmentNames: [],
                    lastFailure: "box did not answer"),
            ],
            terminalLauncher: [TerminalLauncherStatus(machine: "local", installed: true, path: "/x/devhub-terminal")],
            pendingSweeps: ["ssh:box"],
            repositoryRounds: [
                WorkspaceRepositoryRound(
                    workspaceId: "w1", lastRepositoryRound: .init(at: "2026-01-02T03:04:00.000Z", trigger: .head))
            ],
            roundsLastMinute: { $0 == "local" ? 30 : 0 })
        XCTAssertEqual(MetricsReport.report(input).pretty, try WP7Fixtures.text("control/metrics.json"))
    }

    func testOrdersProcessesByCPUAndNamesASharedOneAfterTheViewOnScreen() {
        let input = MetricsInput(
            takenAt: 0, uptimeMs: 0, titleBar: "shown", mainProcessCpu: (0, 0),
            processMetrics: [
                ProcessMetricInput(pid: 1, type: "Tab", cpuPercent: 0.5), ProcessMetricInput(pid: 2, type: "GPU", cpuPercent: 9),
                ProcessMetricInput(pid: 3, type: "Tab", cpuPercent: 3),
            ],
            views: [
                ViewIdentity(pid: 3, id: 1, surfaceKey: "workspace:hidden", onScreen: false),
                ViewIdentity(pid: 3, id: 2, surfaceKey: "workspace:shown", onScreen: true),
            ],
            counters: CountersReading(elapsedMs: 0, counters: []))
        let processes = MetricsReport.processes(input)
        XCTAssertEqual(processes.map(\.cpuPercent), [9, 3, 0.5])
        XCTAssertEqual(processes[1].workbench?.surfaceKey, "workspace:shown")
        XCTAssertEqual(MetricsReport.report(input)["totalCpuPercent"], 12.5)
        XCTAssertEqual(MetricsReport.isoString(milliseconds: 0), "1970-01-01T00:00:00.000Z")
    }
}

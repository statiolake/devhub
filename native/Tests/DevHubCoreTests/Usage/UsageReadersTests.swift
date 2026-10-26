// Port of apps/desktop/src/main/shell/usageReaders.test.ts and
// main/shell/usageLimits.test.ts.
//
// The background usage readers, against scripted CLIs: what each one is sent
// (control requests and account reads only — never anything that starts a
// turn), how its answers are decoded, how often it asks, how its readings
// merge with a GUI Agent's, that each reading is its own process, killed
// after, and that a failure is said once per streak and retried at the next
// tick.

import Foundation
import XCTest
@testable import DevHubCore

// MARK: - Scripted CLIs

/// What a scripted CLI says back to one message: lines, or that it ends.
enum UsageScriptedAnswer {
    case lines([JsonValue])
    case end
}

final class UsageScriptedProcess: LineProcess, @unchecked Sendable {
    let command: UsageCommand
    let ended = EndSignal()
    private let answer: @Sendable (JsonValue) -> UsageScriptedAnswer
    private let lock = NSLock()
    private var listeners: [@Sendable (String) -> Void] = []
    private var messages: [JsonValue] = []
    private var wasKilled = false

    init(command: UsageCommand, answer: @escaping @Sendable (JsonValue) -> UsageScriptedAnswer) {
        self.command = command
        self.answer = answer
    }

    var sent: [JsonValue] { lock.lock(); defer { lock.unlock() }; return messages }
    var killed: Bool { lock.lock(); defer { lock.unlock() }; return wasKilled }

    func send(_ line: String) {
        guard let message = try? JsonValue.parse(line) else { return XCTFail("sent a line that is not JSON: \(line)") }
        lock.lock(); messages.append(message); lock.unlock()
        // Answered later, as a process would: never inside the send.
        Task {
            switch self.answer(message) {
            case .end: self.end("exit code 1")
            case .lines(let lines): for line in lines { self.say(line.jsonText) }
            }
        }
    }

    func onLine(_ listener: @escaping @Sendable (String) -> Void) {
        lock.lock(); listeners.append(listener); lock.unlock()
    }

    func say(_ line: String) {
        lock.lock(); let all = listeners; lock.unlock()
        for listener in all { listener(line) }
    }

    func end(_ why: String) { ended.end(why) }

    func kill() {
        lock.lock(); wasKilled = true; lock.unlock()
        end("killed")
    }
}

/// Claude's answer to a control request, succeeding with `response`.
fileprivate func claudeSuccess(_ message: JsonValue, _ response: JsonValue) -> JsonValue {
    ["type": "control_response", "response": ["subtype": "success", "request_id": message["request_id"] ?? .null, "response": response]]
}

fileprivate let claudeUsage: JsonValue = [
    "subscription_type": "max",
    "rate_limits_available": true,
    "rate_limits": [
        "five_hour": ["utilization": 91, "resets_at": "2026-09-28T14:59:59.559705+00:00", "limit_dollars": nil],
        "seven_day": ["utilization": 34, "resets_at": "2026-10-04T13:59:59.559729+00:00", "limit_dollars": nil],
        "seven_day_opus": nil,
        "some_internal_cap": ["utilization": 0.7, "resets_at": nil],
    ],
    "limits": [],
    "model_scoped": [],
]

fileprivate func claude(_ usage: @escaping @Sendable () -> JsonValue) -> @Sendable (JsonValue) -> UsageScriptedAnswer {
    { message in
        switch message["request"]?["subtype"]?.stringValue {
        case "initialize":
            // What a hook or the CLI says unasked is not an answer.
            return .lines([["type": "system", "subtype": "status", "session_id": "x"], claudeSuccess(message, ["commands": []])])
        case "get_usage":
            return .lines([claudeSuccess(message, usage())])
        default:
            return .end
        }
    }
}

fileprivate let codexLimits: JsonValue = [
    "rateLimits": [
        "limitId": "codex",
        "limitName": nil,
        "primary": ["usedPercent": 76, "windowDurationMins": 300, "resetsAt": 1_790_625_408],
        "secondary": ["usedPercent": 2, "windowDurationMins": 10_080, "resetsAt": 1_791_091_364],
        "credits": nil,
        "planType": "plus",
        "rateLimitReachedType": nil,
    ],
    "rateLimitsByLimitId": [:],
]

fileprivate func codex(_ account: String?, _ limits: @escaping @Sendable () -> JsonValue = { codexLimits }) -> @Sendable (JsonValue) -> UsageScriptedAnswer {
    { message in
        let id = message["id"] ?? .null
        switch message["method"]?.stringValue {
        case "initialize":
            // A notification is not an answer.
            return .lines([["id": id, "result": ["userAgent": "devhub/0.154.0 (Mac OS)"]], ["method": "remoteControl/status/changed", "params": [:]]])
        case "initialized":
            return .lines([])
        case "account/read":
            return .lines([["id": id, "result": ["account": account.map { ["type": .string($0)] } ?? nil, "requiresOpenaiAuth": true]]])
        case "account/rateLimits/read":
            return .lines([["id": id, "result": limits()]])
        default:
            return .end
        }
    }
}

fileprivate func profile(_ kind: AgentProfileKind, _ name: String? = nil) -> ConfiguredAgentProfile {
    let display = name ?? (kind == .claude ? "Claude" : kind == .codex ? "Codex" : "Cursor")
    return ConfiguredAgentProfile(
        id: "\(kind.rawValue)-\(display)", displayName: display, kind: kind, command: kind.rawValue,
        args: ["--model", "something", "--resume", "abc"], env: ["PROFILE_VAR": "1"]
    )
}

/// Readers over scripted CLIs; the test's clock records each interval asked
/// for, and every reader's next read waits for `next()`.
final class UsageHarness: @unchecked Sendable {
    let limits = UsageLimits()
    private let lock = NSLock()
    private var _published: [UsageLimitsWire] = []
    private var _processes: [UsageScriptedProcess] = []
    private var _intervals: [Int] = []
    private var _reports: [CodedFailure] = []
    private var _readings: [UsageReading] = []
    private var _notes: [UsageNote] = []
    private var ticks: [Int: CheckedContinuation<Void, Never>] = [:]
    private var nextTick = 0
    private var _aliveAtSpawn: [Int] = []
    var readers: UsageReaders!

    init(
        profiles: [ConfiguredAgentProfile],
        answers: [String: @Sendable (JsonValue) -> UsageScriptedAnswer],
        missing: [String] = [],
        readTimeoutMs: Int = UsageReaders.readTimeoutMs,
        prime: (UsageLimits) -> Void = { _ in }
    ) {
        // What is already in the readout before any reader has run.
        prime(limits)
        readers = UsageReaders.start(UsageReaderDeps(
            profiles: profiles,
            resolveProgram: { configured in missing.contains(configured) ? nil : "/opt/bin/\(configured)" },
            environment: { ["PATH": "/usr/bin", "HOME": "/home/testuser"] },
            home: { "/home/testuser" },
            clientVersion: "0.1.0",
            spawn: { [unowned self] command, _ in
                let name = String(command.file.split(separator: "/").last ?? "")
                let answer = answers[name] ?? { _ in .end }
                let process = UsageScriptedProcess(command: command, answer: answer)
                self.locked {
                    self._aliveAtSpawn.append(self._processes.filter { !$0.killed }.count)
                    self._processes.append(process)
                }
                return process
            },
            deliver: { [unowned self] cli, reading in
                self.locked { self._readings.append(reading) }
                UsageLimitsFeed.deliver(self.limits, cli, reading) { wire in self.locked { self._published.append(wire) } }
            },
            note: { [unowned self] cli, note in
                self.locked { self._notes.append(note) }
                UsageLimitsFeed.note(self.limits, cli, note) { wire in self.locked { self._published.append(wire) } }
            },
            report: { [unowned self] failure in self.locked { self._reports.append(failure) } },
            wait: { [unowned self] ms, stop in
                await withCheckedContinuation { continuation in
                    let id: Int = self.locked {
                        self._intervals.append(ms)
                        self.nextTick += 1
                        self.ticks[self.nextTick] = continuation
                        return self.nextTick
                    }
                    stop.onStop { [weak self] in self?.release(id) }
                }
            },
            readTimeoutMs: readTimeoutMs
        ))
    }

    func locked<T>(_ body: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return body() }

    /// Resume one wait, if it is still waiting.
    private func release(_ id: Int) {
        let found = locked { ticks.removeValue(forKey: id) }
        found?.resume()
    }

    func next() {
        let all: [CheckedContinuation<Void, Never>] = locked { let all = Array(ticks.values); ticks = [:]; return all }
        for tick in all { tick.resume() }
    }

    func stop() {
        readers.stop()
        next()
    }

    var published: [UsageLimitsWire] { locked { _published } }
    var processes: [UsageScriptedProcess] { locked { _processes } }
    var intervals: [Int] { locked { _intervals } }
    var reports: [CodedFailure] { locked { _reports } }
    var readings: [UsageReading] { locked { _readings } }
    var notes: [UsageNote] { locked { _notes } }
    var aliveAtSpawn: [Int] { locked { _aliveAtSpawn } }
}

final class UsageReadersTests: XCTestCase {
    private var harnesses: [UsageHarness] = []

    override func tearDown() async throws {
        for harness in harnesses { harness.stop() }
        harnesses = []
    }

    private func harness(
        _ profiles: [ConfiguredAgentProfile],
        _ answers: [String: @Sendable (JsonValue) -> UsageScriptedAnswer],
        missing: [String] = [],
        readTimeoutMs: Int = UsageReaders.readTimeoutMs,
        prime: (UsageLimits) -> Void = { _ in }
    ) -> UsageHarness {
        let made = UsageHarness(profiles: profiles, answers: answers, missing: missing, readTimeoutMs: readTimeoutMs, prime: prime)
        harnesses.append(made)
        return made
    }

    private func waitFor(_ what: String = "the condition", timeout: Double = 5, file: StaticString = #filePath, line: UInt = #line, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 2_000_000)
        }
        XCTFail("\(what) did not happen", file: file, line: line)
    }

    private func iso(_ text: String) -> Double {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: text)!.timeIntervalSince1970 * 1000
    }

    // MARK: decoding a usage reading

    func testReadsClaudesGetUsageAlready0To100TheResetAnISOTimeOnlyItsFiveHourAndSevenDayWindows() throws {
        let reading = try decodeUsage(claudeUsage.objectValue, version: "2.1.0")
        XCTAssertEqual(reading, .windows([
            RateLimit(window: "5-hour", durationMinutes: 300, usedPercent: 91, resetsAt: iso("2026-09-28T14:59:59.559Z")),
            RateLimit(window: "7-day", durationMinutes: 10_080, usedPercent: 34, resetsAt: iso("2026-10-04T13:59:59.559Z")),
        ]))
    }

    func testReadsAClaudeSignInWithoutPlanLimitsAsThatNotAsAFailure() throws {
        let reading = try decodeUsage(["subscription_type": nil, "rate_limits_available": false, "rate_limits": nil], version: nil)
        XCTAssertEqual(reading, .noPlanLimits)
    }

    func testLeavesOutAClaudeWindowTheAccountHasNotStarted() throws {
        let reading = try decodeUsage(["rate_limits_available": true, "rate_limits": ["five_hour": nil, "seven_day": ["utilization": 3, "resets_at": nil]]], version: nil)
        XCTAssertEqual(reading, .windows([RateLimit(window: "7-day", durationMinutes: 10_080, usedPercent: 3, resetsAt: nil)]))
    }

    func testRefusesAClaudeAnswerInAnyOtherShapeSayingWhere() {
        func bad(_ payload: JsonObject) -> String {
            do {
                _ = try decodeUsage(payload, version: "2.1.0")
                return "no failure"
            } catch {
                XCTAssertTrue(error is ProtocolMismatch)
                return "\(error)"
            }
        }
        XCTAssertTrue(bad(["rate_limits": [:]]).contains("rate_limits_available: expected a boolean"))
        XCTAssertTrue(bad(["rate_limits_available": true, "rate_limits": ["five_hour": ["utilization": "91%", "resets_at": nil]]])
            .contains("rate_limits.five_hour.utilization: expected a number (CLI 2.1.0)"))
        XCTAssertTrue(bad(["rate_limits_available": true, "rate_limits": ["five_hour": ["utilization": 1, "resets_at": "tomorrow"]]])
            .contains("five_hour.resets_at: expected an ISO 8601 time"))
        XCTAssertTrue(bad(["rate_limits_available": true]).contains("rate_limits: expected an object"))
    }

    func testReadsCodexsRateLimitsTheResetInSecondsBecomesMillisecondsWindowsNamedByLength() throws {
        XCTAssertEqual(try CodexUsageDecoding.rateLimits(codexLimits, at: "result"), [
            RateLimit(window: "5-hour", durationMinutes: 300, usedPercent: 76, resetsAt: 1_790_625_408_000),
            RateLimit(window: "7-day", durationMinutes: 10_080, usedPercent: 2, resetsAt: 1_791_091_364_000),
        ])
        // A window whose length Codex does not say is named by its slot.
        XCTAssertEqual(
            try CodexUsageDecoding.rateLimits(["rateLimits": ["primary": ["usedPercent": 5, "windowDurationMins": nil, "resetsAt": nil]]], at: "result"),
            [RateLimit(window: "primary", durationMinutes: nil, usedPercent: 5, resetsAt: nil)]
        )
        XCTAssertThrowsError(try CodexUsageDecoding.rateLimits(["rateLimits": ["primary": ["usedPercent": "a"]]], at: "result", version: "0.154.0")) { error in
            XCTAssertTrue("\(error)".contains("result.rateLimits.primary.usedPercent: expected a number"), "\(error)")
        }
    }

    func testDecodesCodexsEnvelopeAndAccount() throws {
        XCTAssertEqual(try CodexUsageDecoding.decodeLine(#"{"id":3,"result":{"a":1}}"#), .response(id: .number(3), result: ["a": 1]))
        XCTAssertEqual(try CodexUsageDecoding.decodeLine(#"{"method":"x/y","params":{}}"#), .notification(method: "x/y", params: [:]))
        XCTAssertEqual(try CodexUsageDecoding.decodeLine(#"{"id":"r","method":"ask","params":null}"#), .request(id: .string("r"), method: "ask", params: .null))
        XCTAssertEqual(try CodexUsageDecoding.decodeLine(#"{"id":null,"error":{"code":-32600,"message":"bad"}}"#), .error(id: nil, code: -32600, message: "bad", data: .null))
        XCTAssertEqual(try CodexUsageDecoding.decodeLine(#"{"type":"devhub_restart"}"#), .restart)
        XCTAssertThrowsError(try CodexUsageDecoding.decodeLine("{}"))
        XCTAssertThrowsError(try CodexUsageDecoding.decodeLine("not json"))
        XCTAssertEqual(try CodexUsageDecoding.accountResponse(["account": ["type": "chatgpt"], "requiresOpenaiAuth": true]).account, "chatgpt")
        XCTAssertNil(try CodexUsageDecoding.accountResponse(["account": nil, "requiresOpenaiAuth": false]).account)
    }

    // MARK: how often a reader asks

    private func at(_ used: Double...) -> UsageReading {
        .windows(used.enumerated().map { RateLimit(window: String($0.offset), durationMinutes: nil, usedPercent: $0.element, resetsAt: nil) })
    }

    func testFollowsCodexsTUI() {
        XCTAssertEqual(UsageReaders.pollInterval(.codex, at(10, 74.9)), 60_000)
        XCTAssertEqual(UsageReaders.pollInterval(.codex, at(75, 1)), 30_000)
        XCTAssertEqual(UsageReaders.pollInterval(.codex, at(1, 90)), 15_000)
        XCTAssertEqual(UsageReaders.pollInterval(.codex, at(99)), 5_000)
        XCTAssertEqual(UsageReaders.pollInterval(.codex, at()), 60_000)
        XCTAssertEqual(UsageReaders.pollInterval(.codex, .noPlanLimits), 60_000)
    }

    func testAsksClaudesExperimentalEndpointOnceAMinuteUntilAWindowReaches90() {
        XCTAssertEqual(UsageReaders.pollInterval(.claude, at(89.9)), 60_000)
        XCTAssertEqual(UsageReaders.pollInterval(.claude, at(75)), 60_000)
        XCTAssertEqual(UsageReaders.pollInterval(.claude, at(90)), 15_000)
        XCTAssertEqual(UsageReaders.pollInterval(.claude, at(50, 99.5)), 5_000)
        XCTAssertEqual(UsageReaders.pollInterval(.claude, .noPlanLimits), 60_000)
    }

    // MARK: the background usage readers

    func testSendClaudeControlRequestsOnlyAndStartItWithoutTheProfilesArguments() async {
        let h = harness([profile(.claude)], ["claude": claude { claudeUsage }])
        await waitFor { h.intervals.count == 1 }
        h.next()
        await waitFor { h.intervals.count == 2 }
        h.stop()
        XCTAssertEqual(h.processes.first?.command, UsageCommand(
            file: "/opt/bin/claude",
            args: ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--settings", #"{"disableAllHooks":true}"#],
            env: ["PATH": "/usr/bin", "HOME": "/home/testuser", "PROFILE_VAR": "1"]
        ))
        XCTAssertEqual(h.processes.count, 2)
        for one in h.processes {
            XCTAssertEqual(one.sent, [
                ["type": "control_request", "request_id": "devhub-usage-1", "request": ["subtype": "initialize"]],
                ["type": "control_request", "request_id": "devhub-usage-2", "request": ["subtype": "get_usage", "skip_behaviors": true]],
            ])
            XCTAssertTrue(one.killed)
        }
        // 91% of the five-hour window: 15 s.
        XCTAssertEqual(h.intervals, [15_000, 15_000])
        XCTAssertEqual(h.reports, [])
    }

    func testSendCodexItsHandshakeAccountReadsAndRateLimitReadsOnly() async {
        let h = harness([profile(.codex)], ["codex": codex("chatgpt")])
        await waitFor { h.intervals.count == 1 }
        h.next()
        await waitFor { h.intervals.count == 2 }
        h.stop()
        XCTAssertEqual(h.processes.first?.command.args, ["app-server"])
        XCTAssertEqual(h.processes.count, 2)
        for one in h.processes {
            XCTAssertEqual(one.sent, [
                ["id": 0, "method": "initialize", "params": [
                    "clientInfo": ["name": "devhub", "title": "DevHub", "version": "0.1.0"],
                    "capabilities": ["experimentalApi": false, "requestAttestation": false],
                ]],
                ["method": "initialized"],
                ["id": 1, "method": "account/read", "params": [:]],
                ["id": 2, "method": "account/rateLimits/read", "params": ["excludeResetCreditDetails": true]],
            ])
            XCTAssertTrue(one.killed)
        }
        // 76% of the five-hour window: 30 s.
        XCTAssertEqual(h.intervals, [30_000, 30_000])
        XCTAssertEqual(h.limits.wire().clis[1], UsageLimitsWire.Cli(cli: .codex, windows: [
            .init(window: "5-hour", durationMinutes: 300, usedPercent: 76, resetsAt: 1_790_625_408_000),
            .init(window: "7-day", durationMinutes: 10_080, usedPercent: 2, resetsAt: 1_791_091_364_000),
        ]))
    }

    func testReadEachKindOnceWithItsFirstProfile() async {
        let h = harness(
            [profile(.cursor), profile(.claude, "First"), profile(.claude, "Second"), profile(.codex)],
            ["claude": claude { claudeUsage }, "codex": codex("chatgpt")]
        )
        await waitFor { h.intervals.count == 2 }
        h.stop()
        XCTAssertEqual(h.processes.map(\.command.file).sorted(), ["/opt/bin/claude", "/opt/bin/codex"])
    }

    func testMergeAReadingWithAGUIAgentsByTheOneRule() async {
        let fiveHourReset = iso("2026-09-28T14:59:59.559Z")
        // A GUI Agent's journal replays: more used of the same window, and a
        // seven-day reading from before its last reset.
        let h = harness([profile(.claude)], ["claude": claude { claudeUsage }]) { limits in
            limits.observe(.claude, RateLimit(window: "5-hour", durationMinutes: 300, usedPercent: 95, resetsAt: fiveHourReset))
            limits.observe(.claude, RateLimit(window: "7-day", durationMinutes: 10_080, usedPercent: 80, resetsAt: 1_000))
        }
        await waitFor { h.intervals.count == 1 }
        h.stop()
        XCTAssertEqual(h.limits.wire().clis[0], UsageLimitsWire.Cli(cli: .claude, windows: [
            .init(window: "5-hour", durationMinutes: 300, usedPercent: 95, resetsAt: fiveHourReset),
            .init(window: "7-day", durationMinutes: 10_080, usedPercent: 34, resetsAt: iso("2026-10-04T13:59:59.559Z")),
        ]))
        XCTAssertEqual(h.published.last, h.limits.wire())
    }

    func testSayASignInWithoutPlanLimitsAsAStateQuietlyAndTakeItBackWhenWindowsAreRead() async {
        let available = TestCell(false)
        let h = harness([profile(.claude), profile(.codex)], [
            "claude": claude { available.value ? claudeUsage : ["rate_limits_available": false, "rate_limits": nil] },
            "codex": codex("apiKey"),
        ])
        await waitFor { h.intervals.count == 2 }
        XCTAssertEqual(h.limits.wire(), UsageLimitsWire(clis: [.init(cli: .claude, note: .noPlanLimits), .init(cli: .codex, note: .noPlanLimits)]))
        // An API-key Codex is not asked for limits it cannot have.
        let codexProcess = h.processes.first { $0.command.file.hasSuffix("codex") }
        XCTAssertFalse(codexProcess?.sent.map { $0["method"]?.stringValue }.contains("account/rateLimits/read") ?? true)
        XCTAssertEqual(h.reports, [])
        available.value = true
        h.next()
        await waitFor { h.limits.wire().clis[0].windows?.count == 2 }
        h.stop()
        XCTAssertNil(h.limits.wire().clis[0].note)
    }

    func testSayACLIWhoseCommandIsNotOnThisMacAndStartNothingForIt() async {
        let h = harness([profile(.claude), profile(.codex)], ["claude": claude { claudeUsage }], missing: ["codex"])
        await waitFor { h.notes == [.cliNotFound] }
        await waitFor { h.processes.count == 1 }
        h.stop()
        XCTAssertEqual(h.processes.count, 1)
        XCTAssertEqual(h.limits.wire().clis[1], UsageLimitsWire.Cli(cli: .codex, note: .cliNotFound))
        XCTAssertEqual(h.reports, [])
    }

    func testSayAProcessThatStopsOnceAndReadAgainWithANewProcessAtTheNextTick() async {
        let healthy = TestCell(false)
        let script = claude { claudeUsage }
        let h = harness([profile(.claude)], ["claude": { healthy.value ? script($0) : .end }])
        await waitFor { h.reports.count == 1 }
        let failure = h.reports.first
        XCTAssertEqual(failure?.code, "usage_unreadable")
        XCTAssertEqual(failure?.offersRetry, false)
        XCTAssertEqual(failure?.detail, "Claude, read with the profile “Claude”: exit code 1")
        await waitFor { h.intervals.count == 1 }
        XCTAssertEqual(h.processes.count, 1)
        XCTAssertTrue(h.processes.first?.killed ?? false)
        healthy.value = true
        h.next()
        await waitFor { h.readings.count == 1 }
        XCTAssertEqual(h.processes.count, 2)
        XCTAssertEqual(h.processes[1].sent.first?["request"]?["subtype"]?.stringValue, "initialize")
        XCTAssertEqual(h.reports.count, 1)
        h.stop()
    }

    func testRetryAFailureAtEveryTickAtTheCadenceOfTheLatestReadingSayingItOncePerStreak() async {
        let healthy = TestCell(true)
        let script = codex("chatgpt")
        let h = harness([profile(.codex)], ["codex": { healthy.value ? script($0) : .end }])
        await waitFor { h.readings.count == 1 }
        await waitFor { h.intervals.count == 1 }
        healthy.value = false
        for n in 2...12 {
            h.next()
            await waitFor { h.intervals.count == n }
        }
        // 76% of the five-hour window: 30 s, after the reading and every failure.
        XCTAssertEqual(h.intervals, Array(repeating: 30_000, count: 12))
        XCTAssertEqual(h.processes.count, 12)
        XCTAssertEqual(h.reports.count, 1)
        // It comes back: a reading ends the streak, so the next failure is news.
        healthy.value = true
        h.next()
        await waitFor { h.readings.count == 2 }
        await waitFor { h.intervals.count == 13 }
        healthy.value = false
        h.next()
        await waitFor { h.reports.count == 2 }
        h.stop()
    }

    func testKillAReadThatIsNotFinishedInTimeAndReadAgainAtTheNextTickNeverTwoAtOnce() async {
        let hang = TestCell(true)
        let script = claude { claudeUsage }
        let h = harness([profile(.claude)], ["claude": { message in
            hang.value && message["request"]?["subtype"]?.stringValue == "get_usage" ? .lines([]) : script(message)
        }], readTimeoutMs: 300)
        try? await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(h.processes.count, 1)
        XCTAssertEqual(h.processes.first?.killed, false)
        XCTAssertEqual(h.reports.count, 0)
        await waitFor { h.reports.count == 1 }
        XCTAssertTrue(h.reports.first?.detail?.contains("not answered within 0.3 s") ?? false)
        XCTAssertTrue(h.processes.first?.killed ?? false)
        // Nothing read yet: the usual 60 s, not a backoff.
        await waitFor { h.intervals == [60_000] }
        hang.value = false
        h.next()
        await waitFor { h.readings.count == 1 }
        XCTAssertEqual(h.processes.count, 2)
        XCTAssertEqual(h.reports.count, 1)
        XCTAssertEqual(h.aliveAtSpawn, [0, 0])
        h.stop()
        XCTAssertEqual(UsageReaders.timeoutSentence(UsageReaders.readTimeoutMs), "the usage read was not answered within 30 s")
    }

    func testSayAnAnswerInAnUnexpectedShapeOnceAndKillItsProcess() async {
        let h = harness([profile(.claude)], ["claude": claude { ["rate_limits_available": true, "rate_limits": ["five_hour": ["utilization": "lots"]]] }])
        await waitFor { h.reports.count == 1 }
        XCTAssertEqual(
            h.reports.first?.detail,
            "Claude, read with the profile “Claude”: control_response(get_usage).response.response.rate_limits.five_hour.utilization: expected a number"
        )
        XCTAssertTrue(h.processes.first?.killed ?? false)
        XCTAssertEqual(h.readings, [])
        await waitFor { h.intervals == [60_000] }
        h.stop()
    }

    func testTakeAPlanWhoseLimitsTheCLICouldNotFetchJustNowAsNoReadingNotAFailure() async {
        let fetched = TestCell(false)
        let h = harness([profile(.claude)], ["claude": claude { fetched.value ? claudeUsage : ["rate_limits_available": true, "rate_limits": nil] }])
        await waitFor { h.intervals == [60_000] }
        XCTAssertEqual(h.readings, [])
        XCTAssertEqual(h.reports, [])
        fetched.value = true
        h.next()
        await waitFor { h.readings.count == 1 }
        h.stop()
        XCTAssertEqual(h.reports, [])
        XCTAssertEqual(h.processes.count, 2)
    }

    func testSayARefusedRequestAndACodexThatIsNotSignedInAsFailures() async {
        let refusing = harness([profile(.claude)], ["claude": { message in
            message["request"]?["subtype"]?.stringValue == "initialize"
                ? .lines([claudeSuccess(message, [:])])
                : .lines([["type": "control_response", "response": ["subtype": "error", "request_id": message["request_id"] ?? .null, "error": "Unsupported control request subtype: get_usage"]]])
        }])
        await waitFor { refusing.reports.count == 1 }
        XCTAssertTrue(refusing.reports.first?.detail?.contains("claude refused get_usage: Unsupported control request subtype: get_usage") ?? false)
        let signedOut = harness([profile(.codex)], ["codex": codex(nil)])
        await waitFor { signedOut.reports.count == 1 }
        XCTAssertTrue(signedOut.reports.first?.detail?.contains("codex is not signed in") ?? false)
    }

    func testSayAProcessThatCouldNotStart() async {
        let h = harness([profile(.codex)], ["codex": { _ in .end }])
        await waitFor { h.reports.count == 1 }
        XCTAssertEqual(h.reports.first?.detail, "Codex, read with the profile “Codex”: exit code 1")
    }

    func testEndQuietlyWhenStoppedWhateverTheStopDoesToAReadInFlight() async {
        let h = harness([profile(.claude)], ["claude": { message in
            message["request"]?["subtype"]?.stringValue == "initialize" ? .lines([claudeSuccess(message, [:])]) : .lines([])
        }])
        await waitFor { h.processes.first?.sent.count == 2 }
        h.stop()
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertTrue(h.processes.first?.killed ?? false)
        XCTAssertEqual(h.reports, [])
    }

    func testAChildLineProcessSpeaksLinesAndSaysHowItEnded() async throws {
        let process = ChildLineProcess(command: UsageCommand(file: "/bin/sh", args: ["-c", "read line; echo \"got $line\"; echo oops >&2; exit 3"], env: [:]), cwd: "/")
        let lines = TestCell<[String]>([])
        process.onLine { lines.value.append($0) }
        process.send(#"{"hello":1}"#)
        await waitFor { process.ended.isEnded }
        XCTAssertEqual(lines.value, [#"got {"hello":1}"#])
        XCTAssertEqual(process.ended.reason, "/bin/sh stopped (exit code 3): oops")
        let missing = ChildLineProcess(command: UsageCommand(file: "/nonexistent/claude", args: [], env: [:]), cwd: "/")
        XCTAssertTrue(missing.ended.reason?.hasPrefix("/nonexistent/claude could not be started") ?? false)
    }

    // MARK: the usage-limits readout (usageLimits.test.ts)

    func testSaysNothingIsKnownForACLINoAgentHasReportedFor() {
        XCTAssertEqual(UsageLimits().wire(), UsageLimitsWire(clis: [.init(cli: .claude), .init(cli: .codex)]))
    }

    func testKeepsTheNewerReadingWhicheverAgentsArrivesLast() {
        let limits = UsageLimits()
        func w(_ used: Double, _ resets: Double) -> RateLimit { RateLimit(window: "5-hour", durationMinutes: 300, usedPercent: used, resetsAt: resets) }
        XCTAssertTrue(limits.observe(.claude, w(40, 2_000)))
        XCTAssertFalse(limits.observe(.claude, w(90, 1_000)))
        XCTAssertFalse(limits.observe(.claude, w(30, 2_000)))
        XCTAssertTrue(limits.observe(.claude, w(55, 2_000)))
        XCTAssertTrue(limits.observe(.claude, w(5, 3_000)))
        XCTAssertTrue(limits.observe(.claude, RateLimit(window: "7-day", durationMinutes: 10_080, usedPercent: 1, resetsAt: 1)))
        XCTAssertEqual(limits.wire().clis[0], .init(cli: .claude, windows: [
            .init(window: "5-hour", durationMinutes: 300, usedPercent: 5, resetsAt: 3_000),
            .init(window: "7-day", durationMinutes: 10_080, usedPercent: 1, resetsAt: 1),
        ]))
    }

    func testTakesEachCLIsLimitFromWhatItsGUIAgentsReportAndPublishesOnlyAChange() throws {
        let limits = UsageLimits()
        var published: [UsageLimitsWire] = []
        let reported = [
            RateLimit(window: "5-hour", durationMinutes: 300, usedPercent: 98, resetsAt: 1_790_280_600_000),
            RateLimit(window: "7-day", durationMinutes: 10_080, usedPercent: 80, resetsAt: 1_790_517_600_000),
        ]
        try UsageLimitsFeed.agentReported(limits, kind: .claude, rateLimits: reported) { published.append($0) }
        try UsageLimitsFeed.agentReported(limits, kind: .claude, rateLimits: reported) { published.append($0) }
        // An Agent whose row has gone: not taken.
        try UsageLimitsFeed.agentReported(limits, kind: nil, rateLimits: [RateLimit(window: "5-hour", durationMinutes: 300, usedPercent: 1, resetsAt: 9e15)]) { published.append($0) }
        XCTAssertEqual(published.count, 1)
        XCTAssertEqual(published.last, limits.wire())
        XCTAssertEqual(limits.wire().clis[0].windows?.map(\.usedPercent), [98, 80])
    }

    func testRefusesARateLimitFromAnAgentThatCannotHaveAGUI() {
        XCTAssertThrowsError(try UsageLimitsFeed.agentReported(UsageLimits(), kind: .cursor, rateLimits: [RateLimit(window: "5-hour", durationMinutes: 300, usedPercent: 1, resetsAt: 1)]) { _ in }) { error in
            XCTAssertTrue("\(error)".contains("only Claude and Codex have a GUI"))
        }
    }
}

/// usageLimits.test.ts's capture case, Claude half: real captured lines go
/// through WP5's Claude adapter, and the events it emits feed the readout. (The
/// Codex half waits for WP6's adapter.)
final class UsageLimitsCaptureTests: XCTestCase {
    func testTakesClaudesLimitFromWhatItsGUIAgentReports() throws {
        let adapter = ClaudeAdapter(bootId: "replay")
        let limits = UsageLimits()
        var published: [UsageLimitsWire] = []
        for line in fixture("claude-session.capture.ndjson") {
            let step = line.side == .sent ? try adapter.sent(line.line) : try adapter.received(line.line)
            for event in step.events {
                guard case .usage(let usage) = event else { continue }
                try UsageLimitsFeed.agentReported(limits, kind: .claude, rateLimits: usage.rateLimits) { published.append($0) }
            }
        }
        // The capture's last `rate_limit_event`: 98% of the five-hour window
        // and 80% of the seven-day one, resets in epoch seconds on the wire.
        XCTAssertEqual(limits.wire().clis[0].windows, [
            .init(window: "5-hour", durationMinutes: 300, usedPercent: 98, resetsAt: 1_790_280_600_000),
            .init(window: "7-day", durationMinutes: 10_080, usedPercent: 80, resetsAt: 1_790_517_600_000),
        ])
        XCTAssertEqual(published.last, limits.wire())
    }
}

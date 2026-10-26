// Port of apps/desktop/src/main/agent/conversation/claude/adapter.test.ts (4/6)

import XCTest
@testable import DevHubCore

private let EFFORTS = ["low", "medium", "high", "xhigh", "max"]

private func listed(_ value: String, _ resolvedModel: String, _ efforts: [String]? = nil) -> JsonValue {
    var model: JsonObject = [
        "value": .string(value), "displayName": .string("\(value) (label)"), "description": "",
        "resolvedModel": .string(resolvedModel),
    ]
    if let efforts { model["supportedEffortLevels"] = .array(efforts.map(JsonValue.string)) }
    return .object(model)
}

/// A CLI whose `model` setting is `opus[1m]` lists the 1M variant.
private let WITH_1M = [
    listed("default", "claude-opus-5-5[1m]", EFFORTS), listed("opus[1m]", "claude-opus-5-5[1m]", EFFORTS),
    listed("sonnet", "claude-sonnet-5", EFFORTS), listed("haiku", "claude-haiku-4-5-20251001"),
]
/// One whose setting is plain `opus` lists no 1M variant.
private let WITHOUT_1M = [
    listed("default", "claude-opus-5-5", EFFORTS), listed("opus", "claude-opus-5-5", EFFORTS),
    listed("sonnet", "claude-sonnet-5", EFFORTS), listed("haiku", "claude-haiku-4-5-20251001"),
]

/// Answer the `initialize` DevHub wrote with this list.
private func answer(_ adapter: ClaudeAdapter, _ written: [String], _ models: [JsonValue]) throws {
    for line in written { _ = try adapter.sent(line) }
    let request = try XCTUnwrap(parsed(written).first { $0["request"]?["subtype"] == "initialize" })
    _ = try adapter.received(
        controlResponse(try XCTUnwrap(request["request_id"]?.stringValue), ["commands": [], "models": .array(models)]))
}

private func started(_ models: [JsonValue], _ model: String) throws -> ClaudeAdapter {
    let adapter = ClaudeAdapter(bootId: "boot")
    try answer(adapter, try adapter.opening(), models)
    _ = try adapter.received(initLine(["model": .string(model)]))
    return adapter
}

private let EFFORT_SETTING = Setting(current: nil, choices: EFFORTS.map { SettingChoice(id: $0, label: $0) })

final class ClaudeModelSettingsTests: XCTestCase {
    func testIsTheListedChoiceThatResolvesToItOnAFreshStart() throws {
        let session = try started(WITH_1M, "claude-opus-5-5[1m]").transcript.session
        XCTAssertEqual(session.model.current, "opus[1m]")
        XCTAssertEqual(session.model.choices.map(\.id), ["default", "opus[1m]", "sonnet", "haiku"])
        XCTAssertEqual(session.effort, EFFORT_SETTING)
    }

    func testIsAChoiceOfItsOwnWhenAResumedSessionKeepsA1mModelTheListDoesNotOffer() throws {
        // Started on a resumed session (Continue in GUI, `--resume`): the
        // session keeps its transcript's model, whatever the setting is.
        let session = try started(WITHOUT_1M, "claude-opus-5-5[1m]").transcript.session
        XCTAssertEqual(session.model.current, "claude-opus-5-5[1m]")
        XCTAssertEqual(
            session.model.choices[0],
            SettingChoice(id: "claude-opus-5-5[1m]", label: "claude-opus-5-5[1m]", resolved: "claude-opus-5-5[1m]"))
        XCTAssertEqual(session.model.choices.dropFirst().map(\.id), ["default", "opus", "sonnet", "haiku"])
        XCTAssertEqual(session.effort, EFFORT_SETTING)
    }

    func testReadsTheSameAfterResumeSwitchesTheCLIToASessionOnAModelTheListDoesNotOffer() throws {
        let adapter = try started(WITHOUT_1M, "claude-opus-5-5")
        XCTAssertEqual(adapter.transcript.session.model.current, "opus")
        let step = try adapter.received(json(["type": "devhub_resume", "session": "other"]))
        try answer(adapter, step.replies, WITHOUT_1M)
        _ = try adapter.received(initLine(["model": "claude-opus-5-5[1m]", "session_id": "other"]))
        let session = adapter.transcript.session
        XCTAssertEqual(session.model.current, "claude-opus-5-5[1m]")
        XCTAssertEqual(session.effort.choices.map(\.id), EFFORTS)
        XCTAssertNil(session.effort.unchangeable)
    }

    func testTakesTheSessionsOwnModelBackWithSetModel() throws {
        let adapter = try started(WITHOUT_1M, "claude-opus-5-5[1m]")
        func agreed(_ line: String) throws {
            _ = try adapter.received(controlResponse(try XCTUnwrap(parsed([line])[0]["request_id"]?.stringValue)))
        }
        try agreed(try configure(adapter, .model, "opus")[0])
        XCTAssertEqual(adapter.transcript.session.model.current, "opus")
        XCTAssertEqual(adapter.transcript.session.model.choices.first?.id, "default")
        let back = try configure(adapter, .model, "claude-opus-5-5[1m]")[0]
        XCTAssertEqual(parsed([back])[0]["request"], ["subtype": "set_model", "model": "claude-opus-5-5[1m]"])
        try agreed(back)
        let session = adapter.transcript.session
        XCTAssertEqual(session.model.current, "claude-opus-5-5[1m]")
        XCTAssertEqual(session.effort.choices.map(\.id), EFFORTS)
    }

    func testSaysWhyTheEffortCantBeChangedForAModelTheListNamesInNoForm() throws {
        let session = try started(WITHOUT_1M, "claude-opus-4-1").transcript.session
        XCTAssertEqual(session.model.current, "claude-opus-4-1")
        XCTAssertEqual(
            session.model.choices[0], SettingChoice(id: "claude-opus-4-1", label: "claude-opus-4-1", resolved: "claude-opus-4-1"))
        XCTAssertEqual(session.effort.choices, [])
        XCTAssertTrue(session.effort.unchangeable?.contains("claude-opus-4-1") ?? false)
    }

    func testReadsEveryChoiceByTheFullModelNameItResolvesTo() throws {
        let session = try started(WITH_1M, "claude-opus-5-5[1m]").transcript.session
        XCTAssertEqual(
            session.model.choices,
            [
                SettingChoice(
                    id: "default", label: "claude-opus-5-5[1m] (default)", detail: "default (label)",
                    resolved: "claude-opus-5-5[1m]"),
                SettingChoice(
                    id: "opus[1m]", label: "claude-opus-5-5[1m] (opus[1m])", detail: "opus[1m] (label)",
                    resolved: "claude-opus-5-5[1m]"),
                SettingChoice(
                    id: "sonnet", label: "claude-sonnet-5 (sonnet)", detail: "sonnet (label)", resolved: "claude-sonnet-5"),
                SettingChoice(
                    id: "haiku", label: "claude-haiku-4-5-20251001 (haiku)", detail: "haiku (label)",
                    resolved: "claude-haiku-4-5-20251001"),
            ])
        XCTAssertEqual(
            session.model.choices.first { $0.id == session.model.current }?.label, "claude-opus-5-5[1m] (opus[1m])")
    }

    func testIsTheEffortSystemInitSaysTheSessionRunsAt() throws {
        let adapter = try started(WITH_1M, "claude-opus-5-5[1m]")
        XCTAssertNil(adapter.transcript.session.effort.current)
        _ = try adapter.received(initLine(["model": "claude-opus-5-5[1m]", "effort": "xhigh"]))
        XCTAssertEqual(adapter.transcript.session.effort.current, "xhigh")
        // A later init that does not say keeps what is known.
        _ = try adapter.received(initLine(["model": "claude-opus-5-5[1m]"]))
        XCTAssertEqual(adapter.transcript.session.effort.current, "xhigh")
    }

    func testIsForgottenByACLIStartedAgainWhichKeepsTheModel() throws {
        let adapter = try started(WITH_1M, "claude-opus-5-5[1m]")
        _ = try adapter.received(initLine(["model": "claude-opus-5-5[1m]", "effort": "xhigh"]))
        XCTAssertEqual(adapter.transcript.session.effort.current, "xhigh")
        _ = try adapter.received(RESTART_MARK)
        XCTAssertEqual(adapter.transcript.session.model.current, "opus[1m]")
        XCTAssertNil(adapter.transcript.session.effort.current)
    }

    func testOffersNoEffortForAListedModelThatTakesNone() throws {
        let session = try started(WITH_1M, "claude-haiku-4-5-20251001").transcript.session
        XCTAssertEqual(session.model.current, "haiku")
        XCTAssertEqual(session.effort, Setting(current: nil, choices: []))
    }
}

final class ClaudeSendingTests: XCTestCase {
    func testIsSendingFromItsWriteUntilTheCLIsEchoMakesItAnEntry() throws {
        let adapter = ClaudeAdapter(bootId: "boot")
        _ = try adapter.received(initLine())
        try carryOut(adapter, send("go"))
        XCTAssertEqual(adapter.transcript.sending, [SendingMessage(id: "sent:1", text: "go", images: [], origin: .person)])
        XCTAssertEqual(adapter.transcript.entries, [])
        let step = try adapter.received(echo("go", "u-go"))
        XCTAssertEqual(adapter.transcript.sending, [])
        XCTAssertEqual(try entry(adapter, "user:u-go").userEntry?.text, "go")
        // The entry comes before the sending list lets go of it.
        XCTAssertEqual(Array(step.events.map(\.type).prefix(2)), ["entry", "sending"])
    }

    func testIsSendingAgainOnAReplayThatHasItsWriteAndNoEchoYet() throws {
        let live = ClaudeAdapter(bootId: "boot")
        let greeting = initLine()
        _ = try live.received(greeting)
        let written = try carryOut(live, send("go"))
        let replayed = ClaudeAdapter(bootId: "replay")
        _ = try replayed.received(greeting)
        for line in written { _ = try replayed.sent(line) }
        XCTAssertEqual(replayed.transcript.sending, live.transcript.sending)
        XCTAssertEqual(replayed.transcript.sending.count, 1)
    }

    func testIsDroppedWithEverythingElseWhenTheCLIIsStartedAgain() throws {
        let adapter = ClaudeAdapter(bootId: "boot")
        _ = try adapter.received(initLine())
        try carryOut(adapter, send("go"))
        _ = try adapter.received(json(["type": "devhub_resume", "session": "other"]))
        XCTAssertEqual(adapter.transcript.sending, [])
    }
}

final class ClaudeUsageLimitTests: XCTestCase {
    func testKeepsEachWindowsLengthDecidedFromItsKey() throws {
        let adapter = try inTurn()
        _ = try adapter.received(
            json([
                "type": "rate_limit_event",
                "rate_limit_info": [
                    "status": "allowed",
                    "unifiedWindows": [
                        "five_hour": ["utilization": 0.1, "resetsAt": 1_800_000_000],
                        "seven_day": ["utilization": 0.2, "resetsAt": 1_800_000_100],
                        "seven_day_opus": ["utilization": 0.3, "resetsAt": 1_800_000_200],
                    ],
                ],
                "session_id": .string(SESSION),
            ]))
        let windows = adapter.transcript.usage?.rateLimits ?? []
        XCTAssertEqual(windows.map(\.window), ["5-hour", "7-day", "seven day opus"])
        XCTAssertEqual(windows.map(\.durationMinutes), [300, 10_080, nil])
    }

    func testIsSaidAndTheConversationStillTakesThePersonsNextMessage() throws {
        let adapter = try inTurn()
        // The limit's event names no window when the CLI cannot tell which
        // one limits (`rateLimitType` is optional in its schema).
        _ = try adapter.received(
            json([
                "type": "rate_limit_event",
                "rate_limit_info": ["status": "rejected", "resetsAt": 1_800_000_000, "isUsingOverage": false],
                "session_id": .string(SESSION),
            ]))
        _ = try adapter.received(
            assistantLine("m", [["type": "text", "text": "You've hit your limit · resets 3am"]], nil, ["error": "rate_limit"]))
        _ = try adapter.received(result(["is_error": true, "result": "You've hit your limit"]))
        XCTAssertEqual(adapter.transcript.state, .ready(turn: .none))
        XCTAssertTrue(adapter.transcript.entries.contains { $0.noticeEntry?.text.contains("rate_limit") ?? false })
        XCTAssertEqual(try carryOut(adapter, send("again")).count, 1)
    }
}

final class ClaudeLimitStoppedTurnTests: XCTestCase {
    let RESETS: Double = 1_800_000_000

    func rejected(_ fields: JsonObject = [:]) -> String {
        json([
            "type": "rate_limit_event",
            "rate_limit_info": .object(
                merged(["status": "rejected", "resetsAt": .number(RESETS), "rateLimitType": "five_hour"], fields)),
            "session_id": .string(SESSION),
        ])
    }

    let limitAnswer = assistantLine(
        "m", [["type": "text", "text": "You've hit your limit · resets 3am"]], nil, ["error": "rate_limit"])

    func lastEnd(_ adapter: ClaudeAdapter) -> TurnEndEntry? {
        adapter.transcript.entries.compactMap(\.turnEndEntry).last
    }

    func testEndsWithTheLimitAndTheResetOfTheWindowThatStoppedIt() throws {
        let adapter = try inTurn()
        _ = try adapter.received(rejected())
        _ = try adapter.received(limitAnswer)
        _ = try adapter.received(result(["is_error": true, "result": "You've hit your limit"]))
        XCTAssertEqual(lastEnd(adapter)?.outcome, .failed)
        XCTAssertEqual(lastEnd(adapter)?.limit, LimitStop(resetsAt: RESETS * 1000))
    }

    func testIsALimitOnTheModelsLimitAnswerAloneItsResetFromAUsedUpWindow() throws {
        let adapter = try inTurn()
        _ = try adapter.received(
            json([
                "type": "rate_limit_event",
                "rate_limit_info": [
                    "status": "allowed_warning",
                    "unifiedWindows": [
                        "five_hour": ["utilization": 1, "resetsAt": .number(RESETS)],
                        "seven_day": ["utilization": 0.4, "resetsAt": .number(RESETS + 99)],
                    ],
                ],
                "session_id": .string(SESSION),
            ]))
        _ = try adapter.received(limitAnswer)
        _ = try adapter.received(result(["is_error": true, "result": "You've hit your limit"]))
        XCTAssertEqual(lastEnd(adapter)?.limit, LimitStop(resetsAt: RESETS * 1000))
    }

    func testLearnsItsResetFromARefusalTheCLIReportsAfterTheTurnEnded() throws {
        let adapter = try inTurn()
        _ = try adapter.received(limitAnswer)
        _ = try adapter.received(result(["is_error": true, "result": "You've hit your limit"]))
        XCTAssertEqual(lastEnd(adapter)?.limit, LimitStop(resetsAt: nil))
        _ = try adapter.received(rejected())
        XCTAssertEqual(lastEnd(adapter)?.limit, LimitStop(resetsAt: RESETS * 1000))
    }

    func testIsNotATurnThatFailedOtherwiseNorOneThePersonStopped() throws {
        let failed = try inTurn()
        _ = try failed.received(result(["is_error": true, "result": "Something broke"]))
        XCTAssertNil(lastEnd(failed)?.limit)
        let stopped = try inTurn()
        _ = try stopped.received(rejected())
        try carryOut(stopped, .interrupt)
        _ = try stopped.received(result(["is_error": true, "result": "interrupted"]))
        XCTAssertEqual(lastEnd(stopped)?.outcome, .interrupted)
        XCTAssertNil(lastEnd(stopped)?.limit)
    }

    func testIsNotCarriedIntoTheNextTurn() throws {
        let adapter = try inTurn()
        _ = try adapter.received(rejected())
        _ = try adapter.received(result())
        try carryOut(adapter, send("more"))
        _ = try adapter.received(echo("more", "u-more"))
        _ = try adapter.received(result(["is_error": true, "result": "Something broke"]))
        XCTAssertNil(lastEnd(adapter)?.limit)
    }

    func testIsGoneOnWithByAMessageSentForThePersonLiveAndReplayed() throws {
        let adapter = try inTurn()
        _ = try adapter.received(rejected())
        _ = try adapter.received(limitAnswer)
        _ = try adapter.received(result(["is_error": true, "result": "You've hit your limit"]))
        let written = try carryOut(adapter, send("続けて", .afterLimit))
        XCTAssertEqual(adapter.transcript.sending.map(\.text), ["続けて"])
        XCTAssertEqual(adapter.transcript.sending.map(\.origin), [.afterLimit])
        let replayed = ClaudeAdapter(bootId: "replay")
        _ = try replayed.received(initLine())
        for line in written { _ = try replayed.sent(line) }
        XCTAssertEqual(replayed.transcript.sending.map(\.text), ["続けて"])
        XCTAssertEqual(replayed.transcript.sending.map(\.origin), [.afterLimit])
        _ = try adapter.received(echo("続けて", "u-resume"))
        let last = try XCTUnwrap(adapter.transcript.entries.last?.userEntry)
        XCTAssertEqual(last.text, "続けて")
        XCTAssertEqual(last.origin, .afterLimit)
    }
}

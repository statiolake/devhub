// Port of apps/desktop/src/main/agent/conversation/codex/adapter.test.ts (3/4):
// requests that are not approvals, what DevHub does not know, a protocol
// DevHub stopped understanding, replay.

import XCTest
@testable import DevHubCore

final class CodexRequestTests: XCTestCase {
    func testAsksRequestUserInputsQuestionsAndAnswersThemById() throws {
        let harness = try codexReady()
        try harness.receive(
            #"{"id":7,"method":"item/tool/requestUserInput","params":{"threadId":"\#(CODEX_MAIN)","turnId":"turn-1","itemId":"ask","isBlocking":true,"autoResolutionMs":null,"questions":[{"id":"lang","header":"Language","question":"Which language?","isOther":true,"isSecret":false,"options":[{"label":"TypeScript","description":"the usual"}]}]}}"#
        )
        let request = harness.transcript.requests[0]
        XCTAssertEqual(
            request,
            PendingRequest(
                id: RequestId("codex/0/7"), entry: nil,
                subject: .question(questions: [
                    Question(
                        id: "lang", header: "Language", text: "Which language?",
                        options: [QuestionOption(label: "TypeScript", description: "the usual")], multiSelect: false,
                        allowsOther: true)
                ]), choices: []))
        assertThrowsMatching("has no choice") {
            try harness.command(.answer(request: request.id, answer: .choice(choiceId: "accept", text: nil)))
        }
        try harness.command(.answer(request: request.id, answer: .answers(values: [("lang", .one("Rust"))], notes: nil)))
        XCTAssertEqual(harness.written.last, #"{"id":7,"result":{"answers":{"lang":{"answers":["Rust"]}}}}"#)
    }

    /// requestUserInput with a question of each kind: options with Other, and a secret.
    let asking =
        #"{"id":8,"method":"item/tool/requestUserInput","params":{"threadId":"00000000-0000-7000-8000-00000000000a","turnId":"turn-1","itemId":"ask","isBlocking":true,"autoResolutionMs":null,"questions":[{"id":"lang","header":"Language","question":"Which language?","isOther":true,"isSecret":false,"options":[{"label":"TypeScript","description":""},{"label":"Rust","description":""}]},{"id":"token","header":"Token","question":"Your token?","isOther":true,"isSecret":true,"options":null}]}}"#

    func testDrawsThePersonsAnswerAsTheirMessageOnceDevHubHasWrittenIt() throws {
        let harness = try codexReady()
        try harness.receive(asking)
        XCTAssertEqual(harness.transcript.entries, [])
        try harness.command(
            .answer(
                request: harness.transcript.requests[0].id,
                answer: .answers(values: [("lang", .one("Zig")), ("token", .one("not-a-real-token"))], notes: nil)))
        XCTAssertEqual(codexOutline(harness.transcript), [#"answer: Language="Zig", Token=(secret)"#])
    }

    func testDrawsTheSameAnswerFromAReplayOfWhatDevHubWrote() throws {
        let live = try codexReady()
        try live.receive(asking)
        try live.command(
            .answer(
                request: live.transcript.requests[0].id,
                answer: .answers(values: [("lang", .one("Rust")), ("token", .one("x"))], notes: nil)))
        let replayed = try codexReady()
        try replayed.receive(asking)
        // A replay feeds `in.log` back to `sent`, as it was written.
        for event in try replayed.adapter.sent(live.written.last!).events {
            replayed.transcript = try applyEvent(replayed.transcript, event)
        }
        XCTAssertEqual(replayed.transcript.entries, live.transcript.entries)
        XCTAssertEqual(codexOutline(replayed.transcript), ["answer: Language=Rust, Token=(secret)"])
    }

    func testGrantsThePermissionsAskedForForATurnOrTheSessionOrGrantsNone() throws {
        let harness = try codexReady()
        try harness.receive(
            #"{"id":"perm-1","method":"item/permissions/requestApproval","params":{"threadId":"\#(CODEX_MAIN)","turnId":"turn-1","itemId":"p","environmentId":null,"startedAtMs":0,"cwd":"\#(CODEX_CWD)","reason":"needs the network","permissions":{"network":{"enabled":true},"fileSystem":null}}}"#
        )
        let request = harness.transcript.requests[0]
        XCTAssertEqual(
            request.subject,
            .tool(
                tool: "permissions", title: "Grant more permissions",
                input: j(#"{"cwd":"\#(CODEX_CWD)","network":{"enabled":true}}"#), reason: "needs the network"))
        XCTAssertEqual(request.choices.map(\.id), ["turn", "session", "decline"])
        try harness.command(.answer(request: request.id, answer: .choice(choiceId: "session", text: nil)))
        XCTAssertEqual(
            harness.written.last, #"{"id":"perm-1","result":{"permissions":{"network":{"enabled":true}},"scope":"session"}}"#)
    }

    func elicit(_ harness: CodexHarness, _ params: String, meta: String = "null") throws -> PendingRequest {
        try harness.receive(
            #"{"id":8,"method":"mcpServer/elicitation/request","params":{"threadId":"\#(CODEX_MAIN)","turnId":null,"serverName":"tickets","_meta":\#(meta),\#(params)}}"#
        )
        return harness.transcript.requests[0]
    }

    func testOffersAFormElicitationOfNoFieldsAsAConfirmationAcceptedWithEmptyContent() throws {
        let harness = try codexReady()
        let request = try elicit(
            harness,
            #""mode":"form","message":"Allow the tickets server to file one?","requestedSchema":{"type":"object","properties":{}}"#)
        XCTAssertEqual(
            request.subject,
            .elicitation(server: "tickets", message: "Allow the tickets server to file one?", url: nil, fields: []))
        XCTAssertEqual(request.choices.map(\.id), ["decline", "cancel"])
        try harness.command(.answer(request: request.id, answer: .answers(values: [], notes: nil)))
        XCTAssertEqual(harness.written.last, #"{"id":8,"result":{"action":"accept","content":{},"_meta":null}}"#)
    }

    func testAnswersAnElicitationsDeclineOrCancelWithNoContent() throws {
        for action in ["decline", "cancel"] {
            let harness = try codexReady()
            let request = try elicit(
                harness, #""mode":"form","message":"Go on?","requestedSchema":{"type":"object","properties":{}}"#)
            try harness.command(.answer(request: request.id, answer: .choice(choiceId: action, text: nil)))
            XCTAssertEqual(harness.written.last, #"{"id":8,"result":{"action":"\#(action)","content":null,"_meta":null}}"#)
        }
    }

    func testReadsAFormsFieldsFromItsSchemaAndAcceptsItWithTheirValuesTyped() throws {
        let harness = try codexReady()
        let request = try elicit(
            harness,
            #""mode":"form","message":"File a ticket","requestedSchema":{"type":"object","properties":{"title":{"type":"string","title":"Title","maxLength":80},"email":{"type":"string","format":"email"},"count":{"type":"integer","minimum":1,"default":2},"urgent":{"type":"boolean","description":"Page someone"},"team":{"type":"string","enum":["web","api"]},"area":{"type":"string","oneOf":[{"const":"ui","title":"User interface"},{"const":"db","title":"Database"}]},"labels":{"type":"array","items":{"type":"string","enum":["bug","chore"]},"maxItems":2}},"required":["title","team"]}"#
        )
        guard case .elicitation(_, _, _, let fields) = request.subject else { return XCTFail("not an elicitation") }
        XCTAssertEqual(fields.map(\.key), ["title", "email", "count", "urgent", "team", "area", "labels"])
        XCTAssertEqual(fields[0].label, "Title")
        XCTAssertTrue(fields[0].required)
        XCTAssertEqual(fields[0].input, .text(format: nil, minLength: nil, maxLength: 80, default: nil))
        XCTAssertEqual(fields[1].label, "email")
        XCTAssertFalse(fields[1].required)
        XCTAssertEqual(fields[1].input, .text(format: .email, minLength: nil, maxLength: nil, default: nil))
        XCTAssertEqual(fields[2].input, .number(integer: true, minimum: 1, maximum: nil, default: 2))
        XCTAssertEqual(fields[3].description, "Page someone")
        XCTAssertEqual(fields[3].input, .boolean(default: nil))
        XCTAssertTrue(fields[4].required)
        XCTAssertEqual(
            fields[4].input,
            .choice(
                multiple: false, options: [FormOption(value: "web", label: "web"), FormOption(value: "api", label: "api")],
                minItems: nil, maxItems: nil, default: []))
        XCTAssertEqual(
            fields[5].input,
            .choice(
                multiple: false,
                options: [FormOption(value: "ui", label: "User interface"), FormOption(value: "db", label: "Database")],
                minItems: nil, maxItems: nil, default: []))
        guard case .choice(let multiple, _, _, let maxItems, _) = fields[6].input else { return XCTFail("not a choice") }
        XCTAssertTrue(multiple)
        XCTAssertEqual(maxItems, 2)
        try harness.command(
            .answer(
                request: request.id,
                answer: .answers(
                    values: [
                        ("title", .one("Login fails")), ("email", .one("")), ("count", .one("3")), ("urgent", .one("true")),
                        ("team", .one("api")), ("area", .one("")), ("labels", .many(["bug"])),
                    ], notes: nil)))
        XCTAssertEqual(
            harness.lastWrite(),
            j(
                #"{"id":8,"result":{"action":"accept","content":{"title":"Login fails","count":3,"urgent":true,"team":"api","labels":["bug"]},"_meta":null}}"#
            ))
    }

    func testAcceptsAURLElicitationWhichCarriesNoContentAndShowsItsPage() throws {
        let harness = try codexReady()
        let request = try elicit(
            harness,
            #""mode":"url","message":"Sign in to the tracker","url":"https://tracker.example.com/auth","elicitationId":"e-1""#)
        XCTAssertEqual(
            request.subject,
            .elicitation(
                server: "tickets", message: "Sign in to the tracker", url: "https://tracker.example.com/auth", fields: []))
        try harness.command(.answer(request: request.id, answer: .answers(values: [], notes: nil)))
        XCTAssertEqual(harness.written.last, #"{"id":8,"result":{"action":"accept","content":null,"_meta":null}}"#)
    }

    func testOffersAConfirmationsRememberingAfterAcceptAndAcceptsItWithMetaPersist() throws {
        for (persist, choiceId) in [("session", "remember:session"), ("always", "remember:always")] {
            let harness = try codexReady()
            let request = try elicit(
                harness,
                #""mode":"form","message":"Allow the tickets server to run file_ticket?","requestedSchema":{"type":"object","properties":{}}"#,
                meta: #"{"codex_approval_kind":"mcp_tool_call","persist":["session","always"]}"#)
            XCTAssertEqual(
                request.choices,
                [
                    RequestChoice(id: "remember:session", label: "Accept for this session", tone: .allow, takesText: false),
                    RequestChoice(id: "remember:always", label: "Always accept", tone: .allow, takesText: false),
                    RequestChoice(id: "decline", label: "Decline", tone: .deny, takesText: false),
                    RequestChoice(id: "cancel", label: "Cancel", tone: .neutral, takesText: false),
                ])
            try harness.command(.answer(request: request.id, answer: .choice(choiceId: choiceId, text: nil)))
            XCTAssertEqual(
                harness.written.last, #"{"id":8,"result":{"action":"accept","content":{},"_meta":{"persist":"\#(persist)"}}}"#)
        }
    }

    func testOffersOnlyTheRememberingMetaPersistNamesAsOneModeOrAListAndNoneItDoesNotKnow() throws {
        func ids(_ meta: String) throws -> [String] {
            try elicit(
                try codexReady(), #""mode":"form","message":"Go on?","requestedSchema":{"type":"object","properties":{}}"#,
                meta: meta
            ).choices.map(\.id)
        }
        XCTAssertEqual(try ids(#"{"persist":"always"}"#), ["remember:always", "decline", "cancel"])
        XCTAssertEqual(try ids(#"{"persist":["forever","session"]}"#), ["remember:session", "decline", "cancel"])
        XCTAssertEqual(try ids(#"{"codex_approval_kind":"mcp_tool_call"}"#), ["decline", "cancel"])
    }

    func testOffersNoRememberingForAFormWithFieldsAsCodexsOwnUIDoesNot() throws {
        let request = try elicit(
            try codexReady(),
            #""mode":"form","message":"File a ticket","requestedSchema":{"type":"object","properties":{"title":{"type":"string"}}}"#,
            meta: #"{"persist":["session","always"]}"#)
        XCTAssertEqual(request.choices.map(\.id), ["decline", "cancel"])
    }
}

final class CodexUnknownTests: XCTestCase {
    func testShowsAnUnknownNotificationAsAQuietReportOncePerMethodAndGoesOn() throws {
        let harness = try codexReady()
        try harness.receive(#"{"method":"thread/sparkles","params":{"threadId":"\#(CODEX_MAIN)"}}"#)
        try harness.receive(#"{"method":"thread/sparkles","params":{"threadId":"\#(CODEX_MAIN)"}}"#)
        XCTAssertEqual(codexOutline(harness.transcript), ["notice(info): codex 0.156.1 reported `thread/sparkles`"])
        assertMatches(harness.transcript.entries[0].noticeEntry?.raw, ["method": "thread/sparkles"])
        XCTAssertEqual(harness.transcript.state, .ready(turn: .none))
    }

    func testSaysNothingForAMethodItKnowsAndDoesNotUse() throws {
        let harness = try codexReady()
        try harness.receive(#"{"method":"turn/diff/updated","params":{"threadId":"\#(CODEX_MAIN)","turnId":"t","diff":""}}"#)
        XCTAssertEqual(harness.transcript.entries, [])
    }

    func testAnswersARequestItDoesNotHandleWithAnErrorAndShowsIt() throws {
        let harness = try codexReady()
        let before = harness.written.count
        try harness.receive(#"{"id":9,"method":"item/tool/call","params":{"threadId":"\#(CODEX_MAIN)"}}"#)
        try harness.receive(#"{"id":10,"method":"item/tool/teleport","params":{}}"#)
        XCTAssertEqual(
            Array(harness.written[before...]),
            [
                #"{"id":9,"error":{"code":-32601,"message":"DevHub does not handle item/tool/call"}}"#,
                #"{"id":10,"error":{"code":-32601,"message":"DevHub does not handle item/tool/teleport"}}"#,
            ])
        let outline = codexOutline(harness.transcript)
        XCTAssertEqual(outline.count, 2)
        XCTAssertTrue(
            outline[0].contains(
                "asked DevHub for `item/tool/call`, which DevHub does not do (DevHub registers no dynamic tools)"))
        XCTAssertTrue(outline[1].contains("asked DevHub for `item/tool/teleport`, which DevHub does not know"))
        // The server clears a request it got an error for; that is not DevHub's to close.
        try harness.receive(#"{"method":"serverRequest/resolved","params":{"threadId":"\#(CODEX_MAIN)","requestId":9}}"#)
        XCTAssertEqual(harness.transcript.requests, [])
    }

    func testShowsAnItemTypeItDoesNotKnowAsANoticeWithTheItem() throws {
        let harness = try codexReady()
        try harness.receive(
            #"{"method":"item/completed","params":{"threadId":"\#(CODEX_MAIN)","turnId":"t","completedAtMs":0,"item":{"type":"hologram","id":"h"}}}"#
        )
        XCTAssertTrue(codexOutline(harness.transcript)[0].contains("sent a `hologram` item, which DevHub does not know"))
    }
}

final class CodexMismatchTests: XCTestCase {
    let cases: [(String, String, String)] = [
        (
            "a known item with a status it does not have",
            #"{"method":"item/completed","params":{"threadId":"00000000-0000-7000-8000-00000000000a","turnId":"t","completedAtMs":0,"item":{"type":"commandExecution","id":"c","command":"ls","cwd":"/home/testuser/project","status":"teleported","aggregatedOutput":null,"exitCode":null}}}"#,
            #"^params\.item\.status: expected one of inProgress \| completed \| failed \| declined, got a string \(CLI 0\.156\.1"#
        ),
        ("a line that is not JSON", "{not json", #"^line: expected JSON, got \{not json"#),
        (
            "a reply to a request DevHub never made", #"{"id":99,"result":{}}"#,
            #"^message\.id: expected a reply to a request DevHub made, got one to 99"#
        ),
        (
            "a delta for a message that never started",
            #"{"method":"item/agentMessage/delta","params":{"threadId":"00000000-0000-7000-8000-00000000000a","turnId":"t","itemId":"ghost","delta":"x"}}"#,
            #"^params\.itemId: expected a delta for a streaming message, got one for ghost \(never started\)"#
        ),
    ]

    func testThrowsTheSharedProtocolMismatchAndIsSpentAfter() throws {
        for (name, line, detail) in cases {
            let harness = try codexReady()
            var thrown: Error?
            do {
                try harness.receive(line)
            } catch {
                thrown = error
            }
            guard let mismatch = thrown as? ProtocolMismatch else {
                XCTFail("\(name): \(String(describing: thrown)) is not a ProtocolMismatch")
                continue
            }
            XCTAssertNotNil(mismatch.message.range(of: detail, options: .regularExpression), "\(name): \(mismatch.message)")
            XCTAssertEqual(mismatch.agentVersion, "0.156.1", name)
            assertThrowsMatching("spent") {
                try harness.receive(#"{"method":"warning","params":{"threadId":null,"message":"later"}}"#)
            }
            assertThrowsMatching("spent") { try harness.command(.interrupt) }
        }
    }
}

final class CodexReplayTests: XCTestCase {
    func liveRun() throws -> CodexHarness {
        let harness = try codexReady()
        try harness.send("go")
        for line in codexFixture("turn.handwritten.ndjson") {
            for event in try harness.receive(line).events {
                if case .requestOpened(let request) = event {
                    try harness.command(.answer(request: request.id, answer: .choice(choiceId: "accept", text: nil)))
                }
            }
        }
        return harness
    }

    func testRebuildsTheSameTranscriptFromTheJournalsAndWritesNothing() throws {
        let live = try liveRun()
        let replayed = try CodexHarness.replaying(live)
        XCTAssertEqual(replayed.written, [])
        XCTAssertEqual(replayed.transcript, live.transcript)
        // And it carries on where the live one left off.
        try replayed.send("next")
        assertMatches(
            replayed.lastWrite(), j(#"{"id":6,"method":"turn/start","params":{"clientUserMessageId":"devhub-person-1"}}"#))
    }

    func testFinishesAHandshakeADevHubThatDiedHalfwayThroughDidNot() throws {
        let replayed = CodexHarness()
        _ = try replayed.adapter.sent(#"{"id":0,"method":"initialize","params":{}}"#)
        try replayed.receive(codexFixture("handshake.handwritten.ndjson")[0])
        XCTAssertEqual(replayed.written, [#"{"method":"initialized"}"#, #"{"id":1,"method":"account/read","params":{}}"#])
    }

    func testDoesNotAnswerAgainARequestItDeclinedBeforeTheRestart() throws {
        let replayed = CodexHarness()
        for line in [
            #"{"id":0,"method":"initialize","params":{}}"#,
            #"{"id":9,"error":{"code":-32601,"message":"DevHub does not handle item/tool/call"}}"#,
        ] {
            _ = try replayed.adapter.sent(line)
        }
        try replayed.receive(#"{"id":9,"method":"item/tool/call","params":{}}"#)
        XCTAssertEqual(replayed.written, [])
    }

    /// The TS app's journals read the same here: a fixture capture's `> `
    /// lines, which the TS adapter wrote, are what this one writes for the
    /// same answers.
    func testWritesTheSameLinesTheTSAdapterWroteInTheCapture() throws {
        let capture = Fixtures.text("codex", "codex-greeting.capture.ndjson").components(separatedBy: "\n")
        let wrote = capture.filter { $0.hasPrefix("> ") }.map { String($0.dropFirst(2)) }
        let adapter = CodexAdapter(CODEX_OPTIONS)
        var ours = try adapter.opening()
        for line in capture {
            if line.hasPrefix("< ") {
                ours += try adapter.received(String(line.dropFirst(2))).replies
            } else if line.hasPrefix("> ") {
                _ = try adapter.sent(String(line.dropFirst(2)))
            }
        }
        // The handshake DevHub wrote by itself is what the TS adapter wrote,
        // spelled the same. (The capture is older than `model/list`'s
        // `includeHidden` and than `skills/list`, which both adapters ask
        // for now.)
        XCTAssertEqual(Array(ours.prefix(4)), Array(wrote.prefix(4)))
        XCTAssertEqual(ours.count, 6)
    }
}

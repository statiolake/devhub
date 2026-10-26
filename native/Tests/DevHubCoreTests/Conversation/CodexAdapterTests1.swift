// Port of apps/desktop/src/main/agent/conversation/codex/adapter.test.ts (1/4):
// the app-server argv, the handshake, a turn.

import XCTest
@testable import DevHubCore

final class CodexArgvAndHandshakeTests: XCTestCase {
    func testPutsTheProfilesArgumentsBeforeTheSubcommand() {
        XCTAssertEqual(appServerArgs(["-c", "model=o3"]), ["-c", "model=o3", "app-server"])
    }

    func testInitializesReadsTheAccountStartsAThreadAndListsModelsAndSkills() throws {
        let harness = CodexHarness()
        let lines = codexFixture("handshake.handwritten.ndjson")
        let (initialize, account, start, started, models, skills) = (lines[0], lines[1], lines[2], lines[3], lines[4], lines[5])

        try harness.start()
        XCTAssertEqual(
            harness.writesSince(0),
            [
                j(
                    #"{"id":0,"method":"initialize","params":{"clientInfo":{"name":"devhub","title":"DevHub","version":"0.1.0"},"capabilities":{"experimentalApi":false,"requestAttestation":false}}}"#
                )
            ])
        // Byte for byte what the TS app writes: both apps read each other's in.log.
        XCTAssertEqual(
            harness.written[0],
            #"{"id":0,"method":"initialize","params":{"clientInfo":{"name":"devhub","title":"DevHub","version":"0.1.0"},"capabilities":{"experimentalApi":false,"requestAttestation":false}}}"#
        )

        try harness.receive(initialize)
        XCTAssertEqual(harness.writesSince(1), [j(#"{"method":"initialized"}"#), j(#"{"id":1,"method":"account/read","params":{}}"#)])
        XCTAssertEqual(harness.written[1...], [#"{"method":"initialized"}"#, #"{"id":1,"method":"account/read","params":{}}"#])

        try harness.receive(account)
        XCTAssertEqual(harness.written[3...], [#"{"id":2,"method":"thread/start","params":{"cwd":"/home/testuser/project"}}"#])
        XCTAssertEqual(harness.transcript.state, .connecting)

        try harness.receive(start)
        XCTAssertEqual(
            harness.written[4...],
            [
                #"{"id":3,"method":"model/list","params":{"includeHidden":true}}"#,
                #"{"id":4,"method":"skills/list","params":{"cwds":["/home/testuser/project"]}}"#,
            ])
        XCTAssertEqual(harness.transcript.state, .ready(turn: .none))
        XCTAssertEqual(conversationStatus(harness.transcript), .idle)

        try harness.receive(started)
        XCTAssertNotEqual(harness.events.last?.type, "entry")
        try harness.receive(models)
        let session = harness.transcript.session
        XCTAssertEqual(session.agentVersion, "0.156.1")
        XCTAssertEqual(session.sessionId, CODEX_MAIN)
        XCTAssertEqual(session.cwd, CODEX_CWD)
        XCTAssertEqual(
            session.model,
            Setting(
                current: "gpt-5.5-codex",
                choices: [
                    SettingChoice(id: "gpt-5.5-codex", label: "gpt-5.5-codex", detail: "GPT-5.5 Codex"),
                    SettingChoice(id: "gpt-5.5-mini", label: "gpt-5.5-mini", detail: "GPT-5.5 mini"),
                ]))
        XCTAssertEqual(
            session.effort,
            Setting(current: "medium", choices: ["low", "medium", "high"].map { SettingChoice(id: $0, label: $0) }))
        // on-request + workspaceWrite is the TUI's "Auto" preset.
        XCTAssertEqual(session.mode.current, "auto")
        XCTAssertEqual(session.mode.choices.map(\.id), ["read-only", "auto", "full-access"])
        XCTAssertEqual(harness.transcript.entries, [])

        // The enabled skills, offered after `$` beside the commands after `/`.
        XCTAssertEqual(
            session.commands.map { "\($0.trigger.rawValue)\($0.name)" },
            ["/model", "/effort", "/approvals", "/resume", "/restart", "/mcp"])
        try harness.receive(skills)
        XCTAssertEqual(
            harness.transcript.session.commands.filter { $0.trigger == .dollar },
            [
                SlashCommand(trigger: .dollar, name: "release-notes", description: "Write release notes", argumentHint: nil, route: .message),
                SlashCommand(trigger: .dollar, name: "skill-creator", description: "Create a skill", argumentHint: nil, route: .message),
            ])
    }

    func testSaysItCouldNotListTheSkillsAndOffersNone() throws {
        let harness = CodexHarness()
        try harness.start()
        for line in codexFixture("handshake.handwritten.ndjson").prefix(5) { try harness.receive(line) }
        try harness.receive(#"{"id":4,"error":{"code":-32603,"message":"no skills"}}"#)
        XCTAssertFalse(harness.transcript.session.commands.contains { $0.trigger == .dollar })
        let notices = harness.transcript.entries.compactMap(\.noticeEntry)
        XCTAssertEqual(notices.map(\.level), [.warning])
        XCTAssertTrue(notices[0].text.contains("could not list its skills: no skills"))
    }

    func testStopsAtASignedOutAccountAndSaysToSignInWithoutStartingAThread() throws {
        let harness = CodexHarness()
        try harness.start()
        try harness.receive(codexFixture("handshake.handwritten.ndjson")[0])
        try harness.receive(#"{"id":1,"result":{"account":null,"requiresOpenaiAuth":true}}"#)
        guard case .broken(let failure) = harness.transcript.state else { return XCTFail("not broken") }
        XCTAssertEqual(failure.code, .notSignedIn)
        XCTAssertTrue(failure.detail.contains("codex login"))
        XCTAssertFalse(harness.writesSince(0).contains { $0["method"] == "thread/start" })
        assertThrowsMatching("broken") { try harness.send("hi") }
    }

    func testGoesOnToTheThreadWhenTheAccountCannotBeReadAndSaysSo() throws {
        let harness = CodexHarness()
        try harness.start()
        try harness.receive(codexFixture("handshake.handwritten.ndjson")[0])
        try harness.receive(#"{"id":1,"error":{"code":-32603,"message":"keyring locked"}}"#)
        assertMatches(harness.lastWrite(), ["method": "thread/start"])
        XCTAssertEqual(
            codexOutline(harness.transcript), ["notice(warning): codex 0.156.1 could not read its account: keyring locked"])
    }

    func testIsRefusedWhenAppServerWillNotInitializeOrOpenTheThread() throws {
        for failing in [0, 2] {
            let harness = CodexHarness()
            try harness.start()
            for line in codexFixture("handshake.handwritten.ndjson").prefix(failing) { try harness.receive(line) }
            try harness.receive(#"{"id":\#(failing),"error":{"code":-32600,"message":"unsupported cwd"}}"#)
            XCTAssertEqual(
                harness.transcript.state,
                .broken(
                    ConversationFailure(
                        code: .refused,
                        detail: "\(failing == 0 ? "initialize" : "thread/start") failed: unsupported cwd (-32600)")))
        }
    }

    func testResumesAThreadItIsGivenAndDrawsTheTurnsThatComeBackWithIt() throws {
        let harness = CodexHarness(CodexAdapterOptions(clientVersion: "0.1.0", cwd: CODEX_CWD, resumeThreadId: CODEX_MAIN))
        try harness.start()
        let lines = codexFixture("handshake.handwritten.ndjson")
        try harness.receive(lines[0])
        try harness.receive(lines[1])
        XCTAssertEqual(
            harness.written.last, #"{"id":2,"method":"thread/resume","params":{"threadId":"\#(CODEX_MAIN)","cwd":"/home/testuser/project"}}"#)
        let opened = setting(
            j(lines[2]), ["result", "thread", "turns"],
            j(
                #"""
                [{"id":"old-turn","items":[
                  {"type":"userMessage","id":"old-user","clientId":null,"content":[{"type":"text","text":"earlier","text_elements":[]}]},
                  {"type":"agentMessage","id":"old-say","text":"done","phase":null,"memoryCitation":null,"delivery":null,"questions":null}],
                 "itemsView":"full","status":"completed","error":null,"startedAt":null,"completedAt":null,"durationMs":10}]
                """#))
        try harness.receive(opened)
        XCTAssertEqual(codexOutline(harness.transcript), ["user(person): earlier", "assistant: done", "turn-end completed 10ms"])
        XCTAssertEqual(harness.transcript.state, .ready(turn: .none))
    }
}

final class CodexTurnTests: XCTestCase {
    func testSendsEachSkillTheWordsMentionAfterDollarAsThatSkillBesideTheWords() throws {
        let harness = try codexReady()
        let text = "Use $release-notes, then $skill-creator. Not $old-habit or $nothing, nor a$release-notes."
        try harness.send(text)
        assertMatches(
            harness.lastWrite(),
            .object([
                "id": 5, "method": "turn/start",
                "params": [
                    "input": [
                        ["type": "text", "text": .string(text), "text_elements": []],
                        [
                            "type": "skill", "name": "release-notes",
                            "path": "/home/testuser/project/.codex/skills/release-notes/SKILL.md",
                        ],
                        [
                            "type": "skill", "name": "skill-creator",
                            "path": "/home/testuser/.codex/skills/.system/skill-creator/SKILL.md",
                        ],
                    ]
                ],
            ]))
        // The message comes back with its skills, and is drawn as its words.
        try harness.receive(
            .object([
                "method": "item/started",
                "params": [
                    "threadId": .string(CODEX_MAIN), "turnId": "turn-1", "startedAtMs": 1_790_000_000_000,
                    "item": [
                        "type": "userMessage", "id": "item-user", "clientId": "devhub-person-0",
                        "content": [
                            ["type": "text", "text": .string(text), "text_elements": []],
                            [
                                "type": "skill", "name": "release-notes",
                                "path": "/home/testuser/project/.codex/skills/release-notes/SKILL.md",
                            ],
                        ],
                    ],
                ],
            ]))
        XCTAssertEqual(harness.transcript.sending, [])
        XCTAssertEqual(codexOutline(harness.transcript), ["user(person): \(text)"])
    }

    func testRunsAWholeTurnWithTwoApprovalsIntoOneTranscript() throws {
        let harness = try codexReady()
        try harness.send("Run pwd, then fix the README title.")
        XCTAssertEqual(
            harness.written.last,
            #"{"id":5,"method":"turn/start","params":{"threadId":"\#(CODEX_MAIN)","input":[{"type":"text","text":"Run pwd, then fix the README title.","text_elements":[]}],"clientUserMessageId":"devhub-person-0"}}"#
        )

        var statuses: [ConversationAgentStatus] = []
        for line in codexFixture("turn.handwritten.ndjson") {
            let step = try harness.receive(line)
            statuses.append(conversationStatus(harness.transcript))
            guard let opened = step.events.lazy.compactMap({ event -> PendingRequest? in
                if case .requestOpened(let request) = event { return request }
                return nil
            }).first else { continue }
            if case .command(let command, let cwd, let reason) = opened.subject {
                XCTAssertEqual(opened.entry, EntryId("\(CODEX_MAIN)/item-pwd"))
                XCTAssertEqual(command, "pwd")
                XCTAssertEqual(cwd, CODEX_CWD)
                XCTAssertEqual(reason, "Needs to read the working directory")
                XCTAssertEqual(
                    opened.choices.map(\.label),
                    ["Allow once", "Allow for this session", "Always allow `pwd`", "Decline", "Decline and stop the turn"])
                try harness.command(.answer(request: opened.id, answer: .choice(choiceId: "accept", text: nil)))
                XCTAssertEqual(harness.written.last, #"{"id":0,"result":{"decision":"accept"}}"#)
            } else {
                XCTAssertEqual(
                    opened.subject,
                    .fileChange(files: [FileDiff(path: "README.md", unifiedDiff: "@@ -1 +1 @@\n-# Projet\n+# Project\n")]))
                try harness.command(.answer(request: opened.id, answer: .choice(choiceId: "acceptForSession", text: nil)))
                XCTAssertEqual(harness.written.last, #"{"id":1,"result":{"decision":"acceptForSession"}}"#)
            }
        }

        XCTAssertEqual(
            codexOutline(harness.transcript),
            [
                "user(person): Run pwd, then fix the README title.",
                "assistant: [thinking] **Checking** where I am",
                "assistant: I'll run `pwd` first.",
                #"tool commandExecution "pwd" succeeded -> "/home/testuser/project\n""#,
                #"tool fileChange "Edit: README.md" succeeded -> README.md"#,
                "assistant: [plan] Run pwd=completed, Fix the README title=in_progress",
                "assistant: Fixed the title.",
                "turn-end completed 4200ms",
            ])
        XCTAssertEqual(harness.transcript.requests, [])
        XCTAssertEqual(harness.transcript.state, .ready(turn: .none))
        // working → waiting (approval) → working → … → idle. Working from the
        // first answer on: the message is written and not taken yet, which is
        // the turn it starts, not an Agent at its prompt.
        XCTAssertEqual(statuses.first, .working)
        XCTAssertTrue(statuses.contains(.waiting))
        XCTAssertEqual(statuses[statuses.count - 2], .working)
        XCTAssertEqual(statuses.last, .idle)

        XCTAssertEqual(
            harness.transcript.usage,
            Usage(
                inputTokens: 1200, outputTokens: 300, cachedInputTokens: 800, contextTokens: 900, contextWindow: 272_000,
                costUsd: nil,
                rateLimits: [
                    RateLimit(window: "5-hour", durationMinutes: 300, usedPercent: 42, resetsAt: (1_790_000_000 + 3600) * 1000)
                ]))
        guard case .turnEnd(let end)? = harness.transcript.entries.last else { return XCTFail("no turn end") }
        XCTAssertEqual(end.usage?.inputTokens, 1200)
        XCTAssertEqual(end.usage?.outputTokens, 300)
        XCTAssertEqual(end.usage?.cachedInputTokens, 800)
    }

    func testStreamsDeltasIntoTheEntriesTheyBelongTo() throws {
        let harness = try codexReady()
        try harness.send("go")
        // Up to and including the second agentMessage delta.
        for line in codexFixture("turn.handwritten.ndjson").prefix(12) { try harness.receive(line) }
        XCTAssertEqual(
            try harness.entry("\(CODEX_MAIN)/item-say"),
            .assistant(
                AssistantEntry(
                    id: EntryId("\(CODEX_MAIN)/item-say"), parent: nil, blocks: [.text(markdown: "I'll run `pwd` first.")],
                    streaming: true)))
        let think = try harness.entry("\(CODEX_MAIN)/item-think").assistantEntry
        XCTAssertEqual(think?.blocks, [.thinking(text: "**Checking** where I am")])
        XCTAssertEqual(think?.streaming, false)
    }

    func testOffersAnExecpolicyAmendmentAsAnAlwaysChoiceAndSpellsItBack() throws {
        let harness = try codexReady()
        try harness.send("go")
        let lines = codexFixture("turn.handwritten.ndjson")
        var request: PendingRequest?
        for line in lines.prefix(15) {
            for event in try harness.receive(line).events {
                if case .requestOpened(let opened) = event { request = opened }
            }
        }
        XCTAssertEqual(conversationStatus(harness.transcript), .waiting)
        try harness.command(.answer(request: request!.id, answer: .choice(choiceId: "execpolicy", text: nil)))
        XCTAssertEqual(
            harness.written.last,
            #"{"id":0,"result":{"decision":{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["pwd"]}}}}"#)
        // Answered, but open until the server says it is resolved.
        XCTAssertEqual(harness.transcript.requests.count, 1)
        assertThrowsMatching("already answered") {
            try harness.command(.answer(request: request!.id, answer: .choice(choiceId: "accept", text: nil)))
        }
        try harness.receive(lines[15])
        XCTAssertEqual(harness.transcript.requests, [])
        assertThrowsMatching("not open") {
            try harness.command(.answer(request: request!.id, answer: .choice(choiceId: "accept", text: nil)))
        }
    }

    func testSteersARunningTurnInsteadOfStartingAnother() throws {
        let harness = try codexReady()
        try harness.send("go")
        for line in codexFixture("turn.handwritten.ndjson").prefix(4) { try harness.receive(line) }
        try harness.send("also check git", .injection)
        XCTAssertEqual(
            harness.written.last,
            #"{"id":6,"method":"turn/steer","params":{"threadId":"\#(CODEX_MAIN)","input":[{"type":"text","text":"also check git","text_elements":[]}],"clientUserMessageId":"devhub-injection-1","expectedTurnId":"turn-1"}}"#
        )
        try harness.receive(
            #"{"method":"item/completed","params":{"threadId":"\#(CODEX_MAIN)","turnId":"turn-1","completedAtMs":0,"item":{"type":"userMessage","id":"item-steer","clientId":"devhub-injection-1","content":[{"type":"text","text":"also check git","text_elements":[]}]}}}"#
        )
        let steer = try harness.user("\(CODEX_MAIN)/item-steer")
        XCTAssertEqual(steer.origin, .injection)
        // Taken into turn-1, which its first message starts: no place to cut.
        XCTAssertFalse(steer.rewindable)
    }

    func testInterruptsTheRunningTurnAndInterruptingNothingSendsNothing() throws {
        let harness = try codexReady()
        let before = harness.written.count
        try harness.command(.interrupt)
        XCTAssertEqual(harness.written.count, before)

        try harness.send("go")
        // Up to and including the command's approval request.
        for line in codexFixture("turn.handwritten.ndjson").prefix(15) { try harness.receive(line) }
        try harness.command(.interrupt)
        XCTAssertEqual(
            harness.written.last,
            #"{"id":6,"method":"turn/interrupt","params":{"threadId":"\#(CODEX_MAIN)","turnId":"turn-1"}}"#)
        try harness.receive(
            #"{"method":"turn/completed","params":{"threadId":"\#(CODEX_MAIN)","turn":{"id":"turn-1","items":[],"itemsView":"notLoaded","status":"interrupted","error":null,"startedAt":null,"completedAt":null,"durationMs":null}}}"#
        )
        // The command that never finished is interrupted with the turn.
        XCTAssertEqual(try harness.tool("\(CODEX_MAIN)/item-pwd").status, .interrupted)
        XCTAssertEqual(harness.transcript.entries.last?.turnEndEntry?.outcome, .interrupted)
        XCTAssertEqual(conversationStatus(harness.transcript), .waiting)  // the approval is still open
    }

    func testCarriesChosenSettingsIntoTheNextTurnStart() throws {
        let harness = try codexReady()
        let before = harness.written.count
        try harness.configure(.model, "gpt-5.5-mini")
        // Choosing writes nothing (Codex takes settings per turn), and the
        // choice shows at once.
        XCTAssertEqual(harness.written.count, before)
        XCTAssertEqual(harness.transcript.session.model.current, "gpt-5.5-mini")
        // A model chosen here runs at its own default effort until one is.
        XCTAssertEqual(harness.transcript.session.effort, Setting(current: "low", choices: [SettingChoice(id: "low", label: "low")]))
        try harness.configure(.effort, "low")
        try harness.configure(.mode, "read-only")
        assertThrowsMatching("not a effort") { try harness.configure(.effort, "extreme") }
        try harness.send("go")
        XCTAssertEqual(
            harness.written.last,
            #"{"id":5,"method":"turn/start","params":{"threadId":"\#(CODEX_MAIN)","input":[{"type":"text","text":"go","text_elements":[]}],"clientUserMessageId":"devhub-person-0","model":"gpt-5.5-mini","effort":"low","approvalPolicy":"on-request","sandboxPolicy":{"type":"readOnly","networkAccess":false}}}"#
        )
    }

    func testSaysWhenAppServerDoesNotStartOrSteerATurn() throws {
        let harness = try codexReady()
        try harness.send("go")
        try harness.receive(#"{"id":5,"error":{"code":-32600,"message":"model not available"}}"#)
        XCTAssertTrue(codexOutline(harness.transcript).last!.hasSuffix("did not start the turn: model not available"))
        XCTAssertEqual(harness.transcript.state, .ready(turn: .none))
    }

    func testShowsAnErrorAppServerWillRetryAsAWarningAndOneItWillNotAsAnError() throws {
        let harness = try codexReady()
        for willRetry in [true, false] {
            try harness.receive(
                #"{"method":"error","params":{"error":{"message":"stream disconnected","codexErrorInfo":null,"additionalDetails":null,"misalignment":null},"willRetry":\#(willRetry),"threadId":"\#(CODEX_MAIN)","turnId":"turn-1"}}"#
            )
        }
        XCTAssertEqual(
            codexOutline(harness.transcript),
            ["notice(warning): stream disconnected (retrying)", "notice(error): stream disconnected"])
    }
}

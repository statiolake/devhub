// Port of apps/desktop/src/model/conversation.test.ts
//
// The one fold of a conversation. The coordinator and the view both build a
// Transcript by folding events with `applyEvent`, so what these tests pin is
// what both of them see: a stream that grows and finalizes, a tool call that
// runs and ends, subagent entries hanging off the call that started them,
// requests that open and close — and the events that cannot be true, refused
// where they land instead of drawn.

import XCTest
@testable import DevHubCore

private let READY = ConversationEvent.state(.ready(turn: .none))
private let RUNNING = ConversationEvent.state(.ready(turn: .running))

private func user(_ id: String, _ text: String, _ parent: String? = nil) -> ConversationEvent {
    .entry(.user(UserEntry(id: EntryId(id), parent: parent.map { EntryId($0) }, text: text, origin: .person, rewindable: true)))
}

private func assistant(_ id: String, _ blocks: [AssistantBlock], _ streaming: Bool, _ parent: String? = nil)
    -> ConversationEvent
{
    .entry(.assistant(AssistantEntry(id: EntryId(id), parent: parent.map { EntryId($0) }, blocks: blocks, streaming: streaming)))
}

private func toolEntry(_ id: String, _ parent: String? = nil, _ change: (inout ToolEntry) -> Void = { _ in }) -> ToolEntry {
    var entry = ToolEntry(
        id: EntryId(id), parent: parent.map { EntryId($0) }, tool: "Bash", title: "Bash: pwd",
        input: ["command": "pwd"], status: .running)
    change(&entry)
    return entry
}

private func tool(_ id: String, _ parent: String? = nil, _ change: (inout ToolEntry) -> Void = { _ in })
    -> ConversationEvent
{
    .entry(.tool(toolEntry(id, parent, change)))
}

private func delta(_ id: String, _ block: Int, _ text: String) -> ConversationEvent {
    .textDelta(entry: EntryId(id), block: block, text: text)
}

private func turnEnd(_ id: String, _ outcome: TurnOutcome, _ limit: LimitStop? = nil) -> ConversationEvent {
    .entry(.turnEnd(TurnEndEntry(id: EntryId(id), outcome: outcome, durationMs: 1200, limit: limit)))
}

private func permission(_ id: String, _ about: String?) -> PendingRequest {
    PendingRequest(
        id: RequestId(id), entry: about.map { EntryId($0) },
        subject: .tool(tool: "Bash", title: "Bash: pwd", input: ["command": "pwd"], reason: nil),
        choices: [
            RequestChoice(id: "allow", label: "Allow once", tone: .allow, takesText: false),
            RequestChoice(id: "deny", label: "Deny", tone: .deny, takesText: true),
        ])
}

private func fold(_ events: ConversationEvent...) throws -> Transcript {
    try applyEvents(EMPTY_TRANSCRIPT, events)
}

private func entry(_ transcript: Transcript, _ id: String) throws -> TranscriptEntry {
    try XCTUnwrap(transcript.entries.first { $0.id == EntryId(id) }, "no entry \(id) in the test transcript")
}

private func refused(
    _ transcript: Transcript, _ event: ConversationEvent, _ pattern: String,
    file: StaticString = #filePath, line: UInt = #line
) {
    XCTAssertThrowsError(try applyEvent(transcript, event), file: file, line: line) { error in
        guard let error = error as? TranscriptInvariantError else {
            return XCTFail("not a TranscriptInvariantError: \(error)", file: file, line: line)
        }
        XCTAssertNotNil(
            error.message.range(of: pattern, options: .regularExpression),
            "\(error.message) does not match /\(pattern)/", file: file, line: line)
    }
}

private func ids(_ entries: [TranscriptEntry]) -> [String] { entries.map(\.id.raw) }

private func running(_ tasks: RunningTask...) -> ConversationEvent { .backgroundTasks(tasks) }

private func shell(_ id: String, _ call: String?) -> RunningTask {
    RunningTask(id: id, kind: "shell", title: "run \(id)", call: call.map { EntryId($0) }, startedAt: nil, stoppable: .yes)
}

private func held(_ id: String, _ text: String, failure: String? = nil, editing: Bool = false) -> PendingMessage {
    PendingMessage(id: PendingId(id), text: text, images: [], failure: failure, editing: editing)
}

final class ConversationFoldTests: XCTestCase {
    // MARK: an empty conversation

    func testAnEmptyConversationIsConnectingAndKnowsNothing() {
        XCTAssertEqual(EMPTY_TRANSCRIPT.state, .connecting)
        XCTAssertEqual(EMPTY_TRANSCRIPT.entries, [])
        XCTAssertEqual(EMPTY_TRANSCRIPT.requests, [])
        XCTAssertNil(EMPTY_TRANSCRIPT.usage)
        XCTAssertNil(EMPTY_TRANSCRIPT.session.sessionId)
        XCTAssertEqual(EMPTY_TRANSCRIPT.session.commands, [])
        XCTAssertEqual(conversationStatus(EMPTY_TRANSCRIPT), .unknown)
    }

    // MARK: entries

    func testEntriesAreAppendedInTheOrderTheyArrive() throws {
        let t = try fold(user("u1", "fix the tests"), assistant("a1", [.text(markdown: "On it.")], false), tool("t1"))
        XCTAssertEqual(ids(t.entries), ["u1", "a1", "t1"])
    }

    func testEntriesAreReplacedWholeInPlace() throws {
        let t = try fold(
            user("u1", "hello"), tool("t1"), assistant("a1", [], false),
            tool("t1") {
                $0.status = .succeeded
                $0.output = [.text("/")]
            })
        XCTAssertEqual(ids(t.entries), ["u1", "t1", "a1"])
        let t1 = try XCTUnwrap(try entry(t, "t1").toolEntry)
        XCTAssertEqual(t1.status, .succeeded)
        XCTAssertEqual(t1.output, [.text("/")])
    }

    func testTheSameEntryTwiceIsTheSameAsOnce() throws {
        let once = try fold(user("u1", "hello"), tool("t1"))
        XCTAssertEqual(try applyEvent(once, tool("t1")), once)
    }

    func testEntriesCannotChangeTheirKind() throws {
        refused(try fold(user("x", "hello")), assistant("x", [], false), "was a user and cannot become a assistant")
    }

    func testEntriesCannotMoveToAnotherParent() throws {
        let t = try fold(
            tool("task1") { $0.tool = "Task" }, tool("task2") { $0.tool = "Task" },
            assistant("child", [], false, "task1"))
        refused(t, assistant("child", [], false, "task2"), "cannot move from parent task1")
        refused(t, assistant("child", [], false, nil), "cannot move from parent task1")
    }

    func testEntriesLeaveTheTranscriptTheyWereAppliedToUntouched() throws {
        let before = try fold(user("u1", "hello"), assistant("a1", [.text(markdown: "")], true))
        let snapshot = before
        _ = try applyEvent(before, delta("a1", 0, "Hi"))
        _ = try applyEvent(before, tool("t1"))
        _ = try applyEvent(before, user("u1", "changed"))
        XCTAssertEqual(before, snapshot)
    }

    // MARK: a streaming assistant message

    private func opened() throws -> Transcript {
        try fold(user("u1", "explain"), assistant("a1", [.thinking(text: ""), .text(markdown: "")], true))
    }

    func testAStreamGrowsByItsDeltasBlockByBlock() throws {
        let grown = try applyEvents(
            try opened(),
            [delta("a1", 0, "Let me "), delta("a1", 0, "think."), delta("a1", 1, "The answer "), delta("a1", 1, "is **42**.")])
        XCTAssertEqual(
            try entry(grown, "a1"),
            .assistant(
                AssistantEntry(
                    id: "a1", parent: nil,
                    blocks: [.thinking(text: "Let me think."), .text(markdown: "The answer is **42**.")], streaming: true)))
    }

    func testAStreamIsFinalizedByTheCompleteMessage() throws {
        let final = try applyEvents(
            try opened(),
            [
                delta("a1", 1, "The ans"),
                assistant("a1", [.thinking(text: "Let me think."), .text(markdown: "The answer is 42.")], false),
            ])
        let finalized = try XCTUnwrap(try entry(final, "a1").assistantEntry)
        XCTAssertFalse(finalized.streaming)
        XCTAssertEqual(finalized.blocks[1], .text(markdown: "The answer is 42."))
    }

    func testAStreamOpensAnotherBlockByBeingReplacedWithOneMore() throws {
        let more = try applyEvents(
            try opened(),
            [
                delta("a1", 1, "First."),
                assistant("a1", [.thinking(text: ""), .text(markdown: "First."), .text(markdown: "")], true),
                delta("a1", 2, "Second."),
            ])
        XCTAssertEqual(
            Array(try XCTUnwrap(try entry(more, "a1").assistantEntry).blocks.dropFirst()),
            [.text(markdown: "First."), .text(markdown: "Second.")])
    }

    func testAStreamTakesNoDeltaOnceFinalized() throws {
        let final = try applyEvent(try opened(), assistant("a1", [.text(markdown: "done")], false))
        refused(final, delta("a1", 0, "late"), "a1, which is no longer streaming")
    }

    func testADeltaForAnEntryThatDoesNotExistIsRefused() throws {
        refused(try opened(), delta("nope", 0, "x"), "text delta for nope, which is not an entry")
    }

    func testADeltaForAnEntryThatIsNotAnAssistantMessageIsRefused() throws {
        let withTool = try applyEvent(try opened(), tool("t1"))
        refused(withTool, delta("t1", 0, "x"), "text delta for t1, which is a tool entry")
        refused(withTool, delta("u1", 0, "x"), "text delta for u1, which is a user entry")
    }

    func testADeltaForABlockTheMessageDoesNotHaveIsRefused() throws {
        refused(try opened(), delta("a1", 2, "x"), "block 2 of a1, which has 2")
        refused(try opened(), delta("a1", -1, "x"), "block -1 of a1")
    }

    func testATextDeltaIntoAPlanIsRefused() throws {
        let planned = try applyEvent(
            try opened(), assistant("a1", [.plan(steps: [PlanStep(text: "read", status: .pending)])], true))
        refused(planned, delta("a1", 0, "x"), "block 0 of a1, which is a plan")
    }

    // MARK: a tool call

    func testAToolCallRunsThenEndsWithItsOutput() throws {
        let running = try fold(RUNNING, tool("t1"))
        let t1 = try XCTUnwrap(try entry(running, "t1").toolEntry)
        XCTAssertEqual(t1.status, .running)
        XCTAssertNil(t1.output)
        let output: ToolOutput = [.command(exitCode: 0, output: "/w\n", stderr: nil, interrupted: false)]
        let done = try applyEvent(
            running,
            tool("t1") {
                $0.status = .succeeded
                $0.output = output
            })
        let ended = try XCTUnwrap(try entry(done, "t1").toolEntry)
        XCTAssertEqual(ended.status, .succeeded)
        XCTAssertEqual(ended.output, output)
    }

    func testAToolCallCanEndFailedDeniedOrInterrupted() throws {
        for status in [ToolStatus.failed, .denied, .interrupted] {
            let ended = try fold(
                tool("t1"),
                tool("t1") {
                    $0.status = status
                    $0.output = [.text("no")]
                })
            XCTAssertEqual(try entry(ended, "t1").toolEntry?.status, status)
        }
    }

    func testAToolCallCarriesTheChangeItMakesToFiles() throws {
        let diff = [FileDiff(path: "src/x.ts", unifiedDiff: "@@ -1 +1 @@\n-a\n+b\n")]
        let edited = try fold(
            tool("t1") {
                $0.tool = "Edit"
                $0.title = "Edit: src/x.ts"
                $0.status = .succeeded
                $0.change = diff
            })
        XCTAssertEqual(try entry(edited, "t1").toolEntry?.change, diff)
    }

    // MARK: how a call's work is going

    private func subagent(_ state: SubagentState) -> SubagentInfo {
        SubagentInfo(label: "survey", prompt: "", model: nil, state: state, takesMessages: false)
    }

    func testWorkStateIsTheCallsOwnStatusWhenItStartedNothing() {
        for status in ToolStatus.allCases {
            XCTAssertEqual(workState(toolEntry("t1") { $0.status = status }).rawValue, status.rawValue)
        }
    }

    func testWorkStateIsTheWorkACallStarted() {
        func background(_ state: SubagentState) -> ToolEntry {
            toolEntry("t1") {
                $0.status = .succeeded
                $0.background = BackgroundTask(state: state, summary: nil)
            }
        }
        XCTAssertEqual(workState(background(.running)), .running)
        XCTAssertEqual(workState(background(.completed)), .succeeded)
        XCTAssertEqual(workState(background(.failed)), .failed)
        XCTAssertEqual(workState(background(.unknown)), .unknown)
        XCTAssertEqual(workState(toolEntry("t1") { $0.status = .succeeded; $0.spawns = subagent(.running) }), .running)
        XCTAssertEqual(workState(toolEntry("t1") { $0.status = .succeeded; $0.spawns = subagent(.idle) }), .idle)
        // The work's end can arrive before the call's own result.
        XCTAssertEqual(workState(toolEntry("t1") { $0.status = .running; $0.spawns = subagent(.failed) }), .failed)
    }

    func testWorkStateIsTheCallsOwnFailureWhateverItStarted() {
        XCTAssertEqual(
            workState(toolEntry("t1") { $0.status = .interrupted; $0.spawns = subagent(.running) }), .interrupted)
    }

    // MARK: subagents

    private let spawns = SubagentInfo(label: "Explore", prompt: "find the reducer", model: "haiku", state: .running, takesMessages: false)

    private func nested() throws -> Transcript {
        let spawns = self.spawns
        return try fold(
            user("u1", "look around"),
            tool("task1") {
                $0.tool = "Task"
                $0.title = "Task: Explore"
                $0.spawns = spawns
            },
            assistant("c1", [.text(markdown: "Searching.")], false, "task1"),
            tool("c1-tool", "task1") { $0.title = "Bash: ls" },
            tool("task2", "task1") {
                $0.tool = "Task"
                $0.title = "Task: deeper"
                $0.spawns = spawns
                $0.spawns?.label = "deeper"
            },
            assistant("g1", [.text(markdown: "Deep.")], false, "task2"),
            assistant("a1", [.text(markdown: "Found it.")], false))
    }

    func testSubagentsHangOffTheCallThatStartedThem() throws {
        let n = try nested()
        XCTAssertEqual(ids(childrenOf(n, nil)), ["u1", "task1", "a1"])
        XCTAssertEqual(ids(childrenOf(n, "task1")), ["c1", "c1-tool", "task2"])
        XCTAssertEqual(ids(childrenOf(n, "task2")), ["g1"])
    }

    func testSubagentsStayInDisplayOrderInTheFlatList() throws {
        XCTAssertEqual(ids(try nested().entries), ["u1", "task1", "c1", "c1-tool", "task2", "g1", "a1"])
    }

    func testSubagentsStreamUnderTheirParent() throws {
        let streaming = try applyEvents(
            try nested(), [assistant("g2", [.text(markdown: "")], true, "task2"), delta("g2", 0, "more")])
        let g2 = try XCTUnwrap(try entry(streaming, "g2").assistantEntry)
        XCTAssertEqual(g2.parent, "task2")
        XCTAssertEqual(g2.blocks, [.text(markdown: "more")])
    }

    func testSubagentsReportTheirStateOnTheCallThatStartedThem() throws {
        let spawns = self.spawns
        let finished = try applyEvent(
            try nested(),
            tool("task1") {
                $0.tool = "Task"
                $0.title = "Task: Explore"
                $0.status = .succeeded
                $0.spawns = spawns
                $0.spawns?.state = .completed
            })
        XCTAssertEqual(try entry(finished, "task1").toolEntry?.spawns?.state, .completed)
        XCTAssertEqual(childrenOf(finished, "task1").count, 3)
    }

    func testSubagentsCannotNameAParentThatHasNotArrivedIsNotACallOrIsThemselves() throws {
        let n = try nested()
        refused(n, assistant("orphan", [], false, "task9"), "parent of orphan task9 is not an entry")
        refused(n, assistant("odd", [], false, "u1"), "parent of odd u1 is a user entry")
        refused(n, tool("self", "self"), "parent of self self is not an entry")
    }

    // MARK: requests

    private func asked() throws -> Transcript {
        try fold(READY, RUNNING, tool("t1"), .requestOpened(permission("p1", "t1")))
    }

    func testRequestsArePendingOnceOpenedAndGoneOnceClosed() throws {
        XCTAssertEqual(try asked().requests, [permission("p1", "t1")])
        XCTAssertEqual(try applyEvent(try asked(), .requestClosed("p1")).requests, [])
    }

    func testRequestsStayInOrderAndCloseIndependently() throws {
        let two = try applyEvents(
            try asked(), [tool("t2"), .requestOpened(permission("p2", "t2")), .requestClosed("p1")])
        XCTAssertEqual(two.requests.map(\.id), ["p2"])
    }

    func testRequestsNeedNotBeAboutAToolCall() throws {
        let question = PendingRequest(
            id: "q1", entry: nil,
            subject: .question(questions: [
                Question(
                    id: "which", header: "Pick", text: "Which one?",
                    options: [
                        QuestionOption(label: "A", description: "the first"),
                        QuestionOption(label: "B", description: "the second"),
                    ], multiSelect: false, allowsOther: true)
            ]), choices: [])
        XCTAssertEqual(try applyEvent(try asked(), .requestOpened(question)).requests.map(\.id), ["p1", "q1"])
    }

    func testRequestsMustBeAboutAToolCallThatExists() throws {
        refused(try asked(), .requestOpened(permission("p2", "t9")), "subject of request p2 t9 is not an entry")
        let withUser = try applyEvent(try asked(), user("u1", "hi"))
        refused(withUser, .requestOpened(permission("p2", "u1")), "subject of request p2 u1 is a user entry, not a tool call")
    }

    func testRequestsCannotBeOpenedTwiceButCanAgainOnceClosed() throws {
        refused(try asked(), .requestOpened(permission("p1", "t1")), "p1 is already open")
        let again = try applyEvents(try asked(), [.requestClosed("p1"), .requestOpened(permission("p1", "t1"))])
        XCTAssertEqual(again.requests.map(\.id), ["p1"])
    }

    func testRequestsCannotBeClosedIfNotOpen() throws {
        refused(try asked(), .requestClosed("p9"), "request p9 is not open")
        let closed = try applyEvent(try asked(), .requestClosed("p1"))
        refused(closed, .requestClosed("p1"), "request p1 is not open")
    }

    // MARK: session facts and usage

    private let session = SessionFacts(
        agentVersion: "2.1.0", sessionId: "00000000-0000-4000-8000-000000000001", cwd: "/home/testuser/project",
        model: Setting(current: "opus", choices: [SettingChoice(id: "opus", label: "Opus")]),
        effort: Setting(current: nil, choices: []),
        mode: Setting(current: "default", choices: [SettingChoice(id: "default", label: "Default")]),
        commands: [
            SlashCommand(trigger: .slash, name: "review", description: "Review a PR", argumentHint: "<pr>", route: .message),
            SlashCommand(trigger: .slash, name: "model", description: "Switch model", argumentHint: nil, route: .model),
        ], canRewind: false)

    func testSessionFactsAreReplacedWhole() throws {
        let first = try fold(.session(session))
        XCTAssertEqual(first.session, session)
        var next = session
        next.model.current = "sonnet"
        XCTAssertEqual(try applyEvent(first, .session(next)).session, next)
        XCTAssertEqual(try applyEvent(first, .session(session)), first)
    }

    func testUsageIsReplacedWhole() throws {
        let usage = Usage(
            inputTokens: 1000, outputTokens: 200, cachedInputTokens: 800, contextTokens: 1200, contextWindow: 200_000,
            costUsd: 0.01,
            rateLimits: [RateLimit(window: "5-hour", durationMinutes: 300, usedPercent: 12, resetsAt: 1_800_000_000_000)])
        let counted = try fold(.usage(usage))
        XCTAssertEqual(counted.usage, usage)
        var later = usage
        later.costUsd = 0.02
        later.rateLimits = nil
        XCTAssertEqual(try applyEvent(counted, .usage(later)).usage, later)
    }

    // MARK: rate-limit windows

    func testRateLimitWindowsReplaceByNameAndKeepWhatAReportLeavesOut() {
        let five = RateLimit(window: "5-hour", durationMinutes: 300, usedPercent: 10, resetsAt: 1)
        let seven = RateLimit(window: "7-day", durationMinutes: 10080, usedPercent: 50, resetsAt: 2)
        var later = five
        later.usedPercent = 60
        XCTAssertEqual(withRateLimits(withRateLimits(nil, [five, seven]), [later]), [later, seven])
    }

    func testRateLimitWindowsAreNamedByTheirLength() {
        XCTAssertEqual(rateLimitWindowName(300), "5-hour")
        XCTAssertEqual(rateLimitWindowName(10080), "7-day")
        XCTAssertEqual(rateLimitWindowName(90), "90-minute")
    }

    // MARK: the turn lifecycle, read as a status

    func testStatusIsUnknownIdleOrWorking() throws {
        XCTAssertEqual(conversationStatus(try fold()), .unknown)
        XCTAssertEqual(conversationStatus(try fold(READY)), .idle)
        XCTAssertEqual(conversationStatus(try fold(READY, user("u1", "go"), RUNNING)), .working)
    }

    func testStatusIsWaitingWhileARequestIsPendingEvenMidTurn() throws {
        let waiting = try fold(READY, RUNNING, tool("t1"), .requestOpened(permission("p1", "t1")))
        XCTAssertEqual(conversationStatus(waiting), .waiting)
        XCTAssertEqual(conversationStatus(try applyEvent(waiting, .requestClosed("p1"))), .working)
    }

    func testStatusIsWorkingOnlyWhileATurnRunsAndWaitingWhileAMessageIsHeld() throws {
        let sending = try fold(READY, .sending([SendingMessage(id: "s1", text: "go", images: [], origin: .person)]))
        XCTAssertEqual(conversationStatus(sending), .idle)
        XCTAssertEqual(conversationStatus(try applyEvent(sending, RUNNING)), .working)
        let heldOne = try fold(READY, .pending([held("held:1", "and then this", editing: true)]))
        XCTAssertEqual(conversationStatus(heldOne), .waiting)
        XCTAssertEqual(conversationStatus(try applyEvent(heldOne, .pending([]))), .idle)
    }

    func testCompactingOnlyWhileATurnRuns() throws {
        let compacting = try fold(READY, RUNNING, .compacting(true))
        XCTAssertTrue(compacting.compacting)
        XCTAssertEqual(conversationStatus(compacting), .working)
        XCTAssertFalse(try applyEvent(compacting, READY).compacting)
        XCTAssertFalse(try applyEvent(compacting, .restarted).compacting)
        XCTAssertThrowsError(try fold(READY, .compacting(true))) { error in
            XCTAssertEqual((error as? TranscriptInvariantError)?.message, "a compaction started while no turn is running")
        }
    }

    func testStatusIsIdleAfterACompletedTurnAndAnInterruptedOne() throws {
        XCTAssertEqual(conversationStatus(try fold(READY, RUNNING, turnEnd("e1", .completed), READY)), .idle)
        XCTAssertEqual(conversationStatus(try fold(READY, RUNNING, turnEnd("e1", .interrupted), READY)), .idle)
    }

    func testStatusStaysErrorAfterAFailedTurnUntilTheNextTurnStarts() throws {
        let failed = try fold(READY, RUNNING, turnEnd("e1", .failed), READY)
        XCTAssertTrue(lastTurnFailed(failed))
        XCTAssertEqual(conversationStatus(failed), .error)
        let next = try applyEvent(failed, RUNNING)
        XCTAssertEqual(conversationStatus(next), .working)
        let recovered = try applyEvents(next, [turnEnd("e2", .completed), READY])
        XCTAssertFalse(lastTurnFailed(recovered))
        XCTAssertEqual(conversationStatus(recovered), .idle)
    }

    func testATurnEndEntryAloneDoesNotEndTheTurn() throws {
        let ended = try fold(READY, RUNNING, turnEnd("e1", .completed))
        XCTAssertEqual(ended.state, .ready(turn: .running))
        XCTAssertEqual(conversationStatus(ended), .working)
    }

    func testBrokenIsErrorAndTheTranscriptStaysReadable() throws {
        let broken = try fold(
            READY, user("u1", "go"), RUNNING,
            .state(
                .broken(
                    ConversationFailure(code: .protocolMismatch, detail: "assistant.message.content: expected an array"))))
        XCTAssertEqual(conversationStatus(broken), .error)
        guard case .broken(let failure) = broken.state else { return XCTFail("not broken") }
        XCTAssertEqual(failure.code, .protocolMismatch)
        XCTAssertEqual(ids(broken.entries), ["u1"])
    }

    // MARK: tasks working in the background

    func testBackgroundTasksAreReplacedWholeOldestFirst() throws {
        let two = try fold(READY, tool("t1"), running(shell("b1", "t1"), shell("b2", nil)))
        XCTAssertEqual(two.backgroundTasks.map(\.id), ["b1", "b2"])
        XCTAssertEqual(try applyEvent(two, running(shell("b2", nil))).backgroundTasks.map(\.id), ["b2"])
    }

    func testBackgroundTasksRefuseATaskNamedTwiceOrAStrangeCall() throws {
        let t = try fold(READY, tool("t1"), user("u1", "go"))
        refused(t, running(shell("b1", "t1"), shell("b1", "t1")), "listed twice")
        refused(t, running(shell("b1", "t9")), "not an entry")
        refused(t, running(shell("b1", "u1")), "not a tool call")
    }

    func testBackgroundTasksRefuseARewindOrSwitchThatOrphansThem() throws {
        let t = try fold(READY, user("u1", "go"), tool("t1"), running(shell("b1", "t1")))
        refused(t, .rewound(from: "u1"), "still running")
        refused(t, .sessionSwitched(session: "s2"), "background task b1 is running")
        let ended = try applyEvent(t, running())
        XCTAssertEqual(try applyEvent(ended, .rewound(from: "u1")).entries, [])
    }

    // MARK: a CLI restarted on its session

    func testARestartKeepsEveryEntryAndNothingTheStoppedCLIHadGoingGoesOn() throws {
        let before = try fold(
            READY, user("u1", "go"), RUNNING, assistant("a1", [.text(markdown: "Look")], true), tool("t1"),
            tool("t2") {
                $0.status = .succeeded
                $0.spawns = SubagentInfo(label: "Explore", prompt: "look around", model: nil, state: .running, takesMessages: false)
            },
            tool("t3") {
                $0.status = .succeeded
                $0.background = BackgroundTask(state: .running, summary: nil)
            },
            tool("t4") { $0.status = .succeeded },
            .requestOpened(permission("p1", "t1")), running(shell("b1", "t3")),
            .sending([SendingMessage(id: "sent:2", text: "and", images: [], origin: .person)]))
        let after = try applyEvent(before, .restarted)
        XCTAssertEqual(ids(after.entries), ids(before.entries))
        XCTAssertEqual(after.requests, [])
        XCTAssertEqual(after.backgroundTasks, [])
        XCTAssertEqual(after.sending, [])
        XCTAssertEqual(try entry(after, "a1").assistantEntry?.streaming, false)
        XCTAssertEqual(try entry(after, "t1").toolEntry?.status, .interrupted)
        XCTAssertEqual(try entry(after, "t2").toolEntry?.status, .succeeded)
        XCTAssertEqual(try entry(after, "t2").toolEntry?.spawns?.state, .unknown)
        XCTAssertEqual(try entry(after, "t3").toolEntry?.background, BackgroundTask(state: .unknown, summary: nil))
        XCTAssertEqual(try entry(after, "t4"), try entry(before, "t4"))
        // What state the conversation is in is the adapter's to say.
        XCTAssertEqual(after.state, before.state)
    }

    // MARK: an Agent whose turn is over with tasks working in the background

    func testBackgroundIsNeitherIdleNorWorking() throws {
        let after = try fold(READY, RUNNING, tool("t1"), turnEnd("e1", .completed), READY, running(shell("b1", "t1")))
        XCTAssertEqual(conversationStatus(after), .background)
        XCTAssertEqual(conversationStatus(try applyEvent(after, running())), .idle)
    }

    func testBackgroundIsWorkingOrWaitingWhenSomethingElseIs() throws {
        let beside = try fold(READY, tool("t1"), running(shell("b1", "t1")))
        XCTAssertEqual(conversationStatus(try applyEvent(beside, RUNNING)), .working)
        XCTAssertEqual(conversationStatus(try applyEvent(beside, .requestOpened(permission("p1", "t1")))), .waiting)
        XCTAssertEqual(conversationStatus(try applyEvent(beside, .pending([held("held:1", "and then", editing: true)]))), .waiting)
    }

    func testBackgroundIsErrorAfterAFailedTurn() throws {
        let failed = try fold(READY, RUNNING, tool("t1"), turnEnd("e1", .failed), READY, running(shell("b1", "t1")))
        XCTAssertEqual(conversationStatus(failed), .error)
    }

    func testBackgroundActivityIsTheOneTaskOrHowMany() throws {
        let one = try fold(READY, tool("t1"), running(shell("b1", "t1")))
        XCTAssertEqual(conversationActivity(one), "run b1")
        let two = try applyEvent(one, running(shell("b1", "t1"), shell("b2", nil)))
        XCTAssertEqual(conversationActivity(two), "2 background tasks")
        // Mid-turn the activity is the turn's own.
        XCTAssertEqual(conversationActivity(try applyEvents(two, [RUNNING, tool("t2") { $0.title = "Edit: x" }])), "Edit: x")
    }

    // MARK: the activity of a turn

    func testActivityIsTheLatestRunningToolCallsTitle() throws {
        let busy = try fold(
            READY, RUNNING, tool("t1") { $0.title = "Bash: npm test" },
            tool("t1") {
                $0.title = "Bash: npm test"
                $0.status = .succeeded
            },
            tool("t2") {
                $0.tool = "Edit"
                $0.title = "Edit: src/x.ts"
            })
        XCTAssertEqual(conversationActivity(busy), "Edit: src/x.ts")
    }

    func testActivityIsTheInProgressStepOfTheLatestPlan() throws {
        let planning = try fold(
            READY, RUNNING,
            assistant(
                "a1",
                [
                    .plan(steps: [
                        PlanStep(text: "read the code", status: .completed),
                        PlanStep(text: "fix the fold", status: .inProgress),
                        PlanStep(text: "run the tests", status: .pending),
                    ])
                ], false))
        XCTAssertEqual(conversationActivity(planning), "fix the fold")
    }

    func testActivityIsNothingOutsideATurn() throws {
        XCTAssertNil(conversationActivity(try fold(READY, tool("t1"))))
        XCTAssertNil(conversationActivity(try fold(tool("t1"))))
    }

    func testActivityFromAPlanACallSet() throws {
        let t = try fold(
            RUNNING,
            tool("t1") {
                $0.status = .succeeded
                $0.plan = [PlanStep(text: "Read", status: .completed), PlanStep(text: "Fixing the bug", status: .inProgress)]
            })
        XCTAssertEqual(conversationActivity(t), "Fixing the bug")
    }

    // MARK: what the CLI says that DevHub does not know

    func testAnUnknownEventIsAWarningNoticeAndTheConversationCarriesOn() throws {
        let raw: JsonValue = ["type": "future_event", "payload": ["x": 1]]
        let noticed = try fold(
            READY, RUNNING, user("u1", "go"),
            .entry(.notice(NoticeEntry(id: "n1", level: .warning, text: "DevHub does not know the event future_event", raw: raw))))
        let n1 = try XCTUnwrap(try entry(noticed, "n1").noticeEntry)
        XCTAssertEqual(n1.level, .warning)
        XCTAssertEqual(n1.raw, raw)
        XCTAssertEqual(conversationStatus(noticed), .working)
        let continued = try applyEvent(noticed, assistant("a1", [.text(markdown: "ok")], false))
        XCTAssertEqual(ids(continued.entries), ["u1", "n1", "a1"])
    }

    func testAnUnknownEventCanComeFromInsideASubagent() throws {
        let noticed = try fold(
            tool("task1") { $0.tool = "Task" },
            .entry(.notice(NoticeEntry(id: "n1", parent: "task1", level: .warning, text: "unknown", raw: .null))))
        XCTAssertEqual(ids(childrenOf(noticed, "task1")), ["n1"])
    }

    // MARK: a rewind

    private func twoTurns() throws -> Transcript {
        try fold(
            .session(SessionFacts(canRewind: true)), READY, user("u1", "first"), RUNNING,
            assistant("a1", [.text(markdown: "one")], false), turnEnd("e1", .completed), READY, user("u2", "second"),
            RUNNING, tool("t1") { $0.status = .succeeded }, assistant("a2", [.text(markdown: "two")], false),
            turnEnd("e2", .completed), READY)
    }

    private let REWINDING = ConversationEvent.state(.ready(turn: .rewinding))

    func testARewindDropsTheMessageAndEverythingAfterIt() throws {
        let rewound = try applyEvents(try twoTurns(), [REWINDING, .rewound(from: "u2"), READY])
        XCTAssertEqual(ids(rewound.entries), ["u1", "a1", "e1"])
    }

    func testARewindIsRefusedForAnEntryThatIsNotATopLevelUserMessage() throws {
        refused(try twoTurns(), .rewound(from: "a2"), "a2 is a assistant entry, not a message the person sent")
        refused(try twoTurns(), .rewound(from: "nope"), "nope, which is not an entry")
    }

    func testARewindIsRefusedWhileARequestIsOpen() throws {
        let asking = try fold(READY, user("u1", "go"), RUNNING, tool("t1"), .requestOpened(permission("p1", "t1")))
        refused(asking, .rewound(from: "u1"), "while request p1 is open")
    }

    func testARewindReadsAsWorkingWhileUnderWay() throws {
        XCTAssertEqual(conversationStatus(try applyEvent(try twoTurns(), REWINDING)), .working)
    }

    func testRewindTargetsOnlyWhenTheSessionCanRewindAndNothingRunsWaitsOrIsHeld() throws {
        let t = try twoTurns()
        XCTAssertEqual(rewindTargets(t), ["u1", "u2"])
        var session = t.session
        session.canRewind = false
        XCTAssertTrue(rewindTargets(try applyEvent(t, .session(session))).isEmpty)
        XCTAssertTrue(rewindTargets(try applyEvent(t, RUNNING)).isEmpty)
        XCTAssertTrue(rewindTargets(try applyEvent(t, REWINDING)).isEmpty)
        XCTAssertTrue(rewindTargets(try applyEvent(t, .pending([held("held:1", "later")]))).isEmpty)
    }

    func testRewindTargetsSkipInjectionsAndMessagesTheCLICannotCutBefore() throws {
        let more = try applyEvents(
            try twoTurns(),
            [
                .entry(.user(UserEntry(id: "u3", text: "from a template", origin: .injection, rewindable: true))),
                .entry(.user(UserEntry(id: "u4", text: "steered into a turn", origin: .person, rewindable: false))),
            ])
        XCTAssertEqual(rewindTargets(more), ["u1", "u2"])
    }

    // MARK: a conversation a usage limit stopped

    private let LIMITED = LimitStop(resetsAt: 1_800_000_000_000)

    private func stopped() -> [ConversationEvent] {
        [READY, user("u1", "go"), RUNNING, turnEnd("t1", .failed, LIMITED), READY]
    }

    func testLimitStopStandsWhileTheTurnsEndIsTheLastThing() throws {
        let stop = limitStop(try applyEvents(EMPTY_TRANSCRIPT, stopped()))
        XCTAssertEqual(stop?.entry, "t1")
        XCTAssertEqual(stop?.resetsAt, LIMITED.resetsAt)
        // A turn that failed for any other reason is not a limit.
        XCTAssertNil(limitStop(try fold(READY, user("u1", "go"), RUNNING, turnEnd("t1", .failed), READY)))
    }

    func testLimitStopEndsOnceAnythingMovesItOn() throws {
        let moved: [(String, ConversationEvent)] = [
            ("the person's words", user("u2", "again")),
            ("a turn the Agent starts", RUNNING),
            ("a restart of its CLI", .entry(.notice(NoticeEntry(id: "n1", level: .info, text: "Session restarted")))),
            ("a message written and not taken", .sending([SendingMessage(id: "s1", text: "x", images: [], origin: .person)])),
            ("a message DevHub holds", .pending([held("held:1", "x", failure: "the host is gone")])),
            ("another session", .sessionSwitched(session: "other")),
        ]
        for (what, event) in moved {
            XCTAssertNil(limitStop(try applyEvents(EMPTY_TRANSCRIPT, stopped() + [event])), what)
        }
    }

    func testLimitResumeIsReplacedWholeAndDevHubsOwn() throws {
        let base = try applyEvents(EMPTY_TRANSCRIPT, stopped())
        let shown = try applyEvent(base, .limitResume(.scheduled(at: 5)))
        XCTAssertEqual(shown.limitResume, .scheduled(at: 5))
        XCTAssertEqual(limitStop(shown)?.entry, limitStop(base)?.entry)
        XCTAssertNil(try applyEvent(shown, .limitResume(nil)).limitResume)
    }

    func testUsedUpResetIsTheLatestOfSeveral() {
        XCTAssertEqual(
            usedUpReset([
                RateLimit(window: "5-hour", durationMinutes: 300, usedPercent: 100, resetsAt: 10),
                RateLimit(window: "7-day", durationMinutes: 10080, usedPercent: 100, resetsAt: 30),
                RateLimit(window: "other", durationMinutes: nil, usedPercent: 40, resetsAt: 50),
            ]), 30)
        XCTAssertNil(usedUpReset([RateLimit(window: "5-hour", durationMinutes: 300, usedPercent: 99, resetsAt: 10)]))
        XCTAssertNil(usedUpReset(nil))
    }

    // MARK: the messages DevHub holds

    func testHeldMessagesAreReplacedWholeAndStartEmpty() throws {
        XCTAssertEqual(EMPTY_TRANSCRIPT.pending, [])
        let messages = [held("held:1", "one"), held("held:2", "two", failure: "the host is gone")]
        let folded = try applyEvent(EMPTY_TRANSCRIPT, .pending(messages))
        XCTAssertEqual(folded.pending, messages)
        XCTAssertEqual(try applyEvent(folded, .pending(Array(messages.dropFirst()))).pending, Array(messages.dropFirst()))
    }

    // MARK: a replayed journal

    func testAReplayedJournalFoldsToTheSameTranscriptAsTheLiveEvents() throws {
        let events: [ConversationEvent] = [
            .session(SessionFacts(sessionId: "s1")), READY, user("u1", "run pwd"), RUNNING,
            assistant("a1", [.text(markdown: "")], true), delta("a1", 0, "Running "), delta("a1", 0, "it."),
            assistant("a1", [.text(markdown: "Running it.")], false), tool("t1"), .requestOpened(permission("p1", "t1")),
            .requestClosed("p1"),
            tool("t1") {
                $0.status = .succeeded
                $0.output = [.text("/w")]
            },
            turnEnd("e1", .completed), READY,
        ]
        var live = EMPTY_TRANSCRIPT
        for event in events { live = try applyEvent(live, event) }
        XCTAssertEqual(try applyEvents(EMPTY_TRANSCRIPT, events), live)
        XCTAssertEqual(conversationStatus(live), .idle)
        XCTAssertEqual(live.requests, [])
    }

    // MARK: attached images

    func testAttachedImagesAreTakenAsTheirOwnBytes() throws {
        let image = ImageRef(mediaType: "image/webp", source: .data(base64: "AAAA"), label: "a.webp")
        XCTAssertEqual(try attachedImages([image]), [image])
    }

    func testAttachedImagesAreRefusedNamingWhich() {
        XCTAssertThrowsError(
            try attachedImages([ImageRef(mediaType: "image/png", source: .file(path: "/etc/passwd"), label: "x")])
        ) { error in
            XCTAssertEqual(
                (error as? AttachedImageRefused)?.message,
                "attached image 0 is not a PNG, JPEG, GIF or WebP image's own bytes")
        }
        XCTAssertThrowsError(
            try attachedImages([ImageRef(mediaType: "image/svg+xml", source: .data(base64: "A"), label: "x")]))
    }
}

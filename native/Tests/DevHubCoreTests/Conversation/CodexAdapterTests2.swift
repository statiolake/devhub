// Port of apps/desktop/src/main/agent/conversation/codex/adapter.test.ts (2/4):
// subagents, multi-agent v1 and v2.

import XCTest
@testable import DevHubCore

private func spawnState(_ harness: CodexHarness, _ id: String) -> SubagentState? {
    harness.transcript.entries.first { $0.id.raw == id }?.toolEntry?.spawns?.state
}

final class CodexSubagentTests: XCTestCase {
    let spawn = "\(CODEX_MAIN)/item-spawn"

    func delegated(_ lines: [String]? = nil) throws -> (CodexHarness, [String]) {
        let harness = try codexReady()
        try harness.send("delegate")
        return (harness, lines ?? codexFixture("subagent.handwritten.ndjson").filter { !$0.contains(#""subAgentActivity""#) })
    }

    func childEnd(_ lines: [String]) -> Int {
        lines.firstIndex { $0.contains(#""turn/completed""#) && $0.contains("child-turn-1") }!
    }

    func testHangsASubagentsThreadUnderTheCallThatStartedIt() throws {
        let harness = try codexReady()
        try harness.send("delegate")
        var states: [String] = []
        for line in codexFixture("subagent.handwritten.ndjson") {
            try harness.receive(line)
            if let spawns = harness.transcript.entries.first(where: { $0.id.raw == spawn })?.toolEntry?.spawns {
                states.append("\(spawns.label)/\(spawns.state.rawValue)")
            }
        }
        XCTAssertEqual(
            codexOutline(harness.transcript),
            [
                #"tool spawnAgent "Start a subagent: List the files in src/" succeeded spawns explorer/completed"#,
                "  assistant: Listing.",
                #"  tool commandExecution "ls src" succeeded -> "main.ts\n""#,
                #"tool wait "Wait for subagents" succeeded"#,
                "assistant: src/ has main.ts.",
                "user(person): delegate",
                "turn-end completed 2100ms",
            ])
        let spawns = try harness.tool(spawn).spawns
        XCTAssertEqual(spawns?.prompt, "List the files in src/\nand report back.")
        XCTAssertEqual(spawns?.model, "gpt-5.5-mini")
        var seen: [String] = []
        for state in states where !seen.contains(state) { seen.append(state) }
        XCTAssertEqual(
            seen,
            [
                "subagent/running", "Explorer/running",
                // Its thread's turn ended; the activity item then names it again.
                "Explorer/completed", "explorer/completed",
            ])
        // A subagent's turn does not end the conversation's turn.
        XCTAssertEqual(try harness.entry("\(CODEX_CHILD)/child-say").parent, EntryId(spawn))
        // A message in the subagent's thread that DevHub did not send is its
        // parent Agent's, not the person's; one in the Agent's own thread
        // without DevHub's id is the person's, typed at Codex's terminal.
        func said(_ threadId: String, _ id: String) throws {
            try harness.receive(
                #"{"method":"item/completed","params":{"threadId":"\#(threadId)","turnId":"turn-x","completedAtMs":0,"item":{"type":"userMessage","id":"\#(id)","clientId":null,"content":[{"type":"text","text":"and lib/","text_elements":[]}]}}}"#
            )
        }
        try said(CODEX_CHILD, "child-told")
        try said(CODEX_MAIN, "main-told")
        XCTAssertEqual(try harness.user("\(CODEX_CHILD)/child-told").origin, .other)
        XCTAssertEqual(try harness.user("\(CODEX_MAIN)/main-told").origin, .person)
    }

    func testSaysASubagentIsDoneWhenItsThreadsTurnEndsAndRunningAgainWhenItStartsAnother() throws {
        let (harness, lines) = try delegated()
        let end = childEnd(lines)
        for line in lines[..<end] { try harness.receive(line) }
        XCTAssertEqual(spawnState(harness, spawn), .running)
        try harness.receive(lines[end])
        XCTAssertEqual(spawnState(harness, spawn), .completed)
        try harness.receive(
            lines[end].replacingOccurrences(of: #""turn/completed""#, with: #""turn/started""#)
                .replacingOccurrences(of: "child-turn-1", with: "child-turn-2")
                .replacingOccurrences(of: #""status":"completed""#, with: #""status":"inProgress""#))
        XCTAssertEqual(spawnState(harness, spawn), .running)
        try harness.receive(
            lines[end].replacingOccurrences(of: "child-turn-1", with: "child-turn-2")
                .replacingOccurrences(of: #""status":"completed""#, with: #""status":"failed""#))
        XCTAssertEqual(spawnState(harness, spawn), .failed)
    }

    func testListsASubagentWhileItsThreadRunsAsWorkingInTheBackgroundAndLetsItGoWhenThatEnds() throws {
        let (harness, lines) = try delegated()
        let end = childEnd(lines)
        for line in lines[..<end] { try harness.receive(line) }
        XCTAssertEqual(harness.transcript.backgroundTasks.count, 1)
        let task = harness.transcript.backgroundTasks[0]
        XCTAssertEqual(task.id, spawn)
        XCTAssertEqual(task.kind, "subagent")
        XCTAssertEqual(task.call, EntryId(spawn))
        // The spawn call's own start, as app-server's item/started said it.
        XCTAssertEqual(task.startedAt, 1_790_000_000_000)
        XCTAssertEqual(task.stoppable, .yes)
        try harness.receive(lines[end])
        XCTAssertEqual(harness.transcript.backgroundTasks, [])
    }

    // stopped from the background tasks

    func childStart(_ lines: [String]) -> Int {
        lines.firstIndex { $0.contains(#""turn/started""#) && $0.contains("child-turn-1") }!
    }

    func testCannotBeStoppedUntilAppServerHasSaidWhichTurnItRuns() throws {
        let (harness, lines) = try delegated()
        for line in lines[..<childStart(lines)] { try harness.receive(line) }
        XCTAssertEqual(harness.transcript.backgroundTasks.map(\.id), [spawn])
        XCTAssertEqual(
            harness.transcript.backgroundTasks[0].stoppable,
            .no(reason: "Codex has not yet said which turn this subagent is running, so there is nothing to interrupt."))
        assertThrowsMatching("cannot be stopped from DevHub") { _ = try harness.adapter.encode(.stopTask(task: self.spawn)) }
    }

    func testInterruptsTheTurnItsThreadRunsAndLeavesTheListOnlyWhenThatTurnEnds() throws {
        let (harness, lines) = try delegated()
        for line in lines[...childStart(lines)] { try harness.receive(line) }
        XCTAssertEqual(harness.transcript.backgroundTasks[0].stoppable, .yes)
        let from = harness.written.count
        try harness.command(.stopTask(task: spawn))
        let written = harness.writesSince(from)
        XCTAssertEqual(written.count, 1)
        XCTAssertEqual(written[0]["method"], "turn/interrupt")
        XCTAssertEqual(written[0]["params"], j(#"{"threadId":"\#(CODEX_CHILD)","turnId":"child-turn-1"}"#))
        try harness.receive(#"{"id":\#(written[0]["id"]!.jsonText),"result":{}}"#)
        // Not gone on DevHub's say-so: the turn has not ended yet.
        XCTAssertEqual(harness.transcript.backgroundTasks.map(\.id), [spawn])
        try harness.receive(
            #"{"method":"turn/completed","params":{"threadId":"\#(CODEX_CHILD)","turn":{"id":"child-turn-1","items":[],"itemsView":"notLoaded","status":"interrupted","error":null,"startedAt":1790000000,"completedAt":1790000002,"durationMs":500}}}"#
        )
        XCTAssertEqual(harness.transcript.backgroundTasks, [])
    }

    func testSaysSoWhenAppServerRefusesAndTheSubagentStaysListed() throws {
        let (harness, lines) = try delegated()
        for line in lines[...childStart(lines)] { try harness.receive(line) }
        let from = harness.written.count
        try harness.command(.stopTask(task: spawn))
        let id = harness.writesSince(from)[0]["id"]!.jsonText
        try harness.receive(#"{"id":\#(id),"error":{"code":-32600,"message":"no such turn"}}"#)
        let notice = harness.transcript.entries.last?.noticeEntry
        XCTAssertEqual(notice?.level, .error)
        XCTAssertTrue(notice?.text.hasSuffix("did not stop the subagent: no such turn") ?? false)
        XCTAssertEqual(harness.transcript.backgroundTasks.map(\.id), [spawn])
    }

    func testRefusesATaskThatIsNotRunning() throws {
        let (harness, _) = try delegated()
        assertThrowsMatching("nothing is not a background task running now") {
            _ = try harness.adapter.encode(.stopTask(task: "nothing"))
        }
    }

    func testTakesThePersonsMessagesWhenAppServerSaysItsThreadDoes() throws {
        let harness = try codexReady()
        try harness.send("delegate")
        let lines = codexFixture("subagent.handwritten.ndjson").map {
            // The fixture's child thread, as app-server prints one that takes direct input.
            $0.replacingOccurrences(
                of: #""parentThreadId":"00000000-0000-7000-8000-00000000000a","#,
                with: #""parentThreadId":"00000000-0000-7000-8000-00000000000a","canAcceptDirectInput":true,"#)
        }
        let childTurnStarted = lines.firstIndex { $0.contains(#""turn/started""#) && $0.contains(CODEX_CHILD) }!
        for line in lines[...childTurnStarted] { try harness.receive(line) }
        XCTAssertEqual(try harness.tool(spawn).spawns?.takesMessages, true)
        try harness.command(.instruct(subagent: EntryId(spawn), text: "look in lib/ too"))
        assertMatches(
            harness.lastWrite(),
            j(
                #"{"method":"turn/steer","params":{"threadId":"\#(CODEX_CHILD)","input":[{"type":"text","text":"look in lib/ too","text_elements":[]}],"expectedTurnId":"child-turn-1"}}"#
            ))
        for line in lines[(childTurnStarted + 1)...] { try harness.receive(line) }
        try harness.command(.instruct(subagent: EntryId(spawn), text: "now summarize"))
        assertMatches(
            harness.lastWrite(),
            j(
                #"{"method":"turn/start","params":{"threadId":"\#(CODEX_CHILD)","input":[{"type":"text","text":"now summarize","text_elements":[]}]}}"#
            ))
    }

    func testTakesNoneWhenAppServerDoesNotSayItsThreadDoes() throws {
        let harness = try codexReady()
        try harness.send("delegate")
        for line in codexFixture("subagent.handwritten.ndjson") { try harness.receive(line) }
        XCTAssertEqual(try harness.tool(spawn).spawns?.takesMessages, false)
        assertThrowsMatching("started no subagent thread that takes the person's messages") {
            try harness.command(.instruct(subagent: EntryId(self.spawn), text: "hello"))
        }
    }
}

/// A thread no call is known to have started.
final class CodexUnplacedThreadTests: XCTestCase {
    let stray = "00000000-0000-7000-8000-00000000000c"

    func said(_ phase: String, _ id: String, _ text: String) -> String {
        let at = phase == "started" ? "startedAtMs" : "completedAtMs"
        return #"{"method":"item/\#(phase)","params":{"threadId":"\#(stray)","turnId":"t","\#(at)":0,"item":{"type":"agentMessage","id":"\#(id)","text":"\#(text)","phase":null,"memoryCitation":null,"delivery":null,"questions":null}}}"#
    }

    func mainTurn(_ status: String) -> String {
        let method = status == "inProgress" ? "turn/started" : "turn/completed"
        return #"{"method":"\#(method)","params":{"threadId":"\#(CODEX_MAIN)","turn":{"id":"turn-2","items":[],"itemsView":"notLoaded","status":"\#(status)","error":null,"startedAt":1790000000,"completedAt":null,"durationMs":null}}}"#
    }

    func startedBy(_ call: String) -> String {
        #"{"method":"item/completed","params":{"threadId":"\#(CODEX_MAIN)","turnId":"turn-2","completedAtMs":0,"item":{"type":"subAgentActivity","id":"\#(call)","kind":"started","agentThreadId":"\#(stray)","agentPath":"/root/late"}}}"#
    }

    func testHoldsWhatItSaysAndSaysOnceWhenTheTurnEndsThatItIsNotShown() throws {
        let harness = try codexReady()
        try harness.receive(mainTurn("inProgress"))
        for n in 0..<100 {
            try harness.receive(said("started", "m\(n)", ""))
            try harness.receive(
                #"{"method":"item/agentMessage/delta","params":{"threadId":"\#(stray)","turnId":"t","itemId":"m\#(n)","delta":"hi"}}"#)
            try harness.receive(said("completed", "m\(n)", "hi"))
        }
        XCTAssertEqual(harness.transcript.entries, [])
        try harness.receive(mainTurn("completed"))
        try harness.receive(mainTurn("inProgress"))
        try harness.receive(said("completed", "later", "again"))
        try harness.receive(mainTurn("completed"))
        XCTAssertEqual(
            codexOutline(harness.transcript).filter { $0.hasPrefix("notice") },
            [
                "notice(warning): codex 0.156.1 ran subagent thread \(stray) but never said which call started it, so what that thread did is not shown."
            ])
    }

    func testDrawsWhatItHeldUnderTheCallOnceOneIsNamedInTheOrderItSaidIt() throws {
        let harness = try codexReady()
        try harness.receive(said("started", "first", ""))
        try harness.receive(said("completed", "first", "one"))
        try harness.receive(said("started", "second", ""))
        try harness.receive(said("completed", "second", "two"))
        try harness.receive(startedBy("call_late"))
        XCTAssertEqual(
            codexOutline(harness.transcript),
            [
                #"tool spawnAgent "Start a subagent: /root/late" succeeded spawns /root/late/running"#,
                "  assistant: one", "  assistant: two",
            ])
    }

    func testIsGivenUpOnceItSaysMoreThanDevHubKeeps() throws {
        let harness = try codexReady()
        for n in 0..<1005 { try harness.receive(said("completed", "m\(n)", "\(n)")) }
        try harness.receive(startedBy("call_late"))
        try harness.receive(said("started", "after", ""))
        try harness.receive(
            #"{"method":"item/agentMessage/delta","params":{"threadId":"\#(stray)","turnId":"t","itemId":"after","delta":"x"}}"#)
        try harness.receive(mainTurn("completed"))
        XCTAssertEqual(
            codexOutline(harness.transcript),
            [
                "notice(warning): codex 0.156.1 said more on subagent thread \(stray) than DevHub keeps before it knows which call started the thread, so what that thread did is not shown.",
                #"tool spawnAgent "Start a subagent: /root/late" succeeded spawns /root/late/unknown"#,
                "turn-end completed -ms",
            ])
        XCTAssertEqual(harness.transcript.backgroundTasks, [])
    }

    func testSaysOnceThatAppServerReportedOnItHoweverOftenItDoes() throws {
        let harness = try codexReady()
        for n in 0..<50 {
            try harness.receive(
                #"{"method":"item/completed","params":{"threadId":"\#(CODEX_MAIN)","turnId":"turn-2","completedAtMs":0,"item":{"type":"subAgentActivity","id":"subagent-completed-t\#(n)","kind":"completed","agentThreadId":"\#(stray)","agentPath":"/root/gone"}}}"#
            )
        }
        XCTAssertEqual(
            codexOutline(harness.transcript),
            ["notice(warning): codex 0.156.1 reported on subagent thread \(stray), which DevHub never saw started."])
        // The item is kept as the notice's raw, as the TS adapter keeps it.
        assertMatches(
            harness.transcript.entries[0].noticeEntry?.raw,
            j(#"{"type":"subAgentActivity","id":"subagent-completed-t0","kind":"completed","agentThreadId":"\#(stray)","agentPath":"/root/gone"}"#))
    }
}

/// Multi-agent v2, which codex-cli 0.158.0 runs: a spawn call is reported as
/// a `subAgentActivity` `started` item named by the call's id, with no
/// `collabAgentToolCall`, and the subagent's thread may have begun before it.
final class CodexMultiAgentV2Tests: XCTestCase {
    let a = "00000000-0000-7000-8000-00000000000b"
    let b = "00000000-0000-7000-8000-00000000000c"
    let spawnA = "\(CODEX_MAIN)/call_spawn_a"
    let spawnB = "\(CODEX_MAIN)/call_spawn_b"
    let v1 = "00000000-0000-7000-8000-00000000000d"

    func delegated(_ lines: [String]? = nil, _ each: (CodexHarness) throws -> Void = { _ in }) throws -> CodexHarness {
        let harness = try codexReady()
        try harness.send("delegate")
        for line in lines ?? codexFixture("subagent-v2.handwritten.ndjson") {
            try harness.receive(line)
            try each(harness)
        }
        return harness
    }

    func testDrawsEachSubagentsCardFromItsStartedActivity() throws {
        let harness = try delegated()
        XCTAssertEqual(
            codexOutline(harness.transcript),
            [
                #"tool spawnAgent "Start a subagent: /root/reader" succeeded spawns /root/reader/completed"#,
                "  assistant: Reading src.",
                #"  tool commandExecution "ls src" succeeded -> "main.ts\n""#,
                #"tool spawnAgent "Start a subagent: /root/tester" succeeded spawns /root/tester/failed"#,
                #"  tool commandExecution "make test" succeeded -> "ok\n""#,
                #"tool wait "Wait for subagents" succeeded"#,
                "assistant: src/ has main.ts; the tests could not finish.",
                "user(person): delegate",
                "turn-end completed 2100ms",
            ])
        XCTAssertEqual(try harness.entry("\(a)/a-say").parent, EntryId(spawnA))
    }

    func testFollowsEachSubagentFromRunningToDoneOrFailedAndListsItInTheBackgroundWhileItRuns() throws {
        var states: [String: [SubagentState]] = [:]
        var tasks: [String] = []
        _ = try delegated(nil) { harness in
            for spawn in [self.spawnA, self.spawnB] {
                guard let state = spawnState(harness, spawn) else { continue }
                var seen = states[spawn] ?? []
                if seen.last != state { seen.append(state) }
                states[spawn] = seen
            }
            let listed = harness.transcript.backgroundTasks.map(\.id).joined(separator: ",")
            if tasks.last != listed { tasks.append(listed) }
        }
        XCTAssertEqual(states[spawnA], [.running, .completed])
        XCTAssertEqual(states[spawnB], [.running, .failed])
        XCTAssertEqual(tasks, ["", spawnA, "\(spawnA),\(spawnB)", spawnB, ""])
    }

    func testStopsASubagentByInterruptingItsThreadsTurnAndTakesThePersonsWordsWhenItsThreadDoes() throws {
        let lines = codexFixture("subagent-v2.handwritten.ndjson").map {
            $0.replacingOccurrences(
                of: #""parentThreadId":"\#(CODEX_MAIN)","#,
                with: #""parentThreadId":"\#(CODEX_MAIN)","canAcceptDirectInput":true,"#)
        }
        let running = lines.firstIndex { $0.contains(#""turn/started""#) && $0.contains("child-b-1") }!
        let harness = try delegated(Array(lines[...running]))
        XCTAssertEqual(try harness.tool(spawnB).spawns?.takesMessages, true)
        XCTAssertEqual(try harness.tool(spawnB).spawns?.state, .running)
        XCTAssertEqual(harness.transcript.backgroundTasks.first { $0.id == spawnB }?.stoppable, .yes)
        let from = harness.written.count
        try harness.command(.stopTask(task: spawnB))
        let written = harness.writesSince(from)
        XCTAssertEqual(written.count, 1)
        XCTAssertEqual(written[0]["method"], "turn/interrupt")
        XCTAssertEqual(written[0]["params"], j(#"{"threadId":"\#(b)","turnId":"child-b-1"}"#))
        XCTAssertNotNil(written[0]["id"]?.numberValue)
        try harness.command(.instruct(subagent: EntryId(spawnA), text: "look in lib/ too"))
        assertMatches(
            harness.lastWrite(), j(#"{"method":"turn/steer","params":{"threadId":"\#(a)","expectedTurnId":"child-a-1"}}"#))
    }

    func testGivesManyParallelSubagentsACardEach() throws {
        let count = 40
        func thread(_ n: Int) -> String {
            let hex = String(0x100 + n, radix: 16)
            return "00000000-0000-7000-8000-\(String(repeating: "0", count: 12 - hex.count))\(hex)"
        }
        func item(_ threadId: String, _ phase: String, _ value: String) -> String {
            let at = phase == "started" ? "startedAtMs" : "completedAtMs"
            return #"{"method":"item/\#(phase)","params":{"threadId":"\#(threadId)","turnId":"\#(threadId == CODEX_MAIN ? "turn-2" : "child")","\#(at)":0,"item":\#(value)}}"#
        }
        func childTurn(_ threadId: String, _ status: String) -> String {
            let method = status == "inProgress" ? "turn/started" : "turn/completed"
            return #"{"method":"\#(method)","params":{"threadId":"\#(threadId)","turn":{"id":"child","items":[],"itemsView":"notLoaded","status":"\#(status)","error":null,"startedAt":1790000000,"completedAt":null,"durationMs":null}}}"#
        }
        func message(_ n: Int) -> String {
            #"{"type":"agentMessage","id":"say-\#(n)","text":"helper \#(n)","phase":null,"memoryCitation":null,"delivery":null,"questions":null}"#
        }
        func started(_ n: Int) -> String {
            #"{"type":"subAgentActivity","id":"call_\#(n)","kind":"started","agentThreadId":"\#(thread(n))","agentPath":"/root/helper_\#(n)"}"#
        }
        // Every thread starts and speaks; its call comes after its words for
        // an even thread, before them for an odd one.
        var lines: [String] = []
        for n in 0..<count {
            if n % 2 == 1 { lines += [item(CODEX_MAIN, "started", started(n)), item(CODEX_MAIN, "completed", started(n))] }
            lines += [childTurn(thread(n), "inProgress"), item(thread(n), "completed", message(n))]
        }
        for n in stride(from: 0, to: count, by: 2) {
            lines += [item(CODEX_MAIN, "started", started(n)), item(CODEX_MAIN, "completed", started(n))]
        }
        let harness = try delegated(lines)
        XCTAssertEqual(harness.transcript.backgroundTasks.count, count)
        for n in 0..<count { try harness.receive(childTurn(thread(n), "completed")) }
        XCTAssertEqual(harness.transcript.backgroundTasks, [])
        XCTAssertEqual(codexOutline(harness.transcript).filter { $0.contains("notice") }, [])
        for n in 0..<count {
            XCTAssertEqual(try harness.entry("\(thread(n))/say-\(n)").parent, EntryId("\(CODEX_MAIN)/call_\(n)"))
            let spawns = try harness.tool("\(CODEX_MAIN)/call_\(n)").spawns
            XCTAssertEqual(spawns?.label, "/root/helper_\(n)")
            XCTAssertEqual(spawns?.state, .completed)
        }
    }

    func testRebuildsTheSameTranscriptFromTheJournalsAndWritesNothing() throws {
        let live = try delegated()
        let replayed = try CodexHarness.replaying(live)
        XCTAssertEqual(replayed.written, [])
        XCTAssertEqual(replayed.transcript, live.transcript)
    }

    func testDrawsAResumedThreadsPastSubagentsFromItsHistoryNeverRunning() throws {
        let harness = CodexHarness(CodexAdapterOptions(clientVersion: "0.1.0", cwd: CODEX_CWD, resumeThreadId: CODEX_MAIN))
        try harness.start()
        let lines = codexFixture("handshake.handwritten.ndjson")
        try harness.receive(lines[0])
        try harness.receive(lines[1])
        func activity(_ id: String, _ kind: String, _ thread: String) -> String {
            #"{"type":"subAgentActivity","id":"\#(id)","kind":"\#(kind)","agentThreadId":"\#(thread)","agentPath":"\#(thread == a ? "/root/reader" : "/root/tester")"}"#
        }
        let turns = j(
            #"""
            [{"id":"old-turn","items":[
              \#(activity("call_spawn_a", "started", a)),
              \#(activity("call_ask_a", "interacted", a)),
              \#(activity("subagent-completed-old", "completed", a)),
              \#(activity("call_spawn_b", "started", b)),
              {"type":"collabAgentToolCall","id":"call_v1","tool":"spawnAgent","status":"completed","senderThreadId":"\#(CODEX_MAIN)","receiverThreadIds":["\#(v1)"],"prompt":"Look around.","model":null,"reasoningEffort":null,"agentsStates":{"\#(v1)":{"status":"running","message":null}}}],
             "itemsView":"full","status":"completed","error":null,"startedAt":null,"completedAt":null,"durationMs":10}]
            """#)
        try harness.receive(setting(j(lines[2]), ["result", "thread", "turns"], turns))
        XCTAssertEqual(
            codexOutline(harness.transcript),
            [
                #"tool spawnAgent "Start a subagent: /root/reader" succeeded spawns /root/reader/completed"#,
                #"tool sendMessage "Message a subagent: /root/reader" succeeded"#,
                #"tool spawnAgent "Start a subagent: /root/tester" succeeded spawns /root/tester/unknown"#,
                #"tool spawnAgent "Start a subagent: Look around." succeeded spawns subagent/unknown"#,
                "turn-end completed 10ms",
            ])
        XCTAssertEqual(harness.transcript.backgroundTasks, [])
    }

    func restarted() throws -> CodexHarness {
        let lines = codexFixture("subagent-v2.handwritten.ndjson")
        let running = lines.firstIndex { $0.contains(#""turn/started""#) && $0.contains("child-b-1") }!
        let harness = try delegated(Array(lines[...running]))
        XCTAssertEqual(harness.transcript.backgroundTasks.count, 2)
        try harness.receive(RESTART_MARK)
        return harness
    }

    func testOnceRestartedSaysOfEachRunningSubagentThatHowItStandsIsUnknownAndListsNone() throws {
        let harness = try restarted()
        XCTAssertEqual(try harness.tool(spawnA).spawns?.state, .unknown)
        XCTAssertEqual(try harness.tool(spawnB).spawns?.state, .unknown)
        XCTAssertEqual(harness.transcript.backgroundTasks, [])
    }

    func testOnceRestartedSaysTheSameWhenTheJournalIsReadBack() throws {
        let live = try restarted()
        let replayed = try CodexHarness.replaying(live)
        XCTAssertEqual(replayed.transcript.entries, live.transcript.entries)
        XCTAssertEqual(try replayed.tool(spawnA).spawns?.state, .unknown)
    }

    func testSaysASubagentFailedWhenItsThreadsTurnEndsFailedOrInterrupted() throws {
        for status in ["failed", "interrupted"] {
            let lines = codexFixture("subagent-v2.handwritten.ndjson").map { line in
                line.contains(#""turn/completed""#) && line.contains("child-a-1")
                    ? line.replacingOccurrences(of: #""status":"completed""#, with: #""status":"\#(status)""#) : line
            }
            let harness = try delegated(lines.filter { !$0.contains("subagent-completed") })
            XCTAssertEqual(try harness.tool(spawnA).spawns?.state, .failed, status)
        }
    }
}

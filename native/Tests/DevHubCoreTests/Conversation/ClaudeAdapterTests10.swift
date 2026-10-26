// Port of apps/desktop/src/main/agent/conversation/claude/adapter.test.ts (10/12)

import XCTest
@testable import DevHubCore

/// The CLI's whole list of background tasks, as `background_tasks_changed` prints it.
private func listed(_ tasks: (String, String, String)...) -> String {
    system(
        "background_tasks_changed",
        [
            "uuid": .string("u-\(tasks.count)"),
            "tasks": .array(
                tasks.map { id, type, description in
                    ["task_id": .string(id), "task_type": .string(type), "description": .string(description)]
                }),
        ])
}

/// A turn that ran `npm run dev` in the background (task b1) and ended.
private func serverLeftRunning() throws -> ClaudeAdapter {
    let adapter = try inTurn()
    _ = try adapter.received(
        assistantLine(
            "m",
            [
                toolUse(
                    "toolu_bg", "Bash",
                    ["command": "npm run dev", "description": "Start the dev server", "run_in_background": true])
            ]))
    // The CLI prints the list before the task's own start, which names the call.
    _ = try adapter.received(listed(("b1", "local_bash", "Start the dev server")))
    _ = try adapter.received(
        system(
            "task_started",
            [
                "task_id": "b1", "tool_use_id": "toolu_bg", "task_type": "local_bash", "description": "Start the dev server",
                "is_backgrounded": true,
            ]))
    _ = try adapter.received(result())
    return adapter
}

final class ClaudeBackgroundTests: XCTestCase {
    func testIsTheCLIsOwnListEachTaskTiedToItsCallOnceATaskEventNamesIt() throws {
        let adapter = try inTurn()
        _ = try adapter.received(
            assistantLine(
                "m", [toolUse("toolu_bg", "Bash", ["command": "npm run dev", "run_in_background": true])], nil,
                ["timestamp": "2026-09-20T10:00:00.500Z"]))
        _ = try adapter.received(listed(("b1", "local_bash", "Start the dev server")))
        XCTAssertEqual(
            adapter.transcript.backgroundTasks,
            [RunningTask(id: "b1", kind: "shell", title: "Start the dev server", call: nil, startedAt: nil, stoppable: .yes)])
        _ = try adapter.received(
            system(
                "task_started",
                ["task_id": "b1", "tool_use_id": "toolu_bg", "task_type": "local_bash", "description": "Start the dev server"]))
        XCTAssertEqual(
            adapter.transcript.backgroundTasks,
            [
                RunningTask(
                    id: "b1", kind: "shell", title: "Start the dev server", call: "tool:toolu_bg", startedAt: 1_789_898_400_500,
                    stoppable: .yes)
            ])
    }

    func testStartsAtTheSameTimeInAReplayWheneverTheReplayRuns() throws {
        func playing(_ now: Double) throws -> [RunningTask] {
            let adapter = ClaudeAdapter(bootId: "boot", now: { now })
            _ = try adapter.received(initLine())
            try carryOut(adapter, send("go"))
            _ = try adapter.received(echo("go", "u-go"))
            _ = try adapter.received(
                assistantLine(
                    "m", [toolUse("toolu_bg", "Bash", ["command": "sleep 99"])], nil, ["timestamp": "2026-09-20T10:00:00.000Z"]))
            _ = try adapter.received(listed(("b1", "local_bash", "sleep")))
            _ = try adapter.received(system("task_started", ["task_id": "b1", "tool_use_id": "toolu_bg"]))
            return adapter.transcript.backgroundTasks
        }
        let live = try playing(1_000)
        XCTAssertEqual(try playing(1_790_000_000_000), live)
        XCTAssertEqual(live.first?.startedAt, 1_789_898_400_000)
    }

    func testHasNoStartWhenTheCLIWroteNoTimeAndRefusesATimeThatIsNotOne() throws {
        let adapter = try inTurn()
        _ = try adapter.received(
            assistantLine("m", [toolUse("toolu_bg", "Bash", ["command": "npm run dev", "run_in_background": true])]))
        _ = try adapter.received(listed(("b1", "local_bash", "Start the dev server")))
        _ = try adapter.received(system("task_started", ["task_id": "b1", "tool_use_id": "toolu_bg"]))
        XCTAssertNil(adapter.transcript.backgroundTasks.first?.startedAt)
        assertThrows(try adapter.received(assistantLine("m2", [], nil, ["timestamp": "yesterday-ish"])), #"assistant\.timestamp"#)
    }

    func testKeepsAnAgentWhoseTurnEndedWithATaskStillWorkingOutOfIdle() throws {
        let adapter = try serverLeftRunning()
        XCTAssertEqual(conversationStatus(adapter.transcript), .background)
        _ = try adapter.received(listed())
        XCTAssertEqual(adapter.transcript.backgroundTasks, [])
        XCTAssertEqual(conversationStatus(adapter.transcript), .idle)
    }

    func testNamesASubagentsTaskAsASubagentAndAnyOtherKindByTheCLIsOwnName() throws {
        let adapter = try inTurn()
        _ = try adapter.received(listed(("a1", "local_agent", "Research the parser"), ("w1", "local_workflow", "Nightly checks")))
        XCTAssertEqual(adapter.transcript.backgroundTasks.map { [$0.id, $0.kind] }, [["a1", "subagent"], ["w1", "local_workflow"]])
    }

    func testCountsATeammateAtWorkAndNotOneThatSitsIdle() throws {
        let adapter = try inTurn()
        _ = try adapter.received(
            assistantLine("m", [toolUse("toolu_tm", "Agent", ["description": "research", "prompt": "look into it"])]))
        _ = try adapter.received(
            withFields(
                toolResult("toolu_tm", "Spawned successfully."),
                ["tool_use_result": ["status": "teammate_spawned", "name": "researcher", "teammate_id": "researcher@team"]]))
        _ = try adapter.received(result())
        XCTAssertEqual(
            adapter.transcript.backgroundTasks,
            [
                RunningTask(
                    id: "teammate:researcher", kind: "teammate", title: "research", call: "tool:toolu_tm", startedAt: nil,
                    // `stop_task` is documented for the CLI's own tasks, not teammates.
                    stoppable: .no(reason: "A teammate can't be stopped from here."))
            ])
        assertThrows(try adapter.encode(.stopTask(task: "teammate:researcher")), "cannot be stopped from DevHub")
        XCTAssertEqual(conversationStatus(adapter.transcript), .background)
        let idle = json(["type": "idle_notification", "from": "researcher", "idleReason": "available", "timestamp": "t"])
        _ = try adapter.received(
            echo("<teammate-message teammate_id=\"researcher\" color=\"blue\" summary=\"idle\">\n\(idle)\n</teammate-message>", "u-idle"))
        XCTAssertEqual(adapter.transcript.backgroundTasks, [])
        XCTAssertEqual(conversationStatus(adapter.transcript), .idle)
    }

    func testEndsWithTheCLIThatRanItWhenTheConversationIsTakenBackPastItsCall() throws {
        let adapter = ClaudeAdapter(bootId: "boot")
        _ = try adapter.received(initLine(["claude_code_version": "2.1.282"]))
        try carryOut(adapter, send("go"))
        _ = try adapter.received(echo("go", "u-go"))
        _ = try adapter.received(
            assistantLine(
                "m", [toolUse("toolu_bg", "Bash", ["command": "npm run dev", "run_in_background": true])], nil, ["uuid": "a1"]))
        _ = try adapter.received(listed(("b1", "local_bash", "dev server")))
        _ = try adapter.received(system("task_started", ["task_id": "b1", "tool_use_id": "toolu_bg"]))
        _ = try adapter.received(result())
        guard case .restart(let plan) = try adapter.rewind("user:u-go") else { return XCTFail("not a restart") }
        _ = try adapter.received(plan.mark[0])
        XCTAssertEqual(adapter.transcript.backgroundTasks, [])
        XCTAssertEqual(adapter.transcript.entries, [])
    }

    func testStopsATaskWithItsStopTaskRequestAndLetsItGoOnlyWhenTheCLISaysItStopped() throws {
        let adapter = try serverLeftRunning()
        let written = parsed(try carryOut(adapter, .stopTask(task: "b1")))[0]
        XCTAssertEqual(written["type"], "control_request")
        XCTAssertEqual(written["request"], ["subtype": "stop_task", "task_id": "b1"])
        _ = try adapter.received(controlResponse(try XCTUnwrap(written["request_id"]?.stringValue), [:]))
        // Asked, not done: the task is listed until the CLI says otherwise.
        XCTAssertEqual(adapter.transcript.backgroundTasks.map(\.id), ["b1"])
        _ = try adapter.received(
            system("task_notification", ["task_id": "b1", "status": "stopped", "summary": "Start the dev server"]))
        _ = try adapter.received(listed())
        XCTAssertEqual(adapter.transcript.backgroundTasks, [])
        XCTAssertEqual(try toolOf(adapter, "tool:toolu_bg").background?.state, .failed)
    }

    func testSaysSoWhenTheCLIRefusesToStopATaskAndKeepsItListed() throws {
        let adapter = try serverLeftRunning()
        let written = parsed(try carryOut(adapter, .stopTask(task: "b1")))[0]
        _ = try adapter.received(
            controlResponse(try XCTUnwrap(written["request_id"]?.stringValue), error: "No task found with ID: b1"))
        let notice = try XCTUnwrap(adapter.transcript.entries.last?.noticeEntry)
        XCTAssertEqual(notice.level, .error)
        XCTAssertEqual(notice.text, "stop_task was refused: No task found with ID: b1")
        XCTAssertEqual(adapter.transcript.backgroundTasks.map(\.id), ["b1"])
    }

    func testRefusesToStopATaskThatIsNotRunning() throws {
        assertThrows(try (try serverLeftRunning()).encode(.stopTask(task: "b9")), "b9 is not a background task running now")
    }

    func testBreaksTheConversationForAListWhoseTaskDoesNotSayItsKind() throws {
        let adapter = try inTurn()
        XCTAssertThrowsError(
            try adapter.received(system("background_tasks_changed", ["tasks": [["task_id": "b1", "description": "x"]]]))
        ) { XCTAssertTrue($0 is ProtocolMismatch) }
    }
}

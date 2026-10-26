// Ports of apps/desktop/src/main/agent/conversation/{toolTitle,claude/argv,
// claude/promptCache}.test.ts, and of the argv and session-file cases of
// resume.test.ts (the rest of resume.test.ts is WP6's).

import XCTest
@testable import DevHubCore

final class ToolTitleTests: XCTestCase {
    func testNamesEachWellKnownToolByWhatItDoes() {
        let cases: [(String, JsonObject, String)] = [
            ("Bash", ["command": "npm test\n--watch"], "Bash: npm test"),
            ("Edit", ["file_path": "src/x.ts", "old_string": "a"], "Edit: src/x.ts"),
            ("SendMessage", ["to": "researcher", "message": "hi", "summary": "status"], "SendMessage: researcher — status"),
            ("SendMessage", ["recipient": "lead", "content": "done"], "SendMessage: lead"),
            ("Monitor", ["command": "tail -f log", "description": "watch the log"], "Monitor: watch the log"),
            ("TaskStop", ["task_id": "b7"], "TaskStop: b7"),
            ("ToolSearch", ["query": "select:Read", "max_results": 1], "ToolSearch: select:Read"),
            ("TaskCreate", ["subject": "Write the docs", "description": "all of them"], "TaskCreate: Write the docs"),
            ("TaskUpdate", ["taskId": "3", "status": "completed"], "TaskUpdate: 3 → completed"),
            ("TaskOutput", ["task_id": "b7", "block": true], "TaskOutput: b7"),
            ("AskUserQuestion", ["questions": [["question": "Which one?"]]], "AskUserQuestion: Which one?"),
            ("ListAgents", [:], "ListAgents"),
        ]
        for (name, input, title) in cases { XCTAssertEqual(toolTitle(name, input), title, name) }
    }

    func testNamesAnMCPToolByItsServerAndToolAndItsMostTellingArgument() {
        XCTAssertEqual(
            toolTitle("mcp__claude-in-chrome__computer", ["action": "screenshot", "tabId": 3]),
            "claude-in-chrome · computer: screenshot")
        XCTAssertEqual(
            toolTitle("mcp__playwright__browser_navigate", ["url": "https://example.com"]),
            "playwright · browser_navigate: https://example.com")
        XCTAssertEqual(toolTitle("mcp__srv__ping", ["tabId": 3]), "srv · ping")
    }

    func testFallsBackToTheMostTellingArgumentElseTheFirstWordedOne() {
        XCTAssertEqual(toolTitle("Frobnicate", ["level": 3, "path": "a/b"]), "Frobnicate: a/b")
        XCTAssertEqual(toolTitle("Frobnicate", ["level": 3, "flavour": "mint"]), "Frobnicate: mint")
        XCTAssertEqual(toolTitle("Frobnicate", ["level": 3]), "Frobnicate")
    }

    func testATodoWriteCallsTitleSaysHowFarThePlanHasCome() {
        XCTAssertEqual(
            toolTitle("TodoWrite", ["todos": [["content": "a", "status": "completed"], ["content": "b", "status": "pending"]]]),
            "TodoWrite: 1 of 2 done")
    }
}

final class ClaudeArgvTests: XCTestCase {
    let profile = CLICommand(file: "claude", args: ["--permission-mode", "acceptEdits"], env: ["EXAMPLE": "1"])

    func testKeepsTheProfilesCommandArgumentsAndEnvironmentFollowedByTheStreamJSONFlags() {
        XCTAssertEqual(
            claudeStructuredCommand(profile),
            CLICommand(
                file: "claude",
                args: [
                    "--permission-mode", "acceptEdits", "-p", "--input-format", "stream-json", "--output-format",
                    "stream-json", "--verbose", "--include-partial-messages", "--forward-subagent-text",
                    "--replay-user-messages", "--permission-prompt-tool", "stdio",
                ], env: ["EXAMPLE": "1"]))
    }

    func testNeverSignsInWithAnAPIKeyAlone() {
        XCTAssertFalse(claudeStructuredCommand(profile).args.contains("--bare"))
    }
}

private func sample(
    inputTokens: Double = 10, outputTokens: Double = 100, cacheWriteTokens: Double = 0, cacheReadTokens: Double = 0,
    write5mTokens: Double? = nil, write1hTokens: Double? = nil
) -> CacheSample {
    CacheSample(
        inputTokens: inputTokens, outputTokens: outputTokens, cacheWriteTokens: cacheWriteTokens,
        cacheReadTokens: cacheReadTokens, write5mTokens: write5mTokens, write1hTokens: write1hTokens)
}

final class PromptCacheTrackerTests: XCTestCase {
    func testSaysNothingBeforeAResponse() {
        XCTAssertNil(PromptCacheTracker().state())
    }

    func testTakesTheTTLFromTheWritesSplitAndExpiresThatLongAfter() {
        var tracker = PromptCacheTracker()
        let state = tracker.record(sample(cacheWriteTokens: 20_000, write1hTokens: 20_000), at: 1_000)
        XCTAssertEqual(state.ttlSeconds, 3600)
        XCTAssertTrue(state.ttlKnown)
        XCTAssertEqual(state.expiresAt, 1_000 + 3_600_000)
        XCTAssertEqual(state.requests, 1)
        XCTAssertEqual(state.misses, 0)
        XCTAssertEqual(state.recacheTokens, 20_110)
        XCTAssertEqual(state.hitRatio ?? -1, 0, accuracy: 0.005)
    }

    func testAssumesFiveMinutesUntilAWriteSaysAndKeepsATTLAcrossReads() {
        var tracker = PromptCacheTracker()
        let first = tracker.record(sample(cacheReadTokens: 5000), at: 0)
        XCTAssertEqual(first.ttlSeconds, 300)
        XCTAssertFalse(first.ttlKnown)
        XCTAssertEqual(first.expiresAt, 300_000)
        tracker.record(sample(cacheWriteTokens: 100, write1hTokens: 100), at: 10)
        let later = tracker.record(sample(cacheReadTokens: 5300), at: 20)
        XCTAssertEqual(later.ttlSeconds, 3600)
        XCTAssertTrue(later.ttlKnown)
        XCTAssertEqual(later.expiresAt, 3_600_020)
    }

    func testIsColdWhenTheLastResponseReportedNoCacheTokens() {
        var tracker = PromptCacheTracker()
        tracker.record(sample(cacheWriteTokens: 1000), at: 0)
        XCTAssertNil(tracker.record(sample(), at: 1).expiresAt)
    }

    func testCountsAWarmPrefixWrittenAgainAsAMissACompactionsRebuildNot() {
        var tracker = PromptCacheTracker()
        tracker.record(sample(cacheWriteTokens: 50_000), at: 0)
        // Read what was cached: a hit.
        XCTAssertEqual(tracker.record(sample(cacheWriteTokens: 200, cacheReadTokens: 50_000), at: 1000).misses, 0)
        // Wrote it all again while warm: a miss.
        XCTAssertEqual(tracker.record(sample(cacheWriteTokens: 50_500), at: 2000).misses, 1)
        tracker.compacted()
        XCTAssertEqual(tracker.record(sample(cacheWriteTokens: 9000), at: 3000).misses, 1)
        // Cold by then: a rebuild is expected, not a miss.
        XCTAssertEqual(tracker.record(sample(cacheWriteTokens: 9500), at: 3000 + 400_000).misses, 1)
    }

    func testDividesReadsByEveryInputToken() {
        var tracker = PromptCacheTracker()
        tracker.record(sample(inputTokens: 0, cacheWriteTokens: 1000), at: 0)
        let state = tracker.record(sample(inputTokens: 0, cacheReadTokens: 3000), at: 1)
        XCTAssertEqual(state.hitRatio ?? -1, 0.75, accuracy: 0.005)
    }
}

final class SessionArgsTests: XCTestCase {
    func testIsTheTerminalModesArgumentsAndReadsBackFromTheEndOfAnArgv() {
        XCTAssertEqual(resumeArgs(.claude, "s1"), ["--resume", "s1"])
        XCTAssertEqual(resumeArgs(.codex, "t1"), ["resume", "t1"])
        XCTAssertEqual(resumedSession(.claude, ["--model", "x", "--resume", "s1"]), "s1")
        XCTAssertEqual(resumedSession(.codex, ["-c", "a=b", "resume", "t1"]), "t1")
        XCTAssertNil(resumedSession(.claude, ["--model", "x"]))
        XCTAssertNil(resumedSession(.codex, ["--resume", "t1"]))
    }

    func testBecomesThreadResumeForCodexsAppServer() {
        let resumed = codexStructuredArgs(["-c", "a=b", "resume", "t1"])
        XCTAssertEqual(resumed.args, ["-c", "a=b", "app-server"])
        XCTAssertEqual(resumed.resumeThreadId, "t1")
        let fresh = codexStructuredArgs(["-c", "a=b"])
        XCTAssertEqual(fresh.args, ["-c", "a=b", "app-server"])
        XCTAssertNil(fresh.resumeThreadId)
    }

    func testReplacesEveryArgumentThatPicksASession() {
        XCTAssertEqual(
            withSession(.claude, ["--model", "x", "--resume", "old", "--verbose"], ["--resume", "new"]),
            ["--model", "x", "--verbose", "--resume", "new"])
        XCTAssertEqual(
            withSession(
                .claude,
                [
                    "--continue", "-r", "a", "--resume=b", "--resume-session-at", "m1", "--resume-session-at=m2",
                    "--resume-drops-turn", "-c", "--model", "x",
                ], ["--resume", "s", "--resume-session-at", "m3"]),
            ["--model", "x", "--resume", "s", "--resume-session-at", "m3"])
        XCTAssertEqual(withSession(.codex, ["-c", "a=b", "resume", "old"], ["resume", "new"]), ["-c", "a=b", "resume", "new"])
        XCTAssertEqual(withSession(.codex, ["resume", "--last", "-m", "x"], ["resume", "t"]), ["-m", "x", "resume", "t"])
    }

    func testStartsANewSessionWhenNothingPicksOne() {
        XCTAssertEqual(withSession(.claude, ["--resume", "old", "--model", "x"], []), ["--model", "x"])
    }

    func testIsWhatALaunchResumingASessionRuns() {
        let args = withSession(.claude, ["--resume", "old"], resumeArgs(.claude, "new"))
        XCTAssertEqual(args, ["--resume", "new"])
        XCTAssertEqual(resumedSession(.claude, args), "new")
    }
}

final class ClaudeHistoryLinesTests: XCTestCase {
    let SESSION_A = "00000000-0000-4000-8000-00000000000a"

    func uuids(_ lines: [String]) -> [String] {
        lines.map { line in
            let record = (try? JsonValue.parse(line))?["record"]
            return record?["uuid"]?.stringValue ?? record?["type"]?.stringValue ?? "?"
        }
    }

    func line(_ fields: JsonObject) -> String {
        json(.object(merged(["type": "user", "message": ["role": "user", "content": "x"]], fields)))
    }

    func testIsTheChainFromTheLastMessageBackAcrossACompaction() throws {
        let lines = try claudeHistoryLines(session: SESSION_A, text: Fixtures.text("conversation", "claude-session-file.handwritten.jsonl"))
        // Not the meta caveat (u1), the rewound branch (u4, a4), the subagent
        // (s1), the CLI's note to the model (t1) or the summary (u5); the
        // boundary (c1) is the compaction, which is drawn.
        XCTAssertEqual(uuids(lines), ["u2", "a1", "a2", "u3", "a3", "c1", "u6", "a5"])
        XCTAssertEqual(
            try JsonValue.parse(lines[0]),
            [
                "type": "devhub_history",
                "record": ["type": "user", "uuid": "u2", "message": ["role": "user", "content": "List the files in src"]],
            ])
    }

    func testGoesUpTheFilePastARecordClaudeWroteTwiceUnderOneUuid() throws {
        let lines = try claudeHistoryLines(
            session: SESSION_A, text: Fixtures.text("conversation", "claude-session-rewritten-uuid.handwritten.jsonl"))
        XCTAssertEqual(uuids(lines), ["u1", "a1", "c1", "u6", "a6"])
    }

    func testFollowsAParentWrittenOnlyAfterItsChild() throws {
        let lines = try claudeHistoryLines(
            session: SESSION_A,
            text: [
                line(["uuid": "u1", "parentUuid": .null]), line(["uuid": "u3", "parentUuid": "u2"]),
                line(["uuid": "u2", "parentUuid": "u1"]), line(["uuid": "u4", "parentUuid": "u3"]),
            ].joined(separator: "\n"))
        XCTAssertEqual(uuids(lines), ["u1", "u2", "u3", "u4"])
    }

    func testGoesOnAcrossACompactionWhoseLogicalParentWasWrittenAfterIt() throws {
        let lines = try claudeHistoryLines(
            session: SESSION_A, text: Fixtures.text("conversation", "claude-session-logical-parent-after.handwritten.jsonl"))
        XCTAssertEqual(uuids(lines), ["u1", "a1", "q1", "c1", "attachment", "u6", "a6"])
    }

    func testGoesOnAcrossACompactionWhoseLogicalParentIsNotInTheFile() throws {
        let lines = try claudeHistoryLines(
            session: SESSION_A,
            text: [
                line(["uuid": "u1", "parentUuid": .null]), line(["uuid": "u2", "parentUuid": "u1"]),
                json([
                    "type": "system", "subtype": "compact_boundary", "uuid": "c1", "parentUuid": .null,
                    "logicalParentUuid": "gone",
                ]),
                line(["uuid": "u3", "parentUuid": "c1"]),
            ].joined(separator: "\n"))
        XCTAssertEqual(uuids(lines), ["u1", "u2", "c1", "u3"])
    }

    func testReadsEveryRecordOfAChainThatLoopsBackOnce() throws {
        let lines = try claudeHistoryLines(
            session: SESSION_A,
            text: [
                line(["uuid": "u1", "parentUuid": "u3"]), line(["uuid": "u2", "parentUuid": "u1"]),
                line(["uuid": "u3", "parentUuid": "u2"]), line(["uuid": "u4", "parentUuid": "u3"]),
            ].joined(separator: "\n"))
        XCTAssertEqual(uuids(lines), ["u1", "u2", "u3", "u4"])
    }

    func testRefusesAFileThatIsNotJSONLines() {
        assertThrows(try claudeHistoryLines(session: SESSION_A, text: "{}\nnot json\n"), "not a JSON object")
    }
}

// Port of subagentColumn.test.ts, activity.test.tsx and the reading halves of
// freshEntries / StatusMark / ContextUsage / BackgroundTasks / FindBar /
// EntryParts tests.

import XCTest
@testable import DevHubCore

final class SubagentColumnTests: XCTestCase {
    let a = EntryId("a"), b = EntryId("b"), c = EntryId("c")

    func testWidth() {
        XCTAssertEqual(SubagentColumn.clampWidth(500, across: 1200), 500)
        XCTAssertEqual(SubagentColumn.clampWidth(100, across: 1200), SubagentColumn.minColumn)
        XCTAssertEqual(SubagentColumn.clampWidth(1100, across: 1200), 1200 - SubagentColumn.minConversation)
        let dragged = SubagentColumn().withWidth(450, across: 1200)
        XCTAssertEqual(dragged.width, 450)
        XCTAssertNil(dragged.withDefaultWidth().width)
    }

    var open: [SubagentColumn.MeasuredPane] { [.init(id: a, height: 300), .init(id: b, height: 300), .init(id: c, height: 200)] }

    func testASashTradesHeight() throws {
        let moved = try SubagentColumn().withSashMoved(open, above: 0, below: 1, delta: 100)
        XCTAssertEqual(moved.weight(of: a), 400)
        XCTAssertEqual(moved.weight(of: b), 200)
        XCTAssertEqual(moved.weight(of: c), 200)
        let down = try SubagentColumn().withSashMoved(open, above: 0, below: 1, delta: 1000)
        XCTAssertEqual(down.weight(of: a), 600 - SubagentColumn.minPane)
        XCTAssertEqual(down.weight(of: b), SubagentColumn.minPane)
        let up = try SubagentColumn().withSashMoved(open, above: 0, below: 1, delta: -1000)
        XCTAssertEqual(up.weight(of: a), SubagentColumn.minPane)
        let cramped: [SubagentColumn.MeasuredPane] = [.init(id: a, height: 90), .init(id: b, height: 90)]
        XCTAssertEqual(try SubagentColumn().withSashMoved(cramped, above: 0, below: 1, delta: 20), SubagentColumn())
        XCTAssertEqual(moved.weight(of: EntryId("later")), 800.0 / 3, accuracy: 0.001)
        XCTAssertEqual(moved.withEqualHeights().weight(of: a), 1)
        XCTAssertThrowsError(try SubagentColumn().withSashMoved(open, above: 1, below: 1, delta: 10))
        XCTAssertThrowsError(try SubagentColumn().withSashMoved(open, above: 2, below: 3, delta: 10))
    }

    func testFolds() {
        let folded = SubagentColumn().withFold(b, true)
        XCTAssertTrue(folded.folded.contains(b))
        XCTAssertFalse(folded.withFold(b, false).folded.contains(b))
        XCTAssertEqual(SubagentColumn.sashes([true, true, true]), [.init(before: 1, above: 0, below: 1), .init(before: 2, above: 1, below: 2)])
        XCTAssertEqual(SubagentColumn.sashes([true, false, true]), [.init(before: 2, above: 0, below: 1)])
        XCTAssertEqual(SubagentColumn.sashes([false, true, false]), [])
        XCTAssertEqual(SubagentColumn.sashes([true]), [])
    }

    func testAPaneThatLeaves() throws {
        let panes: [SubagentColumn.MeasuredPane] = [.init(id: a, height: 300), .init(id: b, height: 100), .init(id: c, height: 200)]
        let laidOut = try SubagentColumn().withSashMoved(panes, above: 0, below: 1, delta: 0).withWidth(450, across: 1200).withFold(c, true)
        let left = laidOut.withPanes(of: [a, b])
        XCTAssertEqual(left.weights, [a: 300, b: 100])
        XCTAssertTrue(left.folded.isEmpty)
        XCTAssertEqual(left.width, 450)
        XCTAssertEqual(left.weight(of: c), 200)
        let foldedA = SubagentColumn().withFold(a, true)
        XCTAssertEqual(foldedA.withPanes(of: [a, b]), foldedA)
    }

    func testPlacement() {
        typealias F = TranscriptFixtures
        let running = SubagentInfo(label: "Explore", prompt: "p", model: nil, state: .running, takesMessages: false)
        let done = SubagentInfo(label: "Done", prompt: "p", model: nil, state: .completed, takesMessages: false)
        let transcript = F.transcript([F.put(F.tool("s1", "Task: a", name: "Task", status: .running, spawns: running)), F.put(F.tool("s2", "Task: b", name: "Task", spawns: done))])
        var layout = SubagentLayout()
        layout.update(transcript, wide: false)
        XCTAssertEqual(layout.listed.map(\.id), [EntryId("s1")])
        XCTAssertEqual(layout.place(of: EntryId("s1")), .inline)
        layout.update(transcript, wide: true)
        XCTAssertEqual(layout.place(of: EntryId("s1")), .beside)
        layout.setBeside(EntryId("s1"), false)
        XCTAssertEqual(layout.place(of: EntryId("s1")), .inline)
        layout.maximize(EntryId("s2"))
        XCTAssertEqual(layout.place(of: EntryId("s2")), .maximized)
        XCTAssertTrue(layout.beside.isEmpty)
    }
}

final class ActivityTests: XCTestCase {
    typealias F = TranscriptFixtures

    func testDeriveActivity() {
        XCTAssertNil(ConversationActivity.of(F.transcript([F.put(F.user("u", "hi"))])))
        XCTAssertEqual(ConversationActivity.of(F.transcript([F.put(F.user("u", "hi")), F.running])), .thinking)
        let thinking = F.transcript([F.put(F.user("u", "hi")), F.running, F.put(F.assistant("a", [.thinking(text: "hmm")], streaming: true))])
        XCTAssertEqual(ConversationActivity.of(thinking), .thinking)
        let text = F.transcript([F.put(F.user("u", "hi")), F.running, F.put(F.assistant("a", [.thinking(text: "hmm"), .text(markdown: "ok")], streaming: true))])
        XCTAssertEqual(ConversationActivity.of(text), .responding)
        let tool = F.transcript([F.put(F.user("u", "hi")), F.running, F.put(F.tool("t", "Bash: ls", status: .running))])
        XCTAssertEqual(ConversationActivity.of(tool)?.label, "Running Bash…")
    }

    func testFormatting() {
        XCTAssertEqual(ConversationActivity.formatElapsed(12_900), "12s")
        XCTAssertEqual(ConversationActivity.formatElapsed(125_000), "2m 05s")
        XCTAssertEqual(ConversationActivity.formatTokens(850), "850")
        XCTAssertEqual(ConversationActivity.formatTokens(1200), "1.2k")
        let t = F.transcript([
            F.put(F.assistant("old", String(repeating: "x", count: 4000))), F.put(F.user("u", "hi")), F.running,
            F.put(F.assistant("a", [.thinking(text: String(repeating: "y", count: 400))], streaming: true)),
        ])
        XCTAssertEqual(ConversationActivity.estimateTokens(t), 100)
        XCTAssertEqual(ConversationActivity.meta(elapsedMs: 0, tokens: 0), "0s")
    }

    func testWorkNotes() {
        let failed = ToolEntry(id: "t", tool: "Bash", title: "Bash: x", input: .null, status: .failed, output: [.command(exitCode: 2, output: "", stderr: nil, interrupted: false)])
        XCTAssertEqual(WorkStateWords.note(failed), "Exit code 2")
        let denied = ToolEntry(id: "t", tool: "Bash", title: "Bash: x", input: .null, status: .denied)
        XCTAssertEqual(WorkStateWords.note(denied), "Denied")
        let background = ToolEntry(id: "t", tool: "Bash", title: "Bash: x", input: .null, status: .succeeded, background: BackgroundTask(state: .running, summary: nil))
        XCTAssertEqual(WorkStateWords.note(background), "In the background")
        XCTAssertNil(WorkStateWords.note(ToolEntry(id: "t", tool: "Read", title: "Read: a", input: .null, status: .succeeded)))
    }

    func testWords() {
        XCTAssertEqual(ContextWords.words(Usage(contextTokens: 54_000, contextWindow: 200_000)), "Context 27% · 54k of 200k")
        XCTAssertEqual(ContextWords.words(Usage(contextTokens: 900)), "Context 900")
        XCTAssertNil(ContextWords.words(Usage()))
        XCTAssertEqual(ContextWords.level(Usage(contextTokens: 190, contextWindow: 200)), .at)
        XCTAssertEqual(BackgroundWords.elapsed(45_000), "45s")
        XCTAssertEqual(BackgroundWords.elapsed(192_000), "3m 12s")
        XCTAssertEqual(BackgroundWords.elapsed(3_900_000), "1h 5m")
        XCTAssertEqual(BackgroundWords.elapsed(-5), "0s")
        XCTAssertEqual(BackgroundWords.sentence(1), "1 background task")
        XCTAssertEqual(FindWords.countText("a", total: 2_596_112, current: 2, complete: false), "3 of 2,596,112…")
        XCTAssertEqual(FindWords.countText("a", total: 0, current: nil, complete: true), "No results")
        XCTAssertEqual(FindWords.countText("a", total: 0, current: nil, complete: false), "Searching…")
        XCTAssertEqual(FindWords.countText("", total: 0, current: nil, complete: true), "")
        XCTAssertEqual(SurfaceWords.waitingSentence(2), "2 requests are waiting for an answer")
        XCTAssertEqual(SurfaceWords.fontSize(terminal: 13), 15)
        XCTAssertEqual(EntryWords.compaction(CompactionEntry(id: "k", trigger: "auto", preTokens: 120_000, postTokens: 12_000)), "Conversation compacted · auto · from 120,000 to 12,000 tokens")
        XCTAssertEqual(ComposerWords.draftWords([PendingMessage(id: "p", text: "x", images: [], failure: nil, editing: true)], ["p": "edited"], "typed"), "edited\n\ntyped")
        XCTAssertEqual(SettingPickerModel.shortModelName("claude-opus-5-5[1m]"), "Opus 5.5 (1M)")
        XCTAssertEqual(SettingPickerModel.shortModelName("claude-haiku-4-5-20251001"), "Haiku 4.5")
        XCTAssertEqual(SettingPickerModel.shortModelName("sonnet"), "sonnet")
    }

    func testDiffRows() {
        let rows = DiffRows.of("@@ -3,2 +3,3 @@\n a\n-b\n+c\n+d")
        XCTAssertEqual(rows.map(\.kind), [.hunk, .context, .remove, .add, .add])
        XCTAssertEqual(rows.map(\.old), [nil, 3, 4, nil, nil])
        XCTAssertEqual(rows.map(\.new), [nil, 3, nil, 4, 5])
        XCTAssertEqual(DiffRows.firstNewLine(rows), 3)
        XCTAssertEqual(DiffRows.of("@@\n+x").map(\.new), [nil, nil])
        XCTAssertEqual(DiffRows.shownPath("/p/src/a.ts", cwd: "/p"), "src/a.ts")
        XCTAssertEqual(DiffRows.shownPath("/q/a.ts", cwd: "/p"), "/q/a.ts")
    }

    func testFreshEntries() {
        var fresh = FreshEntries()
        XCTAssertEqual(fresh.drawn([("a", "user"), ("b", "assistant")]), [])
        XCTAssertEqual(fresh.drawn([("a", "user"), ("b", "assistant"), ("c", "tool")]), ["c"])
        // A load of many at once is not fresh.
        let many = (0..<10).map { ("n\($0)", "tool") }
        XCTAssertEqual(fresh.drawn([("a", "user"), ("b", "assistant"), ("c", "tool")] + many), [])
        // An echo replacing its sending bubble does not rise twice.
        var echo = FreshEntries()
        _ = echo.drawn([("a", "user"), ("sending:1", "user")])
        XCTAssertEqual(echo.drawn([("a", "user"), ("u2", "user")]), [])
    }

    func testSubmission() {
        typealias F = TranscriptFixtures
        var t = F.transcript([.pending([PendingMessage(id: "p1", text: "x", images: [], failure: nil, editing: false)])])
        XCTAssertEqual(ComposerWords.submission(text: "", images: 0, transcript: t, editing: []), .sendPendingNow("p1"))
        XCTAssertEqual(ComposerWords.submission(text: "", images: 0, transcript: t, editing: ["p1"]), .nothing)
        XCTAssertEqual(ComposerWords.submission(text: "hi", images: 0, transcript: t, editing: []), .send(text: "hi"))
        t.session.commands = [SlashCommand(trigger: .slash, name: "mcp", description: "", argumentHint: nil, route: .mcp)]
        if case .command(let command) = ComposerWords.submission(text: " /mcp ", images: 0, transcript: t, editing: []) {
            XCTAssertEqual(command.name, "mcp")
        } else {
            XCTFail("a command DevHub answers is that command")
        }
    }

    func testTheFixturesFold() {
        XCTAssertGreaterThan(TranscriptFixtures.long(200).entries.count, 190)
        let everything = TranscriptFixtures.everything()
        XCTAssertEqual(everything.requests.count, 2)
        XCTAssertEqual(EntryTree(everything).unattached.count, 1)
    }
}

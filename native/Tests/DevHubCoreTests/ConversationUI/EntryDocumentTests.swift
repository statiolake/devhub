// What conversationSurface.test.tsx, readableView.test.tsx, subagentTree.test.tsx
// and math.test.tsx say of the drawn transcript, asked of its document.

import XCTest
@testable import DevHubCore

private typealias F = TranscriptFixtures

private func paragraphs(_ blocks: [DocBlock]) -> [DocParagraph] {
    blocks.flatMap { block -> [DocParagraph] in
        switch block {
        case .paragraph(let p): return [p]
        case .box(let b): return paragraphs(b.children)
        case .embed: return []
        }
    }
}

private func embeds(_ blocks: [DocBlock]) -> [DocEmbed] {
    blocks.flatMap { block -> [DocEmbed] in
        switch block {
        case .paragraph: return []
        case .box(let b): return embeds(b.children)
        case .embed(let e): return [e]
        }
    }
}

private func boxes(_ blocks: [DocBlock]) -> [DocBox] {
    blocks.flatMap { block -> [DocBox] in
        if case .box(let b) = block { return [b] + boxes(b.children) }
        return []
    }
}

private func texts(_ section: DocSection?) -> [String] {
    paragraphs(section?.blocks ?? []).map(\.text)
}

private func build(_ transcript: Transcript, _ change: (inout EntryDocumentState) -> Void = { _ in }) -> [DocSection] {
    var state = EntryDocumentState()
    state.rewindTargets = rewindTargets(transcript)
    state.skillWords = SkillTokens.words(transcript.session.commands)
    change(&state)
    return EntryDocumentBuilder(transcript: transcript, state: state).sections()
}

private func section(_ sections: [DocSection], _ id: String) -> DocSection? { sections.first { $0.id == id } }

final class EntryDocumentTests: XCTestCase {
    func testACompletedTurnDrawsNothingAndAnInterruptedOneSaysSo() {
        let sections = build(F.transcript([F.put(F.user("u", "hi")), F.put(F.turnEnd("e1")), F.put(F.turnEnd("e2", .interrupted, detail: "Stopped"))]))
        XCTAssertNil(section(sections, "e1"))
        XCTAssertEqual(texts(section(sections, "e2")), ["Turn interrupted", "Stopped"])
        XCTAssertEqual(paragraphs(section(sections, "e2")!.blocks)[0].rule?.ink, .lineSoft)
    }

    func testThePersonsBubbleWithItsOriginAndActions() {
        let transcript = F.transcript([
            .session(SessionFacts(canRewind: true)),
            F.put(F.user("u1", "first")), F.put(F.assistant("a1", "ok")), F.put(F.turnEnd("e1")),
            F.put(F.user("u2", "Template text", origin: .injection)),
        ])
        let sections = build(transcript)
        let first = section(sections, "u1")!
        XCTAssertEqual(boxes(first.blocks).first?.style, .bubble)
        guard case .actions(let buttons, let align, _)? = embeds(first.blocks).first?.kind else { return XCTFail("no actions") }
        XCTAssertEqual(align, .trailing)
        XCTAssertEqual(buttons.map(\.label), transcript.session.canRewind && rewindTargets(transcript).contains("u1") ? ["Copy", "Rewind"] : ["Copy"])
        let template = section(sections, "u2")!
        XCTAssertEqual(texts(template).first, "Sent by a template")
        XCTAssertEqual(boxes(template.blocks).first?.style, .bubbleDashed)
    }

    func testRewindAsksOnceMoreBeforeItDropsAnything() {
        let transcript = F.transcript([
            .session(SessionFacts(canRewind: true)),
            F.put(F.user("u1", "first")), F.put(F.assistant("a1", "ok")), F.put(F.turnEnd("e1")), F.put(F.user("u2", "second")),
        ])
        let targets = rewindTargets(transcript)
        XCTAssertFalse(targets.isEmpty)
        let target = targets.first!
        let asking = build(transcript) { $0.confirming = [target] }
        guard case .confirm(let note, let go, let cancel)? = embeds(section(asking, target.raw)!.blocks).last?.kind else { return XCTFail("no confirm") }
        XCTAssertEqual(note, ComposerWords.rewindNote)
        XCTAssertEqual(go.action, .rewind(target))
        XCTAssertEqual(cancel.action, .cancelRewind(target))
    }

    func testAMessageNotFromThePersonIsFoldedPastEightLinesAndTheFindBarStillReachesIt() {
        let text = (1...12).map { "line \($0)" }.joined(separator: "\n")
        let transcript = F.transcript([F.put(F.user("o", text, origin: .other))])
        let folded = section(build(transcript), "o")!
        XCTAssertEqual(texts(folded)[0], EntryWords.notFromYouLabel)
        XCTAssertFalse(texts(folded).joined().contains("line 9"))
        guard case .actions(let buttons, _, _)? = embeds(folded.blocks).last?.kind else { return XCTFail() }
        XCTAssertEqual(buttons.map(\.label), ["Show all", "Copy"])
        let search = EntryDocumentBuilder.searchSections(transcript, state: EntryDocumentState())
        XCTAssertTrue(search.sections[0].text.contains("line 12"))
        let key = paragraphs(search.documents[0].blocks).first { $0.text.contains("line 12") }!.key
        XCTAssertEqual(search.documents[0].folds(containing: key), [EntryFold.other("o")])
        let unfolded = section(build(transcript) { $0.unfoldedOther = ["o"] }, "o")!
        XCTAssertTrue(texts(unfolded).joined().contains("line 12"))
    }

    func testAnAnswerToQuestionsIsThePersonsMessage() {
        let answer = AnswerEntry(id: "q", answers: [
            QuestionAnswer(header: "Scope", question: "Which files?", chosen: ["src/", "docs/"], written: "tests", notes: "quick", secret: false),
            QuestionAnswer(header: "", question: "Token?", chosen: ["x"], written: nil, notes: nil, secret: true),
        ])
        let sections = build(F.transcript([.entry(.answer(answer))]))
        XCTAssertEqual(texts(section(sections, "q")), ["Scope Which files?", "src/", "docs/", "tests", "Note: quick", "Token?", "Hidden"])
        XCTAssertEqual(EntryWords.answerText(answer), "Scope: Which files?\nsrc/\ndocs/\ntests\nNote: quick\n\nToken?\n(hidden)")
    }

    func testThinkingIsFoldedAndWithheldThinkingIsNotDrawn() {
        let transcript = F.transcript([F.put(F.assistant("a", [.thinking(text: ""), .thinking(text: "Hmm."), .text(markdown: "Done.")]))])
        let closed = section(build(transcript), "a")!
        XCTAssertEqual(texts(closed).filter { !$0.isEmpty }, ["Thought ", "Done."])
        let open = section(build(transcript) { $0.chosenFolds[EntryFold.thinking("a", 1)] = true }, "a")!
        XCTAssertTrue(texts(open).contains("Hmm."))
        guard case .actions(let buttons, let align, _)? = embeds(open.blocks).last?.kind else { return XCTFail() }
        XCTAssertEqual(align, .leading)
        XCTAssertEqual(buttons.first?.action, .copy(id: "copy:a", text: "Done."))
    }

    func testAStreamingAnswerEndsInTheCaretAndHidesItsCopy() {
        let sections = build(F.transcript([F.running, F.put(F.assistant("a", "Working", streaming: true))]))
        let answer = section(sections, "a")!
        XCTAssertEqual(paragraphs(answer.blocks).first?.runs.last?.inline, .streamingDot)
        guard case .actions(_, _, let hide)? = embeds(answer.blocks).last?.kind else { return XCTFail() }
        XCTAssertTrue(hide)
        XCTAssertEqual(sections.last?.id, "activity")
    }

    func testAToolRowSplitsVerbAndTargetAndSaysOnlyWhatItsMarkCannot() {
        let transcript = F.transcript([
            F.put(F.tool("t", "Bash: npm test", status: .failed, output: [.command(exitCode: 2, output: "x", stderr: nil, interrupted: false)], outsideSandbox: true)),
            F.put(F.tool("d", "Read", status: .denied)),
        ])
        let sections = build(transcript)
        let row = paragraphs(section(sections, "t")!.blocks)[0]
        XCTAssertEqual(row.runs.first?.inline, .status(.failed))
        XCTAssertEqual(row.runs.first { $0.style.bold }?.text, "Bash:")
        XCTAssertEqual(row.runs.first { $0.style.mono }?.text, "npm test")
        XCTAssertEqual(row.runs.first { $0.style.chip == .sandbox }?.text, "unsandboxed")
        XCTAssertEqual(row.trailing.map(\.text), ["Exit code 2"])
        XCTAssertEqual(row.action, .toggle(EntryFold.tool("t")))
        XCTAssertEqual(paragraphs(section(sections, "d")!.blocks)[0].trailing.map(\.text), ["Denied"])
    }

    func testAnOpenCallShowsItsInputAndOutputUnderSections() {
        let transcript = F.transcript([F.put(F.tool(
            "t", "Bash: npm test", input: ["command": "npm test"],
            output: [.command(exitCode: 1, output: "FAIL", stderr: "boom", interrupted: true), .reference(name: "Grep"),
                     .persisted(note: "Output was saved", path: "/tmp/out.txt", preview: "head")]))])
        let closed = section(build(transcript), "t")!
        XCTAssertEqual(texts(closed).count, 1)
        let open = section(build(transcript) { $0.chosenFolds[EntryFold.tool("t")] = true }, "t")!
        XCTAssertEqual(Array(texts(open).dropFirst()), [
            "Input", "{\n  \"command\": \"npm test\"\n}", "Output", "FAIL", "Stderr", "boom", "Interrupted", "Exit code 1",
            "Loaded the tool Grep", "Output was saved /tmp/out.txt", "head",
        ])
        XCTAssertEqual(boxes(open.blocks).first { $0.style == .toolBody }?.indent, 1.45)
    }

    func testAReadableViewShowsTheChangeTheLatestPlanAndImagesClipped() {
        let diff = FileDiff(path: "/p/src/a.ts", unifiedDiff: "@@ -1,2 +1,2 @@\n-a\n+b\n c")
        let image = ImageRef(mediaType: "image/png", source: .data(base64: "AA=="), label: "shot.png")
        let transcript = F.transcript([
            .session(SessionFacts(cwd: "/p")),
            F.put(F.tool("e", "Edit: src/a.ts", change: [diff])),
            F.put(F.tool("p1", "TodoWrite", plan: [PlanStep(text: "Old", status: .pending)])),
            F.put(F.tool("p2", "TodoWrite", plan: [PlanStep(text: "New", status: .inProgress)])),
            F.put(F.tool("s", "Screenshot", output: [.image(image)])),
        ])
        let sections = build(transcript) { $0.links.cwd = "/p" }
        let edit = section(sections, "e")!
        let readable = boxes(edit.blocks).first { $0.clip != nil }!
        XCTAssertEqual(readable.clip, DocClip(id: EntryFold.readable("e"), open: false))
        let lines = paragraphs(readable.children)
        XCTAssertEqual(lines[0].text, "src/a.ts")
        XCTAssertEqual(lines.map(\.band), [nil, nil, .remove, .add, nil])
        XCTAssertEqual(lines[2].runs[0].text, "   1       ")
        XCTAssertEqual(lines[3].runs[0].text, "        1  ")
        XCTAssertTrue(lines[2].runs[0].style.control)
        XCTAssertEqual(edit.candidates, ["src/a.ts", "/p/src/a.ts"])
        XCTAssertFalse(boxes(section(sections, "p1")!.blocks).contains { $0.clip != nil })
        XCTAssertTrue(texts(section(sections, "p2")).contains("New"))
        guard case .images(let images)? = embeds(section(sections, "s")!.blocks).first?.kind else { return XCTFail() }
        XCTAssertEqual(images, [image])
    }

    func testADiffsPathIsALinkToItsFirstChangedLineOnceKnown() {
        let diff = FileDiff(path: "/p/a.ts", unifiedDiff: "@@ -3 +7 @@\n-x\n+y")
        let transcript = F.transcript([F.put(F.tool("e", "Edit: a.ts", change: [diff]))])
        let sections = build(transcript) {
            $0.links = LinkContext(cwd: "/p", issues: nil, file: { _, path in path == "/p/a.ts" ? .file("/p/a.ts") : nil })
        }
        let path = paragraphs(section(sections, "e")!.blocks).first { $0.text == "a.ts" }!
        XCTAssertEqual(path.runs[0].link, .file(path: "/p/a.ts", range: .line(line: 7, column: 1)))
    }

    func testADenialIsOneQuietLineWithItsAccountFolded() {
        let transcript = F.transcript([F.put(F.tool("t", "Bash: rm", status: .denied, denial: Denial(summary: "Denied by auto mode", detail: "Deletes files.")))])
        XCTAssertEqual(texts(section(build(transcript), "t")).last, "Denied by auto mode ")
        let open = build(transcript) { $0.chosenFolds[EntryFold.denial("t")] = true }
        XCTAssertEqual(texts(section(open, "t")).last, "Deletes files.")
    }

    func testRequestsAreDrawnOnTheirCallOrAfterTheLastEntry() {
        let transcript = F.transcript([
            F.put(F.tool("t", "Bash: npm test", status: .running)),
            F.opened(F.toolRequest("r1", entry: "t")), F.opened(F.toolRequest("r2", entry: nil)),
        ])
        let sections = build(transcript)
        guard case .request(let request)? = embeds(section(sections, "t")!.blocks).first?.kind else { return XCTFail() }
        XCTAssertEqual(request.id, "r1")
        XCTAssertNotNil(section(sections, "request:r2"))
        XCTAssertTrue(EntryDocumentBuilder.requestText(request).contains("Allow once"))
    }

    func testASubagentIsOpenWhileItRunsAndItsWorkIsDrawnInOnePlace() {
        let running = SubagentInfo(label: "Explore", prompt: "List it", model: "haiku", state: .running, takesMessages: true)
        let transcript = F.transcript([
            F.put(F.tool("s", "Task: explore", name: "Task", status: .running, spawns: running)),
            F.put(F.assistant("sa", "Found `a`.", parent: "s")),
        ])
        let inline = section(build(transcript), "s")!
        XCTAssertEqual(boxes(inline.blocks).first { $0.style == .subagent }?.open, true)
        XCTAssertTrue(texts(inline).contains("List it"))
        XCTAssertTrue(texts(inline).contains("Found a."))
        XCTAssertTrue(embeds(inline.blocks).contains { if case .subagentMessage = $0.kind { return true }; return false })
        var layout = SubagentLayout()
        layout.update(transcript, wide: true)
        let beside = section(build(transcript) { $0.layout = layout }, "s")!
        XCTAssertFalse(texts(beside).contains("Found a."))
        XCTAssertTrue(texts(beside).contains(Subagents.elsewhere(.beside)))
        guard case .subagentActions(_, _, let canBeside, let isBeside, let canMaximize)? = embeds(beside.blocks).last?.kind else { return XCTFail() }
        XCTAssertEqual([canBeside, isBeside, canMaximize], [true, true, false])
        let pane = EntryDocumentBuilder(transcript: transcript, state: EntryDocumentState()).paneSections(transcript.entries[0].toolEntry!)
        XCTAssertEqual(pane.map(\.id), ["prompt:s", "sa"])
        let done = F.transcript([F.put(F.tool("s", "Task: explore", name: "Task", spawns: SubagentInfo(label: "E", prompt: "", model: nil, state: .completed, takesMessages: false)))])
        XCTAssertEqual(boxes(section(build(done), "s")!.blocks).first { $0.style == .subagent }?.open, false)
    }

    func testIndentationStopsGrowingAtTheThirdLevel() {
        func spawn(_ id: String, parent: String?) -> ConversationEvent {
            F.put(F.tool(id, "Task: deeper", name: "Task", status: .running, spawns: SubagentInfo(label: id, prompt: "", model: nil, state: .running, takesMessages: false), parent: parent))
        }
        let transcript = F.transcript([spawn("s0", parent: nil), spawn("s1", parent: "s0"), spawn("s2", parent: "s1"), spawn("s3", parent: "s2")])
        let entries = boxes(section(build(transcript), "s0")!.blocks).filter { $0.style == .subagentEntries }
        XCTAssertEqual(entries.map(\.flat), [false, false, true, true])
    }

    func testTheCLIsOwnLines() {
        let transcript = F.transcript([
            .entry(.command(CommandEntry(id: "c", line: "/model x", output: "nope", failed: true))),
            .entry(.compaction(CompactionEntry(id: "k", trigger: "auto", preTokens: 120_000, postTokens: 12_000))),
            F.put(F.notice("n1", "Pushed")), F.put(F.notice("n2", "Retrying", level: .warning, raw: ["a": 1])),
            F.running, .compacting(true), .limitResume(.unscheduled(reason: "no reset time")),
        ])
        let sections = build(transcript)
        XCTAssertEqual(texts(section(sections, "c")), ["/model x", "nope"])
        XCTAssertEqual(boxes(section(sections, "c")!.blocks).first?.style, .railDanger)
        XCTAssertEqual(texts(section(sections, "k")), ["Conversation compacted · auto · from 120,000 to 12,000 tokens"])
        XCTAssertEqual(section(sections, "n1")?.kind, "notice-info")
        XCTAssertEqual(texts(section(sections, "n2")), ["Retrying", "Event as received "])
        XCTAssertEqual(paragraphs(section(sections, "compacting")!.blocks)[0].rule?.dashed, true)
        let limit = paragraphs(section(sections, "limit-resume")!.blocks)[0]
        XCTAssertEqual(limit.runs.last?.text, "Dismiss")
        XCTAssertEqual(limit.runs.last?.action, .cancelLimitResume)
    }

    func testAMessageOnItsWayIsDimmedWhereItWillLand() {
        let transcript = F.transcript([.sending([SendingMessage(id: "m", text: "hello", images: [], origin: .person)])])
        let sending = section(build(transcript), "sending:m")!
        XCTAssertTrue(sending.dimmed)
        XCTAssertEqual(texts(sending), ["hello"])
    }

    func testSkillNamesInThePersonsWordsArePills() {
        let transcript = F.transcript([
            .session(SessionFacts(commands: [SlashCommand(trigger: .slash, name: "review", description: "", argumentHint: nil, route: .message)])),
            F.put(F.user("u", "please /review it")),
        ])
        let runs = paragraphs(section(build(transcript), "u")!.blocks)[0].runs
        XCTAssertEqual(runs.map(\.text), ["please ", "/review", " it"])
        XCTAssertEqual(runs[1].style.chip, .skill)
    }

    func testTheGapsBetweenEntriesAreTheStylesheets() {
        let em = 1 / SurfaceMetrics.fontPx
        XCTAssertEqual(DocSection.gap(after: nil, before: "user"), 0)
        XCTAssertEqual(DocSection.gap(after: "assistant", before: "user"), 20 * em)
        XCTAssertEqual(DocSection.gap(after: "tool", before: "tool"), 2 * em)
        XCTAssertEqual(DocSection.gap(after: "tool", before: "notice-info"), 4 * em)
        XCTAssertEqual(DocSection.gap(after: "user", before: "assistant"), 12 * em)
    }

    func testAQuestionAskedAndAnsweredIsKeptAsTheCardDrewIt() {
        let asked = AskedQuestion(
            question: Question(id: "q", header: "Layout", text: "Which layout?", options: [
                QuestionOption(label: "Columns", description: "Side by side", preview: "```\nA | B\n```"),
                QuestionOption(label: "Rows", description: "", preview: nil),
            ], multiSelect: false, allowsOther: true),
            answer: QuestionAnswer(header: "Layout", question: "Which layout?", chosen: ["Rows"], written: "Neither", notes: "narrow", secret: false))
        let transcript = F.transcript([F.put(F.tool("t", "AskUserQuestion", name: "AskUserQuestion", asked: [asked]))])
        let open = section(build(transcript) { $0.chosenFolds[EntryFold.tool("t")] = true }, "t")!
        let records = embeds(open.blocks).filter { if case .questionRecord = $0.kind { return true }; return false }
        XCTAssertEqual(records.count, 1)
        guard case .questionRecord(let drawn)? = records.first?.kind else { return XCTFail("no record") }
        XCTAssertEqual(drawn, asked)
        XCTAssertEqual(records.first?.searchText, "Layout\nWhich layout?\nColumns — Side by side\nRows\nNeither — Written instead\nNote: narrow")
        let hidden = AskedQuestion(question: asked.question, answer: QuestionAnswer(header: "Layout", question: "Which layout?", chosen: ["Rows"], written: "x", notes: "n", secret: true))
        XCTAssertTrue(EntryDocumentBuilder.recordText(hidden).hasSuffix("Rows\nAnswer hidden"))
    }

    func testEverythingAndTheLongTranscriptBuildAndSearch() {
        let everything = F.everything()
        let sections = build(everything)
        XCTAssertGreaterThan(sections.count, 15)
        let search = EntryDocumentBuilder.searchSections(everything, state: EntryDocumentState())
        let all = search.sections.map(\.text).joined(separator: "\n")
        for word in ["Let me look at the file first.", "npm ERR! Test failed", "The command deletes files.", "const a = 2;", "The note."] {
            XCTAssertTrue(all.contains(word), word)
        }
        let long = F.long(600)
        let started = Date()
        let built = build(long)
        XCTAssertEqual(built.count, long.entries.filter { $0.parent == nil && $0.kind != "turn-end" }.count)
        XCTAssertLessThan(Date().timeIntervalSince(started), 30)
    }
}

final class MarkdownDocumentTests: XCTestCase {
    private func doc(_ source: String, links: LinkContext = .none) -> [DocBlock] {
        MarkdownDocumentBuilder.blocks(source, streaming: false, links: links, keyPrefix: "m").blocks
    }

    func testHeadingsParagraphsAndInlineStyles() {
        let blocks = doc("# Title\n\nSome **bold**, *it*, ~~gone~~ and `code`.")
        let p = paragraphs(blocks)
        XCTAssertEqual(p.map(\.text), ["Title", "Some bold, it, gone and code."])
        XCTAssertEqual(p[0].runs[0].style.size, 1.4)
        XCTAssertEqual(p[0].before, 0)
        let runs = p[1].runs
        XCTAssertTrue(runs.first { $0.text == "bold" }!.style.bold)
        XCTAssertTrue(runs.first { $0.text == "it" }!.style.italic)
        XCTAssertTrue(runs.first { $0.text == "gone" }!.style.strike)
        XCTAssertEqual(runs.first { $0.text == "code" }!.style.chip, .code)
    }

    func testListsTaskListsAndQuotes() {
        let blocks = doc("- a\n- [x] b\n\n1. one\n2. two\n\n> quoted")
        let p = paragraphs(blocks)
        XCTAssertEqual(p.map { $0.marker?.text ?? "" }, ["•", "", "1.", "2.", ""])
        XCTAssertEqual(p[1].marker?.inline, .checkbox(true))
        XCTAssertTrue(boxes(blocks).contains { $0.style == .quote })
    }

    func testCodeTablesMathAndRules() {
        let blocks = doc("```ts\nconst a = 1\n```\n\n| a | b |\n|:-|-:|\n| 1 |\n\n$$\nx^2\n$$\n\n---")
        let kinds = embeds(blocks).map(\.kind)
        XCTAssertEqual(kinds[0], .code(language: "ts", code: "const a = 1", settled: true))
        guard case .table(let align, let rows) = kinds[1] else { return XCTFail() }
        XCTAssertEqual(align, [.left, .right])
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows[1].count, 2)
        XCTAssertEqual(kinds[2], .math("x^2"))
        XCTAssertEqual(kinds[3], .rule)
    }

    func testRawHtmlIsNotDrawnAndFootnotesAreNumbered() {
        let blocks = doc("a <b>bold</b> c[^n]\n\n<div>x</div>\n\n[^n]: The note.")
        let p = paragraphs(blocks).map(\.text)
        XCTAssertEqual(p[0], "a bold c1")
        XCTAssertEqual(p[1], "Footnotes")
        XCTAssertEqual(p[2], "The note. ↩")
        XCTAssertFalse(p.contains("x"))
    }

    func testPathsAreLinksOnlyWhereTheyNameAFile() {
        let links = LinkContext(cwd: "/p", issues: nil, file: { _, path in path == "src/a.ts" ? .file("/p/src/a.ts") : .none })
        let made = MarkdownDocumentBuilder.blocks("See src/a.ts:3 and src/b.ts.", streaming: false, links: links, keyPrefix: "m")
        XCTAssertEqual(made.candidates, ["src/a.ts", "src/b.ts"])
        let run = paragraphs(made.blocks)[0].runs.first { $0.link != nil }!
        XCTAssertEqual(run.text, "src/a.ts:3")
        XCTAssertEqual(run.link, .file(path: "/p/src/a.ts", range: .line(line: 3, column: 1)))
        XCTAssertEqual(paragraphs(made.blocks)[0].runs.filter { $0.link != nil }.count, 1)
    }

    func testAStreamingDocumentDrawsItsTailUncolouredWithTheCaret() {
        let made = MarkdownDocumentBuilder.blocks("Para one.\n\n```ts\nlet a", streaming: true, links: .none, keyPrefix: "m")
        guard case .code(_, _, let settled)? = embeds(made.blocks).first?.kind else { return XCTFail() }
        XCTAssertFalse(settled)
        XCTAssertEqual(paragraphs(made.blocks).first?.text, "Para one.")
        XCTAssertEqual(paragraphs(made.blocks).last?.runs.last?.inline, .streamingDot)
    }
}

final class ConversationIconTests: XCTestCase {
    func testEveryIconsOutlineParses() throws {
        for icon in [DocIcon.send, .clock, .edit, .rewind, .mic, .stop, .copy, .check, .arrowDown, .arrowUp, .close, .arrowLeft, .chevronDown, .chevronRight, .maximize, .column] {
            for shape in ConversationIcons.drawing(icon).shapes {
                if case .path(let data, _) = shape { XCTAssertFalse(try PathData.parse(data).isEmpty, icon.rawValue) }
            }
        }
    }
}

final class ClipTests: XCTestCase {
    func testALongReadableViewIsCutWithShowAllAndOpenedWhole() {
        let lines = (1...60).map { "+line \($0)" }.joined(separator: "\n")
        let diff = FileDiff(path: "/p/a.ts", unifiedDiff: "@@ -1,0 +1,60 @@\n" + lines)
        let transcript = TranscriptFixtures.transcript([TranscriptFixtures.put(TranscriptFixtures.tool("e", "Edit: a.ts", change: [diff]))])
        func texts(_ state: EntryDocumentState) -> [String] {
            let section = EntryDocumentBuilder(transcript: transcript, state: state).section(transcript.entries[0], depth: 0)!
            func walk(_ blocks: [DocBlock]) -> [String] {
                blocks.flatMap { block -> [String] in
                    switch block {
                    case .paragraph(let p): return [p.text]
                    case .box(let b): return walk(b.children)
                    case .embed: return []
                    }
                }
            }
            return walk(section.blocks)
        }
        let cut = texts(EntryDocumentState())
        XCTAssertEqual(cut.last, "Show all")
        XCTAssertFalse(cut.joined().contains("line 60"))
        var open = EntryDocumentState()
        open.openClips = [EntryFold.readable("e")]
        let whole = texts(open)
        XCTAssertEqual(whole.last, "Show less")
        XCTAssertTrue(whole.joined().contains("line 60"))
        let short = TranscriptFixtures.transcript([TranscriptFixtures.put(TranscriptFixtures.tool("e", "Edit: a.ts", change: [FileDiff(path: "/p/a.ts", unifiedDiff: "@@ -1 +1 @@\n-a\n+b")]))])
        let section = EntryDocumentBuilder(transcript: short, state: EntryDocumentState()).section(short.entries[0], depth: 0)!
        XCTAssertFalse(section.blocks.contains { if case .paragraph(let p) = $0 { return p.text == "Show all" }; return false })
    }
}

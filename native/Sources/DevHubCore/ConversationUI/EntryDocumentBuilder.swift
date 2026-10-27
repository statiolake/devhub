// Port of apps/desktop/src/shell/conversation/EntryView.tsx, EntryParts.tsx,
// StatusMark.tsx, RequestCard's QuestionRecord, Clip.tsx and the transcript
// part of ConversationSurface.tsx, as the drawn conversation's document.
//
// One component drew an entry wherever it stands: at the top level, or inside
// a subagent inside a subagent. Here one builder does: depth is only an
// indentation, and the indentation stops growing at the third level so a deep
// tree does not walk off the side of the pane.
//
// What the surface remembers of the person's hand — which folds they opened
// or closed, which long views they opened, which rewind they are confirming —
// is `EntryDocumentState`, kept by the App's view and handed in on every
// build. A build reads it and the transcript and nothing else, so the same
// two always give the same document; and a search builds it once more with
// every fold open, which is how the find bar reaches folded words and knows
// which folds to open for a match.

import Foundation

/// The surface's state an entry is drawn with.
public struct EntryDocumentState: Sendable {
    /// Folds the person opened or closed; the others take their default.
    public var chosenFolds: [String: Bool] = [:]
    /// Readable views opened past their clip (`Clip`).
    public var openClips: Set<String> = []
    /// Long messages not from the person, unfolded.
    public var unfoldedOther: Set<EntryId> = []
    /// Messages whose Rewind is being confirmed.
    public var confirming: Set<EntryId> = []
    /// The messages the conversation can be taken back to before (`rewindTargets`).
    public var rewindTargets: Set<EntryId> = []
    /// Where each subagent is drawn.
    public var layout = SubagentLayout()
    public var links: LinkContext = .none
    /// The session's command names, drawn as pills in the person's words.
    public var skillWords: Set<String> = []
    /// Every fold open: the document the find bar reads.
    public var allOpen = false
    /// Now, in ms since 1970, for a resume time's words.
    public var now: Double = Date().timeIntervalSince1970 * 1000
    public var timeZone: TimeZone = .current

    public init() {}

    /// A fold's state: the person's choice, else its default.
    public func open(_ fold: String, default value: Bool = false) -> Bool {
        allOpen || (chosenFolds[fold] ?? value)
    }
}

/// The deepest level that still indents.
public let MAX_INDENT = 3

public enum EntryFold {
    public static func tool(_ id: EntryId) -> String { "tool:\(id.raw)" }
    public static func thinking(_ id: EntryId, _ block: Int) -> String { "thinking:\(id.raw):\(block)" }
    public static func denial(_ id: EntryId) -> String { "denial:\(id.raw)" }
    public static func raw(_ id: EntryId) -> String { "raw:\(id.raw)" }
    public static func subagent(_ id: EntryId) -> String { "subagent:\(id.raw)" }
    public static func other(_ id: EntryId) -> String { "other:\(id.raw)" }
    public static func readable(_ id: EntryId) -> String { "readable:\(id.raw)" }
}

public struct EntryDocumentBuilder {
    public var state: EntryDocumentState
    public let transcript: Transcript
    public let tree: EntryTree

    public init(transcript: Transcript, tree: EntryTree? = nil, state: EntryDocumentState) {
        self.transcript = transcript
        self.tree = tree ?? EntryTree(transcript)
        self.state = state
    }

    var links: LinkContext { state.links }

    // MARK: The transcript

    /// Every section the conversation's transcript draws, in order: the
    /// entries, the messages on their way, the compaction under way, the
    /// limit's line, the requests about no call, and the activity line.
    public func sections(activity: Bool = true) -> [DocSection] {
        var out: [DocSection] = []
        for entry in tree.topLevel {
            if let section = section(entry, depth: 0) { out.append(section) }
        }
        return out + trailingSections(activity: activity)
    }

    /// What the transcript draws after its entries: the messages on their way,
    /// the compaction under way, the limit's line, the requests about no
    /// call, and the activity line.
    public func trailingSections(activity: Bool = true) -> [DocSection] {
        var out: [DocSection] = []
        for message in transcript.sending { out.append(sending(message)) }
        if transcript.compacting { out.append(compacting()) }
        if let resume = transcript.limitResume { out.append(limitResume(resume)) }
        for request in tree.unattached {
            out.append(DocSection(id: "request:\(request.id.raw)", kind: "request", blocks: [requestEmbed(request, key: "request:\(request.id.raw)")]))
        }
        if activity, ConversationActivity.of(transcript) != nil {
            out.append(DocSection(id: "activity", kind: "activity", blocks: [
                .embed(DocEmbed(key: "activity", kind: .activity, searchText: "", copyText: "")),
            ]))
        }
        return out
    }

    /// A subagent's own transcript, for its pane (the column's, or the whole
    /// view's): its prompt, its entries, and the box to message it.
    public func paneSections(_ tool: ToolEntry) -> [DocSection] {
        guard let spawns = tool.spawns else { return [] }
        var out: [DocSection] = []
        if !spawns.prompt.isEmpty {
            var prompt = DocParagraph(key: "prompt:\(tool.id.raw)", runs: [DocRun(spawns.prompt, DocStyle().with { $0.ink = .secondary; $0.size = 0.92 })])
            prompt.lineHeight = 1.6
            out.append(DocSection(id: "prompt:\(tool.id.raw)", kind: "prompt", blocks: [.paragraph(prompt)]))
        }
        for child in tree.children(of: tool.id) {
            if let section = section(child, depth: 0) { out.append(section) }
        }
        return out
    }

    /// The section one entry draws, or nil for one that draws nothing (a completed turn's end).
    public func section(_ entry: TranscriptEntry, depth: Int) -> DocSection? {
        guard let made = blocks(entry, depth: depth) else { return nil }
        var section = DocSection(id: entry.id.raw, kind: Self.kind(entry), blocks: made.blocks)
        section.candidates = made.candidates
        return section
    }

    /// What a top-level entry's section is drawn from besides the surface's
    /// state: the entry, everything under it, the requests about any of it,
    /// and where its subagents are. Two equal fingerprints (under one state)
    /// draw the same section, so the view keeps the one it has.
    public func fingerprint(_ entry: TranscriptEntry) -> Int {
        var hasher = Hasher()
        hasher.combine(state.layout.wide)
        func walk(_ entry: TranscriptEntry) {
            hasher.combine(entry)
            if let requests = tree.requests[entry.id] { hasher.combine(requests) }
            if case .tool(let tool) = entry {
                hasher.combine(tree.latestPlan == tool.id)
                if tool.spawns != nil { hasher.combine(state.layout.place(of: tool.id).rawValue) }
            }
            for child in tree.children(of: entry.id) { walk(child) }
        }
        walk(entry)
        return hasher.finalize()
    }

    /// The kind the gaps between entries are read by.
    static func kind(_ entry: TranscriptEntry) -> String {
        if case .notice(let notice) = entry, notice.level == .info { return "notice-info" }
        return entry.kind
    }

    func blocks(_ entry: TranscriptEntry, depth: Int) -> (blocks: [DocBlock], candidates: [String])? {
        switch entry {
        case .user(let user):
            return (user.origin == .other ? notFromYou(user) : personMessage(user), [])
        case .answer(let answer): return (answerView(answer), [])
        case .assistant(let assistant): return assistantView(assistant)
        case .tool(let tool): return toolView(tool, depth: depth)
        case .command(let command): return (commandView(command), [])
        case .compaction(let compaction): return (compactionView(compaction), [])
        case .notice(let notice): return (noticeView(notice), [])
        case .turnEnd(let end):
            guard let label = EntryWords.outcomeLabel(end.outcome) else { return nil }
            return (turnEndView(end, label), [])
        }
    }

    // MARK: Styles

    static func style(_ change: (inout DocStyle) -> Void) -> DocStyle { DocStyle().with(change) }

    static func paragraph(_ key: String, _ runs: [DocRun], before: Double = 0, after: Double = 0, lineHeight: Double = 1.6) -> DocParagraph {
        var paragraph = DocParagraph(key: key, runs: runs)
        paragraph.before = before
        paragraph.after = after
        paragraph.lineHeight = lineHeight
        return paragraph
    }

    static func box(_ key: String, _ style: DocBoxStyle, _ children: [DocBlock], before: Double = 0, after: Double = 0, indent: Double = 0) -> DocBox {
        var box = DocBox(key: key, style: style, children: children)
        box.before = before
        box.after = after
        box.indent = indent
        return box
    }

    /// `--space-N` in em of the conversation's size.
    static func space(_ n: Int) -> Double {
        let px: [Double] = [0, 4, 8, 12, 16, 20, 24, 32]
        return SurfaceMetrics.em(px[min(n, px.count - 1)])
    }

    /// A monospace block of text as it came (`.conversation-json`, `.conversation-output`).
    static func pre(_ key: String, _ text: String, ink: DocInk? = nil, size: Double = 0.88, linked: LinkContext? = nil, candidates: inout [String]) -> DocParagraph {
        let style = Self.style { $0.mono = true; $0.size = size; $0.ink = ink }
        var runs: [DocRun]
        if let linked {
            let made = LinkedText.runs(text, style, linked)
            runs = made.runs
            candidates += made.candidates
        } else {
            runs = [DocRun(text, style)]
        }
        if runs.isEmpty { runs = [DocRun("", style)] }
        return paragraph(key, runs, lineHeight: 1.5)
    }

    // MARK: The person

    /// The bubble on the right, its origin's note over it.
    func personBubble(_ key: String, origin note: String?, _ children: [DocBlock], dashed: Bool) -> [DocBlock] {
        var out: [DocBlock] = []
        if let note {
            var line = Self.paragraph(key + "/origin", [DocRun(note, Self.style { $0.size = 0.8; $0.ink = .tertiary })], after: Self.space(1))
            line.align = .trailing
            out.append(.paragraph(line))
        }
        if !children.isEmpty { out.append(.box(Self.box(key + "/bubble", dashed ? .bubbleDashed : .bubble, children))) }
        return out
    }

    /// The person's words, their command names as pills.
    func skillRuns(_ text: String) -> [DocRun] {
        SkillTokens.tokenize(text, state.skillWords).map { segment in
            segment.skill ? DocRun(segment.text, Self.style { $0.chip = .skill; $0.ink = .accentInk }) : DocRun(segment.text)
        }
    }

    func imageStrip(_ key: String, _ images: [ImageRef]) -> [DocBlock] {
        if images.isEmpty { return [] }
        var embed = DocEmbed(key: key, kind: .images(images), searchText: "", copyText: images.map(\.label).joined(separator: "\n"))
        embed.before = Self.space(1)
        embed.after = Self.space(2)
        return [.embed(embed)]
    }

    static func copyButton(_ id: String, _ text: String, label: String) -> DocActionButton {
        DocActionButton(label: "Copy", icon: .copy, action: .copy(id: id, text: text), accessibility: label)
    }

    static func actions(_ key: String, _ buttons: [DocActionButton], align: DocAlign, hideWhileStreaming: Bool = false) -> DocBlock {
        .embed(DocEmbed(key: key, kind: .actions(buttons, align: align, hideWhileStreaming: hideWhileStreaming), searchText: "", copyText: ""))
    }

    func personMessage(_ entry: UserEntry) -> [DocBlock] {
        let key = entry.id.raw
        let origin: SentOrigin
        switch entry.origin {
        case .person, .other: origin = .person
        case .injection: origin = .injection
        case .afterLimit: origin = .afterLimit
        case .autoCompact: origin = .autoCompact
        }
        let words: [DocBlock] = entry.text.isEmpty ? [] : [.paragraph(Self.paragraph(key + "/text", skillRuns(entry.text)))]
        var out = personBubble(key, origin: EntryWords.originNote(origin), words, dashed: origin == .injection)
        out += imageStrip(key + "/images", entry.images)
        let rewindable = state.rewindTargets.contains(entry.id)
        var buttons = [Self.copyButton("copy:" + key, entry.text, label: "Copy message")]
        if rewindable {
            buttons.append(DocActionButton(
                label: "Rewind", icon: .rewind, action: .askRewind(entry.id),
                tooltip: "Take the conversation back to before this message", accessibility: "Rewind to here"))
        }
        out.append(Self.actions(key + "/actions", buttons, align: .trailing))
        if rewindable && state.confirming.contains(entry.id) {
            out.append(.embed(DocEmbed(
                key: key + "/confirm",
                kind: .confirm(
                    note: ComposerWords.rewindNote,
                    go: DocActionButton(label: "Rewind", icon: nil, action: .rewind(entry.id)),
                    cancel: DocActionButton(label: "Cancel", icon: nil, action: .cancelRewind(entry.id))),
                searchText: "", copyText: "")))
        }
        return out
    }

    /// A message that reached the Agent as a user message DevHub did not send.
    func notFromYou(_ entry: UserEntry) -> [DocBlock] {
        let key = entry.id.raw
        let lines = entry.text.components(separatedBy: "\n")
        let long = lines.count > EntryWords.notFromYouLines
        let unfolded = state.allOpen || state.unfoldedOther.contains(entry.id)
        var children: [DocBlock] = [
            .paragraph(Self.paragraph(key + "/label", [DocRun(EntryWords.notFromYouLabel, Self.style { $0.size = 0.8; $0.ink = .tertiary })], after: Self.space(1))),
        ]
        if !entry.text.isEmpty {
            let head = lines.prefix(EntryWords.notFromYouLines).joined(separator: "\n")
            children.append(.paragraph(Self.paragraph(key + "/text", [DocRun(head)])))
            if long {
                var rest = Self.box(key + "/rest", .plain, unfolded
                    ? [.paragraph(Self.paragraph(key + "/rest-text", [DocRun(lines.dropFirst(EntryWords.notFromYouLines).joined(separator: "\n"))]))]
                    : [])
                rest.fold = EntryFold.other(entry.id)
                rest.open = unfolded
                children.append(.box(rest))
            }
        }
        children += imageStrip(key + "/images", entry.images)
        var buttons: [DocActionButton] = []
        if long {
            buttons.append(DocActionButton(label: unfolded ? "Show less" : "Show all", icon: nil, action: .unfoldOther(entry.id)))
        }
        buttons.append(Self.copyButton("copy:" + key, entry.text, label: "Copy message"))
        children.append(Self.actions(key + "/actions", buttons, align: .leading))
        return [.box(Self.box(key + "/other", .other, children))]
    }

    /// The person's answer to questions the Agent asked, as their message.
    func answerView(_ entry: AnswerEntry) -> [DocBlock] {
        let key = entry.id.raw
        var inside: [DocBlock] = []
        for (index, answer) in entry.answers.enumerated() {
            let at = "\(key)/a\(index)"
            var question: [DocRun] = []
            if !answer.header.isEmpty {
                question.append(DocRun(answer.header + " ", Self.style { $0.size = 0.85; $0.ink = .secondary; $0.bold = true }))
            }
            question.append(DocRun(answer.question, Self.style { $0.size = 0.85; $0.ink = .secondary }))
            var group: [DocBlock] = [.paragraph(Self.paragraph(at + "/q", question))]
            let quiet = Self.style { $0.size = 0.9; $0.ink = .secondary }
            if answer.secret {
                group.append(.paragraph(Self.paragraph(at + "/empty", [DocRun("Hidden", quiet)])))
            } else if answer.chosen.isEmpty && answer.written == nil {
                group.append(.paragraph(Self.paragraph(at + "/empty", [DocRun("No answer", quiet)])))
            } else {
                for (line, label) in answer.chosen.enumerated() {
                    group.append(.paragraph(Self.paragraph("\(at)/c\(line)", [DocRun(label)])))
                }
                if let written = answer.written {
                    group.append(.paragraph(Self.paragraph(at + "/w", [DocRun(written)])))
                }
            }
            if let notes = answer.notes, !answer.secret {
                group.append(.paragraph(Self.paragraph(at + "/n", [DocRun("Note: \(notes)", quiet)])))
            }
            inside.append(.box(Self.box(at, .plain, group, before: index == 0 ? 0 : Self.space(2))))
        }
        var out = personBubble(key, origin: nil, inside, dashed: false)
        out.append(Self.actions(key + "/actions", [Self.copyButton("copy:" + key, EntryWords.answerText(entry), label: "Copy reply")], align: .trailing))
        return out
    }

    // MARK: The Agent

    func checklist(_ key: String, _ steps: [PlanStep], bordered: Bool) -> DocBlock {
        var items: [DocBlock] = []
        for (index, step) in steps.enumerated() {
            let style = Self.style {
                switch step.status {
                case .inProgress: $0.bold = true
                case .completed: $0.ink = .tertiary; $0.strike = true
                case .pending: break
                }
            }
            var row = Self.paragraph("\(key)/\(index)", [DocRun(step.text, style)], before: index == 0 ? 0 : 0.15)
            row.marker = DocRun("", tooltip: EntryWords.stepLabel(step.status), inline: .checklist(step.status))
            row.indent = 0.8 + Self.space(2)
            items.append(.paragraph(row))
        }
        return .box(Self.box(key, bordered ? .checklist : .plain, items, before: bordered ? Self.space(2) : 0, after: bordered ? Self.space(2) : 0))
    }

    func assistantView(_ entry: AssistantEntry) -> (blocks: [DocBlock], candidates: [String]) {
        let key = entry.id.raw
        var out: [DocBlock] = []
        var candidates: [String] = []
        for (index, block) in entry.blocks.enumerated() {
            // Only the last block can still be growing.
            let streaming = entry.streaming && index == entry.blocks.count - 1
            let at = "\(key)/b\(index)"
            switch block {
            case .text(let markdown):
                let made = MarkdownDocumentBuilder.blocks(markdown, streaming: streaming, links: links, keyPrefix: at)
                var inner = made.blocks
                if streaming, inner.isEmpty {
                    inner = [.paragraph(DocParagraph(key: at + "/dot", runs: [DocRun("", inline: .streamingDot)]))]
                }
                out.append(.box(Self.box(at, .plain, inner)))
                candidates += made.candidates
            case .thinking(let text):
                // Claude withholds the thinking itself: a fold with nothing inside is not drawn.
                if text.isEmpty { continue }
                let fold = EntryFold.thinking(entry.id, index)
                let open = state.open(fold)
                var summary = Self.paragraph(at + "/summary", [
                    DocRun(EntryWords.thinking(streaming: streaming), Self.style { $0.ink = .tertiary; $0.size = 0.9 }),
                    DocRun(" ", Self.style { $0.size = 0.9 }),
                    DocRun("", Self.style { $0.ink = .tertiary; $0.size = 0.9 }, inline: .chevron(open: open, quietUntilHover: false)),
                ])
                summary.action = .toggle(fold)
                var children: [DocBlock] = [.paragraph(summary)]
                if open {
                    let text = Self.paragraph(at + "/text", [DocRun(text, Self.style { $0.ink = .secondary; $0.size = 0.95 })])
                    children.append(.box(Self.box(at + "/rail", .rail, [.paragraph(text)], before: Self.space(1), after: Self.space(2))))
                }
                var box = Self.box(at, .plain, children, after: Self.space(2))
                box.fold = fold
                box.open = open
                out.append(.box(box))
            case .plan(let steps):
                out.append(checklist(at, steps, bordered: true))
            }
        }
        let source = EntryWords.answerSource(entry)
        if !source.isEmpty {
            out.append(Self.actions(key + "/actions", [Self.copyButton("copy:" + key, source, label: "Copy answer")], align: .leading, hideWhileStreaming: entry.streaming))
        }
        return (MarkdownDocumentBuilder.collapse(out), candidates)
    }

    // MARK: Tool calls

    /// A call's row: its state, `Verb: target`, a note at the right.
    func toolSummary(_ entry: ToolEntry, open: Bool, candidates: inout [String]) -> DocParagraph {
        let key = entry.id.raw
        let state = workState(entry)
        var runs: [DocRun] = [
            DocRun("", Self.style { $0.size = 0.9 }, tooltip: WorkStateWords.label(state), inline: .status(state)),
            DocRun(" "),
        ]
        let title = entry.title as NSString
        let colon = title.range(of: ": ")
        let titleSize = 0.92
        if colon.location == NSNotFound || colon.location == 0 {
            runs.append(DocRun(entry.title, Self.style { $0.size = titleSize; $0.ink = .secondary }))
        } else {
            runs.append(DocRun(title.substring(to: colon.location + 1), Self.style { $0.size = titleSize; $0.ink = .primary; $0.bold = true }))
            runs.append(DocRun(" ", Self.style { $0.size = titleSize }))
            let target = title.substring(from: colon.location + 2)
            let made = LinkedText.runs(target, Self.style { $0.size = titleSize * 0.95; $0.mono = true; $0.ink = .secondary }, links)
            runs += made.runs
            candidates += made.candidates
        }
        runs.append(DocRun(" ", Self.style { $0.size = titleSize }))
        runs.append(DocRun("", Self.style { $0.ink = .tertiary }, inline: .chevron(open: open, quietUntilHover: true)))
        if entry.outsideSandbox {
            runs.append(DocRun(" ", Self.style { $0.size = 0.72 }))
            runs.append(DocRun("unsandboxed", Self.style { $0.size = 0.72; $0.chip = .sandbox; $0.ink = .waiting }, tooltip: "Ran outside the sandbox"))
        }
        var row = Self.paragraph(key + "/summary", runs, lineHeight: 1.6)
        row.oneLine = true
        row.hover = true
        row.action = .toggle(EntryFold.tool(entry.id))
        if let note = WorkStateWords.note(entry) {
            let failed = state == .failed || state == .denied
            row.trailing = [DocRun(note, Self.style { $0.size = 0.8; $0.ink = failed ? .statusError : .tertiary })]
        }
        return row
    }

    static func section(_ key: String, _ words: String, first: Bool) -> DocBlock {
        var row = paragraph(key, [DocRun(words, style { $0.size = 0.75; $0.bold = true; $0.ink = .tertiary; $0.uppercase = true; $0.tracking = 0.04 })],
                            before: space(2), after: space(1))
        row.rule = first ? nil : DocRule(ink: .lineSoft, dashed: false, place: .top)
        return .paragraph(row)
    }

    func toolBody(_ entry: ToolEntry, candidates: inout [String]) -> DocBlock {
        let key = entry.id.raw + "/body"
        var children: [DocBlock] = []
        var first = true
        func heading(_ words: String) {
            children.append(Self.section("\(key)/h\(children.count)", words, first: first))
            first = false
        }
        if let plan = entry.plan {
            heading("Plan")
            children.append(checklist(key + "/plan", plan, bordered: false))
        }
        if let asked = entry.asked {
            heading("Questions")
            children += questionRecord(key + "/asked", asked)
        }
        heading("Input")
        children.append(.paragraph(Self.pre(key + "/input", Self.jsonText(entry.input), candidates: &candidates)))
        let output = (entry.output ?? []).filter { if case .image = $0 { return false }; return true }
        if !output.isEmpty {
            heading("Output")
            for (index, part) in output.enumerated() {
                children += outputPart("\(key)/o\(index)", part, heading: { words in
                    children.append(Self.section("\(key)/o\(index)/h", words, first: false))
                }, candidates: &candidates)
            }
        }
        // Each block under a section is padded below (`.conversation-json`, `.conversation-output-note`).
        children = children.map { block in
            guard case .paragraph(var paragraph) = block, paragraph.rule == nil, paragraph.after == 0 else { return block }
            paragraph.after = Self.space(2)
            return .paragraph(paragraph)
        }
        return .box(Self.box(key, .toolBody, children, before: Self.space(1), after: Self.space(2), indent: 1.45))
    }

    /// A bare string as itself; anything else as JSON, two spaces deep (`JsonView`).
    public static func jsonText(_ value: JsonValue) -> String {
        if case .string(let text) = value { return text }
        return value.jsonText(indent: 2)
    }

    func outputPart(_ key: String, _ part: ToolOutputPart, heading: (String) -> Void, candidates: inout [String]) -> [DocBlock] {
        let note = Self.style { $0.size = 0.85; $0.ink = .secondary }
        switch part {
        case .text(let text):
            return [.paragraph(Self.pre(key, text, linked: links, candidates: &candidates))]
        case .image(let image):
            return imageStrip(key, [image])
        case .reference(let name):
            return [.paragraph(Self.paragraph(key, [
                DocRun("Loaded the tool ", note),
                DocRun(name, note.with { $0.mono = true; $0.size = 0.85 * 0.88; $0.chip = .code }),
            ]))]
        case let .command(exitCode, output, stderr, interrupted):
            var out: [DocBlock] = []
            if !output.isEmpty { out.append(.paragraph(Self.pre(key + "/out", output, linked: links, candidates: &candidates))) }
            if let stderr {
                out.append(Self.section(key + "/stderr-h", "Stderr", first: false))
                out.append(.paragraph(Self.pre(key + "/stderr", stderr, ink: .danger, linked: links, candidates: &candidates)))
            }
            if interrupted {
                out.append(.paragraph(Self.paragraph(key + "/interrupted", [DocRun("Interrupted", note.with { $0.ink = .danger })])))
            }
            if let exitCode {
                let failed = exitCode != 0
                out.append(.paragraph(Self.paragraph(key + "/exit", [DocRun("Exit code \(Self.number(exitCode))", note.with { $0.ink = failed ? .danger : .secondary })])))
            }
            return out
        case let .persisted(words, path, preview):
            var runs = [DocRun(words, note)]
            if let path, !words.contains(path) {
                runs.append(DocRun(" ", note))
                let made = LinkedText.runs(path, note.with { $0.mono = true; $0.size = 0.85 * 0.88; $0.chip = .code }, links)
                runs += made.runs
                candidates += made.candidates
            }
            var out: [DocBlock] = [.paragraph(Self.paragraph(key + "/note", runs, before: Self.space(2)))]
            if !preview.isEmpty { out.append(.paragraph(Self.pre(key + "/preview", preview, linked: links, candidates: &candidates))) }
            return out
        }
    }

    static func number(_ value: Double) -> String {
        value == value.rounded() && abs(value) < 1e15 ? String(Int(value)) : String(value)
    }

    /// What a call asked the person, kept for reference once answered.
    func questionRecord(_ key: String, _ asked: [AskedQuestion]) -> [DocBlock] {
        var out: [DocBlock] = []
        for (index, item) in asked.enumerated() {
            let question = item.question, answer = item.answer
            let at = "\(key)/\(index)"
            let chosen = answer.secret ? [] : answer.chosen
            var children: [DocBlock] = []
            if !question.header.isEmpty {
                children.append(.paragraph(Self.paragraph(at + "/header", [
                    DocRun(question.header, Self.style { $0.size = 0.75; $0.bold = true; $0.chip = .questionHeader; $0.ink = .accentInk }),
                ], after: Self.space(1))))
            }
            children.append(.paragraph(Self.paragraph(at + "/words", [DocRun(question.text, Self.style { $0.medium = true })], after: Self.space(2))))
            func option(_ id: String, _ label: String, _ description: String, picked: Bool) {
                var row = Self.paragraph(id, [DocRun(label)])
                row.marker = DocRun("", inline: .optionMark(multiple: question.multiSelect, picked: picked))
                row.indent = 1.6
                children.append(.paragraph(row))
                if !description.isEmpty {
                    var line = Self.paragraph(id + "/d", [DocRun(description, Self.style { $0.size = 0.85; $0.ink = .tertiary })], after: Self.space(1))
                    line.indent = 1.6
                    line.oneLine = true
                    children.append(.paragraph(line))
                }
            }
            for (row, choice) in question.options.enumerated() {
                option("\(at)/o\(row)", choice.label, choice.description, picked: chosen.contains(choice.label))
            }
            if let written = answer.written, !answer.secret {
                option(at + "/written", written, "Written instead", picked: true)
            }
            let quiet = Self.style { $0.size = 0.85; $0.ink = .secondary }
            if answer.secret {
                children.append(.paragraph(Self.paragraph(at + "/note", [DocRun("Answer hidden", quiet)], before: Self.space(1))))
            } else if let notes = answer.notes {
                children.append(.paragraph(Self.paragraph(at + "/note", [DocRun("Note: \(notes)", quiet)], before: Self.space(1))))
            }
            // Beside a single-select question with previews, the resting option's preview.
            if !question.multiSelect, question.options.contains(where: { $0.preview != nil }) {
                let shownLabel = chosen.first ?? question.options.first?.label
                if let shown = question.options.first(where: { $0.label == shownLabel }) {
                    children.append(.box(preview(at + "/preview", shown)))
                }
            }
            out.append(.box(Self.box(at, .plain, children, before: index == 0 ? 0 : Self.space(3))))
        }
        return [.box(Self.box(key, .plain, out, before: Self.space(1), after: Self.space(2), indent: SurfaceMetrics.em(12)))]
    }

    /// An option's preview, in its monospace box.
    func preview(_ key: String, _ option: QuestionOption) -> DocBox {
        guard let source = option.preview else {
            return Self.box(key, .preview, [.paragraph(Self.paragraph(key + "/none", [DocRun("No preview", Self.style { $0.ink = .tertiary; $0.size = 0.85 })]))], before: Self.space(2))
        }
        var builder = MarkdownDocumentBuilder(links: links, settled: true, keyPrefix: key)
        builder.size = 0.85
        builder.preformatted = true
        let blocks = builder.document(MarkdownStreaming.keepIndentation(source))
        return Self.box(key, .preview, blocks, before: Self.space(2))
    }

    /// The images a call gave back, drawn on the call rather than folded into its output.
    static func outputImages(_ entry: ToolEntry) -> [ImageRef] {
        (entry.output ?? []).compactMap { if case .image(let image) = $0 { return image }; return nil }
    }

    /// Each file's change: its path over its lines, numbered where the diff says.
    func diffView(_ key: String, _ files: [FileDiff], candidates: inout [String]) -> DocBlock {
        var children: [DocBlock] = []
        for (index, file) in files.enumerated() {
            let at = "\(key)/f\(index)"
            let rows = DiffRows.of(file.unifiedDiff)
            let line = DiffRows.firstNewLine(rows)
            let range = line.map { FileRange.line(line: $0, column: 1) }
            let pathStyle = Self.style { $0.mono = true; $0.size = 0.85; $0.ink = .secondary }
            let shown = DiffRows.shownPath(file.path, cwd: links.cwd)
            candidates.append(file.path)
            var pathRun = DocRun(shown, pathStyle, tooltip: file.path)
            if case .file(let resolved)? = links.file(links.cwd, file.path) {
                pathRun = DocRun(shown, pathStyle.with { $0.ink = .accent; $0.underline = true },
                                 link: .file(path: resolved, range: range),
                                 tooltip: "Open \(resolved)\(TextLinks.rangeSuffix(range)) in the editor")
            }
            var path = Self.paragraph(at + "/path", [pathRun], before: Self.space(1), after: Self.space(1), lineHeight: 1.6)
            path.indent = Self.space(3)
            path.rule = DocRule(ink: .lineSoft, dashed: false, place: .bottom)
            children.append(.paragraph(path))
            let width = max(3, rows.reduce(0) { max($0, String($1.old ?? 0).count, String($1.new ?? 0).count) })
            func pad(_ value: Int?) -> String {
                let text = value.map(String.init) ?? ""
                return String(repeating: " ", count: max(0, width - text.count)) + text
            }
            let mono = Self.style { $0.mono = true; $0.size = 0.88 }
            var lines: [DocBlock] = []
            for (number, row) in rows.enumerated() {
                let numbers = Self.style { $0.mono = true; $0.size = 0.88; $0.ink = .tertiary; $0.control = true }
                var paragraph = Self.paragraph("\(at)/l\(number)", [
                    DocRun(" " + pad(row.old) + "  " + pad(row.new) + "  ", numbers),
                    DocRun(row.text, row.kind == .hunk ? mono.with { $0.ink = .secondary } : mono),
                ], lineHeight: 1.5)
                switch row.kind {
                case .add: paragraph.band = .add
                case .remove: paragraph.band = .remove
                default: break
                }
                // A long line wraps under itself, past its numbers.
                paragraph.indent = 0
                lines.append(.paragraph(paragraph))
            }
            children.append(.box(Self.box(at + "/lines", .plain, lines, before: Self.space(1), after: Self.space(1))))
        }
        return .box(Self.box(key, .diff, children))
    }

    /// A call's readable view, under its row and outside its fold, cut to a height.
    func readableView(_ entry: ToolEntry, planShown: Bool, candidates: inout [String]) -> [DocBlock] {
        let images = Self.outputImages(entry)
        let plan = planShown ? entry.plan : nil
        if entry.change == nil && plan == nil && images.isEmpty { return [] }
        let key = entry.id.raw + "/readable"
        var children: [DocBlock] = []
        if let change = entry.change { children.append(diffView(key + "/diff", change, candidates: &candidates)) }
        if let plan { children.append(checklist(key + "/plan", plan, bordered: true)) }
        children += imageStrip(key + "/images", images)
        var box = Self.box(key, .plain, MarkdownDocumentBuilder.collapse(children), before: Self.space(1), after: Self.space(2))
        let id = EntryFold.readable(entry.id)
        box.clip = DocClip(id: id, open: state.allOpen || state.openClips.contains(id))
        return [.box(box)]
    }

    func toolView(_ entry: ToolEntry, depth: Int) -> (blocks: [DocBlock], candidates: [String]) {
        let key = entry.id.raw
        var candidates: [String] = []
        var out: [DocBlock] = []
        let fold = EntryFold.tool(entry.id)
        let open = state.open(fold)
        var call = Self.box(key + "/call", .plain, [.paragraph(toolSummary(entry, open: open, candidates: &candidates))])
        if open { call.children.append(toolBody(entry, candidates: &candidates)) }
        call.fold = fold
        call.open = open
        if entry.outsideSandbox { call.style = .plain }
        out.append(.box(call))
        out += readableView(entry, planShown: tree.latestPlan == entry.id, candidates: &candidates)
        if let summary = entry.background?.summary, !summary.isEmpty {
            var line = Self.paragraph(key + "/background", [DocRun(summary, Self.style { $0.size = 0.8; $0.ink = .tertiary })])
            line.oneLine = true
            line.indent = Self.space(3)
            out.append(.paragraph(line))
        }
        out += denialLine(entry)
        for request in tree.requests[entry.id] ?? [] {
            out.append(requestEmbed(request, key: "\(key)/request:\(request.id.raw)"))
        }
        if let spawns = entry.spawns {
            out.append(.box(subagentCard(entry, spawns, depth: depth, candidates: &candidates)))
            let place = state.layout.place(of: entry.id)
            out.append(.embed(DocEmbed(
                key: key + "/subagent-actions",
                kind: .subagentActions(
                    entry: entry.id, label: spawns.label,
                    canBeside: state.layout.wide && !Subagents.ended(spawns.state),
                    beside: place == .beside, canMaximize: place != .beside),
                searchText: "", copyText: "")))
        }
        return (out, candidates)
    }

    func denialLine(_ entry: ToolEntry) -> [DocBlock] {
        guard let denial = entry.denial else { return [] }
        let key = entry.id.raw + "/denial"
        let style = Self.style { $0.size = 0.8; $0.ink = .danger }
        guard let detail = denial.detail else {
            var line = Self.paragraph(key, [DocRun(denial.summary, style)], before: SurfaceMetrics.em(2))
            line.indent = Self.space(3)
            return [.paragraph(line)]
        }
        let fold = EntryFold.denial(entry.id)
        let open = state.open(fold)
        var summary = Self.paragraph(key + "/summary", [
            DocRun(denial.summary, style), DocRun(" ", style),
            DocRun("", style, inline: .chevron(open: open, quietUntilHover: false)),
        ])
        summary.action = .toggle(fold)
        var children: [DocBlock] = [.paragraph(summary)]
        if open {
            children.append(.paragraph(Self.paragraph(key + "/detail", [DocRun(detail, Self.style { $0.size = 0.8; $0.ink = .secondary })], before: Self.space(1))))
        }
        var box = Self.box(key, .plain, children, before: SurfaceMetrics.em(2), indent: Self.space(3))
        box.fold = fold
        box.open = open
        return [.box(box)]
    }

    func subagentCard(_ entry: ToolEntry, _ spawns: SubagentInfo, depth: Int, candidates: inout [String]) -> DocBox {
        let key = entry.id.raw + "/subagent"
        let fold = EntryFold.subagent(entry.id)
        let open = state.open(fold, default: spawns.state == .running)
        var runs = [DocRun(spawns.label, Self.style { $0.bold = true })]
        if let model = spawns.model, !model.isEmpty {
            runs.append(DocRun("  "))
            runs.append(DocRun(model, Self.style { $0.chip = .model; $0.mono = true; $0.size = 0.78; $0.ink = .secondary }))
        }
        var summary = Self.paragraph(key + "/summary", runs)
        summary.action = .toggle(fold)
        summary.trailing = [DocRun("", Self.style { $0.ink = .tertiary }, inline: .chevron(open: open, quietUntilHover: false))]
        var children: [DocBlock] = [.paragraph(summary)]
        if open {
            let place = state.layout.place(of: entry.id)
            if place == .inline {
                var inner: [DocBlock] = []
                if !spawns.prompt.isEmpty {
                    inner.append(.paragraph(Self.paragraph(key + "/prompt", [DocRun(spawns.prompt, Self.style { $0.ink = .secondary; $0.size = 0.92 })], after: Self.space(2))))
                }
                var previous: String?
                for child in tree.children(of: entry.id) {
                    guard let made = blocks(child, depth: depth + 1) else { continue }
                    candidates += made.candidates
                    let kind = Self.kind(child)
                    var group = Self.box(key + "/" + child.id.raw, .plain, made.blocks,
                                         before: DocSection.gap(after: previous, before: kind))
                    group.key = child.id.raw
                    inner.append(.box(group))
                    previous = kind
                }
                if spawns.takesMessages {
                    var message = DocEmbed(key: key + "/message", kind: .subagentMessage(entry: entry.id, label: spawns.label), searchText: "", copyText: "")
                    message.before = Self.space(2)
                    inner.append(.embed(message))
                }
                var entries = Self.box(key + "/entries", .subagentEntries, inner)
                entries.flat = depth + 1 >= MAX_INDENT
                children.append(.box(entries))
            } else {
                children.append(.paragraph(Self.paragraph(key + "/elsewhere", [
                    DocRun(Subagents.elsewhere(place), Self.style { $0.size = 0.9; $0.italic = true; $0.ink = .tertiary }),
                ])))
            }
        }
        var card = Self.box(key, .subagent, children, before: Self.space(1), after: Self.space(2))
        card.fold = fold
        card.open = open
        card.flat = depth >= MAX_INDENT
        return card
    }

    func requestEmbed(_ request: PendingRequest, key: String) -> DocBlock {
        var embed = DocEmbed(key: key, kind: .request(request), searchText: Self.requestText(request), copyText: Self.requestText(request))
        embed.before = Self.space(2)
        return .embed(embed)
    }

    /// What a request's card says it is about, over its form and answers (`Subject`).
    public func requestSubject(_ request: PendingRequest) -> [DocBlock] {
        let key = "request:\(request.id.raw)/subject"
        var unused: [String] = []
        let reasonStyle = Self.style { $0.size = 0.9; $0.ink = .secondary }
        func title(_ words: String) -> DocBlock {
            .paragraph(Self.paragraph(key + "/title", [DocRun(words, Self.style { $0.mono = true; $0.size = 0.92; $0.bold = true })]))
        }
        func reason(_ words: String?) -> [DocBlock] {
            guard let words, !words.isEmpty else { return [] }
            return [.paragraph(Self.paragraph(key + "/reason", [DocRun(words, reasonStyle)], before: Self.space(1), after: Self.space(1)))]
        }
        func panel(_ text: String, _ name: String) -> DocBlock {
            .box(Self.box(key + "/" + name, .sunkenPanel, [.paragraph(Self.pre(key + "/" + name + "/text", text, candidates: &unused))], before: Self.space(2)))
        }
        switch request.subject {
        case let .tool(_, words, input, why):
            return [title(words), panel(Self.jsonText(input), "input")] + reason(why)
        case let .command(command, cwd, why):
            return [panel(command, "command"),
                    .paragraph(Self.paragraph(key + "/cwd", [DocRun("in \(cwd)", reasonStyle)], before: Self.space(1), after: Self.space(1)))]
                + reason(why)
        case .fileChange(let files):
            var diff = diffView(key + "/diff", files, candidates: &unused)
            if case .box(var box) = diff {
                box.before = Self.space(2)
                diff = .box(box)
            }
            return [diff]
        case .question:
            return []
        case let .elicitation(server, message, url, _):
            var out = [title(server)] + reason(message)
            if let url {
                out.append(.paragraph(Self.paragraph(key + "/url", [DocRun(url, Self.style { $0.size = 0.9; $0.ink = .accent; $0.underline = true }, link: .url(url))], before: Self.space(1), after: Self.space(1))))
            }
            return out
        }
    }

    /// An option's preview as a question shows it beside its options: Markdown in the monospace box.
    public func optionPreview(_ key: String, _ option: QuestionOption) -> DocBlock {
        .box(preview(key, option))
    }

    /// The words of a request's card a find reaches.
    public static func requestText(_ request: PendingRequest) -> String {
        var parts: [String] = []
        switch request.subject {
        case let .tool(_, title, input, reason):
            parts += [title, jsonText(input)] + (reason.map { [$0] } ?? [])
        case let .command(command, cwd, reason):
            parts += [command, "in \(cwd)"] + (reason.map { [$0] } ?? [])
        case .fileChange(let files):
            for file in files { parts += [file.path, file.unifiedDiff] }
        case .question(let questions):
            for question in questions {
                parts += [question.header, question.text].filter { !$0.isEmpty }
                for option in question.options { parts += [option.label, option.description].filter { !$0.isEmpty } }
            }
        case let .elicitation(server, message, url, _):
            parts += [server, message] + (url.map { [$0] } ?? [])
        }
        parts += request.choices.map(\.label)
        return parts.joined(separator: BLOCK_BREAK)
    }

    // MARK: The CLI's own

    func commandView(_ entry: CommandEntry) -> [DocBlock] {
        let key = entry.id.raw
        var out: [DocBlock] = [.paragraph(Self.paragraph(key + "/line", [
            DocRun(entry.line ?? "Command output", Self.style { $0.mono = true; $0.size = 0.92; $0.ink = .secondary }),
        ]))]
        if let output = entry.output, !output.isEmpty {
            let text = Self.paragraph(key + "/output", [DocRun(output, Self.style { $0.mono = true; $0.size = 0.92 * 0.9; $0.ink = entry.failed ? .danger : .secondary })], lineHeight: 1.6)
            out.append(.box(Self.box(key + "/rail", entry.failed ? .railDanger : .rail, [.paragraph(text)], before: Self.space(1))))
        }
        return out
    }

    func compactionView(_ entry: CompactionEntry) -> [DocBlock] {
        var line = Self.paragraph(entry.id.raw + "/line", [DocRun(EntryWords.compaction(entry), Self.style { $0.size = 0.8; $0.ink = .tertiary })])
        line.align = .center
        line.rule = DocRule(ink: .lineSoft, dashed: false)
        return [.paragraph(line)]
    }

    func compacting() -> DocSection {
        var line = Self.paragraph("compacting/line", [DocRun(EntryWords.compacting, Self.style { $0.size = 0.8; $0.ink = .tertiary })])
        line.align = .center
        line.rule = DocRule(ink: .lineSoft, dashed: true)
        return DocSection(id: "compacting", kind: "compacting", blocks: [.paragraph(line)])
    }

    func rawFold(_ entry: NoticeEntry, size: Double) -> [DocBlock] {
        guard let raw = entry.raw else { return [] }
        let key = entry.id.raw + "/raw"
        let fold = EntryFold.raw(entry.id)
        let open = state.open(fold)
        let style = Self.style { $0.size = size; $0.ink = .tertiary }
        var summary = Self.paragraph(key + "/summary", [
            DocRun(EntryWords.eventAsReceived, style), DocRun(" ", style),
            DocRun("", style, inline: .chevron(open: open, quietUntilHover: false)),
        ])
        summary.action = .toggle(fold)
        var children: [DocBlock] = [.paragraph(summary)]
        var unused: [String] = []
        if open { children.append(.paragraph(Self.pre(key + "/json", Self.jsonText(raw), candidates: &unused))) }
        var box = Self.box(key, .plain, children)
        box.fold = fold
        box.open = open
        return [.box(box)]
    }

    func noticeView(_ entry: NoticeEntry) -> [DocBlock] {
        let key = entry.id.raw
        if entry.level == .info {
            // One quiet line, whatever the CLI reports; what it was is behind its fold.
            return [.paragraph(Self.paragraph(key + "/text", [DocRun(entry.text, Self.style { $0.size = 0.8; $0.ink = .tertiary })]))]
                + rawFold(entry, size: 0.8)
        }
        let text = Self.paragraph(key + "/text", [DocRun(entry.text, Self.style { $0.size = 0.9; $0.ink = .primary })])
        return [.box(Self.box(key + "/notice", entry.level == .error ? .noticeError : .noticeWarning,
                              [.paragraph(text)] + rawFold(entry, size: 0.9 * 0.9)))]
    }

    func turnEndView(_ entry: TurnEndEntry, _ label: String) -> [DocBlock] {
        let ink: DocInk = entry.outcome == .failed ? .danger : .waiting
        var facts = Self.paragraph(entry.id.raw + "/facts", [DocRun(label, Self.style { $0.size = 0.75; $0.ink = ink })])
        facts.align = .center
        facts.rule = DocRule(ink: .lineSoft, dashed: false)
        var out: [DocBlock] = [.paragraph(facts)]
        if let detail = entry.detail, !detail.isEmpty {
            var line = Self.paragraph(entry.id.raw + "/detail", [DocRun(detail, Self.style { $0.size = 0.75; $0.ink = .secondary })])
            line.align = .center
            out.append(.paragraph(line))
        }
        return out
    }

    // MARK: The surface's own lines

    /// A message written to the Agent that its CLI has not taken yet.
    func sending(_ message: SendingMessage) -> DocSection {
        let key = "sending:\(message.id)"
        let words: [DocBlock] = message.text.isEmpty ? [] : [.paragraph(Self.paragraph(key + "/text", [DocRun(message.text)]))]
        var blocks = personBubble(key, origin: EntryWords.originNote(message.origin), words, dashed: message.origin == .injection)
        blocks += imageStrip(key + "/images", message.images)
        var wrapper = Self.box(key + "/user", .plain, blocks)
        wrapper.tooltip = EntryWords.sending
        var section = DocSection(id: key, kind: "user", blocks: [.box(wrapper)])
        section.dimmed = true
        return section
    }

    func limitResume(_ resume: LimitResume) -> DocSection {
        let (text, level, action) = EntryWords.limitResumeLine(resume, now: state.now, timeZone: state.timeZone)
        let runs = [
            DocRun(text, Self.style { $0.size = level == .info ? 0.8 : 0.9; $0.ink = level == .info ? .tertiary : .primary }),
            DocRun("  ", Self.style { $0.size = 0.8 }),
            DocRun(action, Self.style { $0.size = level == .info ? 0.8 : 0.9; $0.ink = .secondary; $0.underline = true; $0.control = true }, action: .cancelLimitResume),
        ]
        let line = Self.paragraph("limit-resume/line", runs)
        if level == .info {
            return DocSection(id: "limit-resume", kind: "limit-resume", blocks: [.paragraph(line)])
        }
        return DocSection(id: "limit-resume", kind: "limit-resume", blocks: [.box(Self.box("limit-resume/notice", .noticeWarning, [.paragraph(line)]))])
    }
}

extension EntryDocumentBuilder {
    /// The find bar's sections: each drawn section's text with every fold open.
    public static func searchSections(_ transcript: Transcript, tree: EntryTree? = nil, state: EntryDocumentState, pane: ToolEntry? = nil) -> (sections: [SearchSection], documents: [DocSection]) {
        var open = state
        open.allOpen = true
        let builder = EntryDocumentBuilder(transcript: transcript, tree: tree, state: open)
        let documents = pane.map { builder.paneSections($0) } ?? builder.sections(activity: false)
        return (documents.map { SearchSection(id: $0.id, text: $0.search.text) }, documents)
    }
}

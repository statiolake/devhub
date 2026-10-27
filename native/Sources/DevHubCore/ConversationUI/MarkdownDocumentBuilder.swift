// Port of apps/desktop/src/shell/conversation/Markdown.tsx (and what
// remark-rehype and conversation.css make of an answer's mdast).
//
// An answer's Markdown, as blocks of the drawn conversation. Raw HTML is not
// drawn at all (`skipHtml`). A path in the prose or in inline code that names
// a file on the Agent's machine is a link to it, and so is an Issue or pull
// request reference (`TextLinks`); one in a fenced block is code and is left
// alone. Only a settled document is looked through: a path still being
// written would be asked about one keystroke at a time.
//
// While the answer streams, its source is drawn as two documents: the settled
// prefix and the tail, which is parsed again on every delta and whose code is
// not coloured (`MarkdownStreaming`). Once it has finished it is drawn as the
// one document it is.

import Foundation

/// What a builder needs to know to draw links.
public struct LinkContext: Sendable {
    /// The directory a relative path is relative to.
    public var cwd: String?
    /// Where a bare `#12` is numbered.
    public var issues: IssueRepository?
    /// What the path-link store says of a candidate: a file, none, or not yet asked.
    public var file: @Sendable (_ cwd: String?, _ path: String) -> PathLinks.Known?

    public init(cwd: String?, issues: IssueRepository?, file: @escaping @Sendable (String?, String) -> PathLinks.Known?) {
        self.cwd = cwd
        self.issues = issues
        self.file = file
    }

    public static let none = LinkContext(cwd: nil, issues: nil, file: { _, _ in nil })
}

/// A paragraph's runs being made, and the candidates they named.
struct RunCollector {
    var runs: [DocRun] = []
    var candidates: [String] = []

    mutating func append(_ run: DocRun) {
        if run.text.isEmpty && run.inline == nil { return }
        if let last = runs.last, last.style == run.style, last.link == run.link, last.action == run.action,
           last.tooltip == run.tooltip, last.inline == nil, run.inline == nil
        {
            runs[runs.count - 1].text += run.text
        } else {
            runs.append(run)
        }
    }
}

public struct LinkedText {
    /// `text` with its links drawn (`LinkedText`): each path that names a file
    /// and each Issue or pull request reference; the candidates it holds.
    static func runs(_ text: String, _ style: DocStyle, _ links: LinkContext, into collector: inout RunCollector) {
        let spans = TextLinks.spans(text)
        if spans.isEmpty {
            collector.append(DocRun(text, style))
            return
        }
        let ns = text as NSString
        var at = 0
        for span in spans {
            if span.start > at { collector.append(DocRun(ns.substring(with: NSRange(location: at, length: span.start - at)), style)) }
            let shown = ns.substring(with: NSRange(location: span.start, length: span.end - span.start))
            switch span {
            case let .path(candidate, _, _):
                collector.candidates.append(candidate.path)
                if case .file(let file)? = links.file(links.cwd, candidate.path) {
                    collector.append(DocRun(
                        shown, style.with { $0.ink = .accent; $0.underline = true },
                        link: .file(path: file, range: candidate.range),
                        tooltip: "Open \(file)\(TextLinks.rangeSuffix(candidate.range)) in the editor"))
                } else {
                    collector.append(DocRun(shown, style))
                }
            case let .issue(reference, _, _):
                if let url = IssueRepository.url(reference, links.issues) {
                    collector.append(DocRun(
                        shown, style.with { $0.ink = .accent; $0.underline = true },
                        link: .issue(url: url, title: IssueRepository.title(reference, links.issues)),
                        tooltip: IssueRepository.tooltip(reference, links.issues)))
                } else {
                    collector.append(DocRun(shown, style))
                }
            }
            at = span.end
        }
        if at < ns.length { collector.append(DocRun(ns.substring(from: at), style)) }
    }

    /// The text as one paragraph's runs.
    public static func runs(_ text: String, _ style: DocStyle = .plain, _ links: LinkContext) -> (runs: [DocRun], candidates: [String]) {
        var collector = RunCollector()
        runs(text, style, links, into: &collector)
        return (collector.runs, collector.candidates)
    }
}

public struct MarkdownDocumentBuilder {
    public var links: LinkContext
    /// Whether code blocks are coloured and links looked for (a settled document).
    public var settled: Bool
    /// Every key is made under this prefix.
    public var keyPrefix: String
    /// The base size of the document's text, in em (a preview is 0.85).
    public var size: Double = 1
    /// Whether to draw in the preview's monospace, lines as written.
    public var preformatted = false
    private(set) var candidates: [String] = []
    private var footnoteOrder: [String] = []
    private var footnoteCalls: [String: Int] = [:]
    private var counter = 0

    public init(links: LinkContext, settled: Bool, keyPrefix: String) {
        self.links = links
        self.settled = settled
        self.keyPrefix = keyPrefix
    }

    private mutating func key(_ kind: String) -> String {
        counter += 1
        return "\(keyPrefix)/\(kind)\(counter)"
    }

    /// An answer's source, drawn: one document, or (streaming) the settled
    /// prefix and the tail; and the path candidates it names.
    public static func blocks(_ source: String, streaming: Bool, links: LinkContext, keyPrefix: String) -> (blocks: [DocBlock], candidates: [String]) {
        if !streaming {
            var builder = MarkdownDocumentBuilder(links: links, settled: true, keyPrefix: keyPrefix)
            let blocks = builder.document(source)
            return (blocks, builder.candidates)
        }
        let split = MarkdownStreaming.settledEnd(source)
        var out: [DocBlock] = []
        var candidates: [String] = []
        if split > source.startIndex {
            var settled = MarkdownDocumentBuilder(links: links, settled: true, keyPrefix: keyPrefix + "/s")
            out += settled.document(String(source[..<split]))
            candidates = settled.candidates
        }
        var tail = MarkdownDocumentBuilder(links: links, settled: false, keyPrefix: keyPrefix + "/t")
        var tailBlocks = tail.document(String(source[split...]))
        // While it grows, a caret at its end (`data-streaming`).
        if !appendDot(&tailBlocks) {
            tailBlocks.append(.paragraph(DocParagraph(key: keyPrefix + "/dot", runs: [DocRun("", inline: .streamingDot)])))
        }
        out += tailBlocks
        return (Self.collapse(out), candidates)
    }

    /// The dot after the last paragraph, heading or list item.
    static func appendDot(_ blocks: inout [DocBlock]) -> Bool {
        guard let last = blocks.last else { return false }
        switch last {
        case .paragraph(var paragraph):
            paragraph.runs.append(DocRun("", inline: .streamingDot))
            blocks[blocks.count - 1] = .paragraph(paragraph)
            return true
        case .box(var box) where box.style == .plain:
            if appendDot(&box.children) {
                blocks[blocks.count - 1] = .box(box)
                return true
            }
            return false
        default:
            return false
        }
    }

    /// The whole document's blocks.
    public mutating func document(_ source: String) -> [DocBlock] {
        let parsed = MarkdownParser.parse(MarkdownStreaming.normalizeMath(source))
        // Footnotes: numbered by first call, as remark-rehype numbers them.
        var definitions: [String: [MarkdownBlock]] = [:]
        for block in parsed.blocks {
            if case let .footnoteDefinition(label, children) = block { definitions[label] = children }
        }
        var blocks = parsed.blocks.flatMap { self.block($0, parsed.definitions, depth: 0) }
        let called = footnoteOrder.filter { definitions[$0] != nil }
        if !called.isEmpty {
            var items: [DocBlock] = [
                .paragraph(withMargins(
                    DocParagraph(key: key("fnh"), runs: [DocRun("Footnotes", headingStyle(2))]),
                    before: 1.4 * 1.22, after: 0.5 * 1.22, lineHeight: 1.3)),
            ]
            for (index, label) in called.enumerated() {
                var inner = (definitions[label] ?? []).flatMap { self.block($0, parsed.definitions, depth: 1) }
                // The way back, after the note's last paragraph.
                let back = DocRun(" ↩", DocStyle().with { $0.ink = .accent }, link: .footnote("ref-" + label), tooltip: "Back to reference \(index + 1)")
                if case .paragraph(var last)? = inner.last {
                    last.runs.append(back)
                    inner[inner.count - 1] = .paragraph(last)
                } else {
                    inner.append(.paragraph(DocParagraph(key: key("fnb"), runs: [back])))
                }
                var item = DocBox(key: "fn-" + label, style: .plain, children: inner)
                item.indent = 1.5
                if case .paragraph(var first)? = item.children.first {
                    first.marker = DocRun("\(index + 1).", DocStyle().with { $0.ink = .tertiary })
                    item.children[0] = .paragraph(first)
                }
                items.append(.box(item))
            }
            var footnotes = DocBox(key: key("fns"), style: .footnotes, children: items)
            footnotes.before = 0.75
            blocks.append(.box(footnotes))
        }
        return Self.collapse(blocks)
    }

    // MARK: Margins

    func withMargins(_ paragraph: DocParagraph, before: Double, after: Double, lineHeight: Double = 1.6) -> DocParagraph {
        var next = paragraph
        next.before = before
        next.after = after
        next.lineHeight = lineHeight
        return next
    }

    /// CSS's collapsing margins between siblings, and none at the document's
    /// ends (`> :first-child { margin-top: 0 }`).
    public static func collapse(_ blocks: [DocBlock]) -> [DocBlock] {
        var out = blocks
        func margins(_ block: DocBlock) -> (Double, Double) {
            switch block {
            case .paragraph(let p): return (p.before, p.after)
            case .box(let b): return (b.before, b.after)
            case .embed(let e): return (e.before, e.after)
            }
        }
        func set(_ index: Int, before: Double? = nil, after: Double? = nil) {
            switch out[index] {
            case .paragraph(var p):
                if let before { p.before = before }
                if let after { p.after = after }
                out[index] = .paragraph(p)
            case .box(var b):
                if let before { b.before = before }
                if let after { b.after = after }
                out[index] = .box(b)
            case .embed(var e):
                if let before { e.before = before }
                if let after { e.after = after }
                out[index] = .embed(e)
            }
        }
        guard !out.isEmpty else { return out }
        set(0, before: 0)
        set(out.count - 1, after: 0)
        for index in 1..<max(1, out.count) where index < out.count {
            let gap = max(margins(out[index - 1]).1, margins(out[index]).0)
            set(index - 1, after: 0)
            set(index, before: gap)
        }
        return out
    }

    // MARK: Blocks

    func headingStyle(_ depth: Int) -> DocStyle {
        DocStyle().with {
            $0.bold = true
            $0.tracking = -0.005
            $0.size = depth == 1 ? 1.4 : depth == 2 ? 1.22 : depth == 3 ? 1.08 : 1
            if depth == 6 { $0.ink = .secondary }
        }
    }

    var bodyStyle: DocStyle {
        DocStyle().with {
            $0.size = size
            $0.mono = preformatted
        }
    }

    mutating func block(_ block: MarkdownBlock, _ definitions: [String: MarkdownDefinition], depth: Int, tight: Bool = false) -> [DocBlock] {
        switch block {
        case .paragraph(let inlines):
            var collector = RunCollector()
            var images: [DocBlock] = []
            self.inlines(inlines, bodyStyle, definitions, into: &collector, images: &images)
            candidates += collector.candidates
            var out: [DocBlock] = []
            if !collector.runs.isEmpty {
                let margin = tight ? 0 : 0.75
                out.append(.paragraph(withMargins(DocParagraph(key: key("p"), runs: collector.runs), before: margin, after: margin)))
            }
            return out + images
        case let .heading(depth, inlines):
            var collector = RunCollector()
            var images: [DocBlock] = []
            let style = headingStyle(depth)
            self.inlines(inlines, style, definitions, into: &collector, images: &images)
            candidates += collector.candidates
            return [.paragraph(withMargins(
                DocParagraph(key: key("h"), runs: collector.runs), before: 1.4 * style.size, after: 0.5 * style.size,
                lineHeight: 1.3))] + images
        case .thematicBreak:
            var rule = DocEmbed(key: key("hr"), kind: .rule, searchText: "", copyText: "")
            rule.before = 1.5
            rule.after = 1.5
            return [.embed(rule)]
        case .blockquote(let children):
            var box = DocBox(key: key("q"), style: .quote, children: Self.collapse(children.flatMap { self.block($0, definitions, depth: depth + 1) }))
            box.before = 0.75
            box.after = 0.75
            return [.box(box)]
        case let .list(ordered, start, spread, items):
            let loose = spread || items.contains(where: \.spread)
            var out: [DocBlock] = []
            for (index, item) in items.enumerated() {
                var children = item.blocks.flatMap { self.block($0, definitions, depth: depth + 1, tight: !loose) }
                let marker: DocRun
                if let checked = item.checked {
                    marker = DocRun("", inline: .checkbox(checked))
                } else if ordered {
                    marker = DocRun("\((start ?? 1) + index).", DocStyle().with { $0.ink = .tertiary })
                } else {
                    marker = DocRun(depth % 3 == 0 ? "•" : depth % 3 == 1 ? "◦" : "▪", DocStyle().with { $0.ink = .tertiary })
                }
                if children.isEmpty { children = [.paragraph(DocParagraph(key: key("li"), runs: []))] }
                if case .paragraph(var first) = children[0] {
                    first.marker = marker
                    children[0] = .paragraph(first)
                } else {
                    children.insert(.paragraph(DocParagraph(key: key("li"), runs: [])), at: 0)
                    if case .paragraph(var first) = children[0] {
                        first.marker = marker
                        children[0] = .paragraph(first)
                    }
                }
                var box = DocBox(key: key("li"), style: .plain, children: Self.collapse(children))
                box.indent = 1.5
                box.before = index == 0 ? 0 : 0.3
                out.append(.box(box))
            }
            var list = DocBox(key: key("l"), style: .plain, children: out)
            list.before = depth > 0 ? 0.3 : 0.75
            list.after = depth > 0 ? 0 : 0.75
            return [.box(list)]
        case let .code(lang, meta, value):
            if lang?.lowercased() == "math" {
                var math = DocEmbed(key: key("m"), kind: .math(value), searchText: value, copyText: value)
                math.before = 0.6
                math.after = 0.6
                return [.embed(math)]
            }
            let info = [lang, meta].compactMap { $0 }.joined(separator: " ")
            var embed = DocEmbed(
                key: key("c"), kind: .code(language: info.isEmpty ? nil : info, code: value, settled: settled),
                searchText: value, copyText: value)
            embed.before = 0.75
            embed.after = 0.75
            return [.embed(embed)]
        case .html, .definition, .footnoteDefinition:
            return []
        case let .table(align, rows):
            var drawn: [[[DocRun]]] = []
            for row in rows {
                var cells: [[DocRun]] = []
                for index in 0..<align.count {
                    var collector = RunCollector()
                    var images: [DocBlock] = []
                    if index < row.count { inlines(row[index], DocStyle(), definitions, into: &collector, images: &images) }
                    candidates += collector.candidates
                    cells.append(collector.runs)
                }
                drawn.append(cells)
            }
            let text = drawn.map { $0.map { $0.map(\.text).joined() }.joined(separator: "\t") }.joined(separator: "\n")
            var embed = DocEmbed(key: key("t"), kind: .table(align: align, rows: drawn), searchText: drawn.map { $0.map { $0.map(\.text).joined() }.joined(separator: BLOCK_BREAK) }.joined(separator: BLOCK_BREAK), copyText: text)
            embed.before = 0.75
            embed.after = 0.75
            return [.embed(embed)]
        case .math(let value):
            var math = DocEmbed(key: key("m"), kind: .math(value), searchText: value, copyText: value)
            math.before = 0.6
            math.after = 0.6
            return [.embed(math)]
        }
    }

    // MARK: Inlines

    /// HTML's white space: runs of spaces are one, a soft break is a space.
    func collapseSpaces(_ text: String) -> String {
        if preformatted { return text }
        var out = ""
        var space = false
        for scalar in text.unicodeScalars {
            if scalar == " " || scalar == "\t" || scalar == "\n" || scalar == "\r" {
                if !space { out.unicodeScalars.append(" ") }
                space = true
            } else {
                out.unicodeScalars.append(scalar)
                space = false
            }
        }
        return out
    }

    mutating func inlines(_ inlines: [MarkdownInline], _ style: DocStyle, _ definitions: [String: MarkdownDefinition], into collector: inout RunCollector, images: inout [DocBlock], link: DocLink? = nil) {
        for inline in inlines {
            switch inline {
            case .text(let text):
                let text = collapseSpaces(text)
                if settled, link == nil {
                    LinkedText.runs(text, style, links, into: &collector)
                } else {
                    collector.append(DocRun(text, style, link: link))
                }
            case .emphasis(let children):
                self.inlines(children, style.with { $0.italic = true }, definitions, into: &collector, images: &images, link: link)
            case .strong(let children):
                self.inlines(children, style.with { $0.bold = true }, definitions, into: &collector, images: &images, link: link)
            case .delete(let children):
                self.inlines(children, style.with { $0.strike = true }, definitions, into: &collector, images: &images, link: link)
            case .code(let value):
                let code = style.with {
                    $0.mono = true
                    $0.size = style.size * 0.88
                    $0.chip = .code
                }
                let text = collapseSpaces(value)
                if settled, link == nil {
                    LinkedText.runs(text, code, links, into: &collector)
                } else {
                    collector.append(DocRun(text, code, link: link))
                }
            case .hardBreak:
                collector.append(DocRun("\u{2028}", style, link: link))
            case let .link(destination, title, children):
                let target = self.link(destination)
                self.inlines(children, style.with { $0.ink = .accent; $0.underline = true }, definitions, into: &collector, images: &images, link: target)
                if let title, var last = collector.runs.last, last.tooltip == nil {
                    last.tooltip = title
                    collector.runs[collector.runs.count - 1] = last
                }
            case let .linkReference(label, _, children):
                let definition = definitions[label]
                let target = definition.map { self.link($0.destination) }
                self.inlines(children, style.with { $0.ink = .accent; $0.underline = true }, definitions, into: &collector, images: &images, link: target)
            case let .image(source, _, alt):
                images.append(.embed(DocEmbed(key: key("img"), kind: .remoteImage(source: source, alt: alt), searchText: "", copyText: alt)))
            case let .imageReference(label, _, alt):
                if let definition = definitions[label] {
                    images.append(.embed(DocEmbed(key: key("img"), kind: .remoteImage(source: definition.destination, alt: alt), searchText: "", copyText: alt)))
                }
            case .footnoteReference(let label):
                if footnoteCalls[label] == nil {
                    footnoteOrder.append(label)
                    footnoteCalls[label] = footnoteOrder.count
                }
                let number = footnoteCalls[label] ?? 0
                collector.append(DocRun(
                    String(number), style.with { $0.superscript = true; $0.ink = .accent; $0.size = style.size * 0.75 },
                    link: .footnote("fn-" + label)))
            case .html:
                // `skipHtml`: the page does not become whatever markup the model chose to write.
                break
            case .math(let tex):
                collector.append(DocRun(tex, style, link: link, inline: .math(tex)))
            }
        }
    }

    /// A link the Agent gave: a page outside DevHub, or a file in the editor.
    func link(_ destination: String) -> DocLink {
        if let candidate = TextLinks.pathOfHref(destination) { return .href(candidate) }
        return .url(destination)
    }
}

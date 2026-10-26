// The block half of the Markdown parser: CommonMark's parsing strategy (the
// spec's appendix, as cmark implements it), with what `remark-gfm` and
// `remark-math` add to micromark — tables, task list items, footnote
// definitions, `$$` blocks. Inline content is `MarkdownInlineParser`'s.
//
// The TS app parses with micromark (Markdown.tsx); the fixtures under
// Tests/DevHubCoreTests/Fixtures/markdown are micromark's mdast for the
// CommonMark and GFM spec examples, which this parser is held to.

import Foundation

public enum MarkdownParser {
    /// `source` as a document.
    public static func parse(_ source: String) -> MarkdownDocument {
        let parser = BlockParser()
        parser.run(source)
        return parser.document()
    }
}

typealias Scalars = [Unicode.Scalar]

extension Unicode.Scalar {
    var isSpaceOrTab: Bool { self == " " || self == "\t" }
    var isLineEnd: Bool { self == "\n" || self == "\r" }
    var isASCIIDigit: Bool { value >= 0x30 && value <= 0x39 }
    var isASCIILetter: Bool { (value >= 0x41 && value <= 0x5A) || (value >= 0x61 && value <= 0x7A) }
    var isASCIIAlphanumeric: Bool { isASCIIDigit || isASCIILetter }
    /// CommonMark's ASCII punctuation.
    var isASCIIPunctuation: Bool {
        switch value {
        case 0x21...0x2F, 0x3A...0x40, 0x5B...0x60, 0x7B...0x7E: return true
        default: return false
        }
    }
}

// MARK: - Blocks while they are parsed

final class BlockNode {
    enum Kind {
        case document, blockQuote, list, item, paragraph, heading, thematicBreak
        case codeBlock, htmlBlock, table, footnoteDefinition, mathBlock
    }

    struct ListData {
        var ordered = false
        var bulletChar: Unicode.Scalar = "-"
        var delimiter: Unicode.Scalar = "."
        var start = 1
        var padding = 0
        var markerOffset = 0
    }

    var kind: Kind
    var children: [BlockNode] = []
    weak var parent: BlockNode?
    var open = true
    var lastLineBlank = false
    var startLine = 0
    /// The lines a leaf holds, as added.
    var content: [String] = []
    var list = ListData()
    // A heading.
    var level = 0
    var setext = false
    // A code or math block.
    var fenced = false
    var fenceChar: Unicode.Scalar = "`"
    var fenceLength = 0
    var fenceOffset = 0
    var info = ""
    // An HTML block.
    var htmlType = 0
    var htmlClosed = false
    // A table: its alignments and its rows, each row as its cells' raw text.
    var align: [MarkdownAlign?] = []
    var rows: [[String]] = []
    // A footnote definition, or an item's task box.
    var label = ""
    var checked: Bool?

    init(_ kind: Kind, line: Int) {
        self.kind = kind
        startLine = line
    }

    var lastChild: BlockNode? { children.last }

    var acceptsLines: Bool {
        switch kind {
        case .paragraph, .heading, .codeBlock, .htmlBlock, .mathBlock, .table: return true
        default: return false
        }
    }

    func canContain(_ child: Kind) -> Bool {
        switch kind {
        case .document, .blockQuote, .item, .footnoteDefinition:
            return child != .item
        case .list:
            return child == .item
        default:
            return false
        }
    }

    func append(_ child: BlockNode) {
        child.parent = self
        children.append(child)
    }
}

// MARK: - The parser

final class BlockParser {
    let root = BlockNode(.document, line: 0)
    var current: BlockNode
    var lineNumber = 0
    var definitions: [String: MarkdownDefinition] = [:]
    var footnoteLabels: Set<String> = []

    // The line being read, and where in it the parser stands.
    var line: Scalars = []
    var offset = 0
    var column = 0
    var firstNonspace = 0
    var firstNonspaceColumn = 0
    var indent = 0
    var blank = false
    var partiallyConsumedTab = false

    init() { current = root }

    var endsWithNewline = false

    func run(_ source: String) {
        endsWithNewline = source.hasSuffix("\n") || source.hasSuffix("\r")
        var lineStart = source.unicodeScalars.startIndex
        let scalars = source.unicodeScalars
        var index = lineStart
        while index < scalars.endIndex {
            let scalar = scalars[index]
            if scalar == "\n" || scalar == "\r" {
                var next = scalars.index(after: index)
                if scalar == "\r", next < scalars.endIndex, scalars[next] == "\n" { next = scalars.index(after: next) }
                processLine(Array(scalars[lineStart..<index]))
                index = next
                lineStart = next
                continue
            }
            index = scalars.index(after: index)
        }
        if lineStart < scalars.endIndex { processLine(Array(scalars[lineStart..<scalars.endIndex])) }
        while current !== root { current = finalize(current) }
        _ = finalize(root)
    }

    // MARK: Moving along a line

    func peek(_ at: Int) -> Unicode.Scalar? { at < line.count ? line[at] : nil }

    func findFirstNonspace() {
        var chars = 0
        var col = column
        var at = offset
        while at < line.count {
            let c = line[at]
            if c == " " {
                at += 1
                col += 1
                chars += 1
            } else if c == "\t" {
                at += 1
                let width = 4 - (col % 4)
                col += width
                chars += width
            } else {
                break
            }
        }
        firstNonspace = at
        firstNonspaceColumn = col
        indent = firstNonspaceColumn - column
        blank = at >= line.count
    }

    /// Advance by `count` characters, or (`columns`) by `count` columns, a tab split if it must be.
    func advance(_ count: Int, columns: Bool) {
        var count = count
        while count > 0, offset < line.count {
            let c = line[offset]
            if c == "\t" {
                let charsToTab = 4 - (column % 4)
                if columns {
                    partiallyConsumedTab = charsToTab > count
                    let advance = min(count, charsToTab)
                    column += advance
                    offset += partiallyConsumedTab ? 0 : 1
                    count -= advance
                } else {
                    partiallyConsumedTab = false
                    column += charsToTab
                    offset += 1
                    count -= 1
                }
            } else {
                partiallyConsumedTab = false
                offset += 1
                column += 1
                count -= 1
            }
        }
    }

    /// The rest of the line from where the parser stands, a split tab's remainder as spaces.
    func restOfLine() -> String {
        var out = String.UnicodeScalarView()
        var at = offset
        if partiallyConsumedTab {
            at += 1
            let charsToTab = 4 - (column % 4)
            for _ in 0..<charsToTab { out.append(" ") }
        }
        if at < line.count { out.append(contentsOf: line[at...]) }
        return String(out)
    }

    func addLine(to block: BlockNode) {
        block.content.append(restOfLine())
    }

    // MARK: One line

    func processLine(_ scalars: Scalars) {
        // NUL is replaced (CommonMark §2.3).
        line = scalars.map { $0 == "\0" ? "\u{FFFD}" : $0 }
        offset = 0
        column = 0
        blank = false
        partiallyConsumedTab = false
        lineNumber += 1

        var allMatched = false
        guard var container = checkOpenBlocks(&allMatched) else { return }
        let lastMatched = container
        openNewBlocks(&container, allMatched: allMatched)
        addText(container, lastMatched: lastMatched)
    }

    func lastChildIsOpen(_ node: BlockNode) -> Bool { node.lastChild?.open == true }

    /// Every open block the line continues, from the top: the deepest one
    /// it continues, or nil when the line was used up (a closing fence).
    func checkOpenBlocks(_ allMatched: inout Bool) -> BlockNode? {
        allMatched = false
        var container = root
        var shouldContinue = true
        while lastChildIsOpen(container) {
            let child = container.lastChild!
            findFirstNonspace()
            var matched = true
            switch child.kind {
            case .blockQuote:
                matched = parseBlockQuotePrefix()
            case .item:
                matched = parseItemPrefix(child)
            case .footnoteDefinition:
                if indent >= 4 {
                    advance(4, columns: true)
                } else if blank {
                    advance(firstNonspace - offset, columns: false)
                } else {
                    matched = false
                }
            case .codeBlock, .mathBlock:
                matched = parseFencedPrefix(child, &shouldContinue)
            case .heading, .thematicBreak:
                matched = false
            case .htmlBlock:
                matched = !((child.htmlType == 6 || child.htmlType == 7) && blank)
            case .paragraph:
                matched = !blank
            case .table:
                matched = !blank && !interruptsTable()
            case .list, .document:
                matched = true
            }
            if !shouldContinue { return nil }
            if !matched { return container }
            container = child
        }
        allMatched = true
        return container
    }

    func parseBlockQuotePrefix() -> Bool {
        if indent <= 3, peek(firstNonspace) == ">" {
            advance(indent + 1, columns: true)
            if let next = peek(offset), next.isSpaceOrTab { advance(1, columns: true) }
            return true
        }
        return false
    }

    func parseItemPrefix(_ item: BlockNode) -> Bool {
        if indent >= item.list.markerOffset + item.list.padding {
            advance(item.list.markerOffset + item.list.padding, columns: true)
            return true
        }
        if blank, !item.children.isEmpty {
            advance(firstNonspace - offset, columns: false)
            return true
        }
        return false
    }

    func parseFencedPrefix(_ block: BlockNode, _ shouldContinue: inout Bool) -> Bool {
        if block.fenced {
            if indent <= 3, peek(firstNonspace) == block.fenceChar,
               let matched = closingFence(at: firstNonspace, char: block.fenceChar), matched >= block.fenceLength
            {
                shouldContinue = false
                advance(matched, columns: false)
                current = finalize(block)
                return false
            }
            var remaining = block.fenceOffset
            while remaining > 0, let c = peek(offset), c.isSpaceOrTab {
                advance(1, columns: true)
                remaining -= 1
            }
            return true
        }
        // An indented code block.
        if indent >= 4 {
            advance(4, columns: true)
            return true
        }
        if blank {
            advance(firstNonspace - offset, columns: false)
            return true
        }
        return false
    }

    /// The length of a closing fence of `char` at `at`, when the line is one.
    func closingFence(at: Int, char: Unicode.Scalar) -> Int? {
        var end = at
        while end < line.count, line[end] == char { end += 1 }
        let length = end - at
        guard length >= (char == "$" ? 2 : 3) else { return nil }
        var rest = end
        while rest < line.count, line[rest].isSpaceOrTab { rest += 1 }
        return rest == line.count ? length : nil
    }

    /// Whether this line starts a block that ends a table's body.
    func interruptsTable() -> Bool {
        if indent >= 4 { return true }
        let c = peek(firstNonspace)
        if c == ">" { return true }
        if atxHeading(at: firstNonspace) != nil { return true }
        if openingFence(at: firstNonspace) != nil { return true }
        if htmlBlockStart(at: firstNonspace, interruptsParagraph: true) != nil { return true }
        if thematicBreak(at: firstNonspace) { return true }
        if listMarker(at: firstNonspace, interruptsParagraph: false) != nil { return true }
        if mathFence(at: firstNonspace) != nil { return true }
        return false
    }

    // MARK: New blocks

    func openNewBlocks(_ container: inout BlockNode, allMatched: Bool) {
        var maybeLazy = current.kind == .paragraph
        var kind = container.kind
        while kind != .codeBlock && kind != .htmlBlock && kind != .mathBlock {
            findFirstNonspace()
            let indented = indent >= 4
            if !indented, peek(firstNonspace) == ">" {
                advance(firstNonspace + 1 - offset, columns: false)
                if let next = peek(offset), next.isSpaceOrTab { advance(1, columns: true) }
                container = addChild(container, .blockQuote)
            } else if !indented, let level = atxHeading(at: firstNonspace) {
                advance(firstNonspace + level - offset, columns: false)
                container = addChild(container, .heading)
                container.level = level
                container.setext = false
            } else if !indented, let fence = openingFence(at: firstNonspace) {
                container = addChild(container, .codeBlock)
                container.fenced = true
                container.fenceChar = line[firstNonspace]
                container.fenceLength = fence.length
                container.fenceOffset = firstNonspace - offset
                container.info = fence.info
                advance(line.count - offset, columns: false)
            } else if !indented, let fence = mathFence(at: firstNonspace) {
                container = addChild(container, .mathBlock)
                container.fenced = true
                container.fenceChar = "$"
                container.fenceLength = fence.length
                container.fenceOffset = firstNonspace - offset
                container.info = fence.info
                advance(line.count - offset, columns: false)
            } else if !indented,
                      let type = htmlBlockStart(at: firstNonspace, interruptsParagraph: kind == .paragraph)
            {
                container = addChild(container, .htmlBlock)
                container.htmlType = type
            } else if !indented, kind == .paragraph, let level = setextUnderline(at: firstNonspace) {
                if resolveDefinitions(container) {
                    container.kind = .heading
                    container.level = level
                    container.setext = true
                    advance(line.count - offset, columns: false)
                }
            } else if !indented, kind == .paragraph, allMatched, let table = tableStart(container) {
                // The paragraph's last line is the header; what was before it stays a paragraph.
                container = startTable(container, table)
                advance(line.count - offset, columns: false)
            } else if !indented, !(kind == .paragraph && !allMatched), thematicBreak(at: firstNonspace) {
                container = addChild(container, .thematicBreak)
                advance(line.count - offset, columns: false)
            } else if !indented, let footnote = footnoteDefinitionStart(at: firstNonspace) {
                advance(footnote.end - offset, columns: false)
                if let next = peek(offset), next.isSpaceOrTab { advance(1, columns: true) }
                container = addChild(container, .footnoteDefinition)
                container.label = footnote.label
                footnoteLabels.insert(normalizeLabel(footnote.label))
            } else if (!indented || kind == .list), indent < 4,
                      let marker = listMarker(at: firstNonspace, interruptsParagraph: kind == .paragraph)
            {
                advance(firstNonspace + marker.length - offset, columns: false)
                let savedTab = partiallyConsumedTab
                let savedOffset = offset
                let savedColumn = column
                while column - savedColumn <= 5, let c = peek(offset), c.isSpaceOrTab {
                    advance(1, columns: true)
                }
                let spaces = column - savedColumn
                var data = marker.data
                if spaces >= 5 || spaces < 1 || peek(offset) == nil {
                    data.padding = marker.length + 1
                    offset = savedOffset
                    column = savedColumn
                    partiallyConsumedTab = savedTab
                    if spaces > 0 { advance(1, columns: true) }
                } else {
                    data.padding = marker.length + spaces
                }
                data.markerOffset = indent
                if kind != .list || !listsMatch(container.list, data) {
                    container = addChild(container, .list)
                    container.list = data
                }
                container = addChild(container, .item)
                container.list = data
            } else if indented, !maybeLazy, !blank {
                advance(4, columns: true)
                container = addChild(container, .codeBlock)
                container.fenced = false
            } else {
                break
            }
            if container.acceptsLines { break }
            kind = container.kind
            maybeLazy = false
        }
    }

    func listsMatch(_ a: BlockNode.ListData, _ b: BlockNode.ListData) -> Bool {
        a.ordered == b.ordered && a.delimiter == b.delimiter && a.bulletChar == b.bulletChar
    }

    func addChild(_ parent: BlockNode, _ kind: BlockNode.Kind) -> BlockNode {
        var parent = parent
        while !parent.canContain(kind) {
            parent = finalize(parent)
        }
        let child = BlockNode(kind, line: lineNumber)
        parent.append(child)
        return child
    }

    // MARK: Adding the line's text

    func addText(_ container: BlockNode, lastMatched: BlockNode) {
        var container = container
        findFirstNonspace()
        if blank, let last = container.lastChild { last.lastLineBlank = true }
        let kind = container.kind
        let lastLineBlank = blank && kind != .blockQuote && kind != .heading && kind != .thematicBreak
            && !((kind == .codeBlock || kind == .mathBlock) && container.fenced)
            && !(kind == .item && container.children.isEmpty && container.startLine == lineNumber)
        container.lastLineBlank = lastLineBlank
        var walk = container
        while let parent = walk.parent {
            parent.lastLineBlank = false
            walk = parent
        }

        if current !== lastMatched, container === lastMatched, !blank, current.kind == .paragraph {
            // A lazy continuation line.
            advance(firstNonspace - offset, columns: false)
            addLine(to: current)
            return
        }
        while current !== lastMatched {
            current = finalize(current)
        }
        switch container.kind {
        case .codeBlock, .mathBlock:
            addLine(to: container)
        case .htmlBlock:
            addLine(to: container)
            if htmlBlockEnds(container.htmlType) {
                container.htmlClosed = true
                container = finalize(container)
                current = container
            }
        case .table:
            if !blank {
                advance(firstNonspace - offset, columns: false)
                container.rows.append(tableCells(restOfLine()))
            }
        default:
            if blank {
                // Nothing to add.
            } else if container.acceptsLines {
                if container.kind == .heading, !container.setext {
                    chopTrailingHashes()
                }
                advance(firstNonspace - offset, columns: false)
                addLine(to: container)
            } else {
                container = addChild(container, .paragraph)
                advance(firstNonspace - offset, columns: false)
                addLine(to: container)
            }
        }
        current = container
    }

    func chopTrailingHashes() {
        var end = line.count
        while end > offset, line[end - 1].isSpaceOrTab { end -= 1 }
        var hashes = end
        while hashes > offset, line[hashes - 1] == "#" { hashes -= 1 }
        if hashes == end { line = Array(line[..<end]); return }
        if hashes == offset || line[hashes - 1].isSpaceOrTab {
            var cut = hashes
            while cut > offset, line[cut - 1].isSpaceOrTab { cut -= 1 }
            line = Array(line[..<cut])
        } else {
            line = Array(line[..<end])
        }
    }

    // MARK: Finishing blocks

    @discardableResult
    func finalize(_ block: BlockNode) -> BlockNode {
        let parent = block.parent ?? block
        block.open = false
        switch block.kind {
        case .paragraph:
            // Only definitions: the paragraph stays as their place, with no text.
            _ = resolveDefinitions(block)
        case .codeBlock:
            if !block.fenced {
                while let last = block.content.last, isBlankText(last) { block.content.removeLast() }
            }
        default:
            break
        }
        return parent
    }

    func isBlankText(_ text: String) -> Bool {
        text.unicodeScalars.allSatisfy { $0.isSpaceOrTab }
    }

    /// Take the link reference definitions off the paragraph's start; whether any text is left.
    func resolveDefinitions(_ paragraph: BlockNode) -> Bool {
        var text = paragraph.content.joined(separator: "\n")
        while let parsed = MarkdownDefinitionScanner.definition(in: text) {
            let key = normalizeLabel(parsed.label)
            if definitions[key] == nil {
                definitions[key] = MarkdownDefinition(destination: parsed.destination, title: parsed.title)
            }
            definedAt.append((paragraph, parsed.label, parsed.destination, parsed.title))
            text = String(text.unicodeScalars.dropFirst(parsed.consumed))
        }
        if text.unicodeScalars.allSatisfy({ $0 == " " || $0 == "\t" || $0 == "\n" }) {
            paragraph.content = []
            return false
        }
        paragraph.content = text.components(separatedBy: "\n")
        return true
    }

    /// Definitions in the order they were found, beside the paragraph they came from.
    var definedAt: [(BlockNode, String, String, String?)] = []

    // MARK: Recognizers

    func atxHeading(at: Int) -> Int? {
        var end = at
        while end < line.count, line[end] == "#", end - at < 7 { end += 1 }
        let level = end - at
        guard (1...6).contains(level) else { return nil }
        if end < line.count, !line[end].isSpaceOrTab { return nil }
        return level
    }

    struct Fence {
        var length: Int
        var info: String
    }

    func openingFence(at: Int) -> Fence? {
        guard let c = peek(at), c == "`" || c == "~" else { return nil }
        var end = at
        while end < line.count, line[end] == c { end += 1 }
        let length = end - at
        guard length >= 3 else { return nil }
        let info = line[end...]
        if c == "`", info.contains("`") { return nil }
        return Fence(length: length, info: String(String.UnicodeScalarView(info)))
    }

    /// `$$` (or more) opening a math block; its meta cannot hold a `$`.
    func mathFence(at: Int) -> Fence? {
        guard peek(at) == "$" else { return nil }
        var end = at
        while end < line.count, line[end] == "$" { end += 1 }
        let length = end - at
        guard length >= 2 else { return nil }
        let meta = line[end...]
        if meta.contains("$") { return nil }
        return Fence(length: length, info: String(String.UnicodeScalarView(meta)))
    }

    func setextUnderline(at: Int) -> Int? {
        guard let c = peek(at), c == "=" || c == "-" else { return nil }
        var end = at
        while end < line.count, line[end] == c { end += 1 }
        while end < line.count, line[end].isSpaceOrTab { end += 1 }
        guard end == line.count else { return nil }
        return c == "=" ? 1 : 2
    }

    func thematicBreak(at: Int) -> Bool {
        guard let c = peek(at), c == "*" || c == "-" || c == "_" else { return false }
        var count = 0
        var index = at
        while index < line.count {
            let each = line[index]
            if each == c {
                count += 1
            } else if !each.isSpaceOrTab {
                return false
            }
            index += 1
        }
        return count >= 3
    }

    struct Marker {
        var length: Int
        var data: BlockNode.ListData
    }

    func listMarker(at: Int, interruptsParagraph: Bool) -> Marker? {
        guard let c = peek(at) else { return nil }
        var data = BlockNode.ListData()
        var end = at
        if c == "*" || c == "+" || c == "-" {
            end += 1
            if let next = peek(end), !next.isSpaceOrTab { return nil }
            if interruptsParagraph, restIsBlank(end) { return nil }
            data.ordered = false
            data.bulletChar = c
        } else if c.isASCIIDigit {
            var digits = 0
            var start = 0
            while let d = peek(end), d.isASCIIDigit, digits < 9 {
                start = start * 10 + Int(d.value - 0x30)
                end += 1
                digits += 1
            }
            guard let delimiter = peek(end), delimiter == "." || delimiter == ")" else { return nil }
            end += 1
            if let next = peek(end), !next.isSpaceOrTab { return nil }
            if interruptsParagraph, start != 1 || restIsBlank(end) { return nil }
            data.ordered = true
            data.start = start
            data.delimiter = delimiter
        } else {
            return nil
        }
        return Marker(length: end - at, data: data)
    }

    func restIsBlank(_ from: Int) -> Bool {
        var index = from
        while index < line.count {
            if !line[index].isSpaceOrTab { return false }
            index += 1
        }
        return true
    }

    /// `[^label]:` opening a footnote definition: the label, and where the colon ends.
    func footnoteDefinitionStart(at: Int) -> (label: String, end: Int)? {
        guard peek(at) == "[", peek(at + 1) == "^" else { return nil }
        var index = at + 2
        var label = String.UnicodeScalarView()
        var size = 0
        while index < line.count {
            let c = line[index]
            if c == "]" { break }
            if c == "[" || c.isSpaceOrTab { return nil }
            if c == "\\", let next = peek(index + 1), next == "[" || next == "\\" || next == "]" {
                label.append(c)
                label.append(next)
                index += 2
                size += 2
                continue
            }
            label.append(c)
            index += 1
            size += 1
            if size > 999 { return nil }
        }
        guard index < line.count, line[index] == "]", !label.isEmpty else { return nil }
        guard !label.allSatisfy({ $0.isSpaceOrTab }) else { return nil }
        guard peek(index + 1) == ":" else { return nil }
        return (String(label), index + 2)
    }

    // MARK: HTML blocks

    static let blockTagNames: Set<String> = [
        "address", "article", "aside", "base", "basefont", "blockquote", "body", "caption", "center", "col",
        "colgroup", "dd", "details", "dialog", "dir", "div", "dl", "dt", "fieldset", "figcaption", "figure",
        "footer", "form", "frame", "frameset", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hr",
        "html", "iframe", "legend", "li", "link", "main", "menu", "menuitem", "nav", "noframes", "ol",
        "optgroup", "option", "p", "param", "search", "section", "summary", "table", "tbody", "td", "tfoot",
        "th", "thead", "title", "tr", "track", "ul",
    ]

    func htmlBlockStart(at: Int, interruptsParagraph: Bool) -> Int? {
        guard peek(at) == "<" else { return nil }
        let rest = String(String.UnicodeScalarView(line[at...]))
        let lower = rest.lowercased()
        for tag in ["<pre", "<script", "<style", "<textarea"] where lower.hasPrefix(tag) {
            let after = lower.unicodeScalars.dropFirst(tag.unicodeScalars.count).first
            if after == nil || after == " " || after == "\t" || after == ">" { return 1 }
        }
        if rest.hasPrefix("<!--") { return 2 }
        if rest.hasPrefix("<?") { return 3 }
        if rest.hasPrefix("<!"), let letter = rest.unicodeScalars.dropFirst(2).first, letter.isASCIILetter { return 4 }
        if rest.hasPrefix("<![CDATA[") { return 5 }
        // Type 6: an opening or closing block tag.
        var scalars = Array(lower.unicodeScalars.dropFirst())
        if scalars.first == "/" { scalars.removeFirst() }
        var name = ""
        var index = 0
        while index < scalars.count, scalars[index].isASCIIAlphanumeric {
            name.unicodeScalars.append(scalars[index])
            index += 1
        }
        if !name.isEmpty, Self.blockTagNames.contains(name) {
            if index == scalars.count { return 6 }
            let next = scalars[index]
            if next.isSpaceOrTab || next == ">" { return 6 }
            if next == "/", index + 1 < scalars.count, scalars[index + 1] == ">" { return 6 }
        }
        // Type 7: any complete tag alone on its line, not interrupting a paragraph.
        if !interruptsParagraph, let end = MarkdownHTML.tag(Array(line[at...]), 0) {
            let tagText = String(String.UnicodeScalarView(line[at..<(at + end)])).lowercased()
            let tagName = tagText.drop(while: { $0 == "<" || $0 == "/" }).prefix(while: { $0.isLetter || $0.isNumber || $0 == "-" })
            if ["script", "style", "pre", "textarea"].contains(String(tagName)) { return nil }
            if restIsBlank(at + end) { return 7 }
        }
        return nil
    }

    func htmlBlockEnds(_ type: Int) -> Bool {
        let text = String(String.UnicodeScalarView(line[offset...]))
        switch type {
        case 1:
            let lower = text.lowercased()
            return lower.contains("</script>") || lower.contains("</pre>") || lower.contains("</style>")
                || lower.contains("</textarea>")
        case 2: return text.contains("-->")
        case 3: return text.contains("?>")
        case 4: return text.contains(">")
        case 5: return text.contains("]]>")
        default: return false
        }
    }

    // MARK: Tables

    struct TableStart {
        var header: [String]
        var align: [MarkdownAlign?]
    }

    /// The line is a delimiter row under the paragraph's last line, with as many cells.
    func tableStart(_ paragraph: BlockNode) -> TableStart? {
        guard let headerLine = paragraph.content.last else { return nil }
        // A row that starts like a list item is the list item's.
        if listMarker(at: firstNonspace, interruptsParagraph: true) != nil { return nil }
        let delimiterText = String(String.UnicodeScalarView(line[firstNonspace...]))
        guard let align = delimiterRow(delimiterText) else { return nil }
        let header = tableCells(headerLine)
        guard header.count == align.count else { return nil }
        // A header line that is all blank or that would start another block is no header.
        return TableStart(header: header, align: align)
    }

    func startTable(_ paragraph: BlockNode, _ start: TableStart) -> BlockNode {
        paragraph.content.removeLast()
        let parent = paragraph.parent!
        let table = BlockNode(.table, line: lineNumber)
        table.align = start.align
        table.rows = [start.header]
        if paragraph.content.isEmpty || !resolveDefinitionsKeeping(paragraph) {
            // The paragraph was the header alone: the table takes its place.
            if let at = parent.children.firstIndex(where: { $0 === paragraph }) { parent.children.remove(at: at) }
        } else {
            paragraph.open = false
        }
        parent.append(table)
        return table
    }

    /// `resolveDefinitions` for a paragraph that is being cut short.
    func resolveDefinitionsKeeping(_ paragraph: BlockNode) -> Bool {
        resolveDefinitions(paragraph)
    }

    /// A GFM delimiter row's alignments, when the text is one.
    func delimiterRow(_ text: String) -> [MarkdownAlign?]? {
        var cells = splitRow(text)
        if cells.isEmpty { return nil }
        var aligns: [MarkdownAlign?] = []
        let hadPipe = text.contains("|")
        for index in cells.indices {
            let cell = cells[index].trimmingCharacters(in: CharacterSet(charactersIn: " \t"))
            cells[index] = cell
            var scalars = Array(cell.unicodeScalars)
            guard !scalars.isEmpty else { return nil }
            let left = scalars.first == ":"
            let right = scalars.last == ":"
            if left { scalars.removeFirst() }
            if right, !scalars.isEmpty { scalars.removeLast() }
            guard !scalars.isEmpty, scalars.allSatisfy({ $0 == "-" }) else { return nil }
            aligns.append(left && right ? .center : left ? .left : right ? .right : nil)
        }
        // One cell with no pipe at all is a setext underline or a list item, not a table.
        if !hadPipe { return nil }
        return aligns
    }

    /// A row's cells, the outer pipes dropped, `\|` kept for the inline parser to read.
    func tableCells(_ text: String) -> [String] {
        splitRow(text).map { $0.trimmingCharacters(in: CharacterSet(charactersIn: " \t")) }
    }

    func splitRow(_ text: String) -> [String] {
        var scalars = Array(text.unicodeScalars)
        while let last = scalars.last, last.isSpaceOrTab { scalars.removeLast() }
        var start = 0
        while start < scalars.count, scalars[start].isSpaceOrTab { start += 1 }
        scalars = Array(scalars[start...])
        if scalars.first == "|" { scalars.removeFirst() }
        if scalars.last == "|", !(scalars.count >= 2 && scalars[scalars.count - 2] == "\\") { scalars.removeLast() }
        var cells: [String] = []
        var cell = String.UnicodeScalarView()
        var index = 0
        while index < scalars.count {
            let c = scalars[index]
            if c == "\\", index + 1 < scalars.count {
                cell.append(c)
                cell.append(scalars[index + 1])
                index += 2
                continue
            }
            if c == "|" {
                cells.append(String(cell))
                cell = String.UnicodeScalarView()
            } else {
                cell.append(c)
            }
            index += 1
        }
        cells.append(String(cell))
        return cells
    }

    // MARK: The tree, done

    /// The block that ended the document, deepest first.
    var lastBlock: BlockNode? {
        var node = root
        while let last = node.lastChild { node = last }
        return node === root ? nil : node
    }

    func document() -> MarkdownDocument {
        let inline = MarkdownInlineParser(definitions: definitions, footnotes: footnoteLabels)
        return MarkdownDocument(blocks: convert(root.children, inline), definitions: definitions)
    }

    func convert(_ nodes: [BlockNode], _ inline: MarkdownInlineParser) -> [MarkdownBlock] {
        var out: [MarkdownBlock] = []
        for node in nodes {
            // The definitions a paragraph held stand where it stood.
            for (paragraph, label, destination, title) in definedAt where paragraph === node {
                out.append(.definition(label: normalizeLabel(label), destination: destination, title: title))
            }
            if let block = convert(node, inline) { out.append(block) }
        }
        return out
    }

    func convert(_ node: BlockNode, _ inline: MarkdownInlineParser) -> MarkdownBlock? {
        switch node.kind {
        case .document: return nil
        case .paragraph:
            if node.content.isEmpty { return nil }
            return .paragraph(inline.parse(paragraphText(node.content)))
        case .heading:
            let text = node.setext ? paragraphText(node.content) : (node.content.first ?? "")
            return .heading(depth: node.level, inline.parse(trimmed(text)))
        case .thematicBreak:
            return .thematicBreak
        case .blockQuote:
            return .blockquote(convert(node.children, inline))
        case .list:
            let items = node.children.map { item -> MarkdownListItem in
                var blocks = convert(item.children, inline)
                var checked: Bool?
                if case .paragraph(let inlines)? = blocks.first, let task = taskBox(inlines) {
                    checked = task.checked
                    blocks[0] = .paragraph(task.rest)
                }
                return MarkdownListItem(checked: checked, spread: itemSpread(item), blocks: blocks)
            }
            return .list(
                ordered: node.list.ordered, start: node.list.ordered ? node.list.start : nil, spread: listSpread(node),
                items: items)
        case .codeBlock:
            if node.fenced {
                let info = MarkdownInlineParser.unescapeInfo(trimmed(node.info))
                let space = info.firstIndex(where: { $0 == " " || $0 == "\t" })
                let lang = space.map { String(info[..<$0]) } ?? info
                let meta = space.map { trimmed(String(info[$0...])) }
                let lines = Array(node.content.dropFirst())
                return .code(lang: lang.isEmpty ? nil : lang, meta: meta?.isEmpty == false ? meta : nil, value: lines.joined(separator: "\n"))
            }
            return .code(lang: nil, meta: nil, value: node.content.joined(separator: "\n"))
        case .mathBlock:
            return .math(node.content.dropFirst().joined(separator: "\n"))
        case .htmlBlock:
            var lines = node.content
            if node.htmlType <= 5, !node.htmlClosed {
                // Unclosed, it runs to the document's end, its last line's end included.
                return .html(lines.joined(separator: "\n") + (endsWithNewline && node === lastBlock ? "\n" : ""))
            }
            while let last = lines.last, last.isEmpty, lines.count > 1 { lines.removeLast() }
            return .html(lines.joined(separator: "\n"))
        case .table:
            // Rows keep the cells they have, as mdast does; the renderer
            // lays them out to the header's width.
            let rows = node.rows.map { cells in cells.map { inline.parse(MarkdownInlineParser.unescapePipes($0)) } }
            return .table(align: node.align, rows: rows)
        case .footnoteDefinition:
            return .footnoteDefinition(label: normalizeLabel(node.label), convert(node.children, inline))
        case .item:
            return nil
        }
    }

    /// A paragraph's lines, each without its leading whitespace, the last without its trailing.
    func paragraphText(_ lines: [String]) -> String {
        var text = lines.map { String($0.drop(while: { $0 == " " || $0 == "\t" })) }.joined(separator: "\n")
        while let last = text.unicodeScalars.last, last == " " || last == "\t" { text.unicodeScalars.removeLast() }
        return text
    }

    func trimmed(_ text: String) -> String {
        text.trimmingCharacters(in: CharacterSet(charactersIn: " \t"))
    }

    /// A task item's `[ ]` / `[x]` at the start of its first paragraph, and
    /// what follows it: the box is followed by one whitespace character
    /// (a line's end too), which goes with it (`exitParagraphWithTaskListItem`).
    func taskBox(_ inlines: [MarkdownInline]) -> (checked: Bool, rest: [MarkdownInline])? {
        guard case .text(let text)? = inlines.first else { return nil }
        let scalars = Array(text.unicodeScalars)
        guard scalars.count >= 4, scalars[0] == "[", scalars[2] == "]" else { return nil }
        let mark = scalars[1]
        guard mark == " " || mark == "x" || mark == "X" || mark == "\t" else { return nil }
        guard scalars[3] == " " || scalars[3] == "\t" || scalars[3] == "\n" else { return nil }
        let rest = String(String.UnicodeScalarView(scalars[4...]))
        var tail = Array(inlines.dropFirst())
        if !rest.isEmpty { tail.insert(.text(rest), at: 0) }
        return (mark == "x" || mark == "X", tail)
    }

    // MARK: Spread, as mdast says it

    func endsWithBlankLine(_ node: BlockNode) -> Bool {
        if node.lastLineBlank { return true }
        if node.kind == .list || node.kind == .item, let last = node.lastChild {
            return endsWithBlankLine(last)
        }
        return false
    }

    /// A blank line between two items.
    func listSpread(_ list: BlockNode) -> Bool {
        for (index, item) in list.children.enumerated() where index < list.children.count - 1 {
            if endsWithBlankLine(item) { return true }
        }
        return false
    }

    /// A blank line between two of the item's own blocks.
    func itemSpread(_ item: BlockNode) -> Bool {
        for (index, child) in item.children.enumerated() where index < item.children.count - 1 {
            if child.lastLineBlank || (child.kind == .list && endsWithBlankLine(child)) { return true }
        }
        return false
    }
}

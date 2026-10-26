// The inline half of the Markdown parser: code spans, emphasis and
// strikethrough (the delimiter-run algorithm of CommonMark, with GFM's one or
// two tildes), links and images (inline, reference, the brackets' stack),
// autolinks and GFM's literal ones, raw HTML, entities, escapes, hard and soft
// breaks, `$` math and footnote calls — what micromark reads in a paragraph.

import Foundation

final class InlineNode {
    enum Kind {
        case text
        /// A delimiter run (`*`, `_`, `~`), as text until it is matched.
        case delimiter
        case finished(MarkdownInline)
        case emphasis, strong, delete
        case link(String, String?)
        case linkReference(String, MarkdownReferenceKind)
    }

    var kind: Kind
    var text: String
    var children: [InlineNode] = []
    /// A `[` or `![` that may open a link: text that nothing is merged into.
    var bracket = false

    init(_ kind: Kind, _ text: String = "") {
        self.kind = kind
        self.text = text
    }
}

final class Delimiter {
    let node: InlineNode
    let char: Unicode.Scalar
    var count: Int
    let originalCount: Int
    let canOpen: Bool
    let canClose: Bool
    /// Where the run's node stands in the sequence being built.
    var active = true

    init(node: InlineNode, char: Unicode.Scalar, count: Int, canOpen: Bool, canClose: Bool) {
        self.node = node
        self.char = char
        self.count = count
        originalCount = count
        self.canOpen = canOpen
        self.canClose = canClose
    }
}

struct Bracket {
    let node: InlineNode
    let image: Bool
    var active = true
    /// The delimiters on the stack when it was pushed: those above it are the link text's.
    let delimiterDepth: Int
    /// Where the label's text starts in the source.
    let position: Int
    var bracketAfter = false
}

final class MarkdownInlineParser {
    let definitions: [String: MarkdownDefinition]
    let footnotes: Set<String>

    init(definitions: [String: MarkdownDefinition], footnotes: Set<String>) {
        self.definitions = definitions
        self.footnotes = footnotes
    }

    // The subject.
    private var input: Scalars = []
    private var pos = 0
    private var nodes: [InlineNode] = []
    private var delimiters: [Delimiter] = []
    private var brackets: [Bracket] = []

    func parse(_ text: String) -> [MarkdownInline] {
        input = Array(text.unicodeScalars)
        pos = 0
        nodes = []
        delimiters = []
        brackets = []
        while pos < input.count { parseOne() }
        processEmphasis(stackBottom: 0)
        let built = build(nodes)
        return MarkdownLiteralAutolinks.transform(built)
    }

    private func peek(_ offset: Int = 0) -> Unicode.Scalar? {
        let at = pos + offset
        return at < input.count ? input[at] : nil
    }

    private var previousScalar: Unicode.Scalar? { pos > 0 ? input[pos - 1] : nil }

    private func appendText(_ text: String) {
        if let last = nodes.last, case .text = last.kind, !last.bracket {
            last.text += text
        } else {
            nodes.append(InlineNode(.text, text))
        }
    }

    private func append(_ inline: MarkdownInline) {
        nodes.append(InlineNode(.finished(inline)))
    }

    // MARK: One construct

    private func parseOne() {
        let c = input[pos]
        switch c {
        case "\n":
            lineBreak()
        case "`":
            if !codeSpan() {
                appendText(backtickRun())
            }
        case "\\":
            backslash()
        case "&":
            entity()
        case "<":
            if !autolinkOrHTML() {
                pos += 1
                appendText("<")
            }
        case "*", "_":
            delimiterRun(c)
        case "~":
            tildeRun()
        case "$":
            if !mathSpan() {
                appendText(dollarRun())
            }
        case "[":
            if footnoteCall() { return }
            pos += 1
            let node = InlineNode(.text, "[")
            node.bracket = true
            nodes.append(node)
            pushBracket(Bracket(node: node, image: false, delimiterDepth: delimiters.count, position: pos))
        case "!":
            if peek(1) == "[" {
                pos += 2
                let node = InlineNode(.text, "![")
                node.bracket = true
                nodes.append(node)
                pushBracket(Bracket(node: node, image: true, delimiterDepth: delimiters.count, position: pos))
            } else {
                pos += 1
                appendText("!")
            }
        case "]":
            closeBracket()
        default:
            if literalAutolink() { return }
            plainText()
        }
    }

    private static let special: Set<Unicode.Scalar> = ["\n", "`", "\\", "&", "<", "*", "_", "~", "$", "[", "!", "]"]

    private func plainText() {
        let start = pos
        pos += 1
        while pos < input.count {
            let c = input[pos]
            if Self.special.contains(c) { break }
            // A literal autolink can start at any letter or digit (an email's local part).
            if MarkdownLiteralAutolinks.mayStart(c), MarkdownLiteralAutolinks.previousAllows(c, input[pos - 1]) { break }
            pos += 1
        }
        appendText(String(String.UnicodeScalarView(input[start..<pos])))
    }

    private func lineBreak() {
        // Trailing spaces were left on the text before; two or more make a hard break.
        var hard = false
        if let last = nodes.last, case .text = last.kind, !last.bracket {
            var spaces = 0
            var scalars = last.text.unicodeScalars
            while let tail = scalars.last, tail == " " {
                spaces += 1
                scalars.removeLast()
            }
            last.text = String(scalars)
            hard = spaces >= 2
            if last.text.isEmpty { nodes.removeLast() }
        }
        pos += 1
        if hard {
            append(.hardBreak)
        } else {
            appendText("\n")
        }
        while pos < input.count, input[pos] == " " || input[pos] == "\t" { pos += 1 }
    }

    // MARK: Escapes, entities

    private func backslash() {
        pos += 1
        guard let next = peek() else {
            appendText("\\")
            return
        }
        if next == "\n" {
            pos += 1
            append(.hardBreak)
            while pos < input.count, input[pos] == " " || input[pos] == "\t" { pos += 1 }
        } else if next.isASCIIPunctuation {
            pos += 1
            // An escaped character never opens or closes anything: it is text.
            appendText(String(Character(next)))
        } else {
            appendText("\\")
        }
    }

    private func entity() {
        if let (decoded, length) = MarkdownCharacters.entity(input, pos) {
            pos += length
            appendText(decoded)
        } else {
            pos += 1
            appendText("&")
        }
    }

    // MARK: Code and math spans

    private func backtickRun() -> String {
        let start = pos
        while pos < input.count, input[pos] == "`" { pos += 1 }
        return String(String.UnicodeScalarView(input[start..<pos]))
    }

    private func dollarRun() -> String {
        let start = pos
        while pos < input.count, input[pos] == "$" { pos += 1 }
        return String(String.UnicodeScalarView(input[start..<pos]))
    }

    /// A code span from here; whether there was one.
    private func codeSpan() -> Bool { span("`") }

    /// `$x$`, `$$x$$` inline: a run of dollars, closed by one as long, read as a code span is.
    private func mathSpan() -> Bool {
        if pos > 0, input[pos - 1] == "$" { return false }
        return span("$")
    }

    private func span(_ mark: Unicode.Scalar) -> Bool {
        let start = pos
        var end = pos
        while end < input.count, input[end] == mark { end += 1 }
        let length = end - start
        var at = end
        while at < input.count {
            if input[at] == mark {
                let closeStart = at
                while at < input.count, input[at] == mark { at += 1 }
                if at - closeStart == length {
                    var content = Array(input[end..<closeStart])
                    // A line's end is a space to the reader, but mdast keeps it.
                    let spaceLike: (Unicode.Scalar) -> Bool = { $0 == " " || $0 == "\n" }
                    if content.count >= 2, spaceLike(content.first!), spaceLike(content.last!),
                       !content.allSatisfy(spaceLike)
                    {
                        content.removeFirst()
                        content.removeLast()
                    }
                    let value = String(String.UnicodeScalarView(content))
                    append(mark == "`" ? .code(value) : .math(value))
                    pos = at
                    return true
                }
            } else {
                at += 1
            }
        }
        pos = start
        return false
    }

    // MARK: Autolinks and HTML

    private func autolinkOrHTML() -> Bool {
        if let (destination, text, length) = MarkdownCharacters.autolink(input, pos) {
            pos += length
            append(.link(destination: destination, title: nil, [.text(text)]))
            return true
        }
        if let end = MarkdownHTML.inline(input, pos) {
            append(.html(String(String.UnicodeScalarView(input[pos..<end]))))
            pos = end
            return true
        }
        return false
    }

    private func literalAutolink() -> Bool {
        guard let found = MarkdownLiteralAutolinks.scan(input, pos, insideUnbalancedLabel: brackets.contains { $0.active })
        else { return false }
        append(.link(destination: found.destination, title: nil, [.text(found.text)]))
        pos += found.length
        return true
    }

    // MARK: Footnote calls

    private func footnoteCall() -> Bool {
        guard peek(1) == "^" else { return false }
        var at = pos + 2
        var label = String.UnicodeScalarView()
        while at < input.count {
            let c = input[at]
            if c == "]" { break }
            if c == "[" || c == " " || c == "\t" || c == "\n" { return false }
            if c == "\\", at + 1 < input.count, input[at + 1] == "[" || input[at + 1] == "\\" || input[at + 1] == "]" {
                label.append(c)
                label.append(input[at + 1])
                at += 2
                continue
            }
            label.append(c)
            at += 1
            if label.count > 999 { return false }
        }
        guard at < input.count, !label.isEmpty else { return false }
        let key = normalizeLabel(String(label))
        guard footnotes.contains(key) else { return false }
        append(.footnoteReference(label: key))
        pos = at + 1
        return true
    }

    // MARK: Delimiter runs

    /// micromark's `classifyCharacter`: 1 whitespace, 2 punctuation, 0 other.
    static func classify(_ c: Unicode.Scalar?) -> Int {
        guard let c else { return 1 }
        if MarkdownCharacters.isUnicodeWhitespace(c) { return 1 }
        if MarkdownCharacters.isUnicodePunctuation(c) { return 2 }
        return 0
    }

    private func delimiterRun(_ c: Unicode.Scalar) {
        let before = Self.classify(previousScalar)
        let start = pos
        while pos < input.count, input[pos] == c { pos += 1 }
        let count = pos - start
        let after = Self.classify(peek())
        // micromark's attention: open = !after || (after == punctuation && before); close mirrored.
        let leftFlanking = after != 1 && (after != 2 || before != 0)
        let rightFlanking = before != 1 && (before != 2 || after != 0)
        let canOpen: Bool
        let canClose: Bool
        if c == "_" {
            canOpen = leftFlanking && (!rightFlanking || before == 2)
            canClose = rightFlanking && (!leftFlanking || after == 2)
        } else {
            canOpen = leftFlanking
            canClose = rightFlanking
        }
        let node = InlineNode(.delimiter, String(repeating: String(Character(c)), count: count))
        nodes.append(node)
        if canOpen || canClose {
            delimiters.append(Delimiter(node: node, char: c, count: count, canOpen: canOpen, canClose: canClose))
        }
    }

    /// `~` and `~~`: strikethrough's runs. A longer run, or one after an
    /// unescaped `~`, is plain text.
    private func tildeRun() {
        let before = Self.classify(previousScalar)
        let start = pos
        while pos < input.count, input[pos] == "~" { pos += 1 }
        let count = pos - start
        let text = String(repeating: "~", count: count)
        if count > 2 {
            appendText(text)
            return
        }
        let after = Self.classify(peek())
        let canOpen = after == 0 || (after == 2 && before != 0)
        let canClose = before == 0 || (before == 2 && after != 0)
        let node = InlineNode(.delimiter, text)
        nodes.append(node)
        delimiters.append(Delimiter(node: node, char: "~", count: count, canOpen: canOpen, canClose: canClose))
    }

    // MARK: Brackets

    /// cmark's `push_bracket`: the bracket open before it now has one after it.
    private func pushBracket(_ bracket: Bracket) {
        if !brackets.isEmpty { brackets[brackets.count - 1].bracketAfter = true }
        brackets.append(bracket)
    }

    private func closeBracket() {
        let closerPosition = pos
        pos += 1
        guard let openerIndex = brackets.indices.last else {
            appendText("]")
            return
        }
        let opener = brackets[openerIndex]
        if !opener.active {
            brackets.removeLast()
            appendText("]")
            return
        }
        // An inline link: `(destination "title")`.
        var destination: String?
        var title: String?
        var matched = false
        var reference: (label: String, kind: MarkdownReferenceKind)?
        let afterBracket = pos
        if peek() == "(", let inline = MarkdownDefinitionScanner.inlineLink(input, pos + 1) {
            destination = inline.destination
            title = inline.title
            pos = inline.end
            matched = true
        } else {
            // A reference: `[text][label]`, `[text][]`, `[text]`.
            let rawText = String(String.UnicodeScalarView(input[opener.position..<closerPosition]))
            if let label = MarkdownDefinitionScanner.label(input, pos) {
                if label.text.isEmpty {
                    reference = opener.bracketAfter ? nil : (rawText, .collapsed)
                } else {
                    reference = (label.text, .full)
                }
                pos = label.end
            } else {
                reference = opener.bracketAfter ? nil : (rawText, .shortcut)
            }
            if let candidate = reference, rawText.unicodeScalars.count <= 999 || candidate.kind == .full {
                let key = normalizeLabel(candidate.label)
                if !key.isEmpty, definitions[key] != nil, !isFootnoteLabel(candidate.label, candidate.kind) {
                    matched = true
                    reference = (key, candidate.kind)
                } else {
                    reference = nil
                }
            } else {
                reference = nil
            }
            if !matched { pos = afterBracket }
        }
        guard matched else {
            brackets.removeLast()
            appendText("]")
            return
        }
        // The opener's node and everything after it become the link.
        guard let at = nodes.firstIndex(where: { $0 === opener.node }) else {
            brackets.removeLast()
            appendText("]")
            return
        }
        processEmphasis(stackBottom: opener.delimiterDepth)
        let inside = Array(nodes[(at + 1)...])
        nodes.removeSubrange(at...)
        let children = build(inside)
        if opener.image {
            let alt = MarkdownInline.plainText(children)
            if let reference {
                append(.imageReference(label: reference.label, kind: reference.kind, alt: alt))
            } else {
                append(.image(source: destination ?? "", title: title, alt: alt))
            }
        } else {
            let node: InlineNode
            if let reference {
                node = InlineNode(.linkReference(reference.label, reference.kind))
            } else {
                node = InlineNode(.link(destination ?? "", title))
            }
            node.children = inside
            nodes.append(node)
        }
        brackets.removeLast()
        // No links in links: every `[` before this one is now plain text.
        if !opener.image {
            for index in brackets.indices where !brackets[index].image { brackets[index].active = false }
        }
    }

    /// `[^x]` is a footnote's label, never a link's, when it reads as one.
    private func isFootnoteLabel(_ label: String, _ kind: MarkdownReferenceKind) -> Bool {
        kind == .shortcut && label.hasPrefix("^") && footnotes.contains(normalizeLabel(String(label.dropFirst())))
    }

    // MARK: Emphasis

    private func processEmphasis(stackBottom: Int) {
        var openersBottom: [String: Int] = [:]
        var closerIndex = stackBottom
        while closerIndex < delimiters.count {
            let closer = delimiters[closerIndex]
            guard closer.canClose, closer.active else {
                closerIndex += 1
                continue
            }
            let key = "\(closer.char)\(closer.char == "~" ? closer.count : closer.originalCount % 3)\(closer.canOpen)"
            var openerIndex = closerIndex - 1
            var found = false
            let bottom = max(stackBottom, openersBottom[key] ?? stackBottom)
            while openerIndex >= bottom {
                let opener = delimiters[openerIndex]
                if opener.active, opener.char == closer.char, opener.canOpen {
                    if closer.char == "~" {
                        if opener.count == closer.count {
                            found = true
                            break
                        }
                    } else {
                        let oddMatch = (closer.canOpen || opener.canClose)
                            && (opener.originalCount + closer.originalCount) % 3 == 0
                            && !(opener.originalCount % 3 == 0 && closer.originalCount % 3 == 0)
                        if !oddMatch {
                            found = true
                            break
                        }
                    }
                }
                openerIndex -= 1
            }
            if !found {
                openersBottom[key] = closerIndex
                if !closer.canOpen { closer.active = false }
                closerIndex += 1
                continue
            }
            let opener = delimiters[openerIndex]
            let used = closer.char == "~" ? closer.count : (closer.count >= 2 && opener.count >= 2 ? 2 : 1)
            opener.count -= used
            closer.count -= used
            opener.node.text = String(opener.node.text.dropLast(used))
            closer.node.text = String(closer.node.text.dropFirst(used))
            // Wrap what lies between the two.
            guard let openAt = nodes.firstIndex(where: { $0 === opener.node }),
                  let closeAt = nodes.firstIndex(where: { $0 === closer.node }), openAt < closeAt
            else {
                closerIndex += 1
                continue
            }
            let kind: InlineNode.Kind = closer.char == "~" ? .delete : used == 2 ? .strong : .emphasis
            let wrapper = InlineNode(kind)
            wrapper.children = Array(nodes[(openAt + 1)..<closeAt])
            nodes.replaceSubrange((openAt + 1)..<closeAt, with: [wrapper])
            // The delimiters between them are plain text now.
            for index in (openerIndex + 1)..<closerIndex { delimiters[index].active = false }
            if opener.count == 0 {
                opener.active = false
                if let at = nodes.firstIndex(where: { $0 === opener.node }) { nodes.remove(at: at) }
            }
            if closer.count == 0 {
                closer.active = false
                if let at = nodes.firstIndex(where: { $0 === closer.node }) { nodes.remove(at: at) }
                closerIndex += 1
            }
        }
        // Everything above the bottom is done with.
        if delimiters.count > stackBottom { delimiters.removeSubrange(stackBottom...) }
    }

    // MARK: The tree

    private func build(_ nodes: [InlineNode]) -> [MarkdownInline] {
        var out: [MarkdownInline] = []
        func text(_ value: String) {
            if value.isEmpty { return }
            if case .text(let previous)? = out.last {
                out[out.count - 1] = .text(previous + value)
            } else {
                out.append(.text(value))
            }
        }
        for node in nodes {
            switch node.kind {
            case .text, .delimiter: text(node.text)
            case .finished(let inline):
                if case .text(let value) = inline { text(value) } else { out.append(inline) }
            case .emphasis: out.append(.emphasis(build(node.children)))
            case .strong: out.append(.strong(build(node.children)))
            case .delete: out.append(.delete(build(node.children)))
            case let .link(destination, title): out.append(.link(destination: destination, title: title, build(node.children)))
            case let .linkReference(label, kind): out.append(.linkReference(label: label, kind: kind, build(node.children)))
            }
        }
        return out
    }

    // MARK: Helpers the block parser uses

    /// A fenced block's info string with its escapes and entities read.
    static func unescapeInfo(_ text: String) -> String {
        MarkdownCharacters.unescape(text)
    }

    /// A table cell's `\|`, which only the row's split saw, as `|`.
    static func unescapePipes(_ text: String) -> String {
        text.replacingOccurrences(of: "\\|", with: "|")
    }
}

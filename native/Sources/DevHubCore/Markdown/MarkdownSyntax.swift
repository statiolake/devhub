// The Markdown an answer is written in, as a tree.
//
// The TS app hands an answer to `react-markdown` with `remark-gfm` and
// `remark-math` (apps/desktop/src/shell/conversation/Markdown.tsx), which
// parse it with micromark into mdast. This tree is mdast's shape, node for
// node, so that what the native transcript draws is what the TS one drew from
// the same source: CommonMark, GitHub's extensions (tables, task list items,
// strikethrough with one or two tildes, autolink literals, footnotes), and
// `$…$` / `$$…$$` math. The parser is `MarkdownParser`; the renderer is the
// App's, through `MarkdownDocument`.
//
// Raw HTML is kept as `html` nodes, as mdast keeps it, and is never drawn
// (`skipHtml`): the text came out of a model.

import Foundation

/// A whole document: its blocks, and what the blocks refer to by label.
public struct MarkdownDocument: Hashable, Sendable {
    public var blocks: [MarkdownBlock]
    /// Link reference definitions, by normalized label (`normalizeLabel`).
    public var definitions: [String: MarkdownDefinition]

    public init(blocks: [MarkdownBlock], definitions: [String: MarkdownDefinition] = [:]) {
        self.blocks = blocks
        self.definitions = definitions
    }
}

public struct MarkdownDefinition: Hashable, Sendable {
    public var destination: String
    public var title: String?

    public init(destination: String, title: String?) {
        self.destination = destination
        self.title = title
    }
}

public enum MarkdownAlign: String, Hashable, Sendable {
    case left, center, right
}

public indirect enum MarkdownBlock: Hashable, Sendable {
    case paragraph([MarkdownInline])
    case heading(depth: Int, [MarkdownInline])
    case thematicBreak
    case blockquote([MarkdownBlock])
    /// `start` is the first item's number of an ordered list.
    case list(ordered: Bool, start: Int?, spread: Bool, items: [MarkdownListItem])
    /// A fenced block (`lang` and `meta` from its info string) or an indented one (neither).
    case code(lang: String?, meta: String?, value: String)
    case html(String)
    case definition(label: String, destination: String, title: String?)
    case footnoteDefinition(label: String, [MarkdownBlock])
    /// The header row first.
    case table(align: [MarkdownAlign?], rows: [[[MarkdownInline]]])
    /// A `$$` block.
    case math(String)
}

public struct MarkdownListItem: Hashable, Sendable {
    /// A task list item's box: checked, unchecked, or none.
    public var checked: Bool?
    public var spread: Bool
    public var blocks: [MarkdownBlock]

    public init(checked: Bool?, spread: Bool, blocks: [MarkdownBlock]) {
        self.checked = checked
        self.spread = spread
        self.blocks = blocks
    }
}

public enum MarkdownReferenceKind: String, Hashable, Sendable {
    case full, collapsed, shortcut
}

public indirect enum MarkdownInline: Hashable, Sendable {
    /// Text, soft line breaks included (as `\n`).
    case text(String)
    case emphasis([MarkdownInline])
    case strong([MarkdownInline])
    case delete([MarkdownInline])
    case code(String)
    case hardBreak
    case link(destination: String, title: String?, [MarkdownInline])
    case image(source: String, title: String?, alt: String)
    /// A link by label; `label` is normalized (`normalizeLabel`) and defined.
    case linkReference(label: String, kind: MarkdownReferenceKind, [MarkdownInline])
    case imageReference(label: String, kind: MarkdownReferenceKind, alt: String)
    case footnoteReference(label: String)
    case html(String)
    case math(String)
}

// MARK: - Labels

/// A label as micromark compares labels (`normalizeIdentifier`): whitespace
/// runs are one space, the ends trimmed, and the case folded.
public func normalizeLabel(_ label: String) -> String {
    var out = ""
    var space = false
    for scalar in label.unicodeScalars {
        if scalar == " " || scalar == "\t" || scalar == "\n" || scalar == "\r" {
            space = true
            continue
        }
        if space && !out.isEmpty { out.append(" ") }
        space = false
        out.unicodeScalars.append(scalar)
    }
    // `value.toLowerCase().toUpperCase()`: one fold for every case variant.
    return out.lowercased().uppercased()
}

// MARK: - The plain text of inlines

extension MarkdownInline {
    /// What a reader without the formatting reads: an image's alt, a break as a new line.
    public static func plainText(_ inlines: [MarkdownInline]) -> String {
        var out = ""
        for inline in inlines {
            switch inline {
            case .text(let text), .code(let text), .math(let text): out += text
            case .emphasis(let children), .strong(let children), .delete(let children): out += plainText(children)
            case .link(_, _, let children), .linkReference(_, _, let children): out += plainText(children)
            case .image(_, _, let alt), .imageReference(_, _, let alt): out += alt
            case .hardBreak: out += "\n"
            case .footnoteReference(let label): out += label
            case .html: break
            }
        }
        return out
    }
}

// MARK: - A canonical spelling, for tests

/// The tree in one line, in the spelling the reference fixtures are written
/// in (the TS side's mdast, serialized the same way: see
/// Tests/DevHubCoreTests/Fixtures/markdown/README.md).
public enum MarkdownSpelling {
    public static func of(_ document: MarkdownDocument) -> String {
        document.blocks.map(block).joined(separator: " ")
    }

    static func quoted(_ text: String) -> String {
        var out = "\""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }

    static func blocks(_ blocks: [MarkdownBlock]) -> String { blocks.map(block).joined(separator: " ") }
    static func inlines(_ inlines: [MarkdownInline]) -> String { inlines.map(inline).joined(separator: " ") }

    static func block(_ block: MarkdownBlock) -> String {
        switch block {
        case .paragraph(let children): return "(p \(inlines(children)))"
        case .heading(let depth, let children): return "(h\(depth) \(inlines(children)))"
        case .thematicBreak: return "(hr)"
        case .blockquote(let children): return "(quote \(blocks(children)))"
        case let .list(ordered, start, spread, items):
            let kind = ordered ? "ordered start=\(start ?? 1)" : "bullet"
            let body = items.map { item -> String in
                let box = item.checked == true ? " [x]" : item.checked == false ? " [ ]" : ""
                return "(item\(box)\(item.spread ? " spread" : "") \(blocks(item.blocks)))"
            }.joined(separator: " ")
            return "(list \(kind) \(spread ? "loose" : "tight") \(body))"
        case let .code(lang, meta, value): return "(code \(quoted(lang ?? "")) \(quoted(meta ?? "")) \(quoted(value)))"
        case .html(let value): return "(html \(quoted(value)))"
        case let .definition(label, destination, title):
            return "(def \(quoted(label.lowercased())) \(quoted(destination)) \(quoted(title ?? "")))"
        case let .footnoteDefinition(label, children): return "(fndef \(quoted(label.lowercased())) \(blocks(children)))"
        case let .table(align, rows):
            let aligns = align.map { $0?.rawValue ?? "none" }.joined(separator: ",")
            let body = rows.map { row in "(tr \(row.map { "(td \(inlines($0)))" }.joined(separator: " ")))" }
                .joined(separator: " ")
            return "(table \(quoted(aligns)) \(body))"
        case .math(let value): return "(math \(quoted(value)))"
        }
    }

    static func inline(_ inline: MarkdownInline) -> String {
        switch inline {
        case .text(let text): return "(text \(quoted(text)))"
        case .emphasis(let children): return "(em \(inlines(children)))"
        case .strong(let children): return "(strong \(inlines(children)))"
        case .delete(let children): return "(del \(inlines(children)))"
        case .code(let value): return "(icode \(quoted(value)))"
        case .hardBreak: return "(br)"
        case let .link(destination, title, children):
            return "(link \(quoted(destination)) \(quoted(title ?? "")) \(inlines(children)))"
        case let .image(source, title, alt): return "(img \(quoted(source)) \(quoted(title ?? "")) \(quoted(alt)))"
        case let .linkReference(label, kind, children):
            return "(linkref \(quoted(label.lowercased())) \(kind.rawValue) \(inlines(children)))"
        case let .imageReference(label, kind, alt): return "(imgref \(quoted(label.lowercased())) \(kind.rawValue) \(quoted(alt)))"
        case .footnoteReference(let label): return "(fnref \(quoted(label.lowercased())))"
        case .html(let value): return "(html \(quoted(value)))"
        case .math(let value): return "(imath \(quoted(value)))"
        }
    }
}

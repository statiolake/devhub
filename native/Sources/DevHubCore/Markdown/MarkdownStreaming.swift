// Port of apps/desktop/src/shell/conversation/markdownBlocks.ts,
// mathDelimiters.ts, and the `keepIndentation` of RequestCard.tsx.
//
// Where a streaming answer stops being final.
//
// An assistant entry that is still streaming grows at its end and nowhere
// else, so its Markdown is two parts: a prefix whose blocks can no longer
// change, and a tail that the next delta may still rewrite. The prefix is
// drawn once and kept; only the tail is parsed again on every delta. And a
// code block is highlighted only once it is in the prefix — a fence still
// open would be tokenized again on every delta, and would flicker between
// colourings as its grammar state moved under it.
//
// A block is settled once a line after it proves it has ended: a blank line
// outside a fence, or the fence's own closing line. Only lines that have
// ended count, because the last line of a delta may still be growing — "```"
// becomes "``` js" and stops closing anything.

import Foundation

public enum MarkdownStreaming {
    struct Fence {
        let marker: Character
        let length: Int
    }

    /// `^ {0,3}(`{3,}|~{3,})(.*)$`: the run and what follows it.
    static func fenceRun(_ line: Substring) -> (run: Substring, rest: Substring)? {
        var index = line.startIndex
        var spaces = 0
        while index < line.endIndex, line[index] == " ", spaces < 3 {
            spaces += 1
            index = line.index(after: index)
        }
        guard index < line.endIndex, line[index] == "`" || line[index] == "~" else { return nil }
        let marker = line[index]
        let start = index
        while index < line.endIndex, line[index] == marker { index = line.index(after: index) }
        let run = line[start..<index]
        guard run.count >= 3 else { return nil }
        return (run, line[index...])
    }

    static func fenceOpening(_ line: Substring) -> Fence? {
        guard let (run, rest) = fenceRun(line) else { return nil }
        let marker = run.first!
        // CommonMark: a backtick fence's info string cannot contain a backtick.
        if marker == "`", rest.contains("`") { return nil }
        return Fence(marker: marker, length: run.count)
    }

    static func closes(_ line: Substring, _ open: Fence) -> Bool {
        guard let (run, rest) = fenceRun(line) else { return false }
        return run.first == open.marker && run.count >= open.length
            && rest.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// Where in `markdown` the prefix of final blocks ends.
    public static func settledEnd(_ markdown: String) -> String.Index {
        var settled = markdown.startIndex
        var open: Fence?
        var start = markdown.startIndex
        while true {
            // An unterminated last line is still being written.
            guard let newline = markdown[start...].firstIndex(of: "\n") else { return settled }
            let line = markdown[start..<newline]
            let end = markdown.index(after: newline)
            if let fence = open {
                if closes(line, fence) {
                    open = nil
                    settled = end
                }
            } else if line.trimmingCharacters(in: .whitespaces).isEmpty {
                settled = end
            } else {
                open = fenceOpening(line)
            }
            start = end
        }
    }

    /// The prefix of `markdown` whose blocks are final (`settledLength`).
    public static func settledPrefix(_ markdown: String) -> Substring {
        markdown[..<settledEnd(markdown)]
    }

    // MARK: - Math delimiters

    // Which dollar signs and backslash brackets in an answer are math.
    //
    // `remark-math` reads `$…$` as math wherever a second `$` follows, so "$5
    // and $10" would become a formula. This rewrites the source first, outside
    // code, with pandoc's rules: an opening `$` is followed by a non-space, a
    // closing one is preceded by a non-space and not followed by a digit. A `$`
    // that opens nothing is escaped (`\$`), and `\(…\)` / `\[…\]` become `$…$` /
    // `$$…$$`, which are the delimiters `remark-math` knows. Fenced blocks,
    // inline code and existing `$$…$$` spans are copied as they are. A
    // delimiter still waiting for its partner (a streaming answer) is left as
    // text.

    static func isSpace(_ c: Character?) -> Bool {
        guard let c else { return true }
        return c.isWhitespace
    }

    /// The end of the code span opened by the backtick run at `i`, or just past the run.
    static func codeSpanEnd(_ text: [Character], _ i: Int) -> Int {
        var end = i
        while end < text.count, text[end] == "`" { end += 1 }
        let length = end - i
        var at = end
        while at < text.count {
            if text[at] != "`" {
                at += 1
                continue
            }
            var stop = at
            while stop < text.count, text[stop] == "`" { stop += 1 }
            if stop - at == length { return stop }
            at = stop
        }
        return end
    }

    static func indexOf(_ text: [Character], _ needle: String, from: Int) -> Int? {
        let wanted = Array(needle)
        var at = max(0, from)
        while at + wanted.count <= text.count {
            if Array(text[at..<(at + wanted.count)]) == wanted { return at }
            at += 1
        }
        return nil
    }

    /// A paragraph that is one `$$…$$` is a display block, not inline math.
    static func display(_ text: String) -> String {
        // `^(\s*)\$\$([^$]+)\$\$\s*$`
        let chars = Array(text)
        var at = 0
        while at < chars.count, chars[at].isWhitespace { at += 1 }
        let lead = String(chars[0..<at])
        guard at + 1 < chars.count, chars[at] == "$", chars[at + 1] == "$" else { return text }
        var end = chars.count
        while end > 0, chars[end - 1].isWhitespace { end -= 1 }
        guard end - 2 > at + 2, chars[end - 1] == "$", chars[end - 2] == "$" else { return text }
        let inner = chars[(at + 2)..<(end - 2)]
        guard !inner.isEmpty, !inner.contains("$") else { return text }
        return "\(lead)$$\n\(String(inner).trimmingCharacters(in: .whitespacesAndNewlines))\n$$"
    }

    static func paragraph(_ source: String) -> String {
        let text = Array(source)
        var out = ""
        var i = 0
        while i < text.count {
            let ch = text[i]
            if ch == "\\" {
                let next: Character? = i + 1 < text.count ? text[i + 1] : nil
                if next == "(" || next == "[" {
                    let close = indexOf(text, next == "(" ? "\\)" : "\\]", from: i + 2)
                    let inner = close.map { String(text[(i + 2)..<$0]).trimmingCharacters(in: .whitespacesAndNewlines) } ?? ""
                    if let close, !inner.isEmpty {
                        out += next == "(" ? "$\(inner)$" : "$$\(inner)$$"
                        i = close + 2
                        continue
                    }
                }
                out += String(text[i..<min(i + 2, text.count)])
                i += 2
            } else if ch == "`" {
                let stop = codeSpanEnd(text, i)
                out += String(text[i..<stop])
                i = stop
            } else if ch == "$" {
                if i + 1 < text.count, text[i + 1] == "$" {
                    let close = indexOf(text, "$$", from: i + 2)
                    let stop = close.map { $0 + 2 } ?? i + 2
                    out += String(text[i..<stop])
                    i = stop
                    continue
                }
                var close: Int?
                if !isSpace(i + 1 < text.count ? text[i + 1] : nil) {
                    var j = i + 1
                    while j < text.count {
                        if text[j] == "\\" {
                            j += 2
                            continue
                        }
                        let after: Character? = j + 1 < text.count ? text[j + 1] : nil
                        if text[j] != "$" || after == "$" {
                            j += 1
                            continue
                        }
                        if !isSpace(text[j - 1]), !(after?.isASCII == true && after?.isNumber == true) {
                            close = j
                            break
                        }
                        j += 1
                    }
                }
                if let close {
                    out += String(text[i...close])
                    i = close + 1
                } else {
                    out += "\\$"
                    i += 1
                }
            } else {
                out.append(ch)
                i += 1
            }
        }
        return out
    }

    /// `normalizeMath`: the source with only its real math delimited, as `remark-math` reads them.
    public static func normalizeMath(_ source: String) -> String {
        if !source.contains("$") && !source.contains("\\") { return source }
        var out: [String] = []
        var prose: [String] = []
        var fence: (marker: Character, length: Int)?
        func flush() {
            if !prose.isEmpty { out.append(display(paragraph(prose.joined(separator: "\n")))) }
            prose = []
        }
        for line in source.components(separatedBy: "\n") {
            let run = fenceRun(Substring(line))?.run
            if let open = fence {
                out.append(line)
                if let run, run.first == open.marker, run.count >= open.length,
                   line.trimmingCharacters(in: .whitespaces) == String(run)
                {
                    fence = nil
                }
            } else if let run {
                flush()
                fence = (run.first!, run.count)
                out.append(line)
            } else if line.trimmingCharacters(in: .whitespaces).isEmpty {
                flush()
                out.append(line)
            } else if (line.hasPrefix("    ") || line.hasPrefix("\t")), prose.isEmpty {
                out.append(line)  // indented code
            } else {
                prose.append(line)
            }
        }
        flush()
        return out.joined(separator: "\n")
    }

    // MARK: - A preview's indentation

    /// A preview's Markdown with each line's leading spaces kept. Markdown drops
    /// the indentation of a paragraph's lines, which would pull an ASCII mockup's
    /// columns out of line; outside a fenced block the spaces become no-break
    /// spaces, which it keeps. A fenced block keeps its lines as they are anyway.
    public static func keepIndentation(_ source: String) -> String {
        var fence: String?
        return source.components(separatedBy: "\n").map { line -> String in
            let trimmed = line.drop(while: { $0.isWhitespace })
            let run = trimmed.prefix(while: { $0 == "`" })
            let tilde = trimmed.prefix(while: { $0 == "~" })
            let marker = run.count >= 3 ? String(run) : tilde.count >= 3 ? String(tilde) : nil
            if let marker {
                if fence == nil {
                    fence = marker
                } else if marker.hasPrefix(fence!) {
                    fence = nil
                }
                return line
            }
            if fence != nil { return line }
            let spaces = line.prefix(while: { $0 == " " }).count
            return String(repeating: "\u{00A0}", count: spaces) + line.dropFirst(spaces)
        }.joined(separator: "\n")
    }
}

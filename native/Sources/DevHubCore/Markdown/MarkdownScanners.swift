// The small scanners the Markdown parser reads with: character classes as
// micromark has them, character references, autolinks, raw HTML, link
// labels, destinations and titles, and GFM's literal autolinks.

import Foundation

enum MarkdownCharacters {
    /// JavaScript's `\s`, which micromark's `unicodeWhitespace` is.
    static func isUnicodeWhitespace(_ c: Unicode.Scalar) -> Bool {
        switch c.value {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            return true
        default:
            return false
        }
    }

    /// `\p{P}` or `\p{S}`: micromark's `unicodePunctuation`.
    static func isUnicodePunctuation(_ c: Unicode.Scalar) -> Bool {
        if c.isASCII { return c.isASCIIPunctuation }
        // micromark tests `String.fromCharCode(code)`: past the BMP that is
        // a lone surrogate's half, which is never punctuation.
        if c.value > 0xFFFF { return false }
        switch c.properties.generalCategory {
        case .connectorPunctuation, .dashPunctuation, .openPunctuation, .closePunctuation, .initialPunctuation,
             .finalPunctuation, .otherPunctuation, .mathSymbol, .currencySymbol, .modifierSymbol, .otherSymbol:
            return true
        default:
            return false
        }
    }

    private static let entities: [String: String] = {
        var map: [String: String] = [:]
        map.reserveCapacity(2200)
        for line in MarkdownEntities.table.split(separator: "\n") {
            let parts = line.split(separator: " ")
            guard let name = parts.first else { continue }
            var value = String.UnicodeScalarView()
            for hex in parts.dropFirst() {
                if let code = UInt32(hex, radix: 16), let scalar = Unicode.Scalar(code) { value.append(scalar) }
            }
            map[String(name)] = String(value)
        }
        return map
    }()

    /// A character reference at `at` (`&amp;`, `&#35;`, `&#x22;`): what it stands for, and its length.
    static func entity(_ input: Scalars, _ at: Int) -> (String, Int)? {
        guard at < input.count, input[at] == "&" else { return nil }
        var index = at + 1
        if index < input.count, input[index] == "#" {
            index += 1
            var hex = false
            if index < input.count, input[index] == "x" || input[index] == "X" {
                hex = true
                index += 1
            }
            let start = index
            while index < input.count, hex ? input[index].properties.isASCIIHexDigit : input[index].isASCIIDigit {
                index += 1
                if index - start > (hex ? 6 : 7) { return nil }
            }
            guard index > start, index < input.count, input[index] == ";" else { return nil }
            let digits = String(String.UnicodeScalarView(input[start..<index]))
            let code = UInt32(digits, radix: hex ? 16 : 10) ?? 0
            let scalar: Unicode.Scalar
            if code == 0 || (code >= 0xD800 && code <= 0xDFFF) || code > 0x10FFFF {
                scalar = "\u{FFFD}"
            } else if let valid = Unicode.Scalar(code), !isDisallowedCode(code) {
                scalar = valid
            } else {
                scalar = "\u{FFFD}"
            }
            return (String(Character(scalar)), index + 1 - at)
        }
        let start = index
        while index < input.count, input[index].isASCIIAlphanumeric {
            index += 1
            if index - start > 31 { return nil }
        }
        guard index > start, index < input.count, input[index] == ";" else { return nil }
        let name = String(String.UnicodeScalarView(input[start..<index]))
        guard let value = entities[name] else { return nil }
        return (value, index + 1 - at)
    }

    /// micromark's `decodeNumericCharacterReference` refusals beyond the surrogates.
    private static func isDisallowedCode(_ code: UInt32) -> Bool {
        (code < 0x09) || code == 0x0B || (code > 0x0D && code < 0x20) || (code > 0x7E && code < 0xA0)
            || (code & 0xFFFF) == 0xFFFF || (code & 0xFFFF) == 0xFFFE
            || (code >= 0xFDD0 && code <= 0xFDEF)
    }

    /// Backslash escapes and character references read, as in a destination, a title or an info string.
    static func unescape(_ text: String) -> String {
        let input = Array(text.unicodeScalars)
        var out = String.UnicodeScalarView()
        var index = 0
        while index < input.count {
            let c = input[index]
            if c == "\\", index + 1 < input.count, input[index + 1].isASCIIPunctuation {
                out.append(input[index + 1])
                index += 2
            } else if c == "&", let (decoded, length) = entity(input, index) {
                out.append(contentsOf: decoded.unicodeScalars)
                index += length
            } else {
                out.append(c)
                index += 1
            }
        }
        return String(out)
    }

    /// `<scheme:…>` or `<user@host>` at `at`: the destination, the text, and the length.
    static func autolink(_ input: Scalars, _ at: Int) -> (String, String, Int)? {
        guard at < input.count, input[at] == "<" else { return nil }
        var index = at + 1
        // A URI: a scheme of 2–32 characters, a colon, then no spaces, `<`, `>` or controls.
        let schemeStart = index
        if index < input.count, input[index].isASCIILetter {
            index += 1
            while index < input.count,
                  input[index].isASCIIAlphanumeric || input[index] == "+" || input[index] == "." || input[index] == "-"
            {
                index += 1
            }
            let schemeLength = index - schemeStart
            if schemeLength >= 2, schemeLength <= 32, index < input.count, input[index] == ":" {
                index += 1
                while index < input.count {
                    let c = input[index]
                    if c == ">" {
                        let text = String(String.UnicodeScalarView(input[(at + 1)..<index]))
                        return (text, text, index + 1 - at)
                    }
                    if c == "<" || c.value <= 0x20 || c.value == 0x7F { break }
                    index += 1
                }
            }
        }
        // An email address.
        index = at + 1
        let localStart = index
        while index < input.count, isEmailLocal(input[index]) { index += 1 }
        guard index > localStart, index < input.count, input[index] == "@" else { return nil }
        index += 1
        var labelLength = 0
        var labels = 0
        var lastWasDash = false
        while index < input.count {
            let c = input[index]
            if c.isASCIIAlphanumeric || c == "-" {
                if labelLength == 0, c == "-" { return nil }
                labelLength += 1
                lastWasDash = c == "-"
                if labelLength > 63 { return nil }
                index += 1
            } else if c == "." {
                if labelLength == 0 || lastWasDash { return nil }
                labels += 1
                labelLength = 0
                index += 1
            } else if c == ">" {
                if labelLength == 0 || lastWasDash { return nil }
                let text = String(String.UnicodeScalarView(input[(at + 1)..<index]))
                return ("mailto:" + text, text, index + 1 - at)
            } else {
                return nil
            }
        }
        _ = labels
        return nil
    }

    private static func isEmailLocal(_ c: Unicode.Scalar) -> Bool {
        if c.isASCIIAlphanumeric { return true }
        return ".!#$%&'*+/=?^_`{|}~-".unicodeScalars.contains(c)
    }
}

// MARK: - Raw HTML

enum MarkdownHTML {
    /// The end of the raw HTML at `at`: a tag, a comment, a processing
    /// instruction, a declaration or a CDATA section (CommonMark §6.6).
    static func inline(_ input: Scalars, _ at: Int) -> Int? {
        guard at < input.count, input[at] == "<", at + 1 < input.count else { return nil }
        let next = input[at + 1]
        if next == "!" {
            if starts(input, at, "<!--") {
                if starts(input, at, "<!-->") { return at + 5 }
                if starts(input, at, "<!--->") { return at + 6 }
                return find(input, "-->", from: at + 4).map { $0 + 3 }
            }
            if starts(input, at, "<![CDATA[") {
                return find(input, "]]>", from: at + 9).map { $0 + 3 }
            }
            if at + 2 < input.count, input[at + 2].isASCIILetter {
                return find(input, ">", from: at + 2).map { $0 + 1 }
            }
            return nil
        }
        if next == "?" {
            return find(input, "?>", from: at + 2).map { $0 + 2 }
        }
        return tag(input, at)
    }

    /// An open or closing tag at `at`; where it ends.
    static func tag(_ input: Scalars, _ at: Int) -> Int? {
        guard at < input.count, input[at] == "<" else { return nil }
        var index = at + 1
        if index < input.count, input[index] == "/" {
            index += 1
            guard let afterName = tagName(input, index) else { return nil }
            index = afterName
            index = skipWhitespace(input, index)
            guard index < input.count, input[index] == ">" else { return nil }
            return index + 1
        }
        guard let afterName = tagName(input, index) else { return nil }
        index = afterName
        while true {
            let beforeSpace = index
            index = skipWhitespace(input, index)
            guard index < input.count else { return nil }
            if input[index] == ">" { return index + 1 }
            if input[index] == "/" {
                return index + 1 < input.count && input[index + 1] == ">" ? index + 2 : nil
            }
            // An attribute needs whitespace before it.
            if index == beforeSpace { return nil }
            guard let afterAttribute = attribute(input, index) else { return nil }
            index = afterAttribute
        }
    }

    private static func tagName(_ input: Scalars, _ at: Int) -> Int? {
        guard at < input.count, input[at].isASCIILetter else { return nil }
        var index = at + 1
        while index < input.count, input[index].isASCIIAlphanumeric || input[index] == "-" { index += 1 }
        return index
    }

    private static func attribute(_ input: Scalars, _ at: Int) -> Int? {
        var index = at
        guard index < input.count, input[index].isASCIILetter || input[index] == "_" || input[index] == ":" else { return nil }
        index += 1
        while index < input.count,
              input[index].isASCIIAlphanumeric || input[index] == "_" || input[index] == "." || input[index] == ":"
                || input[index] == "-"
        {
            index += 1
        }
        let afterName = index
        index = skipWhitespace(input, index)
        guard index < input.count, input[index] == "=" else { return afterName }
        index += 1
        index = skipWhitespace(input, index)
        guard index < input.count else { return nil }
        let quote = input[index]
        if quote == "\"" || quote == "'" {
            index += 1
            while index < input.count, input[index] != quote { index += 1 }
            guard index < input.count else { return nil }
            return index + 1
        }
        let start = index
        while index < input.count {
            let c = input[index]
            if c == " " || c == "\t" || c == "\n" || c == "\r" || c == "\"" || c == "'" || c == "=" || c == "<" || c == ">"
                || c == "`"
            {
                break
            }
            index += 1
        }
        return index > start ? index : nil
    }

    private static func skipWhitespace(_ input: Scalars, _ at: Int) -> Int {
        var index = at
        while index < input.count, input[index] == " " || input[index] == "\t" || input[index] == "\n" { index += 1 }
        return index
    }

    static func starts(_ input: Scalars, _ at: Int, _ prefix: String) -> Bool {
        var index = at
        for scalar in prefix.unicodeScalars {
            guard index < input.count, input[index] == scalar else { return false }
            index += 1
        }
        return true
    }

    static func find(_ input: Scalars, _ needle: String, from: Int) -> Int? {
        let wanted = Array(needle.unicodeScalars)
        guard !wanted.isEmpty, input.count >= wanted.count else { return nil }
        var index = from
        while index + wanted.count <= input.count {
            if input[index] == wanted[0], Array(input[index..<(index + wanted.count)]) == wanted { return index }
            index += 1
        }
        return nil
    }
}

// MARK: - Labels, destinations, titles, definitions

enum MarkdownDefinitionScanner {
    struct Label {
        var text: String
        var end: Int
    }

    /// A link label `[…]` at `at`: its raw text and where it ends.
    static func label(_ input: Scalars, _ at: Int) -> Label? {
        guard at < input.count, input[at] == "[" else { return nil }
        var index = at + 1
        var size = 0
        while index < input.count {
            let c = input[index]
            if c == "]" {
                let text = String(String.UnicodeScalarView(input[(at + 1)..<index]))
                return Label(text: text, end: index + 1)
            }
            if c == "[" { return nil }
            if c == "\\", index + 1 < input.count, input[index + 1].isASCIIPunctuation {
                index += 2
                size += 2
            } else {
                index += 1
                size += 1
            }
            if size > 999 { return nil }
        }
        return nil
    }

    struct Inline {
        var destination: String
        var title: String?
        var end: Int
    }

    /// What follows `[text](`: a destination, maybe a title, and `)`.
    static func inlineLink(_ input: Scalars, _ at: Int) -> Inline? {
        var index = skipSpace(input, at, lineEndings: true)
        guard index < input.count else { return nil }
        if input[index] == ")" { return Inline(destination: "", title: nil, end: index + 1) }
        guard let destination = self.destination(input, index) else { return nil }
        index = destination.end
        let afterDestination = index
        index = skipSpace(input, index, lineEndings: true)
        var title: String?
        if index < input.count, index > afterDestination, let scanned = self.title(input, index) {
            title = scanned.text
            index = skipSpace(input, scanned.end, lineEndings: true)
        }
        guard index < input.count, input[index] == ")" else { return nil }
        return Inline(destination: destination.text, title: title, end: index + 1)
    }

    static func skipSpace(_ input: Scalars, _ at: Int, lineEndings: Bool) -> Int {
        var index = at
        var lines = 0
        while index < input.count {
            let c = input[index]
            if c == " " || c == "\t" {
                index += 1
            } else if c == "\n", lineEndings {
                lines += 1
                index += 1
            } else {
                break
            }
        }
        return index
    }

    struct Scanned {
        var text: String
        var end: Int
    }

    static func destination(_ input: Scalars, _ at: Int) -> Scanned? {
        guard at < input.count else { return nil }
        if input[at] == "<" {
            var index = at + 1
            while index < input.count {
                let c = input[index]
                if c == ">" {
                    let raw = String(String.UnicodeScalarView(input[(at + 1)..<index]))
                    return Scanned(text: MarkdownCharacters.unescape(raw), end: index + 1)
                }
                if c == "<" || c == "\n" { return nil }
                if c == "\\", index + 1 < input.count, input[index + 1].isASCIIPunctuation {
                    index += 2
                    continue
                }
                index += 1
            }
            return nil
        }
        var index = at
        var depth = 0
        while index < input.count {
            let c = input[index]
            if c == "\\", index + 1 < input.count, input[index + 1].isASCIIPunctuation {
                index += 2
                continue
            }
            if c == "(" {
                depth += 1
                if depth > 32 { return nil }
            } else if c == ")" {
                if depth == 0 { break }
                depth -= 1
            } else if c.value <= 0x20 || c.value == 0x7F {
                break
            }
            index += 1
        }
        guard index > at, depth == 0 else { return nil }
        let raw = String(String.UnicodeScalarView(input[at..<index]))
        return Scanned(text: MarkdownCharacters.unescape(raw), end: index)
    }

    static func title(_ input: Scalars, _ at: Int) -> Scanned? {
        guard at < input.count else { return nil }
        let open = input[at]
        let close: Unicode.Scalar
        switch open {
        case "\"": close = "\""
        case "'": close = "'"
        case "(": close = ")"
        default: return nil
        }
        var index = at + 1
        while index < input.count {
            let c = input[index]
            if c == "\\", index + 1 < input.count, input[index + 1].isASCIIPunctuation {
                index += 2
                continue
            }
            if c == close {
                let raw = String(String.UnicodeScalarView(input[(at + 1)..<index]))
                return Scanned(text: MarkdownCharacters.unescape(raw), end: index + 1)
            }
            if open == "(", c == "(" { return nil }
            // A blank line ends the paragraph a title would be in.
            if c == "\n", index + 1 < input.count {
                var look = index + 1
                while look < input.count, input[look] == " " || input[look] == "\t" { look += 1 }
                if look < input.count, input[look] == "\n" { return nil }
            }
            index += 1
        }
        return nil
    }

    struct Definition {
        var label: String
        var destination: String
        var title: String?
        /// How many scalars of the text it took, its line's end included.
        var consumed: Int
    }

    /// A link reference definition at the start of `text`.
    static func definition(in text: String) -> Definition? {
        let input = Array(text.unicodeScalars)
        var index = 0
        while index < input.count, index < 3, input[index] == " " { index += 1 }
        guard let label = label(input, index) else { return nil }
        guard label.text.unicodeScalars.contains(where: { !($0 == " " || $0 == "\t" || $0 == "\n") }) else { return nil }
        index = label.end
        guard index < input.count, input[index] == ":" else { return nil }
        index += 1
        index = skipSpace(input, index, lineEndings: false)
        if index < input.count, input[index] == "\n" {
            index += 1
            index = skipSpace(input, index, lineEndings: false)
        }
        guard let destination = destination(input, index), !(destination.text.isEmpty && input[index] != "<") else {
            return nil
        }
        index = destination.end
        let afterDestination = index
        // The rest of the destination's line, if no title follows on it or the next.
        func lineEnd(_ from: Int) -> Int? {
            var at = from
            while at < input.count, input[at] == " " || input[at] == "\t" { at += 1 }
            if at == input.count { return at }
            if input[at] == "\n" { return at + 1 }
            return nil
        }
        var spaced = skipSpace(input, index, lineEndings: false)
        var newline = false
        if spaced < input.count, input[spaced] == "\n" {
            newline = true
            spaced = skipSpace(input, spaced + 1, lineEndings: false)
        }
        if spaced > afterDestination, let title = title(input, spaced), let end = lineEnd(title.end) {
            return Definition(label: label.text, destination: destination.text, title: title.text, consumed: end)
        }
        _ = newline
        guard let end = lineEnd(afterDestination) else { return nil }
        return Definition(label: label.text, destination: destination.text, title: nil, consumed: end)
    }
}

// MARK: - GFM literal autolinks

/// `www.example.com`, `https://example.com`, `user@example.com` without
/// angle brackets: micromark-extension-gfm-autolink-literal's tokenizer, then
/// mdast-util-gfm-autolink-literal's pass over the text that is left.
enum MarkdownLiteralAutolinks {
    struct Found {
        var destination: String
        var text: String
        var length: Int
    }

    static func isAtext(_ c: Unicode.Scalar) -> Bool {
        c == "+" || c == "-" || c == "." || c == "_" || c.isASCIIAlphanumeric
    }

    /// The characters a literal autolink can start at.
    static func mayStart(_ c: Unicode.Scalar) -> Bool { isAtext(c) }

    /// Whether the character before allows one of them to start at `c`.
    static func previousAllows(_ c: Unicode.Scalar, _ previous: Unicode.Scalar?) -> Bool {
        if previousEmail(previous) { return true }
        if c == "w" || c == "W" { return previousWww(previous) }
        if c == "h" || c == "H" { return previousProtocol(previous) }
        return false
    }

    static func previousWww(_ c: Unicode.Scalar?) -> Bool {
        guard let c else { return true }
        return c == "(" || c == "*" || c == "_" || c == "[" || c == "]" || c == "~" || c == " " || c == "\t" || c == "\n"
            || c == "\r"
    }

    static func previousProtocol(_ c: Unicode.Scalar?) -> Bool {
        guard let c else { return true }
        return !c.isASCIILetter
    }

    static func previousEmail(_ c: Unicode.Scalar?) -> Bool {
        guard let c else { return true }
        return !(c == "/" || isAtext(c))
    }

    static func scan(_ input: Scalars, _ at: Int, insideUnbalancedLabel: Bool) -> Found? {
        guard at < input.count, !insideUnbalancedLabel else { return nil }
        let c = input[at]
        let previous: Unicode.Scalar? = at > 0 ? input[at - 1] : nil
        if isAtext(c), previousEmail(previous), let found = email(input, at) { return found }
        if c == "h" || c == "H", previousProtocol(previous), let found = protocolLink(input, at) { return found }
        if c == "w" || c == "W", previousWww(previous), let found = www(input, at) { return found }
        return nil
    }

    private static func isSpaceLike(_ c: Unicode.Scalar?) -> Bool {
        guard let c else { return true }
        return c == " " || c == "\t" || c == "\n" || c == "\r" || MarkdownCharacters.isUnicodeWhitespace(c)
    }

    private static func email(_ input: Scalars, _ at: Int) -> Found? {
        var index = at
        while index < input.count, isAtext(input[index]) { index += 1 }
        guard index < input.count, input[index] == "@", index > at else { return nil }
        index += 1
        var data = false
        var dot = false
        while index < input.count {
            let c = input[index]
            if c == "." {
                // A dot followed by no alphanumeric ends the address before it.
                let next: Unicode.Scalar? = index + 1 < input.count ? input[index + 1] : nil
                if next.map({ $0.isASCIIAlphanumeric }) != true { break }
                dot = true
                index += 1
                continue
            }
            if c == "-" || c == "_" || c.isASCIIAlphanumeric {
                data = true
                index += 1
                continue
            }
            break
        }
        let last = input[index - 1]
        guard data, dot, last.isASCIILetter else { return nil }
        let text = String(String.UnicodeScalarView(input[at..<index]))
        return Found(destination: "mailto:" + text, text: text, length: index - at)
    }

    private static func protocolLink(_ input: Scalars, _ at: Int) -> Found? {
        var index = at
        var buffer = ""
        while index < input.count, input[index].isASCIILetter, buffer.count < 5 {
            buffer.unicodeScalars.append(input[index])
            index += 1
        }
        let scheme = buffer.lowercased()
        guard scheme == "http" || scheme == "https", index + 2 < input.count, input[index] == ":", input[index + 1] == "/",
              input[index + 2] == "/"
        else { return nil }
        index += 3
        guard index < input.count else { return nil }
        let first = input[index]
        if first.value < 0x20 || first.value == 0x7F || isSpaceLike(first) || MarkdownCharacters.isUnicodePunctuation(first) {
            return nil
        }
        guard let afterDomain = domain(input, index) else { return nil }
        let end = path(input, afterDomain)
        let text = String(String.UnicodeScalarView(input[at..<end]))
        return Found(destination: text, text: text, length: end - at)
    }

    private static func www(_ input: Scalars, _ at: Int) -> Found? {
        guard at + 3 < input.count else { return nil }
        for offset in 0..<3 where input[at + offset] != "w" && input[at + offset] != "W" { return nil }
        guard input[at + 3] == ".", at + 4 < input.count else { return nil }
        guard let afterDomain = domain(input, at) else { return nil }
        let end = path(input, afterDomain)
        let text = String(String.UnicodeScalarView(input[at..<end]))
        return Found(destination: "http://" + text, text: text, length: end - at)
    }

    /// micromark's `tokenizeDomain`: where the domain ends, if it is one.
    private static func domain(_ input: Scalars, _ at: Int) -> Int? {
        var index = at
        var underscoreInLast = false
        var underscoreInLastButOne = false
        var seen = false
        while index < input.count {
            let c = input[index]
            if c == "." || c == "_" {
                if trailEnds(input, index) { break }
                if c == "_" {
                    underscoreInLast = true
                } else {
                    underscoreInLastButOne = underscoreInLast
                    underscoreInLast = false
                }
                index += 1
                continue
            }
            if isSpaceLike(c) || (c != "-" && MarkdownCharacters.isUnicodePunctuation(c)) { break }
            seen = true
            index += 1
        }
        if underscoreInLastButOne || underscoreInLast || !seen { return nil }
        return index
    }

    /// micromark's `tokenizePath`: where the path ends, trailing punctuation left out.
    private static func path(_ input: Scalars, _ at: Int) -> Int {
        var index = at
        var open = 0
        var close = 0
        while index < input.count {
            let c = input[index]
            if c == "(" {
                open += 1
                index += 1
                continue
            }
            if c == ")", close < open {
                close += 1
                index += 1
                continue
            }
            if "!\"&')*,.:;<?]_~".unicodeScalars.contains(c) {
                if trailEnds(input, index) { return index }
                if c == ")" { close += 1 }
                index += 1
                continue
            }
            if isSpaceLike(c) { return index }
            index += 1
        }
        return index
    }

    /// micromark's `tokenizeTrail`: whether what starts at `at` is trailing
    /// punctuation running to the link's end.
    private static func trailEnds(_ input: Scalars, _ at: Int) -> Bool {
        var index = at
        while true {
            guard index < input.count else { return true }
            let c = input[index]
            if "!\"')*,.:;?_~".unicodeScalars.contains(c) {
                index += 1
                continue
            }
            if c == "&" {
                index += 1
                guard index < input.count, input[index].isASCIILetter else { return false }
                while index < input.count, input[index].isASCIILetter { index += 1 }
                guard index < input.count, input[index] == ";" else { return false }
                index += 1
                continue
            }
            if c == "]" {
                index += 1
                guard index < input.count else { return true }
                let next = input[index]
                if next == "(" || next == "[" || isSpaceLike(next) { return true }
                continue
            }
            if c == "<" || isSpaceLike(c) { return true }
            return false
        }
    }

    // MARK: The pass over the finished text

    /// mdast-util-gfm-autolink-literal's `transformGfmAutolinkLiterals`:
    /// URLs and addresses in the text the tokenizer left, outside links.
    static func transform(_ inlines: [MarkdownInline]) -> [MarkdownInline] {
        var out: [MarkdownInline] = []
        for inline in inlines {
            switch inline {
            case .text(let text):
                for piece in linkify(text) {
                    if case .text(let value) = piece, case .text(let previous)? = out.last {
                        out[out.count - 1] = .text(previous + value)
                    } else {
                        out.append(piece)
                    }
                }
            case .emphasis(let children): out.append(.emphasis(transform(children)))
            case .strong(let children): out.append(.strong(transform(children)))
            case .delete(let children): out.append(.delete(transform(children)))
            default: out.append(inline)
            }
        }
        return out
    }

    private static func isWordCharacter(_ c: Unicode.Scalar) -> Bool { c.isASCIIAlphanumeric || c == "_" }

    private static func previousOK(_ input: Scalars, _ at: Int, email: Bool) -> Bool {
        guard at > 0 else { return true }
        let c = input[at - 1]
        let ok = MarkdownCharacters.isUnicodeWhitespace(c) || MarkdownCharacters.isUnicodePunctuation(c)
        return ok && (!email || c != "/")
    }

    static func linkify(_ text: String) -> [MarkdownInline] {
        let input = Array(text.unicodeScalars)
        guard input.contains(where: { $0 == "." || $0 == "@" }) else { return [.text(text)] }
        var out: [MarkdownInline] = []
        var plain = 0
        var index = 0
        func flush(_ to: Int) {
            if to > plain { out.append(.text(String(String.UnicodeScalarView(input[plain..<to])))) }
        }
        while index < input.count {
            if let (link, end) = url(input, index) ?? emailAt(input, index) {
                flush(index)
                out.append(contentsOf: link)
                index = end
                plain = end
                continue
            }
            index += 1
        }
        flush(input.count)
        return out
    }

    /// `/(https?:\/\/|www(?=\.))([-.\w]+)([^ \t\r\n]*)/gi` at `at`, through `findUrl`.
    private static func url(_ input: Scalars, _ at: Int) -> ([MarkdownInline], Int)? {
        var index = at
        var protocolText = ""
        var prefix = ""
        let lowerAt = { (offset: Int) -> Unicode.Scalar? in
            at + offset < input.count ? Unicode.Scalar(String(input[at + offset]).lowercased()) : nil
        }
        if lowerAt(0) == "h", lowerAt(1) == "t", lowerAt(2) == "t", lowerAt(3) == "p" {
            var length = 4
            if lowerAt(4) == "s" { length = 5 }
            guard at + length + 2 < input.count, input[at + length] == ":", input[at + length + 1] == "/",
                  input[at + length + 2] == "/"
            else { return nil }
            protocolText = String(String.UnicodeScalarView(input[at..<(at + length + 3)]))
            index = at + length + 3
        } else if lowerAt(0) == "w", lowerAt(1) == "w", lowerAt(2) == "w", at + 3 < input.count, input[at + 3] == "." {
            index = at
            prefix = "http://"
        } else {
            return nil
        }
        guard previousOK(input, at, email: false) else { return nil }
        let domainStart = index
        while index < input.count, isWordCharacter(input[index]) || input[index] == "-" || input[index] == "." { index += 1 }
        guard index > domainStart else { return nil }
        let domainText = String(String.UnicodeScalarView(input[domainStart..<index]))
        let pathStart = index
        while index < input.count, !(input[index] == " " || input[index] == "\t" || input[index] == "\r" || input[index] == "\n") {
            index += 1
        }
        let pathText = String(String.UnicodeScalarView(input[pathStart..<index]))
        guard correctDomain(domainText) else { return nil }
        let (url, trail) = splitUrl(domainText + pathText)
        guard !url.isEmpty else { return nil }
        var result: [MarkdownInline] = [
            .link(destination: prefix + protocolText + url, title: nil, [.text(protocolText + url)])
        ]
        if let trail, !trail.isEmpty { result.append(.text(trail)) }
        return (result, index)
    }

    private static func correctDomain(_ domain: String) -> Bool {
        let parts = domain.components(separatedBy: ".")
        guard parts.count >= 2 else { return false }
        for part in [parts[parts.count - 1], parts[parts.count - 2]] where !part.isEmpty {
            if part.contains("_") || !part.unicodeScalars.contains(where: { $0.isASCIIAlphanumeric }) { return false }
        }
        return true
    }

    private static func splitUrl(_ url: String) -> (String, String?) {
        var scalars = Array(url.unicodeScalars)
        let trailSet = "!\"&'),.:;<>?]}".unicodeScalars
        var cut = scalars.count
        while cut > 0, trailSet.contains(scalars[cut - 1]) { cut -= 1 }
        if cut == scalars.count { return (url, nil) }
        var trail = Array(scalars[cut...])
        scalars = Array(scalars[..<cut])
        let opening = scalars.filter { $0 == "(" }.count
        var closing = scalars.filter { $0 == ")" }.count
        while let paren = trail.firstIndex(of: ")"), opening > closing {
            scalars += trail[...paren]
            trail = Array(trail[(paren + 1)...])
            closing += 1
        }
        return (String(String.UnicodeScalarView(scalars)), String(String.UnicodeScalarView(trail)))
    }

    /// `/(?<=^|\s|\p{P}|\p{S})([-.\w+]+)@([-\w]+(?:\.[-\w]+)+)/gu`, through `findEmail`.
    private static func emailAt(_ input: Scalars, _ at: Int) -> ([MarkdownInline], Int)? {
        let isLocal = { (c: Unicode.Scalar) in isWordCharacter(c) || c == "-" || c == "." || c == "+" }
        guard at < input.count, isLocal(input[at]) else { return nil }
        if at > 0, !(MarkdownCharacters.isUnicodeWhitespace(input[at - 1]) || MarkdownCharacters.isUnicodePunctuation(input[at - 1])) {
            return nil
        }
        var index = at
        while index < input.count, isLocal(input[index]) { index += 1 }
        guard index < input.count, input[index] == "@" else { return nil }
        let localEnd = index
        index += 1
        let isLabel = { (c: Unicode.Scalar) in isWordCharacter(c) || c == "-" }
        let labelStart = index
        while index < input.count, isLabel(input[index]) { index += 1 }
        guard index > labelStart else { return nil }
        var dots = 0
        while index + 1 < input.count, input[index] == ".", isLabel(input[index + 1]) {
            index += 1
            while index < input.count, isLabel(input[index]) { index += 1 }
            dots += 1
        }
        guard dots > 0 else { return nil }
        guard previousOK(input, at, email: true) else { return nil }
        let label = String(String.UnicodeScalarView(input[labelStart..<index]))
        if let last = label.unicodeScalars.last, last == "-" || last == "_" || last.isASCIIDigit { return nil }
        let local = String(String.UnicodeScalarView(input[at..<localEnd]))
        let text = local + "@" + label
        return ([.link(destination: "mailto:" + text, title: nil, [.text(text)])], index)
    }
}

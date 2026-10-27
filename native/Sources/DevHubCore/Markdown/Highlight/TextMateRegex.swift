// The regular expressions of TextMate grammars, on Foundation's engine.
//
// Grammars are written for Oniguruma (vscode-textmate's `onig` scanner;
// Shiki's JavaScript engine translates them with oniguruma-to-es). Foundation's
// `NSRegularExpression` is ICU's engine, which reads almost all of them the
// same way. What differs is translated here, once per pattern:
//
// - `\h` / `\H` are a hex digit / not one (ICU: horizontal space);
// - `\N` is any character but a line's end (ICU: `\N{name}`);
// - `(?~X)`, Oniguruma's absent operator, is `(?:(?!X).)*`;
// - `\g<name>` / `\g<1>`, subexpression calls, are the group's own text,
//   copied in with its groups made non-capturing (so the capture numbers the
//   grammar's `captures` name stay where they are), a bounded depth deep;
// - group names are renamed to what ICU accepts (letters and digits);
// - a `{` that starts no repetition is a literal brace.
//
// A pattern ICU still refuses never matches; `TextMateRegex.refused` counts
// them, and a test holds the vendored grammars to a known handful.

import Foundation

/// One compiled pattern, safe to share: matching never mutates it.
final class TextMateRegex: @unchecked Sendable {
    let source: String
    let regex: NSRegularExpression?
    /// Whether the pattern reads `\G`, so a match found from one position does
    /// not stand for a search from another.
    let anchoredAtSearchStart: Bool

    init(_ source: String) {
        self.source = source
        let translated = TextMateRegexTranslation.translate(source)
        regex = try? NSRegularExpression(pattern: translated, options: [.anchorsMatchLines])
        anchoredAtSearchStart = source.contains("\\G")
    }

    private static let cacheLock = NSLock()
    nonisolated(unsafe) private static var cache: [String: TextMateRegex] = [:]

    /// The compiled pattern for `source`, made once.
    static func of(_ source: String) -> TextMateRegex {
        cacheLock.lock()
        defer { cacheLock.unlock() }
        if let hit = cache[source] { return hit }
        let made = TextMateRegex(source)
        cache[source] = made
        return made
    }

    /// The patterns of the grammars read so far that ICU refused.
    static var refused: [String] {
        cacheLock.lock()
        defer { cacheLock.unlock() }
        return cache.values.filter { $0.regex == nil }.map(\.source).sorted()
    }

    /// The first match at or after `from` in `text`.
    func match(_ text: NSString, from: Int) -> NSTextCheckingResult? {
        guard let regex, from <= text.length else { return nil }
        return regex.firstMatch(
            in: text as String, options: [.withTransparentBounds, .withoutAnchoringBounds],
            range: NSRange(location: from, length: text.length - from))
    }
}

enum TextMateRegexTranslation {
    static func translate(_ source: String) -> String {
        var chars = Array(source)
        chars = expandCalls(chars)
        return rewrite(chars)
    }

    // MARK: - Groups

    struct Group {
        let open: Int
        let close: Int
        let name: String?
        let number: Int?
    }

    /// Every group of the pattern, with its capture number when it captures.
    static func groups(_ chars: [Character]) -> [Group] {
        var stack: [(open: Int, name: String?, number: Int?)] = []
        var groups: [Group] = []
        var number = 0
        var index = 0
        var inClass = 0
        while index < chars.count {
            let c = chars[index]
            if c == "\\" {
                index += 2
                continue
            }
            if inClass > 0 {
                if c == "[" { inClass += 1 } else if c == "]" { inClass -= 1 }
                index += 1
                continue
            }
            if c == "[" {
                inClass = 1
                // A `]` first in a class is a literal.
                if index + 1 < chars.count, chars[index + 1] == "]" { index += 1 }
                else if index + 2 < chars.count, chars[index + 1] == "^", chars[index + 2] == "]" { index += 2 }
                index += 1
                continue
            }
            if c == "(" {
                if index + 1 < chars.count, chars[index + 1] == "?" {
                    // `(?<name>` and `(?'name'` capture; `(?<=` / `(?<!` do not.
                    if index + 2 < chars.count, chars[index + 2] == "<" || chars[index + 2] == "'",
                       index + 3 < chars.count, chars[index + 3] != "=", chars[index + 3] != "!"
                    {
                        let closer: Character = chars[index + 2] == "<" ? ">" : "'"
                        var end = index + 3
                        var name = ""
                        while end < chars.count, chars[end] != closer {
                            name.append(chars[end])
                            end += 1
                        }
                        number += 1
                        stack.append((index, name, number))
                    } else {
                        stack.append((index, nil, nil))
                    }
                } else {
                    number += 1
                    stack.append((index, nil, number))
                }
            } else if c == ")", let top = stack.popLast() {
                groups.append(Group(open: top.open, close: index, name: top.name, number: top.number))
            }
            index += 1
        }
        return groups.sorted { $0.open < $1.open }
    }

    /// `\g<…>` replaced by the group it calls.
    static func expandCalls(_ chars: [Character], depth: Int = 0) -> [Character] {
        guard containsCall(chars) else { return chars }
        let all = groups(chars)
        var out: [Character] = []
        var index = 0
        while index < chars.count {
            if chars[index] == "\\", index + 1 < chars.count {
                if chars[index + 1] == "g", index + 2 < chars.count, chars[index + 2] == "<" || chars[index + 2] == "'" {
                    let closer: Character = chars[index + 2] == "<" ? ">" : "'"
                    var end = index + 3
                    var name = ""
                    while end < chars.count, chars[end] != closer {
                        name.append(chars[end])
                        end += 1
                    }
                    let body: [Character]?
                    if name == "0" {
                        body = chars
                    } else if let number = Int(name) {
                        body = all.first { $0.number == number }.map { Array(chars[($0.open)...($0.close)]) }
                    } else {
                        body = all.first { $0.name == name }.map { Array(chars[($0.open)...($0.close)]) }
                    }
                    if let body, depth < 4 {
                        out += Array("(?:") + nonCapturing(expandCalls(body, depth: depth + 1)) + [")"]
                    } else {
                        // Called deeper than it is followed: nothing there.
                        out += Array("(?:(?!))")
                    }
                    index = end + 1
                    continue
                }
                out.append(chars[index])
                out.append(chars[index + 1])
                index += 2
                continue
            }
            out.append(chars[index])
            index += 1
        }
        return out
    }

    static func containsCall(_ chars: [Character]) -> Bool {
        var index = 0
        while index + 2 < chars.count {
            if chars[index] == "\\" {
                if chars[index + 1] == "g", chars[index + 2] == "<" || chars[index + 2] == "'" { return true }
                index += 2
                continue
            }
            index += 1
        }
        return false
    }

    /// Every capturing group of a copy made non-capturing, and its backreferences dropped.
    static func nonCapturing(_ chars: [Character]) -> [Character] {
        var out: [Character] = []
        var index = 0
        var inClass = 0
        while index < chars.count {
            let c = chars[index]
            if c == "\\", index + 1 < chars.count {
                let next = chars[index + 1]
                if inClass == 0, next == "k", index + 2 < chars.count, chars[index + 2] == "<" {
                    // A backreference into a copy cannot be kept: it names no group of its own.
                    var end = index + 3
                    while end < chars.count, chars[end] != ">" { end += 1 }
                    out += Array("(?:)")
                    index = end + 1
                    continue
                }
                out.append(c)
                out.append(next)
                index += 2
                continue
            }
            if inClass > 0 {
                if c == "[" { inClass += 1 } else if c == "]" { inClass -= 1 }
                out.append(c)
                index += 1
                continue
            }
            if c == "[" {
                inClass = 1
                out.append(c)
                index += 1
                continue
            }
            if c == "(" {
                if index + 1 < chars.count, chars[index + 1] == "?" {
                    if index + 2 < chars.count, chars[index + 2] == "<" || chars[index + 2] == "'",
                       index + 3 < chars.count, chars[index + 3] != "=", chars[index + 3] != "!"
                    {
                        let closer: Character = chars[index + 2] == "<" ? ">" : "'"
                        var end = index + 3
                        while end < chars.count, chars[end] != closer { end += 1 }
                        out += Array("(?:")
                        index = end + 1
                        continue
                    }
                    out.append(c)
                    index += 1
                    continue
                }
                out += Array("(?:")
                index += 1
                continue
            }
            out.append(c)
            index += 1
        }
        return out
    }

    // MARK: - The rest, character by character

    /// Oniguruma's POSIX-style property names, as ICU spells them.
    static func property(_ name: String, negated: Bool, inClass: Bool) -> String {
        let p = negated ? "P" : "p"
        let body: String
        switch name.lowercased() {
        case "upper": body = "\\\(p){Uppercase}"
        case "lower": body = "\\\(p){Lowercase}"
        case "alpha": body = "\\\(p){Alphabetic}"
        case "digit": body = "\\\(p){Nd}"
        case "space": body = "\\\(p){White_Space}"
        case "punct": body = "\\\(p){P}"
        case "word": body = negated ? "\\W" : "\\w"
        case "xdigit": body = negated ? "[^0-9a-fA-F]" : (inClass ? "0-9a-fA-F" : "[0-9a-fA-F]")
        case "alnum":
            if negated { return "[^\\p{Alphabetic}\\p{Nd}]" }
            return inClass ? "\\p{Alphabetic}\\p{Nd}" : "[\\p{Alphabetic}\\p{Nd}]"
        default: body = "\\\(p){\(name)}"
        }
        return body
    }

    static func rewrite(_ chars: [Character]) -> String {
        var out: [Character] = []
        var names: [String: String] = [:]
        var made = 0
        // Oniguruma lets a name be given twice; ICU does not, so each group is
        // named afresh, and a reference reads the last group of that name.
        func icuName(_ name: String, defining: Bool = false) -> String {
            if !defining, let known = names[name] { return known }
            made += 1
            let icu = "g" + String(made) + String(name.filter { $0.isASCII && ($0.isLetter || $0.isNumber) })
            names[name] = icu
            return icu
        }
        func emit(_ text: String) { out += Array(text) }
        // Where the last atom began in `out`, and whether a quantifier followed it.
        var atomStart = 0
        var quantified = false
        // The output positions of the groups open now, and whether each is a lookbehind.
        var groupStarts: [(position: Int, lookbehind: Bool)] = []
        var lookbehinds: Int { groupStarts.filter(\.lookbehind).count }
        func atom(_ start: Int) {
            atomStart = start
            quantified = false
        }
        /// A quantifier after a quantifier repeats what the first one made (Oniguruma), so that is grouped.
        func quantifier(_ text: String) {
            if quantified {
                out.insert(contentsOf: Array("(?:"), at: atomStart)
                out.append(")")
            }
            // ICU's lookbehind must be bounded.
            if lookbehinds > 0, text == "*" || text == "+" || text == "*?" || text == "+?" {
                emit(text.hasPrefix("*") ? "{0,32}" : "{1,32}")
            } else {
                emit(text)
            }
            quantified = true
        }
        var index = 0
        while index < chars.count {
            let c = chars[index]
            let start = out.count
            if c == "\\", index + 1 < chars.count {
                let next = chars[index + 1]
                // `\x{…}`, `\p{…}`, `\N{…}`: copied through their brace.
                if (next == "x" || next == "p" || next == "P" || next == "N" || next == "o" || next == "u"),
                   index + 2 < chars.count, chars[index + 2] == "{"
                {
                    var end = index + 3
                    while end < chars.count, chars[end] != "}" { end += 1 }
                    let inside = String(chars[(index + 3)..<min(end, chars.count)])
                    if next == "p" || next == "P" {
                        var name = inside
                        var negated = next == "P"
                        if name.hasPrefix("^") {
                            negated.toggle()
                            name.removeFirst()
                        }
                        emit(property(name, negated: negated, inClass: false))
                    } else if next == "u" {
                        emit("\\x{\(inside)}")
                    } else {
                        emit(String(chars[index...min(end, chars.count - 1)]))
                    }
                    index = end + 1
                    atom(start)
                    continue
                }
                // `\uHHHH`, `\xHH`: one character.
                if next == "u", index + 5 < chars.count + 0, chars[(index + 2)..<min(index + 6, chars.count)].count == 4,
                   chars[(index + 2)..<(index + 6)].allSatisfy({ $0.isHexDigit })
                {
                    emit("\\x{" + String(chars[(index + 2)..<(index + 6)]) + "}")
                    index += 6
                    atom(start)
                    continue
                }
                if next == "x", index + 3 < chars.count, chars[index + 2].isHexDigit, chars[index + 3].isHexDigit {
                    emit(String(chars[index..<(index + 4)]))
                    index += 4
                    atom(start)
                    continue
                }
                switch next {
                case "h": emit("[0-9a-fA-F]")
                case "H": emit("[^0-9a-fA-F]")
                case "N": emit("[^\\n]")
                case "k":
                    if index + 2 < chars.count, chars[index + 2] == "<" {
                        var end = index + 3
                        var name = ""
                        while end < chars.count, chars[end] != ">" {
                            name.append(chars[end])
                            end += 1
                        }
                        emit(Int(name) != nil ? "\\" + name : "\\k<\(icuName(name))>")
                        index = end + 1
                        atom(start)
                        continue
                    }
                    emit("\\k")
                default:
                    out.append(c)
                    out.append(next)
                }
                index += 2
                atom(start)
                continue
            }
            switch c {
            case "[":
                let end = classEnd(chars, index)
                emit(rewriteClass(Array(chars[index...end])))
                index = end + 1
                atom(start)
                continue
            case "(":
                if index + 2 < chars.count, chars[index + 1] == "?" {
                    if chars[index + 2] == "~" {
                        let close = matchingParen(chars, index)
                        emit("(?:(?!" + rewrite(Array(chars[(index + 3)..<close])) + ").)*")
                        index = close + 1
                        atom(start)
                        continue
                    }
                    if chars[index + 2] == "<" || chars[index + 2] == "'", index + 3 < chars.count,
                       chars[index + 3] != "=", chars[index + 3] != "!"
                    {
                        let closer: Character = chars[index + 2] == "<" ? ">" : "'"
                        var end = index + 3
                        var name = ""
                        while end < chars.count, chars[end] != closer {
                            name.append(chars[end])
                            end += 1
                        }
                        groupStarts.append((start, false))
                        emit("(?<\(icuName(name, defining: true))>")
                        index = end + 1
                        continue
                    }
                    // The group's whole opening: `(?:`, `(?=`, `(?<!`, `(?>`, `(?i:`; or flags `(?i)`.
                    var end = index + 2
                    if chars[end] == "<" { end += 1 }
                    if end < chars.count, ":=!>".contains(chars[end]) {
                        end += 1
                    } else {
                        while end < chars.count, "imsxwWdDaAuU-".contains(chars[end]) { end += 1 }
                        if end < chars.count, chars[end] == ")" {
                            // Flags for the rest of the group: not a group of its own.
                            emit(String(chars[index...end]))
                            index = end + 1
                            continue
                        }
                        if end < chars.count, chars[end] == ":" { end += 1 }
                        if chars[index + 2] == "#" {
                            // A comment: dropped.
                            index = matchingParen(chars, index) + 1
                            continue
                        }
                    }
                    let lookbehind = chars[index + 2] == "<"
                    groupStarts.append((start, lookbehind))
                    emit(String(chars[index..<end]))
                    index = end
                    continue
                }
                groupStarts.append((start, false))
                out.append(c)
                index += 1
                continue
            case ")":
                out.append(c)
                let open = groupStarts.popLast()?.position ?? start
                index += 1
                atom(open)
                continue
            case "{":
                if isInterval(chars, index) {
                    var end = index
                    while chars[end] != "}" { end += 1 }
                    var body = String(chars[(index + 1)..<end])
                    if body.hasPrefix(",") { body = "0" + body }
                    index = end + 1
                    var lazy = ""
                    if index < chars.count, chars[index] == "?" || chars[index] == "+" {
                        lazy = String(chars[index])
                        index += 1
                    }
                    quantifier("{" + body + "}" + lazy)
                    continue
                }
                emit("\\{")
                index += 1
                atom(start)
                continue
            case "}":
                emit("\\}")
                index += 1
                atom(start)
                continue
            case "*", "+", "?":
                var text = String(c)
                index += 1
                if index < chars.count, chars[index] == "?" || chars[index] == "+" {
                    text.append(chars[index])
                    index += 1
                }
                quantifier(text)
                continue
            default:
                out.append(c)
                index += 1
                atom(start)
                continue
            }
        }
        return String(out)
    }

    /// Where the class opened at `at` closes.
    static func classEnd(_ chars: [Character], _ at: Int) -> Int {
        var index = at + 1
        if index < chars.count, chars[index] == "^" { index += 1 }
        if index < chars.count, chars[index] == "]" { index += 1 }
        var depth = 1
        while index < chars.count {
            let c = chars[index]
            if c == "\\" {
                index += 2
                continue
            }
            if c == "[" {
                if index + 1 < chars.count, chars[index + 1] == ":" {
                    var end = index + 2
                    while end < chars.count, chars[end] != "]" { end += 1 }
                    index = end + 1
                    continue
                }
                depth += 1
                index += 1
                if index < chars.count, chars[index] == "^" { index += 1 }
                if index < chars.count, chars[index] == "]" { index += 1 }
                continue
            }
            if c == "]" {
                depth -= 1
                if depth == 0 { return index }
            }
            index += 1
        }
        return chars.count - 1
    }

    /// A character class, Oniguruma's way of writing it made ICU's.
    static func rewriteClass(_ chars: [Character]) -> String {
        var out = "["
        var index = 1
        if index < chars.count, chars[index] == "^" {
            out += "^"
            index += 1
        }
        if index < chars.count, chars[index] == "]" {
            out += "\\]"
            index += 1
        }
        let last = chars.count - 1
        while index < last {
            let c = chars[index]
            if c == "\\", index + 1 < chars.count {
                let next = chars[index + 1]
                if (next == "p" || next == "P" || next == "x" || next == "u"), index + 2 < chars.count, chars[index + 2] == "{" {
                    var end = index + 3
                    while end < chars.count, chars[end] != "}" { end += 1 }
                    let inside = String(chars[(index + 3)..<min(end, chars.count)])
                    if next == "p" || next == "P" {
                        var name = inside
                        var negated = next == "P"
                        if name.hasPrefix("^") {
                            negated.toggle()
                            name.removeFirst()
                        }
                        out += property(name, negated: negated, inClass: true)
                    } else if next == "u" {
                        out += "\\x{\(inside)}"
                    } else {
                        out += String(chars[index...min(end, chars.count - 1)])
                    }
                    index = end + 1
                    continue
                }
                switch next {
                case "h": out += "0-9a-fA-F"
                case "H": out += "\\x{0}-/:-@G-`g-\\x{10FFFF}"
                case "N": out += "\\x{0}-\\x{9}\\x{B}-\\x{10FFFF}"
                default:
                    out.append(c)
                    out.append(next)
                }
                index += 2
                continue
            }
            if c == "[" {
                if index + 1 < chars.count, chars[index + 1] == ":" {
                    var end = index + 2
                    while end < chars.count, chars[end] != "]" { end += 1 }
                    out += String(chars[index...min(end, chars.count - 1)])
                    index = end + 1
                    continue
                }
                let end = classEnd(chars, index)
                out += rewriteClass(Array(chars[index...end]))
                index = end + 1
                continue
            }
            // ICU reads these as operators inside a class; Oniguruma as themselves.
            if c == "[" || c == "{" || c == "}" || c == "$" {
                out += "\\" + String(c)
            } else if c == "&", index + 1 < last, chars[index + 1] == "&" {
                out += "&&"
                index += 2
                continue
            } else if c == "-", index + 1 < last, chars[index + 1] == "-" {
                out += "\\-"
            } else {
                out.append(c)
            }
            index += 1
        }
        return out + "]"
    }

    static func isInterval(_ chars: [Character], _ at: Int) -> Bool {
        var index = at + 1
        var digits = 0
        var comma = false
        while index < chars.count {
            let c = chars[index]
            if c == "}" { return digits > 0 }
            if c == "," {
                if comma { return false }
                comma = true
            } else if c.isASCII, c.isNumber {
                digits += 1
            } else {
                return false
            }
            index += 1
        }
        return false
    }

    static func matchingParen(_ chars: [Character], _ open: Int) -> Int {
        var depth = 0
        var index = open
        var inClass = false
        while index < chars.count {
            let c = chars[index]
            if c == "\\" {
                index += 2
                continue
            }
            if inClass {
                if c == "]" { inClass = false }
            } else if c == "[" {
                inClass = true
            } else if c == "(" {
                depth += 1
            } else if c == ")" {
                depth -= 1
                if depth == 0 { return index }
            }
            index += 1
        }
        return chars.count - 1
    }
}

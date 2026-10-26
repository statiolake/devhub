// Port of toml-eslint-parser 1.0.3 (https://github.com/ota-meshi/toml-eslint-parser),
// the TOML parser the TypeScript app reads `settings.toml` with
// (`model/tomlDocument.ts`). MIT License, Copyright (c) 2021 Yosuke Ota:
//
//   Permission is hereby granted, free of charge, to any person obtaining a
//   copy of this software and associated documentation files (the
//   "Software"), to deal in the Software without restriction, including
//   without limitation the rights to use, copy, modify, merge, publish,
//   distribute, sublicense, and/or sell copies of the Software, and to permit
//   persons to whom the Software is furnished to do so, subject to the
//   following conditions: The above copyright notice and this permission
//   notice shall be included in all copies or substantial portions of the
//   Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
//
// Ported rather than written afresh because the two apps share one file: the
// same document must parse to the same values, be refused for the same reason
// at the same line and column, and expose the same source ranges, which is
// what `TomlDocument`'s in-place edits splice at. The default TOML version of
// that release is 1.1 (`\e` and `\xHH` escapes, newlines and a trailing comma
// in inline tables, times without seconds), so that is what this accepts.
//
// Offsets are UTF-16 code units and lines count from 1, columns from 0 — the
// JS string indices the TypeScript code works in.

import Foundation

/// A document that could not be parsed at all.
public struct TomlSyntaxError: Error, Equatable, CustomStringConvertible, Sendable {
    public let message: String
    /// The UTF-16 offset the parser stopped at.
    public let offset: Int?
    public let line: Int?
    public let column: Int?

    public init(_ message: String, offset: Int? = nil, line: Int? = nil, column: Int? = nil) {
        self.message = message
        self.offset = offset
        self.line = line
        self.column = column
    }

    public var description: String {
        if let line, let column { return "\(message) (line \(line), column \(column))" }
        return message
    }
}

// MARK: - AST

/// A path segment of a table's resolved key: a name, or the index of an
/// array-of-tables element.
public enum TomlPathSegment: Equatable, Hashable, Sendable, CustomStringConvertible {
    case key(String)
    case index(Int)

    public var description: String {
        switch self {
        case .key(let name): return name
        case .index(let index): return String(index)
        }
    }
}

final class TomlKeyPart {
    enum Kind { case bare, quoted }
    let kind: Kind
    let name: String
    var range: (Int, Int)
    var loc: TomlLoc
    init(kind: Kind, name: String, range: (Int, Int), loc: TomlLoc) {
        self.kind = kind
        self.name = name
        self.range = range
        self.loc = loc
    }
}

final class TomlKeyNode {
    var parts: [TomlKeyPart] = []
    var range: (Int, Int)
    var loc: TomlLoc
    init(range: (Int, Int), loc: TomlLoc) {
        self.range = range
        self.loc = loc
    }
    var names: [String] { parts.map(\.name) }
}

struct TomlPos: Equatable { var line: Int; var column: Int }
struct TomlLoc: Equatable { var start: TomlPos; var end: TomlPos }

/// A value node: a scalar, an array, or an inline table.
final class TomlValueNode {
    enum Kind {
        case string(String)
        case number(Double)
        case bool(Bool)
        case datetime(TomlDateTime)
        case array([TomlValueNode])
        case inlineTable([TomlKeyValueNode])
    }
    var kind: Kind
    var range: (Int, Int)
    var loc: TomlLoc
    init(kind: Kind, range: (Int, Int), loc: TomlLoc) {
        self.kind = kind
        self.range = range
        self.loc = loc
    }
}

final class TomlKeyValueNode {
    var key: TomlKeyNode!
    var value: TomlValueNode!
    var range: (Int, Int)
    var loc: TomlLoc
    init(range: (Int, Int), loc: TomlLoc) {
        self.range = range
        self.loc = loc
    }
}

final class TomlTableNode {
    enum Kind: Equatable { case standard, array }
    var kind: Kind = .standard
    var key: TomlKeyNode!
    var resolvedKey: [TomlPathSegment] = []
    var body: [TomlKeyValueNode] = []
    var range: (Int, Int)
    var loc: TomlLoc
    init(range: (Int, Int), loc: TomlLoc) {
        self.range = range
        self.loc = loc
    }
}

/// One entry of the top-level body: a pair before the first heading, or a table.
enum TomlTopLevelNode {
    case keyValue(TomlKeyValueNode)
    case table(TomlTableNode)
}

/// A parsed document: the top-level body, in source order.
final class TomlProgram {
    var body: [TomlTopLevelNode] = []
}

// MARK: - Tokens

private enum TokenType: Equatable {
    case punctuator, bare, basicString, literalString, multiLineBasicString, multiLineLiteralString
    case integer, float, boolean, localDate, localTime, localDateTime, offsetDateTime, block
}

private struct Token {
    let type: TokenType
    /// The source text of the token.
    let value: String
    let range: (Int, Int)
    let loc: TomlLoc
    var string: String = ""
    var number: Double = 0
    var boolean: Bool = false
    var date: TomlDateTime?
}

private enum ErrorCode: String {
    case unterminatedString = "unterminated-string"
    case unterminatedTableKey = "unterminated-table-key"
    case unterminatedArray = "unterminated-array"
    case unterminatedInlineTable = "unterminated-inline-table"
    case missingKey = "missing-key"
    case missingNewline = "missing-newline"
    case missingEqualsSign = "missing-equals-sign"
    case missingValue = "missing-value"
    case missingComma = "missing-comma"
    case dupeKeys = "dupe-keys"
    case unexpectedChar = "unexpected-char"
    case unexpectedToken = "unexpected-token"
    case invalidControlCharacter = "invalid-control-character"
    case invalidCommentCharacter = "invalid-comment-character"
    case invalidKeyValueNewline = "invalid-key-value-newline"
    case invalidUnderscore = "invalid-underscore"
    case invalidSpace = "invalid-space"
    case invalidThreeQuotes = "invalid-three-quotes"
    case invalidDate = "invalid-date"
    case invalidTime = "invalid-time"
    case invalidLeadingZero = "invalid-leading-zero"
    case invalidCharInEscapeSequence = "invalid-char-in-escape-sequence"
    case invalidConsecutiveDotsInKey = "invalid-consecutive-dots-in-key"
    case invalidCodePoint = "invalid-code-point"
    case invalidTrailingDotInKey = "invalid-trailing-dot-in-key"
    case invalidLeadingDotInKey = "invalid-leading-dot-in-key"

    var message: String {
        switch self {
        case .unterminatedString: return "Unterminated string constant"
        case .unterminatedTableKey: return "Unterminated table-key"
        case .unterminatedArray: return "Unterminated array"
        case .unterminatedInlineTable: return "Unterminated inline table"
        case .missingKey: return "Empty bare keys are not allowed"
        case .missingNewline: return "Must be a newline"
        case .missingEqualsSign: return "Expected equal (=) token"
        case .missingValue: return "Unspecified values are invalid"
        case .missingComma: return "Expected comma (,) token"
        case .dupeKeys: return "Defining a key multiple times is invalid"
        case .unexpectedChar: return "Unexpected character"
        case .unexpectedToken: return "Unexpected token"
        case .invalidControlCharacter: return "Control characters (codes < 0x1f and 0x7f) are not allowed"
        case .invalidCommentCharacter: return "Invalid code point {{cp}} within comments"
        case .invalidKeyValueNewline: return "The key, equals sign, and value must be on the same line"
        case .invalidUnderscore: return "Underscores are allowed between digits"
        case .invalidSpace: return "Unexpected spaces"
        case .invalidThreeQuotes: return "Three or more quotes are not permitted"
        case .invalidDate: return "Unexpected invalid date"
        case .invalidTime: return "Unexpected invalid time"
        case .invalidLeadingZero: return "Leading zeros are not allowed"
        case .invalidCharInEscapeSequence: return "Invalid character in escape sequence"
        case .invalidConsecutiveDotsInKey: return "Consecutive dots are not permitted in keys"
        case .invalidCodePoint: return "Invalid code point {{cp}}"
        case .invalidTrailingDotInKey: return "Keys cannot end with a dot"
        case .invalidLeadingDotInKey: return "Keys cannot start with a dot"
        }
    }
}

// MARK: - Code points

private enum CP {
    static let eof: Int32 = -1
    static let null: Int32 = 0
    static let backspace: Int32 = 8
    static let tab: Int32 = 9
    static let lf: Int32 = 10
    static let ff: Int32 = 12
    static let cr: Int32 = 13
    static let esc: Int32 = 27
    static let us: Int32 = 31
    static let space: Int32 = 32
    static let quote: Int32 = 34
    static let hash: Int32 = 35
    static let singleQuote: Int32 = 39
    static let plus: Int32 = 43
    static let comma: Int32 = 44
    static let dash: Int32 = 45
    static let dot: Int32 = 46
    static let d0: Int32 = 48
    static let d1: Int32 = 49
    static let d7: Int32 = 55
    static let d9: Int32 = 57
    static let colon: Int32 = 58
    static let equals: Int32 = 61
    static let A: Int32 = 65
    static let E: Int32 = 69
    static let F: Int32 = 70
    static let T: Int32 = 84
    static let U: Int32 = 85
    static let Z: Int32 = 90
    static let leftBracket: Int32 = 91
    static let backslash: Int32 = 92
    static let rightBracket: Int32 = 93
    static let underscore: Int32 = 95
    static let a: Int32 = 97
    static let b: Int32 = 98
    static let e: Int32 = 101
    static let f: Int32 = 102
    static let i: Int32 = 105
    static let l: Int32 = 108
    static let n: Int32 = 110
    static let o: Int32 = 111
    static let r: Int32 = 114
    static let s: Int32 = 115
    static let t: Int32 = 116
    static let u: Int32 = 117
    static let x: Int32 = 120
    static let z: Int32 = 122
    static let leftBrace: Int32 = 123
    static let rightBrace: Int32 = 125
    static let tilde: Int32 = 126
    static let delete: Int32 = 127
    static let pad: Int32 = 128
}

private func isControl(_ cp: Int32) -> Bool { cp >= CP.null && cp <= CP.us }
private func isWhitespace(_ cp: Int32) -> Bool { cp == CP.tab || cp == CP.space }
private func isEOL(_ cp: Int32) -> Bool { cp == CP.lf || cp == CP.cr }
private func isUpperLetter(_ cp: Int32) -> Bool { cp >= CP.A && cp <= CP.Z }
private func isLowerLetter(_ cp: Int32) -> Bool { cp >= CP.a && cp <= CP.z }
private func isLetter(_ cp: Int32) -> Bool { isLowerLetter(cp) || isUpperLetter(cp) }
private func isDigit(_ cp: Int32) -> Bool { cp >= CP.d0 && cp <= CP.d9 }
private func isHexDig(_ cp: Int32) -> Bool {
    isDigit(cp) || (cp >= CP.a && cp <= CP.f) || (cp >= CP.A && cp <= CP.F)
}
private func isOctalDig(_ cp: Int32) -> Bool { cp >= CP.d0 && cp <= CP.d7 }
private func isBinaryDig(_ cp: Int32) -> Bool { cp == CP.d0 || cp == CP.d1 }
private func isUnicodeScalarValue(_ cp: Int) -> Bool { (cp >= 0 && cp <= 55295) || (cp >= 57344 && cp <= 1_114_111) }
private func isUnquotedKeyChar(_ cp: Int32) -> Bool {
    isLetter(cp) || isDigit(cp) || cp == CP.underscore || cp == CP.dash
}
private func isControlOtherThanTab(_ cp: Int32) -> Bool { (isControl(cp) && cp != CP.tab) || cp == CP.delete }
private func isNonAscii(_ cp: Int32) -> Bool { (CP.pad <= cp && cp <= 55295) || (57344 <= cp && cp <= 1_114_111) }
private func isNonEOL(_ cp: Int32) -> Bool { cp == CP.tab || (CP.space <= cp && cp <= CP.tilde) || isNonAscii(cp) }

private func isValidDate(_ y: Int, _ m: Int, _ d: Int) -> Bool {
    if y >= 0 && m <= 12 && m >= 1 && d >= 1 {
        let max: Int
        if m == 2 {
            max = ((y & 3) != 0 || ((y % 25) == 0 && (y & 15) != 0)) ? 28 : 29
        } else {
            max = 30 + ((m + (m >> 3)) & 1)
        }
        return d <= max
    }
    return false
}

private func isValidTime(_ h: Int, _ m: Int, _ s: Int) -> Bool {
    !(h >= 24 || h < 0 || m > 59 || m < 0 || s > 60 || s < 0)
}

// MARK: - Locations and the code point iterator

private struct Locations {
    var offsets: [Int] = []

    mutating func addOffset(_ offset: Int) {
        var i = offsets.count - 1
        while i >= 0 {
            let element = offsets[i]
            if element == offset { return }
            if element < offset { break }
            i -= 1
        }
        offsets.append(offset)
    }

    func loc(_ offset: Int) -> TomlPos {
        // sortedLastIndex
        var low = 0
        var high = offsets.count
        var found: Int?
        while low < high {
            let mid = (low + high) >> 1
            let value = offsets[mid]
            if value == offset { found = mid + 1; break }
            if value < offset { low = mid + 1 } else { high = mid }
        }
        let line = (found ?? low) + 1
        return TomlPos(line: line, column: offset - (line == 1 ? 0 : offsets[line - 2]))
    }
}

private struct CodePointIterator {
    let text: [UInt16]
    var locs = Locations()
    var lastCodePoint: Int32 = CP.null
    var start = -1
    var end = 0

    init(_ text: [UInt16]) { self.text = text }

    func codePointAt(_ index: Int) -> Int32? {
        guard index >= 0, index < text.count else { return nil }
        let unit = text[index]
        if unit >= 0xD800 && unit <= 0xDBFF, index + 1 < text.count {
            let next = text[index + 1]
            if next >= 0xDC00 && next <= 0xDFFF {
                return Int32((Int(unit) - 0xD800) * 0x400 + (Int(next) - 0xDC00) + 0x10000)
            }
        }
        return Int32(unit)
    }

    mutating func next() -> Int32 {
        if lastCodePoint == CP.eof { return CP.eof }
        lastCodePoint = moveAt(end)
        return lastCodePoint
    }

    mutating func eat(_ cp: Int32) -> Bool {
        if codePointAt(end) == cp {
            _ = next()
            return true
        }
        return false
    }

    mutating func moveAt(_ offset: Int) -> Int32 {
        start = offset
        end = offset
        guard let cp = codePointAt(start) else {
            end = start
            return CP.eof
        }
        end += cp >= 65536 ? 2 : 1
        if cp == CP.lf {
            locs.addOffset(end)
        } else if cp == CP.cr {
            if codePointAt(end) == CP.lf {
                end += 1
                locs.addOffset(end)
            }
            return CP.lf
        }
        return cp
    }
}

private struct DateTimeData {
    var hasDate = false
    var year = 0
    var month = 0
    var day = 0
    var hour = 0
    var minute = 0
    var second = 0
    var frac: String?
    var offsetSign: Int32 = 0
}

private struct NumberData {
    var minus = false
    var digits: [Int32] = []
}

// MARK: - Tokenizer

private enum TokenizerState {
    case data, comment, bare, basicString, multiLineBasicString, literalString, multiLineLiteralString
    case sign, nanOrInf, number, hex, octal, binary, fractionalRight, exponentRight, boolean
    case dateMonth, dateDay, timeHour, timeMinute, timeSecond, timeSecFrac, timeOffset
}

private struct Tokenizer {
    var iterator: CodePointIterator
    let text: [UInt16]
    var backCode = false
    var lastCodePoint: Int32 = CP.null
    var state: TokenizerState = .data
    var token: Token?
    var tokenStart = -1
    var valuesEnabled = false
    var dateData = DateTimeData()
    var numberData = NumberData()

    init(_ text: [UInt16]) {
        self.text = text
        iterator = CodePointIterator(text)
    }

    var start: Int { iterator.start }
    var end: Int { iterator.end }

    func loc(_ offset: Int) -> TomlPos { iterator.locs.loc(offset) }

    func slice(_ from: Int, _ to: Int) -> String {
        let lower = max(0, min(from, text.count))
        let upper = max(lower, min(to, text.count))
        return String(decoding: text[lower..<upper], as: UTF16.self)
    }

    func error(_ code: ErrorCode, data: String? = nil) -> TomlSyntaxError {
        let offset = iterator.start
        let pos = loc(offset)
        var message = code.message
        if let data { message = message.replacingOccurrences(of: "{{cp}}", with: data) }
        return TomlSyntaxError(message, offset: offset, line: pos.line, column: pos.column)
    }

    mutating func nextToken() throws -> Token? {
        if let token {
            self.token = nil
            return token
        }
        var cp = lastCodePoint
        while cp != CP.eof && token == nil {
            cp = nextCode()
            state = try step(state, cp)
        }
        let result = token
        token = nil
        return result
    }

    mutating func nextCode() -> Int32 {
        if lastCodePoint == CP.eof { return CP.eof }
        if backCode {
            backCode = false
            return lastCodePoint
        }
        lastCodePoint = iterator.next()
        return lastCodePoint
    }

    mutating func eatCode(_ cp: Int32) -> Bool {
        if lastCodePoint == CP.eof { return false }
        if backCode {
            if lastCodePoint == cp {
                backCode = false
                return true
            }
            return false
        }
        return iterator.eat(cp)
    }

    mutating func moveAt(_ offset: Int) {
        if backCode { backCode = false }
        lastCodePoint = iterator.moveAt(offset)
    }

    mutating func back(_ state: TokenizerState) -> TokenizerState {
        backCode = true
        return state
    }

    mutating func startToken() { tokenStart = iterator.start }

    mutating func punctuatorToken() {
        startToken()
        endToken(.punctuator, atEnd: true)
    }

    mutating func endToken(
        _ type: TokenType,
        atEnd: Bool,
        string: String = "",
        number: Double = 0,
        boolean: Bool = false,
        date: TomlDateTime? = nil
    ) {
        let end = atEnd ? iterator.end : iterator.start
        let range = (tokenStart, end)
        let loc = TomlLoc(start: self.loc(tokenStart), end: self.loc(end))
        let value = type == .block ? slice(tokenStart + 1, end) : slice(tokenStart, end)
        var token = Token(type: type, value: value, range: range, loc: loc)
        token.string = string
        token.number = number
        token.boolean = boolean
        token.date = date
        self.token = token
    }

    mutating func step(_ state: TokenizerState, _ cp: Int32) throws -> TokenizerState {
        switch state {
        case .data: return try dataState(cp)
        case .comment: return try commentState(cp)
        case .bare: return bareState(cp)
        case .basicString: return try basicStringState(cp)
        case .multiLineBasicString: return try multiLineBasicStringState(cp)
        case .literalString: return try literalStringState(cp)
        case .multiLineLiteralString: return try multiLineLiteralStringState(cp)
        case .sign: return try signState(cp)
        case .nanOrInf: return try nanOrInfState(cp)
        case .number: return try numberState(cp)
        case .hex: return try radixState(cp, isHexDig, 16)
        case .octal: return try radixState(cp, isOctalDig, 8)
        case .binary: return try radixState(cp, isBinaryDig, 2)
        case .fractionalRight: return try fractionalRightState(cp)
        case .exponentRight: return try exponentRightState(cp)
        case .boolean: return try booleanState(cp)
        case .dateMonth: return try dateMonthState(cp)
        case .dateDay: return try dateDayState(cp)
        case .timeHour: return try timeHourState(cp)
        case .timeMinute: return try timeMinuteState(cp)
        case .timeSecond: return try timeSecondState(cp)
        case .timeSecFrac: return try timeSecFracState(cp)
        case .timeOffset: return try timeOffsetState(cp)
        }
    }

    mutating func dataState(_ cpIn: Int32) throws -> TokenizerState {
        var cp = cpIn
        while isWhitespace(cp) || isEOL(cp) { cp = nextCode() }
        if cp == CP.hash {
            startToken()
            return .comment
        }
        if cp == CP.quote {
            startToken()
            return .basicString
        }
        if cp == CP.singleQuote {
            startToken()
            return .literalString
        }
        if cp == CP.dot || cp == CP.equals || cp == CP.leftBracket || cp == CP.rightBracket
            || cp == CP.leftBrace || cp == CP.rightBrace || cp == CP.comma
        {
            punctuatorToken()
            return .data
        }
        if valuesEnabled {
            if cp == CP.dash || cp == CP.plus {
                startToken()
                return .sign
            }
            if cp == CP.n || cp == CP.i {
                startToken()
                return back(.nanOrInf)
            }
            if isDigit(cp) {
                startToken()
                return back(.number)
            }
            if cp == CP.t || cp == CP.f {
                startToken()
                return back(.boolean)
            }
        } else if isUnquotedKeyChar(cp) {
            startToken()
            return .bare
        }
        if cp == CP.eof { return .data }
        throw error(.unexpectedChar)
    }

    mutating func commentState(_ cpIn: Int32) throws -> TokenizerState {
        var cp = cpIn
        while !isEOL(cp) && cp != CP.eof {
            if !isNonEOL(cp) {
                throw error(.invalidCommentCharacter, data: Self.jsonEscaped(cp))
            }
            cp = nextCode()
        }
        endToken(.block, atEnd: false)
        return .data
    }

    /// `JSON.stringify(String.fromCodePoint(c)).slice(1, -1)`.
    static func jsonEscaped(_ cp: Int32) -> String {
        switch cp {
        case 0x08: return "\\b"
        case 0x09: return "\\t"
        case 0x0A: return "\\n"
        case 0x0C: return "\\f"
        case 0x0D: return "\\r"
        case 0x22: return "\\\""
        case 0x5C: return "\\\\"
        default:
            if cp < 0x20 || (cp >= 0xD800 && cp <= 0xDFFF) {
                let hex = String(cp, radix: 16)
                return "\\u" + String(repeating: "0", count: max(0, 4 - hex.count)) + hex
            }
            return Unicode.Scalar(UInt32(cp)).map { String(Character($0)) } ?? ""
        }
    }

    mutating func bareState(_ cpIn: Int32) -> TokenizerState {
        var cp = cpIn
        while isUnquotedKeyChar(cp) { cp = nextCode() }
        endToken(.bare, atEnd: false)
        return back(.data)
    }

    func escape(_ cp: Int32) -> Int32? {
        switch cp {
        case CP.quote: return CP.quote
        case CP.backslash: return CP.backslash
        case CP.b: return CP.backspace
        case CP.f: return CP.ff
        case CP.n: return CP.lf
        case CP.r: return CP.cr
        case CP.t: return CP.tab
        case CP.e: return CP.esc
        default: return nil
        }
    }

    static func string(_ codePoints: [Int32]) -> String {
        var view = String.UnicodeScalarView()
        for cp in codePoints {
            if let scalar = Unicode.Scalar(UInt32(bitPattern: cp)) { view.append(scalar) } else { view.append("\u{FFFD}") }
        }
        return String(view)
    }

    mutating func basicStringState(_ cpIn: Int32) throws -> TokenizerState {
        var cp = cpIn
        if cp == CP.quote {
            cp = nextCode()
            if cp == CP.quote { return .multiLineBasicString }
            endToken(.basicString, atEnd: false, string: "")
            return back(.data)
        }
        var out: [Int32] = []
        while cp != CP.quote && cp != CP.eof && cp != CP.lf {
            if isControlOtherThanTab(cp) { throw error(.invalidControlCharacter) }
            if cp == CP.backslash {
                cp = nextCode()
                if let ecp = escape(cp) {
                    out.append(ecp)
                    cp = nextCode()
                    continue
                } else if cp == CP.u {
                    out.append(try parseUnicode(4))
                    cp = nextCode()
                    continue
                } else if cp == CP.U {
                    out.append(try parseUnicode(8))
                    cp = nextCode()
                    continue
                } else if cp == CP.x {
                    out.append(try parseUnicode(2))
                    cp = nextCode()
                    continue
                }
                throw error(.invalidCharInEscapeSequence)
            }
            out.append(cp)
            cp = nextCode()
        }
        if cp != CP.quote { throw error(.unterminatedString) }
        endToken(.basicString, atEnd: true, string: Self.string(out))
        return .data
    }

    mutating func multiLineBasicStringState(_ cpIn: Int32) throws -> TokenizerState {
        var cp = cpIn
        var out: [Int32] = []
        if cp == CP.lf { cp = nextCode() }
        while cp != CP.eof {
            if cp != CP.lf && isControlOtherThanTab(cp) { throw error(.invalidControlCharacter) }
            if cp == CP.quote {
                let startPos = iterator.start
                if eatCode(CP.quote) && eatCode(CP.quote) {
                    if eatCode(CP.quote) {
                        out.append(CP.quote)
                        if eatCode(CP.quote) {
                            out.append(CP.quote)
                            if eatCode(CP.quote) {
                                moveAt(startPos)
                                throw error(.invalidThreeQuotes)
                            }
                        }
                    }
                    endToken(.multiLineBasicString, atEnd: true, string: Self.string(out))
                    return .data
                }
                moveAt(startPos)
            }
            if cp == CP.backslash {
                cp = nextCode()
                if let ecp = escape(cp) {
                    out.append(ecp)
                    cp = nextCode()
                    continue
                } else if cp == CP.u {
                    out.append(try parseUnicode(4))
                    cp = nextCode()
                    continue
                } else if cp == CP.U {
                    out.append(try parseUnicode(8))
                    cp = nextCode()
                    continue
                } else if cp == CP.x {
                    out.append(try parseUnicode(2))
                    cp = nextCode()
                    continue
                } else if cp == CP.lf {
                    cp = nextCode()
                    while isWhitespace(cp) || cp == CP.lf { cp = nextCode() }
                    continue
                } else if isWhitespace(cp) {
                    var valid = true
                    let startPos = iterator.start
                    while true {
                        let nextCp = nextCode()
                        if nextCp == CP.eof { break }
                        if nextCp == CP.lf { break }
                        if !isWhitespace(nextCp) {
                            moveAt(startPos)
                            valid = false
                            break
                        }
                    }
                    if valid {
                        cp = nextCode()
                        while isWhitespace(cp) || cp == CP.lf { cp = nextCode() }
                        continue
                    }
                }
                throw error(.invalidCharInEscapeSequence)
            }
            out.append(cp)
            cp = nextCode()
        }
        throw error(.unterminatedString)
    }

    mutating func literalStringState(_ cpIn: Int32) throws -> TokenizerState {
        var cp = cpIn
        if cp == CP.singleQuote {
            cp = nextCode()
            if cp == CP.singleQuote { return .multiLineLiteralString }
            endToken(.literalString, atEnd: false, string: "")
            return back(.data)
        }
        var out: [Int32] = []
        while cp != CP.singleQuote && cp != CP.eof && cp != CP.lf {
            if isControlOtherThanTab(cp) { throw error(.invalidControlCharacter) }
            out.append(cp)
            cp = nextCode()
        }
        if cp != CP.singleQuote { throw error(.unterminatedString) }
        endToken(.literalString, atEnd: true, string: Self.string(out))
        return .data
    }

    mutating func multiLineLiteralStringState(_ cpIn: Int32) throws -> TokenizerState {
        var cp = cpIn
        var out: [Int32] = []
        if cp == CP.lf { cp = nextCode() }
        while cp != CP.eof {
            if cp != CP.lf && isControlOtherThanTab(cp) { throw error(.invalidControlCharacter) }
            if cp == CP.singleQuote {
                let startPos = iterator.start
                if eatCode(CP.singleQuote) && eatCode(CP.singleQuote) {
                    if eatCode(CP.singleQuote) {
                        out.append(CP.singleQuote)
                        if eatCode(CP.singleQuote) {
                            out.append(CP.singleQuote)
                            if eatCode(CP.singleQuote) {
                                moveAt(startPos)
                                throw error(.invalidThreeQuotes)
                            }
                        }
                    }
                    endToken(.multiLineLiteralString, atEnd: true, string: Self.string(out))
                    return .data
                }
                moveAt(startPos)
            }
            out.append(cp)
            cp = nextCode()
        }
        throw error(.unterminatedString)
    }

    mutating func signState(_ cp: Int32) throws -> TokenizerState {
        if cp == CP.n || cp == CP.i { return back(.nanOrInf) }
        if isDigit(cp) { return back(.number) }
        throw error(.unexpectedChar)
    }

    mutating func nanOrInfState(_ cp: Int32) throws -> TokenizerState {
        if cp == CP.n {
            let startPos = iterator.start
            if eatCode(CP.a) && eatCode(CP.n) {
                endToken(.float, atEnd: true, number: .nan)
                return .data
            }
            moveAt(startPos)
        } else if cp == CP.i {
            let startPos = iterator.start
            if eatCode(CP.n) && eatCode(CP.f) {
                let negative = tokenStart < text.count && text[tokenStart] == UInt16(CP.dash)
                endToken(.float, atEnd: true, number: negative ? -.infinity : .infinity)
                return .data
            }
            moveAt(startPos)
        }
        throw error(.unexpectedChar)
    }

    var signAtTokenStart: Int32 {
        guard tokenStart >= 0, tokenStart < text.count else { return CP.null }
        let unit = Int32(text[tokenStart])
        return unit == CP.plus ? CP.plus : unit == CP.dash ? CP.dash : CP.null
    }

    mutating func numberState(_ cpIn: Int32) throws -> TokenizerState {
        var cp = cpIn
        let sign = signAtTokenStart
        if cp == CP.d0 {
            if sign == CP.null {
                let startPos = iterator.start
                let nextCp1 = nextCode()
                if isDigit(nextCp1) {
                    let nextNextCp = nextCode()
                    if nextNextCp == CP.colon {
                        dateData = DateTimeData()
                        dateData.hour = Int(nextCp1 - CP.d0)
                        return .timeMinute
                    }
                    if isDigit(nextNextCp) {
                        let nextNextNextCp = nextCode()
                        if isDigit(nextNextNextCp) && eatCode(CP.dash) {
                            dateData = DateTimeData()
                            dateData.hasDate = true
                            dateData.year = Int(nextCp1 - CP.d0) * 100 + Int(nextNextCp - CP.d0) * 10 + Int(nextNextNextCp - CP.d0)
                            return .dateMonth
                        }
                    }
                    moveAt(startPos)
                    throw error(.invalidLeadingZero)
                }
                moveAt(startPos)
            }
            cp = nextCode()
            if cp == CP.x || cp == CP.o || cp == CP.b {
                if sign != CP.null { throw error(.unexpectedChar) }
                return cp == CP.x ? .hex : cp == CP.o ? .octal : .binary
            }
            if cp == CP.e || cp == CP.E {
                numberData = NumberData(minus: sign == CP.dash, digits: [CP.d0])
                return .exponentRight
            }
            if cp == CP.dot {
                numberData = NumberData(minus: sign == CP.dash, digits: [CP.d0])
                return .fractionalRight
            }
            endToken(.integer, atEnd: false, number: 0)
            return back(.data)
        }
        let (out, nextCp, hasUnderscore) = try parseDigits(cp, isDigit)
        if nextCp == CP.dash && sign == CP.null && !hasUnderscore && out.count == 4 {
            dateData = DateTimeData()
            dateData.hasDate = true
            dateData.year = Int(Self.ascii(out)) ?? 0
            return .dateMonth
        }
        if nextCp == CP.colon && sign == CP.null && !hasUnderscore && out.count == 2 {
            dateData = DateTimeData()
            dateData.hour = Int(Self.ascii(out)) ?? 0
            return .timeMinute
        }
        if nextCp == CP.e || nextCp == CP.E {
            numberData = NumberData(minus: sign == CP.dash, digits: out)
            return .exponentRight
        }
        if nextCp == CP.dot {
            numberData = NumberData(minus: sign == CP.dash, digits: out)
            return .fractionalRight
        }
        let digits = Self.ascii(out)
        let value = Double(digits) ?? 0 // parseInt(text, 10): decimal, correctly rounded
        endToken(.integer, atEnd: false, number: sign == CP.dash ? -value : value)
        return back(.data)
    }

    static func ascii(_ codePoints: [Int32]) -> String {
        String(decoding: codePoints.map { UInt8(truncatingIfNeeded: $0) }, as: UTF8.self)
    }

    mutating func radixState(_ cp: Int32, _ check: (Int32) -> Bool, _ radix: Int) throws -> TokenizerState {
        let (out, _, _) = try parseDigits(cp, check)
        endToken(.integer, atEnd: false, number: Self.parseRadix(out, radix))
        return back(.data)
    }

    /// `parseInt(digits, radix)` for 2, 8 and 16: exact while it fits, and
    /// rounded to the nearest double past that.
    static func parseRadix(_ digits: [Int32], _ radix: Int) -> Double {
        var exact: UInt64 = 0
        var overflow = false
        for cp in digits {
            let digit = UInt64(hexValue(cp))
            let (shifted, o1) = exact.multipliedReportingOverflow(by: UInt64(radix))
            let (added, o2) = shifted.addingReportingOverflow(digit)
            if o1 || o2 { overflow = true; break }
            exact = added
        }
        if !overflow { return Double(exact) }
        var value: Double = 0
        for cp in digits { value = value * Double(radix) + Double(hexValue(cp)) }
        return value
    }

    static func hexValue(_ cp: Int32) -> Int {
        if cp >= CP.d0 && cp <= CP.d9 { return Int(cp - CP.d0) }
        if cp >= CP.a && cp <= CP.f { return Int(cp - CP.a) + 10 }
        if cp >= CP.A && cp <= CP.F { return Int(cp - CP.A) + 10 }
        return 0
    }

    mutating func fractionalRightState(_ cp: Int32) throws -> TokenizerState {
        let minus = numberData.minus
        let absInt = numberData.digits
        let (out, nextCp, _) = try parseDigits(cp, isDigit)
        let absNum = absInt + [CP.dot] + out
        if nextCp == CP.e || nextCp == CP.E {
            numberData = NumberData(minus: minus, digits: absNum)
            return .exponentRight
        }
        let value = Double((minus ? "-" : "") + Self.ascii(absNum)) ?? .nan
        endToken(.float, atEnd: false, number: value)
        return back(.data)
    }

    mutating func exponentRightState(_ cpIn: Int32) throws -> TokenizerState {
        var cp = cpIn
        let left = numberData.digits
        let leftMinus = numberData.minus
        var minus = false
        if cp == CP.dash || cp == CP.plus {
            minus = cp == CP.dash
            cp = nextCode()
        }
        let (out, _, _) = try parseDigits(cp, isDigit)
        let text = (leftMinus ? "-" : "") + Self.ascii(left) + "e" + (minus ? "-" : "") + Self.ascii(out)
        endToken(.float, atEnd: false, number: Double(text) ?? .nan)
        return back(.data)
    }

    mutating func booleanState(_ cp: Int32) throws -> TokenizerState {
        if cp == CP.t {
            let startPos = iterator.start
            if eatCode(CP.r) && eatCode(CP.u) && eatCode(CP.e) {
                endToken(.boolean, atEnd: true, boolean: true)
                return .data
            }
            moveAt(startPos)
        } else if cp == CP.f {
            let startPos = iterator.start
            if eatCode(CP.a) && eatCode(CP.l) && eatCode(CP.s) && eatCode(CP.e) {
                endToken(.boolean, atEnd: true, boolean: false)
                return .data
            }
            moveAt(startPos)
        }
        throw error(.unexpectedChar)
    }

    mutating func twoDigits(_ cpIn: Int32) throws -> (Int, Int32) {
        var cp = cpIn
        if !isDigit(cp) { throw error(.unexpectedChar) }
        let first = Int(cp - CP.d0)
        cp = nextCode()
        if !isDigit(cp) { throw error(.unexpectedChar) }
        return (first * 10 + Int(cp - CP.d0), cp)
    }

    mutating func dateMonthState(_ cp: Int32) throws -> TokenizerState {
        let (month, _) = try twoDigits(cp)
        let next = nextCode()
        if next != CP.dash { throw error(.unexpectedChar) }
        dateData.month = month
        return .dateDay
    }

    mutating func dateDayState(_ cpIn: Int32) throws -> TokenizerState {
        let (day, _) = try twoDigits(cpIn)
        dateData.day = day
        if !isValidDate(dateData.year, dateData.month, dateData.day) { throw error(.invalidDate) }
        let cp = nextCode()
        if cp == CP.T || cp == CP.t { return .timeHour }
        if cp == CP.space {
            let startPos = iterator.start
            if isDigit(nextCode()) && isDigit(nextCode()) {
                moveAt(startPos)
                return .timeHour
            }
            moveAt(startPos)
        }
        endToken(.localDate, atEnd: false, date: TomlDateTime(kind: .localDate, text: slice(tokenStart, iterator.start)))
        return back(.data)
    }

    mutating func timeHourState(_ cp: Int32) throws -> TokenizerState {
        let (hour, _) = try twoDigits(cp)
        let next = nextCode()
        if next != CP.colon { throw error(.unexpectedChar) }
        dateData.hour = hour
        return .timeMinute
    }

    mutating func timeMinuteState(_ cp: Int32) throws -> TokenizerState {
        let (minute, _) = try twoDigits(cp)
        dateData.minute = minute
        let next = nextCode()
        if next == CP.colon { return .timeSecond }
        if !isValidTime(dateData.hour, dateData.minute, dateData.second) { throw error(.invalidTime) }
        return processTimeEnd(next)
    }

    mutating func timeSecondState(_ cp: Int32) throws -> TokenizerState {
        let (second, _) = try twoDigits(cp)
        dateData.second = second
        if !isValidTime(dateData.hour, dateData.minute, dateData.second) { throw error(.invalidTime) }
        let next = nextCode()
        if next == CP.dot { return .timeSecFrac }
        return processTimeEnd(next)
    }

    mutating func timeSecFracState(_ cpIn: Int32) throws -> TokenizerState {
        var cp = cpIn
        if !isDigit(cp) { throw error(.unexpectedChar) }
        let start = iterator.start
        while isDigit(cp) { cp = nextCode() }
        dateData.frac = slice(start, iterator.start)
        return processTimeEnd(cp)
    }

    mutating func processTimeEnd(_ cp: Int32) -> TokenizerState {
        if dateData.hasDate {
            if cp == CP.dash || cp == CP.plus {
                dateData.offsetSign = cp
                return .timeOffset
            }
            if cp == CP.Z || cp == CP.z {
                endToken(.offsetDateTime, atEnd: true, date: TomlDateTime(kind: .offsetDateTime, text: slice(tokenStart, iterator.end)))
                return .data
            }
            endToken(.localDateTime, atEnd: false, date: TomlDateTime(kind: .localDateTime, text: slice(tokenStart, iterator.start)))
            return back(.data)
        }
        endToken(.localTime, atEnd: false, date: TomlDateTime(kind: .localTime, text: slice(tokenStart, iterator.start)))
        return back(.data)
    }

    mutating func timeOffsetState(_ cpIn: Int32) throws -> TokenizerState {
        var cp = cpIn
        if !isDigit(cp) { throw error(.unexpectedChar) }
        let h1 = Int(cp - CP.d0)
        cp = nextCode()
        if !isDigit(cp) { throw error(.unexpectedChar) }
        let hour = h1 * 10 + Int(cp - CP.d0)
        cp = nextCode()
        if cp != CP.colon { throw error(.unexpectedChar) }
        cp = nextCode()
        if !isDigit(cp) { throw error(.unexpectedChar) }
        let m1 = Int(cp - CP.d0)
        cp = nextCode()
        if !isDigit(cp) { throw error(.unexpectedChar) }
        let minute = m1 * 10 + Int(cp - CP.d0)
        if !isValidTime(hour, minute, 0) { throw error(.invalidTime) }
        endToken(.offsetDateTime, atEnd: true, date: TomlDateTime(kind: .offsetDateTime, text: slice(tokenStart, iterator.end)))
        return .data
    }

    mutating func parseDigits(_ cpIn: Int32, _ check: (Int32) -> Bool) throws -> ([Int32], Int32, Bool) {
        var cp = cpIn
        if cp == CP.underscore { throw error(.invalidUnderscore) }
        if !check(cp) { throw error(.unexpectedChar) }
        var out: [Int32] = []
        var before = CP.null
        var hasUnderscore = false
        while check(cp) || cp == CP.underscore {
            if cp == CP.underscore {
                hasUnderscore = true
                if before == CP.underscore { throw error(.invalidUnderscore) }
            } else {
                out.append(cp)
            }
            before = cp
            cp = nextCode()
        }
        if before == CP.underscore { throw error(.invalidUnderscore) }
        return (out, cp, hasUnderscore)
    }

    mutating func parseUnicode(_ count: Int) throws -> Int32 {
        let startLoc = iterator.start
        let start = iterator.end
        var charCount = 0
        while true {
            let cp = nextCode()
            if cp == CP.eof { break }
            if !isHexDig(cp) {
                moveAt(startLoc)
                throw error(.invalidCharInEscapeSequence)
            }
            charCount += 1
            if charCount >= count { break }
        }
        let end = iterator.end
        let code = slice(start, end)
        let codePoint = Int(code, radix: 16) ?? -1
        if !isUnicodeScalarValue(codePoint) { throw error(.invalidCodePoint, data: code) }
        return Int32(codePoint)
    }
}

// MARK: - Keys resolver

private final class KeyStore {
    enum TableKind { case standard, array }
    enum ValueKind { case value, intermediate }
    var table: TableKind?
    var value: ValueKind?
    var nodeRange: (Int, Int)
    var nodeLoc: TomlLoc
    var peekIndex = 0

    init(table: TableKind? = nil, value: ValueKind? = nil, range: (Int, Int), loc: TomlLoc) {
        self.table = table
        self.value = value
        self.nodeRange = range
        self.nodeLoc = loc
    }
}

// MARK: - Parser

private enum ParserState { case table, value }

private struct ValueContainer {
    let set: (TomlValueNode, inout ParserContext) throws -> [ParserState]
}

private struct ParserContext {
    var tokenizer: Tokenizer
    var back: Token?
    var stateStack: [ParserState] = []
    var needNewLine = false
    var needSameLine: ErrorCode?
    var currToken: Token?
    var prevToken: Token?
    var valueContainerStack: [ValueContainer] = []
    var program: TomlProgram
    /// The table key-values are added to: nil for the top level.
    var table: TomlTableNode?
    init(text: [UInt16], program: TomlProgram) {
        tokenizer = Tokenizer(text)
        self.program = program
    }

    mutating func nextToken(valuesEnabled: Bool = false, needSameLine optionSameLine: ErrorCode? = nil) throws -> Token? {
        prevToken = currToken
        if let back {
            currToken = back
            self.back = nil
        } else {
            currToken = try nextTokenFromTokenizer(valuesEnabled: valuesEnabled)
        }
        if needNewLine || needSameLine != nil || optionSameLine != nil, let prev = prevToken, let curr = currToken {
            if prev.loc.end.line == curr.loc.start.line {
                if needNewLine { throw error(.missingNewline, curr) }
            } else if let code = needSameLine ?? optionSameLine {
                throw error(code, curr)
            }
        }
        needNewLine = false
        needSameLine = nil
        return currToken
    }

    mutating func nextTokenFromTokenizer(valuesEnabled: Bool) throws -> Token? {
        let saved = tokenizer.valuesEnabled
        if valuesEnabled { tokenizer.valuesEnabled = true }
        var token = try tokenizer.nextToken()
        while let current = token, current.type == .block {
            token = try tokenizer.nextToken()
        }
        tokenizer.valuesEnabled = saved
        return token
    }

    mutating func backToken() {
        back = currToken
        currToken = prevToken
    }

    mutating func addValueContainer(_ container: ValueContainer) {
        valueContainerStack.append(container)
        tokenizer.valuesEnabled = true
    }

    mutating func consumeValueContainer() -> ValueContainer {
        let container = valueContainerStack.removeLast()
        tokenizer.valuesEnabled = !valueContainerStack.isEmpty
        return container
    }

    func error(_ code: ErrorCode, _ token: Token?) -> TomlSyntaxError {
        if let token {
            return TomlSyntaxError(code.message, offset: token.range.0, line: token.loc.start.line, column: token.loc.start.column)
        }
        let offset = tokenizer.start
        let pos = tokenizer.loc(offset)
        return TomlSyntaxError(code.message, offset: offset, line: pos.line, column: pos.column)
    }

    func error(_ code: ErrorCode, range: (Int, Int), loc: TomlLoc) -> TomlSyntaxError {
        TomlSyntaxError(code.message, offset: range.0, line: loc.start.line, column: loc.start.column)
    }
}

/// A reference to a key map, so the resolver can hand out the map a table's
/// pairs are checked against.
private final class KeyStoreBox {
    var keys: [AnyHashable: KeyStore]
    init(_ keys: [AnyHashable: KeyStore] = [:]) { self.keys = keys }
}

/// The parser: tokens to `TomlProgram`, with the duplicate-key rules applied.
enum TomlParser {
    static func parse(_ source: String) throws -> TomlProgram {
        try parse(utf16: Array(source.utf16))
    }

    static func parse(utf16 text: [UInt16]) throws -> TomlProgram {
        let program = TomlProgram()
        var ctx = ParserContext(text: text, program: program)
        let resolver = KeysResolver()
        var token = try ctx.nextToken()
        if token != nil {
            while let current = token {
                let state = ctx.stateStack.popLast() ?? .table
                let next = try step(state, current, &ctx, resolver)
                ctx.stateStack.append(contentsOf: next)
                token = try ctx.nextToken()
            }
            let state = ctx.stateStack.popLast() ?? .table
            if state == .value { throw ctx.error(.missingValue, nil) }
            if let table = ctx.table, let last = table.body.last { applyEndLoc(table, last.range, last.loc) }
        }
        try resolver.verifyDuplicateKeys(program, &ctx)
        return program
    }

    private static func step(_ state: ParserState, _ token: Token, _ ctx: inout ParserContext, _ resolver: KeysResolver) throws -> [ParserState] {
        switch state {
        case .table:
            if token.type == .bare || isString(token) { return try processKeyValue(token, &ctx) }
            if isPunct(token, "[") { return try processTable(token, &ctx, resolver) }
            throw ctx.error(.unexpectedToken, token)
        case .value:
            if isString(token) || isMultiLineString(token) { return try processStringValue(token, &ctx) }
            if token.type == .integer || token.type == .float {
                return try setValue(TomlValueNode(kind: .number(token.number), range: token.range, loc: token.loc), &ctx)
            }
            if token.type == .boolean {
                return try setValue(TomlValueNode(kind: .bool(token.boolean), range: token.range, loc: token.loc), &ctx)
            }
            if let date = token.date {
                return try setValue(TomlValueNode(kind: .datetime(date), range: token.range, loc: token.loc), &ctx)
            }
            if isPunct(token, "[") { return try processArray(token, &ctx) }
            if isPunct(token, "{") { return try processInlineTable(token, &ctx) }
            throw ctx.error(.unexpectedToken, token)
        }
    }

    private static func isPunct(_ token: Token?, _ value: String) -> Bool {
        guard let token else { return false }
        return token.type == .punctuator && token.value == value
    }

    private static func isString(_ token: Token) -> Bool {
        token.type == .basicString || token.type == .literalString
    }

    private static func isMultiLineString(_ token: Token) -> Bool {
        token.type == .multiLineBasicString || token.type == .multiLineLiteralString
    }

    private static func applyEndLoc(_ table: TomlTableNode, _ range: (Int, Int), _ loc: TomlLoc) {
        table.range.1 = range.1
        table.loc.end = loc.end
    }

    private static func processTable(_ token: Token, _ ctx: inout ParserContext, _ resolver: KeysResolver) throws -> [ParserState] {
        let tableNode = TomlTableNode(range: token.range, loc: token.loc)
        if let table = ctx.table, let last = table.body.last { applyEndLoc(table, last.range, last.loc) }
        ctx.program.body.append(.table(tableNode))
        ctx.table = tableNode
        var target = try ctx.nextToken(needSameLine: .invalidKeyValueNewline)
        if isPunct(target, "[") {
            if token.range.1 < target!.range.0 { throw ctx.error(.invalidSpace, target) }
            tableNode.kind = .array
            target = try ctx.nextToken(needSameLine: .invalidKeyValueNewline)
        }
        if isPunct(target, "]") { throw ctx.error(.missingKey, target) }
        guard let keyStart = target else { throw ctx.error(.unterminatedTableKey, nil) }
        let (keyNode, after) = try processKeyNode(keyStart, &ctx)
        tableNode.key = keyNode
        target = after
        if !isPunct(target, "]") { throw ctx.error(.unterminatedTableKey, target) }
        if tableNode.kind == .array {
            let rightBracket = target!
            target = try ctx.nextToken(needSameLine: .invalidKeyValueNewline)
            if !isPunct(target, "]") { throw ctx.error(.unterminatedTableKey, target) }
            if rightBracket.range.1 < target!.range.0 { throw ctx.error(.invalidSpace, target) }
        }
        applyEndLoc(tableNode, target!.range, target!.loc)
        try resolver.applyResolveKeyForTable(tableNode, &ctx)
        ctx.needNewLine = true
        return []
    }

    private static func processKeyValue(_ token: Token, _ ctx: inout ParserContext) throws -> [ParserState] {
        let keyValue = TomlKeyValueNode(range: token.range, loc: token.loc)
        if let table = ctx.table {
            table.body.append(keyValue)
        } else {
            ctx.program.body.append(.keyValue(keyValue))
        }
        let (keyNode, target) = try processKeyNode(token, &ctx)
        keyValue.key = keyNode
        if !isPunct(target, "=") { throw ctx.error(.missingEqualsSign, target) }
        ctx.addValueContainer(ValueContainer { value, ctx in
            keyValue.value = value
            keyValue.range.1 = value.range.1
            keyValue.loc.end = value.loc.end
            ctx.needNewLine = true
            return []
        })
        ctx.needSameLine = .invalidKeyValueNewline
        return [.value]
    }

    private static func processKeyNode(_ token: Token, _ ctx: inout ParserContext) throws -> (TomlKeyNode, Token?) {
        if isPunct(token, ".") { throw ctx.error(.invalidLeadingDotInKey, token) }
        let keyNode = TomlKeyNode(range: token.range, loc: token.loc)
        var target: Token? = token
        var dotToken: Token?
        repeat {
            guard let current = target else { break }
            if current.type == .bare {
                keyNode.parts.append(TomlKeyPart(kind: .bare, name: current.value, range: current.range, loc: current.loc))
            } else if isString(current) {
                keyNode.parts.append(TomlKeyPart(kind: .quoted, name: current.string, range: current.range, loc: current.loc))
            } else {
                break
            }
            dotToken = nil
            target = try ctx.nextToken(needSameLine: .invalidKeyValueNewline)
            if !isPunct(target, ".") { break }
            dotToken = target
            target = try ctx.nextToken(needSameLine: .invalidKeyValueNewline)
        } while target != nil
        if let dotToken {
            throw ctx.error(isPunct(target, ".") ? .invalidConsecutiveDotsInKey : .invalidTrailingDotInKey, dotToken)
        }
        if let last = keyNode.parts.last {
            keyNode.range.1 = last.range.1
            keyNode.loc.end = last.loc.end
        }
        return (keyNode, target)
    }

    private static func setValue(_ node: TomlValueNode, _ ctx: inout ParserContext) throws -> [ParserState] {
        let container = ctx.consumeValueContainer()
        return try container.set(node, &ctx)
    }

    private static func processStringValue(_ token: Token, _ ctx: inout ParserContext) throws -> [ParserState] {
        try setValue(TomlValueNode(kind: .string(token.string), range: token.range, loc: token.loc), &ctx)
    }

    private static func processArray(_ token: Token, _ ctx: inout ParserContext) throws -> [ParserState] {
        let container = ctx.consumeValueContainer()
        let node = TomlValueNode(kind: .array([]), range: token.range, loc: token.loc)
        let next = try ctx.nextToken(valuesEnabled: true)
        if isPunct(next, "]") {
            node.range.1 = next!.range.1
            node.loc.end = next!.loc.end
            return try container.set(node, &ctx)
        }
        ctx.backToken()
        return processArrayValue(node, container, &ctx)
    }

    private static func processArrayValue(_ node: TomlValueNode, _ outer: ValueContainer, _ ctx: inout ParserContext) -> [ParserState] {
        ctx.addValueContainer(ValueContainer { value, ctx in
            if case .array(var elements) = node.kind {
                elements.append(value)
                node.kind = .array(elements)
            }
            var next = try ctx.nextToken(valuesEnabled: true)
            let hasComma = isPunct(next, ",")
            if hasComma { next = try ctx.nextToken(valuesEnabled: true) }
            if isPunct(next, "]") {
                node.range.1 = next!.range.1
                node.loc.end = next!.loc.end
                return try outer.set(node, &ctx)
            }
            if hasComma {
                ctx.backToken()
                return processArrayValue(node, outer, &ctx)
            }
            throw ctx.error(next != nil ? .missingComma : .unterminatedArray, next)
        })
        return [.value]
    }

    private static func processInlineTable(_ token: Token, _ ctx: inout ParserContext) throws -> [ParserState] {
        let container = ctx.consumeValueContainer()
        let node = TomlValueNode(kind: .inlineTable([]), range: token.range, loc: token.loc)
        let next = try ctx.nextToken()
        if let next {
            if next.type == .bare || isString(next) { return try processInlineTableKeyValue(next, node, container, &ctx) }
            if isPunct(next, "}") {
                node.range.1 = next.range.1
                node.loc.end = next.loc.end
                return try container.set(node, &ctx)
            }
        }
        throw ctx.error(.unexpectedToken, next)
    }

    private static func processInlineTableKeyValue(
        _ token: Token,
        _ inlineTable: TomlValueNode,
        _ outer: ValueContainer,
        _ ctx: inout ParserContext
    ) throws -> [ParserState] {
        let keyValue = TomlKeyValueNode(range: token.range, loc: token.loc)
        if case .inlineTable(var body) = inlineTable.kind {
            body.append(keyValue)
            inlineTable.kind = .inlineTable(body)
        }
        let (keyNode, target) = try processKeyNode(token, &ctx)
        keyValue.key = keyNode
        if !isPunct(target, "=") { throw ctx.error(.missingEqualsSign, target) }
        ctx.addValueContainer(ValueContainer { value, ctx in
            keyValue.value = value
            keyValue.range.1 = value.range.1
            keyValue.loc.end = value.loc.end
            var next = try ctx.nextToken()
            if isPunct(next, ",") {
                next = try ctx.nextToken()
                if let candidate = next, candidate.type == .bare || isString(candidate) {
                    return try processInlineTableKeyValue(candidate, inlineTable, outer, &ctx)
                }
                if !isPunct(next, "}") {
                    throw ctx.error(next != nil ? .unexpectedToken : .unterminatedInlineTable, next)
                }
            }
            if isPunct(next, "}") {
                inlineTable.range.1 = next!.range.1
                inlineTable.loc.end = next!.loc.end
                return try outer.set(inlineTable, &ctx)
            }
            throw ctx.error(next != nil ? .missingComma : .unterminatedInlineTable, next)
        })
        ctx.needSameLine = .invalidKeyValueNewline
        return [.value]
    }
}

/// `KeysResolver`: table headings resolved as they are read, and every pair
/// checked against what is already defined once the whole document is read.
private final class KeysResolver {
    let root = KeyStoreBox()
    var tables: [(node: TomlTableNode, keys: KeyStoreBox)] = []
    /// The boxes of key maps, by store identity, so a table's map can be shared.
    var boxes: [ObjectIdentifier: KeyStoreBox] = [:]

    func box(for store: KeyStore) -> KeyStoreBox {
        if let box = boxes[ObjectIdentifier(store)] { return box }
        let box = KeyStoreBox()
        boxes[ObjectIdentifier(store)] = box
        return box
    }

    func applyResolveKeyForTable(_ node: TomlTableNode, _ ctx: inout ParserContext) throws {
        var keys = root
        let parts = node.key.parts
        let peekKeyIndex = parts.count - 1
        for index in 0..<peekKeyIndex {
            let keyPart = parts[index]
            let name = keyPart.name
            node.resolvedKey.append(.key(name))
            var store: KeyStore
            if let existing = keys.keys[name] {
                store = existing
                if existing.table == .array {
                    let peek = existing.peekIndex
                    node.resolvedKey.append(.index(peek))
                    store = box(for: existing).keys[peek]!
                }
            } else {
                store = KeyStore(range: keyPart.range, loc: keyPart.loc)
                keys.keys[name] = store
            }
            keys = box(for: store)
        }
        let lastPart = parts[peekKeyIndex]
        let lastName = lastPart.name
        node.resolvedKey.append(.key(lastName))
        if let lastStore = keys.keys[lastName] {
            if lastStore.table == nil {
                if node.kind == .array {
                    throw ctx.error(.dupeKeys, range: lastPart.range, loc: lastPart.loc)
                }
                let transformed = KeyStore(table: .standard, range: lastPart.range, loc: lastPart.loc)
                // The same key map: a table heading over keys a dotted key or a
                // sub-table already implied.
                boxes[ObjectIdentifier(transformed)] = box(for: lastStore)
                keys.keys[lastName] = transformed
                tables.append((node, box(for: transformed)))
            } else if lastStore.table == .array {
                if node.kind == .array {
                    let element = KeyStore(range: lastPart.range, loc: lastPart.loc)
                    let newIndex = lastStore.peekIndex + 1
                    node.resolvedKey.append(.index(newIndex))
                    box(for: lastStore).keys[newIndex] = element
                    lastStore.peekIndex = newIndex
                    tables.append((node, box(for: element)))
                } else {
                    throw ctx.error(.dupeKeys, range: lastPart.range, loc: lastPart.loc)
                }
            } else {
                throw ctx.error(.dupeKeys, range: lastPart.range, loc: lastPart.loc)
            }
        } else if node.kind == .array {
            node.resolvedKey.append(.index(0))
            let element = KeyStore(range: lastPart.range, loc: lastPart.loc)
            let arrayStore = KeyStore(table: .array, range: lastPart.range, loc: lastPart.loc)
            arrayStore.peekIndex = 0
            box(for: arrayStore).keys[0] = element
            keys.keys[lastName] = arrayStore
            tables.append((node, box(for: element)))
        } else {
            let store = KeyStore(table: .standard, range: lastPart.range, loc: lastPart.loc)
            keys.keys[lastName] = store
            tables.append((node, box(for: store)))
        }
    }

    func verifyDuplicateKeys(_ program: TomlProgram, _ ctx: inout ParserContext) throws {
        for entry in program.body {
            if case .keyValue(let pair) = entry { try verify(pair, in: root, &ctx) }
        }
        for (node, keys) in tables {
            for pair in node.body { try verify(pair, in: keys, &ctx) }
        }
    }

    /// `getAfterNode`: whichever of the two starts later.
    private func after(_ aRange: (Int, Int), _ aLoc: TomlLoc, _ store: KeyStore) -> (range: (Int, Int), loc: TomlLoc) {
        aRange.0 <= store.nodeRange.0 ? (store.nodeRange, store.nodeLoc) : (aRange, aLoc)
    }

    private func verify(_ pair: TomlKeyValueNode, in defineKeys: KeyStoreBox, _ ctx: inout ParserContext) throws {
        var keys = defineKeys
        let parts = pair.key.parts
        for (index, part) in parts.enumerated() {
            let isLast = index == parts.count - 1
            let store: KeyStore
            if let existing = keys.keys[part.name] {
                if existing.value == .value || isLast || existing.table != nil {
                    let at = after(part.range, part.loc, existing)
                    throw ctx.error(.dupeKeys, range: at.range, loc: at.loc)
                }
                existing.value = .intermediate
                store = existing
            } else {
                store = KeyStore(value: isLast ? .value : .intermediate, range: part.range, loc: part.loc)
                keys.keys[part.name] = store
            }
            keys = box(for: store)
        }
        switch pair.value.kind {
        case .inlineTable(let body):
            for inner in body { try verify(inner, in: keys, &ctx) }
        case .array(let elements):
            try verifyArray(elements, in: keys, &ctx)
        default:
            break
        }
    }

    private func verifyArray(_ elements: [TomlValueNode], in keys: KeyStoreBox, _ ctx: inout ParserContext) throws {
        for (index, element) in elements.enumerated() {
            if let existing = keys.keys[index] {
                let at = after(element.range, element.loc, existing)
                throw ctx.error(.dupeKeys, range: at.range, loc: at.loc)
            }
            let store = KeyStore(value: .value, range: element.range, loc: element.loc)
            keys.keys[index] = store
            switch element.kind {
            case .inlineTable(let body):
                for inner in body { try verify(inner, in: box(for: store), &ctx) }
            case .array(let inner):
                try verifyArray(inner, in: box(for: store), &ctx)
            default:
                break
            }
        }
    }
}

// MARK: - The static value

/// `getStaticTOMLValue`, built over reference-typed tables the way the JS
/// builds over objects, then frozen into `TomlValue`.
private final class MutableTable {
    var keys: [String] = []
    var values: [String: MutableEntry] = [:]

    func get(_ key: String) -> MutableEntry? { values[key] }

    func set(_ key: String, _ entry: MutableEntry) {
        if values.updateValue(entry, forKey: key) == nil {
            if let index = JSPropertyOrder.arrayIndex(key) {
                var at = 0
                while at < keys.count, let other = JSPropertyOrder.arrayIndex(keys[at]), other < index { at += 1 }
                keys.insert(key, at: at)
            } else {
                keys.append(key)
            }
        }
    }
}

private final class MutableArray {
    var elements: [MutableEntry] = []
}

private enum MutableEntry {
    case value(TomlValue)
    case table(MutableTable)
    case array(MutableArray)

    var isValue: Bool {
        if case .value = self { return true }
        return false
    }

    func frozen() -> TomlValue {
        switch self {
        case .value(let value): return value
        case .table(let table):
            var out = TomlTable()
            for key in table.keys { out[key] = table.values[key]!.frozen() }
            return .table(out)
        case .array(let array): return .array(array.elements.map { $0.frozen() })
        }
    }
}

extension TomlProgram {
    /// What the document says, as values.
    func staticValue() -> TomlTable {
        let base = MutableTable()
        for entry in body {
            switch entry {
            case .keyValue(let pair):
                setPair(base, pair)
            case .table(let table):
                let target = getTable(base, table.key.names, array: table.kind == .array)
                for pair in table.body { setPair(target, pair) }
            }
        }
        guard case .table(let result) = MutableEntry.table(base).frozen() else { return TomlTable() }
        return result
    }

    private func entry(_ node: TomlValueNode) -> MutableEntry {
        switch node.kind {
        case .string(let value): return .value(.string(value))
        case .number(let value): return .value(.number(value))
        case .bool(let value): return .value(.bool(value))
        case .datetime(let value): return .value(.datetime(value))
        case .array(let elements):
            let array = MutableArray()
            array.elements = elements.map(entry)
            return .array(array)
        case .inlineTable(let body):
            let table = MutableTable()
            for pair in body { setPair(table, pair) }
            return .table(table)
        }
    }

    private func setPair(_ base: MutableTable, _ pair: TomlKeyValueNode) {
        let value = entry(pair.value)
        let keys = pair.key.names
        var target = base
        for key in keys.dropLast() {
            if let next = target.get(key), case .table(let table) = next {
                target = table
            } else {
                let table = MutableTable()
                target.set(key, .table(table))
                target = table
            }
        }
        target.set(keys.last!, value)
    }

    private func getTable(_ base: MutableTable, _ keys: [String], array: Bool) -> MutableTable {
        var target = base
        for key in keys.dropLast() { target = nextTarget(target, key) }
        let lastKey = keys.last!
        let fresh = MutableTable()
        guard let lastTarget = target.get(lastKey), !lastTarget.isValue else {
            if array {
                let list = MutableArray()
                list.elements = [.table(fresh)]
                target.set(lastKey, .array(list))
            } else {
                target.set(lastKey, .table(fresh))
            }
            return fresh
        }
        if !array {
            if case .table(let table) = lastTarget { return table }
            target.set(lastKey, .table(fresh))
            return fresh
        }
        if case .array(let list) = lastTarget {
            list.elements.append(.table(fresh))
            return fresh
        }
        let list = MutableArray()
        list.elements = [.table(fresh)]
        target.set(lastKey, .array(list))
        return fresh
    }

    private func nextTarget(_ current: MutableTable, _ key: String) -> MutableTable {
        guard let next = current.get(key), !next.isValue else {
            let table = MutableTable()
            current.set(key, .table(table))
            return table
        }
        var result = next
        while case .array(let list) = result {
            guard let lastElement = list.elements.last else {
                // An empty array has no element to descend into; the JS reads
                // `undefined` and fails later. Nothing DevHub writes reaches here.
                let table = MutableTable()
                list.elements.append(.table(table))
                return table
            }
            if lastElement.isValue {
                let table = MutableTable()
                list.elements[list.elements.count - 1] = .table(table)
                return table
            }
            result = lastElement
        }
        if case .table(let table) = result { return table }
        let table = MutableTable()
        current.set(key, .table(table))
        return table
    }
}

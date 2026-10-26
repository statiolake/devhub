// The JSON of DevHub's control socket, exactly as the TypeScript side spells it.
//
// The `devhub` command and the app talk one JSON object per line
// (`apps/desktop/src/main/cli/protocol.ts`), and both apps must answer both
// CLIs. Foundation's `JSONSerialization` would do for reading, but not for
// writing: it does not keep key order, and `devhub --tell --json` prints the
// answer the way `JSON.stringify(value, null, 2)` does — keys in the order the
// answer was built, numbers in JavaScript's shortest form. A script that
// diffs the output of one app against the other should see nothing.
//
// So this is a small JSON value of its own: objects keep their keys in
// order, numbers are doubles (what `JSON.parse` makes of them), and the
// writer follows ECMA-262's `JSON.stringify` and `Number.prototype.toString`.

import Foundation

/// A JSON value with ordered object keys.
public enum WireJSON: Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([WireJSON])
    case object([(key: String, value: WireJSON)])

    public static func == (lhs: WireJSON, rhs: WireJSON) -> Bool {
        switch (lhs, rhs) {
        case (.null, .null): return true
        case let (.bool(a), .bool(b)): return a == b
        case let (.number(a), .number(b)): return a == b
        case let (.string(a), .string(b)): return a == b
        case let (.array(a), .array(b)): return a == b
        case let (.object(a), .object(b)):
            guard a.count == b.count else { return false }
            for (left, right) in zip(a, b) where left.key != right.key || left.value != right.value {
                return false
            }
            return true
        default: return false
        }
    }

    /// `JSON.stringify`'s rule for object equality in tests is "same keys and
    /// values"; vitest's `toEqual` ignores key order. This does too.
    public func sameValue(as other: WireJSON) -> Bool {
        switch (self, other) {
        case let (.array(a), .array(b)):
            return a.count == b.count && zip(a, b).allSatisfy { $0.sameValue(as: $1) }
        case let (.object(a), .object(b)):
            guard a.count == b.count else { return false }
            for (key, value) in a {
                guard let found = b.first(where: { $0.key == key }), found.value.sameValue(as: value) else {
                    return false
                }
            }
            return true
        default:
            return self == other
        }
    }
}

// MARK: - Building

extension WireJSON {
    public static func int(_ value: Int) -> WireJSON { .number(Double(value)) }

    /// An object from ordered pairs whose `nil` values are left out, the way
    /// `JSON.stringify` leaves out a property that is `undefined`.
    public static func object(dropping pairs: [(String, WireJSON?)]) -> WireJSON {
        .object(pairs.compactMap { pair in pair.1.map { (key: pair.0, value: $0) } })
    }

    public static func optional(_ value: String?) -> WireJSON? { value.map(WireJSON.string) }
    public static func optional(_ value: Int?) -> WireJSON? { value.map { .number(Double($0)) } }
    public static func optional(_ value: Bool?) -> WireJSON? { value.map(WireJSON.bool) }
    public static func strings(_ values: [String]) -> WireJSON { .array(values.map(WireJSON.string)) }
}

extension WireJSON: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral,
    ExpressibleByFloatLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral, ExpressibleByNilLiteral
{
    public init(stringLiteral value: String) { self = .string(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(floatLiteral value: Double) { self = .number(value) }
    public init(arrayLiteral elements: WireJSON...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, WireJSON)...) {
        self = .object(elements.map { (key: $0.0, value: $0.1) })
    }
    public init(nilLiteral: ()) { self = .null }
}

// MARK: - Reading

extension WireJSON {
    /// The value at `key` of an object; `nil` when absent (JavaScript's
    /// `undefined`) or when this is not an object.
    public subscript(key: String) -> WireJSON? {
        guard case let .object(pairs) = self else { return nil }
        return pairs.last(where: { $0.key == key })?.value
    }

    public var stringValue: String? {
        if case let .string(value) = self { return value }
        return nil
    }

    public var numberValue: Double? {
        if case let .number(value) = self { return value }
        return nil
    }

    public var boolValue: Bool? {
        if case let .bool(value) = self { return value }
        return nil
    }

    public var arrayValue: [WireJSON]? {
        if case let .array(value) = self { return value }
        return nil
    }

    public var objectValue: [(key: String, value: WireJSON)]? {
        if case let .object(value) = self { return value }
        return nil
    }

    public var isObject: Bool {
        if case .object = self { return true }
        return false
    }

    /// A whole number, the way `Number.isInteger` sees one.
    public var integerValue: Int? {
        guard case let .number(value) = self, value.isFinite, value.rounded(.towardZero) == value,
            abs(value) < 9.007_199_254_740_992e15
        else { return nil }
        return Int(value)
    }

    /// The object with `key` set: replaced in place when it is there (as a
    /// JavaScript spread over an existing key keeps its position), appended
    /// when it is not.
    public func setting(_ key: String, _ value: WireJSON) -> WireJSON {
        guard case var .object(pairs) = self else { return self }
        if let index = pairs.firstIndex(where: { $0.key == key }) {
            pairs[index].value = value
        } else {
            pairs.append((key: key, value: value))
        }
        return .object(pairs)
    }
}

// MARK: - Parsing

/// What `JSON.parse` refused, in words.
public struct WireJSONError: Error, Equatable, CustomStringConvertible, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

extension WireJSON {
    /// `JSON.parse`: one value, surrounded by nothing but whitespace.
    public static func parse(_ text: String) throws -> WireJSON {
        try parse(Array(text.utf8))
    }

    public static func parse(_ bytes: [UInt8]) throws -> WireJSON {
        var parser = Parser(bytes: bytes)
        parser.skipWhitespace()
        let value = try parser.value(depth: 0)
        parser.skipWhitespace()
        guard parser.index == bytes.count else {
            throw WireJSONError("Unexpected non-whitespace character after JSON at position \(parser.index)")
        }
        return value
    }

    private struct Parser {
        let bytes: [UInt8]
        var index = 0

        mutating func skipWhitespace() {
            while index < bytes.count {
                switch bytes[index] {
                case 0x20, 0x09, 0x0A, 0x0D: index += 1
                default: return
                }
            }
        }

        func failure(_ what: String = "Unexpected token") -> WireJSONError {
            if index >= bytes.count { return WireJSONError("Unexpected end of JSON input") }
            return WireJSONError("\(what) in JSON at position \(index)")
        }

        mutating func expect(_ literal: String, _ value: WireJSON) throws -> WireJSON {
            let utf8 = Array(literal.utf8)
            guard index + utf8.count <= bytes.count, Array(bytes[index..<index + utf8.count]) == utf8 else {
                throw failure()
            }
            index += utf8.count
            return value
        }

        mutating func value(depth: Int) throws -> WireJSON {
            guard depth < 512 else { throw WireJSONError("JSON is nested too deeply") }
            guard index < bytes.count else { throw failure() }
            switch bytes[index] {
            case UInt8(ascii: "{"): return try object(depth: depth)
            case UInt8(ascii: "["): return try array(depth: depth)
            case UInt8(ascii: "\""): return .string(try string())
            case UInt8(ascii: "t"): return try expect("true", .bool(true))
            case UInt8(ascii: "f"): return try expect("false", .bool(false))
            case UInt8(ascii: "n"): return try expect("null", .null)
            case UInt8(ascii: "-"), UInt8(ascii: "0")...UInt8(ascii: "9"): return try number()
            default: throw failure()
            }
        }

        mutating func object(depth: Int) throws -> WireJSON {
            index += 1
            var pairs: [(key: String, value: WireJSON)] = []
            skipWhitespace()
            if index < bytes.count, bytes[index] == UInt8(ascii: "}") {
                index += 1
                return .object(pairs)
            }
            while true {
                skipWhitespace()
                guard index < bytes.count, bytes[index] == UInt8(ascii: "\"") else { throw failure() }
                let key = try string()
                skipWhitespace()
                guard index < bytes.count, bytes[index] == UInt8(ascii: ":") else { throw failure() }
                index += 1
                skipWhitespace()
                let item = try value(depth: depth + 1)
                // `JSON.parse` keeps the last value of a repeated key, at
                // the place the key was first seen.
                if let existing = pairs.firstIndex(where: { $0.key == key }) {
                    pairs[existing].value = item
                } else {
                    pairs.append((key: key, value: item))
                }
                skipWhitespace()
                guard index < bytes.count else { throw failure() }
                if bytes[index] == UInt8(ascii: ",") {
                    index += 1
                    continue
                }
                if bytes[index] == UInt8(ascii: "}") {
                    index += 1
                    return .object(pairs)
                }
                throw failure()
            }
        }

        mutating func array(depth: Int) throws -> WireJSON {
            index += 1
            var items: [WireJSON] = []
            skipWhitespace()
            if index < bytes.count, bytes[index] == UInt8(ascii: "]") {
                index += 1
                return .array(items)
            }
            while true {
                skipWhitespace()
                items.append(try value(depth: depth + 1))
                skipWhitespace()
                guard index < bytes.count else { throw failure() }
                if bytes[index] == UInt8(ascii: ",") {
                    index += 1
                    continue
                }
                if bytes[index] == UInt8(ascii: "]") {
                    index += 1
                    return .array(items)
                }
                throw failure()
            }
        }

        mutating func hex4() throws -> UInt16 {
            guard index + 4 <= bytes.count else { throw failure("Bad Unicode escape") }
            var value: UInt16 = 0
            for _ in 0..<4 {
                let byte = bytes[index]
                let digit: UInt16
                switch byte {
                case UInt8(ascii: "0")...UInt8(ascii: "9"): digit = UInt16(byte - UInt8(ascii: "0"))
                case UInt8(ascii: "a")...UInt8(ascii: "f"): digit = UInt16(byte - UInt8(ascii: "a") + 10)
                case UInt8(ascii: "A")...UInt8(ascii: "F"): digit = UInt16(byte - UInt8(ascii: "A") + 10)
                default: throw failure("Bad Unicode escape")
                }
                value = value * 16 + digit
                index += 1
            }
            return value
        }

        mutating func string() throws -> String {
            index += 1
            var units: [UInt16] = []
            var run: [UInt8] = []
            func flush() {
                if !run.isEmpty {
                    units.append(contentsOf: String(decoding: run, as: UTF8.self).utf16)
                    run.removeAll(keepingCapacity: true)
                }
            }
            while true {
                guard index < bytes.count else { throw WireJSONError("Unterminated string in JSON at position \(index)") }
                let byte = bytes[index]
                if byte == UInt8(ascii: "\"") {
                    index += 1
                    flush()
                    return String(decoding: units, as: UTF16.self)
                }
                if byte < 0x20 {
                    throw failure("Bad control character in string literal")
                }
                if byte != UInt8(ascii: "\\") {
                    run.append(byte)
                    index += 1
                    continue
                }
                flush()
                index += 1
                guard index < bytes.count else { throw failure("Bad escaped character") }
                let escape = bytes[index]
                index += 1
                switch escape {
                case UInt8(ascii: "\""): units.append(0x22)
                case UInt8(ascii: "\\"): units.append(0x5C)
                case UInt8(ascii: "/"): units.append(0x2F)
                case UInt8(ascii: "b"): units.append(0x08)
                case UInt8(ascii: "f"): units.append(0x0C)
                case UInt8(ascii: "n"): units.append(0x0A)
                case UInt8(ascii: "r"): units.append(0x0D)
                case UInt8(ascii: "t"): units.append(0x09)
                case UInt8(ascii: "u"): units.append(try hex4())
                default:
                    index -= 1
                    throw failure("Bad escaped character")
                }
            }
        }

        mutating func number() throws -> WireJSON {
            let start = index
            if bytes[index] == UInt8(ascii: "-") { index += 1 }
            func digits() -> Int {
                let from = index
                while index < bytes.count, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[index]) { index += 1 }
                return index - from
            }
            guard index < bytes.count else { throw failure("No number after minus sign") }
            if bytes[index] == UInt8(ascii: "0") {
                index += 1
            } else if digits() == 0 {
                throw failure("No number after minus sign")
            }
            if index < bytes.count, bytes[index] == UInt8(ascii: ".") {
                index += 1
                guard digits() > 0 else { throw failure("Unterminated fractional number") }
            }
            if index < bytes.count, bytes[index] == UInt8(ascii: "e") || bytes[index] == UInt8(ascii: "E") {
                index += 1
                if index < bytes.count, bytes[index] == UInt8(ascii: "+") || bytes[index] == UInt8(ascii: "-") {
                    index += 1
                }
                guard digits() > 0 else { throw failure("Exponent part is missing a number") }
            }
            let text = String(decoding: bytes[start..<index], as: UTF8.self)
            guard let value = Double(text) else { throw failure() }
            return .number(value)
        }
    }
}

// MARK: - Writing

extension WireJSON {
    /// `JSON.stringify(value)`.
    public var compact: String {
        var out = ""
        write(into: &out, indent: nil, level: 0)
        return out
    }

    /// `JSON.stringify(value, null, 2)`.
    public var pretty: String {
        var out = ""
        write(into: &out, indent: "  ", level: 0)
        return out
    }

    private func write(into out: inout String, indent: String?, level: Int) {
        switch self {
        case .null: out += "null"
        case let .bool(value): out += value ? "true" : "false"
        case let .number(value): out += value.isFinite ? JavaScriptNumber.string(value) : "null"
        case let .string(value): out += WireJSON.quoted(value)
        case let .array(items):
            if items.isEmpty {
                out += "[]"
                return
            }
            out += "["
            for (offset, item) in items.enumerated() {
                if offset > 0 { out += "," }
                if let indent {
                    out += "\n" + String(repeating: indent, count: level + 1)
                }
                item.write(into: &out, indent: indent, level: level + 1)
            }
            if let indent { out += "\n" + String(repeating: indent, count: level) }
            out += "]"
        case let .object(pairs):
            if pairs.isEmpty {
                out += "{}"
                return
            }
            out += "{"
            for (offset, pair) in pairs.enumerated() {
                if offset > 0 { out += "," }
                if let indent {
                    out += "\n" + String(repeating: indent, count: level + 1)
                }
                out += WireJSON.quoted(pair.key)
                out += indent == nil ? ":" : ": "
                pair.value.write(into: &out, indent: indent, level: level + 1)
            }
            if let indent { out += "\n" + String(repeating: indent, count: level) }
            out += "}"
        }
    }

    /// `JSON.stringify(text)`: the string in double quotes, escaped exactly as
    /// ECMA-262's `QuoteJSONString` does (and nothing more: non-ASCII stays).
    public static func quoted(_ text: String) -> String {
        var out = "\""
        out.reserveCapacity(text.utf8.count + 2)
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    let hex = String(scalar.value, radix: 16)
                    out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
        return out
    }
}

/// JavaScript's `Number.prototype.toString()` for finite doubles (radix 10).
public enum JavaScriptNumber {
    public static func string(_ value: Double) -> String {
        if value == 0 { return "0" }
        if value < 0 { return "-" + string(-value) }
        // Swift's description is the shortest round-tripping digit string,
        // which is what ECMA-262 asks for; only its layout differs.
        let (digits, exponent) = decompose(value)
        let k = digits.count
        let n = exponent
        if k <= n && n <= 21 {
            return digits + String(repeating: "0", count: n - k)
        }
        if 0 < n && n <= 21 {
            let index = digits.index(digits.startIndex, offsetBy: n)
            return String(digits[..<index]) + "." + String(digits[index...])
        }
        if -6 < n && n <= 0 {
            return "0." + String(repeating: "0", count: -n) + digits
        }
        let sign = n - 1 >= 0 ? "+" : "-"
        let power = String(abs(n - 1))
        if k == 1 { return digits + "e" + sign + power }
        let first = digits.prefix(1)
        return first + "." + digits.dropFirst() + "e" + sign + power
    }

    /// The significant digits (no leading or trailing zeros) and `n` such
    /// that the value is `0.digits × 10^n`.
    static func decompose(_ value: Double) -> (String, Int) {
        let text = "\(value)"
        var mantissa = text
        var power = 0
        if let e = text.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            mantissa = String(text[..<e])
            power = Int(text[text.index(after: e)...]) ?? 0
        }
        var integerPart = mantissa
        var fraction = ""
        if let dot = mantissa.firstIndex(of: ".") {
            integerPart = String(mantissa[..<dot])
            fraction = String(mantissa[mantissa.index(after: dot)...])
        }
        var all = integerPart + fraction
        var pointAt = integerPart.count + power
        while all.hasPrefix("0") && all.count > 1 {
            all.removeFirst()
            pointAt -= 1
        }
        while all.hasSuffix("0") && all.count > 1 {
            all.removeLast()
        }
        return (all, pointAt)
    }

    /// `Number(text)`, for the strings a command line hands over: what the
    /// TypeScript CLI's `Number(segment)` makes of them. `nan` when it is not
    /// a number at all.
    public static func parse(_ text: String) -> Double {
        let whitespace: Set<Unicode.Scalar> = [
            "\u{09}", "\u{0A}", "\u{0B}", "\u{0C}", "\u{0D}", "\u{20}", "\u{A0}", "\u{1680}", "\u{2000}",
            "\u{2001}", "\u{2002}", "\u{2003}", "\u{2004}", "\u{2005}", "\u{2006}", "\u{2007}", "\u{2008}",
            "\u{2009}", "\u{200A}", "\u{2028}", "\u{2029}", "\u{202F}", "\u{205F}", "\u{3000}", "\u{FEFF}",
        ]
        var scalars = Array(text.unicodeScalars)
        while let first = scalars.first, whitespace.contains(first) { scalars.removeFirst() }
        while let last = scalars.last, whitespace.contains(last) { scalars.removeLast() }
        let trimmed = String(String.UnicodeScalarView(scalars))
        if trimmed.isEmpty { return 0 }
        let lower = trimmed.lowercased()
        for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] where lower.hasPrefix(prefix) {
            let body = trimmed.dropFirst(2)
            guard !body.isEmpty else { return .nan }
            var value = 0.0
            for character in body {
                guard let digit = character.hexDigitValue, digit < radix else { return .nan }
                value = value * Double(radix) + Double(digit)
            }
            return value
        }
        switch trimmed {
        case "Infinity", "+Infinity": return .infinity
        case "-Infinity": return -.infinity
        default: break
        }
        // StrDecimalLiteral: sign? (digits (. digits?)? | . digits) exponent?
        var index = trimmed.startIndex
        func isDigit(_ c: Character) -> Bool { c >= "0" && c <= "9" }
        if index < trimmed.endIndex, trimmed[index] == "+" || trimmed[index] == "-" {
            index = trimmed.index(after: index)
        }
        var sawDigits = false
        while index < trimmed.endIndex, isDigit(trimmed[index]) {
            sawDigits = true
            index = trimmed.index(after: index)
        }
        if index < trimmed.endIndex, trimmed[index] == "." {
            index = trimmed.index(after: index)
            while index < trimmed.endIndex, isDigit(trimmed[index]) {
                sawDigits = true
                index = trimmed.index(after: index)
            }
        }
        guard sawDigits else { return .nan }
        if index < trimmed.endIndex, trimmed[index] == "e" || trimmed[index] == "E" {
            index = trimmed.index(after: index)
            if index < trimmed.endIndex, trimmed[index] == "+" || trimmed[index] == "-" {
                index = trimmed.index(after: index)
            }
            var exponentDigits = false
            while index < trimmed.endIndex, isDigit(trimmed[index]) {
                exponentDigits = true
                index = trimmed.index(after: index)
            }
            guard exponentDigits else { return .nan }
        }
        guard index == trimmed.endIndex else { return .nan }
        var normalized = trimmed
        if normalized.hasPrefix(".") || normalized.hasPrefix("+.") || normalized.hasPrefix("-.") {
            normalized = normalized.replacingOccurrences(of: ".", with: "0.", options: [], range: normalized.range(of: "."))
        }
        if normalized.hasSuffix(".") { normalized += "0" }
        normalized = normalized.replacingOccurrences(of: ".e", with: ".0e").replacingOccurrences(of: ".E", with: ".0E")
        return Double(normalized) ?? .nan
    }
}

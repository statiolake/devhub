// JSON as it came off the wire, kept for display (tool input, raw events) and
// read field by field by the protocol decoders.
//
// Port of the `JsonValue` type of apps/desktop/src/model/conversation.ts, with
// the two parts of JavaScript's `JSON` the TypeScript code leans on:
// `JSON.parse` (strict JSON, objects keep the order their keys came in) and
// `JSON.stringify` (the same text, byte for byte, for the same value), so a
// line DevHub writes to a CLI, or keeps in `in.log`, reads the same to the TS
// app and to this one.
//
// Foundation's JSONSerialization is not used: it loses the order of an
// object's keys (a tool title reads a tool's first argument in words), and it
// reads `1` and `true` as the same NSNumber on Linux.

import Foundation

/// An object of JSON, in the order its keys were first given.
public struct JsonObject: Sendable, Hashable, Sequence, ExpressibleByDictionaryLiteral {
    public private(set) var keys: [String] = []
    private var storage: [String: JsonValue] = [:]

    public init() {}

    public init(_ pairs: [(String, JsonValue)]) {
        for (key, value) in pairs { self[key] = value }
    }

    public init(dictionaryLiteral elements: (String, JsonValue)...) {
        for (key, value) in elements { self[key] = value }
    }

    /// The value at `key`; setting `nil` removes the key.
    public subscript(key: String) -> JsonValue? {
        get { storage[key] }
        set {
            if let newValue {
                if storage.updateValue(newValue, forKey: key) == nil { keys.append(key) }
            } else if storage.removeValue(forKey: key) != nil {
                keys.removeAll { $0 == key }
            }
        }
    }

    public var count: Int { keys.count }
    public var isEmpty: Bool { keys.isEmpty }

    /// The values, in key order.
    public var values: [JsonValue] { keys.map { storage[$0]! } }

    public func makeIterator() -> AnyIterator<(key: String, value: JsonValue)> {
        var index = 0
        let keys = self.keys, storage = self.storage
        return AnyIterator {
            guard index < keys.count else { return nil }
            defer { index += 1 }
            return (keys[index], storage[keys[index]]!)
        }
    }

    /// Equal as JavaScript's deep equality reads two objects: the same keys
    /// with equal values, in whatever order.
    public static func == (lhs: JsonObject, rhs: JsonObject) -> Bool {
        lhs.storage == rhs.storage
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(storage)
    }
}

public enum JsonValue: Sendable, Hashable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JsonValue])
    case object(JsonObject)

    public var stringValue: String? {
        if case .string(let text) = self { return text }
        return nil
    }

    public var numberValue: Double? {
        if case .number(let number) = self { return number }
        return nil
    }

    public var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    public var arrayValue: [JsonValue]? {
        if case .array(let items) = self { return items }
        return nil
    }

    public var objectValue: JsonObject? {
        if case .object(let object) = self { return object }
        return nil
    }

    public var isNull: Bool {
        if case .null = self { return true }
        return false
    }

    /// `value[key]` of an object; nil for anything else, as optional chaining reads it.
    public subscript(key: String) -> JsonValue? {
        objectValue?[key]
    }
}

// ExpressibleByNilLiteral, for literals (`["parent": nil]`). Beware: inside a
// closure whose result is `JsonValue?`, a bare `nil` can be read as JSON null
// rather than Optional's none; write `.none` or `.null` there, never `nil`.
extension JsonValue: ExpressibleByNilLiteral, ExpressibleByBooleanLiteral,
    ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral, ExpressibleByStringLiteral,
    ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral
{
    public init(nilLiteral: ()) { self = .null }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(floatLiteral value: Double) { self = .number(value) }
    public init(stringLiteral value: String) { self = .string(value) }
    public init(arrayLiteral elements: JsonValue...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, JsonValue)...) {
        self = .object(JsonObject(elements))
    }
}

// MARK: - JSON.parse

/// A text that is not JSON: where it went wrong.
public struct JsonSyntaxError: Error, CustomStringConvertible, Equatable {
    public let offset: Int
    public let reason: String
    public var description: String { "\(reason) at offset \(offset)" }
}

extension JsonValue {
    /// `JSON.parse`: strict JSON, surrounding whitespace allowed.
    public static func parse(_ text: String) throws -> JsonValue {
        var parser = JsonParser(Array(text.utf8))
        parser.skipWhitespace()
        let value = try parser.value(depth: 0)
        parser.skipWhitespace()
        guard parser.atEnd else { throw parser.error("unexpected text after the value") }
        return value
    }

    /// `JSON.parse` of bytes taken as UTF-8.
    public static func parse(_ data: Data) throws -> JsonValue {
        try parse(String(decoding: data, as: UTF8.self))
    }
}

private struct JsonParser {
    let bytes: [UInt8]
    var index = 0

    init(_ bytes: [UInt8]) { self.bytes = bytes }

    var atEnd: Bool { index >= bytes.count }

    func error(_ reason: String) -> JsonSyntaxError {
        JsonSyntaxError(offset: index, reason: reason)
    }

    mutating func skipWhitespace() {
        while index < bytes.count {
            switch bytes[index] {
            case 0x20, 0x09, 0x0A, 0x0D: index += 1
            default: return
            }
        }
    }

    mutating func value(depth: Int) throws -> JsonValue {
        guard depth < 10_000 else { throw error("nested too deeply") }
        guard index < bytes.count else { throw error("unexpected end of JSON") }
        switch bytes[index] {
        case UInt8(ascii: "{"): return try object(depth: depth)
        case UInt8(ascii: "["): return try array(depth: depth)
        case UInt8(ascii: "\""): return .string(try string())
        case UInt8(ascii: "t"): try literal("true"); return .bool(true)
        case UInt8(ascii: "f"): try literal("false"); return .bool(false)
        case UInt8(ascii: "n"): try literal("null"); return .null
        case UInt8(ascii: "-"), UInt8(ascii: "0")...UInt8(ascii: "9"): return .number(try number())
        default: throw error("unexpected character")
        }
    }

    mutating func literal(_ word: String) throws {
        for byte in word.utf8 {
            guard index < bytes.count, bytes[index] == byte else { throw error("unexpected token") }
            index += 1
        }
    }

    mutating func object(depth: Int) throws -> JsonValue {
        index += 1
        var object = JsonObject()
        skipWhitespace()
        if index < bytes.count, bytes[index] == UInt8(ascii: "}") {
            index += 1
            return .object(object)
        }
        while true {
            skipWhitespace()
            guard index < bytes.count, bytes[index] == UInt8(ascii: "\"") else {
                throw error("expected a property name")
            }
            let key = try string()
            skipWhitespace()
            guard index < bytes.count, bytes[index] == UInt8(ascii: ":") else { throw error("expected ':'") }
            index += 1
            skipWhitespace()
            object[key] = try value(depth: depth + 1)
            skipWhitespace()
            guard index < bytes.count else { throw error("unexpected end of JSON") }
            if bytes[index] == UInt8(ascii: ",") {
                index += 1
                continue
            }
            if bytes[index] == UInt8(ascii: "}") {
                index += 1
                return .object(object)
            }
            throw error("expected ',' or '}'")
        }
    }

    mutating func array(depth: Int) throws -> JsonValue {
        index += 1
        var items: [JsonValue] = []
        skipWhitespace()
        if index < bytes.count, bytes[index] == UInt8(ascii: "]") {
            index += 1
            return .array(items)
        }
        while true {
            skipWhitespace()
            items.append(try value(depth: depth + 1))
            skipWhitespace()
            guard index < bytes.count else { throw error("unexpected end of JSON") }
            if bytes[index] == UInt8(ascii: ",") {
                index += 1
                continue
            }
            if bytes[index] == UInt8(ascii: "]") {
                index += 1
                return .array(items)
            }
            throw error("expected ',' or ']'")
        }
    }

    mutating func hex4() throws -> UInt32 {
        guard index + 4 <= bytes.count else { throw error("bad unicode escape") }
        var value: UInt32 = 0
        for _ in 0..<4 {
            let byte = bytes[index]
            let digit: UInt32
            switch byte {
            case UInt8(ascii: "0")...UInt8(ascii: "9"): digit = UInt32(byte - UInt8(ascii: "0"))
            case UInt8(ascii: "a")...UInt8(ascii: "f"): digit = UInt32(byte - UInt8(ascii: "a") + 10)
            case UInt8(ascii: "A")...UInt8(ascii: "F"): digit = UInt32(byte - UInt8(ascii: "A") + 10)
            default: throw error("bad unicode escape")
            }
            value = value * 16 + digit
            index += 1
        }
        return value
    }

    mutating func string() throws -> String {
        index += 1
        var out: [UInt8] = []
        var scalars = String.UnicodeScalarView()
        func flush() {
            if !out.isEmpty {
                scalars.append(contentsOf: String(decoding: out, as: UTF8.self).unicodeScalars)
                out.removeAll(keepingCapacity: true)
            }
        }
        while true {
            guard index < bytes.count else { throw error("unterminated string") }
            let byte = bytes[index]
            if byte == UInt8(ascii: "\"") {
                index += 1
                break
            }
            if byte < 0x20 { throw error("bad control character in string") }
            if byte != UInt8(ascii: "\\") {
                out.append(byte)
                index += 1
                continue
            }
            index += 1
            guard index < bytes.count else { throw error("unterminated string") }
            let escape = bytes[index]
            index += 1
            switch escape {
            case UInt8(ascii: "\""): out.append(0x22)
            case UInt8(ascii: "\\"): out.append(0x5C)
            case UInt8(ascii: "/"): out.append(0x2F)
            case UInt8(ascii: "b"): out.append(0x08)
            case UInt8(ascii: "f"): out.append(0x0C)
            case UInt8(ascii: "n"): out.append(0x0A)
            case UInt8(ascii: "r"): out.append(0x0D)
            case UInt8(ascii: "t"): out.append(0x09)
            case UInt8(ascii: "u"):
                flush()
                let first = try hex4()
                if (0xD800...0xDBFF).contains(first),
                   index + 1 < bytes.count, bytes[index] == UInt8(ascii: "\\"), bytes[index + 1] == UInt8(ascii: "u")
                {
                    let save = index
                    index += 2
                    let second = try hex4()
                    if (0xDC00...0xDFFF).contains(second) {
                        let combined = 0x10000 + ((first - 0xD800) << 10) + (second - 0xDC00)
                        scalars.append(Unicode.Scalar(combined)!)
                    } else {
                        // A lone high surrogate, as a JS string would hold it, has
                        // no Swift spelling: it reads as the replacement character.
                        scalars.append("\u{FFFD}")
                        index = save
                    }
                } else if let scalar = Unicode.Scalar(first) {
                    scalars.append(scalar)
                } else {
                    scalars.append("\u{FFFD}")
                }
            default:
                throw error("bad escape in string")
            }
        }
        flush()
        return String(scalars)
    }

    mutating func number() throws -> Double {
        let start = index
        if bytes[index] == UInt8(ascii: "-") { index += 1 }
        guard index < bytes.count else { throw error("bad number") }
        if bytes[index] == UInt8(ascii: "0") {
            index += 1
        } else if (UInt8(ascii: "1")...UInt8(ascii: "9")).contains(bytes[index]) {
            while index < bytes.count, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[index]) { index += 1 }
        } else {
            throw error("bad number")
        }
        if index < bytes.count, bytes[index] == UInt8(ascii: ".") {
            index += 1
            let digits = index
            while index < bytes.count, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[index]) { index += 1 }
            guard index > digits else { throw error("bad number") }
        }
        if index < bytes.count, bytes[index] == UInt8(ascii: "e") || bytes[index] == UInt8(ascii: "E") {
            index += 1
            if index < bytes.count, bytes[index] == UInt8(ascii: "+") || bytes[index] == UInt8(ascii: "-") { index += 1 }
            let digits = index
            while index < bytes.count, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[index]) { index += 1 }
            guard index > digits else { throw error("bad number") }
        }
        let text = String(decoding: bytes[start..<index], as: UTF8.self)
        guard let value = Double(text) else { throw error("bad number") }
        return value
    }
}

// MARK: - JSON.stringify

extension JsonValue {
    /// `JSON.stringify(value)`: compact, keys in order, the same escapes.
    public var jsonText: String {
        var out = ""
        write(into: &out)
        return out
    }

    func write(into out: inout String) {
        switch self {
        case .null: out += "null"
        case .bool(let value): out += value ? "true" : "false"
        case .number(let value): out += JsonValue.javaScriptNumber(value)
        case .string(let text): JsonValue.quote(text, into: &out)
        case .array(let items):
            out += "["
            for (offset, item) in items.enumerated() {
                if offset > 0 { out += "," }
                item.write(into: &out)
            }
            out += "]"
        case .object(let object):
            out += "{"
            var first = true
            for (key, value) in object {
                if !first { out += "," }
                first = false
                JsonValue.quote(key, into: &out)
                out += ":"
                value.write(into: &out)
            }
            out += "}"
        }
    }

    /// A string as `JSON.stringify` quotes it.
    public static func quoted(_ text: String) -> String {
        var out = ""
        quote(text, into: &out)
        return out
    }

    static func quote(_ text: String, into out: inout String) {
        out += "\""
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
    }

    /// `String(n)` for a JavaScript number (what `JSON.stringify` writes).
    public static func javaScriptNumber(_ value: Double) -> String {
        guard value.isFinite else { return "null" }
        if value == 0 { return "0" }
        if value == value.rounded(), abs(value) < 1e15 {
            return String(Int64(value))
        }
        // Swift's description is the shortest round-tripping digits, as
        // JavaScript's is; only the layout differs.
        let negative = value < 0
        var text = "\(abs(value))"
        var exponent = 0
        if let e = text.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            exponent = Int(text[text.index(after: e)...])!
            text = String(text[..<e])
        }
        var digits: String
        var pointAt: Int
        if let dot = text.firstIndex(of: ".") {
            digits = String(text[..<dot]) + String(text[text.index(after: dot)...])
            pointAt = text.distance(from: text.startIndex, to: dot)
        } else {
            digits = text
            pointAt = text.count
        }
        // Strip leading zeros (moving the point) and trailing zeros.
        while digits.count > 1, digits.first == "0" {
            digits.removeFirst()
            pointAt -= 1
        }
        while digits.count > 1, digits.last == "0" { digits.removeLast() }
        // n: the position of the decimal point relative to the digits, as in
        // ECMAScript's Number::toString (value = 0.d1d2… × 10^n).
        let n = pointAt + exponent
        let k = digits.count
        var result: String
        if k <= n, n <= 21 {
            result = digits + String(repeating: "0", count: n - k)
        } else if 0 < n, n <= 21 {
            let split = digits.index(digits.startIndex, offsetBy: n)
            result = digits[..<split] + "." + digits[split...]
        } else if -6 < n, n <= 0 {
            result = "0." + String(repeating: "0", count: -n) + digits
        } else {
            let e = n - 1
            let sign = e >= 0 ? "+" : "-"
            if k == 1 {
                result = digits + "e" + sign + String(abs(e))
            } else {
                result = String(digits.first!) + "." + digits.dropFirst() + "e" + sign + String(abs(e))
            }
        }
        return negative ? "-" + result : result
    }
}

extension JsonObject {
    /// `JSON.stringify` of the object.
    public var jsonText: String { JsonValue.object(self).jsonText }
}

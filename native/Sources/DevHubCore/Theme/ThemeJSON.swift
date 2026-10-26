// The JSON the theme catalog reads: VS Code's theme files and extension
// manifests, parsed with JavaScript's `JSON.parse` semantics (after
// `parseJsonc` has taken out comments and trailing commas).
//
// Own parser rather than `JSONSerialization` because the catalog's decisions
// hang on distinctions Foundation blurs: `true` is not `1` (`.obsolete`), a
// later duplicate key wins, and the order an object's keys were written in is
// kept (VS Code walks a theme's `colors` in that order).

import Foundation

/// A JSON value, with an object's keys in the order they were written.
public indirect enum ThemeJSONValue: Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([ThemeJSONValue])
    case object(ThemeJSONObject)

    /// The value as a record (`record()` in the TS catalog): an object, not an
    /// array, not null.
    public var object: ThemeJSONObject? {
        if case .object(let object) = self { return object }
        return nil
    }

    public var string: String? {
        if case .string(let text) = self { return text }
        return nil
    }

    public var array: [ThemeJSONValue]? {
        if case .array(let values) = self { return values }
        return nil
    }

    /// `String(value)` in JavaScript, for the few places a manifest field is
    /// turned into text whatever it is.
    var jsString: String {
        switch self {
        case .null: return "null"
        case .bool(let value): return value ? "true" : "false"
        case .number(let value): return ThemeJSONValue.jsNumberString(value)
        case .string(let text): return text
        case .array(let values):
            return values.map { value -> String in
                if case .null = value { return "" }
                return value.jsString
            }.joined(separator: ",")
        case .object: return "[object Object]"
        }
    }

    static func jsNumberString(_ value: Double) -> String {
        if value.isNaN { return "NaN" }
        if value.isInfinite { return value < 0 ? "-Infinity" : "Infinity" }
        if value == value.rounded(), abs(value) < 1e21 { return String(Int64(value)) }
        return "\(value)"
    }
}

/// A JSON object: its entries in order, a later duplicate key replacing the
/// earlier one's value in place (as `JSON.parse` does).
public struct ThemeJSONObject: Sendable, Equatable {
    public private(set) var keys: [String] = []
    private var values: [String: ThemeJSONValue] = [:]

    public init() {}

    public subscript(key: String) -> ThemeJSONValue? {
        values[key]
    }

    public var entries: [(key: String, value: ThemeJSONValue)] {
        keys.map { ($0, values[$0]!) }
    }

    mutating func set(_ key: String, _ value: ThemeJSONValue) {
        if values.updateValue(value, forKey: key) == nil { keys.append(key) }
    }
}

/// `JSON.parse`, strictly: anything else is `nil`.
enum ThemeJSONParser {
    static func parse(_ text: String) -> ThemeJSONValue? {
        var parser = Parser(Array(text.utf16))
        parser.skipWhitespace()
        guard let value = parser.value() else { return nil }
        parser.skipWhitespace()
        return parser.atEnd ? value : nil
    }

    private struct Parser {
        let units: [UInt16]
        var index = 0
        var depth = 0

        init(_ units: [UInt16]) { self.units = units }

        var atEnd: Bool { index >= units.count }

        func peek() -> UInt16? { index < units.count ? units[index] : nil }

        mutating func skipWhitespace() {
            // JSON whitespace only: space, tab, LF, CR.
            while let unit = peek(), unit == 0x20 || unit == 0x09 || unit == 0x0A || unit == 0x0D {
                index += 1
            }
        }

        mutating func literal(_ word: String) -> Bool {
            let wordUnits = Array(word.utf16)
            guard index + wordUnits.count <= units.count,
                  Array(units[index..<(index + wordUnits.count)]) == wordUnits
            else { return false }
            index += wordUnits.count
            return true
        }

        mutating func value() -> ThemeJSONValue? {
            guard let unit = peek() else { return nil }
            switch unit {
            case 0x7B: return objectValue()
            case 0x5B: return arrayValue()
            case 0x22: return stringValue().map(ThemeJSONValue.string)
            case 0x74: return literal("true") ? .bool(true) : nil
            case 0x66: return literal("false") ? .bool(false) : nil
            case 0x6E: return literal("null") ? .null : nil
            default: return numberValue()
            }
        }

        mutating func objectValue() -> ThemeJSONValue? {
            depth += 1
            defer { depth -= 1 }
            guard depth < 512 else { return nil }
            index += 1
            var object = ThemeJSONObject()
            skipWhitespace()
            if peek() == 0x7D {
                index += 1
                return .object(object)
            }
            while true {
                skipWhitespace()
                guard peek() == 0x22, let key = stringValue() else { return nil }
                skipWhitespace()
                guard peek() == 0x3A else { return nil }
                index += 1
                skipWhitespace()
                guard let value = value() else { return nil }
                object.set(key, value)
                skipWhitespace()
                switch peek() {
                case 0x2C: index += 1
                case 0x7D:
                    index += 1
                    return .object(object)
                default: return nil
                }
            }
        }

        mutating func arrayValue() -> ThemeJSONValue? {
            depth += 1
            defer { depth -= 1 }
            guard depth < 512 else { return nil }
            index += 1
            var values: [ThemeJSONValue] = []
            skipWhitespace()
            if peek() == 0x5D {
                index += 1
                return .array(values)
            }
            while true {
                skipWhitespace()
                guard let value = value() else { return nil }
                values.append(value)
                skipWhitespace()
                switch peek() {
                case 0x2C: index += 1
                case 0x5D:
                    index += 1
                    return .array(values)
                default: return nil
                }
            }
        }

        mutating func hexValue() -> UInt16? {
            guard index + 4 <= units.count else { return nil }
            var result: UInt16 = 0
            for unit in units[index..<(index + 4)] {
                let digit: UInt16
                switch unit {
                case 0x30...0x39: digit = unit - 0x30
                case 0x41...0x46: digit = unit - 0x41 + 10
                case 0x61...0x66: digit = unit - 0x61 + 10
                default: return nil
                }
                result = result * 16 + digit
            }
            index += 4
            return result
        }

        mutating func stringValue() -> String? {
            index += 1
            var out: [UInt16] = []
            while let unit = peek() {
                index += 1
                switch unit {
                case 0x22:
                    // A lone surrogate is legal in a JS string and not in a
                    // Swift one; it becomes U+FFFD.
                    return String(decoding: out, as: UTF16.self)
                case 0x5C:
                    guard let escaped = peek() else { return nil }
                    index += 1
                    switch escaped {
                    case 0x22, 0x5C, 0x2F: out.append(escaped)
                    case 0x62: out.append(0x08)
                    case 0x66: out.append(0x0C)
                    case 0x6E: out.append(0x0A)
                    case 0x72: out.append(0x0D)
                    case 0x74: out.append(0x09)
                    case 0x75:
                        guard let code = hexValue() else { return nil }
                        out.append(code)
                    default: return nil
                    }
                default:
                    if unit < 0x20 { return nil }
                    out.append(unit)
                }
            }
            return nil
        }

        mutating func numberValue() -> ThemeJSONValue? {
            let start = index
            if peek() == 0x2D { index += 1 }
            guard let first = peek(), (0x30...0x39).contains(first) else { return nil }
            if first == 0x30 {
                index += 1
            } else {
                while let unit = peek(), (0x30...0x39).contains(unit) { index += 1 }
            }
            if peek() == 0x2E {
                index += 1
                guard let unit = peek(), (0x30...0x39).contains(unit) else { return nil }
                while let unit = peek(), (0x30...0x39).contains(unit) { index += 1 }
            }
            if peek() == 0x65 || peek() == 0x45 {
                index += 1
                if peek() == 0x2B || peek() == 0x2D { index += 1 }
                guard let unit = peek(), (0x30...0x39).contains(unit) else { return nil }
                while let unit = peek(), (0x30...0x39).contains(unit) { index += 1 }
            }
            let text = String(decoding: units[start..<index], as: UTF16.self)
            guard let number = Double(text) else { return nil }
            return .number(number)
        }
    }
}

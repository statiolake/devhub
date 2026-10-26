// The values a TOML document holds, as the TypeScript app sees them.
//
// `toml-eslint-parser`'s `getStaticTOMLValue` hands the TS code plain JS
// values: strings, numbers (integers and floats alike — a JS `number`),
// booleans, `Date`s, arrays and objects. Config validation is written against
// exactly that shape ("is it a number", "is it a plain object"), so the Swift
// value keeps it: one `number` case, and tables that list their keys in JS
// property order.

import Foundation

/// A TOML date-time value. The TS app receives a JS `Date` and refuses it
/// wherever DevHub expects anything else, so the native app keeps only what is
/// needed to say the same: which kind it was and how it was written.
public struct TomlDateTime: Equatable, Hashable, Sendable {
    public enum Kind: String, Sendable {
        case offsetDateTime = "offset-date-time"
        case localDateTime = "local-date-time"
        case localDate = "local-date"
        case localTime = "local-time"
    }

    public var kind: Kind
    /// The value as the file spells it.
    public var text: String

    public init(kind: Kind, text: String) {
        self.kind = kind
        self.text = text
    }
}

public indirect enum TomlValue: Equatable, Hashable, Sendable {
    case string(String)
    /// Integers and floats alike, as a JS `number`.
    case number(Double)
    case bool(Bool)
    case datetime(TomlDateTime)
    case array([TomlValue])
    case table(TomlTable)

    public var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    public var numberValue: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    public var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    public var arrayValue: [TomlValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    public var tableValue: TomlTable? {
        if case .table(let value) = self { return value }
        return nil
    }
}

extension TomlValue: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral,
    ExpressibleByBooleanLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral
{
    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(floatLiteral value: Double) { self = .number(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(arrayLiteral elements: TomlValue...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, TomlValue)...) {
        var table = TomlTable()
        for (key, value) in elements { table[key] = value }
        self = .table(table)
    }
}

/// A TOML table: keys in JS property order (insertion order, with
/// array-index-like keys first), which is the order the TypeScript code walks
/// a table in.
public struct TomlTable: Equatable, Hashable, Sendable, ExpressibleByDictionaryLiteral {
    public private(set) var keys: [String] = []
    private var storage: [String: TomlValue] = [:]

    public init() {}

    public init(dictionaryLiteral elements: (String, TomlValue)...) {
        for (key, value) in elements { self[key] = value }
    }

    public init(_ pairs: [(String, TomlValue)]) {
        for (key, value) in pairs { self[key] = value }
    }

    public subscript(key: String) -> TomlValue? {
        get { storage[key] }
        set {
            if let newValue {
                if storage.updateValue(newValue, forKey: key) == nil { insertKey(key) }
            } else if storage.removeValue(forKey: key) != nil {
                keys.removeAll { $0 == key }
            }
        }
    }

    public var count: Int { keys.count }
    public var isEmpty: Bool { keys.isEmpty }
    public func contains(_ key: String) -> Bool { storage[key] != nil }

    /// `Object.entries(table)`.
    public var entries: [(key: String, value: TomlValue)] { keys.map { ($0, storage[$0]!) } }

    public static func == (lhs: TomlTable, rhs: TomlTable) -> Bool {
        lhs.keys == rhs.keys && lhs.storage == rhs.storage
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(keys)
        for key in keys { hasher.combine(storage[key]) }
    }

    private mutating func insertKey(_ key: String) {
        guard let index = JSPropertyOrder.arrayIndex(key) else {
            keys.append(key)
            return
        }
        var at = 0
        while at < keys.count, let other = JSPropertyOrder.arrayIndex(keys[at]), other < index { at += 1 }
        keys.insert(key, at: at)
    }
}

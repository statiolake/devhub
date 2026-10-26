// Port of apps/desktop/src/main/editor/msgpack.ts
//
// Just enough MessagePack for Neovim's RPC.
//
// Neovim speaks msgpack-rpc on its `--listen` socket (`:help rpc`), and the
// managed Neovim server (`ManagedNeovims`) is the one place DevHub talks to
// it. A dependency for this would be a package to pin, audit and bundle for a
// few dozen lines; the format is small and stable, so it is written here and
// tested against the specification's own byte layouts.
//
// What it encodes: nil, booleans, integers (as the smallest int/uint that
// holds them), doubles (float64), strings (UTF-8 str), binary (bin), arrays,
// and maps with string keys. What it decodes: all of that, float32, maps with
// any keys (keys stringified, as the TypeScript decoder does), and ext —
// which is how Neovim sends a Buffer, Window or Tabpage handle — as `.ext`.
//
// Integers beyond 2^53 are refused rather than rounded: nothing DevHub sends
// or asks for is that large, and the TypeScript client (whose numbers are
// doubles) refuses them too, so the two clients agree on every value.

import Foundation

/// One msgpack value.
public enum MsgpackValue: Equatable, Sendable {
    case `nil`
    case bool(Bool)
    case int(Int64)
    case double(Double)
    case string(String)
    case binary([UInt8])
    case array([MsgpackValue])
    /// A map, keys in the order they were written or read.
    case map([MsgpackEntry])
    /// An ext value as it arrived: Neovim's handles are these (`:help api-types`).
    case ext(type: Int8, data: [UInt8])

    public var stringValue: String? {
        if case let .string(value) = self { return value }
        return nil
    }

    public var intValue: Int64? {
        if case let .int(value) = self { return value }
        return nil
    }

    public var boolValue: Bool? {
        if case let .bool(value) = self { return value }
        return nil
    }

    public var arrayValue: [MsgpackValue]? {
        if case let .array(value) = self { return value }
        return nil
    }

    public var isNil: Bool {
        if case .nil = self { return true }
        return false
    }

    /// A map's value at `key`, the last one when repeated (as a JavaScript
    /// object built from the map keeps the last).
    public subscript(key: String) -> MsgpackValue? {
        guard case let .map(entries) = self else { return nil }
        return entries.last(where: { $0.key == key })?.value
    }
}

public struct MsgpackEntry: Equatable, Sendable {
    public let key: String
    public let value: MsgpackValue
    public init(_ key: String, _ value: MsgpackValue) {
        self.key = key
        self.value = value
    }
}

extension MsgpackValue: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByBooleanLiteral,
    ExpressibleByArrayLiteral, ExpressibleByNilLiteral, ExpressibleByFloatLiteral, ExpressibleByDictionaryLiteral
{
    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int64) { self = .int(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(arrayLiteral elements: MsgpackValue...) { self = .array(elements) }
    public init(nilLiteral: ()) { self = .nil }
    public init(floatLiteral value: Double) { self = .double(value) }
    public init(dictionaryLiteral elements: (String, MsgpackValue)...) {
        self = .map(elements.map { MsgpackEntry($0.0, $0.1) })
    }

    public static func optional(_ value: String?) -> MsgpackValue { value.map(MsgpackValue.string) ?? .nil }
    public static func optional(_ value: Int?) -> MsgpackValue { value.map { .int(Int64($0)) } ?? .nil }
}

/// Why a value could not be encoded or decoded.
public enum MsgpackError: Error, Equatable, CustomStringConvertible, Sendable {
    /// The buffer ended part way through a value: wait for more bytes.
    case incomplete
    /// An integer past 2^53 either way.
    case unsafeInteger(String)
    /// A byte that starts no msgpack value.
    case badTypeByte(UInt8)
    /// A str whose bytes are not UTF-8.
    case invalidUTF8

    public var description: String {
        switch self {
        case .incomplete: return "msgpack: the value is not complete yet"
        case let .unsafeInteger(value): return "msgpack: \(value) is not a safe integer"
        case let .badTypeByte(byte): return "msgpack: 0x\(String(byte, radix: 16)) is not a type byte"
        case .invalidUTF8: return "msgpack: a string is not UTF-8"
        }
    }
}

public enum Msgpack {
    /// `Number.MAX_SAFE_INTEGER`.
    public static let maxSafeInteger: Int64 = 9_007_199_254_740_991

    /// Encode one value.
    public static func encode(_ value: MsgpackValue) throws -> [UInt8] {
        var out: [UInt8] = []
        try write(value, into: &out)
        return out
    }

    /// Decode one value from the front of `buffer`: the value and how many
    /// bytes it took. Throws `.incomplete` when the buffer ends inside it,
    /// which a stream reader answers by waiting for more.
    public static func decode<Bytes: RandomAccessCollection>(_ buffer: Bytes) throws -> (value: MsgpackValue, length: Int)
    where Bytes.Element == UInt8, Bytes.Index == Int {
        var reader = Reader(buffer: buffer)
        let value = try reader.value()
        return (value, reader.offset - buffer.startIndex)
    }

    private static func appendBigEndian<T: FixedWidthInteger>(_ value: T, into out: inout [UInt8]) {
        withUnsafeBytes(of: value.bigEndian) { out.append(contentsOf: $0) }
    }

    private static func writeInteger(_ value: Int64, into out: inout [UInt8]) throws {
        guard value >= -maxSafeInteger, value <= maxSafeInteger else {
            throw MsgpackError.unsafeInteger(String(value))
        }
        if value >= 0 {
            if value < 0x80 {
                out.append(UInt8(value))
            } else if value <= 0xff {
                out.append(0xcc)
                out.append(UInt8(value))
            } else if value <= 0xffff {
                out.append(0xcd)
                appendBigEndian(UInt16(value), into: &out)
            } else if value <= 0xffff_ffff {
                out.append(0xce)
                appendBigEndian(UInt32(value), into: &out)
            } else {
                out.append(0xcf)
                appendBigEndian(UInt64(value), into: &out)
            }
            return
        }
        if value >= -32 {
            out.append(UInt8(bitPattern: Int8(value)))
        } else if value >= -0x80 {
            out.append(0xd0)
            out.append(UInt8(bitPattern: Int8(value)))
        } else if value >= -0x8000 {
            out.append(0xd1)
            appendBigEndian(Int16(value), into: &out)
        } else if value >= -0x8000_0000 {
            out.append(0xd2)
            appendBigEndian(Int32(value), into: &out)
        } else {
            out.append(0xd3)
            appendBigEndian(value, into: &out)
        }
    }

    private static func writeLength(
        _ length: Int, fix: (prefix: UInt8, max: Int)?, prefixes: (UInt8?, UInt8, UInt8), into out: inout [UInt8]
    ) {
        if let fix, length <= fix.max {
            out.append(fix.prefix | UInt8(length))
        } else if let one = prefixes.0, length <= 0xff {
            out.append(one)
            out.append(UInt8(length))
        } else if length <= 0xffff {
            out.append(prefixes.1)
            appendBigEndian(UInt16(length), into: &out)
        } else {
            out.append(prefixes.2)
            appendBigEndian(UInt32(length), into: &out)
        }
    }

    private static func write(_ value: MsgpackValue, into out: inout [UInt8]) throws {
        switch value {
        case .nil:
            out.append(0xc0)
        case let .bool(flag):
            out.append(flag ? 0xc3 : 0xc2)
        case let .int(number):
            try writeInteger(number, into: &out)
        case let .double(number):
            out.append(0xcb)
            appendBigEndian(number.bitPattern, into: &out)
        case let .string(text):
            let utf8 = Array(text.utf8)
            writeLength(utf8.count, fix: (0xa0, 31), prefixes: (0xd9, 0xda, 0xdb), into: &out)
            out.append(contentsOf: utf8)
        case let .binary(bytes):
            writeLength(bytes.count, fix: nil, prefixes: (0xc4, 0xc5, 0xc6), into: &out)
            out.append(contentsOf: bytes)
        case let .array(items):
            writeLength(items.count, fix: (0x90, 15), prefixes: (nil, 0xdc, 0xdd), into: &out)
            for item in items { try write(item, into: &out) }
        case let .map(entries):
            writeLength(entries.count, fix: (0x80, 15), prefixes: (nil, 0xde, 0xdf), into: &out)
            for entry in entries {
                try write(.string(entry.key), into: &out)
                try write(entry.value, into: &out)
            }
        case let .ext(type, data):
            switch data.count {
            case 1: out.append(0xd4)
            case 2: out.append(0xd5)
            case 4: out.append(0xd6)
            case 8: out.append(0xd7)
            case 16: out.append(0xd8)
            default:
                writeLength(data.count, fix: nil, prefixes: (0xc7, 0xc8, 0xc9), into: &out)
            }
            out.append(UInt8(bitPattern: type))
            out.append(contentsOf: data)
        }
    }

    private struct Reader<Bytes: RandomAccessCollection> where Bytes.Element == UInt8, Bytes.Index == Int {
        let buffer: Bytes
        var offset: Int

        init(buffer: Bytes) {
            self.buffer = buffer
            self.offset = buffer.startIndex
        }

        func need(_ count: Int) throws {
            if offset + count > buffer.endIndex { throw MsgpackError.incomplete }
        }

        mutating func u8() throws -> UInt8 {
            try need(1)
            defer { offset += 1 }
            return buffer[offset]
        }

        mutating func bigEndian<T: FixedWidthInteger>(_: T.Type) throws -> T {
            let size = MemoryLayout<T>.size
            try need(size)
            var value: T = 0
            for index in 0..<size {
                value = (value << 8) | T(truncatingIfNeeded: buffer[offset + index])
            }
            offset += size
            return value
        }

        mutating func take(_ count: Int) throws -> [UInt8] {
            try need(count)
            defer { offset += count }
            return Array(buffer[offset..<offset + count])
        }

        mutating func str(_ length: Int) throws -> MsgpackValue {
            let bytes = try take(length)
            guard let text = String(bytes: bytes, encoding: .utf8) else { throw MsgpackError.invalidUTF8 }
            return .string(text)
        }

        mutating func array(_ length: Int) throws -> MsgpackValue {
            var items: [MsgpackValue] = []
            items.reserveCapacity(min(length, 4096))
            for _ in 0..<length { items.append(try value()) }
            return .array(items)
        }

        mutating func map(_ length: Int) throws -> MsgpackValue {
            var entries: [MsgpackEntry] = []
            for _ in 0..<length {
                let key = try value()
                entries.append(MsgpackEntry(Msgpack.keyString(key), try value()))
            }
            return .map(entries)
        }

        mutating func ext(_ length: Int) throws -> MsgpackValue {
            try need(1)
            let type = Int8(bitPattern: buffer[offset])
            offset += 1
            return .ext(type: type, data: try take(length))
        }

        func safe(_ value: Int64) throws -> MsgpackValue {
            guard value >= -Msgpack.maxSafeInteger, value <= Msgpack.maxSafeInteger else {
                throw MsgpackError.unsafeInteger(String(value))
            }
            return .int(value)
        }

        mutating func value() throws -> MsgpackValue {
            let prefix = try u8()
            if prefix <= 0x7f { return .int(Int64(prefix)) }
            if prefix >= 0xe0 { return .int(Int64(prefix) - 0x100) }
            if prefix & 0xf0 == 0x80 { return try map(Int(prefix & 0x0f)) }
            if prefix & 0xf0 == 0x90 { return try array(Int(prefix & 0x0f)) }
            if prefix & 0xe0 == 0xa0 { return try str(Int(prefix & 0x1f)) }
            switch prefix {
            case 0xc0: return .nil
            case 0xc2: return .bool(false)
            case 0xc3: return .bool(true)
            case 0xc4: return .binary(try take(Int(try u8())))
            case 0xc5: return .binary(try take(Int(try bigEndian(UInt16.self))))
            case 0xc6: return .binary(try take(Int(try bigEndian(UInt32.self))))
            case 0xc7: return try ext(Int(try u8()))
            case 0xc8: return try ext(Int(try bigEndian(UInt16.self)))
            case 0xc9: return try ext(Int(try bigEndian(UInt32.self)))
            case 0xca: return .double(Double(Float(bitPattern: try bigEndian(UInt32.self))))
            case 0xcb: return .double(Double(bitPattern: try bigEndian(UInt64.self)))
            case 0xcc: return .int(Int64(try u8()))
            case 0xcd: return .int(Int64(try bigEndian(UInt16.self)))
            case 0xce: return .int(Int64(try bigEndian(UInt32.self)))
            case 0xcf:
                let raw = try bigEndian(UInt64.self)
                guard raw <= UInt64(Msgpack.maxSafeInteger) else {
                    throw MsgpackError.unsafeInteger(String(raw))
                }
                return .int(Int64(raw))
            case 0xd0: return .int(Int64(Int8(bitPattern: try u8())))
            case 0xd1: return .int(Int64(try bigEndian(Int16.self)))
            case 0xd2: return .int(Int64(try bigEndian(Int32.self)))
            case 0xd3: return try safe(try bigEndian(Int64.self))
            case 0xd4: return try ext(1)
            case 0xd5: return try ext(2)
            case 0xd6: return try ext(4)
            case 0xd7: return try ext(8)
            case 0xd8: return try ext(16)
            case 0xd9: return try str(Int(try u8()))
            case 0xda: return try str(Int(try bigEndian(UInt16.self)))
            case 0xdb: return try str(Int(try bigEndian(UInt32.self)))
            case 0xdc: return try array(Int(try bigEndian(UInt16.self)))
            case 0xdd: return try array(Int(try bigEndian(UInt32.self)))
            case 0xde: return try map(Int(try bigEndian(UInt16.self)))
            case 0xdf: return try map(Int(try bigEndian(UInt32.self)))
            default: throw MsgpackError.badTypeByte(prefix)
            }
        }
    }

    /// A map key as the TypeScript decoder files it: strings as themselves,
    /// anything else as `String(key)` would spell it.
    static func keyString(_ key: MsgpackValue) -> String {
        switch key {
        case let .string(text): return text
        case .nil: return "null"
        case let .bool(flag): return flag ? "true" : "false"
        case let .int(number): return String(number)
        case let .double(number): return JavaScriptNumber.string(number)
        case let .binary(bytes): return bytes.map(String.init).joined(separator: ",")
        case let .array(items): return items.map(keyString).joined(separator: ",")
        case .map: return "[object Object]"
        case .ext: return "[object Object]"
        }
    }
}

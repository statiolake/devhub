// Port of apps/desktop/src/main/editor/msgpack.test.ts, plus the byte
// vectors the TypeScript encoder produced (Fixtures/editor/msgpack.json).

import XCTest
@testable import DevHubCore

final class MessagePackTests: XCTestCase {
    func hex(_ value: MsgpackValue) throws -> String {
        try Msgpack.encode(value).map { String(format: "%02x", $0) }.joined()
    }

    func bytes(_ hex: String) -> [UInt8] {
        var out: [UInt8] = []
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            out.append(UInt8(hex[index..<next], radix: 16)!)
            index = next
        }
        return out
    }

    func testEncodesEachTypeInItsSmallestForm() throws {
        XCTAssertEqual(try hex(.nil), "c0")
        XCTAssertEqual(try hex(true), "c3")
        XCTAssertEqual(try hex(false), "c2")
        XCTAssertEqual(try hex(0), "00")
        XCTAssertEqual(try hex(127), "7f")
        XCTAssertEqual(try hex(128), "cc80")
        XCTAssertEqual(try hex(256), "cd0100")
        XCTAssertEqual(try hex(65_536), "ce00010000")
        XCTAssertEqual(try hex(.int(1 << 32)), "cf0000000100000000")
        XCTAssertEqual(try hex(-1), "ff")
        XCTAssertEqual(try hex(-32), "e0")
        XCTAssertEqual(try hex(-33), "d0df")
        XCTAssertEqual(try hex(-129), "d1ff7f")
        XCTAssertEqual(try hex(-40_000), "d2ffff63c0")
        XCTAssertEqual(try hex(1.5), "cb3ff8000000000000")
        XCTAssertEqual(try hex("a"), "a161")
        XCTAssertEqual(try hex(.string(String(repeating: "x", count: 32))), "d920" + String(repeating: "78", count: 32))
        XCTAssertEqual(try hex([1, 2]), "920102")
        XCTAssertEqual(try hex(["a": 1]), "81a16101")
        XCTAssertEqual(try hex(.binary([1, 2])), "c4020102")
    }

    func testRoundTripsWhatNeovimsRPCCarries() throws {
        let message: MsgpackValue = [
            0, 42, "nvim_exec_lua",
            [
                "return ...",
                ["/tmp/a file with ' and |.ts", 12, nil, "日本語"],
                ["nested": [true, false, -7, 3.25]],
            ],
        ]
        let encoded = try Msgpack.encode(message)
        let decoded = try Msgpack.decode(encoded)
        XCTAssertEqual(decoded.value, message)
        XCTAssertEqual(decoded.length, encoded.count)
    }

    func testRoundTripsLongStringsArraysAndMapsInTheir16And32BitForms() throws {
        let long = MsgpackValue.string(String(repeating: "y", count: 70_000))
        let array = MsgpackValue.array((0..<20).map { .int(Int64($0)) })
        let map = MsgpackValue.map((0..<20).map { MsgpackEntry("k\($0)", .int(Int64($0))) })
        let bigArray = MsgpackValue.array((0..<70_000).map { _ in .nil })
        for value in [long, array, map, bigArray] {
            XCTAssertEqual(try Msgpack.decode(try Msgpack.encode(value)).value, value)
        }
    }

    func testReadsAnExtValueHowNeovimSendsABufferHandleAsItself() throws {
        // fixext1, type 0 (Buffer), payload 0x01.
        let value = try Msgpack.decode([0xd4, 0x00, 0x01]).value
        XCTAssertEqual(value, .ext(type: 0, data: [1]))
        // And writes one back the same way.
        XCTAssertEqual(try Msgpack.encode(.ext(type: 0, data: [1])), [0xd4, 0x00, 0x01])
        XCTAssertEqual(try Msgpack.encode(.ext(type: 2, data: [1, 2, 3])), [0xc7, 0x03, 0x02, 1, 2, 3])
    }

    func testSaysAValueIsIncompleteRatherThanMisreadingIt() throws {
        let whole = try Msgpack.encode(["abc", 1234])
        for cut in 0..<whole.count {
            XCTAssertThrowsError(try Msgpack.decode(whole[0..<cut])) { error in
                XCTAssertEqual(error as? MsgpackError, .incomplete)
            }
        }
    }

    func testRefusesIntegersPast2To53RatherThanRoundingThem() {
        XCTAssertThrowsError(try Msgpack.encode(.int(1 << 60)))
        XCTAssertThrowsError(try Msgpack.decode([0xcf, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])) { error in
            guard case .unsafeInteger = error as? MsgpackError else { return XCTFail("\(error)") }
        }
        XCTAssertThrowsError(try Msgpack.decode([0xd3, 0x80, 0, 0, 0, 0, 0, 0, 0]))
    }

    func testRefusesAByteThatStartsNoValueAndAStrThatIsNotUTF8() {
        XCTAssertThrowsError(try Msgpack.decode([0xc1])) { error in
            XCTAssertEqual(error as? MsgpackError, .badTypeByte(0xc1))
        }
        XCTAssertThrowsError(try Msgpack.decode([0xa2, 0xff, 0xfe])) { error in
            XCTAssertEqual(error as? MsgpackError, .invalidUTF8)
        }
    }

    func testDecodesFromTheMiddleOfABuffer() throws {
        let joined = try Msgpack.encode("first") + Msgpack.encode(7)
        let first = try Msgpack.decode(joined)
        let second = try Msgpack.decode(joined[first.length...])
        XCTAssertEqual(second.value, 7)
        XCTAssertEqual(second.length, 1)
    }

    // MARK: - The TypeScript encoder's own bytes

    func build(_ tagged: WireJSON) -> MsgpackValue {
        let items = tagged.arrayValue!
        let tag = items[0].stringValue!
        let value = items[1]
        switch tag {
        case "nil": return .nil
        case "bool": return .bool(value.boolValue!)
        case "int": return .int(Int64(value.numberValue!))
        case "double": return .double(value.numberValue!)
        case "string": return .string(value.stringValue!)
        case "binary": return .binary(value.arrayValue!.map { UInt8($0.numberValue!) })
        case "array": return .array(value.arrayValue!.map(build))
        case "map":
            return .map(value.arrayValue!.map { pair in
                MsgpackEntry(pair.arrayValue![0].stringValue!, build(pair.arrayValue![1]))
            })
        default: fatalError(tag)
        }
    }

    func testEncodesEveryVectorByteForByteAsTheTypeScriptEncoderDoes() throws {
        let fixture = try WP7Fixtures.json("editor/msgpack.json")
        let encoded = fixture["encoded"]!.arrayValue!
        XCTAssertGreaterThan(encoded.count, 40)
        for vector in encoded {
            let value = build(vector["value"]!)
            XCTAssertEqual(try hex(value), vector["hex"]!.stringValue!, "\(value)")
            XCTAssertEqual(try Msgpack.decode(bytes(vector["hex"]!.stringValue!)).value, value)
        }
    }

    /// The TypeScript decoder's reading of each, as JSON: maps keyed by
    /// string (non-string keys stringified), ext and bin tagged.
    func asTypeScriptJSON(_ value: MsgpackValue) -> WireJSON {
        switch value {
        case .nil: return .null
        case let .bool(flag): return .bool(flag)
        case let .int(number): return .number(Double(number))
        case let .double(number): return .number(number)
        case let .string(text): return .string(text)
        case let .binary(data): return ["bin": .array(data.map { .int(Int($0)) })]
        case let .array(items): return .array(items.map(asTypeScriptJSON))
        case let .map(entries):
            var object: WireJSON = .object([])
            for entry in entries { object = object.setting(entry.key, asTypeScriptJSON(entry.value)) }
            return object
        case let .ext(type, data): return ["ext": .int(Int(type)), "data": .array(data.map { .int(Int($0)) })]
        }
    }

    func testDecodesAsTheTypeScriptDecoderDoes() throws {
        let fixture = try WP7Fixtures.json("editor/msgpack.json")
        for vector in fixture["decodes"]!.arrayValue! {
            let input = bytes(vector["hex"]!.stringValue!)
            if let expected = vector["json"]?.stringValue {
                let decoded = try Msgpack.decode(input)
                XCTAssertEqual(asTypeScriptJSON(decoded.value).compact, expected, vector["hex"]!.stringValue!)
                XCTAssertEqual(decoded.length, vector["length"]!.integerValue)
            } else {
                XCTAssertThrowsError(try Msgpack.decode(input), vector["hex"]!.stringValue!)
            }
        }
    }
}

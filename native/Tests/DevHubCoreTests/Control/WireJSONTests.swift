// The control socket's JSON, against what `JSON.stringify` and `JSON.parse`
// do (Fixtures/control/json.json was written by Node).

import XCTest
@testable import DevHubCore

final class WireJSONTests: XCTestCase {
    func testNumbersAreWrittenAsJavaScriptWritesThem() throws {
        let fixture = try WP7Fixtures.json("control/json.json")
        for entry in fixture["numbers"]!.arrayValue! {
            let text = entry["n"]!.stringValue!
            let value = try XCTUnwrap(Double(text), text)
            XCTAssertEqual(WireJSON.number(value).compact, entry["json"]!.stringValue!, text)
        }
        XCTAssertEqual(WireJSON.number(.nan).compact, "null")
        XCTAssertEqual(WireJSON.number(-.infinity).compact, "null")
    }

    func testStringsAreQuotedAsJavaScriptQuotesThem() throws {
        let fixture = try WP7Fixtures.json("control/json.json")
        for entry in fixture["quoted"]!.arrayValue! {
            let text = entry["s"]!.stringValue!
            XCTAssertEqual(WireJSON.quoted(text), entry["json"]!.stringValue!, text)
            // And reads back as itself.
            XCTAssertEqual(try WireJSON.parse(entry["json"]!.stringValue!), .string(text))
        }
    }

    func testPrettyIsStringifyWithTwoSpaces() throws {
        let fixture = try WP7Fixtures.json("control/json.json")
        let expected = fixture["pretty"]!.stringValue!
        let value: WireJSON = ["ok": true, "a": [], "b": .object([]), "c": [1, ["d": "e"]], "f": nil, "g": 1.5, "h": "x\ny"]
        XCTAssertEqual(value.pretty, expected)
        XCTAssertEqual(try WireJSON.parse(expected), value)
    }

    func testParsesWhatJSONParseParsesAndRefusesTheRest() throws {
        XCTAssertEqual(try WireJSON.parse(" {\"a\":[1,-2.5e3,true,false,null],\"b\":\"\\u00e9\\ud83d\\ude00\"} "),
            ["a": [1, -2500, true, false, nil], "b": "é😀"])
        // A repeated key keeps its first place and its last value.
        XCTAssertEqual(try WireJSON.parse("{\"k\":1,\"j\":2,\"k\":3}").compact, "{\"k\":3,\"j\":2}")
        for bad in ["", "{", "[1,]", "{\"a\":}", "01", "1.", ".5", "+1", "'x'", "\"\u{01}\"", "nul", "{} x", "[1 2]", "\"\\x\""] {
            XCTAssertThrowsError(try WireJSON.parse(bad), bad)
        }
    }

    func testKeepsKeyOrderAndDropsWhatJavaScriptWouldNotWrite() {
        let value = WireJSON.object(dropping: [("b", .int(1)), ("a", nil), ("c", .string("x"))])
        XCTAssertEqual(value.compact, "{\"b\":1,\"c\":\"x\"}")
        XCTAssertEqual(value.setting("b", 2).compact, "{\"b\":2,\"c\":\"x\"}")
        XCTAssertEqual(value.setting("d", true).compact, "{\"b\":1,\"c\":\"x\",\"d\":true}")
        XCTAssertTrue(WireJSON.parse(#"{"x":1,"y":2}"#, or: nil)!.sameValue(as: ["y": 2, "x": 1]))
    }

    func testJavaScriptNumberReadsCommandLineSegmentsAsNumberDoes() {
        let cases: [(String, Double)] = [
            ("", 0), (" 12 ", 12), ("0x10", 16), ("0o7", 7), ("0b11", 3), ("1e2", 100), ("+4", 4), ("-3", -3),
            (".5", 0.5), ("5.", 5), ("007", 7), ("\t8", 8),
        ]
        for (text, expected) in cases {
            XCTAssertEqual(JavaScriptNumber.parse(text), expected, text)
        }
        for text in ["abc", "1_000", "0x", "1e", "Infinity", "--1", "1.2.3", "0xg"] {
            let value = JavaScriptNumber.parse(text)
            XCTAssertTrue(value.isNaN || value.isInfinite, text)
        }
    }
}

extension WireJSON {
    static func parse(_ text: String, or fallback: WireJSON?) -> WireJSON? {
        (try? parse(text)) ?? fallback
    }
}

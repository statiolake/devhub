// Port of apps/desktop/src/model/elicitationForm.test.ts, and the JSON the
// conversation code reads and writes, checked against what Node prints.

import XCTest
@testable import DevHubCore

private func field(_ key: String, _ input: FormInput, required: Bool = false) -> FormField {
    FormField(key: key, label: key, description: nil, required: required, input: input)
}

private let NAME = field("name", .text(format: nil, minLength: 2, maxLength: 5, default: nil), required: true)
private let AGE = field("age", .number(integer: true, minimum: 0, maximum: 150, default: nil))
private let TAGS = field(
    "tags",
    .choice(
        multiple: true, options: [FormOption(value: "a", label: "A"), FormOption(value: "b", label: "B")],
        minItems: nil, maxItems: 1, default: []))

final class ElicitationFormTests: XCTestCase {
    func testAFormOfNoFieldsHasNothingToSendAndNothingWrong() throws {
        let (content, problems) = try formContent([], [:])
        XCTAssertEqual(content, [:])
        XCTAssertEqual(problems, [:])
    }

    func testARequiredFieldLeftEmptyIsRequiredAndAnOptionalOneIsLeftOut() throws {
        let (content, problems) = try formContent([NAME, AGE], ["name": .one(""), "age": .one("")])
        XCTAssertEqual(content, [:])
        XCTAssertEqual(problems, ["name": "Required"])
    }

    func testValuesAreHeldToTheSchemasBounds() throws {
        XCTAssertEqual(
            try formContent([NAME, AGE, TAGS], ["name": .one("a"), "age": .one("2.5"), "tags": .many(["a", "b"])]).problems,
            ["name": "At least 2 characters", "age": "A whole number", "tags": "Choose at most 1"])
        XCTAssertEqual(try formContent([AGE], ["age": .one("151")]).problems, ["age": "At most 150"])
    }

    func testEachValueIsTypedAsItsFieldSays() throws {
        let urgent = field("urgent", .boolean(default: nil))
        let (content, problems) = try formContent(
            [NAME, AGE, TAGS, urgent],
            ["name": .one("Ann"), "age": .one(" 42 "), "tags": .many(["b"]), "urgent": .one("false")])
        XCTAssertEqual(content, ["name": "Ann", "age": 42, "tags": ["b"], "urgent": false])
        XCTAssertEqual(problems, [:])
    }

    func testAValueNoControlCouldHoldThrows() {
        XCTAssertThrowsError(try formContent([TAGS], ["tags": .many(["c"])])) { error in
            XCTAssertTrue("\(error)".contains("offers no choice \"c\""))
        }
        XCTAssertThrowsError(try formContent([field("ok", .boolean(default: nil))], ["ok": .one("yes")])) { error in
            XCTAssertTrue("\(error)".contains("yes/no"))
        }
    }

    func testInitialValuesAreTheSchemasDefaults() {
        XCTAssertEqual(
            initialValues([
                NAME, field("n", .number(integer: false, minimum: nil, maximum: nil, default: 1.5)),
                field("b", .boolean(default: true)), TAGS,
            ]),
            ["name": .one(""), "n": .one("1.5"), "b": .one("true"), "tags": .many([])])
    }
}

final class JsonValueTests: XCTestCase {
    func testParseKeepsTheOrderOfKeys() throws {
        let value = try JsonValue.parse(#"{"z":1,"a":{"y":true,"b":null},"m":[1,"x"]}"#)
        XCTAssertEqual(value.objectValue?.keys, ["z", "a", "m"])
        XCTAssertEqual(value["a"]?.objectValue?.keys, ["y", "b"])
        XCTAssertEqual(value.jsonText, #"{"z":1,"a":{"y":true,"b":null},"m":[1,"x"]}"#)
    }

    func testStringifyEscapesAsJavaScriptDoes() {
        // JSON.stringify("a\"b\\c\n\t\u0001é😀/") in Node.
        XCTAssertEqual(JsonValue.string("a\"b\\c\n\t\u{01}é😀/").jsonText, #""a\"b\\c\n\t\u0001é😀/""#)
        XCTAssertEqual(JsonValue.string("\u{08}\u{0C}\r\u{1F}").jsonText, #""\b\f\r\u001f""#)
    }

    func testNumbersAreWrittenAsJavaScriptWritesThem() {
        // String(n) in Node for each.
        let cases: [(Double, String)] = [
            (0, "0"), (-0.0, "0"), (1, "1"), (-42, "-42"), (1.5, "1.5"), (0.1, "0.1"),
            (1e21, "1e+21"), (1e20, "100000000000000000000"), (123456789012345680000, "123456789012345680000"),
            (0.000001, "0.000001"), (1e-7, "1e-7"), (1.5e-10, "1.5e-10"), (2.5e300, "2.5e+300"),
            (1_800_000_000_000, "1800000000000"), (0.30000000000000004, "0.30000000000000004"),
            (Double.nan, "null"),
        ]
        for (value, text) in cases {
            XCTAssertEqual(JsonValue.javaScriptNumber(value), text, "\(value)")
        }
    }

    func testParseReadsEscapesAndSurrogatePairs() throws {
        XCTAssertEqual(try JsonValue.parse(#""é😀\n\/""#), .string("é😀\n/"))
        XCTAssertEqual(try JsonValue.parse(" [1.5e2, -0, true] "), [150, 0, true])
    }

    func testParseRefusesWhatIsNotJSON() {
        for text in ["", "{", "[1,]", "{'a':1}", "01", "1.", "nul", "\"a\nb\"", "1 2", "{\"a\" 1}"] {
            XCTAssertThrowsError(try JsonValue.parse(text), text)
        }
    }
}

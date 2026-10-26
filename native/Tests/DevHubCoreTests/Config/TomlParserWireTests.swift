// Wire compatibility of the TOML parser with toml-eslint-parser 1.0.3, the
// parser the TypeScript app reads `settings.toml` with.
//
// `Fixtures/toml/parse-cases.json` was produced by running the real
// toml-eslint-parser 1.0.3 (`parseTOML` + `getStaticTOMLValue`) over a corpus:
// hand-written cases for every corner of the grammar, the README's sample
// settings, the TS app's rendered default settings, and seeded random
// mutations of those (insertions, deletions and substitutions of TOML's
// punctuation, quotes, escapes, digits, line endings and non-ASCII text). For
// each input it records either the value (with key order and JS number
// spellings) and the source ranges of every pair and table, or the error's
// message, line, column and offset.
import XCTest
@testable import DevHubCore

final class TomlParserWireTests: XCTestCase {
    func encode(_ value: TomlValue) -> Any {
        switch value {
        case .string(let s): return ["s": s]
        case .number(let n): return ["n": n == 0 && n.sign == .minus ? "-0" : JSString.number(n)]
        case .bool(let b): return ["b": b]
        case .datetime: return ["d": 1]
        case .array(let items): return ["a": items.map(encode)]
        case .table(let table): return ["t": table.entries.map { [$0.key, encode($0.value)] }]
        }
    }

    func canonical(_ value: Any) -> String {
        let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed])
        return String(decoding: data, as: UTF8.self)
    }

    func same(_ a: Any, _ b: Any) -> Bool { canonical(a) == canonical(b) }

    func range(_ r: (Int, Int)) -> [Int] { [r.0, r.1] }

    func body(_ program: TomlProgram) -> Any {
        program.body.map { entry -> Any in
            switch entry {
            case .keyValue(let pair):
                return ["kv": range(pair.range), "v": range(pair.value.range)]
            case .table(let table):
                return [
                    "table": range(table.range),
                    "kind": table.kind == .array ? "array" : "standard",
                    "key": table.resolvedKey.map { segment -> Any in
                        switch segment {
                        case .key(let k): return ["k": k]
                        case .index(let i): return ["i": i]
                        }
                    },
                    "body": table.body.map { ["kv": range($0.range), "v": range($0.value.range)] },
                ]
            }
        }
    }

    func testEveryCaseParsesAsTheTypeScriptAppParsesIt() throws {
        let cases = try XCTUnwrap(try ConfigFixture.json("toml", "parse-cases.json") as? [[String: Any]])
        XCTAssertGreaterThan(cases.count, 1000)
        var failures = 0
        var parsed = 0
        var refused = 0
        for entry in cases {
            let input = try XCTUnwrap(entry["input"] as? String)
            do {
                let program = try TomlParser.parse(input)
                if let message = entry["error"] as? String {
                    failures += 1
                    XCTFail("parsed what the TS app refuses (\(message)): \(input.debugDescription)")
                    continue
                }
                parsed += 1
                let value = encode(.table(program.staticValue()))
                if !same(value, entry["value"]!) {
                    failures += 1
                    XCTFail("value differs for \(input.debugDescription): \(value) vs \(entry["value"]!)")
                }
                if !same(body(program), entry["body"]!) {
                    failures += 1
                    XCTFail("ranges differ for \(input.debugDescription): \(body(program)) vs \(entry["body"]!)")
                }
            } catch let error as TomlSyntaxError {
                guard let message = entry["error"] as? String else {
                    failures += 1
                    XCTFail("refused what the TS app parses (\(error)): \(input.debugDescription)")
                    continue
                }
                refused += 1
                let expected = "\(message) \(entry["line"]!):\(entry["column"]!)@\(entry["offset"]!)"
                let actual = "\(error.message) \(error.line!):\(error.column!)@\(error.offset!)"
                if expected != actual {
                    failures += 1
                    XCTFail("error differs for \(input.debugDescription): \(actual) vs \(expected)")
                }
            }
            if failures > 25 { break }
        }
        XCTAssertEqual(parsed + refused, cases.count)
        XCTAssertGreaterThan(parsed, 300)
        XCTAssertGreaterThan(refused, 1000)
    }
}

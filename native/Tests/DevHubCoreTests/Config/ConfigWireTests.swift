// Wire compatibility of config parsing, validation and saving with
// apps/desktop/src/model/config.ts.
//
// `Fixtures/config/parse-cases.json` and `save-cases.json` were produced by
// running the TypeScript app's own `parseConfig`, `configDocument`,
// `retiredKeysIn` and `configOntoDocument` (via tsx, over the TS source) on:
// the README's sample settings and agent actions, the rendered defaults, a
// rich hand-written file, legacy-shape files, and seeded random mutations of
// those (keys removed, added and retyped, values swapped for valid and invalid
// ones). For each input: the diagnostic (code, path, location), or the
// config's document as the TS app renders it, the retired keys it names, and
// whether saving it back over itself changes nothing. For each save: the
// source, the desired config (as its rendered document) and the exact text
// written.
import XCTest
@testable import DevHubCore

final class ConfigWireTests: XCTestCase {
    func diagnostic(_ value: Any?) -> ConfigDiagnostic? {
        guard let object = value as? [String: Any], let code = object["code"] as? String else { return nil }
        var location: SourceLocation?
        if let at = object["location"] as? [String: Any], let line = at["line"] as? Int, let column = at["column"] as? Int {
            location = SourceLocation(line: line, column: column)
        }
        return ConfigDiagnostic(code: ValidationCode(rawValue: code)!, path: object["path"] as? String, location: location)
    }

    func testEveryCaseIsReadAsTheTypeScriptAppReadsIt() throws {
        let cases = try XCTUnwrap(try ConfigFixture.json("config", "parse-cases.json") as? [[String: Any]])
        XCTAssertGreaterThan(cases.count, 400)
        var accepted = 0
        var refused = 0
        for entry in cases {
            let input = try XCTUnwrap(entry["input"] as? String)
            if let expected = diagnostic(entry["diagnostic"]) {
                refused += 1
                do {
                    let config = try ConfigParsing.parse(input)
                    XCTFail("accepted what the TS app refuses with \(expected): \(input)\n=> \(config)")
                } catch let error as ConfigError {
                    XCTAssertEqual(error.diagnostic, expected, input)
                }
                continue
            }
            accepted += 1
            do {
                let config = try ConfigParsing.parse(input)
                XCTAssertEqual(try TomlDocument.render(ConfigParsing.document(config)), entry["config"] as? String, input)
                let retired = ConfigParsing.retiredKeysIn(try ConfigParsing.parseText(input)).map(\.key)
                XCTAssertEqual(retired, entry["retired"] as? [String], input)
                let resaved = try ConfigParsing.ontoDocument(input, config) == input
                XCTAssertEqual(resaved, entry["resaved"] as? Bool, input)
            } catch {
                XCTFail("refused what the TS app accepts (\(error)): \(input)")
            }
        }
        XCTAssertGreaterThan(accepted, 50)
        XCTAssertGreaterThan(refused, 200)
    }

    func testEverySaveWritesTheSameTextAsTheTypeScriptApp() throws {
        let cases = try XCTUnwrap(try ConfigFixture.json("config", "save-cases.json") as? [[String: Any]])
        XCTAssertGreaterThan(cases.count, 40)
        for entry in cases {
            let source = try XCTUnwrap(entry["source"] as? String)
            let desired = try ConfigParsing.parse(try XCTUnwrap(entry["desired"] as? String))
            if let expected = diagnostic(entry["diagnostic"]) {
                XCTAssertThrowsError(try ConfigParsing.ontoDocument(source, desired)) { error in
                    XCTAssertEqual((error as? ConfigError)?.diagnostic, expected)
                }
                continue
            }
            XCTAssertEqual(try ConfigParsing.ontoDocument(source, desired), entry["output"] as? String, source)
        }
    }

    /// PLAN.md WP1 acceptance: the README sample config loads with no
    /// diagnostics, and an edit keeps the commented file byte-identical except
    /// the edited value.
    func testTheReadmeSampleLoadsAndAnEditTouchesOnlyItsValue() throws {
        let sample = try ConfigFixture.text("toml", "readme-settings.toml")
        var config = try ConfigParsing.parse(sample)
        XCTAssertEqual(config.general.noticeSeconds, 8)
        XCTAssertEqual(config.projects.directory, "~/dev/new")
        let actions = try ConfigParsing.parse("version = 4\n" + ConfigFixture.text("toml", "readme-agent-actions.toml"))
        XCTAssertEqual(actions.agentActions.first { $0.id == "answer_reviewers" }?.displayName, "Answer the reviewers")

        // Saving what was read writes the file forward (version, and the
        // sections a save states in full) but never rewrites a line the person
        // wrote; editing one value after that changes that value's span only.
        let forward = try ConfigParsing.ontoDocument(sample, config)
        let forwardLines = forward.components(separatedBy: "\n")
        for line in sample.components(separatedBy: "\n") where !line.isEmpty && line != "version = 3" {
            XCTAssertTrue(forwardLines.contains(line), line)
        }
        config.general.noticeSeconds = 12
        let edited = try ConfigParsing.ontoDocument(forward, config)
        let expected = forward.replacingOccurrences(of: "notice_seconds = 8", with: "notice_seconds = 12")
        XCTAssertEqual(edited, expected)
    }
}

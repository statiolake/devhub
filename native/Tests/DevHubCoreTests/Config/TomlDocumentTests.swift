// Port of apps/desktop/src/model/tomlDocument.test.ts
import XCTest
@testable import DevHubCore

/// `expect(a).toEqual(b)` for TOML values: deep, key order ignored.
func XCTAssertTomlEqual(_ actual: TomlTable, _ expected: TomlTable, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertTrue(tomlValuesEqual(.table(actual), .table(expected)), "\(actual) is not \(expected)", file: file, line: line)
}

func count(_ needle: String, in haystack: String) -> Int {
    haystack.components(separatedBy: needle).count - 1
}

final class TomlReadingTests: XCTestCase {
    func testReadsScalarsArraysTablesAndArraysOfTables() throws {
        let source = [
            "version = 1", "", "[general]", "import_login_environment = true", "",
            "[appearance]", "terminal_line_height = 1.2", ##"ansi = [ "#aa0000", "#00bb00" ]"##, "",
            "[[agent_profiles]]", #"id = "codex""#, "[agent_profiles.env]", #"TOKEN = "x""#, "",
        ].joined(separator: "\n")
        XCTAssertTomlEqual(try TomlDocument.parseValue(source), [
            "version": 1,
            "general": ["import_login_environment": true],
            "appearance": ["terminal_line_height": 1.2, "ansi": ["#aa0000", "#00bb00"]],
            "agent_profiles": [["id": "codex", "env": ["TOKEN": "x"]]],
        ])
    }

    func testReportsASyntaxErrorRatherThanAPartialDocument() {
        XCTAssertThrowsError(try TomlDocument.parseValue("version = \n")) { error in
            XCTAssertTrue(error is TomlSyntaxError)
            XCTAssertEqual((error as? TomlSyntaxError)?.line, 2)
            XCTAssertEqual((error as? TomlSyntaxError)?.column, 0)
        }
    }
}

final class TomlRenderingTests: XCTestCase {
    func testEscapesWhatHasNoLiteralSpelling() throws {
        XCTAssertEqual(try TomlDocument.renderValue("a \"quoted\"\npath\\here"), #""a \"quoted\"\npath\\here""#)
        XCTAssertEqual(try TomlDocument.renderValue([]), "[]")
        XCTAssertEqual(try TomlDocument.renderValue(["a", "b"]), #"[ "a", "b" ]"#)
        XCTAssertEqual(try TomlDocument.renderValue(.table(TomlTable())), "{}")
        XCTAssertEqual(try TomlDocument.renderValue(true), "true")
        XCTAssertEqual(try TomlDocument.renderValue("\u{1}\u{7f}"), #""\u0001\u007f""#)
        XCTAssertThrowsError(try TomlDocument.renderValue(.number(.infinity)))
    }

    func testPutsScalarsFirstThenTablesThenArraysOfTables() throws {
        let value: TomlTable = [
            "version": 1,
            "general": ["import_login_environment": true],
            "agent_profiles": [["id": "codex", "env": ["TOKEN": "x"]]],
        ]
        let text = try TomlDocument.render(value)
        XCTAssertTomlEqual(try TomlDocument.parseValue(text), value)
        XCTAssertLessThan(text.range(of: "version")!.lowerBound, text.range(of: "[general]")!.lowerBound)
    }
}

final class TomlEditingTests: XCTestCase {
    let source = [
        "# DevHub configuration.", "version = 1", "", "[appearance]", "# I like it small.",
        "terminal_font_size = 13   # not 14", #"terminal_font_family = "SF Mono""#, "",
        "[[agent_profiles]]", #"id = "codex""#, #"display_name = "Codex""#, "",
        "[[agent_profiles]]", #"id = "claude""#, #"display_name = "Claude""#, "",
    ].joined(separator: "\n")

    func documentOf(_ text: String) throws -> TomlTable { try TomlDocument.parseValue(text) }

    var document: TomlTable { try! documentOf(source) }
    var appearance: TomlTable { document["appearance"]!.tableValue! }
    var profiles: [TomlTable] { document["agent_profiles"]!.arrayValue!.map { $0.tableValue! } }

    func with(_ table: TomlTable, _ key: String, _ value: TomlValue?) -> TomlTable {
        var copy = table
        copy[key] = value
        return copy
    }

    func testReturnsTheFileUntouchedWhenNothingChanged() throws {
        XCTAssertEqual(try TomlDocument.update(source, desired: document), source)
    }

    func testReplacesOneValueAndKeepsItsCommentSpacingAndNeighbours() throws {
        let next = try TomlDocument.update(source, desired: with(document, "appearance", .table(with(appearance, "terminal_font_size", 15))))
        XCTAssertTrue(next.contains("terminal_font_size = 15   # not 14"))
        XCTAssertTrue(next.contains("# I like it small."))
        XCTAssertTrue(next.contains("# DevHub configuration."))
        XCTAssertTrue(next.contains(#"terminal_font_family = "SF Mono""#))
    }

    func testAppendsANewKeyUnderTheTableItBelongsTo() throws {
        let next = try TomlDocument.update(source, desired: with(document, "appearance", .table(with(appearance, "sidebar_density", "comfortable"))))
        let lines = next.components(separatedBy: "\n")
        let table = lines.firstIndex(of: "[appearance]")!
        let added = lines.firstIndex(of: #"sidebar_density = "comfortable""#)!
        XCTAssertGreaterThan(added, table)
        XCTAssertLessThan(added, lines.firstIndex(of: "[[agent_profiles]]")!)
    }

    func testRemovesAKeyWithItsOwnLineAndTrailingComment() throws {
        let next = try TomlDocument.update(source, desired: with(document, "appearance", .table(with(appearance, "terminal_font_size", nil))))
        XCTAssertFalse(next.contains("terminal_font_size"))
        XCTAssertFalse(next.contains("# not 14"))
        XCTAssertTrue(next.contains("# I like it small."))
    }

    func testAddsAWholeTableForASectionTheFileDoesNotHave() throws {
        let next = try TomlDocument.update(source, desired: with(document, "general", ["import_login_environment": false]))
        XCTAssertTrue(next.contains("[general]"))
        XCTAssertTrue(next.contains("import_login_environment = false"))
        XCTAssertTomlEqual(try documentOf(next)["general"]!.tableValue!, ["import_login_environment": false])
    }

    func testMatchesArrayOfTablesEntriesByIdNotByPosition() throws {
        let next = try TomlDocument.update(source, desired: with(document, "agent_profiles", [
            .table(profiles[1]), .table(with(profiles[0], "display_name", "Codex CLI")),
        ]))
        XCTAssertTrue(next.contains(#"display_name = "Codex CLI""#))
        XCTAssertTrue(next.contains(#"display_name = "Claude""#))
        XCTAssertEqual(count("[[agent_profiles]]", in: next), 2)
    }

    func testRemovesAnArrayOfTablesEntryWithItsOwnBlockOnly() throws {
        let next = try TomlDocument.update(source, desired: with(document, "agent_profiles", [.table(profiles[0])]))
        XCTAssertEqual(count("[[agent_profiles]]", in: next), 1)
        XCTAssertTrue(next.contains(#"id = "codex""#))
        XCTAssertFalse(next.contains(#"id = "claude""#))
        XCTAssertTrue(next.contains("# I like it small."))
    }

    func testRemovesTheLastEntryOfAOneEntryArrayAndWritesTheEmptyArray() throws {
        let one = [
            "version = 1", "", "# The only profile.", "[[agent_profiles]]", #"id = "codex""#,
            #"display_name = "Codex""#, "[agent_profiles.env]", #"TOKEN = "x""#, "",
        ].joined(separator: "\n")
        let next = try TomlDocument.update(one, desired: with(try documentOf(one), "agent_profiles", []))
        XCTAssertFalse(next.contains("[[agent_profiles]]"))
        XCTAssertFalse(next.contains("[agent_profiles.env]"))
        XCTAssertTrue(next.contains("agent_profiles = []"))
        XCTAssertTomlEqual(try documentOf(next), ["version": 1, "agent_profiles": []])
    }

    func testRemovesTheLastOfTwoEntriesThenReAddsOne() throws {
        let emptied = try TomlDocument.update(source, desired: with(document, "agent_profiles", []))
        XCTAssertFalse(emptied.contains("[[agent_profiles]]"))
        XCTAssertTrue(emptied.contains("agent_profiles = []"))
        XCTAssertTrue(emptied.contains("# I like it small."))
        XCTAssertTrue(emptied.contains("terminal_font_size = 13   # not 14"))
        XCTAssertTomlEqual(try documentOf(emptied), with(document, "agent_profiles", []))

        let refilled = try TomlDocument.update(emptied, desired: with(try documentOf(emptied), "agent_profiles", [.table(profiles[1])]))
        XCTAssertFalse(refilled.contains("agent_profiles = []"))
        XCTAssertEqual(count("[[agent_profiles]]", in: refilled), 1)
        XCTAssertTomlEqual(try documentOf(refilled), with(document, "agent_profiles", [.table(profiles[1])]))
    }

    func testKeepsAnInlineArrayOfTablesInline() throws {
        let inline = "version = 1\nagent_profiles = [ { id = \"codex\" } ]\nworkspace_sources = []\n"
        let next = try TomlDocument.update(inline, desired: with(try documentOf(inline), "agent_profiles", [["id": "codex", "display_name": "Codex"]]))
        XCTAssertEqual(next, "version = 1\nagent_profiles = [ { id = \"codex\", display_name = \"Codex\" } ]\nworkspace_sources = []\n")
    }

    func testAppendsAnArrayOfTablesEntryTheFileDoesNotHave() throws {
        let next = try TomlDocument.update(source, desired: with(document, "agent_profiles", .array(profiles.map { .table($0) } + [
            ["id": "extra", "display_name": "Extra", "kind": "codex"],
        ])))
        XCTAssertEqual(try documentOf(next)["agent_profiles"]?.arrayValue?.count, 3)
        XCTAssertTrue(next.contains(#"id = "extra""#))
    }

    func testKeepsAnInlineTableInline() throws {
        let inline = "version = 1\nappearance = { terminal_font_size = 13 }\n"
        let next = try TomlDocument.update(inline, desired: with(try documentOf(inline), "appearance", ["terminal_font_size": 15]))
        XCTAssertEqual(next, "version = 1\nappearance = { terminal_font_size = 15 }\n")
    }

    func testReplacesATableThatBecameAValueHeadingsAndSubTablesAlike() throws {
        let headed = [
            "[appearance]", "size = 13", "", "[appearance.theme]", "", "[appearance.theme.light]",
            ##"background = "#FFFFFF""##, "", "[appearance.theme.dark]", ##"background = "#000000""##, "",
            "[agents]", "on = true", "",
        ].joined(separator: "\n")
        let next = try TomlDocument.update(headed, desired: ["appearance": ["size": 13, "theme": "vscode"], "agents": ["on": true]])
        XCTAssertEqual(next, "[appearance]\nsize = 13\ntheme = \"vscode\"\n\n[agents]\non = true\n")
        let implied = ["[appearance]", "size = 13", "", "[appearance.theme.light]", ##"background = "#FFFFFF""##, ""].joined(separator: "\n")
        XCTAssertTomlEqual(
            try documentOf(try TomlDocument.update(implied, desired: ["appearance": ["size": 13, "theme": "vscode"]])),
            ["appearance": ["size": 13, "theme": "vscode"]]
        )
    }

    func testLeavesAnEmptySubTablesHeadingToSpellItNotASecondDefinition() throws {
        let withEmptyEnv = [
            "version = 1", "", "[[agent_profiles]]", #"id = "codex""#, #"kind = "codex""#, "", "[agent_profiles.env]", "",
            "[[agent_profiles]]", #"id = "claude""#, #"kind = "claude""#, "", "[agent_profiles.env]", "",
        ].joined(separator: "\n")
        let wanted: TomlValue = [
            ["id": "codex", "kind": "codex", "env": .table(TomlTable())],
            ["id": "claude", "kind": "custom", "command": "my-agent", "env": .table(TomlTable())],
        ]
        let next = try TomlDocument.update(withEmptyEnv, desired: with(try documentOf(withEmptyEnv), "agent_profiles", wanted))
        XCTAssertFalse(next.contains("env = {}"))
        XCTAssertEqual(count("[agent_profiles.env]", in: next), 2)
        XCTAssertTomlEqual(try documentOf(next), ["version": 1, "agent_profiles": wanted])
    }

    func testEmptiesASubTablesContentsAndKeepsItsHeading() throws {
        let withEnv = ["version = 1", "", "[[agent_profiles]]", #"id = "codex""#, "", "[agent_profiles.env]", #"TOKEN = "x""#, ""].joined(separator: "\n")
        let next = try TomlDocument.update(withEnv, desired: with(try documentOf(withEnv), "agent_profiles", [["id": "codex", "env": .table(TomlTable())]]))
        XCTAssertTrue(next.contains("[agent_profiles.env]"))
        XCTAssertFalse(next.contains("env = {}"))
        XCTAssertTomlEqual(try documentOf(next), ["version": 1, "agent_profiles": [["id": "codex", "env": .table(TomlTable())]]])
    }

    func testLeavesAnEmptyTopLevelTablesHeadingAlone() throws {
        let withEmptyGeneral = "version = 1\n\n[general]\n"
        XCTAssertEqual(try TomlDocument.update(withEmptyGeneral, desired: ["version": 1, "general": .table(TomlTable())]), withEmptyGeneral)
    }

    func testWritesAnEmptyTableTheDocumentDoesNotHaveAsItsOwnHeading() throws {
        let next = try TomlDocument.update("version = 1\n", desired: ["version": 1, "general": .table(TomlTable())])
        XCTAssertTrue(next.contains("[general]"))
        XCTAssertFalse(next.contains("general = {}"))
        XCTAssertTomlEqual(try documentOf(next), ["version": 1, "general": .table(TomlTable())])
    }

    func testRewritesAnEmptyInlineTableItWroteItselfAsAHeading() throws {
        let written = "version = 1\n\n[keybindings]\nprefix = \"Cmd+q\"\nchords = {}\n"
        let next = try TomlDocument.update(written, desired: ["version": 1, "keybindings": ["prefix": "Cmd+q", "chords": .table(TomlTable())]])
        XCTAssertFalse(next.contains("chords = {}"))
        XCTAssertTrue(next.contains("[keybindings.chords]"))
        XCTAssertTomlEqual(try documentOf(next), ["version": 1, "keybindings": ["prefix": "Cmd+q", "chords": .table(TomlTable())]])
    }

    func testKeepsAnInlineTableThePersonActuallySpelledInline() throws {
        let chosen = "version = 1\ngeneral = { import_login_environment = true }\n"
        let next = try TomlDocument.update(chosen, desired: ["version": 1, "general": ["import_login_environment": false]])
        XCTAssertTrue(next.contains("general = { import_login_environment = false }"))
        XCTAssertFalse(next.contains("[general]"))
    }

    func testEmptiesAnInlineTableWithoutReSpellingItAsABlock() throws {
        let inlineEnv = "version = 1\nagent_profiles = [ { id = \"codex\" } ]\n"
        let next = try TomlDocument.update(inlineEnv, desired: with(try documentOf(inlineEnv), "agent_profiles", [["id": "codex", "env": .table(TomlTable())]]))
        XCTAssertTomlEqual(try documentOf(next), ["version": 1, "agent_profiles": [["id": "codex", "env": .table(TomlTable())]]])
    }

    func testTakesOutTheBlocksOfAKeyThatIsNoLongerAnArrayOfTables() throws {
        let legacy = ["version = 1", "", "[[agent_actions]]", #"id = "issue_assignment""#, #"template = "mine""#, ""].joined(separator: "\n")
        let wanted: TomlTable = ["version": 1, "agent_actions": ["issue": ["issue_assignment": ["template": "mine"]]]]
        let next = try TomlDocument.update(legacy, desired: wanted)
        XCTAssertFalse(next.contains("[[agent_actions]]"))
        XCTAssertTomlEqual(try documentOf(next), wanted)
    }

    func testRoundTripsWhateverItProduced() throws {
        var nextAppearance = appearance
        nextAppearance["terminal_font_size"] = 15
        nextAppearance["sidebar_density"] = "comfortable"
        var wanted = document
        wanted["appearance"] = .table(nextAppearance)
        wanted["general"] = ["import_login_environment": false]
        XCTAssertTomlEqual(try documentOf(try TomlDocument.update(source, desired: wanted)), wanted)
    }
}

// Port of apps/desktop/src/model/settingsMigration.test.ts
import XCTest
@testable import DevHubCore

final class MergeSettingsTests: XCTestCase {
    func testKeepsWhatOnlyOneSideSays() {
        XCTAssertTomlEqual(SettingsMigration.merge(["a": 1], ["b": 2]), ["a": 1, "b": 2])
    }

    func testGivesTheLocalSideTheLastWord() {
        XCTAssertTomlEqual(SettingsMigration.merge(["a": 1], ["a": 2]), ["a": 2])
    }

    func testMergesTablesKeyByKeyAllTheWayDown() {
        XCTAssertTomlEqual(
            SettingsMigration.merge(
                ["appearance": ["size": 12, "family": "SF Mono", "nested": ["a": 1, "b": 2]]],
                ["appearance": ["size": 20, "nested": ["b": 3]]]
            ),
            ["appearance": ["size": 20, "family": "SF Mono", "nested": ["a": 1, "b": 3]]]
        )
    }

    func testReplacesArraysWholeRatherThanMergingThem() {
        XCTAssertTomlEqual(SettingsMigration.merge(["args": ["a", "b", "c"]], ["args": ["z"]]), ["args": ["z"]])
        XCTAssertTomlEqual(SettingsMigration.merge(["agent_actions": [["id": "a"]]], ["agent_actions": []]), ["agent_actions": []])
    }

    func testLetsEitherSideReplaceATableWithAScalarAndBack() {
        XCTAssertTomlEqual(SettingsMigration.merge(["a": ["b": 1]], ["a": 2]), ["a": 2])
        XCTAssertTomlEqual(SettingsMigration.merge(["a": 2], ["a": ["b": 1]]), ["a": ["b": 1]])
    }

    func testSharesNoObjectWithEitherSide() {
        // Values, not references: changing the merge cannot reach either side.
        let shared: TomlTable = ["appearance": ["size": 12]]
        var merged = SettingsMigration.merge(shared, TomlTable())
        merged["appearance"] = ["size": 99]
        XCTAssertEqual(shared["appearance"]?.tableValue?["size"], 12)
    }
}

final class MigratedTextTests: XCTestCase {
    func testKeepsTheCommentsAndGroupingOfTheFileItWritesOver() throws {
        let text = try SettingsMigration.migratedText(
            shared: "# Do not reformat.\nversion = 1\n\n[appearance]\nterminal_font_size = 12\n",
            local: "[appearance]\nterminal_font_size = 20\n",
            parse: ConfigParsing.parseText
        )
        XCTAssertTrue(text.contains("# Do not reformat."))
        XCTAssertTrue(text.contains("terminal_font_size = 20"))
        XCTAssertFalse(text.contains("terminal_font_size = 12"))
    }

    func testWritesTheLocalFilesWholeWordWhenThereIsNothingToWriteOver() throws {
        let text = try SettingsMigration.migratedText(shared: "", local: "version = 1\n[runtimes]\nshell = \"/bin/bash\"\n", parse: ConfigParsing.parseText)
        XCTAssertTomlEqual(try ConfigParsing.parseText(text), ["version": 1, "runtimes": ["shell": "/bin/bash"]])
    }
}

final class MigrateLocalSettingsTests: ScratchDirectoryTestCase {
    var file: String { Path.join(directory, "settings.toml") }
    var local: String { Path.join(directory, "settings.local.toml") }

    final class Writes { var paths: [String] = [] }

    func migrate(_ writes: Writes) throws -> SettingsMigration.Outcome {
        try SettingsMigration.migrateLocalSettings(sharedPath: file, localPath: local, parse: ConfigParsing.parseText) { path, text in
            writes.paths.append(path)
            try text.write(toFile: path, atomically: false, encoding: .utf8)
        }
    }

    func testDoesNothingWhenTheLocalFileIsAbsent() throws {
        try write(file, "version = 1\n")
        let writes = Writes()
        XCTAssertEqual(try migrate(writes), .nothingToMigrate)
        XCTAssertEqual(writes.paths, [])
        XCTAssertEqual(try read(file), "version = 1\n")
    }

    func testMergesTheLocalFileInAndRenamesItAway() throws {
        try write(file, "version = 1\n[appearance]\nterminal_font_size = 12\nsidebar_density = \"comfortable\"\n")
        try write(local, "[appearance]\nterminal_font_size = 20\n")
        XCTAssertEqual(try migrate(Writes()), .migrated(from: local, to: local + ".migrated"))
        XCTAssertTomlEqual(try ConfigParsing.parseText(read(file)), ["version": 1, "appearance": ["terminal_font_size": 20, "sidebar_density": "comfortable"]])
        XCTAssertFalse(FileSystem.exists(local))
        XCTAssertTrue(try read(local + ".migrated").contains("20"))
    }

    func testLeavesTheLocalFileInPlaceWhenTheWriteFails() throws {
        struct ReadOnly: Error {}
        try write(file, "version = 1\n")
        try write(local, "[appearance]\nterminal_font_size = 20\n")
        XCTAssertThrowsError(try SettingsMigration.migrateLocalSettings(sharedPath: file, localPath: local, parse: ConfigParsing.parseText) { _, _ in
            throw ReadOnly()
        }) { XCTAssertTrue($0 is ReadOnly) }
        XCTAssertTrue(try read(local).contains("20"))
    }

    func testDoesNothingASecondTime() throws {
        try write(file, "version = 1\n")
        try write(local, "[appearance]\nterminal_font_size = 20\n")
        _ = try migrate(Writes())
        let writes = Writes()
        XCTAssertEqual(try migrate(writes), .nothingToMigrate)
        XCTAssertEqual(writes.paths, [])
    }
}

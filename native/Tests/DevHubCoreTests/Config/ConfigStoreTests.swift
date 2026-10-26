// Port of apps/desktop/src/model/config.test.ts — "store", "saving over a
// hand-written file", "the files a configuration can arrive from" and "the
// chords table, written so it can be added to".
import XCTest
@testable import DevHubCore

/// A fresh directory under the system's temporary one, removed in `tearDown`.
class ScratchDirectoryTestCase: XCTestCase {
    var directory = ""

    override func setUpWithError() throws {
        directory = NSTemporaryDirectory() + "devhub-wp1-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        chmod(directory, 0o700)
        try? FileManager.default.removeItem(atPath: directory)
    }

    func write(_ path: String, _ text: String, mode: Int? = nil) throws {
        try text.write(toFile: path, atomically: false, encoding: .utf8)
        if let mode { chmod(path, mode_t(mode)) }
    }

    func read(_ path: String) throws -> String {
        try String(contentsOfFile: path, encoding: .utf8)
    }
}

final class ConfigStoreTests: ScratchDirectoryTestCase {
    var path: String { Path.join(directory, "settings.toml") }
    var paths: ConfigPaths { ConfigPaths(file: path) }

    func testWritesTheDefaultsWhenThereIsNoFileYet() async throws {
        let store = ConfigStore(paths: paths)
        let loaded = try await store.load()
        XCTAssertEqual(loaded.config, Config.defaults)
        XCTAssertEqual(try parseConfig(read(path)), Config.defaults)
    }

    func testReportsAnUnchangedFileWithoutReAdoptingIt() async throws {
        let store = ConfigStore(paths: paths)
        _ = try await store.load()
        guard case .unchanged = try await store.reload() else { return XCTFail("expected unchanged") }
    }

    func testAdoptsAnExternalEditAndReportsItApplied() async throws {
        let store = ConfigStore(paths: paths)
        _ = try await store.load()
        try write(path, "version = 1\n[appearance]\nterminal_font_size = 15\n")
        guard case .applied(let loaded) = try await store.reload() else { return XCTFail("expected applied") }
        XCTAssertEqual(loaded.config.appearance.terminalFontSize, 15)
    }

    func testKeepsTheLastGoodConfigAndRecordsTheDiagnosticWhenTheFileBreaks() async throws {
        let store = ConfigStore(paths: paths)
        let good = try await store.load()
        try write(path, "version = 1\nnonsense = true\n")
        do {
            _ = try await store.reload()
            XCTFail("expected a refusal")
        } catch is ConfigError {}
        let current = await store.current()
        XCTAssertEqual(current, good)
        let diagnostic = await store.lastDiagnostic()
        XCTAssertEqual(diagnostic?.code, .unknownKey)
    }

    func testRecordsTheDiagnosticWhenTheFileIsAlreadyBrokenAtLoad() async throws {
        try write(path, "version = 1\nnonsense = true\n")
        let store = ConfigStore(paths: paths)
        do {
            _ = try await store.load()
            XCTFail("expected a refusal")
        } catch is ConfigError {}
        let diagnostic = await store.lastDiagnostic()
        XCTAssertEqual(diagnostic?.code, .unknownKey)
    }

    func testRefusesASaveOverAFileThatChangedUnderneathIt() async throws {
        let store = ConfigStore(paths: paths)
        let loaded = try await store.load()
        try write(path, "version = 1\n[appearance]\nterminal_font_size = 15\n")
        do {
            _ = try await store.save(expectedRevision: loaded.revision, config: loaded.config)
            XCTFail("expected a conflict")
        } catch let error as ConfigError {
            XCTAssertEqual(error.code, .conflict)
            XCTAssertEqual(error.expectedRevision, loaded.revision)
            XCTAssertNotNil(error.actualRevision)
        }
    }

    func testSavesOverTheRevisionItWasGivenAndReturnsTheNewOne() async throws {
        let store = ConfigStore(paths: paths)
        let loaded = try await store.load()
        var next = loaded.config
        next.appearance.terminalFontSize = 16
        let saved = try await store.save(expectedRevision: loaded.revision, config: next)
        XCTAssertEqual(saved.config.appearance.terminalFontSize, 16)
        let fresh = try await ConfigStore(paths: paths).load()
        XCTAssertEqual(saved.revision, fresh.revision)
    }

    func testSavesOverAFileWrittenInTheOldArrayShape() async throws {
        try write(path, lines("version = 1", "", "[[agent_actions]]", #"id = "issue_assignment""#, #"display_name = "Work on the Issue""#, #"template = "mine, edited""#, ""))
        let store = ConfigStore(paths: paths)
        let loaded = try await store.load()
        let saved = try await store.save(expectedRevision: loaded.revision, config: loaded.config)
        let text = try read(path)
        XCTAssertFalse(text.contains("[[agent_actions]]"))
        XCTAssertTrue(text.contains("[agent_actions.issue.issue_assignment]"))
        XCTAssertEqual(try parseConfig(text).agentActions, saved.config.agentActions)
        XCTAssertTrue(text.contains("order = 0"))
        XCTAssertFalse(text.contains("order = -1"))
    }

    func testResetsASectionBackToTheDefaults() async throws {
        try write(path, lines("version = 1", "", "[appearance]", "terminal_font_size = 19", ""))
        let store = ConfigStore(paths: paths)
        let loaded = try await store.load()
        let reset = try await store.resetScope(expectedRevision: loaded.revision, keys: [.appearance])
        XCTAssertEqual(reset.config.appearance, Config.defaults.appearance)
        XCTAssertFalse(try read(path).contains("= 19"))
    }

    func testLeavesTheSectionsAResetDoesNotNameAlone() async throws {
        try write(path, lines("version = 1", "", "[appearance]", "terminal_font_size = 19", "", "[runtimes]", #"shell = "/bin/bash""#, ""))
        let store = ConfigStore(paths: paths)
        let loaded = try await store.load()
        let reset = try await store.resetScope(expectedRevision: loaded.revision, keys: [.appearance])
        XCTAssertEqual(reset.config.appearance, Config.defaults.appearance)
        XCTAssertEqual(reset.config.runtimes.shell, "/bin/bash")
    }

    func testKeepsTheFilesPermissions() async throws {
        try write(path, "version = 1\n", mode: 0o640)
        let store = ConfigStore(paths: paths)
        let loaded = try await store.load()
        var next = loaded.config
        next.appearance.terminalFontSize = 15
        _ = try await store.save(expectedRevision: loaded.revision, config: next)
        XCTAssertEqual(FileSystem.permissions(path), 0o640)
        // No temporary file is left beside it.
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory), ["settings.toml"])
    }

    func testRefusesAFileThatIsNotUTF8() async throws {
        try Data([0x76, 0x65, 0xFF, 0x0A]).write(to: URL(fileURLWithPath: path))
        do {
            _ = try await ConfigStore(paths: paths).load()
            XCTFail("expected a refusal")
        } catch let error as ConfigError {
            XCTAssertEqual(error.code, .invalidUtf8)
        }
    }

    func testWatchHearsAnEditAndARefusal() async throws {
        let store = ConfigStore(paths: paths)
        _ = try await store.load()
        final class Heard: @unchecked Sendable {
            let lock = NSLock()
            var outcomes: [String] = []
            func add(_ value: String) { lock.lock(); outcomes.append(value); lock.unlock() }
            var all: [String] { lock.lock(); defer { lock.unlock() }; return outcomes }
        }
        let heard = Heard()
        let token = await store.watch(intervalMs: 20) { outcome in
            switch outcome {
            case .success(let loaded): heard.add("applied \(JSString.number(loaded.config.appearance.terminalFontSize))")
            case .failure(let failure): heard.add("refused \(failure.diagnostic.code.rawValue)")
            }
        }
        try write(path, "version = 1\n[appearance]\nterminal_font_size = 15\n")
        for _ in 0..<100 where !heard.all.contains("applied 15") { try await Task.sleep(nanoseconds: 20_000_000) }
        try write(path, "version = 1\nnonsense = 1\n")
        for _ in 0..<100 where !heard.all.contains("refused unknown_key") { try await Task.sleep(nanoseconds: 20_000_000) }
        await store.unwatch(token)
        XCTAssertTrue(heard.all.contains("applied 15"))
        XCTAssertTrue(heard.all.contains("refused unknown_key"))
    }
}

final class ConfigHandWrittenFileTests: ScratchDirectoryTestCase {
    var path: String { Path.join(directory, "settings.toml") }
    var paths: ConfigPaths { ConfigPaths(file: path) }

    func testKeepsTheCommentsGroupingAndOrderThePersonWrote() async throws {
        let handWritten = lines(
            "# My DevHub config. Do not reformat.", "version = 1", "", "# Small on this display.", "[appearance]",
            "terminal_font_size = 13", #"terminal_font_family = "SF Mono""#, "", "[runtimes]", #"shell = "/bin/zsh"   # not fish, on purpose"#, ""
        )
        try write(path, handWritten, mode: 0o600)
        let store = ConfigStore(paths: paths)
        let loaded = try await store.load()
        var next = loaded.config
        next.appearance.terminalFontSize = 15
        _ = try await store.save(expectedRevision: loaded.revision, config: next)

        let saved = try read(path)
        XCTAssertTrue(saved.contains("# My DevHub config. Do not reformat."))
        XCTAssertTrue(saved.contains("# Small on this display."))
        XCTAssertTrue(saved.contains("# not fish, on purpose"))
        XCTAssertTrue(saved.contains("terminal_font_size = 15"))
        XCTAssertTrue(saved.contains(#"terminal_font_family = "SF Mono""#))

        let savedLines = saved.components(separatedBy: "\n")
        let written = handWritten.components(separatedBy: "\n").filter { !$0.isEmpty }
            .map { $0.replacingOccurrences(of: "terminal_font_size = 13", with: "terminal_font_size = 15") }
            .map { $0 == "version = 1" ? "version = \(JSString.number(SCHEMA))" : $0 }
        let positions = written.map { savedLines.firstIndex(of: $0) ?? -1 }
        XCTAssertTrue(positions.allSatisfy { $0 >= 0 }, "\(positions)")
        XCTAssertEqual(positions, positions.sorted())
        XCTAssertTrue(saved.contains(#"terminal_theme = "vscode""#))
        XCTAssertEqual(try parseConfig(saved).appearance.terminalFontSize, 15)
    }

    func testSavesEveryFontFamilySpellingAndKeepsTheCommentsAroundIt() async throws {
        let handWritten = lines("# My DevHub config. Do not reformat.", "version = 1", "", "[appearance]", #"terminal_font_family = "ui-monospace""#, "")
        for family in ["SF Mono", "Menlo", "JetBrains Mono, Menlo, monospace", "\"Fira Code\""] {
            try write(path, handWritten, mode: 0o600)
            let store = ConfigStore(paths: paths)
            let loaded = try await store.load()
            var next = loaded.config
            next.appearance.terminalFontFamily = family
            let saved = try await store.save(expectedRevision: loaded.revision, config: next)
            XCTAssertEqual(saved.config.appearance.terminalFontFamily, family)
            let text = try read(path)
            XCTAssertTrue(text.contains("# My DevHub config. Do not reformat."))
            XCTAssertEqual(try parseConfig(text).appearance.terminalFontFamily, family)
        }
    }
}

final class ConfigArrivalTests: ScratchDirectoryTestCase {
    var paths: ConfigPaths {
        ConfigPaths(file: Path.join(directory, "settings.toml"), local: Path.join(directory, "settings.local.toml"), legacy: Path.join(directory, "config.toml"))
    }

    func testTakesThePreSplitFileOverAsTheSettingsFileOnce() async throws {
        try write(paths.legacy!, "version = 1\n[appearance]\nterminal_font_size = 21\n")
        let loaded = try await ConfigStore(paths: paths).load()
        XCTAssertEqual(loaded.config.appearance.terminalFontSize, 21)
        XCTAssertTrue(try read(paths.file).contains("terminal_font_size = 21"))
        XCTAssertFalse(FileSystem.exists(paths.legacy!))
    }

    func testLeavesThePreSplitFileAloneOnceThereIsASettingsFile() async throws {
        try write(paths.legacy!, "version = 1\n[appearance]\nterminal_font_size = 21\n")
        try write(paths.file, "version = 1\n[appearance]\nterminal_font_size = 9\n")
        let loaded = try await ConfigStore(paths: paths).load()
        XCTAssertEqual(loaded.config.appearance.terminalFontSize, 9)
        XCTAssertTrue(try read(paths.legacy!).contains("21"))
    }

    func testDoesNothingWhenThereIsNoPerMachineFileToFoldIn() async throws {
        try write(paths.file, "version = 1\n[appearance]\nterminal_font_size = 12\n")
        let store = ConfigStore(paths: paths)
        let loaded = try await store.load()
        let migration = await store.lastMigration()
        XCTAssertEqual(migration, .nothingToMigrate)
        XCTAssertEqual(loaded.config.appearance.terminalFontSize, 12)
    }

    func testFoldsThePerMachineFileInAndRenamesItAway() async throws {
        try write(paths.file, "# Mine.\nversion = 1\n[appearance]\nterminal_font_size = 12\nsidebar_density = \"comfortable\"\n")
        try write(paths.local!, "version = 1\n[appearance]\nterminal_font_size = 20\n")
        let store = ConfigStore(paths: paths)
        let loaded = try await store.load()
        let migration = await store.lastMigration()
        XCTAssertEqual(migration, .migrated(from: paths.local!, to: paths.local! + ".migrated"))
        XCTAssertEqual(loaded.config.appearance.terminalFontSize, 20)
        XCTAssertEqual(loaded.config.appearance.sidebarDensity, "comfortable")
        let text = try read(paths.file)
        XCTAssertTrue(text.contains("terminal_font_size = 20"))
        XCTAssertTrue(text.contains("# Mine."))
        XCTAssertFalse(FileSystem.exists(paths.local!))
        XCTAssertTrue(try read(paths.local! + ".migrated").contains("terminal_font_size = 20"))
    }

    func testFoldsAPerMachineFileInWhenThereIsNoSettingsFileAtAll() async throws {
        try write(paths.local!, "version = 1\n[runtimes]\nshell = \"/bin/bash\"\n")
        let loaded = try await ConfigStore(paths: paths).load()
        XCTAssertEqual(loaded.config.runtimes.shell, "/bin/bash")
        XCTAssertTrue(try read(paths.file).contains("/bin/bash"))
    }

    func testFoldsInOnceASecondStartFindsNothingToDo() async throws {
        try write(paths.file, "version = 1\n")
        try write(paths.local!, "version = 1\n[appearance]\nterminal_font_size = 20\n")
        _ = try await ConfigStore(paths: paths).load()
        try write(paths.local! + ".migrated", "version = 1\n[appearance]\nterminal_font_size = 9\n")
        let second = ConfigStore(paths: paths)
        let loaded = try await second.load()
        let migration = await second.lastMigration()
        XCTAssertEqual(migration, .nothingToMigrate)
        XCTAssertEqual(loaded.config.appearance.terminalFontSize, 20)
    }

    func testFailsTheStartWhenTheFoldCannotBeWritten() async throws {
        if getuid() == 0 { throw XCTSkip("root writes into a read-only directory anyway") }
        try write(paths.file, "version = 1\n")
        try write(paths.local!, "version = 1\n")
        chmod(directory, 0o500)
        defer { chmod(directory, 0o700) }
        do {
            _ = try await ConfigStore(paths: paths).load()
            XCTFail("expected the start to fail")
        } catch {}
        chmod(directory, 0o700)
        XCTAssertTrue(try read(paths.local!).contains("version = 1"))
    }

    func testFailsTheStartWhenThePerMachineFileWillNotParse() async throws {
        try write(paths.file, "version = 1\n")
        try write(paths.local!, "this is not = = toml\n")
        do {
            _ = try await ConfigStore(paths: paths).load()
            XCTFail("expected a refusal")
        } catch let error as ConfigError {
            XCTAssertEqual(error.code, .parse)
        }
    }
}

final class ConfigChordsTableTests: ScratchDirectoryTestCase {
    var paths: ConfigPaths { ConfigPaths(file: Path.join(directory, "settings.toml")) }

    func testWritesAHeadingForAnEmptyTableNotAOneLineMarker() async throws {
        let store = ConfigStore(paths: paths)
        let loaded = try await store.load()
        _ = try await store.save(expectedRevision: loaded.revision, config: .defaults)
        let written = try read(paths.file)
        XCTAssertTrue(written.contains("[keybindings.chords]"))
        XCTAssertFalse(written.contains("chords = {}"))
    }

    func testTakesASectionAppendedByHandAndAppliesIt() async throws {
        let store = ConfigStore(paths: paths)
        let first = try await store.load()
        _ = try await store.save(expectedRevision: first.revision, config: .defaults)
        let written = try read(paths.file)
        try write(paths.file, written.replacingOccurrences(of: "[keybindings.chords]", with: "[keybindings.chords]\n\"Shift+n\" = \"previous_workspace\"\ng = \"\""))
        let reloaded = try await ConfigStore(paths: paths).load()
        XCTAssertEqual(reloaded.config.keybindings.chords, ["Shift+n": "previous_workspace", "g": ""])
    }

    func testRewritesAFileTheOldVersionWroteOnTheNextSave() async throws {
        try write(paths.file, "version = 1\n\n[keybindings]\nprefix = \"Cmd+q\"\nchords = {}\n")
        let store = ConfigStore(paths: paths)
        let loaded = try await store.load()
        XCTAssertEqual(loaded.config.keybindings, KeybindingsSpec(prefix: "Cmd+q", chords: [:]))
        _ = try await store.save(expectedRevision: loaded.revision, config: loaded.config)
        let written = try read(paths.file)
        XCTAssertFalse(written.contains("chords = {}"))
        XCTAssertTrue(written.contains("[keybindings.chords]"))
        XCTAssertEqual(try parseConfig(written).keybindings, loaded.config.keybindings)
    }
}

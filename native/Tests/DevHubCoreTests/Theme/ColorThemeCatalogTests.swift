// Port of apps/desktop/src/main/shell/colorThemeCatalog.test.ts, plus the
// vendored built-in themes checked against what the TS catalog and resolver
// make of the same files (Fixtures/theme/builtin-themes.json).

import Foundation
import XCTest
@testable import DevHubCore

final class ColorThemeCatalogTests: XCTestCase {
    private var root = ""

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("devhub-color-themes-\(UUID().uuidString)").path
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(atPath: root)
    }

    private func write(_ path: String, _ content: String) throws {
        try FileManager.default.createDirectory(
            atPath: ThemePath.directoryName(path), withIntermediateDirectories: true)
        try Data(content.utf8).write(to: URL(fileURLWithPath: path))
    }

    private func json(_ object: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self)
    }

    /// An extension contributing `themes`.
    private func makeExtension(_ directory: String, _ themes: [[String: String]], nls: [String: String]? = nil) throws {
        var name = (directory as NSString).lastPathComponent
        if let range = name.range(of: #"-\d.*$"#, options: .regularExpression) { name.removeSubrange(range) }
        try write(Path.join(directory, "package.json"), try json([
            "name": name, "publisher": "test", "contributes": ["themes": themes],
        ] as [String: Any]))
        if let nls { try write(Path.join(directory, "package.nls.json"), try json(nls)) }
    }

    // MARK: JSON with comments

    func testReadsCommentsAndTrailingCommasAndLeavesStringsAlone() {
        let parsed = ColorThemeCatalog.parseJsonc("""
        {
            // a comment
            "a": "http://x//y", /* another */
            "b": [1, 2,],
        }
        """)
        XCTAssertEqual(parsed?.object?["a"], .string("http://x//y"))
        XCTAssertEqual(parsed?.object?["b"], .array([.number(1), .number(2)]))
        XCTAssertEqual(parsed?.object?.keys, ["a", "b"])
        XCTAssertEqual(ColorThemeCatalog.parseJsonc(##"{"a": "q\"//"}"##)?.object?["a"], .string(#"q"//"#))
        XCTAssertNil(ColorThemeCatalog.parseJsonc("{ nope"))
    }

    func testIsJSONParseStrict() {
        XCTAssertNil(ThemeJSONParser.parse("{'a': 1}"))
        XCTAssertNil(ThemeJSONParser.parse("[01]"))
        XCTAssertNil(ThemeJSONParser.parse(#"{"a": 1} x"#))
        XCTAssertNil(ThemeJSONParser.parse("\"tab\there\""))
        XCTAssertEqual(ThemeJSONParser.parse(##"{"a": 1, "a": 2}"##)?.object?["a"], .number(2))
        XCTAssertEqual(ThemeJSONParser.parse(#""é\n""#), .string("é\n"))
        XCTAssertEqual(ThemeJSONParser.parse(" [true, 1, -2.5e1, null] "), .array([.bool(true), .number(1), .number(-25), .null]))
    }

    // MARK: finding a theme

    func testFindsBuiltInAndInstalledThemesByIdByLocalizedLabelIgnoringCase() throws {
        let builtin = Path.join(root, "builtin")
        try makeExtension(Path.join(builtin, "theme-defaults"), [[
            "id": "Visual Studio Dark", "label": "%dark%", "uiTheme": "vs-dark", "path": "./themes/dark.json",
        ]], nls: ["dark": "Dark (Visual Studio)"])
        let user = Path.join(root, "user")
        try makeExtension(Path.join(user, "test.mine-1.0.0"), [["label": "Mine", "uiTheme": "vs", "path": "./mine.json"]])
        let themes = ColorThemeCatalog.list(ExtensionRoots(builtin: builtin, user: user))
        XCTAssertEqual(themes.map(\.settingsId), ["Visual Studio Dark", "Mine"])
        XCTAssertEqual(ColorThemeCatalog.find(themes, "Visual Studio Dark")?.label, "Dark (Visual Studio)")
        XCTAssertEqual(ColorThemeCatalog.find(themes, "Dark (Visual Studio)")?.settingsId, "Visual Studio Dark")
        XCTAssertEqual(ColorThemeCatalog.find(themes, "mine")?.settingsId, "Mine")
        XCTAssertNil(ColorThemeCatalog.find(themes, "Nothing"))
        XCTAssertEqual(themes[0].path, Path.join(builtin, "theme-defaults", "themes", "dark.json"))
        XCTAssertEqual(themes[0].extensionId, "test.theme-defaults")
    }

    func testTakesTheNewestVersionOfAnInstalledExtensionAndSkipsRemovedOnes() throws {
        let user = Path.join(root, "user")
        try makeExtension(Path.join(user, "test.mine-1.9.0"), [["label": "Old", "uiTheme": "vs", "path": "./t.json"]])
        try makeExtension(Path.join(user, "test.mine-1.10.0"), [["label": "New", "uiTheme": "vs", "path": "./t.json"]])
        try makeExtension(Path.join(user, "test.gone-1.0.0"), [["label": "Gone", "uiTheme": "vs", "path": "./t.json"]])
        try write(Path.join(user, ".obsolete"), ##"{"test.gone-1.0.0": true}"##)
        XCTAssertEqual(ColorThemeCatalog.list(ExtensionRoots(builtin: nil, user: user)).map(\.label), ["New"])
    }

    func testIsNothingAtAllWhereThereAreNoExtensions() {
        XCTAssertEqual(ColorThemeCatalog.list(ExtensionRoots(builtin: Path.join(root, "absent"), user: nil as String?)), [])
    }

    func testSearchesEveryUserRootInOrder() throws {
        let devhub = Path.join(root, "devhub")
        let vscode = Path.join(root, "vscode")
        try makeExtension(Path.join(devhub, "a.one-1.0.0"), [["label": "Same", "uiTheme": "vs", "path": "./devhub.json"]])
        try makeExtension(Path.join(vscode, "a.one-2.0.0"), [["label": "Same", "uiTheme": "vs-dark", "path": "./vscode.json"]])
        let themes = ColorThemeCatalog.list(ExtensionRoots(builtin: nil, user: [devhub, vscode]))
        XCTAssertEqual(themes.count, 2)
        XCTAssertEqual(ColorThemeCatalog.find(themes, "Same")?.uiTheme, "vs")
    }

    func testVersionsAndNamesAreReadAsTheTSCatalogReadsThem() {
        XCTAssertGreaterThan(ColorThemeCatalog.compareVersions("1.10.0", "1.9.3"), 0)
        XCTAssertEqual(ColorThemeCatalog.compareVersions("1.0", "1.0.0"), 0)
        XCTAssertLessThan(ColorThemeCatalog.compareVersions("1.0.0-beta", "1.0.1"), 0)
        XCTAssertEqual(ColorThemeCatalog.splitVersion("test.mine-1.10.0")?.key, "test.mine")
        XCTAssertEqual(ColorThemeCatalog.splitVersion("a-b-2.0.0-universal")?.version, "2.0.0-universal")
        XCTAssertEqual(ColorThemeCatalog.splitVersion("a-b-c")?.key, nil)
    }

    // MARK: reading a theme

    private func entry(_ path: String, uiTheme: String = "vs-dark") -> ColorThemeEntry {
        ColorThemeEntry(settingsId: "T", label: "T", id: nil, uiTheme: uiTheme, path: path, extensionId: "test.t")
    }

    func testFoldsInAnIncludeChainTheIncludingFilesColoursWinning() throws {
        try write(Path.join(root, "base.json"), ##"{"colors": {"editor.background": "#000000", "foreground": "#111111"}}"##)
        try write(Path.join(root, "middle.json"), ##"{"include": "./base.json", "colors": {"foreground": "#222222", "sideBar.background": "#333333"}}"##)
        try write(Path.join(root, "top.json"), """
        {
            // VS Code's own themes are JSON with comments
            "include": "./middle.json",
            "colors": {
                "sideBar.background": "default",
                "terminal.ansiRed": "#ff0000",
            },
        }
        """)
        let theme = try ColorThemeCatalog.load(entry(Path.join(root, "top.json"), uiTheme: "vs"))
        XCTAssertEqual(theme.type, .light)
        XCTAssertEqual(theme.colors, [
            "editor.background": "#000000",
            "foreground": "#222222",
            "terminal.ansiRed": "#ff0000",
        ])
    }

    func testSaysWhichFileItCouldNotRead() throws {
        try write(Path.join(root, "loop.json"), ##"{"include": "./loop.json"}"##)
        XCTAssertThrowsError(try ColorThemeCatalog.load(entry(Path.join(root, "loop.json")))) { error in
            XCTAssertTrue(error is ColorThemeUnreadable)
            XCTAssertEqual((error as? ColorThemeUnreadable)?.message,
                           "\(Path.join(root, "loop.json")): its includes go deeper than 16 files.")
        }
        XCTAssertThrowsError(try ColorThemeCatalog.load(entry(Path.join(root, "absent.json")))) { error in
            XCTAssertEqual((error as? ColorThemeUnreadable)?.message, "\(Path.join(root, "absent.json")) could not be read.")
        }
        try write(Path.join(root, "broken.json"), "{ nope")
        XCTAssertThrowsError(try ColorThemeCatalog.load(entry(Path.join(root, "broken.json")))) { error in
            XCTAssertEqual((error as? ColorThemeUnreadable)?.message, "\(Path.join(root, "broken.json")) is not a JSON theme.")
        }
        try write(Path.join(root, "bad-colors.json"), ##"{"colors": ["#fff"]}"##)
        XCTAssertThrowsError(try ColorThemeCatalog.load(entry(Path.join(root, "bad-colors.json")))) { error in
            XCTAssertEqual((error as? ColorThemeUnreadable)?.message, "\(Path.join(root, "bad-colors.json")): 'colors' is not an object.")
        }
    }

    func testTakesATextMateThemeAsItsTypeAlone() throws {
        try write(Path.join(root, "old.tmTheme"), "<plist/>")
        XCTAssertEqual(
            try ColorThemeCatalog.load(entry(Path.join(root, "old.tmTheme"), uiTheme: "vs")),
            ColorThemeDefinition(settingsId: "T", label: "T", type: .light, colors: [:])
        )
    }

    func testFoldsTokenColorsIncludedFirst() throws {
        try write(Path.join(root, "base.json"), ##"{"tokenColors": [{"scope": "comment, string", "settings": {"foreground": "#111111"}}]}"##)
        try write(Path.join(root, "top.json"), ##"{"include": "base.json", "tokenColors": [{"scope": ["keyword"], "settings": {"foreground": "#222222", "fontStyle": "bold"}}, {"settings": {"foreground": "#333333"}}]}"##)
        let rules = try ColorThemeCatalog.loadTokenColors(entry(Path.join(root, "top.json")))
        XCTAssertEqual(rules, [
            TokenColorRule(scopes: ["comment", "string"], foreground: "#111111", background: nil, fontStyle: nil),
            TokenColorRule(scopes: ["keyword"], foreground: "#222222", background: nil, fontStyle: "bold"),
            TokenColorRule(scopes: [], foreground: "#333333", background: nil, fontStyle: nil),
        ])
    }

    func testPathsResolveAsNodeResolvesThem() {
        XCTAssertEqual(ThemePath.resolve("/a/b", "./themes/x.json"), "/a/b/themes/x.json")
        XCTAssertEqual(ThemePath.resolve("/a/b", "../c/./d.json"), "/a/c/d.json")
        XCTAssertEqual(ThemePath.resolve("/a/b", "/abs.json"), "/abs.json")
        XCTAssertEqual(ThemePath.directoryName("/a/b/c.json"), "/a/b")
        XCTAssertEqual(ThemePath.extensionName("/a/b/c.JSON"), ".JSON")
        XCTAssertEqual(ThemePath.extensionName("/a/.json"), "")
        XCTAssertEqual(ThemePath.extensionName("/a/x.tmTheme"), ".tmTheme")
    }
}

/// VS Code's own themes, vendored: every one is found, reads, and resolves to
/// exactly what the TS app resolves from the same files.
final class BuiltinThemeFixtureTests: XCTestCase {
    func testTheVendoredThemesAreThere() throws {
        let builtin = try XCTUnwrap(ColorThemeCatalog.builtinRoot)
        let themes = ColorThemeCatalog.list(ExtensionRoots(builtin: builtin, user: [] as [String]))
        XCTAssertNotNil(ColorThemeCatalog.find(themes, "Dark 2026"))
        XCTAssertNotNil(ColorThemeCatalog.find(themes, "Light 2026"))
        XCTAssertEqual(ColorThemeCatalog.find(themes, "Dark Modern")?.uiTheme, "vs-dark")
        XCTAssertTrue(FileManager.default.fileExists(atPath: Path.join(builtin, "LICENSE.txt")))
    }

    func testEveryBuiltInThemeResolvesAsTheTSAppResolvesIt() throws {
        let builtin = try XCTUnwrap(ColorThemeCatalog.builtinRoot)
        let entries = ColorThemeCatalog.list(ExtensionRoots(builtin: builtin, user: [] as [String]))
        let expected = try ThemeFixtures.builtinThemes()
        XCTAssertEqual(entries.count, 19)
        XCTAssertEqual(entries.map(\.settingsId), expected.map(\.settingsId))
        for (entry, want) in zip(entries, expected) {
            let name = want.settingsId
            XCTAssertEqual(entry.label, want.label, name)
            XCTAssertEqual(entry.id, want.id, name)
            XCTAssertEqual(entry.uiTheme, want.uiTheme, name)
            XCTAssertEqual(entry.extensionId, want.extension, name)
            XCTAssertEqual(String(entry.path.dropFirst(builtin.count + 1)), want.path, name)
            let definition = try ColorThemeCatalog.load(entry)
            XCTAssertEqual(definition.type.rawValue, want.type, name)
            XCTAssertEqual(definition.colors, want.colors, name)
            let resolved = ResolvedColorTheme(definition)
            let shell = ShellPalette(theme: resolved)
            XCTAssertEqual(
                ThemeFixtures.Shell(base: shell.base.rawValue, surface: shell.surface, chrome: shell.chrome, canvas: shell.canvas, ink: shell.ink),
                want.shell, name)
            let terminal = TerminalPalette(theme: resolved)
            XCTAssertEqual(
                ThemeFixtures.Terminal(
                    background: terminal.background, foreground: terminal.foreground, cursor: terminal.cursor,
                    cursorText: terminal.cursorText, selectionBackground: terminal.selectionBackground,
                    selectionForeground: terminal.selectionForeground, ansi: terminal.ansi),
                want.terminal, name)
            XCTAssertTrue(terminal.isValid, name)
            for (id, css) in want.css {
                XCTAssertEqual(resolved.css(id), css, "\(name) \(id)")
            }
            // A theme's code colours read too (the highlighter's).
            _ = try ColorThemeCatalog.loadTokenColors(entry)
        }
    }

    func testTheDefaultThemesCarryTokenColours() throws {
        let builtin = try XCTUnwrap(ColorThemeCatalog.builtinRoot)
        let entries = ColorThemeCatalog.list(ExtensionRoots(builtin: builtin, user: [] as [String]))
        for name in ["Dark+", "Light+", "Dark 2026", "Light 2026"] {
            let entry = try XCTUnwrap(ColorThemeCatalog.find(entries, name))
            let rules = try ColorThemeCatalog.loadTokenColors(entry)
            XCTAssertTrue(rules.contains { $0.scopes.contains("comment") && $0.foreground != nil }, name)
        }
    }
}

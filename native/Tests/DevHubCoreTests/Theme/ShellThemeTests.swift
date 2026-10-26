// Port of apps/desktop/src/main/shell/shellTheme.test.ts and
// apps/desktop/src/main/shell/appearanceMode.test.ts.

import XCTest
@testable import DevHubCore

private let themes: [String: ColorThemeDefinition] = [
    "Dark 2026": ColorThemeDefinition(
        settingsId: "Dark 2026", label: "Dark 2026", type: .dark,
        colors: ["editor.background": "#121314", "sideBar.background": "#191a1b"]),
    "Light 2026": ColorThemeDefinition(
        settingsId: "Light 2026", label: "Light 2026", type: .light,
        colors: ["editor.background": "#ffffff"]),
    "Monokai": ColorThemeDefinition(
        settingsId: "Monokai", label: "Monokai", type: .dark,
        colors: ["editor.background": "#272822", "terminal.ansiRed": "#c4265e"]),
]

private final class Harness {
    var dark = true
    var listings = 0
    var changes = 0
    var theme: ShellTheme!

    init(themes: [String: ColorThemeDefinition] = themes, broken: String? = nil) throws {
        theme = ShellTheme(
            loader: { [unowned self] in
                self.listings += 1
                return { name in
                    if name == broken { throw ColorThemeUnreadable("\(name).json is not a JSON theme.") }
                    return themes[name]
                }
            },
            prefersDark: { [unowned self] in self.dark }
        )
        try theme.onDidChange { [unowned self] in self.changes += 1 }
    }

    func setDark(_ next: Bool) {
        dark = next
        theme.appearanceChanged()
    }
}

final class ShellThemeTests: XCTestCase {
    func testIsVSCodesDefaultForTheAppearanceTheProcessIsIn() throws {
        let h = try Harness()
        XCTAssertEqual(h.theme.palette().surface, "#121314")
        XCTAssertEqual(h.theme.palette().base, .dark)
        XCTAssertEqual(h.theme.wornThemes(), WornColorThemes(dark: "Dark 2026", light: "Light 2026", current: "Dark 2026"))
        h.setDark(false)
        XCTAssertEqual(h.theme.palette().surface, "#ffffff")
        XCTAssertEqual(h.theme.palette().base, .light)
        XCTAssertEqual(h.theme.wornThemes().current, "Light 2026")
        XCTAssertEqual(h.changes, 1)
    }

    func testIsTheOneTheSettingsNameTerminalColoursIncluded() throws {
        let h = try Harness()
        h.theme.configure(ColorThemeNames(dark: "Monokai", light: "Light 2026"))
        XCTAssertEqual(h.changes, 1)
        XCTAssertEqual(h.theme.palette().surface, "#272822")
        XCTAssertEqual(h.theme.terminalPalette().ansi[1], "#c4265e")
        XCTAssertEqual(h.theme.terminalPalette().background, "#272822")
        XCTAssertEqual(h.theme.wornThemes(), WornColorThemes(dark: "Monokai", light: "Light 2026", current: "Monokai"))
        // The same names again change nothing, and say nothing.
        h.theme.configure(ColorThemeNames(dark: "Monokai", light: "Light 2026"))
        XCTAssertEqual(h.changes, 1)
    }

    func testReadsTheInstalledThemesOncePerReadingOfTheNames() throws {
        let h = try Harness()
        let before = h.listings
        h.theme.configure(ColorThemeNames(dark: "Monokai", light: "Light 2026"))
        XCTAssertEqual(h.listings, before + 1)
    }

    func testFallsBackToVSCodesDefaultForANameNothingHasAndSaysSoOnce() throws {
        let h = try Harness()
        _ = h.theme.takeProblems()
        h.theme.configure(ColorThemeNames(dark: "Nope", light: "Light 2026"))
        XCTAssertEqual(h.theme.wornThemes().dark, "Dark 2026")
        XCTAssertEqual(h.theme.takeProblems(), ["No installed colour theme is called 'Nope' (appearance.theme_dark)."])
        h.theme.configure(ColorThemeNames(dark: "Nope", light: "Light 2026"))
        XCTAssertEqual(h.theme.takeProblems(), [])
    }

    func testSaysWhyAThemeThatIsThereCouldNotBeRead() throws {
        let h = try Harness(broken: "Monokai")
        h.theme.configure(ColorThemeNames(dark: "Monokai", light: "Light 2026"))
        XCTAssertEqual(h.theme.takeProblems(), ["Monokai.json is not a JSON theme."])
        XCTAssertEqual(h.theme.wornThemes().dark, "Dark 2026")
    }

    func testIsStillVSCodesColoursWithNoThemeInstalledAtAll() throws {
        let h = try Harness(themes: [:])
        let palette = h.theme.palette()
        // The registry's dark defaults: editor and side bar.
        XCTAssertEqual(palette.surface, "#1e1e1e")
        XCTAssertEqual(palette.chrome, "#252526")
        XCTAssertEqual(h.theme.wornThemes().dark, "Dark 2026")
        XCTAssertEqual(h.theme.takeProblems(), [
            "No installed colour theme is called 'Dark 2026' (appearance.theme_dark).",
            "No installed colour theme is called 'Light 2026' (appearance.theme_light).",
        ])
    }

    func testRefusesASecondListener() throws {
        let h = try Harness()
        XCTAssertThrowsError(try h.theme.onDidChange {}) { error in
            XCTAssertEqual((error as? ThemeInvariantViolation)?.message, "the shell theme already has a listener")
        }
    }

    /// The real thing, with no VS Code installed: the vendored themes.
    func testWearsDark2026AndLight2026FromTheVendoredThemes() throws {
        var dark = true
        let roots = ExtensionRoots(builtin: ColorThemeCatalog.builtinRoot, user: [] as [String])
        let theme = ShellTheme(roots: { roots }, prefersDark: { dark })
        XCTAssertEqual(theme.takeProblems(), [])
        let expected = try ThemeFixtures.builtinThemes()
        let dark2026 = try XCTUnwrap(expected.first { $0.settingsId == "Dark 2026" })
        let light2026 = try XCTUnwrap(expected.first { $0.settingsId == "Light 2026" })
        XCTAssertEqual(theme.palette().surface, dark2026.shell.surface)
        XCTAssertEqual(theme.palette().chrome, dark2026.shell.chrome)
        XCTAssertEqual(theme.terminalPalette().ansi, dark2026.terminal.ansi)
        dark = false
        theme.appearanceChanged()
        XCTAssertEqual(theme.palette().canvas, light2026.shell.canvas)
        XCTAssertEqual(theme.terminalPalette().background, light2026.terminal.background)
        XCTAssertEqual(theme.wornThemes().current, "Light 2026")
        XCTAssertEqual(theme.tokens().base, .light)
    }
}

/// The writer the app hands over, and a record of what it was told.
private final class SourceWriter {
    var written: [String] = []
    func write(_ source: AppearanceSource) { written.append(source.rawValue) }
}

final class AppearanceModeTests: XCTestCase {
    func testStartsByReportingTheOSBeforeAnyConfigHasBeenRead() throws {
        // `auto` is the default, and until the config is read it is also the
        // only honest answer: DevHub has not been told to overrule anything yet.
        let mode = AppearanceMode()
        let writer = SourceWriter()
        try mode.own(writer.write)
        XCTAssertEqual(writer.written, ["system"])
        XCTAssertEqual(mode.current(), "auto")
    }

    func testMapsEachAppearanceOntoWhatTheApplicationUnderstands() throws {
        let mode = AppearanceMode()
        let writer = SourceWriter()
        try mode.own(writer.write)
        try mode.apply("dark")
        try mode.apply("light")
        try mode.apply("auto")
        // 'system' is the value that makes the application report the real OS,
        // so it is what `auto` has to mean — anything else would pin it.
        XCTAssertEqual(writer.written, ["system", "dark", "light", "system"])
    }

    func testWritesOnEveryChangeSoASavedSettingNeedsNoRestart() throws {
        let mode = AppearanceMode()
        let writer = SourceWriter()
        try mode.own(writer.write)
        try mode.apply("dark")
        XCTAssertEqual(writer.written, ["system", "dark"])
        XCTAssertEqual(mode.current(), "dark")
    }

    func testAppliesTheConfigItWasGivenTheMomentItTakesOwnership() throws {
        // Ordering insurance: an appearance silently dropped because it arrived
        // early would be invisible.
        let mode = AppearanceMode()
        try mode.apply("dark")
        let writer = SourceWriter()
        try mode.own(writer.write)
        XCTAssertEqual(writer.written, ["dark"])
    }

    func testRefusesAnAppearanceItHasNoAnswerFor() throws {
        let mode = AppearanceMode()
        try mode.own(SourceWriter().write)
        XCTAssertThrowsError(try mode.apply("midnight")) { error in
            XCTAssertTrue(String(describing: error).contains("no appearance called"))
        }
    }

    func testRefusesASecondOwner() throws {
        let mode = AppearanceMode()
        try mode.own(SourceWriter().write)
        XCTAssertThrowsError(try mode.own(SourceWriter().write)) { error in
            XCTAssertTrue(String(describing: error).contains("already has an owner"))
        }
    }

    func testPrefersDarkFollowsTheOSOnlyInAuto() throws {
        let mode = AppearanceMode()
        XCTAssertTrue(mode.prefersDark(systemIsDark: true))
        XCTAssertFalse(mode.prefersDark(systemIsDark: false))
        try mode.apply("dark")
        XCTAssertTrue(mode.prefersDark(systemIsDark: false))
        try mode.apply("light")
        XCTAssertFalse(mode.prefersDark(systemIsDark: true))
        XCTAssertEqual(AppearanceMode.modes, ["auto", "light", "dark"])
    }
}

final class AppearanceSettingsTests: XCTestCase {
    func testTheDefaultSettingsWearVSCodesDefaults() {
        let appearance = AppearanceConfig()
        XCTAssertEqual(ColorThemeNames(appearance: appearance), .defaults)
        XCTAssertEqual(DevHubTheme.TitleBar(setting: appearance.titleBar), .shown)
        XCTAssertEqual(DevHubTheme.TitleBar(setting: "hidden"), .hidden)
        XCTAssertEqual(DevHubTheme.Density(setting: appearance.sidebarDensity), .compact)
        let terminal = TerminalAppearance(appearance: appearance, fromVSCode: nil)
        XCTAssertTrue(terminal.isValid)
        XCTAssertEqual(terminal.theme, .defaults)
        XCTAssertEqual(terminal.fontSize, 13)
    }

    func testFollowingTheThemeGivesTheWornThemesTerminal() {
        var dark = true
        let theme = ShellTheme(
            roots: { ExtensionRoots(builtin: ColorThemeCatalog.builtinRoot, user: [String]()) },
            prefersDark: { dark }
        )
        var appearance = AppearanceConfig()
        appearance.themeDark = "Monokai"
        theme.configure(appearance: appearance)
        XCTAssertEqual(theme.takeProblems(), [])
        let terminal = TerminalAppearance(appearance: appearance, fromVSCode: theme.terminalPalette())
        XCTAssertEqual(terminal.theme.dark.background, "#272822")
        XCTAssertEqual(terminal.theme.light, terminal.theme.dark)
        dark = false
        theme.appearanceChanged()
        XCTAssertEqual(theme.wornThemes().current, "Light 2026")
    }
}

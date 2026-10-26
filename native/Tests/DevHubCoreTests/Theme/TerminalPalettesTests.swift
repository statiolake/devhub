// Port of the terminal-palette parts of apps/desktop/src/model/wire.ts
// (`terminalThemeWire`, `terminalPaletteIsValid`) and of
// apps/desktop/src/ipc/palette.ts (`isPaletteColor`, `scrimColor`).

import XCTest
@testable import DevHubCore

final class TerminalPalettesTests: XCTestCase {
    func testBuiltInPalettesAreValid() {
        XCTAssertTrue(TerminalPalette.defaultLight.isValid)
        XCTAssertTrue(TerminalPalette.defaultDark.isValid)
        XCTAssertEqual(TerminalPalette.defaultDark.background, "#121314")
        XCTAssertEqual(TerminalPalette.defaultLight.ansi[6], "#0069CC")
    }

    func testAPaletteNeedsSixteenColoursAndColoursOnly() {
        var palette = TerminalPalette.defaultDark
        palette.ansi.removeLast()
        XCTAssertFalse(palette.isValid)
        palette = .defaultDark
        palette.selectionForeground = nil
        XCTAssertTrue(palette.isValid)
        palette.cursor = "red"
        XCTAssertFalse(palette.isValid)
    }

    func testFollowingTheThemeWearsItsColoursInBothSchemes() {
        var theme = TerminalPalette.defaultDark
        theme.background = "#272822"
        let palettes = terminalPalettes(for: .vscode, fromVSCode: theme)
        XCTAssertEqual(palettes.light, theme)
        XCTAssertEqual(palettes.dark, theme)
        XCTAssertEqual(terminalPalettes(for: .vscode, fromVSCode: nil), .defaults)
        let own = TerminalPalettes(light: .defaultDark, dark: .defaultLight)
        XCTAssertEqual(terminalPalettes(for: .palettes(own), fromVSCode: theme), own)
        XCTAssertEqual(own.palette(dark: true), .defaultLight)
    }
}

final class ShellPaletteColorTests: XCTestCase {
    func testOnlyPlainColoursArePaletteColours() {
        for good in ["#abc", "#aabbcc", "#aabbcc80", "#ABCDEF12", "rgba(0, 0, 0, 0.5)", "rgb(1,2,3)", "rgba(10% 20% 30% / 0.5)"] {
            XCTAssertTrue(ShellPalette.isPaletteColor(good), good)
        }
        for bad in ["", "#ab", "#123456789", "#ggg", "red", "rgba()", "rgba(0,0,0);x", "rgba(0, 0, 0, 0.5) ", "url(x)", "rgb(a)"] {
            XCTAssertFalse(ShellPalette.isPaletteColor(bad), bad)
        }
    }

    func testScrimIsTheMacSheetDim() {
        XCTAssertEqual(ShellPalette.scrimColor(base: .dark, reducedTransparency: false), "rgba(0, 0, 0, 0.42)")
        XCTAssertEqual(ShellPalette.scrimColor(base: .light, reducedTransparency: false), "rgba(0, 0, 0, 0.16)")
        XCTAssertEqual(ShellPalette.scrimColor(base: .dark, reducedTransparency: true), "rgba(0, 0, 0, 0.6)")
        XCTAssertEqual(ShellPalette.scrimColor(base: .light, reducedTransparency: true), "rgba(0, 0, 0, 0.35)")
    }
}

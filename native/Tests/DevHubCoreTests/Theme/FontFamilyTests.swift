// Port of apps/desktop/src/shell/terminal/theme.test.ts (font stack) and the
// font-family rule of apps/desktop/src/model/fontFamily.ts.

import XCTest
@testable import DevHubCore

final class TerminalFontStackTests: XCTestCase {
    /// The families `terminalFontStack` appends behind whatever was chosen.
    let fallbacks = #"ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace"#

    func testEndsInTheMonospaceGeneric() {
        XCTAssertEqual(TerminalFontStack.css(nil), fallbacks)
        XCTAssertEqual(TerminalFontStack.css(""), fallbacks)
        XCTAssertEqual(TerminalFontStack.css("   "), fallbacks)
    }

    func testKeepsTheChosenFamiliesFirst() {
        XCTAssertEqual(
            TerminalFontStack.css("Menlo, Monaco"),
            #"Menlo, Monaco, ui-monospace, SFMono-Regular, "SF Mono", monospace"#
        )
    }

    func testRequotesANameThatIsNotAnIdentifier() {
        XCTAssertEqual(
            TerminalFontStack.css("SF Mono"),
            #""SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace"#
        )
    }

    func testStripsTheQuotesAViewerWrote() {
        let single = TerminalFontStack.css("'SauceCodePro Nerd Font Mono', 'Hiragino Sans W3'")
        let double = TerminalFontStack.css(#""SauceCodePro Nerd Font Mono", "Hiragino Sans W3""#)
        XCTAssertEqual(single, #""SauceCodePro Nerd Font Mono", "Hiragino Sans W3", "# + fallbacks)
        XCTAssertEqual(double, single)
        XCTAssertEqual(
            TerminalFontStack.families("'SauceCodePro Nerd Font Mono'").first,
            "SauceCodePro Nerd Font Mono"
        )
    }

    func testLeavesAGenericUnquoted() {
        XCTAssertEqual(
            TerminalFontStack.css("monospace"),
            #"monospace, ui-monospace, SFMono-Regular, "SF Mono", Menlo"#
        )
        XCTAssertEqual(TerminalFontStack.css("system-ui"), "system-ui, " + fallbacks)
    }

    func testDoesNotRepeatAFallbackWhateverItsCase() {
        XCTAssertEqual(
            TerminalFontStack.css("menlo"),
            #"menlo, ui-monospace, SFMono-Regular, "SF Mono", monospace"#
        )
    }

    func testDropsEmptyEntries() {
        XCTAssertEqual(
            TerminalFontStack.css("Menlo,, ,"),
            #"Menlo, ui-monospace, SFMono-Regular, "SF Mono", monospace"#
        )
    }

    func testUnescapesAQuotedName() {
        XCTAssertEqual(TerminalFontStack.css(#""My\"Font""#), #""MyFont", "# + fallbacks)
    }

    func testDefaultIsTheCSSFontMono() {
        // tokens.css `--font-mono` is `terminalFontStack` at the default.
        XCTAssertEqual(
            TerminalFontStack.css(TerminalFontStack.defaultFamily),
            #"ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace"#
        )
    }

    func testResolvesToTheFirstInstalledFamilyLikeCSS() {
        let installed: Set<String> = ["Menlo", "JetBrains Mono"]
        XCTAssertEqual(
            TerminalFontStack.resolve("Nope, JetBrains Mono", isInstalled: installed.contains),
            .family("JetBrains Mono")
        )
        XCTAssertEqual(TerminalFontStack.resolve("Nope", isInstalled: installed.contains), .systemMonospace)
        XCTAssertEqual(TerminalFontStack.resolve(nil, isInstalled: installed.contains), .systemMonospace)
        XCTAssertEqual(TerminalFontStack.resolve("Menlo", isInstalled: installed.contains), .family("Menlo"))
        XCTAssertEqual(TerminalFontStack.resolve("system-ui", isInstalled: installed.contains), .generic("system-ui"))
        XCTAssertEqual(TerminalFontStack.resolve("'Menlo'", isInstalled: installed.contains), .family("Menlo"))
    }
}

final class FontFamilyRuleTests: XCTestCase {
    func testAcceptsOrdinaryValues() {
        for value in ["Menlo", "SF Mono", #""Fira Code""#, "JetBrains Mono, Menlo, monospace"] {
            XCTAssertTrue(FontFamily.isValid(value), value)
        }
    }

    func testRefusesNothingControlCharactersAndLength() {
        XCTAssertFalse(FontFamily.isValid(""))
        XCTAssertFalse(FontFamily.isValid("  \t "))
        XCTAssertFalse(FontFamily.isValid("Menlo\n"))
        XCTAssertFalse(FontFamily.isValid("Me\u{7f}nlo"))
        XCTAssertTrue(FontFamily.isValid(String(repeating: "a", count: 128)))
        XCTAssertFalse(FontFamily.isValid(String(repeating: "a", count: 129)))
        // Counted in code points, as `[...value]` counts.
        XCTAssertTrue(FontFamily.isValid(String(repeating: "😀", count: 128)))
    }

    func testTheRuleSaysTheLimit() {
        XCTAssertTrue(FontFamily.rule.hasSuffix("is at most 128 characters."))
    }
}

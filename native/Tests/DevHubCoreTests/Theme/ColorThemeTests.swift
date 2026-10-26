// Port of apps/desktop/src/model/colorTheme.test.ts and
// apps/desktop/src/model/colorDefaults.test.ts, plus fixture checks against
// what the TS implementation computes (Fixtures/theme, see ThemeFixtures).

import XCTest
@testable import DevHubCore

private func theme(_ type: ColorThemeType, _ colors: [String: String] = [:]) -> ColorThemeDefinition {
    ColorThemeDefinition(settingsId: "Test", label: "Test", type: type, colors: colors)
}

final class ThemeColorTests: XCTestCase {
    func testParsesEveryHexFormAndAnUnparsableOneIsRed() {
        XCTAssertEqual(ThemeColor.fromHex("#1f1f1f").description, "#1f1f1f")
        XCTAssertEqual(ThemeColor.fromHex("#abc").description, "#aabbcc")
        XCTAssertEqual(ThemeColor.fromHex("#00000080").description, "rgba(0, 0, 0, 0.5)")
        XCTAssertEqual(ThemeColor.fromHex("#fff8").description, "rgba(255, 255, 255, 0.53)")
        XCTAssertEqual(ThemeColor.fromHex("blue").description, "#ff0000")
    }

    func testTransformsTheWayTheRegistrysTransformsDo() {
        let grey = ThemeColor.fromHex("#808080")
        XCTAssertEqual(grey.transparent(0.5).description, "rgba(128, 128, 128, 0.5)")
        XCTAssertEqual(grey.darken(0.5).description, "#404040")
        XCTAssertEqual(grey.lighten(0.5).description, "#c0c0c0")
        XCTAssertEqual(ThemeColor.fromHex("#ffffff80").makeOpaque(.fromHex("#000000")).description, "#808080")
        XCTAssertEqual(ThemeColor.fromHex("#000000").mix(.fromHex("#ffffff")).description, "#7f7f7f")
    }

    func testJavaScriptRoundingIsKept() {
        XCTAssertEqual(JSNumber.round(2.5), 3)
        XCTAssertEqual(JSNumber.round(-2.5), -2)
        XCTAssertEqual(JSNumber.round(0.49999999999999994), 0)
        XCTAssertEqual(JSNumber.fixed2(0.125), "0.13")
        XCTAssertEqual(JSNumber.fixed2(0.5), "0.5")
        XCTAssertEqual(JSNumber.fixed2(0), "0")
        XCTAssertEqual(JSNumber.fixed2(0.995), "0.99") // 0.995 is a hair under, as a double
        XCTAssertEqual(JSNumber.fixed2(0.105), "0.1")
        XCTAssertEqual(JSNumber.int32(254.9), 254)
        XCTAssertEqual(JSNumber.int32(.nan), 0)
    }

    func testEveryHexFormMatchesTS() throws {
        for item in try ThemeFixtures.colorMath().hex {
            XCTAssertEqual(ThemeColor.fromHex(item.text).description, item.toString, item.text)
        }
    }

    /// 800 colours, every operation, against what the TS port of VS Code's
    /// `Color` answers.
    func testColourArithmeticMatchesTS() throws {
        let math = try ThemeFixtures.colorMath()
        XCTAssertEqual(math.cases.count, 800)
        for item in math.cases {
            let a = ThemeColor.fromHex(item.a)
            let b = ThemeColor.fromHex(item.b)
            let f = item.f
            let label = "\(item.a) \(item.b) \(f)"
            XCTAssertEqual(a.description, item.toString, label)
            XCTAssertEqual(a.relativeLuminance(), item.luminance, label)
            XCTAssertEqual(a.lighten(f).description, item.lighten, label)
            XCTAssertEqual(a.darken(f).description, item.darken, label)
            XCTAssertEqual(a.lighten(f).darken(f / 2).transparent(0.8).description, item.lightenDarken, label)
            XCTAssertEqual(a.transparent(f).description, item.transparent, label)
            XCTAssertEqual(a.mix(b, f).description, item.mix, label)
            XCTAssertEqual(a.mix(b).description, item.mixDefault, label)
            XCTAssertEqual(a.makeOpaque(b).description, item.opaque, label)
            XCTAssertEqual(ThemeColor.lighterColor(a, b, f).description, item.lighter, label)
            XCTAssertEqual(ThemeColor.darkerColor(a, b, f).description, item.darker, label)
            XCTAssertEqual(ThemeColor.lighterColor(a, b).description, item.lighterDefault, label)
            XCTAssertEqual(ThemeColor.darkerColor(a, b).description, item.darkerDefault, label)
        }
    }

    func testParsesFunctionalColours() {
        XCTAssertEqual(ThemeColor.parse("rgba(0, 105, 204, 0.15)")?.description, "rgba(0, 105, 204, 0.15)")
        XCTAssertEqual(ThemeColor.parse("rgb(1, 2, 3)")?.description, "#010203")
        XCTAssertEqual(ThemeColor.parse("rgba(100% 0% 0% / 50%)")?.description, "rgba(255, 0, 0, 0.5)")
        XCTAssertNil(ThemeColor.parse("rgba(1, 2)"))
        XCTAssertNil(ThemeColor.parse("red"))
    }
}

final class ResolvedColorThemeTests: XCTestCase {
    func testAreTheThemesOwnWhereItSetsThem() {
        let resolved = ResolvedColorTheme(theme(.dark, ["editor.background": "#123456"]))
        XCTAssertEqual(resolved.css("editor.background"), "#123456")
        XCTAssertTrue(resolved.defines("editor.background"))
    }

    func testAreTheRegistrysDefaultForTheThemesTypeWhereItDoesNot() {
        for type in ColorThemeType.allCases {
            let resolved = ResolvedColorTheme(theme(type))
            guard case .hex(let literal)? = ColorDefaults.table["terminal.ansiRed"]?[type] else {
                return XCTFail("terminal.ansiRed has no literal default for \(type)")
            }
            XCTAssertEqual(resolved.css("terminal.ansiRed"), ThemeColor.fromHex(literal).description)
        }
        XCTAssertEqual(ResolvedColorTheme(theme(.dark)).css("foreground"), "#cccccc")
        XCTAssertEqual(ResolvedColorTheme(theme(.light)).css("foreground"), "#616161")
    }

    func testFollowADefaultThatRefersToAnotherColourThroughTheTheme() {
        // terminal.selectionBackground's default is editor.selectionBackground.
        let resolved = ResolvedColorTheme(theme(.dark, ["editor.selectionBackground": "#abcdef"]))
        XCTAssertEqual(resolved.css("terminal.selectionBackground"), "#abcdef")
    }

    func testHaveNoColourWhereNeitherTheThemeNorTheRegistryGivesOne() {
        XCTAssertNil(ResolvedColorTheme(theme(.dark)).css("terminal.background"))
    }

    func testEvaluateEveryTransformADefaultCanBe() {
        func everywhere(_ value: ColorValue) -> [ColorThemeType: ColorValue] {
            Dictionary(uniqueKeysWithValues: ColorThemeType.allCases.map { ($0, value) })
        }
        let table: ColorDefaultsTable = [
            "base": everywhere(.hex("#808080")),
            "dark": everywhere(.darken(.ref("base"), factor: 0.5)),
            "clear": everywhere(.transparent(.ref("base"), factor: 0.5)),
            "firstSet": everywhere(.oneOf([.ref("unset"), .ref("base")])),
            "picked": everywhere(.ifDefinedThenElse("own", then: .hex("#111111"), else: .hex("#222222"))),
            "flat": everywhere(.opaque(.ref("clear"), background: .hex("#000000"))),
            "loop": everywhere(.ref("loop")),
        ]
        let plain = ResolvedColorTheme(theme(.dark), defaults: table)
        XCTAssertEqual(plain.css("dark"), "#404040")
        XCTAssertEqual(plain.css("clear"), "rgba(128, 128, 128, 0.5)")
        XCTAssertEqual(plain.css("firstSet"), "#808080")
        XCTAssertEqual(plain.css("picked"), "#222222")
        XCTAssertEqual(plain.css("flat"), "#404040")
        XCTAssertNil(plain.css("loop"))
        let own = ResolvedColorTheme(theme(.dark, ["own": "#ffffff"]), defaults: table)
        XCTAssertEqual(own.css("picked"), "#111111")
    }

    /// A synthetic registry with every transform, nested and through
    /// references and cycles, under each type: as TS resolves it.
    func testEveryTransformResolvesAsTSResolvesIt() throws {
        let text = String(decoding: try ThemeFixtures.data("registry.json"), as: UTF8.self)
        guard let root = ThemeJSONParser.parse(text)?.object,
              let tableJSON = root["table"]?.object,
              let cases = root["cases"]?.array
        else { return XCTFail("registry.json does not read") }
        var table: ColorDefaultsTable = [:]
        for (id, perType) in tableJSON.entries {
            var values: [ColorThemeType: ColorValue] = [:]
            for type in ColorThemeType.allCases {
                values[type] = try colorValue(perType.object?[type.rawValue] ?? .null)
            }
            table[id] = values
        }
        XCTAssertEqual(cases.count, 8)
        for item in cases {
            guard let fields = item.object,
                  let type = fields["type"]?.string.flatMap(ColorThemeType.init(rawValue:)),
                  let colorsJSON = fields["colors"]?.object,
                  let css = fields["css"]?.object
            else { return XCTFail("a case does not read") }
            var colors: [String: String] = [:]
            for (id, value) in colorsJSON.entries { colors[id] = value.string }
            let resolved = ResolvedColorTheme(theme(type, colors), defaults: table)
            for (id, expected) in css.entries {
                XCTAssertEqual(resolved.css(id), expected.string, "\(type) \(colors) \(id)")
            }
        }
    }

    private struct BadValue: Error {}

    private func colorValue(_ json: ThemeJSONValue) throws -> ColorValue {
        switch json {
        case .null: return .none
        case .string(let text): return .string(text)
        case .object(let object):
            if let rgba = object["rgba"]?.array {
                let n = rgba.compactMap { value -> Double? in
                    if case .number(let number) = value { return number }
                    return nil
                }
                guard n.count == 4 else { throw BadValue() }
                return .rgba(n[0], n[1], n[2], n[3])
            }
            func number(_ key: String) throws -> Double {
                guard case .number(let value)? = object[key] else { throw BadValue() }
                return value
            }
            func inner(_ key: String) throws -> ColorValue { try colorValue(object[key] ?? .null) }
            switch object["op"]?.string {
            case "darken": return .darken(try inner("value"), factor: try number("factor"))
            case "lighten": return .lighten(try inner("value"), factor: try number("factor"))
            case "transparent": return .transparent(try inner("value"), factor: try number("factor"))
            case "opaque": return .opaque(try inner("value"), background: try inner("background"))
            case "oneOf": return .oneOf(try (object["values"]?.array ?? []).map(colorValue))
            case "lessProminent":
                return .lessProminent(try inner("value"), background: try inner("background"),
                                      factor: try number("factor"), transparency: try number("transparency"))
            case "ifDefinedThenElse":
                return .ifDefinedThenElse(object["if"]?.string ?? "", then: try inner("then"), else: try inner("else"))
            case "mix":
                return .mix(try inner("color"), with: try inner("with"), ratio: object["ratio"] == nil ? nil : try number("ratio"))
            default: throw BadValue()
            }
        default: throw BadValue()
        }
    }
}

final class ThemePaintingTests: XCTestCase {
    func testIsTheFourAnchorsTheWindowSplashCarries() {
        let palette = ShellPalette(theme: ResolvedColorTheme(theme(.dark, [
            "editor.background": "#1f1f1f",
            "sideBar.background": "#181818",
            "titleBar.activeBackground": "#18181880",
            "foreground": "#cccccc",
        ])))
        XCTAssertEqual(palette, ShellPalette(
            base: .dark,
            surface: "#1f1f1f",
            chrome: "#181818",
            // Made opaque over the workbench background, as the splash does.
            canvas: "#1e1e1e",
            ink: "#cccccc"
        ))
    }

    func testIsAWholePaletteEvenForAThemeThatSetsNothing() {
        for type in ColorThemeType.allCases {
            let resolved = ResolvedColorTheme(theme(type))
            let palette = ShellPalette(theme: resolved)
            XCTAssertEqual(palette.base, type == .light || type == .hcLight ? .light : .dark)
            for color in [palette.surface, palette.chrome, palette.canvas, palette.ink] {
                XCTAssertTrue(ShellPalette.isPaletteColor(color), color)
            }
            XCTAssertTrue(TerminalPalette(theme: resolved).isValid)
        }
    }

    func testGivesTheTerminalVSCodesFallbacks() {
        let palette = TerminalPalette(theme: ResolvedColorTheme(theme(.dark, [
            "editor.background": "#1f1f1f",
            "terminal.foreground": "#dddddd",
        ])))
        XCTAssertEqual(palette.background, "#1f1f1f")
        XCTAssertEqual(palette.cursor, "#dddddd")
        XCTAssertEqual(palette.cursorText, "#1f1f1f")
        XCTAssertNil(palette.selectionForeground)
        XCTAssertEqual(palette.ansi.count, 16)
    }

    func testTheThemeTypeIsTheContributionsUiThemeDarkWhenItSaysNothing() {
        XCTAssertEqual(ColorThemeType(uiTheme: "vs"), .light)
        XCTAssertEqual(ColorThemeType(uiTheme: "vs-dark"), .dark)
        XCTAssertEqual(ColorThemeType(uiTheme: "hc-black"), .hcDark)
        XCTAssertEqual(ColorThemeType(uiTheme: "hc-light"), .hcLight)
        XCTAssertEqual(ColorThemeType(uiTheme: nil), .dark)
    }
}

final class ColorDefaultsTests: XCTestCase {
    func testHaveEveryColourDevHubReads() {
        for id in ColorIds.all {
            XCTAssertNotNil(ColorDefaults.table[id], id)
            XCTAssertEqual(ColorDefaults.table[id]?.count, 4, id)
        }
        XCTAssertEqual(ColorIds.all.count, 26)
    }

    /// The table is the TS one: every id the TS fixtures resolved is here,
    /// and nothing else.
    func testAreTheTSTable() throws {
        let fixture = try ThemeFixtures.builtinThemes()
        let ids = Set(fixture[0].css.keys)
        XCTAssertEqual(Set(ColorDefaults.table.keys).union(ColorIds.all), ids)
    }

    /// Every reference in the table resolves to an id the table has, so no
    /// default silently means "no colour" by a typo.
    func testEveryReferenceIsInTheTable() {
        func references(_ value: ColorValue) -> [String] {
            switch value {
            case .none, .hex, .rgba: return []
            case .ref(let id): return [id]
            case .darken(let v, _), .lighten(let v, _), .transparent(let v, _): return references(v)
            case .opaque(let v, let b): return references(v) + references(b)
            case .oneOf(let values): return values.flatMap(references)
            case .lessProminent(let v, let b, _, _): return references(v) + references(b)
            case .ifDefinedThenElse(let id, let t, let e): return [id] + references(t) + references(e)
            case .mix(let c, let w, _): return references(c) + references(w)
            }
        }
        for (id, perType) in ColorDefaults.table {
            for value in perType.values {
                for reference in references(value) {
                    XCTAssertNotNil(ColorDefaults.table[reference], "\(id) → \(reference)")
                }
            }
        }
    }
}

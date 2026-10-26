// Tests of DevHubTheme: every custom property of
// apps/desktop/src/shell/styles/tokens.css, derived from a palette the way the
// stylesheet derives it; and of TerminalAppearance
// (apps/desktop/src/shell/terminal/theme.test.ts, `terminalSurfaceStyle`).

import XCTest
@testable import DevHubCore

final class DevHubThemeTests: XCTestCase {
    /// Every custom property tokens.css declares.
    static let tokensCSS: Set<String> = [
        "--accent", "--accent-ink", "--canvas", "--chrome", "--danger", "--disabled-ink", "--focus-ring",
        "--font-mono", "--ink-line", "--ink-line-soft", "--ink-line-strong", "--ink-scrollbar",
        "--ink-scrollbar-hover", "--ink-secondary", "--ink-selection", "--ink-selection-inactive",
        "--ink-tertiary", "--ink-wash", "--ink-wash-strong", "--lift", "--line", "--line-soft", "--line-strong",
        "--motion-base", "--motion-ease", "--motion-fast", "--motion-rise", "--motion-slow", "--primary",
        "--radius-control", "--radius-panel", "--radius-row", "--raised", "--recess", "--row-glyph-ink",
        "--row-height", "--row-pad-block", "--secondary", "--selection", "--selection-inactive",
        "--shadow-dialog", "--shadow-raised", "--sidebar-agent-glyph-inset", "--sidebar-agent-text-inset",
        "--sidebar-edge", "--sidebar-glyph-ink", "--sidebar-glyph-optical-shift", "--sidebar-glyph-stroke",
        "--sidebar-glyph-width", "--sidebar-rail-collapsed-width", "--sidebar-rail-entry", "--sidebar-row-gap",
        "--sidebar-row-inset", "--sidebar-scroll-inset", "--sidebar-section-gap", "--sidebar-text-inset",
        "--sidebar-tree-gap", "--sidebar-tree-line", "--sidebar-width", "--space-1", "--space-2", "--space-3",
        "--space-4", "--space-5", "--space-6", "--space-8", "--status-background", "--status-done",
        "--status-error", "--status-idle", "--status-waiting", "--status-working", "--sunken", "--surface",
        "--tertiary", "--titlebar-bar", "--titlebar-control-size", "--titlebar-controls-inset",
        "--traffic-light-inset", "--waiting", "--wash", "--wash-strong",
    ]

    private let dark2026 = ShellPalette(base: .dark, surface: "#121314", chrome: "#191a1b", canvas: "#191a1b", ink: "#bfbfbf")

    func testCoversEveryTokenOfTokensCSS() {
        XCTAssertEqual(Self.tokensCSS.count, 82)
        for titleBar in DevHubTheme.TitleBar.allCases {
            for density in DevHubTheme.Density.allCases {
                let theme = DevHubTheme(palette: dark2026, titleBar: titleBar, density: density)
                XCTAssertEqual(Set(theme.cssVariables.keys), Self.tokensCSS)
                for (name, value) in theme.cssVariables {
                    XCTAssertFalse(value.isEmpty, name)
                }
            }
        }
    }

    func testTheFourAnchorsAreThePalettes() {
        let theme = DevHubTheme(palette: dark2026)
        XCTAssertEqual(theme.surface.description, "#121314")
        XCTAssertEqual(theme.chrome.description, "#191a1b")
        XCTAssertEqual(theme.canvas.description, "#191a1b")
        XCTAssertEqual(theme.primary.description, "#bfbfbf")
        XCTAssertEqual(theme.base, .dark)
        // An anchor that is not a colour stands in from tokens.css.
        let broken = DevHubTheme(palette: ShellPalette(base: .light, surface: "nope", chrome: "#ececec", canvas: "#ececec", ink: "#000000"))
        XCTAssertEqual(broken.surface.description, "#ffffff")
    }

    func testColorMixIsCSSs() throws {
        // color-mix(in srgb, #ffffff 7%, #121314)
        let raised = DevHubColor.white.mix(0.07, with: try XCTUnwrap(DevHubColor(css: "#121314")))
        XCTAssertEqual(raised.red, 0.07 + 0.93 * 18 / 255, accuracy: 1e-12)
        XCTAssertEqual(raised.alpha, 1)
        // Mixing with transparent keeps the hue and scales the alpha.
        let ink = try XCTUnwrap(DevHubColor(css: "#bfbfbf")).mix(0.62, with: .transparent)
        XCTAssertEqual(ink.red, 191.0 / 255, accuracy: 1e-12)
        XCTAssertEqual(ink.alpha, 0.62, accuracy: 1e-12)
        XCTAssertEqual(ink.description, "rgba(191, 191, 191, 0.62)")
        // Premultiplied: a translucent colour weighs by its alpha.
        let half = DevHubColor(red: 1, green: 0, blue: 0, alpha: 0.5).mix(0.5, with: DevHubColor(red: 0, green: 0, blue: 1, alpha: 1))
        XCTAssertEqual(half.alpha, 0.75, accuracy: 1e-12)
        XCTAssertEqual(half.red, 0.25 / 0.75, accuracy: 1e-12)
        XCTAssertEqual(half.blue, 0.5 / 0.75, accuracy: 1e-12)
        XCTAssertEqual(DevHubColor.transparent.mix(0.5, with: .transparent), .transparent)
    }

    func testEveryInkIsTheOneInkAtAStrength() {
        let theme = DevHubTheme(palette: dark2026)
        let primary = theme.primary
        XCTAssertEqual(theme.secondary, primary.mix(0.62, with: .transparent))
        XCTAssertEqual(theme.tertiary, primary.mix(0.30, with: .transparent))
        XCTAssertEqual(theme.disabledInk, theme.tertiary)
        XCTAssertEqual(theme.rowGlyphInk, theme.tertiary)
        XCTAssertEqual(theme.selection, primary.mix(0.14, with: .transparent))
        XCTAssertEqual(theme.selectionInactive, primary.mix(0.07, with: .transparent))
        XCTAssertEqual(theme.line, primary.mix(0.14, with: .transparent))
        XCTAssertEqual(theme.lineSoft, primary.mix(0.08, with: .transparent))
        XCTAssertEqual(theme.lineStrong, primary.mix(0.26, with: .transparent))
        XCTAssertEqual(theme.wash, primary.mix(0.06, with: .transparent))
        XCTAssertEqual(theme.washStrong, primary.mix(0.12, with: .transparent))
        XCTAssertEqual(theme.scrollbar, primary.mix(0.22, with: .transparent))
        XCTAssertEqual(theme.scrollbarHover, primary.mix(0.38, with: .transparent))
        XCTAssertEqual(theme.raised, DevHubColor.white.mix(0.07, with: theme.surface))
        XCTAssertEqual(theme.sunken, DevHubColor.black.mix(0.11, with: theme.surface))
        XCTAssertEqual(theme.statusBackground, theme.statusWorking.mix(0.55, with: theme.secondary))
        XCTAssertEqual(theme.cssVariables["--raised"], "#232424")
    }

    func testIncreaseContrastMovesTheStrengthsNotTheColours() {
        let theme = DevHubTheme(palette: dark2026, increaseContrast: true)
        XCTAssertEqual(theme.primary.description, "#bfbfbf")
        XCTAssertEqual(theme.secondary, theme.primary.mix(0.88, with: .transparent))
        XCTAssertEqual(theme.tertiary, theme.primary.mix(0.68, with: .transparent))
        XCTAssertEqual(theme.line, theme.primary.mix(0.38, with: .transparent))
        XCTAssertEqual(theme.selection, theme.primary.mix(0.30, with: .transparent))
        XCTAssertEqual(theme.cssVariables["--ink-scrollbar-hover"], "65%")
        XCTAssertEqual(theme.cssVariables["--lift"], "7%")
    }

    func testLightDarkPicksTheHalfOfTheScheme() {
        let dark = DevHubTheme(palette: dark2026)
        let light = DevHubTheme(palette: DevHubTheme.fallbackPalette(.light))
        XCTAssertEqual(dark.statusWorking.description, "#ff9f0a")
        XCTAssertEqual(light.statusWorking.description, "#b25000")
        XCTAssertEqual(dark.danger.description, "#ff6961")
        XCTAssertEqual(light.danger.description, "#c0392f")
        XCTAssertEqual(dark.statusError, dark.danger)
        XCTAssertEqual(light.statusDone.description, "#8250df")
        XCTAssertEqual(dark.statusIdle.description, "#30d158")
        XCTAssertEqual(light.statusWaiting.description, "#0a66d0")
        XCTAssertEqual(dark.accent.description, "#82aeca")
        XCTAssertEqual(dark.focusRing, dark.accent)
        XCTAssertEqual(dark.cssVariables["--shadow-raised"], "0 1px 2px rgba(0, 0, 0, 0.5)")
        XCTAssertEqual(light.cssVariables["--shadow-dialog"], "0 12px 38px rgba(0, 0, 0, 0.22)")
        XCTAssertEqual(light.primary.description, "rgba(0, 0, 0, 0.85)")
    }

    func testTheDensitiesAreTheSidebarsTwoGeometries() {
        let compact = DevHubTheme(palette: dark2026, density: .compact).sidebar
        XCTAssertEqual(
            [compact.rowInset, compact.treeLine, compact.textInset, compact.agentGlyphInset, compact.agentTextInset],
            [16, 24, 40, 40, 64])
        XCTAssertEqual(compact.rowHeight, 26)
        XCTAssertEqual(compact.railEntry, 26)
        XCTAssertEqual(compact.glyphStroke, 1.71)
        let comfortable = DevHubTheme(palette: dark2026, density: .comfortable).sidebar
        XCTAssertEqual(
            [comfortable.rowInset, comfortable.treeLine, comfortable.textInset, comfortable.agentGlyphInset, comfortable.agentTextInset],
            [18, 27, 44, 44, 70])
        XCTAssertEqual(comfortable.rowHeight, 30)
        XCTAssertEqual(comfortable.sectionGap, 12)
        XCTAssertEqual(DevHubTheme.Density(setting: "comfortable"), .comfortable)
        XCTAssertEqual(DevHubTheme.Density(setting: "anything"), .compact)
    }

    func testTheTwoChromes() {
        let shown = DevHubTheme(palette: dark2026, titleBar: .shown, density: .compact).chromeMetrics
        XCTAssertEqual(shown.titlebarBar, 32)
        XCTAssertEqual(shown.titlebarControlsInset, 76 + 8 + 22 + 12)
        XCTAssertEqual(shown.sidebarRailCollapsedWidth, 40)
        XCTAssertEqual(DevHubTheme(palette: dark2026, titleBar: .shown, density: .comfortable).chromeMetrics.sidebarRailCollapsedWidth, 42)
        let hidden = DevHubTheme(palette: dark2026, titleBar: .hidden).chromeMetrics
        XCTAssertEqual(hidden.titlebarBar, 0)
        XCTAssertEqual(hidden.trafficLightInset, 88)
        XCTAssertEqual(hidden.titlebarControlsInset, 0)
        XCTAssertEqual(hidden.sidebarRailCollapsedWidth, 76)
    }

    func testTheMonospaceIsTheTerminalsFamily() {
        XCTAssertEqual(DevHubTheme(palette: dark2026).cssVariables["--font-mono"], #"ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace"#)
        XCTAssertEqual(DevHubTheme(palette: dark2026, terminalFontFamily: "JetBrains Mono").fontMono.first, "JetBrains Mono")
    }

    func testTheGroundAndTheDim() {
        let theme = DevHubTheme(palette: dark2026)
        XCTAssertNil(theme.windowBackground(reducedTransparency: false, hasMaterial: true))
        XCTAssertEqual(theme.windowBackground(reducedTransparency: true, hasMaterial: true), theme.canvas)
        XCTAssertEqual(theme.windowBackground(reducedTransparency: false, hasMaterial: false), theme.canvas)
        XCTAssertEqual(theme.scrim(reducedTransparency: false).alpha, 0.42, accuracy: 1e-9)
        XCTAssertEqual(theme.scrim(reducedTransparency: true).alpha, 0.6, accuracy: 1e-9)
    }

    func testFallbackPalettesAreTokensCSSs() {
        let theme = DevHubTheme(palette: DevHubTheme.fallbackPalette(.dark))
        XCTAssertEqual(theme.cssVariables["--canvas"], "#1e1e1e")
        XCTAssertEqual(theme.cssVariables["--chrome"], "#262626")
        XCTAssertEqual(theme.cssVariables["--primary"], "rgba(255, 255, 255, 0.85)")
        XCTAssertEqual(theme.cssVariables["--motion-ease"], "cubic-bezier(0.2, 0.8, 0.2, 1)")
        XCTAssertEqual(theme.cssVariables["--motion-base"], "180ms")
        XCTAssertEqual(theme.cssVariables["--sidebar-glyph-stroke"], "1.71")
        XCTAssertEqual(theme.cssVariables["--space-8"], "32px")
        XCTAssertEqual(theme.cssVariables["--radius-panel"], "10px")
        XCTAssertEqual(theme.cssVariables["--sidebar-width"], "248px")
    }
}

final class TerminalAppearanceTests: XCTestCase {
    private func appearance(_ change: (inout TerminalAppearance) -> Void = { _ in }) -> TerminalAppearance {
        var value = TerminalAppearance(fontFamily: "ui-monospace", fontSize: 13, lineHeight: 1, scrollSensitivity: 3, margin: 4, theme: .defaults)
        change(&value)
        return value
    }

    func testTheDefaultsArePaintable() {
        XCTAssertTrue(appearance().isValid)
        XCTAssertEqual(appearance().palette(dark: true), .defaultDark)
    }

    func testOutOfRangeValuesAreRefused() {
        XCTAssertFalse(appearance { $0.fontSize = 8 }.isValid)
        XCTAssertFalse(appearance { $0.fontSize = 25 }.isValid)
        XCTAssertFalse(appearance { $0.lineHeight = 2.5 }.isValid)
        XCTAssertFalse(appearance { $0.scrollSensitivity = 0 }.isValid)
        XCTAssertFalse(appearance { $0.margin = 65 }.isValid)
        XCTAssertFalse(appearance { $0.fontFamily = "" }.isValid)
    }

    func testThePaintedMarginNeverGoesWrong() {
        // `var()` would not fall back from an unparsable margin.
        XCTAssertEqual(TerminalAppearance.paintedMargin(nil), 4)
        XCTAssertEqual(TerminalAppearance.paintedMargin(.nan), 4)
        XCTAssertEqual(TerminalAppearance.paintedMargin(-8), 0)
        XCTAssertEqual(TerminalAppearance.paintedMargin(6), 6)
    }
}

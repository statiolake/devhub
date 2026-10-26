// Port of apps/desktop/src/shell/styles/tokens.css (every custom property it
// declares), with apps/desktop/src/shell/styles/windowBackground.css and the
// derivation rule of apps/desktop/src/ipc/palette.ts (`paletteVariables`).
//
// DevHub design tokens.
//
// Every token is declared once per role and resolved for the appearance the
// window is in. A theme replaces exactly four values — canvas, chrome,
// surface, primary — and the scheme (light or dark). Everything else below is
// written as a relation to one of those (a lift off the surface, an ink at a
// strength) rather than as a literal, which is what lets a theme reach every
// token, and what lets Increase Contrast keep working on top of one: it moves
// the strengths, and the strengths are named. No view knows any of it
// happened.
//
// The CSS relations are kept exactly: `color-mix(in srgb, A p%, B)` is
// `DevHubColor.mix` (premultiplied alpha, as CSS Color 5 defines it), and
// `light-dark(a, b)` is the palette's base choosing. Lengths are points, the
// CSS pixels the TS app's stylesheets say.

import Foundation

/// A colour as DevHub paints it: sRGB components on 0…1, not rounded to eight
/// bits (CSS keeps a `color-mix` result exact until it is drawn).
public struct DevHubColor: Sendable, Equatable, CustomStringConvertible {
    public var red: Double
    public var green: Double
    public var blue: Double
    public var alpha: Double

    public init(red: Double, green: Double, blue: Double, alpha: Double = 1) {
        self.red = red
        self.green = green
        self.blue = blue
        self.alpha = alpha
    }

    public init(_ color: ThemeColor) {
        let unit = color.unitComponents
        self.init(red: unit.red, green: unit.green, blue: unit.blue, alpha: unit.alpha)
    }

    /// A palette colour (`#…`, `rgb()`, `rgba()`); anything else is `nil`.
    public init?(css text: String) {
        guard ShellPalette.isPaletteColor(text), let color = ThemeColor.parse(text) else { return nil }
        self.init(color)
    }

    /// A literal from this file; a typo here is a bug.
    static func hex(_ text: String) -> DevHubColor {
        DevHubColor(ThemeColor.fromHex(text))
    }

    public static let white = DevHubColor(red: 1, green: 1, blue: 1)
    public static let black = DevHubColor(red: 0, green: 0, blue: 0)
    public static let transparent = DevHubColor(red: 0, green: 0, blue: 0, alpha: 0)

    /// `color-mix(in srgb, self p, other)`, `p` on 0…1 and the other colour
    /// taking the rest: interpolated with premultiplied alpha, so mixing with
    /// `transparent` keeps the hue and scales the alpha.
    public func mix(_ share: Double, with other: DevHubColor) -> DevHubColor {
        let p = min(max(share, 0), 1)
        let q = 1 - p
        let alpha = alpha * p + other.alpha * q
        guard alpha > 0 else { return .transparent }
        func channel(_ a: Double, _ b: Double) -> Double {
            (a * self.alpha * p + b * other.alpha * q) / alpha
        }
        return DevHubColor(
            red: channel(red, other.red),
            green: channel(green, other.green),
            blue: channel(blue, other.blue),
            alpha: alpha
        )
    }

    /// The colour as CSS would write it, components rounded to eight bits.
    public var description: String {
        let r = Int((red * 255).rounded())
        let g = Int((green * 255).rounded())
        let b = Int((blue * 255).rounded())
        if alpha >= 1 {
            return String(format: "#%02x%02x%02x", r, g, b)
        }
        return "rgba(\(r), \(g), \(b), \(JSNumber.fixed2((alpha * 1000).rounded() / 1000)))"
    }
}

/// A box shadow: `0 <y> <blur> <color>`.
public struct DevHubShadow: Sendable, Equatable {
    public var offsetY: Double
    public var blur: Double
    public var color: DevHubColor
}

/// A cubic Bézier easing, CSS `cubic-bezier()`.
public struct DevHubEasing: Sendable, Equatable {
    public var x1: Double
    public var y1: Double
    public var x2: Double
    public var y2: Double
}

public struct DevHubTheme: Sendable, Equatable {
    // MARK: inputs

    /// `appearance.title_bar`, as the window was made (`data-title-bar`).
    public enum TitleBar: String, Sendable, Equatable, CaseIterable {
        case shown
        case hidden
    }

    /// `appearance.sidebar_density` (`data-sidebar-density`); anything but
    /// `comfortable` is compact, as the projection says.
    public enum Density: String, Sendable, Equatable, CaseIterable {
        case compact
        case comfortable

        public init(setting: String) {
            self = setting == "comfortable" ? .comfortable : .compact
        }
    }

    /// The named strengths. Increase Contrast asks for firmer edges and darker
    /// secondary ink; it moves these, not the colours.
    public struct Strengths: Sendable, Equatable {
        public var lift: Double
        public var recess: Double
        public var inkSecondary: Double
        public var inkTertiary: Double
        public var inkSelection: Double
        public var inkSelectionInactive: Double
        public var inkLine: Double
        public var inkLineSoft: Double
        public var inkLineStrong: Double
        public var inkScrollbar: Double
        public var inkScrollbarHover: Double
        public var inkWash: Double
        public var inkWashStrong: Double

        /// `:root`.
        public static let standard = Strengths(
            lift: 0.07, recess: 0.11,
            inkSecondary: 0.62, inkTertiary: 0.30,
            inkSelection: 0.14, inkSelectionInactive: 0.07,
            inkLine: 0.14, inkLineSoft: 0.08, inkLineStrong: 0.26,
            inkScrollbar: 0.22, inkScrollbarHover: 0.38,
            inkWash: 0.06, inkWashStrong: 0.12
        )

        /// `@media (prefers-contrast: more)`.
        public static let increasedContrast = Strengths(
            lift: 0.07, recess: 0.11,
            inkSecondary: 0.88, inkTertiary: 0.68,
            inkSelection: 0.30, inkSelectionInactive: 0.17,
            inkLine: 0.38, inkLineSoft: 0.25, inkLineStrong: 0.60,
            inkScrollbar: 0.45, inkScrollbarHover: 0.65,
            inkWash: 0.06, inkWashStrong: 0.12
        )
    }

    /// The Sidebar's row geometry for one density, and the columns derived
    /// from it (`.app-shell` and `.app-shell[data-sidebar-density]`).
    ///
    ///     compact       inset 0→16   icon 16→32   vertical 24   elbow 24→36   Agent icon 40→56   Agent text 64
    ///     comfortable   inset 0→18   icon 18→36   vertical 27   elbow 27→40   Agent icon 44→62   Agent text 70
    public struct SidebarMetrics: Sendable, Equatable {
        public var rowHeight: Double
        /// The space above a row's content and below it.
        public var rowPadBlock: Double
        public var glyphWidth: Double
        public var glyphInk: Double
        /// On the 16-unit box every Sidebar mark is drawn on, scaled to this
        /// density's ink size (both land on 1.5 device pixels).
        public var glyphStroke: Double
        public var rowGap: Double
        /// The step between the Scratch row and the workspaces under it.
        public var sectionGap: Double
        public var scrollInset: Double

        /// The air before the icon column: one glyph column wide.
        public var rowInset: Double { glyphWidth }
        /// Where the tree's vertical stands: down the middle of the
        /// Workspace's icon column.
        public var treeLine: Double { rowInset + glyphWidth / 2 }
        /// The air between the end of the elbow and the Agent's mark.
        public var treeGap: Double { Spacing.space1 }
        /// Where a row's words start: after the icon column, with one gap.
        public var textInset: Double { rowInset + glyphWidth + Spacing.space2 }
        /// Where an Agent's icon column starts: where its Workspace's words do.
        public var agentGlyphInset: Double { textInset }
        /// Where an Agent's words start.
        public var agentTextInset: Double { agentGlyphInset + glyphWidth + Spacing.space2 }
        /// An entry in the rail: as wide as a row is tall.
        public var railEntry: Double { rowHeight }
        /// The hairline down the Sidebar's trailing edge.
        public var edge: Double { 1 }

        public static func of(_ density: Density) -> SidebarMetrics {
            switch density {
            case .compact:
                return SidebarMetrics(
                    rowHeight: 26, rowPadBlock: 3, glyphWidth: 16, glyphInk: 14, glyphStroke: 1.71,
                    rowGap: Spacing.space1, sectionGap: Spacing.space2, scrollInset: Spacing.space1
                )
            case .comfortable:
                return SidebarMetrics(
                    rowHeight: 30, rowPadBlock: 5, glyphWidth: 18, glyphInk: 16, glyphStroke: 1.5,
                    rowGap: Spacing.space2, sectionGap: Spacing.space3, scrollInset: Spacing.space2
                )
            }
        }
    }

    /// The window's two chromes, as geometry (`.app-shell[data-title-bar]`).
    public struct ChromeMetrics: Sendable, Equatable {
        /// `--titlebar-height`: a plain titled macOS window's own bar (32pt on
        /// macOS 26), the band the traffic lights sit in either way.
        public var titlebarHeight: Double
        /// `--traffic-light-span`: how far the lights reach from the edge.
        public var trafficLightSpan: Double
        /// How tall the bar DevHub draws is.
        public var titlebarBar: Double
        /// How far past the lights the band that holds them starts its content.
        public var trafficLightInset: Double
        /// How much of each end of the bar is not the name.
        public var titlebarControlsInset: Double
        /// The Sidebar collapsed to its rail.
        public var sidebarRailCollapsedWidth: Double

        public static let titlebarHeightValue: Double = 32
        public static let trafficLightSpanValue: Double = 76

        public static func of(_ titleBar: TitleBar, sidebar: SidebarMetrics) -> ChromeMetrics {
            switch titleBar {
            case .shown:
                return ChromeMetrics(
                    titlebarHeight: titlebarHeightValue,
                    trafficLightSpan: trafficLightSpanValue,
                    titlebarBar: titlebarHeightValue,
                    trafficLightInset: 0,
                    titlebarControlsInset: trafficLightSpanValue + Spacing.space2 + DevHubTheme.titlebarControlSize + Spacing.space3,
                    sidebarRailCollapsedWidth: sidebar.glyphWidth + 2 * Spacing.space3
                )
            case .hidden:
                return ChromeMetrics(
                    titlebarHeight: titlebarHeightValue,
                    trafficLightSpan: trafficLightSpanValue,
                    titlebarBar: 0,
                    trafficLightInset: 88,
                    titlebarControlsInset: 0,
                    sidebarRailCollapsedWidth: trafficLightSpanValue
                )
            }
        }
    }

    /// `--space-*`.
    public enum Spacing {
        public static let space1: Double = 4
        public static let space2: Double = 8
        public static let space3: Double = 12
        public static let space4: Double = 16
        public static let space5: Double = 20
        public static let space6: Double = 24
        public static let space8: Double = 32
    }

    /// `--radius-*`.
    public enum Radius {
        public static let row: Double = 6
        public static let control: Double = 6
        public static let panel: Double = 10
    }

    /// Motion: one easing (quick out, soft settle) and three short durations,
    /// in seconds. Under Reduce Motion each view turns its own off.
    public enum Motion {
        public static let ease = DevHubEasing(x1: 0.2, y1: 0.8, x2: 0.2, y2: 1)
        public static let fast: Double = 0.120
        public static let base: Double = 0.180
        public static let slow: Double = 0.220
        public static let rise: Double = 4
    }

    /// A bar control: the smallest square that reads as pressable beside a
    /// 16pt mark.
    public static let titlebarControlSize: Double = 22
    /// The Sidebar's expanded width before the person drags it.
    public static let sidebarWidth: Double = 248
    /// How far a row's leading glyph drops to sit level with its label: the
    /// 13pt system font's optical centre sits a point below its line box's.
    public static let sidebarGlyphOpticalShift: Double = 1
    /// The chrome's type size: the 13pt macOS control size.
    public static let fontSize: Double = 13

    // MARK: the tokens

    public let palette: ShellPalette
    public let base: ShellPaletteBase
    public let strengths: Strengths
    public let titleBar: TitleBar
    public let density: Density

    // Materials, back to front.
    public let canvas: DevHubColor
    public let chrome: DevHubColor
    public let surface: DevHubColor
    /// A lift off the surface, one step towards white.
    public let raised: DevHubColor
    /// A recess into the surface, one step towards black.
    public let sunken: DevHubColor

    // Ink: one ink at different strengths.
    public let primary: DevHubColor
    public let secondary: DevHubColor
    public let tertiary: DevHubColor
    public let disabledInk: DevHubColor
    /// The rest colour of every mark inside a Sidebar row.
    public let rowGlyphInk: DevHubColor

    // Accent and state.
    /// The fallback accent. On a Mac the accent is the person's system accent
    /// colour (`NSColor.controlAccentColor`, CSS `AccentColor`), which the app
    /// uses in its place; this is what stands in where it cannot.
    public let accent: DevHubColor
    public let accentInk: DevHubColor
    public let selection: DevHubColor
    public let selectionInactive: DevHubColor
    public let waiting: DevHubColor
    public let danger: DevHubColor

    // Agent status ink (VS Code's own colours for them).
    public let statusWorking: DevHubColor
    /// The working ink, set back: a turn over while something it started runs.
    public let statusBackground: DevHubColor
    public let statusWaiting: DevHubColor
    public let statusIdle: DevHubColor
    public let statusError: DevHubColor
    /// GitHub's purple: a closed Issue, a merged pull request.
    public let statusDone: DevHubColor

    // Separators.
    public let line: DevHubColor
    public let lineSoft: DevHubColor
    public let lineStrong: DevHubColor
    public let focusRing: DevHubColor

    /// A scrollbar's thumb, and under the pointer.
    public let scrollbar: DevHubColor
    public let scrollbarHover: DevHubColor

    /// Hover/pressed washes that work on any material.
    public let wash: DevHubColor
    public let washStrong: DevHubColor

    public let shadowRaised: DevHubShadow
    public let shadowDialog: DevHubShadow

    public let sidebar: SidebarMetrics
    public let chromeMetrics: ChromeMetrics

    /// The one monospace family list on every view (`--font-mono`): the
    /// terminal's, `terminal_font_family`.
    public let fontMono: [String]

    public init(
        palette: ShellPalette,
        increaseContrast: Bool = false,
        titleBar: TitleBar = .shown,
        density: Density = .compact,
        terminalFontFamily: String? = TerminalFontStack.defaultFamily
    ) {
        self.palette = palette
        let base = palette.base
        self.base = base
        let strengths = increaseContrast ? Strengths.increasedContrast : Strengths.standard
        self.strengths = strengths
        self.titleBar = titleBar
        self.density = density
        func pick(_ light: String, _ dark: String) -> DevHubColor {
            .hex(base == .dark ? dark : light)
        }
        let fallback = DevHubTheme.fallbackPalette(base)
        func anchor(_ text: String, _ standIn: String) -> DevHubColor {
            DevHubColor(css: text) ?? DevHubColor(css: standIn) ?? .black
        }

        canvas = anchor(palette.canvas, fallback.canvas)
        chrome = anchor(palette.chrome, fallback.chrome)
        surface = anchor(palette.surface, fallback.surface)
        raised = DevHubColor.white.mix(strengths.lift, with: surface)
        sunken = DevHubColor.black.mix(strengths.recess, with: surface)

        let primary = anchor(palette.ink, fallback.ink)
        self.primary = primary
        func ink(_ strength: Double) -> DevHubColor { primary.mix(strength, with: .transparent) }
        secondary = ink(strengths.inkSecondary)
        tertiary = ink(strengths.inkTertiary)
        disabledInk = tertiary
        rowGlyphInk = tertiary

        accent = pick("#286486", "#82aeca")
        accentInk = pick("#ffffff", "#12222c")
        selection = ink(strengths.inkSelection)
        selectionInactive = ink(strengths.inkSelectionInactive)
        waiting = pick("#b25000", "#ff9f0a")
        danger = pick("#c0392f", "#ff6961")

        statusWorking = pick("#b25000", "#ff9f0a")
        statusBackground = statusWorking.mix(0.55, with: secondary)
        statusWaiting = pick("#0a66d0", "#0a84ff")
        statusIdle = pick("#1d7f36", "#30d158")
        statusError = danger
        statusDone = pick("#8250df", "#a371f7")

        line = ink(strengths.inkLine)
        lineSoft = ink(strengths.inkLineSoft)
        lineStrong = ink(strengths.inkLineStrong)
        focusRing = accent

        scrollbar = ink(strengths.inkScrollbar)
        scrollbarHover = ink(strengths.inkScrollbarHover)

        wash = ink(strengths.inkWash)
        washStrong = ink(strengths.inkWashStrong)

        shadowRaised = DevHubShadow(
            offsetY: 1, blur: 2,
            color: DevHubColor(red: 0, green: 0, blue: 0, alpha: base == .dark ? 0.5 : 0.12)
        )
        shadowDialog = DevHubShadow(
            offsetY: 12, blur: 38,
            color: DevHubColor(red: 0, green: 0, blue: 0, alpha: base == .dark ? 0.62 : 0.22)
        )

        let sidebar = SidebarMetrics.of(density)
        self.sidebar = sidebar
        chromeMetrics = ChromeMetrics.of(titleBar, sidebar: sidebar)
        fontMono = TerminalFontStack.families(terminalFontFamily)
    }

    /// The dim behind a question (`scrimColor`).
    public func scrim(reducedTransparency: Bool) -> DevHubColor {
        DevHubColor(css: ShellPalette.scrimColor(base: base, reducedTransparency: reducedTransparency)) ?? .transparent
    }

    /// The window's own ground where there is no material to let through
    /// (`windowBackground.css`): under Reduce Transparency, or on a window
    /// that could not be given one, the canvas is painted; otherwise the
    /// window's visual-effect material shows (`nil`).
    public func windowBackground(reducedTransparency: Bool, hasMaterial: Bool) -> DevHubColor? {
        reducedTransparency || !hasMaterial ? canvas : nil
    }

    /// `tokens.css`'s own anchors: the colours a window comes up in before any
    /// theme has said otherwise. They track the macOS system colours.
    public static func fallbackPalette(_ base: ShellPaletteBase) -> ShellPalette {
        switch base {
        case .light:
            return ShellPalette(base: .light, surface: "#ffffff", chrome: "#ececec", canvas: "#ececec", ink: "rgba(0, 0, 0, 0.85)")
        case .dark:
            return ShellPalette(base: .dark, surface: "#1e1e1e", chrome: "#262626", canvas: "#1e1e1e", ink: "rgba(255, 255, 255, 0.85)")
        }
    }

    /// Every token by its CSS custom-property name, as the stylesheet would
    /// compute it — the map a parity check reads against `tokens.css`.
    public var cssVariables: [String: String] {
        func px(_ value: Double) -> String { "\(JSNumber.lengthString(value))px" }
        func pct(_ value: Double) -> String { "\(JSNumber.lengthString((value * 100).rounded()))%" }
        func ms(_ value: Double) -> String { "\(Int((value * 1000).rounded()))ms" }
        func shadow(_ value: DevHubShadow) -> String { "0 \(px(value.offsetY)) \(px(value.blur)) \(value.color)" }
        let e = Motion.ease
        return [
            "--canvas": canvas.description,
            "--chrome": chrome.description,
            "--surface": surface.description,
            "--lift": pct(strengths.lift),
            "--recess": pct(strengths.recess),
            "--raised": raised.description,
            "--sunken": sunken.description,
            "--primary": primary.description,
            "--ink-secondary": pct(strengths.inkSecondary),
            "--ink-tertiary": pct(strengths.inkTertiary),
            "--secondary": secondary.description,
            "--tertiary": tertiary.description,
            "--disabled-ink": disabledInk.description,
            "--row-glyph-ink": rowGlyphInk.description,
            "--accent": accent.description,
            "--accent-ink": accentInk.description,
            "--ink-selection": pct(strengths.inkSelection),
            "--ink-selection-inactive": pct(strengths.inkSelectionInactive),
            "--selection": selection.description,
            "--selection-inactive": selectionInactive.description,
            "--waiting": waiting.description,
            "--danger": danger.description,
            "--status-working": statusWorking.description,
            "--status-background": statusBackground.description,
            "--status-waiting": statusWaiting.description,
            "--status-idle": statusIdle.description,
            "--status-error": statusError.description,
            "--status-done": statusDone.description,
            "--ink-line": pct(strengths.inkLine),
            "--ink-line-soft": pct(strengths.inkLineSoft),
            "--ink-line-strong": pct(strengths.inkLineStrong),
            "--line": line.description,
            "--line-soft": lineSoft.description,
            "--line-strong": lineStrong.description,
            "--focus-ring": focusRing.description,
            "--ink-scrollbar": pct(strengths.inkScrollbar),
            "--ink-scrollbar-hover": pct(strengths.inkScrollbarHover),
            "--ink-wash": pct(strengths.inkWash),
            "--ink-wash-strong": pct(strengths.inkWashStrong),
            "--wash": wash.description,
            "--wash-strong": washStrong.description,
            "--shadow-raised": shadow(shadowRaised),
            "--shadow-dialog": shadow(shadowDialog),
            "--space-1": px(Spacing.space1),
            "--space-2": px(Spacing.space2),
            "--space-3": px(Spacing.space3),
            "--space-4": px(Spacing.space4),
            "--space-5": px(Spacing.space5),
            "--space-6": px(Spacing.space6),
            "--space-8": px(Spacing.space8),
            "--radius-row": px(Radius.row),
            "--radius-control": px(Radius.control),
            "--radius-panel": px(Radius.panel),
            "--font-mono": fontMono.map(TerminalFontStack.quoted).joined(separator: ", "),
            "--titlebar-control-size": px(DevHubTheme.titlebarControlSize),
            "--sidebar-width": px(DevHubTheme.sidebarWidth),
            "--sidebar-glyph-optical-shift": px(DevHubTheme.sidebarGlyphOpticalShift),
            "--motion-ease": "cubic-bezier(\(e.x1), \(e.y1), \(e.x2), \(JSNumber.lengthString(e.y2)))",
            "--motion-fast": ms(Motion.fast),
            "--motion-base": ms(Motion.base),
            "--motion-slow": ms(Motion.slow),
            "--motion-rise": px(Motion.rise),
            "--sidebar-row-inset": px(sidebar.rowInset),
            "--sidebar-tree-line": px(sidebar.treeLine),
            "--sidebar-tree-gap": px(sidebar.treeGap),
            "--sidebar-text-inset": px(sidebar.textInset),
            "--sidebar-agent-glyph-inset": px(sidebar.agentGlyphInset),
            "--sidebar-agent-text-inset": px(sidebar.agentTextInset),
            "--sidebar-rail-entry": px(sidebar.railEntry),
            "--sidebar-edge": px(sidebar.edge),
            "--row-height": px(sidebar.rowHeight),
            "--row-pad-block": px(sidebar.rowPadBlock),
            "--sidebar-glyph-width": px(sidebar.glyphWidth),
            "--sidebar-glyph-ink": px(sidebar.glyphInk),
            "--sidebar-glyph-stroke": JSNumber.lengthString(sidebar.glyphStroke),
            "--sidebar-row-gap": px(sidebar.rowGap),
            "--sidebar-section-gap": px(sidebar.sectionGap),
            "--sidebar-scroll-inset": px(sidebar.scrollInset),
            "--titlebar-bar": px(chromeMetrics.titlebarBar),
            "--traffic-light-inset": px(chromeMetrics.trafficLightInset),
            "--titlebar-controls-inset": px(chromeMetrics.titlebarControlsInset),
            "--sidebar-rail-collapsed-width": px(chromeMetrics.sidebarRailCollapsedWidth),
        ]
    }
}

extension JSNumber {
    /// A length the way JavaScript writes the number: `16`, `1.71`, `0.5`.
    static func lengthString(_ value: Double) -> String {
        ThemeJSONValue.jsNumberString(value)
    }
}

/// The part of the appearance a terminal surface reads (`TerminalAppearance`
/// in `shell/terminal/theme.ts`, the terminal half of `AppAppearanceWire`).
public struct TerminalAppearance: Sendable, Equatable {
    public var fontFamily: String
    public var fontSize: Double
    public var lineHeight: Double
    public var scrollSensitivity: Double
    public var margin: Double
    public var theme: TerminalPalettes

    public init(fontFamily: String, fontSize: Double, lineHeight: Double, scrollSensitivity: Double, margin: Double, theme: TerminalPalettes) {
        self.fontFamily = fontFamily
        self.fontSize = fontSize
        self.lineHeight = lineHeight
        self.scrollSensitivity = scrollSensitivity
        self.margin = margin
        self.theme = theme
    }

    /// The margin the pane keeps around the grid, in points, by default.
    public static let defaultMargin: Double = 4
    /// `MIN_TERMINAL_FONT_SIZE` / `MAX_TERMINAL_FONT_SIZE` (`terminalZoom.ts`).
    public static let fontSizes: ClosedRange<Double> = 9...24
    /// The largest margin the settings accept.
    public static let maxMargin: Double = 64

    /// The margin a pane paints with (`terminalSurfaceStyle`): a value that is
    /// not a number is the default, a negative one is none.
    public static func paintedMargin(_ margin: Double?) -> Double {
        guard let margin, margin.isFinite else { return defaultMargin }
        return max(0, margin)
    }

    /// `validateAppearanceWire`'s terminal half: what a pane can be given.
    public var isValid: Bool {
        FontFamily.isValid(fontFamily)
            && Self.fontSizes.contains(fontSize)
            && lineHeight.isFinite && (1...2).contains(lineHeight)
            && scrollSensitivity.isFinite && (0.1...20).contains(scrollSensitivity)
            && margin <= Self.maxMargin
            && theme.light.isValid && theme.dark.isValid
    }

    /// The palette for the scheme the window is in (`activePalette`).
    public func palette(dark: Bool) -> TerminalPalette {
        theme.palette(dark: dark)
    }
}

// Port of apps/desktop/src/model/colorTheme.ts and apps/desktop/src/model/colorIds.ts
//
// A VS Code colour theme, resolved the way VS Code resolves it — by DevHub.
//
// DevHub's chrome and its terminal panes are painted from the colour theme
// DevHub's own settings name (`[appearance] theme_dark` / `theme_light`). The
// theme file is read by `ColorThemeCatalog`; this file is the other half, and
// has no filesystem in it: given the colours a theme sets and its type, what
// colour VS Code would give each id.
//
// A colour the theme sets is that colour. One it leaves unset is the colour
// registry's default for the theme's type — a literal, another colour, or a
// transform of one — read from `ColorDefaults.generated.swift`, which is
// converted from the TS app's table (itself generated from the pinned VS Code
// source) by `native/Scripts/convert-color-defaults.py`. The colour arithmetic
// below is VS Code's own (`vs/base/common/color.ts`,
// `colorUtils.ts#executeTransform`), with JavaScript's number semantics kept
// where they decide a result (`Math.round`, `| 0`, `toFixed`, NaN through
// `Math.min`/`Math.max`), and it formats exactly as `Color.toString()` does:
// `#rrggbb` when opaque, `rgba(r, g, b, a)` otherwise.

import Foundation

/// VS Code's `ColorScheme`, as the colour registry keys its defaults.
public enum ColorThemeType: String, Sendable, Equatable, Hashable, Codable, CaseIterable {
    case light
    case dark
    case hcDark
    case hcLight

    /// The theme type of a contribution's `uiTheme`; VS Code's default is dark.
    public init(uiTheme: String?) {
        switch uiTheme {
        case "vs": self = .light
        case "hc-black": self = .hcDark
        case "hc-light": self = .hcLight
        default: self = .dark
        }
    }

    /// Which half of DevHub's two-valued tokens applies.
    public var base: ShellPaletteBase {
        self == .light || self == .hcLight ? .light : .dark
    }
}

/// A colour value as the registry's defaults table writes it.
public indirect enum ColorValue: Sendable, Equatable {
    /// No default.
    case none
    /// A literal, `#…`.
    case hex(String)
    /// Another colour, by id.
    case ref(String)
    case rgba(Double, Double, Double, Double)
    case darken(ColorValue, factor: Double)
    case lighten(ColorValue, factor: Double)
    case transparent(ColorValue, factor: Double)
    case opaque(ColorValue, background: ColorValue)
    case oneOf([ColorValue])
    case lessProminent(ColorValue, background: ColorValue, factor: Double, transparency: Double)
    case ifDefinedThenElse(String, then: ColorValue, else: ColorValue)
    case mix(ColorValue, with: ColorValue, ratio: Double?)

    /// A string in the table: a literal when it starts with `#`, else an id.
    public static func string(_ text: String) -> ColorValue {
        text.hasPrefix("#") ? .hex(text) : .ref(text)
    }
}

/// Colour id → theme type → default.
public typealias ColorDefaultsTable = [String: [ColorThemeType: ColorValue]]

/// VS Code's registered colour defaults (`table`, generated:
/// `ColorDefaults.generated.swift`).
public enum ColorDefaults {}

/// A theme as its file says it: its type (from the contribution's `uiTheme`)
/// and the colours its `colors` set, `include`s already folded in.
public struct ColorThemeDefinition: Sendable, Equatable {
    /// What VS Code calls it in `workbench.colorTheme`: the `id`, else the label.
    public var settingsId: String
    public var label: String
    public var type: ColorThemeType
    /// Each colour id the theme sets, to the value it gives it.
    public var colors: [String: String]

    public init(settingsId: String, label: String, type: ColorThemeType, colors: [String: String]) {
        self.settingsId = settingsId
        self.label = label
        self.type = type
        self.colors = colors
    }
}

/// Every colour id DevHub reads out of a theme (`model/colorIds.ts`): the roots
/// of the defaults table, so a colour added here must be in the table
/// (`ColorDefaultsTests` fails until it is).
public enum ColorIds {
    public static let foreground = "foreground"
    public static let editorBackground = "editor.background"
    public static let sideBarBackground = "sideBar.background"
    public static let titleBarBackground = "titleBar.activeBackground"
    public static let terminalBackground = "terminal.background"
    public static let terminalForeground = "terminal.foreground"
    public static let cursor = "terminalCursor.foreground"
    public static let cursorText = "terminalCursor.background"
    public static let selectionBackground = "terminal.selectionBackground"
    public static let selectionForeground = "terminal.selectionForeground"
    public static let ansi: [String] = [
        "Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White",
        "BrightBlack", "BrightRed", "BrightGreen", "BrightYellow",
        "BrightBlue", "BrightMagenta", "BrightCyan", "BrightWhite",
    ].map { "terminal.ansi\($0)" }

    /// Every id, flat, in the order `colorIdList()` gives them.
    public static var all: [String] {
        [
            foreground, editorBackground, sideBarBackground, titleBarBackground,
            terminalBackground, terminalForeground, cursor, cursorText,
            selectionBackground, selectionForeground,
        ] + ansi
    }
}

// MARK: - JavaScript number semantics

/// The handful of JavaScript `Number` operations VS Code's colour code leans
/// on, so the Swift arithmetic rounds the same way.
enum JSNumber {
    /// `Math.round`: the nearest integer, a half going up (towards +∞).
    static func round(_ x: Double) -> Double {
        guard x.isFinite else { return x }
        let floor = x.rounded(.down)
        return x - floor >= 0.5 ? floor + 1 : floor
    }

    /// `Math.max(a, b)`: NaN wins.
    static func max(_ a: Double, _ b: Double) -> Double {
        if a.isNaN || b.isNaN { return .nan }
        return a > b ? a : b
    }

    /// `Math.min(a, b)`: NaN wins.
    static func min(_ a: Double, _ b: Double) -> Double {
        if a.isNaN || b.isNaN { return .nan }
        return a < b ? a : b
    }

    /// `x | 0` for a value already clamped to a small range: ToInt32.
    static func int32(_ x: Double) -> Double {
        guard x.isFinite else { return 0 }
        let truncated = x.rounded(.towardZero)
        let modulo = truncated.truncatingRemainder(dividingBy: 4_294_967_296)
        var wrapped = modulo < 0 ? modulo + 4_294_967_296 : modulo
        if wrapped >= 2_147_483_648 { wrapped -= 4_294_967_296 }
        return wrapped == 0 ? 0 : wrapped
    }

    /// `String(+x.toFixed(2))`, for `0 ≤ x ≤ 1`: rounded at two places on the
    /// exact binary value, a tie going to the larger, written the shortest way.
    static func fixed2(_ x: Double) -> String {
        if x.isNaN { return "NaN" }
        // The exact expansion, far enough that a double can never be mistaken
        // for the tie it sits next to (doubles here are ≥ 1e-21 apart from one).
        let text = String(format: "%.40f", x)
        guard let dot = text.firstIndex(of: ".") else { return text }
        let integerPart = Int(text[text.startIndex..<dot]) ?? 0
        let fraction = Array(text[text.index(after: dot)...])
        let kept = Int(String(fraction[0..<2])) ?? 0
        let rest = fraction[2...]
        let roundsUp = rest.first.map { $0 >= "5" } ?? false
        var hundredths = integerPart * 100 + kept + (roundsUp ? 1 : 0)
        if x < 0 { hundredths = -hundredths }
        let whole = hundredths / 100
        let part = abs(hundredths % 100)
        if part == 0 { return String(whole) }
        var digits = part < 10 ? "0\(part)" : String(part)
        if digits.hasSuffix("0") { digits.removeLast() }
        return "\(whole).\(digits)"
    }
}

private func roundFloat(_ value: Double, _ decimals: Double) -> Double {
    let scale = pow(10, decimals)
    return JSNumber.round(value * scale) / scale
}

// MARK: - colour arithmetic, after vs/base/common/color.ts

public struct RGBA: Sendable, Equatable {
    public let r: Double
    public let g: Double
    public let b: Double
    public let a: Double

    init(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1) {
        self.r = JSNumber.int32(JSNumber.min(255, JSNumber.max(0, r)))
        self.g = JSNumber.int32(JSNumber.min(255, JSNumber.max(0, g)))
        self.b = JSNumber.int32(JSNumber.min(255, JSNumber.max(0, b)))
        self.a = roundFloat(JSNumber.max(JSNumber.min(1, a), 0), 3)
    }
}

public struct HSLA: Sendable, Equatable {
    public let h: Double
    public let s: Double
    public let l: Double
    public let a: Double

    init(_ h: Double, _ s: Double, _ l: Double, _ a: Double) {
        self.h = JSNumber.int32(JSNumber.max(JSNumber.min(360, h), 0))
        self.s = roundFloat(JSNumber.max(JSNumber.min(1, s), 0), 3)
        self.l = roundFloat(JSNumber.max(JSNumber.min(1, l), 0), 3)
        self.a = roundFloat(JSNumber.max(JSNumber.min(1, a), 0), 3)
    }

    init(of rgba: RGBA) {
        let r = rgba.r / 255
        let g = rgba.g / 255
        let b = rgba.b / 255
        let maximum = JSNumber.max(JSNumber.max(r, g), b)
        let minimum = JSNumber.min(JSNumber.min(r, g), b)
        var h = 0.0
        var s = 0.0
        let l = (minimum + maximum) / 2
        let chroma = maximum - minimum
        if chroma > 0 {
            s = JSNumber.min(l <= 0.5 ? chroma / (2 * l) : chroma / (2 - 2 * l), 1)
            if maximum == r {
                h = (g - b) / chroma + (g < b ? 6 : 0)
            } else if maximum == g {
                h = (b - r) / chroma + 2
            } else if maximum == b {
                h = (r - g) / chroma + 4
            }
            h *= 60
            h = JSNumber.round(h)
        }
        self.init(h, s, l, rgba.a)
    }
}

private func hueToRgb(_ p: Double, _ q: Double, _ t: Double) -> Double {
    var t = t
    if t < 0 { t += 1 }
    if t > 1 { t -= 1 }
    if t < 1.0 / 6 { return p + (q - p) * 6 * t }
    if t < 1.0 / 2 { return q }
    if t < 2.0 / 3 { return p + (q - p) * (2.0 / 3 - t) * 6 }
    return p
}

private func rgbaOf(_ hsla: HSLA) -> RGBA {
    let h = hsla.h / 360
    let s = hsla.s
    let l = hsla.l
    let r: Double
    let g: Double
    let b: Double
    if s == 0 {
        r = l
        g = l
        b = l
    } else {
        let q = l < 0.5 ? l * (1 + s) : l + s - l * s
        let p = 2 * l - q
        r = hueToRgb(p, q, h + 1.0 / 3)
        g = hueToRgb(p, q, h)
        b = hueToRgb(p, q, h - 1.0 / 3)
    }
    return RGBA(JSNumber.round(r * 255), JSNumber.round(g * 255), JSNumber.round(b * 255), hsla.a)
}

/// A colour: its RGBA, and its HSLA when it was made from one (VS Code keeps
/// both and lightens from the HSLA it has, so a chain of transforms rounds the
/// same way here as there).
public struct ThemeColor: Sendable, Equatable, CustomStringConvertible {
    public let rgba: RGBA
    public let hsla: HSLA

    private init(_ value: RGBA, hsla: HSLA? = nil) {
        rgba = value
        self.hsla = hsla ?? HSLA(of: value)
    }

    public static func of(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1) -> ThemeColor {
        ThemeColor(RGBA(r, g, b, a))
    }

    private static func of(hsla value: HSLA) -> ThemeColor {
        ThemeColor(rgbaOf(value), hsla: value)
    }

    /// `Color.fromHex`: an unparsable value is red, as it is in VS Code.
    public static func fromHex(_ hex: String) -> ThemeColor {
        parseHex(hex) ?? .of(255, 0, 0, 1)
    }

    /// A colour as a theme or a palette writes it: `#…` or `rgb()/rgba()`.
    /// `nil` for anything else.
    public static func parse(_ text: String) -> ThemeColor? {
        if text.hasPrefix("#") { return parseHex(text) }
        return parseFunctional(text)
    }

    private static func luminance(of component: Double) -> Double {
        let c = component / 255
        return c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
    }

    public func relativeLuminance() -> Double {
        roundFloat(
            0.2126 * Self.luminance(of: rgba.r)
                + 0.7152 * Self.luminance(of: rgba.g)
                + 0.0722 * Self.luminance(of: rgba.b),
            4
        )
    }

    public func isLighter(than other: ThemeColor) -> Bool {
        relativeLuminance() > other.relativeLuminance()
    }

    public func isDarker(than other: ThemeColor) -> Bool {
        relativeLuminance() < other.relativeLuminance()
    }

    public func lighten(_ factor: Double) -> ThemeColor {
        .of(hsla: HSLA(hsla.h, hsla.s, hsla.l + hsla.l * factor, hsla.a))
    }

    public func darken(_ factor: Double) -> ThemeColor {
        .of(hsla: HSLA(hsla.h, hsla.s, hsla.l - hsla.l * factor, hsla.a))
    }

    public func transparent(_ factor: Double) -> ThemeColor {
        .of(rgba.r, rgba.g, rgba.b, rgba.a * factor)
    }

    public var isOpaque: Bool { rgba.a == 1 }

    public func mix(_ other: ThemeColor, _ factor: Double? = nil) -> ThemeColor {
        let ratio = JSNumber.min(JSNumber.max(factor ?? 0.5, 0), 1)
        let from = rgba
        let to = other.rgba
        return .of(
            from.r + (to.r - from.r) * ratio,
            from.g + (to.g - from.g) * ratio,
            from.b + (to.b - from.b) * ratio,
            from.a + (to.a - from.a) * ratio
        )
    }

    public func makeOpaque(_ background: ThemeColor) -> ThemeColor {
        if isOpaque || background.rgba.a != 1 { return self }
        let under = background.rgba
        let a = rgba.a
        return .of(
            under.r - a * (under.r - rgba.r),
            under.g - a * (under.g - rgba.g),
            under.b - a * (under.b - rgba.b),
            1
        )
    }

    /// `factor ? factor : 0.5` — absent, zero and NaN all mean a half.
    private static func baseFactor(_ factor: Double?) -> Double {
        guard let factor, factor != 0, !factor.isNaN else { return 0.5 }
        return factor
    }

    public static func lighterColor(_ of: ThemeColor, _ relative: ThemeColor, _ factor: Double? = nil) -> ThemeColor {
        if of.isLighter(than: relative) { return of }
        let base = baseFactor(factor)
        let lum1 = of.relativeLuminance()
        let lum2 = relative.relativeLuminance()
        return of.lighten((base * (lum2 - lum1)) / lum2)
    }

    public static func darkerColor(_ of: ThemeColor, _ relative: ThemeColor, _ factor: Double? = nil) -> ThemeColor {
        if of.isDarker(than: relative) { return of }
        let base = baseFactor(factor)
        let lum1 = of.relativeLuminance()
        let lum2 = relative.relativeLuminance()
        return of.darken((base * (lum1 - lum2)) / lum1)
    }

    /// `Color.toString()`: hex when opaque, `rgba()` otherwise.
    public var description: String {
        let r = Int(rgba.r)
        let g = Int(rgba.g)
        let b = Int(rgba.b)
        if rgba.a == 1 { return "#\(Self.hex2(r))\(Self.hex2(g))\(Self.hex2(b))" }
        return "rgba(\(r), \(g), \(b), \(JSNumber.fixed2(rgba.a)))"
    }

    public var css: String { description }

    /// The components on 0…1, for a native colour.
    public var unitComponents: (red: Double, green: Double, blue: Double, alpha: Double) {
        (rgba.r / 255, rgba.g / 255, rgba.b / 255, rgba.a)
    }

    private static func hex2(_ value: Int) -> String {
        let text = String(value, radix: 16)
        return text.count != 2 ? "0\(text)" : text
    }

    private static func parseHex(_ hex: String) -> ThemeColor? {
        let units = Array(hex.utf16)
        guard units.first == 0x23 else { return nil }
        func d(_ index: Int) -> Double {
            guard index < units.count else { return 0 }
            switch units[index] {
            case 0x30...0x39: return Double(units[index] - 0x30)
            case 0x41...0x46: return Double(units[index] - 0x41 + 10)
            case 0x61...0x66: return Double(units[index] - 0x61 + 10)
            default: return 0
            }
        }
        switch units.count {
        case 7:
            return .of(16 * d(1) + d(2), 16 * d(3) + d(4), 16 * d(5) + d(6), 1)
        case 9:
            return .of(16 * d(1) + d(2), 16 * d(3) + d(4), 16 * d(5) + d(6), (16 * d(7) + d(8)) / 255)
        case 4:
            return .of(17 * d(1), 17 * d(2), 17 * d(3))
        case 5:
            return .of(17 * d(1), 17 * d(2), 17 * d(3), (17 * d(4)) / 255)
        default:
            return nil
        }
    }

    /// `rgb(r, g, b)` / `rgba(r, g, b, a)`, commas or spaces, an optional
    /// `/ a`, percentages allowed: the forms `ShellPalette.isPaletteColor`
    /// lets through.
    private static func parseFunctional(_ text: String) -> ThemeColor? {
        let trimmed = ThemeJS.trim(text)
        let body: Substring
        if trimmed.hasPrefix("rgba(") {
            body = trimmed.dropFirst(5)
        } else if trimmed.hasPrefix("rgb(") {
            body = trimmed.dropFirst(4)
        } else {
            return nil
        }
        guard body.hasSuffix(")") else { return nil }
        let inner = body.dropLast().replacingOccurrences(of: "/", with: " ")
        let parts = inner.split(whereSeparator: { $0 == "," || $0 == " " || $0 == "\t" }).map(String.init)
        guard parts.count == 3 || parts.count == 4 else { return nil }
        func channel(_ part: String) -> Double? {
            if part.hasSuffix("%") {
                guard let value = Double(part.dropLast()) else { return nil }
                return value * 255 / 100
            }
            return Double(part)
        }
        func alpha(_ part: String) -> Double? {
            if part.hasSuffix("%") {
                guard let value = Double(part.dropLast()) else { return nil }
                return value / 100
            }
            return Double(part)
        }
        guard let r = channel(parts[0]), let g = channel(parts[1]), let b = channel(parts[2]) else { return nil }
        let a = parts.count == 4 ? alpha(parts[3]) : 1
        guard let a else { return nil }
        return .of(JSNumber.round(r), JSNumber.round(g), JSNumber.round(b), a)
    }
}

// MARK: - resolution, after colorThemeData.ts#getColor and colorUtils.ts

/// A theme to ask colours of: `getColor` and `defines` as VS Code's
/// `ColorThemeData` answers them, over a defaults table.
///
/// A class because it memoises (and marks an id before resolving it, so a
/// default that refers back to itself ends as "no colour" rather than as a
/// stack overflow); use it from one isolation domain.
public final class ResolvedColorTheme {
    public let definition: ColorThemeDefinition
    private let defaults: ColorDefaultsTable
    private var cache: [String: ThemeColor?] = [:]

    public init(_ definition: ColorThemeDefinition, defaults: ColorDefaultsTable = ColorDefaults.table) {
        self.definition = definition
        self.defaults = defaults
    }

    public var type: ColorThemeType { definition.type }

    /// Whether the theme itself sets this colour.
    public func defines(_ id: String) -> Bool {
        definition.colors[id] != nil
    }

    /// The colour VS Code would give `id` under this theme, if any.
    public func color(_ id: String) -> ThemeColor? {
        if let cached = cache[id] { return cached }
        cache[id] = .some(nil)
        let resolved: ThemeColor?
        if let own = definition.colors[id] {
            resolved = ThemeColor.fromHex(own)
        } else {
            resolved = resolve(defaults[id]?[type] ?? ColorValue.none)
        }
        cache[id] = .some(resolved)
        return resolved
    }

    /// The colour as `Color.toString()` writes it.
    public func css(_ id: String) -> String? {
        color(id)?.description
    }

    private func resolve(_ value: ColorValue) -> ThemeColor? {
        switch value {
        case .none:
            return nil
        case .hex(let text):
            return ThemeColor.fromHex(text)
        case .ref(let id):
            return color(id)
        case .rgba(let r, let g, let b, let a):
            return ThemeColor.of(r, g, b, a)
        case .darken(let inner, let factor):
            return resolve(inner)?.darken(factor)
        case .lighten(let inner, let factor):
            return resolve(inner)?.lighten(factor)
        case .transparent(let inner, let factor):
            return resolve(inner)?.transparent(factor)
        case .mix(let color, let other, let ratio):
            let clear = ThemeColor.of(0, 0, 0, 0)
            let primary = resolve(color) ?? clear
            let with = resolve(other) ?? clear
            return primary.mix(with, ratio)
        case .opaque(let inner, let backgroundValue):
            let background = resolve(backgroundValue)
            let color = resolve(inner)
            guard let background else { return color }
            return color?.makeOpaque(background)
        case .oneOf(let candidates):
            for candidate in candidates {
                if let color = resolve(candidate) { return color }
            }
            return nil
        case .ifDefinedThenElse(let id, let then, let otherwise):
            return resolve(defines(id) ? then : otherwise)
        case .lessProminent(let inner, let backgroundValue, let factor, let transparency):
            guard let from = resolve(inner) else { return nil }
            guard let background = resolve(backgroundValue) else {
                return from.transparent(factor * transparency)
            }
            return from.isDarker(than: background)
                ? ThemeColor.lighterColor(from, background, factor).transparent(transparency)
                : ThemeColor.darkerColor(from, background, factor).transparent(transparency)
        }
    }
}

/// `WORKBENCH_BACKGROUND` in `vs/workbench/common/theme.ts`.
func workbenchBackground(_ type: ColorThemeType) -> ThemeColor {
    switch type {
    case .light: return .fromHex("#F3F3F3")
    case .hcLight: return .fromHex("#FFFFFF")
    case .hcDark: return .fromHex("#000000")
    case .dark: return .fromHex("#252526")
    }
}

extension ShellPalette {
    /// The shell's four anchors, as the workbench's window splash computes
    /// them (`partsSplash.ts`; `shellPaletteOfTheme`).
    public init(theme: ResolvedColorTheme) {
        let base = theme.type.base
        let background = workbenchBackground(theme.type)
        let editor = theme.css(ColorIds.editorBackground)
        let fallback = (theme.color(ColorIds.editorBackground) ?? background).description
        let sideBar = theme.css(ColorIds.sideBarBackground)
        let titleBar = theme.color(ColorIds.titleBarBackground)?.makeOpaque(background).description
        self.init(
            base: base,
            surface: editor ?? fallback,
            chrome: sideBar ?? titleBar ?? fallback,
            canvas: titleBar ?? sideBar ?? fallback,
            ink: theme.css(ColorIds.foreground) ?? (base == .dark ? "#cccccc" : "#3b3b3b")
        )
    }
}

extension TerminalPalette {
    /// An Agent pane's palette, as VS Code's own terminal resolves the same
    /// theme (`XtermTerminal.getXtermTheme`, `TerminalInstanceColorProvider`;
    /// `terminalPaletteOfTheme`). Four colours have no registry default and
    /// VS Code falls back for them in code, so the same fallbacks are made here:
    ///
    /// - `terminal.background` is the background of wherever the terminal
    ///   sits. A pane sits where an editor does, so it is the editor's — the
    ///   rule VS Code has for a terminal in the editor area.
    /// - `terminalCursor.foreground` is the terminal's foreground.
    /// - `terminalCursor.background`, the character under a block cursor, is
    ///   the terminal's background.
    /// - `terminal.selectionForeground` stays unset: a selected cell keeps its
    ///   own colour.
    public init(theme: ResolvedColorTheme) {
        let background = theme.css(ColorIds.terminalBackground)
            ?? theme.css(ColorIds.editorBackground)
            ?? workbenchBackground(theme.type).description
        let foreground = theme.css(ColorIds.terminalForeground)
            ?? theme.css(ColorIds.foreground)
            ?? "#cccccc"
        self.init(
            background: background,
            foreground: foreground,
            cursor: theme.css(ColorIds.cursor) ?? foreground,
            cursorText: theme.css(ColorIds.cursorText) ?? background,
            selectionBackground: theme.css(ColorIds.selectionBackground) ?? "rgba(128, 128, 128, 0.4)",
            selectionForeground: theme.css(ColorIds.selectionForeground),
            ansi: ColorIds.ansi.map { theme.css($0) ?? foreground }
        )
    }
}

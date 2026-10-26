// Port of apps/desktop/src/ipc/palette.ts
//
// The shell's palette: the active VS Code colour theme, expressed as anchors.
//
// DevHub's chrome is the frame around the editor area, so it is in the same
// colour theme: the one DevHub's settings name. `ShellTheme` reads the theme's
// files itself and computes the four anchors the way VS Code's window splash
// does (`shellPalette(of:)`).
//
// Only four colours (and the scheme) make a palette. Everything else DevHub
// draws is derived from them in one place, `DevHubTheme`, so that no view can
// disagree about what a palette means.

/// Which half of every two-valued token applies.
public enum ShellPaletteBase: String, Sendable, Equatable, Hashable, Codable {
    case light
    case dark
}

public struct ShellPalette: Sendable, Equatable, Hashable, Codable {
    public var base: ShellPaletteBase
    /// The editor background: the ground content is drawn on.
    public var surface: String
    /// The side bar: DevHub's Sidebar and title-bar band.
    public var chrome: String
    /// The title bar: the window ground behind everything.
    public var canvas: String
    /// The foreground: every ink and hairline is derived from it.
    public var ink: String

    public init(base: ShellPaletteBase, surface: String, chrome: String, canvas: String, ink: String) {
        self.base = base
        self.surface = surface
        self.chrome = chrome
        self.canvas = canvas
        self.ink = ink
    }

    /// A colour DevHub is willing to paint with.
    ///
    /// The values originate in a theme extension, which is not DevHub's code.
    /// Anything that is not plainly a colour is refused: the same rule as the
    /// TS app's `^(#[0-9a-fA-F]{3,8}|rgba?\([0-9.,%\s/]+\))$`.
    public static func isPaletteColor(_ value: String) -> Bool {
        let scalars = Array(value.unicodeScalars)
        if scalars.first == "#" {
            let digits = scalars.dropFirst()
            return (3...8).contains(digits.count) && digits.allSatisfy(isHexDigit)
        }
        var rest = Substring(value)
        if rest.hasPrefix("rgba(") {
            rest = rest.dropFirst(5)
        } else if rest.hasPrefix("rgb(") {
            rest = rest.dropFirst(4)
        } else {
            return false
        }
        guard rest.hasSuffix(")") else { return false }
        let inner = rest.dropLast()
        guard !inner.isEmpty else { return false }
        return inner.unicodeScalars.allSatisfy { scalar in
            ("0"..."9").contains(scalar) || scalar == "." || scalar == "," || scalar == "%"
                || scalar == "/" || ThemeJS.isWhitespace(scalar)
        }
    }

    /// The dim behind a question (`scrimColor`): the Mac's sheet dim, one pair
    /// for each scheme, and a stronger pair under Reduce Transparency.
    public static func scrimColor(base: ShellPaletteBase, reducedTransparency: Bool) -> String {
        let alpha: String
        switch (reducedTransparency, base) {
        case (true, .dark): alpha = "0.6"
        case (true, .light): alpha = "0.35"
        case (false, .dark): alpha = "0.42"
        case (false, .light): alpha = "0.16"
        }
        return "rgba(0, 0, 0, \(alpha))"
    }

    private static func isHexDigit(_ scalar: Unicode.Scalar) -> Bool {
        ("0"..."9").contains(scalar) || ("a"..."f").contains(scalar) || ("A"..."F").contains(scalar)
    }
}


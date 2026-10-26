// Port of apps/desktop/src/model/terminalPalettes.ts
//
// An Agent pane's colours as settings name them: the palettes, the built-in
// ones, and the word that says "follow the VS Code theme" instead.
//
// On its own, apart from the config, because the Settings window offers the
// choice too.

/// One scheme's terminal colours. `ansi` is the canonical 16-entry order
/// (black, red, green, yellow, blue, magenta, cyan, white, then the bright
/// eight).
///
/// `selectionForeground` is `nil` when a VS Code theme leaves
/// `terminal.selectionForeground` unset: a selected cell keeps its own colour,
/// as it does in VS Code. A palette the person writes in `settings.toml`
/// always has one.
public struct TerminalPalette: Sendable, Equatable, Hashable, Codable {
    public var background: String
    public var foreground: String
    public var cursor: String
    public var cursorText: String
    public var selectionBackground: String
    public var selectionForeground: String?
    public var ansi: [String]

    public init(
        background: String,
        foreground: String,
        cursor: String,
        cursorText: String,
        selectionBackground: String,
        selectionForeground: String?,
        ansi: [String]
    ) {
        self.background = background
        self.foreground = foreground
        self.cursor = cursor
        self.cursorText = cursorText
        self.selectionBackground = selectionBackground
        self.selectionForeground = selectionForeground
        self.ansi = ansi
    }

    /// `terminalPaletteIsValid` (`model/wire.ts`): sixteen ANSI colours and
    /// every other colour a colour. The selection's foreground may be absent.
    public var isValid: Bool {
        guard ansi.count == 16 else { return false }
        var colours = [background, foreground, cursor, cursorText, selectionBackground]
        if let selectionForeground { colours.append(selectionForeground) }
        colours += ansi
        return colours.allSatisfy(ShellPalette.isPaletteColor)
    }

    /// The canonical names of the sixteen ANSI slots, in `ansi` order — the one
    /// place that order becomes names (`shell/terminal/theme.ts#xtermTheme`).
    public static let ansiNames: [String] = [
        "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
        "brightBlack", "brightRed", "brightGreen", "brightYellow",
        "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
    ]
}

/// One palette for each half of the window's scheme.
public struct TerminalPalettes: Sendable, Equatable, Hashable, Codable {
    public var light: TerminalPalette
    public var dark: TerminalPalette

    public init(light: TerminalPalette, dark: TerminalPalette) {
        self.light = light
        self.dark = dark
    }

    /// The palette for the scheme the window is in (`activePalette`).
    public func palette(dark isDark: Bool) -> TerminalPalette {
        isDark ? dark : light
    }

    /// The palettes a pane wears before any VS Code theme has been read.
    public static var defaults: TerminalPalettes {
        TerminalPalettes(light: .defaultLight, dark: .defaultDark)
    }
}

/// Where an Agent pane's colours come from: `vscode`, the default, is the
/// terminal colours of the VS Code colour theme DevHub wears
/// (`[appearance] theme_dark` / `theme_light`, see `ShellTheme`); palettes are
/// the person's own, one for each scheme, and win whenever the file names them.
///
/// One value rather than a switch beside two palettes, because the palettes
/// mean nothing when the theme is followed: a file that says both would be a
/// file whose tables are read nowhere.
public enum TerminalThemeConfig: Sendable, Equatable, Hashable {
    case vscode
    case palettes(TerminalPalettes)

    /// The one word `[appearance] terminal_theme` takes in place of palettes.
    public static let vscodeWord = "vscode"
}

extension TerminalPalette {
    public static var defaultLight: TerminalPalette {
        TerminalPalette(
            background: "#FFFFFF",
            foreground: "#202020",
            cursor: "#202020",
            cursorText: "#FFFFFF",
            selectionBackground: "#BFD9F2",
            selectionForeground: "#202020",
            ansi: [
                "#202020", "#cf222e", "#116329", "#B69500",
                "#0550ae", "#8250df", "#0069CC", "#606060",
                "#606060", "#ad0707", "#1a7f37", "#9a6700",
                "#0969da", "#6639ba", "#1f6feb", "#1f2328",
            ]
        )
    }

    public static var defaultDark: TerminalPalette {
        TerminalPalette(
            background: "#121314",
            foreground: "#BBBEBF",
            cursor: "#BBBEBF",
            cursorText: "#121314",
            selectionBackground: "#245C73",
            selectionForeground: "#BBBEBF",
            ansi: [
                "#555555", "#ff7b72", "#7ee787", "#e5ba7d",
                "#79c0ff", "#d2a8ff", "#3994BC", "#BBBEBF",
                "#8C8C8C", "#f48771", "#72C892", "#ffa657",
                "#48A0C7", "#B267E6", "#53A5CA", "#ededed",
            ]
        )
    }
}

/// The palettes an Agent pane wears, from the setting and the colour theme
/// (`terminalThemeWire` in `model/wire.ts`).
///
/// Following the theme, the theme's terminal colours are the pane's colours
/// whichever scheme the window is in — they are the colours of the one theme
/// DevHub is wearing, and that theme is what decides the scheme. Without a
/// theme to read (a controller built in a test) the built-in palettes stand
/// in. Palettes the person named win outright.
public func terminalPalettes(
    for setting: TerminalThemeConfig,
    fromVSCode: TerminalPalette?
) -> TerminalPalettes {
    switch setting {
    case .palettes(let palettes):
        return palettes
    case .vscode:
        if let fromVSCode {
            return TerminalPalettes(light: fromVSCode, dark: fromVSCode)
        }
        return .defaults
    }
}

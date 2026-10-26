// Port of apps/desktop/src/model/terminalPalettes.ts
//
// An Agent pane's colours as settings name them: the palettes, the built-in
// ones, and the word that says "follow the VS Code theme" instead.
//
// On its own, apart from the config loader, because the Settings window offers
// the choice and the theme code (WP8) reads it without needing the file store.

/// One terminal palette: the six named colours and the sixteen ANSI ones.
public struct TerminalPalette: Equatable, Hashable, Sendable {
    public var background: String
    public var foreground: String
    public var cursor: String
    public var cursorText: String
    public var selectionBackground: String
    public var selectionForeground: String
    public var ansi: [String]

    public init(
        background: String,
        foreground: String,
        cursor: String,
        cursorText: String,
        selectionBackground: String,
        selectionForeground: String,
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
}

/// One palette for each half of the page's scheme.
public struct TerminalPalettes: Equatable, Hashable, Sendable {
    public var light: TerminalPalette
    public var dark: TerminalPalette

    public init(light: TerminalPalette, dark: TerminalPalette) {
        self.light = light
        self.dark = dark
    }

    /// The palettes a pane wears before any VS Code theme has been read.
    public static var defaults: TerminalPalettes {
        TerminalPalettes(light: .defaultLight, dark: .defaultDark)
    }
}

/// Where an Agent pane's colours come from: `vscode`, the default, is the
/// terminal colours of the VS Code colour theme DevHub wears
/// (`[appearance] theme_dark` / `theme_light`); palettes are the person's own,
/// one for each scheme, and win whenever the file names them.
///
/// One value rather than a switch beside two palettes, because the palettes
/// mean nothing when the theme is followed: a file that says both would be a
/// file whose tables are read nowhere.
public enum TerminalThemeConfig: Equatable, Hashable, Sendable {
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

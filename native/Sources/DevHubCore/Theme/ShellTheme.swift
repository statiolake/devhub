// Port of apps/desktop/src/main/shell/shellTheme.ts
//
// Where DevHub's colours come from: the colour theme DevHub's own settings
// name.
//
// `[appearance] theme_dark` and `theme_light` name a VS Code colour theme each
// (VS Code's defaults unless the person says otherwise), and the appearance
// the process is in (`appearance.mode`, `AppearanceMode`) picks one. DevHub
// reads that theme itself — `ColorThemeCatalog` finds it among the built-in
// and installed extensions and reads its file, and `ResolvedColorTheme` fills
// in what it leaves unset from VS Code's own registered defaults — and paints
// from it:
//
// - the shell's palette (`palette()`): the window, every DevHub view, the
//   questions' dim (`DevHubTheme` derives every token from it);
// - the panes' terminal colours (`terminalPalette()`), with
//   `[appearance] terminal_theme = "vscode"`.
//
// The TS app also tells every VS Code workbench to wear the same theme
// (`workbenchThemes()`); the native app has no workbench, and the same answer
// is `wornThemes()`: which theme each half wears, by the name VS Code gives it.

/// The two names, as the settings say them.
public struct ColorThemeNames: Sendable, Equatable {
    public var dark: String
    public var light: String

    public init(dark: String, light: String) {
        self.dark = dark
        self.light = light
    }

    /// VS Code's default colour themes (`ThemeSettingDefaults.COLOR_THEME_DARK`
    /// / `COLOR_THEME_LIGHT` in the pinned VS Code), and so DevHub's.
    public static let defaultDark = "Dark 2026"
    public static let defaultLight = "Light 2026"
    public static let defaults = ColorThemeNames(dark: defaultDark, light: defaultLight)
}

/// Which theme each half wears, as `workbench.colorTheme` spells it
/// (`WorkbenchColorThemes`).
public struct WornColorThemes: Sendable, Equatable {
    public var dark: String
    public var light: String
    /// The one for the appearance the process is in now.
    public var current: String

    public init(dark: String, light: String, current: String) {
        self.dark = dark
        self.light = light
        self.current = current
    }
}

/// Reading a theme by name: its definition, or `nil` when no installed
/// extension contributes one by that name. A theme that is there and cannot be
/// read throws, with a sentence for the person (`ColorThemeUnreadable`).
public typealias ColorThemeLoader = (String) throws -> ColorThemeDefinition?

/// A broken promise of `ShellTheme`'s or `AppearanceMode`'s own: a bug, not a
/// state (`InvariantViolation` in the TS app).
public struct ThemeInvariantViolation: Error, Equatable, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

/// The theme DevHub wears. Not `Sendable`: one owner (the app's main actor)
/// configures it and reads it; what it hands out are values.
public final class ShellTheme {
    struct Worn {
        let theme: ResolvedColorTheme
        let palette: ShellPalette
        let terminal: TerminalPalette

        init(_ definition: ColorThemeDefinition) {
            theme = ResolvedColorTheme(definition)
            palette = ShellPalette(theme: theme)
            terminal = TerminalPalette(theme: theme)
        }
    }

    private struct Key: Equatable {
        let palette: ShellPalette
        let terminal: TerminalPalette
        let worn: WornColorThemes
    }

    private let loader: () -> ColorThemeLoader
    private let prefersDark: () -> Bool
    private var dark: Worn
    private var light: Worn
    private var changed: (() -> Void)?
    private var announced: Key?
    /// Problems not yet said, and every one already said (said once each).
    private var pending: [String] = []
    private var said: Set<String> = []

    /// - Parameters:
    ///   - loader: A reader of the themes installed now — asked for afresh each
    ///     time the names are read, so one listing serves both names.
    ///   - prefersDark: Whether the process is in the dark appearance.
    public init(
        loader: @escaping () -> ColorThemeLoader,
        prefersDark: @escaping () -> Bool,
        names: ColorThemeNames = .defaults
    ) {
        self.loader = loader
        self.prefersDark = prefersDark
        let empty = Worn(ColorThemeDefinition(settingsId: "", label: "", type: .dark, colors: [:]))
        dark = empty
        light = empty
        let load = loader()
        dark = read(load, names.dark, ColorThemeNames.defaultDark, half: .dark)
        light = read(load, names.light, ColorThemeNames.defaultLight, half: .light)
        announced = key()
    }

    /// The native app's theme: the catalog over the standard roots, listed
    /// afresh at every reading of the names.
    public convenience init(
        roots: @escaping () -> ExtensionRoots,
        prefersDark: @escaping () -> Bool,
        names: ColorThemeNames = .defaults
    ) {
        self.init(loader: { ColorThemeCatalog.loader(roots()) }, prefersDark: prefersDark, names: names)
    }

    /// The names the settings give, read again — at startup, and every time
    /// the settings are saved. The files are read again too, so a theme
    /// installed since is found by saving the setting that names it.
    public func configure(_ names: ColorThemeNames) {
        let load = loader()
        dark = read(load, names.dark, ColorThemeNames.defaultDark, half: .dark)
        light = read(load, names.light, ColorThemeNames.defaultLight, half: .light)
        announce()
    }

    /// The OS appearance (or `appearance.mode`) changed.
    public func appearanceChanged() {
        announce()
    }

    /// The palette the window and every DevHub view wear.
    public func palette() -> ShellPalette {
        current().palette
    }

    /// The panes' colours under the theme worn now.
    public func terminalPalette() -> TerminalPalette {
        current().terminal
    }

    /// Every token, under the theme worn now.
    public func tokens(increaseContrast: Bool = false, titleBar: DevHubTheme.TitleBar = .shown, density: DevHubTheme.Density = .compact) -> DevHubTheme {
        DevHubTheme(palette: palette(), increaseContrast: increaseContrast, titleBar: titleBar, density: density)
    }

    /// The resolved theme worn now, for any other colour id (the code
    /// highlighter's background, say).
    public func resolvedTheme() -> ResolvedColorTheme {
        current().theme
    }

    /// Which theme each half wears.
    public func wornThemes() -> WornColorThemes {
        let darkId = dark.theme.definition.settingsId
        let lightId = light.theme.definition.settingsId
        return WornColorThemes(dark: darkId, light: lightId, current: prefersDark() ? darkId : lightId)
    }

    /// Who to tell when any of the above changed. One listener.
    public func onDidChange(_ listener: @escaping () -> Void) throws {
        if changed != nil {
            throw ThemeInvariantViolation("the shell theme already has a listener")
        }
        changed = listener
    }

    /// What could not be worn since the last call, each said once: a name no
    /// installed theme has, or a theme file that would not read.
    public func takeProblems() -> [String] {
        defer { pending.removeAll() }
        return pending
    }

    private func current() -> Worn {
        prefersDark() ? dark : light
    }

    private func read(_ load: ColorThemeLoader, _ name: String, _ fallback: String, half: ShellPaletteBase) -> Worn {
        func attempt(_ candidate: String) -> ColorThemeDefinition? {
            do {
                let definition = try load(candidate)
                if definition == nil {
                    problem("No installed colour theme is called '\(candidate)' (appearance.theme_\(half.rawValue)).")
                }
                return definition
            } catch let error as ColorThemeUnreadable {
                problem(error.message)
                return nil
            } catch {
                problem(String(describing: error))
                return nil
            }
        }
        if let named = attempt(name) { return Worn(named) }
        if name != fallback, let instead = attempt(fallback) { return Worn(instead) }
        // Not even VS Code's own default is there — a build without its
        // vendored themes, say. The registry's defaults for that half are
        // still VS Code's colours, so they are what is worn.
        let type: ColorThemeType = half == .dark ? .dark : .light
        return Worn(ColorThemeDefinition(settingsId: fallback, label: fallback, type: type, colors: [:]))
    }

    private func problem(_ detail: String) {
        guard !said.contains(detail) else { return }
        said.insert(detail)
        pending.append(detail)
    }

    private func key() -> Key {
        Key(palette: palette(), terminal: terminalPalette(), worn: wornThemes())
    }

    private func announce() {
        let next = key()
        if next == announced { return }
        announced = next
        changed?()
    }
}

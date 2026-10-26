// The theme's inputs, read off `[appearance]` (`AppearanceConfig`): the half of
// `model/wire.ts#appearanceWire` and `appController.ts#colorThemeNamesOf`
// that is about colour, type and the terminal, and the notice a theme that
// cannot be worn raises (`color_theme_unavailable`).

extension ColorThemeNames {
    /// `theme_dark` / `theme_light` as the settings say them.
    public init(appearance: AppearanceConfig) {
        self.init(dark: appearance.themeDark, light: appearance.themeLight)
    }
}

extension DevHubTheme.TitleBar {
    /// `appearance.title_bar`: anything but `hidden` is shown, as the
    /// projection says.
    public init(setting: String) {
        self = setting == "hidden" ? .hidden : .shown
    }
}

extension TerminalAppearance {
    /// What a terminal pane is given: the settings' font and spacing, and the
    /// palettes `terminal_theme` names — the worn theme's terminal colours when
    /// it says `vscode` (`fromVSCode`, `ShellTheme.terminalPalette()`).
    public init(appearance: AppearanceConfig, fromVSCode: TerminalPalette?) {
        self.init(
            fontFamily: appearance.terminalFontFamily,
            fontSize: appearance.terminalFontSize,
            lineHeight: appearance.terminalLineHeight,
            scrollSensitivity: appearance.terminalScrollSensitivity,
            margin: appearance.terminalMargin,
            theme: terminalPalettes(for: appearance.terminalTheme, fromVSCode: fromVSCode)
        )
    }
}

extension ShellTheme {
    /// The notice a theme that cannot be worn raises, once per problem, with
    /// the problem (`takeProblems()`) as its detail.
    public static let unavailableNoticeCode = "color_theme_unavailable"
    public static let unavailableNoticeSummary =
        "The colour theme named in DevHub's settings is not available, so VS Code's default theme is worn instead."

    /// Wear what the settings name now (`adoptConfig`): the two themes, read
    /// again.
    public func configure(appearance: AppearanceConfig) {
        configure(ColorThemeNames(appearance: appearance))
    }
}

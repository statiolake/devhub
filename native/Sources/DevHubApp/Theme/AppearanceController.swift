// The application's appearance and the colour theme it wears, wired to AppKit:
// `AppearanceMode` writes `NSApp.appearance`, and every change of the
// effective appearance (the OS switching, or `appearance.mode` being saved)
// tells `ShellTheme`, which tells `onChange` when anything it paints moved —
// the TS app's `nativeTheme.on("updated")` → `shellTheme().appearanceChanged()`.

import AppKit
import DevHubCore

@MainActor
final class AppearanceController {
    let mode = AppearanceMode()
    let theme: ShellTheme
    /// Called when the palette, the terminal palette or the worn theme changed.
    var onChange: (() -> Void)?
    private var observation: NSKeyValueObservation?

    init(names: ColorThemeNames = .defaults, roots: ExtensionRoots) {
        theme = ShellTheme(
            roots: { roots },
            prefersDark: { MainActor.assumeIsolated { NSApp.effectiveAppearance.isDarkAppearance } },
            names: names
        )
        try? mode.own { source in
            MainActor.assumeIsolated { NSApp.appearance = NSAppearance.devHub(source) }
        }
        try? theme.onDidChange { [weak self] in
            MainActor.assumeIsolated { self?.onChange?() }
        }
        observation = NSApp.observe(\.effectiveAppearance, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.theme.appearanceChanged() }
        }
    }

    /// `appearance.mode` and the two theme names, as the settings say them —
    /// at launch and on every save.
    func configure(mode name: String, names: ColorThemeNames) {
        try? mode.apply(name)
        theme.configure(names)
    }

    /// Every token under the theme worn now, with the system's own accent and
    /// contrast setting.
    func tokens(titleBar: DevHubTheme.TitleBar, density: DevHubTheme.Density, terminalFontFamily: String?) -> DevHubTheme {
        DevHubTheme(
            palette: theme.palette(),
            increaseContrast: NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast,
            titleBar: titleBar,
            density: density,
            terminalFontFamily: terminalFontFamily
        )
    }
}

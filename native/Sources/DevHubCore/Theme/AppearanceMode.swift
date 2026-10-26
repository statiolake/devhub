// Port of apps/desktop/src/main/shell/appearanceMode.ts
//
// Which appearance DevHub runs in, and the one place that says so.
//
// The application's appearance is a process-wide fact: on a Mac it is
// `NSApplication.appearance`, which decides what every native surface DevHub
// draws resolves its dynamic colours against, and which of `theme_dark` and
// `theme_light` DevHub wears (`ShellTheme`, told on every effective-appearance
// change). Because it is one value for the whole application, one owner writes
// it — the app, handing its writer to `own(_:)` — and everything else asks
// this class.
//
// So this is not a palette and it paints nothing directly. It sets what the
// appearance *is*, and the theme is picked from that: choosing Dark here
// recolours the whole application at once.

/// What the owner is told to make the application's appearance: the OS's
/// (`NSApp.appearance = nil`), or pinned to one.
public enum AppearanceSource: String, Sendable, Equatable {
    /// Follow the OS: the only value under which the real system appearance
    /// is what the application reports.
    case system
    case light
    case dark
}

public final class AppearanceMode {
    /// What DevHub tells the application, for each appearance it can be asked
    /// for (`appearance.mode`).
    public static let sources: [String: AppearanceSource] = [
        "auto": .system,
        "light": .light,
        "dark": .dark,
    ]

    /// The modes `appearance.mode` accepts, in the order Settings offers them.
    public static let modes = ["auto", "light", "dark"]

    private var write: ((AppearanceSource) -> Void)?
    private var mode = "auto"

    public init() {}

    /// Take ownership of the application's appearance.
    ///
    /// Called once, before any window exists. The appearance starts at `auto`
    /// because the config has not been read yet, and `auto` is both its
    /// default and the honest answer: report the OS until somebody says
    /// otherwise.
    public func own(_ writer: @escaping (AppearanceSource) -> Void) throws {
        if write != nil {
            throw ThemeInvariantViolation("DevHub's appearance already has an owner")
        }
        write = writer
        writer(Self.sources[mode]!)
    }

    /// Run in the appearance the config asks for.
    ///
    /// Called with `appearance.mode` when the config is first read and again
    /// every time it is saved, so a change takes effect without a restart.
    ///
    /// An unknown mode is a broken invariant rather than something to work
    /// around. The config loader rejects anything but these three, so arriving
    /// here with a fourth means the two lists have drifted apart, and the
    /// useful thing to do is say so where it happened.
    public func apply(_ mode: String) throws {
        guard let source = Self.sources[mode] else {
            throw ThemeInvariantViolation("DevHub has no appearance called \(mode)")
        }
        self.mode = mode
        // Before an owner there is nothing to write to; remembering the answer
        // is enough, because taking ownership applies the latest one.
        write?(source)
    }

    /// The appearance DevHub is running in.
    public func current() -> String {
        mode
    }

    /// Whether DevHub wears its dark theme, given whether the OS is dark: the
    /// question `ShellTheme`'s `prefersDark` asks.
    public func prefersDark(systemIsDark: Bool) -> Bool {
        switch Self.sources[mode] ?? .system {
        case .system: return systemIsDark
        case .light: return false
        case .dark: return true
        }
    }
}

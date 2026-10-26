/// What this build of native DevHub calls itself.
///
/// `devhub --version` prints `description`; the app's About panel and the
/// control socket's `version` answer read the same value, so the three can
/// never disagree.
public enum DevHubVersion {
    /// The marketing version of the native app. Bumped by hand on release.
    public static let marketing = "0.1.0"

    /// Which implementation answered. The TypeScript app answers `version`
    /// with DevHub, VS Code and the commit; the native one has no VS Code.
    public static let implementation = "native"

    public static var description: String {
        "DevHub \(marketing) (\(implementation))"
    }
}

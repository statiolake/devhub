import Foundation

/// Which DevHub this process is, and every location that decides.
///
/// A port of `apps/desktop/src/model/profile.ts`. The default profile's
/// locations are byte for byte those of the TypeScript app, so the native app
/// is a drop-in replacement: the same `settings.toml`, the same `state.json`,
/// the same tmux server (`-L devhub`) and the same control socket the `devhub`
/// command talks to. Two DevHubs on one profile cannot run at once (the
/// control socket refuses the second); develop the native app under
/// `DEVHUB_PROFILE=native-dev` to run it beside the TypeScript one.
public struct ProfileLocations: Equatable, Sendable {
    public static let defaultProfile = "default"
    public static let environmentVariable = "DEVHUB_PROFILE"

    public let profile: String
    public let isDefault: Bool
    /// What the app calls itself (menu bar, Dock, notices).
    public let applicationName: String
    /// The launcher's file name in a PATH directory.
    public let cliCommandName: String
    /// Everything this DevHub owns on disk, under Application Support.
    public let dataDirectory: String
    /// The TS app's VS Code user-data directory. DevHub's own files live in
    /// `<userData>/devhub/` (state.json, control.sock, agent-skill/, nvim/),
    /// so the native app keeps the same directory to share them.
    public let userDataDirectory: String
    public let extensionsDirectory: String
    /// Where `settings.toml` is read from.
    public let configDirectory: String
    /// `tmux -L <name>`: the server the terminals and Agents live on.
    public let tmuxSocketName: String

    public enum Failure: Error, Equatable, CustomStringConvertible {
        case invalidName(String)
        public var description: String {
            switch self {
            case .invalidName(let name):
                return "\(ProfileLocations.environmentVariable)=\(name) is not a usable profile name: lower-case letters, digits and dashes, starting with a letter."
            }
        }
    }

    /// `^[a-z][a-z0-9-]*$`: a path component, a socket name and a command
    /// name at once.
    public static func isValidName(_ name: String) -> Bool {
        guard let first = name.unicodeScalars.first, ("a"..."z").contains(first) else { return false }
        return name.unicodeScalars.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "-" }
    }

    /// The profile named by the environment. An unusable name is a failure,
    /// never a silent fallback to the default's locations.
    public static func resolveProfileName(environment: [String: String]) throws -> String {
        guard let raw = environment[environmentVariable], !raw.isEmpty else { return defaultProfile }
        guard isValidName(raw) else { throw Failure.invalidName(raw) }
        return raw
    }

    public static func titleCase(_ profile: String) -> String {
        profile.split(separator: "-").map { word in
            word.prefix(1).uppercased() + word.dropFirst()
        }.joined(separator: " ")
    }

    public init(profile: String, home: String, environment: [String: String]) {
        let isDefault = profile == Self.defaultProfile
        let appName = isDefault ? "DevHub" : "DevHub \(Self.titleCase(profile))"
        let dataDirectory = Path.join(home, "Library", "Application Support", appName)
        let xdg = environment["XDG_CONFIG_HOME"]
        let configRoot = (xdg.map { $0.hasPrefix("/") } ?? false) ? xdg! : Path.join(home, ".config")
        let suffix = isDefault ? "" : "-\(profile)"
        self.profile = profile
        self.isDefault = isDefault
        self.applicationName = appName
        self.cliCommandName = "devhub\(suffix)"
        self.dataDirectory = dataDirectory
        self.userDataDirectory = Path.join(dataDirectory, "editor")
        self.extensionsDirectory = Path.join(dataDirectory, "extensions")
        self.configDirectory = Path.join(configRoot, "devhub\(suffix)")
        self.tmuxSocketName = "devhub\(suffix)"
    }

    /// The profile this process runs under.
    public static func current(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        home: String = NSHomeDirectory()
    ) throws -> ProfileLocations {
        ProfileLocations(profile: try resolveProfileName(environment: environment), home: home, environment: environment)
    }

    /// `<userData>/devhub`: DevHub's own files.
    public var devhubDirectory: String { Path.join(userDataDirectory, "devhub") }
    /// The unix socket the `devhub` command talks to (`main/cli/protocol.ts`).
    public var controlSocketPath: String { Path.join(devhubDirectory, "control.sock") }
    /// DevHub's state file (`model/persistence.ts`, schema 12).
    public var stateFilePath: String { Path.join(devhubDirectory, "state.json") }
    /// The one settings file.
    public var settingsFilePath: String { Path.join(configDirectory, "settings.toml") }
    /// Main's log (`main/diagnostics/mainLog.ts`).
    public var mainLogPath: String { Path.join(userDataDirectory, "logs", "devhub-main.log") }
}

/// String path helpers. Core keeps paths as `String` (POSIX), the way the
/// TypeScript code does, so ported logic reads the same.
public enum Path {
    public static func join(_ parts: String...) -> String { join(parts) }

    /// Like Node's `path.join` for the cases DevHub uses: segments joined by
    /// one `/`, empty segments skipped. (No `..` normalisation.)
    public static func join(_ parts: [String]) -> String {
        var result = ""
        for part in parts where !part.isEmpty {
            if result.isEmpty {
                result = part
            } else {
                let left = result.hasSuffix("/") ? String(result.dropLast()) : result
                let right = part.hasPrefix("/") ? String(part.dropFirst()) : part
                result = left + "/" + right
            }
        }
        return result
    }
}

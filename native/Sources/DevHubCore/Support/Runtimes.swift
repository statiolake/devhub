// Port of apps/desktop/src/main/shell/runtimes.ts and of
// `executableMissingMessage` in apps/desktop/src/ipc/settings.ts.
//
// What the configured runtime names actually resolve to on this machine.
//
// The Settings window shows three columns for each runtime — configured,
// resolved, effective — because they are three different facts and conflating
// them is how "I set it and nothing happened" becomes unexplainable. This
// produces the middle one: it looks the configured value up the way a shell
// would, and says `unavailable` when it is not there rather than assuming it
// is. The lookup itself and its sentence are WP3's `ProgramResolution`
// (`LocalRuntime.resolve`, `unavailableMessage`), one resolver for every
// program DevHub launches.

import Foundation

/// `SettingsResolvedRuntimeConfigWire`.
public struct ResolvedRuntimes: Equatable, Sendable {
    public var shell: ProgramResolution
    public var git: ProgramResolution
    public var tmux: ProgramResolution
}

/// `SettingsRuntimeHealthValueWire`.
public enum RuntimeHealthValue: String, Sendable, Equatable {
    case starting, healthy, degraded, unavailable, failed
}

/// `SettingsRuntimeHealthWire`.
public struct RuntimeHealth: Equatable, Sendable {
    public var shell: RuntimeHealthValue
    public var git: RuntimeHealthValue
    public var tmux: RuntimeHealthValue
    public var inspectionAvailable: Bool
}

public enum Runtimes {
    /// Look one configured program up, the way a shell would.
    ///
    /// An Agent profile's `command` is the same kind of fact as
    /// `runtimes.tmux`: a name a person wrote, which has to become a path on
    /// this machine before anything can run it. One resolver, one PATH, one
    /// answer.
    public static func resolveExecutable(_ value: String, searchPath: String, home: String = NSHomeDirectory()) -> ProgramResolution {
        LocalRuntime.resolve(value, searchPath: searchPath, home: home)
    }

    /// Look every configured runtime up in `searchPath`.
    ///
    /// `searchPath` is not defaulted to the process's PATH: a DevHub launched
    /// from Finder has launchd's four-entry PATH and nothing a developer
    /// installed. The caller passes the PATH from the launch environment (see
    /// `LoginEnvironment`), which is the same PATH the terminals and Agents get.
    public static func resolve(_ runtimes: RuntimeConfig, searchPath: String, home: String = NSHomeDirectory()) -> ResolvedRuntimes {
        ResolvedRuntimes(
            shell: resolveExecutable(runtimes.shell, searchPath: searchPath, home: home),
            git: resolveExecutable(runtimes.git, searchPath: searchPath, home: home),
            tmux: resolveExecutable(runtimes.tmux, searchPath: searchPath, home: home)
        )
    }

    public static func health(_ resolved: ResolvedRuntimes) -> RuntimeHealth {
        func health(_ value: ProgramResolution) -> RuntimeHealthValue {
            if case .unavailable = value { return .unavailable }
            return .healthy
        }
        return RuntimeHealth(shell: health(resolved.shell), git: health(resolved.git), tmux: health(resolved.tmux), inspectionAvailable: true)
    }

    /// A missing executable, with the reason the PATH was short when there is
    /// one.
    ///
    /// A lookup searches the environment DevHub ended up with, and that is the
    /// user's login one *unless the import failed* — a shell profile slower
    /// than the timeout leaves DevHub on launchd's four directories, and saying
    /// only "could not find 'claude' on PATH" sends the person looking for a
    /// tool that is installed. `loginFailure` is required rather than optional:
    /// passing nil is a caller saying the import is not why. A search on
    /// another machine (`where` set) ran under that machine's own login
    /// environment, which this Mac's import says nothing about.
    public static func executableMissingMessage(_ resolved: ProgramResolution, loginFailure: String?) -> String? {
        guard let lookup = resolved.unavailableMessage else { return nil }
        guard case .unavailable(_, _, let whereText) = resolved, let loginFailure, whereText == nil else { return lookup }
        return "\(lookup) \(loginFailure)"
    }

    /// The sentence `executableMissingMessage` adds when the import failed,
    /// nil when it did not.
    public static func loginFailure(_ login: LoginEnvironment) -> String? {
        if case .failed = login { return login.summary }
        return nil
    }
}

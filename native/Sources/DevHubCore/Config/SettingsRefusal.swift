// Port of apps/desktop/src/main/shell/settingsRefusal.ts and of
// `settingsRefused` in apps/desktop/src/model/wire.ts.
//
// Why this run is not on the settings file, said once and the same way
// everywhere.
//
// Three places find out that `settings.toml` cannot be used: the launch that
// could not load it, the watcher that saw an edit it could not load, and
// anything that needs settings while there are none (`requireConfig`). All
// three answer with the one notice `settingsRefused` builds, naming the file,
// the key and the reason.
//
// The notice is the TS app's `AppErrorWire` for `settings_refused`: the code,
// its summary from `SAFE_ERROR_SUMMARY`, the `config` module, the one action
// (`open_settings`: trying again reads the same file; what answers it is fixing
// the file) and the detail sentence. The model's own notice type (WP2) is built
// from these fields one to one.

import Foundation

/// The `settings_refused` notice.
public struct SettingsRefusedNotice: Equatable, Sendable {
    public static let code = "settings_refused"
    public static let summary = "DevHub could not use its settings file."
    public static let module = "config"
    public static let actions = ["open_settings"]

    public var code: String { Self.code }
    public var summary: String { Self.summary }
    public var module: String { Self.module }
    public var actions: [String] { Self.actions }
    public let detail: String
    /// When it was raised, in milliseconds since the epoch.
    public let timestampMs: Double

    /// What is running instead: at launch there is nothing but the defaults,
    /// and later the last settings accepted stay in effect.
    public enum RunningOn: Sendable {
        case defaults
        case lastAcceptedSettings
    }

    /// `settingsRefused(file, diagnostic, runningOn)`.
    public init(file: String, diagnostic: ConfigDiagnostic, runningOn: RunningOn, now: Date = Date()) {
        let key = diagnostic.path ?? "the file"
        let at = diagnostic.location.map { " (line \($0.line), column \($0.column))" } ?? ""
        let instead = runningOn == .defaults
            ? "DevHub is running on its defaults until the file is fixed."
            : "DevHub is still running on the last settings it accepted."
        let detail = "\(file): \(key) was refused\(at): \(diagnostic.code.rawValue). \(instead)"
        self.detail = JSString.length(detail) <= 4096 ? detail : String(detail.prefix(4096)) + "…"
        self.timestampMs = (now.timeIntervalSince1970 * 1000).rounded(.down)
    }

    /// The notice as one line of text (`failureText`), as the `devhub`
    /// command prints it.
    public var text: String { "\(summary) \(detail)" }

    /// Equal apart from the moment it was raised.
    public func sameNotice(as other: SettingsRefusedNotice) -> Bool { detail == other.detail }
}

public final class SettingsRefusal: @unchecked Sendable {
    private let file: String
    private let lock = NSLock()
    /// The refusal this run is on the defaults because of, if it is.
    private var current: SettingsRefusedNotice?

    public init(file: String) {
        self.file = file
    }

    /// The launch could not load the file, so this run is on the defaults. A
    /// load that failed for a reason the store did not name is still the file
    /// not loading; the log has the error itself.
    public func atLaunch(_ error: Error) -> SettingsRefusedNotice {
        let diagnostic = (error as? ConfigError)?.diagnostic ?? ConfigDiagnostic(code: .io)
        let notice = SettingsRefusedNotice(file: file, diagnostic: diagnostic, runningOn: .defaults)
        lock.lock()
        current = notice
        lock.unlock()
        return notice
    }

    /// An edit to the file could not be loaded. `running` is whether this run
    /// has accepted settings, which stay in effect; without them it is still
    /// on the defaults, and this is now the reason why.
    public func onReload(_ diagnostic: ConfigDiagnostic, running: Bool) -> SettingsRefusedNotice {
        if running {
            return SettingsRefusedNotice(file: file, diagnostic: diagnostic, runningOn: .lastAcceptedSettings)
        }
        let notice = SettingsRefusedNotice(file: file, diagnostic: diagnostic, runningOn: .defaults)
        lock.lock()
        current = notice
        lock.unlock()
        return notice
    }

    /// Settings were accepted: nothing is refused any more.
    public func accepted() {
        lock.lock()
        current = nil
        lock.unlock()
    }

    /// What anything that needs settings answers with while there are none.
    public func required() throws -> SettingsRefusedNotice {
        lock.lock()
        defer { lock.unlock() }
        guard let current else { throw InvariantViolation("DevHub has no settings and no refusal to say why") }
        return current
    }
}

// Port of apps/desktop/src/main/agent/conversation/claude/defaults.ts
//
// Claude Code's defaults for new sessions, read and changed on the Agent's
// machine (ClaudeDefaults.swift says what decides them).
//
// The settings files are the CLI's: the user's under its config directory
// (`CLAUDE_CONFIG_DIR`, else `~/.claude`), the project's and the local ones
// under the Workspace's root, and the managed file where Claude Code looks
// for it on macOS and on Linux. A file that is not there, or that does not
// parse, sets nothing — the CLI would not take a value from it either.
//
// A change is written to the user settings only (CliSettingsFile.swift).

import Foundation

/// Where Claude Code looks for managed settings: macOS's place, then Linux's.
private let MANAGED_SETTINGS = [
    "/Library/Application Support/ClaudeCode/managed-settings.json",
    "/etc/claude-code/managed-settings.json",
]

/// What of an Agent profile its CLI's defaults depend on: its environment and arguments.
public struct ClaudeProfileFacts: Sendable, Equatable {
    public var env: [String: String]
    public var args: [String]

    public init(env: [String: String], args: [String]) {
        self.env = env
        self.args = args
    }
}

/// Where Claude keeps its state: `CLAUDE_CONFIG_DIR`, the profile's before the
/// machine's (`claudeConfigDirectory` in resume.ts).
public func claudeConfigDirectory(_ runtime: any MachineRuntime, profileEnv: [String: String]) async throws -> String {
    if let directory = profileEnv["CLAUDE_CONFIG_DIR"] { return directory }
    if let directory = try await runtime.environment()["CLAUDE_CONFIG_DIR"] { return directory }
    return "\(try await runtime.home())/.claude"
}

private func parsed(_ text: String?) -> JsonValue? {
    guard let text else { return nil }
    return try? JsonValue.parse(text)
}

/// The defaults a new session of `profile` in `root` starts on; the effort
/// for `model` (its full name), when it is known.
public func readClaudeDefaults(
    _ runtime: any MachineRuntime, profile: ClaudeProfileFacts, root: String, model: String?
) async throws -> CliDefaults {
    let user = "\(try await claudeConfigDirectory(runtime, profileEnv: profile.env))/settings.json"
    let paths: [ClaudeSettingsLayer: [String]] = [
        .managed: MANAGED_SETTINGS,
        .local: ["\(root)/.claude/settings.local.json"],
        .project: ["\(root)/.claude/settings.json"],
        .user: [user],
    ]
    var settings: [ClaudeSettingsLayer: JsonValue] = [:]
    for layer in CLAUDE_SETTINGS_LAYERS {
        for path in paths[layer] ?? [] {
            if let value = parsed(try await settingsText(runtime, path)) {
                settings[layer] = value
                break
            }
        }
    }
    let env = try await runtime.environment().merging(profile.env) { _, profile in profile }
    var defaults = claudeDefaults(ClaudeDefaultInputs(settings: settings, env: env, args: profile.args), model)
    defaults.savedIn = try await homeRelative(runtime, user)
    return defaults
}

/// Make `value` the default `which` of new sessions of `profile`'s CLI, in
/// its user settings; an effort is saved for `model` when it is named.
public func writeClaudeDefault(
    _ runtime: any MachineRuntime, profile: ClaudeProfileFacts, _ which: ClaudeDefaultName, _ value: String,
    model: String?
) async throws {
    let directory = try await claudeConfigDirectory(runtime, profileEnv: profile.env)
    let text = try withUserDefault(
        try await settingsText(runtime, "\(directory)/settings.json"), which, value, model: model)
    try await replaceSettingsFile(
        runtime, directory: directory, name: "settings.json", text: text, what: "Claude Code's settings")
}

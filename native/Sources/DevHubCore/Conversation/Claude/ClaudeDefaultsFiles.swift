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
// A change is written to the user settings only, and atomically: the new
// text goes to a file beside it under a name nobody else holds, which is then
// renamed over it, so the CLI never reads half a file and a failed write
// leaves the old one whole.

import Foundation

/// Larger than any settings file a person writes by hand.
private let MAX_SETTINGS_BYTES = 4 * 1024 * 1024

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

/// A file's text, or nil when it is not there.
private func textOf(_ runtime: any MachineRuntime, _ path: String) async throws -> String? {
    do {
        return try await runtime.readTextFile(path, maxBytes: MAX_SETTINGS_BYTES)
    } catch let failure as RuntimeFileError where failure.code == "ENOENT" || failure.code == "ENOTDIR" {
        return nil
    }
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
    let paths: [ClaudeSettingsLayer: [String]] = [
        .managed: MANAGED_SETTINGS,
        .local: ["\(root)/.claude/settings.local.json"],
        .project: ["\(root)/.claude/settings.json"],
        .user: ["\(try await claudeConfigDirectory(runtime, profileEnv: profile.env))/settings.json"],
    ]
    var settings: [ClaudeSettingsLayer: JsonValue] = [:]
    for layer in CLAUDE_SETTINGS_LAYERS {
        for path in paths[layer] ?? [] {
            if let value = parsed(try await textOf(runtime, path)) {
                settings[layer] = value
                break
            }
        }
    }
    let env = try await runtime.environment().merging(profile.env) { _, profile in profile }
    return claudeDefaults(ClaudeDefaultInputs(settings: settings, env: env, args: profile.args), model)
}

/// Make `value` the default `which` of new sessions of `profile`'s CLI, in
/// its user settings; an effort is saved for `model` when it is named.
public func writeClaudeDefault(
    _ runtime: any MachineRuntime, profile: ClaudeProfileFacts, _ which: ClaudeDefaultName, _ value: String,
    model: String?
) async throws {
    let directory = try await claudeConfigDirectory(runtime, profileEnv: profile.env)
    let path = "\(directory)/settings.json"
    let text = try withUserDefault(try await textOf(runtime, path), which, value, model: model)
    try await runtime.makeDirectory(directory)
    let temporary = "\(path).devhub-\(UUID().uuidString.lowercased())"
    if !(try await runtime.writeNewTextFile(temporary, text: text, mode: 0o600)) {
        throw ClaudeDefaultRefused("\(temporary) is taken\(runtime.where)")
    }
    let moved = try await runtime.exec(
        ExecRequest(
            argv: ["mv", "-f", temporary, path], deadline: .within(10_000), cancel: CancellationToken(),
            limits: MachineExecLimits(stdoutBytes: 16 * 1024, stderrBytes: 16 * 1024, overflow: .truncate)))
    if moved.code != 0 {
        try? await runtime.removeTree(temporary)
        let said = jsTrim(String(decoding: moved.stderr, as: UTF8.self))
        let status = moved.code.map { String($0) } ?? moved.signal.map { String($0) } ?? "null"
        throw ClaudeDefaultRefused(
            "DevHub could not save Claude Code's settings \(path)\(runtime.where): \(said.isEmpty ? "exit \(status)" : said)")
    }
}

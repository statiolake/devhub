// Port of apps/desktop/src/main/agent/conversation/cliSettingsFile.ts
//
// A CLI's own settings file, read and replaced on the Agent's machine — the
// file a default for new sessions is saved in (ClaudeDefaults.swift,
// CodexDefaults.swift): Claude Code's `settings.json`, Codex's `config.toml`.
//
// A change is written atomically: the new text goes to a file beside it
// under a name nobody else holds, which is then renamed over it, so the CLI
// never reads half a file and a failed write leaves the old one whole.

import Foundation

/// Larger than any settings file a person writes by hand.
private let MAX_SETTINGS_BYTES = 4 * 1024 * 1024

/// A file's text, or nil when it is not there.
func settingsText(_ runtime: any MachineRuntime, _ path: String) async throws -> String? {
    do {
        return try await runtime.readTextFile(path, maxBytes: MAX_SETTINGS_BYTES)
    } catch let failure as RuntimeFileError where failure.code == "ENOENT" || failure.code == "ENOTDIR" {
        return nil
    }
}

/// `path` under the home directory, as a person reads it: `~/.codex/config.toml`.
func homeRelative(_ runtime: any MachineRuntime, _ path: String) async throws -> String {
    let home = try await runtime.home()
    return path.hasPrefix("\(home)/") ? "~\(path.dropFirst(home.count))" : path
}

/// Replace `directory/name` with `text`, making the directory if it is not
/// there. `what` names the file in a failure: "Claude Code's settings".
func replaceSettingsFile(
    _ runtime: any MachineRuntime, directory: String, name: String, text: String, what: String
) async throws {
    let path = "\(directory)/\(name)"
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
            "DevHub could not save \(what) \(path)\(runtime.where): \(said.isEmpty ? "exit \(status)" : said)")
    }
}

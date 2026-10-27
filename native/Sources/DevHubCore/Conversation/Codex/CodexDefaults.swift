// Port of apps/desktop/src/model/codexDefaults.ts and
// apps/desktop/src/main/agent/conversation/codex/defaults.ts
//
// Codex's defaults for new sessions: which model and reasoning effort a
// thread starts on when nothing in it chose one, where that comes from, and
// how a default is changed.
//
// # What a thread gets
//
// DevHub opens a Codex thread (`thread/start`) without a model or an effort,
// so the app-server takes both from its configuration, in Codex's own order
// (developers.openai.com/codex/config-reference):
//
// - a `-c key=value` override the profile's arguments give `codex` before
//   `app-server` (`CodexArgv` puts them there): `-c model=…`,
//   `-c model_reasoning_effort=…`;
// - the selected configuration profile — `-c profile=…`, else the top-level
//   `profile` key — whose `[profiles.<name>]` table's `model` and
//   `model_reasoning_effort` come before the top-level ones;
// - the top-level `model` and `model_reasoning_effort` of
//   `$CODEX_HOME/config.toml` (`~/.codex/config.toml`);
// - else Codex's own: the model `model/list` marks as its default, and that
//   model's default effort.
//
// Both the profile table and the top level are the person's user
// configuration, so both are the `user` source: a change there is a change
// Codex reads.
//
// # Changing a default
//
// As Codex's own model picker saves one: in `config.toml`, in the selected
// profile's table when a profile is selected, else at the top level — `model`
// for a model, `model_reasoning_effort` for an effort. The file is edited in
// place (`TomlDocument.update`): every other key, comment and table stays as
// the person wrote it. An override among the profile's arguments still wins;
// `CliDefault.source` says so, and the view says a change would not take
// effect until it is gone.
//
// The configuration is read on the Agent's machine: `config.toml` under
// `CODEX_HOME` (the profile's, else the machine's, else `~/.codex`). A file
// that is not there, or that does not parse, sets nothing; a change to one
// that does not parse is refused rather than written over it.

import Foundation

/// What decides a Codex default, read on the Agent's machine.
public struct CodexDefaultInputs: Sendable {
    /// `config.toml`'s parsed contents; nil when there is none, or it does not parse.
    public var config: TomlTable?
    /// The profile's own arguments, which `codex` is started with.
    public var args: [String]

    public init(config: TomlTable?, args: [String]) {
        self.config = config
        self.args = args
    }
}

/// The configuration keys a default is saved under.
public func codexKey(_ which: ClaudeDefaultName) -> String {
    switch which {
    case .model: return "model"
    case .effort: return "model_reasoning_effort"
    }
}

private func tableOf(_ value: TomlValue?) -> TomlTable {
    value?.tableValue ?? TomlTable()
}

private func nonEmpty(_ value: String?) -> String? {
    guard let value else { return nil }
    let trimmed = jsTrim(value)
    return trimmed.isEmpty ? nil : trimmed
}

/// The value of the last `-c key=value` (or `--config key=value`) override
/// of `key` in `args`, as Codex reads one: the value is TOML when it parses
/// as a TOML value, else the text itself.
public func overrideValue(_ args: [String], _ key: String) -> String? {
    var found: String?
    for (index, arg) in args.enumerated() {
        let pair: String?
        if (arg == "-c" || arg == "--config") && index + 1 < args.count {
            pair = args[index + 1]
        } else if arg.hasPrefix("--config=") {
            pair = String(arg.dropFirst("--config=".count))
        } else {
            pair = nil
        }
        guard let pair, let equals = pair.firstIndex(of: "="),
            jsTrim(String(pair[..<equals])) == key
        else { continue }
        let raw = jsTrim(String(pair[pair.index(after: equals)...]))
        // Not TOML: Codex takes the text as a string.
        let value = (try? TomlDocument.parseValue("v = \(raw)"))?["v"]
        found = value?.stringValue ?? raw
    }
    return nonEmpty(found)
}

/// The configuration profile Codex runs under: a `-c profile=` override,
/// else the top-level `profile` key; nil for none.
public func selectedCodexProfile(_ inputs: CodexDefaultInputs) -> String? {
    overrideValue(inputs.args, "profile") ?? nonEmpty(inputs.config?["profile"]?.stringValue)
}

private func codexDefault(_ inputs: CodexDefaultInputs, _ key: String) -> CliDefault {
    if let argument = overrideValue(inputs.args, key) { return CliDefault(value: argument, source: .argument) }
    let config = inputs.config ?? TomlTable()
    if let profile = selectedCodexProfile(inputs),
        let value = nonEmpty(tableOf(tableOf(config["profiles"])[profile])[key]?.stringValue)
    {
        return CliDefault(value: value, source: .layer(.user))
    }
    if let value = nonEmpty(config[key]?.stringValue) { return CliDefault(value: value, source: .layer(.user)) }
    return CliDefault(source: .builtIn)
}

/// The model and effort a new thread starts on (see the file's head).
/// `savedIn` is where a change goes, as a person reads it.
public func codexDefaults(_ inputs: CodexDefaultInputs, savedIn: String = "~/.codex/config.toml") -> CliDefaults {
    // A `--model` among the profile's arguments is the TUI's: the app-server
    // is handed only the `-c` overrides, so it is not read here either.
    CliDefaults(
        cli: .codex, savedIn: savedIn, model: codexDefault(inputs, codexKey(.model)),
        effort: codexDefault(inputs, codexKey(.effort)))
}

/// `config.toml`'s text with `which`'s default made `value`, every other key,
/// comment and table kept as it was: in `[profiles.<profile>]` when a profile
/// is named, else at the top level. `text` is the file as it is, or nil when
/// there is none. A file that does not parse is refused rather than written
/// over: it is the person's, and DevHub cannot keep what it cannot read.
public func withCodexUserDefault(
    _ text: String?, _ which: ClaudeDefaultName, _ value: String, profile: String? = nil
) throws -> String {
    if jsTrim(value).isEmpty { throw ClaudeDefaultRefused("a \(which.rawValue) default cannot be empty") }
    let source = text ?? ""
    var desired: TomlTable
    do {
        desired = try TomlDocument.parseValue(source)
    } catch {
        throw ClaudeDefaultRefused(
            "Codex's config.toml is not valid TOML, so DevHub leaves it as it is: \(error)")
    }
    let key = codexKey(which)
    if let profile {
        var profiles = tableOf(desired["profiles"])
        var table = tableOf(profiles[profile])
        table[key] = .string(value)
        profiles[profile] = .table(table)
        desired["profiles"] = .table(profiles)
    } else {
        desired[key] = .string(value)
    }
    let written = try TomlDocument.update(source, desired: desired)
    return written.hasSuffix("\n") ? written : "\(written)\n"
}

private let CONFIG_FILE = "config.toml"

private func codexInputs(_ runtime: any MachineRuntime, _ profile: SessionProfile) async throws -> (
    directory: String, text: String?, inputs: CodexDefaultInputs
) {
    let directory = try await codexHome(runtime, profile)
    let text = try await settingsText(runtime, "\(directory)/\(CONFIG_FILE)")
    let config = text.flatMap { try? TomlDocument.parseValue($0) }
    return (directory, text, CodexDefaultInputs(config: config, args: profile.args))
}

/// The defaults a new thread of `profile`'s Codex starts on.
public func readCodexDefaults(_ runtime: any MachineRuntime, profile: SessionProfile) async throws -> CliDefaults {
    let (directory, _, inputs) = try await codexInputs(runtime, profile)
    let file = try await homeRelative(runtime, "\(directory)/\(CONFIG_FILE)")
    let savedIn = selectedCodexProfile(inputs).map { "[profiles.\($0)] in \(file)" } ?? file
    return codexDefaults(inputs, savedIn: savedIn)
}

/// Make `value` the default `which` of new threads of `profile`'s Codex, in
/// its `config.toml`: the selected configuration profile's table when one is
/// selected, else the top level.
public func writeCodexDefault(
    _ runtime: any MachineRuntime, profile: SessionProfile, _ which: ClaudeDefaultName, _ value: String
) async throws {
    let (directory, text, inputs) = try await codexInputs(runtime, profile)
    try await replaceSettingsFile(
        runtime, directory: directory, name: CONFIG_FILE,
        text: try withCodexUserDefault(text, which, value, profile: selectedCodexProfile(inputs)),
        what: "Codex's configuration")
}

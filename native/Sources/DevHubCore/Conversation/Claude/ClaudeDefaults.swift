// Port of apps/desktop/src/model/claudeDefaults.ts
//
// Claude Code's defaults for new sessions: which model and effort a session
// starts on when nothing in it chose one, where that comes from, and how a
// default is changed.
//
// # What a session gets, in Claude Code's own order
//
// Claude Code's model configuration (code.claude.com/docs/en/model-config)
// and settings reference (…/settings-reference) say:
//
// - **Model**: `/model` during the session, then `--model` at startup, then
//   `ANTHROPIC_MODEL`, then the `model` key of the settings files, else the
//   account's own default — which the handshake lists as the choice
//   `default`. Of the settings files, managed settings come first (an
//   organization default overrides the person's), then local
//   (`.claude/settings.local.json`), project (`.claude/settings.json`) and
//   user (`~/.claude/settings.json`).
// - **Effort**: an explicit choice — `CLAUDE_CODE_EFFORT_LEVEL` before
//   `--effort` ("`CLAUDE_CODE_EFFORT_LEVEL` takes precedence over both"),
//   or `/effort` in the session — then the settings: the level saved for the
//   model (`modelSettings.<model>.effortLevel`), else the top-level
//   `effortLevel`, which is for "models you haven't saved a level for"; then
//   the model's own default: `medium` on Opus 5.5 and Sonnet 5.5, `xhigh` on
//   Opus 4.7, `high` on every other model that takes effort.
//
// # Resume
//
// "Resumed sessions started with `claude --resume`, `--continue`, or the
// `/resume` picker keep the model they were using when the transcript was
// saved, regardless of the current `model` setting" (model-config, "Model
// on resume"), unless that model was retired or is not allowed. Nothing says
// an effort is kept: an effort chosen with `/effort` in `-p` mode — DevHub's
// GUI Agents run there — is applied "to that session only and doesn't save
// it", so a CLI started again resolves its effort from the order above. That
// is why the defaults here say what a *new* process starts at, and the
// session's own model, when it resumed one, is read from its transcript.
//
// # Changing a default
//
// DevHub changes the person's own user settings only, as the CLI's own
// `/model` and `/effort` save there in an interactive session: the `model`
// key, or the effort saved for the model (`modelSettings.<model>.effortLevel`,
// where the CLI itself saves it) — or the top-level `effortLevel` when no
// model is named. Every other key is kept as it was. A source above the user
// settings (an argument, the environment, managed, local or project
// settings) still wins; `CliDefault.source` says which one the default is
// from, so the view can say a change would not take effect.

import Foundation

/// A settings file Claude Code reads, highest first.
public enum ClaudeSettingsLayer: String, Hashable, Sendable, CaseIterable {
    case managed, local, project, user
}

public let CLAUDE_SETTINGS_LAYERS: [ClaudeSettingsLayer] = [.managed, .local, .project, .user]

/// What decides a default, read on the Agent's machine.
public struct ClaudeDefaultInputs: Sendable {
    /// Each settings file's parsed contents; a file that is not there is absent.
    public var settings: [ClaudeSettingsLayer: JsonValue]
    /// The environment the CLI starts in: the machine's, with the profile's over it.
    public var env: [String: String]
    /// The profile's own arguments, which the CLI is started with.
    public var args: [String]

    public init(settings: [ClaudeSettingsLayer: JsonValue] = [:], env: [String: String] = [:], args: [String] = []) {
        self.settings = settings
        self.env = env
        self.args = args
    }
}

/// Where a default comes from.
public enum CliDefaultSource: Hashable, Sendable {
    case argument
    case environment
    case layer(ClaudeSettingsLayer)
    case builtIn

    /// As the wire spells it: `argument`, `environment`, a layer's name, `built-in`.
    public var wire: String {
        switch self {
        case .argument: return "argument"
        case .environment: return "environment"
        case .layer(let layer): return layer.rawValue
        case .builtIn: return "built-in"
        }
    }
}

/// A setting's default for new sessions.
public struct CliDefault: Hashable, Sendable {
    /// The value: a model alias or name, an effort level. Nil for a model
    /// nothing set (the account's default, the choice `default`) and for an
    /// effort whose model is not known.
    public var value: String?
    public var source: CliDefaultSource

    public init(value: String? = nil, source: CliDefaultSource) {
        self.value = value
        self.source = source
    }
}

/// The CLIs whose defaults DevHub reads and changes (`CliName` in
/// model/cliDefaults.ts).
public enum CliName: String, Hashable, Sendable {
    case claude, codex

    /// How the CLI is called in a sentence (`CLI_WORDS`).
    public var words: String {
        switch self {
        case .claude: return "Claude Code"
        case .codex: return "Codex"
        }
    }
}

/// Both defaults, as Core hands them to the view, and which CLI's they are
/// (`CliDefaults` in model/cliDefaults.ts).
public struct CliDefaults: Hashable, Sendable {
    public var cli: CliName
    /// Where a change is saved, as a person reads it — "~/.claude/settings.json",
    /// "~/.codex/config.toml", or the profile table of it that Codex reads.
    public var savedIn: String
    public var model: CliDefault
    public var effort: CliDefault

    public init(cli: CliName = .claude, savedIn: String = "~/.claude/settings.json", model: CliDefault, effort: CliDefault) {
        self.cli = cli
        self.savedIn = savedIn
        self.model = model
        self.effort = effort
    }
}

/// The effort levels a settings file takes (`max` is a session's only).
public let SAVABLE_EFFORTS = ["low", "medium", "high", "xhigh"]

/// The suffix that picks a model's 1M token context window: not a model of its own.
private let LONG_CONTEXT = "[1m]"

/// The value of the last `--flag value` or `--flag=value` in `args`, as the
/// CLI's parser reads a flag given twice.
public func argumentValue(_ args: [String], _ flag: String) -> String? {
    var value: String?
    for (index, arg) in args.enumerated() {
        if arg == flag && index + 1 < args.count {
            value = args[index + 1]
        } else if arg.hasPrefix("\(flag)=") {
            value = String(arg.dropFirst(flag.count + 1))
        }
    }
    return value
}

private func objectOf(_ value: JsonValue?) -> JsonObject {
    if case .object(let object)? = value { return object }
    return [:]
}

private func nonEmpty(_ value: String?) -> String? {
    guard let value else { return nil }
    let trimmed = jsTrim(value)
    return trimmed.isEmpty ? nil : trimmed
}

private func nonEmpty(_ value: JsonValue?) -> String? {
    guard case .string(let text)? = value else { return nil }
    return nonEmpty(text)
}

/// The model a new session starts on (see the file's head).
public func claudeModelDefault(_ inputs: ClaudeDefaultInputs) -> CliDefault {
    if let argument = nonEmpty(argumentValue(inputs.args, "--model")) {
        return CliDefault(value: argument, source: .argument)
    }
    if let environment = nonEmpty(inputs.env["ANTHROPIC_MODEL"]) {
        return CliDefault(value: environment, source: .environment)
    }
    for layer in CLAUDE_SETTINGS_LAYERS {
        if let value = nonEmpty(objectOf(inputs.settings[layer])["model"]) {
            return CliDefault(value: value, source: .layer(layer))
        }
    }
    return CliDefault(source: .builtIn)
}

/// The effort a model starts at when nothing chose one, as model-config's
/// "Adjust effort level" lists it; nil for no model.
public func builtInEffort(_ model: String?) -> String? {
    guard let model else { return nil }
    if model.contains("opus-5-5") || model.contains("sonnet-5-5") { return "medium" }
    if model.contains("opus-4-7") { return "xhigh" }
    return "high"
}

/// The names `modelSettings` may save `model` under: as given, and without its context window.
private func modelKeys(_ model: String?) -> [String] {
    guard let model else { return [] }
    return model.hasSuffix(LONG_CONTEXT) ? [model, String(model.dropLast(LONG_CONTEXT.count))] : [model]
}

/// The effort a new session of `model` (its full name, when known) starts at
/// (see the file's head). `auto` in the environment is the model's default.
public func claudeEffortDefault(_ inputs: ClaudeDefaultInputs, _ model: String?) -> CliDefault {
    if let environment = nonEmpty(inputs.env["CLAUDE_CODE_EFFORT_LEVEL"]) {
        let value = environment == "auto" ? builtInEffort(model) : environment
        return CliDefault(value: value, source: .environment)
    }
    if let argument = nonEmpty(argumentValue(inputs.args, "--effort")) {
        return CliDefault(value: argument, source: .argument)
    }
    for layer in CLAUDE_SETTINGS_LAYERS {
        let saved = objectOf(objectOf(inputs.settings[layer])["modelSettings"])
        for key in modelKeys(model) {
            if let value = nonEmpty(objectOf(saved[key])["effortLevel"]) {
                return CliDefault(value: value, source: .layer(layer))
            }
        }
    }
    for layer in CLAUDE_SETTINGS_LAYERS {
        if let value = nonEmpty(objectOf(inputs.settings[layer])["effortLevel"]) {
            return CliDefault(value: value, source: .layer(layer))
        }
    }
    return CliDefault(value: builtInEffort(model), source: .builtIn)
}

public func claudeDefaults(_ inputs: ClaudeDefaultInputs, _ model: String?) -> CliDefaults {
    CliDefaults(model: claudeModelDefault(inputs), effort: claudeEffortDefault(inputs, model))
}

/// Whether a default from `source` is what a change to the user settings
/// decides: it is the user settings' own, or nothing above them set one.
public func userSettingsDecide(_ source: CliDefaultSource) -> Bool {
    source == .layer(.user) || source == .builtIn
}

/// How `source` reads, after "set by", for `defaults`' CLI: the user's own
/// is the file a change goes to (`sourceWords` in model/cliDefaults.ts).
public func sourceWords(_ defaults: CliDefaults, _ source: CliDefaultSource) -> String {
    switch (defaults.cli, source) {
    case (_, .layer(.user)): return defaults.savedIn
    case (_, .builtIn): return defaults.cli.words
    case (.claude, .argument): return "the Agent profile's arguments"
    case (.codex, .argument): return "the Agent profile's arguments (-c)"
    case (.claude, .environment): return "the environment"
    case (.claude, .layer(.managed)): return "managed settings"
    case (.claude, .layer(.local)): return "this project's .claude/settings.local.json"
    case (.claude, .layer(.project)): return "this project's .claude/settings.json"
    default: return source.wire
    }
}

/// Why `effort` cannot be saved as `cli`'s default, or nil when it can:
/// Claude Code's settings keep the levels `SAVABLE_EFFORTS` names (`max` is a
/// session's only); Codex keeps any level its model list offers.
public func unsavableEffort(_ cli: CliName, _ effort: String) -> String? {
    if cli == .claude && !SAVABLE_EFFORTS.contains(effort) {
        return "Claude Code's settings do not keep \(effort) as a default: it is for one session only"
    }
    return nil
}

public enum ClaudeDefaultName: String, Hashable, Sendable {
    case model, effort
}

/// A change to a default that cannot be made, and why.
public struct ClaudeDefaultRefused: Error, CustomStringConvertible, Equatable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

/// The user settings file's text with `which`'s default made `value`, every
/// other key kept. `model` names the model an effort is saved for (its full
/// name; a context-window suffix is not part of it); without one the effort
/// is the top-level `effortLevel`. `text` is the file as it is, or nil when
/// there is none. A file that is not a JSON object is refused rather than
/// written over: it is the person's, and DevHub cannot keep what it cannot
/// read.
public func withUserDefault(_ text: String?, _ which: ClaudeDefaultName, _ value: String, model: String? = nil) throws
    -> String
{
    var settings: JsonObject = [:]
    if let text, !jsTrim(text).isEmpty {
        let parsed: JsonValue
        do {
            parsed = try JsonValue.parse(text)
        } catch {
            throw ClaudeDefaultRefused(
                "Claude Code's user settings are not valid JSON, so DevHub leaves them as they are: \(error)")
        }
        guard case .object(let object) = parsed else {
            throw ClaudeDefaultRefused(
                "Claude Code's user settings are not a JSON object, so DevHub leaves them as they are")
        }
        settings = object
    }
    if jsTrim(value).isEmpty { throw ClaudeDefaultRefused("a \(which.rawValue) default cannot be empty") }
    switch which {
    case .model:
        settings["model"] = .string(value)
    case .effort:
        guard SAVABLE_EFFORTS.contains(value) else {
            throw ClaudeDefaultRefused(
                "Claude Code's settings take \(SAVABLE_EFFORTS.joined(separator: ", ")) as a default effort, not \(value): \(value == "max" ? "max is for one session only" : "it is not a level")"
            )
        }
        let key = model.map { $0.hasSuffix(LONG_CONTEXT) ? String($0.dropLast(LONG_CONTEXT.count)) : $0 }
        if let key {
            var saved = objectOf(settings["modelSettings"])
            var forModel = objectOf(saved[key])
            forModel["effortLevel"] = .string(value)
            saved[key] = .object(forModel)
            settings["modelSettings"] = .object(saved)
        } else {
            settings["effortLevel"] = .string(value)
        }
    }
    return "\(JsonValue.object(settings).jsonText(indent: 2))\n"
}

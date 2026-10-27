// The reading half of apps/desktop/src/shell/conversation/SettingPickers.tsx.
//
// The session's settings, as the pickers in the composer's toolbar. The
// pickers list the session's own choices (`SessionFacts`), so the view offers
// exactly what the adapter says this CLI accepts and nothing it had to
// guess. A picker shows the session's current value and nothing else: a
// change is asked for, and the picker moves when the session says it has
// moved. While the session has not named a value, the picker says so in
// words rather than standing empty, and a setting the session gave nothing to
// choose from says why it can't be changed (`unchangeable`).
//
// Beside the rows of the model and the effort, the picker also says which one
// the CLI's *new* sessions start on (`CliDefaults`), with a mark at the
// row's right end, and every other row can be made that default: the CLI's
// own user settings are changed — Claude Code's `settings.json`, as its own
// `/model` and `/effort` save them in a terminal; Codex's `config.toml`, as
// its own model picker saves them — and this session is left where it is.
// When something above the user settings decides the default (the profile's
// arguments, the environment, managed, local or project settings), the mark
// and the button say so: a default saved then does not take effect until
// that is gone.

import Foundation

/// What a picker of a setting with a CLI's default is given of it.
public struct DefaultOffer: Hashable, Sendable {
    /// Both defaults, and which CLI's they are.
    public var defaults: CliDefaults
    /// This setting's.
    public var known: CliDefault

    public init(defaults: CliDefaults, known: CliDefault) {
        self.defaults = defaults
        self.known = known
    }
}

public enum SettingPickerModel {
    public static let names: [SettingName] = [.model, .effort, .mode]

    public static func label(_ name: SettingName) -> String {
        switch name {
        case .model: return "Model"
        case .effort: return "Effort"
        case .mode: return "Permissions"
        }
    }

    /// What a picker says while its session has not named its value and nothing else tells it.
    public static func unknownValue(_ name: SettingName) -> String {
        switch name {
        case .model, .mode: return "Not known yet"
        case .effort: return "CLI's default"
        }
    }

    static func unknownHint(_ name: SettingName) -> String {
        switch name {
        case .model:
            return "No turn has started, and the Agent's handshake has not yet listed the account's default model, so which model it starts on is not known yet"
        case .effort:
            return "No effort was chosen here, and the Agent does not report the one it runs at: it is the CLI's own, from --effort, its environment, its settings or the model's default"
        case .mode:
            return "The Agent names its permissions when its first turn starts"
        }
    }

    public static func hasDefault(_ name: SettingName) -> Bool { name == .model || name == .effort }

    public static func defaultName(_ name: SettingName) -> ClaudeDefaultName? {
        switch name {
        case .model: return .model
        case .effort: return .effort
        case .mode: return nil
        }
    }

    public static func known(_ name: SettingName, _ defaults: CliDefaults?) -> DefaultOffer? {
        guard let defaults else { return nil }
        switch name {
        case .model: return DefaultOffer(defaults: defaults, known: defaults.model)
        case .effort: return DefaultOffer(defaults: defaults, known: defaults.effort)
        case .mode: return nil
        }
    }

    /// The row that is the CLI's default: the one of that value, else the one
    /// that resolves to it; a value nothing set is the CLI's own default,
    /// which Claude lists as the choice `default` and Codex marks
    /// (`builtInDefault`).
    public static func defaultRow(_ rows: [SettingChoice], _ known: CliDefault) -> SettingChoice? {
        if known.value == nil && known.source == .builtIn {
            return rows.first { $0.id == "default" } ?? rows.first { $0.builtInDefault }
        }
        let value = known.value ?? ""
        return rows.first { $0.id == value } ?? rows.first { $0.resolved != nil && $0.resolved == value }
    }

    /// A model's short name: `claude-opus-5-5[1m]` is "Opus 5.5 (1M)", `claude-haiku-4-5-20251001` "Haiku 4.5".
    public static func shortModelName(_ model: String) -> String {
        let long = model.hasSuffix("[1m]")
        let name = long ? String(model.dropLast(4)) : model
        let regex = try! NSRegularExpression(pattern: "^claude-([a-z]+)-([0-9]+)(?:-([0-9]{1,2}))?(?:-[0-9]{8})?$")
        let ns = name as NSString
        guard let match = regex.firstMatch(in: name, range: NSRange(location: 0, length: ns.length)) else { return model }
        let family = ns.substring(with: match.range(at: 1))
        let major = ns.substring(with: match.range(at: 2))
        let minor = match.range(at: 3).location == NSNotFound ? nil : ns.substring(with: match.range(at: 3))
        let words = family.prefix(1).uppercased() + family.dropFirst() + " " + major + (minor.map { ".\($0)" } ?? "")
        return long ? "\(words) (1M)" : words
    }

    /// The full name of the model new sessions start on.
    public static func defaultModelName(_ setting: Setting, _ known: CliDefault?) -> String? {
        guard let known else { return nil }
        return defaultRow(setting.choices, known)?.resolved ?? known.value
    }

    /// What a model nothing named yet reads as: "Default (Opus 5.5 (1M))".
    public static func defaultModelWords(_ setting: Setting, _ known: CliDefault?) -> String? {
        defaultModelName(setting, known).map { "Default (\(shortModelName($0)))" }
    }

    /// Where a default comes from, in the words a hint says it.
    public static func sourceSentence(_ offer: DefaultOffer) -> String {
        offer.known.source == .builtIn
            ? "\(offer.defaults.cli.words)'s own default" : "set by \(sourceWords(offer.defaults, offer.known.source))"
    }

    /// Why making a row the default would not take effect now — something
    /// above the user settings decides it — or nil when it would.
    public static func shadowedBy(_ offer: DefaultOffer) -> String? {
        userSettingsDecide(offer.known.source)
            ? nil
            : "\(sourceWords(offer.defaults, offer.known.source)) sets the default now, so new sessions keep that until it is gone"
    }

    public static func unknownEffort(_ known: CliDefault?) -> String {
        guard let value = known?.value else { return unknownValue(.effort) }
        return "\(unknownValue(.effort)) (\(value))"
    }

    /// The full name of the session's model, as an effort is saved for it.
    public static func modelName(_ session: SessionFacts) -> String? {
        guard let current = session.model.current else { return nil }
        return session.model.choices.first { $0.id == current }?.resolved ?? current
    }

    /// The hint of a value nothing named.
    public static func unknownHint(_ name: SettingName, _ offer: DefaultOffer?, _ setting: Setting) -> String {
        if name == .model, let offer, let model = defaultModelName(setting, offer.known) {
            let from = offer.known.source == .builtIn
                ? "the account's default, as \(offer.defaults.cli.words)'s handshake lists it" : sourceSentence(offer)
            return "No turn has started, so the Agent has not named its model yet: new sessions start on \(model) (\(from))"
        }
        guard name == .effort, let offer, let value = offer.known.value else { return unknownHint(name) }
        return "No effort was chosen here, so the Agent runs at the CLI's own, which resolves to \(value) (\(sourceSentence(offer))). \(offer.defaults.cli.words) does not report it, so this is what it started with."
    }

    /// Whether a setting has anything to show: an effort the model is known not to take does not.
    public static func shown(_ name: SettingName, _ session: SessionFacts) -> Bool {
        let setting = self.setting(name, session)
        return !(name == .effort && setting.choices.isEmpty && setting.current == nil && setting.unchangeable == nil
            && session.model.current != nil)
    }

    public static func setting(_ name: SettingName, _ session: SessionFacts) -> Setting {
        switch name {
        case .model: return session.model
        case .effort: return session.effort
        case .mode: return session.mode
        }
    }

    /// The rows a picker lists: the session's choices, and a current value they do not name ahead of them.
    public static func rows(_ setting: Setting) -> [SettingChoice] {
        guard let current = setting.current, !setting.choices.contains(where: { $0.id == current }) else {
            return setting.choices
        }
        return [SettingChoice(id: current, label: current)] + setting.choices
    }

    /// The value the face of a picker reads.
    public static func value(_ name: SettingName, _ setting: Setting, _ offer: DefaultOffer?) -> String {
        if let row = rows(setting).first(where: { $0.id == setting.current }) { return row.label }
        switch name {
        case .effort: return unknownEffort(offer?.known)
        case .model: return defaultModelWords(setting, offer?.known) ?? unknownValue(.model)
        case .mode: return unknownValue(.mode)
        }
    }

    /// Why a row cannot be made the default, or nil when it can.
    public static func notSavable(_ name: SettingName, _ row: SettingChoice, _ offer: DefaultOffer) -> String? {
        name == .effort ? unsavableEffort(offer.defaults.cli, row.id) : nil
    }

    public static func makeDefaultTitle(_ offer: DefaultOffer) -> String {
        "Make this the default for new sessions, in \(offer.defaults.savedIn). This session is not changed. (⌥↩)"
    }

    /// The tooltip of a row's "Make default".
    public static func makeDefaultTip(_ name: SettingName, _ row: SettingChoice, _ offer: DefaultOffer) -> String {
        notSavable(name, row, offer)
            ?? [makeDefaultTitle(offer), shadowedBy(offer)].compactMap { $0 }.joined(separator: " — ")
    }

    public static func defaultTip(_ offer: DefaultOffer) -> String { "New sessions start on this: \(sourceSentence(offer))" }

    /// What opening a picker that cannot take a change says.
    public static func refusedOpen(_ name: SettingName) -> String {
        "The \(label(name)) picker can't be opened until the Agent can take a change"
    }
}

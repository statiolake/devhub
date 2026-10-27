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
// the CLI's *new* sessions start on (`claudeDefaults`), with a mark at the
// row's right end, and every other row can be made that default: Claude
// Code's user settings are changed, as its own `/model` and `/effort` save
// them, and this session is left where it is. When something above the user
// settings decides the default, the mark and the button say so.

import Foundation

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

    public static func known(_ name: SettingName, _ defaults: CliDefaults?) -> CliDefault? {
        switch name {
        case .model: return defaults?.model
        case .effort: return defaults?.effort
        case .mode: return nil
        }
    }

    /// The row that is the CLI's default: the one of that value, else the one that resolves to it.
    public static func defaultRow(_ rows: [SettingChoice], _ known: CliDefault) -> SettingChoice? {
        let value = known.value ?? (known.source == .builtIn ? "default" : "")
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

    public static func sourceSentence(_ known: CliDefault) -> String {
        known.source == .builtIn ? "Claude Code's own default" : "set by \(sourceWords(known.source))"
    }

    /// Why making a row the default would not take effect now, or nil when it would.
    public static func shadowedBy(_ known: CliDefault) -> String? {
        userSettingsDecide(known.source)
            ? nil : "\(sourceWords(known.source)) sets the default now, so new sessions keep that until it is gone"
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
    public static func unknownHint(_ name: SettingName, _ known: CliDefault?, _ setting: Setting) -> String {
        if name == .model, let known, let model = defaultModelName(setting, known) {
            let from = known.source == .builtIn
                ? "the account's default, as Claude Code's handshake lists it" : sourceSentence(known)
            return "No turn has started, so the Agent has not named its model yet: new sessions start on \(model) (\(from))"
        }
        guard name == .effort, let known, let value = known.value else { return unknownHint(name) }
        return "No effort was chosen here, so the Agent runs at the CLI's own, which resolves to \(value) (\(sourceSentence(known))). Claude does not report it, so this is what it started with."
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
    public static func value(_ name: SettingName, _ setting: Setting, _ known: CliDefault?) -> String {
        if let row = rows(setting).first(where: { $0.id == setting.current }) { return row.label }
        switch name {
        case .effort: return unknownEffort(known)
        case .model: return defaultModelWords(setting, known) ?? unknownValue(.model)
        case .mode: return unknownValue(.mode)
        }
    }

    /// Why a row cannot be made the default, or nil when it can.
    public static func notSavable(_ name: SettingName, _ row: SettingChoice) -> String? {
        name == .effort && !SAVABLE_EFFORTS.contains(row.id)
            ? "Claude Code's settings do not keep \(row.id) as a default: it is for one session only" : nil
    }

    public static let makeDefaultTitle =
        "Make this the default for new sessions, in ~/.claude/settings.json. This session is not changed. (⌥↩)"

    /// The tooltip of a row's "Make default".
    public static func makeDefaultTip(_ name: SettingName, _ row: SettingChoice, _ known: CliDefault) -> String {
        notSavable(name, row) ?? [makeDefaultTitle, shadowedBy(known)].compactMap { $0 }.joined(separator: " — ")
    }

    public static func defaultTip(_ known: CliDefault) -> String { "New sessions start on this: \(sourceSentence(known))" }

    /// What opening a picker that cannot take a change says.
    public static func refusedOpen(_ name: SettingName) -> String {
        "The \(label(name)) picker can't be opened until the Agent can take a change"
    }
}

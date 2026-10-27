// Port of the model halves of apps/desktop/src/settings/SettingsApp.tsx and
// apps/desktop/src/settings/sections.tsx: the sections and the part of the
// configuration each owns, and every edit a screen makes to the draft — the
// collections' add/remove/move, a source switched to another kind, a profile
// switched to a kind with no GUI, the keyboard's rebind and reset, the
// socket's question.
//
// A preferences window on a Mac has no document to save, so a change is
// applied when it is made (`SettingsSession`); these are the changes.

import Foundation

/// The sections, in the order they are shown.
public enum SettingsSection: String, CaseIterable, Sendable {
    case general = "General"
    case workspaces = "Workspaces"
    case agents = "Agents"
    case actions = "Actions"
    case keyboard = "Keyboard"
    case terminal = "Terminal"
    case advanced = "Advanced"

    /// Which part of the configuration each screen owns, for "reset this
    /// screen". The socket is on Terminal but lives under `runtimes`, which
    /// is Advanced's: resetting a font must not move the sessions.
    public var scope: [ConfigScopeKey] {
        switch self {
        case .general: return [.general, .agents, .scratch, .projects]
        case .workspaces: return [.workspaceSources]
        case .agents: return [.agentProfiles]
        case .actions: return [.agentActions]
        case .keyboard: return [.keybindings]
        case .terminal: return [.appearance]
        case .advanced: return [.runtimes]
        }
    }

    /// What the reset link calls the screen's settings.
    public var resetName: String {
        switch self {
        case .general: return "general settings"
        case .workspaces: return "workspace sources"
        case .agents: return "agent profiles"
        case .actions: return "agent actions"
        case .keyboard: return "keyboard shortcuts"
        case .terminal: return "terminal settings"
        case .advanced: return "advanced settings"
        }
    }
}

public enum SettingsEdits {
    public static let presentationNames: [AgentPresentation: String] = [.tui: "Terminal (TUI)", .gui: "GUI"]

    /// The first `prefix-n` nobody is using, so a new entry is never a duplicate.
    public static func freeId(_ prefix: String, taken: [String]) -> String {
        var n = 1
        while taken.contains("\(prefix)-\(n)") { n += 1 }
        return "\(prefix)-\(n)"
    }

    /// A variable name nobody is using (underscores, not dashes).
    public static func freeEnvName(_ taken: [String]) -> String {
        var n = 1
        while taken.contains("VARIABLE_\(n)") { n += 1 }
        return "VARIABLE_\(n)"
    }

    // MARK: Workspace sources

    /// A source of a given kind with something valid in every field: the Add
    /// button and the kind popup make the same source.
    public static func emptySource(_ type: String, id: String) -> WorkspaceSource {
        switch type {
        case "command": return .command(CommandSource(id: id, command: [""], timeoutMs: 2000))
        case "date": return .date(DateSource(id: id, path: "~/workspace/daily/YYYY/MMDD", createIfMissing: true))
        default:
            return .filesystem(FilesystemSource(
                id: id, path: "~", minDepth: 1, maxDepth: 2, kinds: [.gitRepository], includeHidden: false, excludeNames: []))
        }
    }

    /// What a source's row says under its name: the thing it is about.
    public static func sourceNote(_ source: WorkspaceSource) -> String {
        switch source {
        case let .command(command): return command.command.joined(separator: " ")
        case let .filesystem(filesystem): return filesystem.path
        case let .date(date): return date.path
        }
    }

    public static func addSource(_ config: Config) -> (config: Config, selected: Int) {
        var next = config
        next.workspaceSources.append(emptySource("filesystem", id: freeId("source", taken: config.workspaceSources.map(\.id))))
        return (next, next.workspaceSources.count - 1)
    }

    /// One row: the depth range as one decision (a maximum below the minimum
    /// follows it up).
    public static func depth(_ source: FilesystemSource, minDepth: Double) -> FilesystemSource {
        var next = source
        next.minDepth = minDepth
        if let max = source.maxDepth, max < minDepth { next.maxDepth = minDepth }
        return next
    }

    // MARK: Agent profiles

    public static func addProfile(_ config: Config) -> (config: Config, selected: Int) {
        var next = config
        next.agentProfiles.append(ConfiguredAgentProfile(
            id: freeId("agent", taken: config.agentProfiles.map(\.id)), displayName: "New Agent", kind: .codex, command: "codex"))
        return (next, next.agentProfiles.count - 1)
    }

    /// A kind with no GUI takes the profile back to the terminal, rather than
    /// keeping a presentation the file would refuse.
    public static func kind(_ profile: ConfiguredAgentProfile, _ kind: AgentProfileKind) -> ConfiguredAgentProfile {
        var next = profile
        next.kind = kind
        if let presentation = profile.presentation, !kind.presentations.contains(presentation) { next.presentation = .tui }
        return next
    }

    /// What `Default` comes to for a kind.
    public static func defaultPresentation(_ kind: AgentProfileKind, wanted: AgentPresentation) -> AgentPresentation {
        kind.presentations.contains(wanted) ? wanted : .tui
    }

    /// The Show as popup's options: Default (what it comes to), then each one the kind has.
    public static func presentationOptions(_ kind: AgentProfileKind, defaults: AgentsConfig) -> [(id: String, label: String)] {
        let resolved = defaultPresentation(kind, wanted: defaults.defaultPresentation)
        return [("default", "Default (\(presentationNames[resolved]!))")]
            + kind.presentations.map { ($0.rawValue, presentationNames[$0]!) }
    }

    // MARK: Agent actions

    /// The id a new action gets, and the only place one is ever chosen.
    public static func newActionId() -> String { "action-\(UUID().uuidString.lowercased())" }

    /// Add an action at the end of the selected one's group.
    public static func addAction(_ config: Config, selectedTrigger: AgentActionTrigger, id: String = newActionId())
        -> (config: Config, selected: Int)
    {
        var actions = SheetRows.actionsInTreeOrder(config.agentActions)
        let last = actions.lastIndex { $0.trigger == selectedTrigger }
        let at = last.map { $0 + 1 } ?? actions.count
        actions.insert(ConfiguredAgentAction(
            trigger: selectedTrigger, id: id, displayName: "New action",
            template: "{{\(selectedTrigger.variables.first ?? "BRANCH")}}\n", confirmBeforeSend: true,
            button: selectedTrigger.isSmartButton, enabled: true, order: 0), at: at)
        var next = config
        next.agentActions = renumbered(actions)
        return (next, at)
    }

    /// Move the selected action one place, within its group only.
    public static func moveAction(_ config: Config, selected: Int, by direction: Int) -> (config: Config, selected: Int)? {
        var actions = SheetRows.actionsInTreeOrder(config.agentActions)
        let target = selected + direction
        guard selected >= 0, selected < actions.count, target >= 0, target < actions.count,
              actions[target].trigger == actions[selected].trigger
        else { return nil }
        actions.swapAt(selected, target)
        var next = config
        next.agentActions = renumbered(actions)
        return (next, target)
    }

    /// The position in the list is the `order` written down, per trigger.
    public static func renumbered(_ actions: [ConfiguredAgentAction]) -> [ConfiguredAgentAction] {
        var counts: [AgentActionTrigger: Double] = [:]
        return actions.map { action in
            var copy = action
            copy.order = counts[action.trigger] ?? 0
            counts[action.trigger] = copy.order + 1
            return copy
        }
    }

    /// An action moved onto a Smart Button trigger is drawn as one unless it
    /// already said otherwise there; onto the Issue flow it has no button.
    public static func trigger(_ action: ConfiguredAgentAction, _ trigger: AgentActionTrigger) -> ConfiguredAgentAction {
        var next = action
        next.trigger = trigger
        next.button = trigger.isSmartButton && (!action.trigger.isSmartButton || action.button)
        return next
    }

    /// The Message group's note: which variables this trigger offers.
    public static func messageNote(_ trigger: AgentActionTrigger) -> String {
        let names = trigger.variables.map { "{{\($0)}}" }
        let variables: String
        if names.isEmpty {
            variables = "This message takes no variables."
        } else {
            let listed = names.count <= 1 ? names.joined() : "\(names.dropLast().joined(separator: ", ")) and \(names.last!)"
            variables = "\(listed) \(names.count == 1 ? "is" : "are") replaced when it is sent."
        }
        return "\(variables) A line starting $name runs a skill: Claude Code is sent /name, Codex is sent $name, and an agent DevHub has no manifest for is sent the line as written."
    }

    /// The wording DevHub ships for this action, for an emptied message's placeholder.
    public static func templatePlaceholder(_ action: ConfiguredAgentAction) -> String {
        AgentActions.builtIn.first { $0.id == action.id }?.template ?? AgentActions.defaultActionTemplate
    }

    // MARK: The keyboard

    /// What each command is bound to now, and what it ships bound to.
    public struct KeyboardRow: Equatable, Sendable {
        public var command: CommandDefinition
        public var keys: [ChordKey]
        public var defaults: [ChordKey]

        public var atDefault: Bool {
            keys.map(ChordKeys.id).sorted() == defaults.map(ChordKeys.id).sorted()
        }
    }

    public static func keyboardRows(_ keybindings: KeybindingsSpec) -> [KeyboardRow] {
        let bindings = Commands.resolve(keybindings).bindings
        return Commands.all.map { command in
            KeyboardRow(
                command: command, keys: Commands.keys(for: command.id, in: bindings),
                defaults: command.defaultKeys.compactMap { try? ChordKeys.parse($0) })
        }
    }

    /// Which command a key reaches now.
    public static func owner(of key: ChordKey, in rows: [KeyboardRow]) -> CommandDefinition? {
        rows.first { row in row.keys.contains { ChordKeys.id($0) == ChordKeys.id(key) } }?.command
    }

    /// The override table, with one command's keys replaced by one new key: a
    /// shipped key is written as an unbind, an override is removed.
    public static func rebind(_ keybindings: KeybindingsSpec, command: CommandDefinition, keys: [ChordKey], to next: ChordKey?)
        -> KeybindingsSpec
    {
        var chords = keybindings.chords
        for key in keys {
            let written = ChordKeys.format(key)
            if command.defaultKeys.contains(written) { chords[written] = "" } else { chords[written] = nil }
        }
        if let next { chords[ChordKeys.format(next)] = command.id.rawValue }
        var spec = keybindings
        spec.chords = chords
        return spec
    }

    /// The override table with everything this command said taken out of it.
    public static func resetBinding(_ keybindings: KeybindingsSpec, command: CommandDefinition) -> KeybindingsSpec {
        var chords = OrderedStringMap()
        for (key, id) in keybindings.chords {
            if id == command.id.rawValue { continue }
            if id.isEmpty && command.defaultKeys.contains(key) { continue }
            chords[key] = id
        }
        var spec = keybindings
        spec.chords = chords
        return spec
    }

    /// What taking a key from another command says, before the save.
    public static func conflict(_ key: ChordKey, owner: CommandDefinition?, command: CommandDefinition) -> String? {
        guard let owner, owner.id != command.id else { return nil }
        return "\(ChordKeys.describe(key)) currently does “\(owner.label)”. It does this instead now."
    }

    public static let keyboardProblems: [KeybindingProblem.Code: String] = [
        .invalidKey: SettingsRules.chordKeyRule,
        .unknownCommand: "That is not a command DevHub has.",
        .duplicateKey: "Two spellings of one key. A key can only do one thing.",
    ]

    public static func needsNote(_ needs: CommandNeeds) -> String? {
        switch needs {
        case .nothing: return nil
        case .workspace: return "Needs a workspace selected."
        case .agent: return "Needs an agent selected."
        case .split: return "Needs the editor and an Agent side by side."
        }
    }

    // MARK: The terminal

    /// `-u` and `-2`, on or off, kept in the order they were set.
    public static func tmuxArgument(_ runtimes: RuntimeConfig, _ option: String, on: Bool) -> RuntimeConfig {
        var next = runtimes
        next.tmuxArgs = runtimes.tmuxArgs.filter { $0 != option } + (on ? [option] : [])
        return next
    }

    /// The question a socket change asks, in the words of the situation.
    public struct SocketQuestion: Equatable, Sendable {
        public var title: String
        public var message: String
        public var confirm: String
        public var consequence: String
    }

    public static func socketQuestion(_ preflight: TerminalPreflight?, requested name: String) -> SocketQuestion {
        let restarted = "Your current sessions are closed and recreated there, so what is running in them stops."
        guard let preflight, preflight.state != .notChecked else {
            return SocketQuestion(
                title: "Move DevHub's terminals to “\(name)”?", message: "DevHub could not see what is on that socket.",
                confirm: "Move the terminals",
                consequence: "Your current sessions are closed, and DevHub tries to recreate them there.")
        }
        switch preflight.state {
        case .targetAbsent:
            return SocketQuestion(
                title: "Move DevHub's terminals to “\(name)”?", message: "No tmux server is running there yet.",
                confirm: "Move the terminals", consequence: restarted)
        case .targetDevhubEmpty:
            return SocketQuestion(
                title: "Move DevHub's terminals to “\(name)”?", message: "A DevHub tmux server is already there with no sessions.",
                confirm: "Move the terminals", consequence: restarted)
        case .markedSessions:
            let count = preflight.ownedSessionCount
            return SocketQuestion(
                title: "Adopt the DevHub sessions on “\(name)”?",
                message: "That socket already has \(count) DevHub \(count == 1 ? "session" : "sessions") from another run.",
                confirm: "Adopt them", consequence: "DevHub takes them over, and the sessions on the current socket are closed.")
        case .wrongMarker:
            let count = preflight.unknownSessionCount
            return SocketQuestion(
                title: "“\(name)” belongs to another tmux server.",
                message: "There \(count == 1 ? "is" : "are") \(count) \(count == 1 ? "session" : "sessions") there that DevHub did not create. Choose a socket name of its own.",
                confirm: "Move there anyway",
                consequence: "DevHub will not touch the sessions it did not create. Your current sessions are closed and recreated there.")
        case .notChecked:
            return socketQuestion(nil, requested: name)
        }
    }

    public static let changeSocketRow = "devhub:change-socket"
    public static let resetSettingsRow = "devhub:reset-settings"

    public static func socketPrompt(_ preflight: TerminalPreflight?, requested: String) -> PickerPrompt {
        let question = socketQuestion(preflight, requested: requested)
        return PickerPrompt(
            title: question.title, question: question.message,
            items: [PickerItem(id: changeSocketRow, label: question.confirm, detail: question.consequence)],
            details: [
                PickerFact("DevHub sessions there", String(preflight?.ownedSessionCount ?? 0)),
                PickerFact("Other sessions there", String(preflight?.unknownSessionCount ?? 0)),
            ],
            cancelRow: PickerCancelRow(
                label: "Keep the current socket", detail: "DevHub stays on the socket it is on. Nothing is closed."))
    }

    /// `ResetLink`'s question.
    public static func resetPrompt(_ what: String) -> PickerPrompt {
        PickerPrompt(
            title: "Reset \(what) to defaults?",
            question: "This writes DevHub's default \(what) into settings.toml. The rest of the file is left as it is.",
            items: [PickerItem(
                id: resetSettingsRow, label: "Reset \(what)",
                detail: "Whatever \(what) you have set is replaced by DevHub's, and putting it back means typing it again.")],
            cancelRow: PickerCancelRow(
                label: "Keep these settings", detail: "Nothing is written. The file is left exactly as it is."))
    }

    /// The note a retired key leaves in the window.
    public static func retiredNote(_ notice: RetiredKeyNotice) -> String {
        "“\(notice.key)” is no longer used and is ignored — \(notice.replacement). The next change you make here drops it from \(SettingsRules.fileName)."
    }
}

// Port of apps/desktop/src/model/commands.ts — the registry, the default chord
// table and the `[keybindings]` rules (check, resolve, keys for a command).
// What each command *does* (`resolveChord` in `model/coordinator.ts`) is WP2's.
//
// Every command a DevHub chord can raise, in one list.
//
// Command-Q is DevHub's prefix, the way Ctrl-Q is the prefix in the terminal
// multiplexer this app is meant to replace. Every DevHub-level command is a
// two-stroke chord: Command-Q, then one ordinary key. Nothing is a single
// shortcut, because DevHub's surfaces are whole applications — a terminal, a
// Neovim — and a single key taken from them is a key their own users lose.
//
// # Why a registry, and not a table of key→behaviour
//
// Three things have to agree about the same set: the dispatcher that runs a
// chord, the configuration file that rebinds one, and the Settings window that
// lists them. So the *command* is the thing with an identity — a snake_case id
// DevHub owns — and a key is only ever a way to reach one:
//
// - **Many keys may name one command; one key may never name two.**
// - The help overlay is rendered from this list, so it cannot be out of date.
// - A configuration naming an id that is not here is a diagnostic rather than
//   a silently dead binding.
//
// # The default table
//
// | Chord                       | Command                   |
// | --------------------------- | ------------------------- |
// | `Cmd+Q Cmd+Q`               | `forward_prefix`          |
// | `Cmd+Q Shift+N` / `Shift+P` | `next_workspace` / `previous_workspace` |
// | `Cmd+Q ]` / `[`             | `next_agent` / `previous_agent` |
// | `Cmd+Q Cmd+]` / `Cmd+[`     | `next_agent` / `previous_agent` |
// | `Cmd+Q }` / `{`             | `next_unread_agent` / `previous_unread_agent` |
// | `Cmd+Q Cmd+N` / `N`         | `next_tab`                |
// | `Cmd+Q Alt+↑` / `Alt+↓`     | `move_entry_up` / `move_entry_down` |
// | `Cmd+Q Cmd+P` / `P`         | `previous_tab`            |
// | `Cmd+Q G`                   | `open_tab_picker`         |
// | `Cmd+Q 0`…`9`               | `select_entry_0`…`9`      |
// | `Cmd+Q Cmd+J`               | `toggle_workspace_agent`  |
// | `Cmd+Q Z`                   | `toggle_split`            |
// | `Cmd+Q Shift+J`             | `toggle_scratch`          |
// | `Cmd+Q O`                   | `swap_split_focus`        |
// | `Cmd+Q V`                   | `toggle_terminal`         |
// | `Cmd+Q E`                   | `focus_editor`            |
// | (palette only)              | `focus_sidebar`           |
// | `Cmd+Q B`                   | `toggle_sidebar`          |
// | `Cmd+Q F`                   | `add_workspace`           |
// | `Cmd+Q C`                   | `add_agent`               |
// | `Cmd+Q I`                   | `open_issue_picker`       |
// | `Cmd+Q A`                   | `send_agent_action`       |
// | `Cmd+Q ,`                   | `rename_agent`            |
// | `Cmd+Q X`                   | `close_selection`         |
// | `Cmd+Q Shift+R`             | `restart_agent`           |
// | `Cmd+Q Shift+W`             | `close_workspace`         |
// | `Cmd+Q R`                   | `refresh_repositories`    |
// | `Cmd+Q U`                   | `mark_agent_unread`       |
// | `Cmd+Q D`                   | `dismiss_alert`           |
// | `Cmd+Q M`                   | `show_notifications`      |
// | `Cmd+Q Shift+,`             | `open_settings`           |
// | (palette only)              | `open_log`                |
// | `Cmd+Q ?`                   | `show_chord_help`         |
// | `Cmd+Q :`                   | `open_command_palette`    |
// | `Cmd+Q H` / `L`             | `navigate_back` / `navigate_forward` |
//
// **Scratch is entry 0 and part of the workspace cycle.** `Cmd+Q 1`…`9` are
// the first nine workspaces, counted without Scratch.
//
// **`Alt+↑` and `Alt+↓` move the row instead of moving to it**, among its
// siblings and no further — the same rule the drag obeys.
//
// **Three ways of stepping, because there are three lists**: `Shift+N`/`Shift+P`
// step the workspaces, `[`/`]` step every Agent in sidebar order, and
// `Cmd+N`/`Cmd+P` step every row of the tree.
//
// **Shift narrows the same cycle to unread Agents**: `{`/`}` walk the same ring
// and stop only on an Agent that is owed a look.

import Foundation

public enum CommandId: String, CaseIterable, Codable, Sendable, Hashable {
    case selectEntry0 = "select_entry_0"
    case selectEntry1 = "select_entry_1"
    case selectEntry2 = "select_entry_2"
    case selectEntry3 = "select_entry_3"
    case selectEntry4 = "select_entry_4"
    case selectEntry5 = "select_entry_5"
    case selectEntry6 = "select_entry_6"
    case selectEntry7 = "select_entry_7"
    case selectEntry8 = "select_entry_8"
    case selectEntry9 = "select_entry_9"
    case forwardPrefix = "forward_prefix"
    case previousWorkspace = "previous_workspace"
    case nextWorkspace = "next_workspace"
    case previousAgent = "previous_agent"
    case nextAgent = "next_agent"
    case previousUnreadAgent = "previous_unread_agent"
    case nextUnreadAgent = "next_unread_agent"
    case previousTab = "previous_tab"
    case nextTab = "next_tab"
    case moveEntryUp = "move_entry_up"
    case moveEntryDown = "move_entry_down"
    case openTabPicker = "open_tab_picker"
    case toggleWorkspaceAgent = "toggle_workspace_agent"
    case toggleSplit = "toggle_split"
    case toggleScratch = "toggle_scratch"
    case focusEditor = "focus_editor"
    case focusSidebar = "focus_sidebar"
    case toggleSidebar = "toggle_sidebar"
    case addWorkspace = "add_workspace"
    case addAgent = "add_agent"
    case renameAgent = "rename_agent"
    case markAgentUnread = "mark_agent_unread"
    case closeSelection = "close_selection"
    case restartAgent = "restart_agent"
    case closeWorkspace = "close_workspace"
    case openIssuePicker = "open_issue_picker"
    case sendAgentAction = "send_agent_action"
    case swapSplitFocus = "swap_split_focus"
    case toggleTerminal = "toggle_terminal"
    case refreshRepositories = "refresh_repositories"
    case dismissAlert = "dismiss_alert"
    case showNotifications = "show_notifications"
    case openSettings = "open_settings"
    case openLog = "open_log"
    case showChordHelp = "show_chord_help"
    case openCommandPalette = "open_command_palette"
    case navigateBack = "navigate_back"
    case navigateForward = "navigate_forward"

    /// The digit a `select_entry_N` command selects, nil for any other.
    public var selectEntryDigit: Int? { Commands.byId[self]?.ordinal }
}

/// Which heading a command sits under in the command palette — the prefix of
/// its row, `Agent: Rename this Agent…`.
public enum CommandCategory: String, Sendable, CaseIterable {
    case navigate = "Navigate"
    case view = "View"
    case workspace = "Workspace"
    case agent = "Agent"
    case terminal = "Terminal"
    case devhub = "DevHub"
}

/// What has to be selected for a command to have anything to do. The single
/// gate: `resolveChord` reads it once and answers "no-op" for everything that
/// fails it.
public enum CommandNeeds: String, Sendable {
    case nothing
    case workspace
    case agent
    case split
}

public struct CommandDefinition: Equatable, Sendable {
    public let id: CommandId
    /// What it is called, in the help overlay and in Settings.
    public let label: String
    public let needs: CommandNeeds
    /// Its heading in the command palette.
    public let category: CommandCategory
    /// The second strokes DevHub ships, as key strings.
    public let defaultKeys: [String]
    /// Which sidebar row it selects, for the digit commands only.
    public let ordinal: Int?

    init(_ id: CommandId, _ label: String, _ needs: CommandNeeds, _ category: CommandCategory, _ defaultKeys: [String], ordinal: Int? = nil) {
        self.id = id
        self.label = label
        self.needs = needs
        self.category = category
        self.defaultKeys = defaultKeys
        self.ordinal = ordinal
    }
}

/// One binding, flattened: a key, and the command it reaches.
public struct KeyBinding: Equatable, Sendable {
    public let key: ChordKey
    public let commandId: CommandId
}

/// What is wrong with one entry of `[keybindings]`, and where.
public struct KeybindingProblem: Equatable, Sendable {
    public enum Code: String, Sendable {
        case invalidKey = "invalid_key"
        case unknownCommand = "unknown_command"
        case duplicateKey = "duplicate_key"
    }
    public let code: Code
    /// The config path, so the diagnostic names the line to go and fix.
    public let path: String
}

public enum Commands {
    public static let defaultChordPrefix = KeybindingsSpec.defaultPrefix

    /// `Cmd+Q 0` … `Cmd+Q 9`, written by a loop rather than by hand.
    static let selectEntryCommands: [CommandDefinition] = (0...9).map { ordinal in
        CommandDefinition(
            CommandId(rawValue: "select_entry_\(ordinal)")!,
            ordinal == 0 ? "Select Scratch" : "Select workspace \(ordinal)",
            .nothing, .navigate, [String(ordinal)], ordinal: ordinal
        )
    }

    /// Every command, in the order the help overlay lists them: moving around,
    /// then the toggles that change what the content area holds, then the
    /// things that make and unmake work, then what reaches outside DevHub, and
    /// help last.
    public static let all: [CommandDefinition] = [
        // The chord DevHub started with: the second Command-Q is the real one.
        CommandDefinition(.forwardPrefix, "Send a real Command-Q to the surface", .nothing, .devhub, [defaultChordPrefix]),
        CommandDefinition(.nextWorkspace, "Next workspace", .nothing, .navigate, ["N"]),
        CommandDefinition(.previousWorkspace, "Previous workspace", .nothing, .navigate, ["P"]),
        CommandDefinition(.nextAgent, "Next Agent", .nothing, .navigate, ["]", "Cmd+]"]),
        CommandDefinition(.previousAgent, "Previous Agent", .nothing, .navigate, ["[", "Cmd+["]),
        // The same ring as `next_agent`, stopping only where there is something
        // to come back to. Shift narrows; it does not walk a different list.
        CommandDefinition(.nextUnreadAgent, "Next unread Agent", .nothing, .navigate, ["}"]),
        CommandDefinition(.previousUnreadAgent, "Previous unread Agent", .nothing, .navigate, ["{"]),
        CommandDefinition(.nextTab, "Next sidebar row", .nothing, .navigate, ["Cmd+n", "n"]),
        CommandDefinition(.previousTab, "Previous sidebar row", .nothing, .navigate, ["Cmd+p", "p"]),
        // Lower case because that is the canonical spelling of a *named* key.
        CommandDefinition(.moveEntryUp, "Move this row up", .nothing, .view, ["Alt+arrowup"]),
        CommandDefinition(.moveEntryDown, "Move this row down", .nothing, .view, ["Alt+arrowdown"]),
        CommandDefinition(.openTabPicker, "Go to workspace or Agent…", .nothing, .navigate, ["g"]),
    ] + selectEntryCommands + [
        CommandDefinition(.toggleWorkspaceAgent, "Switch between the workspace and its Agent", .workspace, .view, ["Cmd+j"]),
        CommandDefinition(.toggleSplit, "Show the Agent beside the editor, or alone", .workspace, .view, ["z"]),
        // The jump out and the jump back, under one key.
        CommandDefinition(.toggleScratch, "Switch between Scratch and where you were", .nothing, .navigate, ["J"]),
        // Every pane on screen, left to right.
        CommandDefinition(.swapSplitFocus, "Focus the next pane", .nothing, .view, ["o"]),
        // Vim's `:vsplit`, read as where the pane goes: the Agent's own terminal, beside it.
        CommandDefinition(.toggleTerminal, "Show or hide the Agent's terminal", .workspace, .terminal, ["v"]),
        CommandDefinition(.focusEditor, "Show the editor", .nothing, .view, ["e"]),
        // The one command that hands the keyboard to DevHub's own chrome.
        // Palette only. `S` is left unbound.
        CommandDefinition(.focusSidebar, "Focus the sidebar", .nothing, .view, []),
        CommandDefinition(.toggleSidebar, "Collapse the sidebar to its rail, or expand it", .nothing, .view, ["b"]),
        CommandDefinition(.addWorkspace, "Add Workspace…", .nothing, .workspace, ["f"]),
        CommandDefinition(.addAgent, "New Agent in this workspace", .workspace, .agent, ["c"]),
        CommandDefinition(.openIssuePicker, "Assign an Issue…", .nothing, .workspace, ["i"]),
        CommandDefinition(.sendAgentAction, "Send an Agent action…", .agent, .agent, ["a"]),
        CommandDefinition(.renameAgent, "Rename this Agent…", .agent, .agent, [","]),
        CommandDefinition(.markAgentUnread, "Mark this Agent as unread", .agent, .agent, ["u"]),
        CommandDefinition(.closeSelection, "Close what is selected", .nothing, .workspace, ["x"]),
        CommandDefinition(.restartAgent, "Restart this Agent's session", .agent, .agent, ["R"]),
        CommandDefinition(.closeWorkspace, "Close this workspace", .workspace, .workspace, ["W"]),
        CommandDefinition(.refreshRepositories, "Refresh branch, pull request and Issue information", .nothing, .workspace, ["r"]),
        // Whichever failure is on screen, put away.
        CommandDefinition(.dismissAlert, "Dismiss the alert", .nothing, .devhub, ["d"]),
        // The notice center; a second press closes it.
        CommandDefinition(.showNotifications, "Show Notifications", .nothing, .devhub, ["m"]),
        CommandDefinition(.openSettings, "DevHub Settings…", .nothing, .devhub, ["<"]),
        // `devhub-main.log`, in the Mac's own viewer for it. Palette only.
        CommandDefinition(.openLog, "Open Log", .nothing, .devhub, []),
        CommandDefinition(.showChordHelp, "Keyboard shortcuts", .nothing, .devhub, ["?"]),
        // Matched as the character `:`, so US (Shift+;) and JIS both reach it.
        CommandDefinition(.openCommandPalette, "Show all commands…", .nothing, .devhub, [":"]),
        // `H` / `L` are Vim's left and right, the way Vimium's H / L walk the history.
        CommandDefinition(.navigateBack, "Go Back", .nothing, .navigate, ["h"]),
        CommandDefinition(.navigateForward, "Go Forward", .nothing, .navigate, ["l"]),
    ]

    /// The commands DevHub ships with no key at all, reached from the command
    /// palette or a binding the person adds. Named rather than inferred from an
    /// empty `defaultKeys`, so that a command losing its key is a decision.
    public static let paletteOnly: Set<CommandId> = [.focusSidebar, .openLog]

    static let byId: [CommandId: CommandDefinition] = Dictionary(uniqueKeysWithValues: all.map { ($0.id, $0) })

    /// The definition, or nothing when the id is not one DevHub has.
    public static func definition(_ id: String) -> CommandDefinition? {
        CommandId(rawValue: id).flatMap { byId[$0] }
    }

    /// Whether a string is an id DevHub owns. The config's whole check.
    public static func isCommandId(_ id: String) -> Bool { definition(id) != nil }

    /// The shipped table, parsed. A default that does not parse is DevHub's own
    /// typo, caught by the tests before anybody runs the app.
    public static func defaultBindings() -> [KeyBinding] {
        all.flatMap { command in
            command.defaultKeys.map { text in
                // swiftlint:disable:next force_try
                KeyBinding(key: try! ChordKeys.parse(text), commandId: command.id)
            }
        }
    }

    /// Everything wrong with a `[keybindings]` table, rather than the first thing.
    ///
    /// All of them, because a person who mistyped two keys should be told about
    /// two keys — and because the Settings window shows conflicts before a save.
    /// Silence is not an option for any of these: an unknown command id and an
    /// unparsable key both produce a binding that does nothing.
    public static func check(_ spec: KeybindingsSpec) -> [KeybindingProblem] {
        var problems: [KeybindingProblem] = []
        if (try? ChordKeys.parse(spec.prefix)) == nil {
            problems.append(KeybindingProblem(code: .invalidKey, path: "keybindings.prefix"))
        }
        var seen: [String: String] = [:]
        for (text, commandId) in spec.chords {
            let path = "keybindings.chords.\(text)"
            guard let key = try? ChordKeys.parse(text) else {
                problems.append(KeybindingProblem(code: .invalidKey, path: path))
                continue
            }
            let id = ChordKeys.id(key)
            if let previous = seen[id] {
                // Two spellings of one stroke — `Shift+n` and `shift+N` — are
                // one key, and a key can only ever reach one command.
                problems.append(KeybindingProblem(code: .duplicateKey, path: "\(path) (also \(previous))"))
                continue
            }
            seen[id] = path
            // The empty string is how a key is taken away, so it is not an id
            // and is not checked against the registry.
            if commandId.isEmpty { continue }
            if !isCommandId(commandId) {
                problems.append(KeybindingProblem(code: .unknownCommand, path: path))
            }
        }
        return problems
    }

    /// The table actually in effect: what DevHub ships, with the file's word
    /// over it. Keyed by the stroke. Entries `check` would refuse are skipped
    /// here rather than throwing: a chord layer that refused to exist because
    /// one line was mistyped would take every other chord away with it.
    public static func resolve(_ spec: KeybindingsSpec) -> (prefix: ChordKey, bindings: [KeyBinding]) {
        var order: [String] = []
        var table: [String: KeyBinding] = [:]
        func set(_ id: String, _ binding: KeyBinding) {
            if table.updateValue(binding, forKey: id) == nil { order.append(id) }
        }
        for binding in defaultBindings() { set(ChordKeys.id(binding.key), binding) }
        for (text, commandId) in spec.chords {
            guard let key = try? ChordKeys.parse(text) else { continue }
            let id = ChordKeys.id(key)
            if commandId.isEmpty {
                if table.removeValue(forKey: id) != nil { order.removeAll { $0 == id } }
                continue
            }
            guard let command = CommandId(rawValue: commandId) else { continue }
            set(id, KeyBinding(key: key, commandId: command))
        }
        let prefix = (try? ChordKeys.parse(spec.prefix)) ?? (try! ChordKeys.parse(defaultChordPrefix))
        return (prefix, order.map { table[$0]! })
    }

    /// Every key that reaches one command under a given table.
    public static func keys(for commandId: CommandId, in bindings: [KeyBinding]) -> [ChordKey] {
        bindings.filter { $0.commandId == commandId }.map(\.key)
    }
}

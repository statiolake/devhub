// Port of apps/desktop/src/settings/sections.tsx: every screen of the Settings
// window, with every sentence it says. A change is applied when it is made
// (`SettingsContext.update`), and a screen is drawn again only when what it
// shows depends on the change.

import AppKit
import DevHubCore

/// What a screen reads and asks of the window.
@MainActor
protocol SettingsContext: AnyObject {
    var draft: Config { get }
    var snapshot: SettingsSnapshot { get }
    /// Apply `next`; `rebuild` when the screen shows something that follows from it.
    func update(_ next: Config, rebuild: Bool)
    func reset(_ section: SettingsSection)
    func selected(_ section: SettingsSection) -> Int
    func select(_ section: SettingsSection, _ index: Int)
    var socketDraft: String { get }
    func editSocket(_ text: String)
    func changeSocket()
    var busy: Bool { get }
    var status: String? { get }
    func recheck()
    func openLogs()
    func copySummary()
}

@MainActor
enum SettingsSections {
    static func view(_ section: SettingsSection, kit: SettingsKit, context: SettingsContext) -> NSView {
        switch section {
        case .general: return scrolled(general(kit, context))
        case .workspaces: return workspaces(kit, context)
        case .agents: return agents(kit, context)
        case .actions: return actions(kit, context)
        case .keyboard: return scrolled(keyboard(kit, context))
        case .terminal: return scrolled(terminal(kit, context))
        case .advanced: return scrolled(advanced(kit, context))
        }
    }

    /// `.sf-form`: 24 / 24 / 32 around a 560pt column.
    static func scrolled(_ form: NSView) -> NSView {
        FormScrollView(content: form, maxWidth: SettingsKit.columnWidth, insets: NSEdgeInsets(top: Space.s6, left: Space.s6, bottom: Space.s8, right: Space.s6))
    }

    private static func number(
        _ kit: SettingsKit, _ label: String, _ value: Double, min: Double, max: Double, unit: String?, disabled: Bool = false,
        _ commit: @escaping (Double) -> Void
    ) -> NSView {
        SettingsTextField(
            kit: kit, label: label, value: SettingsRules.format(value), narrow: true, disabled: disabled,
            trailing: unit.map { [kit.caption($0)] } ?? [],
            validate: { SettingsRules.numberProblem($0, label: label, min: min, max: max) }
        ) { text in
            if let parsed = Double(text.trimmingCharacters(in: .whitespaces)) { commit(parsed) }
        }
    }

    private static func text(
        _ kit: SettingsKit, _ label: String, _ value: String, placeholder: String? = nil, mono: Bool = false,
        trailing: [NSView] = [], validate: ((String) -> String?)? = nil, _ commit: @escaping (String) -> Void
    ) -> NSView {
        SettingsTextField(
            kit: kit, label: label, value: value, placeholder: placeholder, mono: mono, trailing: trailing, validate: validate,
            onCommit: commit)
    }

    // MARK: - General

    static func general(_ kit: SettingsKit, _ c: SettingsContext) -> NSView {
        let config = c.draft
        func set(_ edit: (inout Config) -> Void, rebuild: Bool = false) {
            var next = c.draft
            edit(&next)
            c.update(next, rebuild: rebuild)
        }
        let presentationNames = SettingsEdits.presentationNames
        return kit.form(reset: resetLink(kit, what: SettingsSection.general.resetName) { c.reset(.general) }, [
            kit.group("Environment", note: c.snapshot.loginEnvironment, [
                kit.switchRow(
                    "Login shell",
                    help: "Use your login shell's environment for everything DevHub runs — the editor and its extensions as well as terminals and agents. Takes effect the next time DevHub starts.",
                    checked: config.general.importLoginEnvironment) { value in set { $0.general.importLoginEnvironment = value } },
            ]),
            kit.group(
                "Notifications",
                note: "When an Agent finishes its turn or is waiting for you, DevHub notifies you unless you are already looking at that Agent. Clicking the notification opens the Agent.",
                [
                    kit.switchRow(
                        "Notify when an Agent needs me",
                        help: "Show a notification when an Agent goes idle or is waiting for permission or input.",
                        checked: config.general.notifyOnIdle) { value in set { $0.general.notifyOnIdle = value } },
                    kit.switchRow("Play a sound", help: "Play the system notification sound with it.", checked: config.general.notifySound) { value in
                        set { $0.general.notifySound = value }
                    },
                    kit.row(
                        "Hide DevHub's notices after (seconds)",
                        help: "A notice from DevHub itself hides into Notifications (Cmd+Q M) after this long, unless the pointer or keyboard is on it. 0 keeps it until it is dismissed or over. Default 8.",
                        [number(kit, "Hide DevHub's notices after (seconds)", config.general.noticeSeconds, min: 0, max: 3_600, unit: "s") { value in
                            set { $0.general.noticeSeconds = value }
                        }]),
                ]),
            kit.group(
                "Terminals",
                note: "A Workspace's row shows the working mark while a command in one of its terminals is printing, and the unread mark when it finishes or goes quiet while you are looking elsewhere.",
                [
                    kit.row(
                        "Quiet after (seconds)",
                        help: "A command that prints nothing for this long counts as finished. 0 counts a command as working until it exits. Default 5.",
                        [number(kit, "Quiet after (seconds)", config.general.terminalIdleSeconds, min: 0, max: 86_400, unit: "s") { value in
                            set { $0.general.terminalIdleSeconds = value }
                        }]),
                ]),
            kit.group(
                "Editors",
                note: "A Workspace's editor that has been off screen for a while is closed to free its memory, and opens again where it was when you show it, unsaved changes included. Its Agents and terminal sessions keep running. An editor with a running terminal command or a debug session stays open, and so do SSH and dev container editors. Closing and the limit apply to VS Code editors only.",
                [
                    kit.row(
                        "Editor area",
                        help: "VS Code gives every Workspace a VS Code editor. Terminal shows the Workspace's own tmux session there instead, with no VS Code at all, and opens files DevHub is asked to open in a Neovim it starts in that session. Terminal is for local Workspaces for now. Whether editors exist is decided at launch, so this takes effect the next time DevHub starts.",
                        [kit.popup("Editor area", value: config.general.workbench, options: [("vscode", "VS Code"), ("terminal", "Terminal (tmux)")]) { value in
                            set { $0.general.workbench = value }
                        }]),
                    kit.row(
                        "Close after (minutes)",
                        help: "How long an editor may be off screen before it is closed. 0 keeps every editor open. Default 10.",
                        [number(kit, "Close after (minutes)", config.general.workbenchHibernateMinutes, min: 0, max: 10_080, unit: "min") { value in
                            set { $0.general.workbenchHibernateMinutes = value }
                        }]),
                    kit.row(
                        "Open at most", help: "Opening one more editor closes the one shown least recently. 0 is no limit. Default 2.",
                        [number(kit, "Open at most", config.general.workbenchAwakeMax, min: 0, max: 100, unit: "editors") { value in
                            set { $0.general.workbenchAwakeMax = value }
                        }]),
                ]),
            kit.group(
                "Appearance",
                note: "DevHub wears the VS Code colour theme named here — its window, its Agent panes and every editor alike: each editor is told to wear the same theme, so a theme chosen in an editor's own picker does not stick. Mode decides which of the two applies; Light and Dark tell the system DevHub is in that appearance.",
                [
                    kit.row(
                        "Dark theme",
                        help: "A VS Code colour theme, by the name VS Code's theme picker shows or its id (what `workbench.colorTheme` says) — a built-in one or one from an installed extension. A name DevHub cannot find falls back to VS Code's default, and DevHub says so.",
                        [text(kit, "Dark colour theme", config.appearance.themeDark, placeholder: "Dark 2026", validate: SettingsRules.themeNameProblem) { value in
                            set { $0.appearance.themeDark = value }
                        }]),
                    kit.row(
                        "Light theme", help: "The theme for the light appearance, named the same way.",
                        [text(kit, "Light colour theme", config.appearance.themeLight, placeholder: "Light 2026", validate: SettingsRules.themeNameProblem) { value in
                            set { $0.appearance.themeLight = value }
                        }]),
                    kit.row(
                        "Mode", help: "Auto follows the system appearance.",
                        [kit.popup("Appearance mode", value: config.appearance.mode, options: [("auto", "Auto"), ("light", "Light"), ("dark", "Dark")]) { value in
                            set { $0.appearance.mode = value }
                        }]),
                    kit.row(
                        "Title bar",
                        help: "Shown gives the window a title bar in the sidebar's own colour, carrying the window's name and the sidebar control, and lets the collapsed sidebar be as narrow as its icons; Hidden has no bar and puts the traffic lights on the sidebar instead. The window is built either way at launch, so this takes effect the next time DevHub starts.",
                        [kit.popup("Title bar", value: config.appearance.titleBar, options: [("shown", "Shown"), ("hidden", "Hidden")]) { value in
                            set { $0.appearance.titleBar = value }
                        }]),
                ]),
            kit.group("Agents", [
                kit.row(
                    "Show agents as",
                    help: "How a new agent is shown when its profile does not say. Only Claude and Codex have a GUI; other agents open in a terminal either way. Command-Return in New Agent opens one the other way.",
                    [kit.popup(
                        "Default agent presentation", value: config.agents.defaultPresentation.rawValue,
                        options: [("tui", presentationNames[.tui]!), ("gui", presentationNames[.gui]!)]
                    ) { value in
                        set { $0.agents.defaultPresentation = AgentPresentation(rawValue: value) ?? .tui }
                    }]),
                kit.switchRow(
                    "Resume after a limit",
                    help: "When a usage limit stops a GUI agent, send it the message below once the limit resets. The conversation says when, and Cancel there stops it.",
                    checked: config.agents.resumeAfterLimit) { value in set { $0.agents.resumeAfterLimit = value } },
                kit.switchRow(
                    "Auto-compact before cache expires",
                    help: "When a GUI Claude agent sits idle and its prompt cache is about to expire, send /compact shortly before, so your next message re-caches a short summary instead of the whole conversation. The compaction itself uses tokens, and conversations under the minimum size below are left alone. On by default.",
                    checked: config.agents.autoCompactBeforeCacheExpiry) { value in
                        set({ $0.agents.autoCompactBeforeCacheExpiry = value }, rebuild: true)
                    },
                kit.row(
                    "Minimum context size (tokens)",
                    help: "Conversations with less context than this are not compacted, since re-caching them is cheap. Default 100,000.",
                    [number(
                        kit, "Minimum context size (tokens)", config.agents.autoCompactMinTokens, min: 0, max: 9_007_199_254_740_991, unit: "tokens",
                        disabled: !config.agents.autoCompactBeforeCacheExpiry
                    ) { value in set { $0.agents.autoCompactMinTokens = value } }]),
                kit.row(
                    "Start this many seconds before expiry",
                    help: "How long before the prompt cache expires the compaction is sent. Must be above zero. Default 60.",
                    [number(
                        kit, "Start this many seconds before expiry", config.agents.autoCompactLeadSeconds, min: 1, max: 9_007_199_254_740_991, unit: "s",
                        disabled: !config.agents.autoCompactBeforeCacheExpiry
                    ) { value in set { $0.agents.autoCompactLeadSeconds = value } }]),
                kit.row(
                    "Resume message", help: "What is sent for you, shown in the conversation as your message sent automatically.",
                    [text(kit, "Message sent after a usage limit resets", config.agents.resumeAfterLimitMessage, validate: SettingsRules.resumeMessageProblem) { value in
                        set { $0.agents.resumeAfterLimitMessage = value }
                    }]),
            ]),
            kit.group(
                "Scratch",
                note: "Scratch is today's folder: an ordinary workspace, made when it is first needed. At midnight Scratch moves to the new day's folder and yesterday's stays in the sidebar under its own name.",
                [
                    kit.row(
                        "Daily folder", help: "A path with the date tokens a dated workspace source takes: YYYY, MM, DD (or MMDD), and [text] for text used as written.",
                        [text(kit, "Scratch daily folder", config.scratch.daily, placeholder: "~/junk/YYYYMMDD", mono: true, validate: SettingsRules.scratchDailyProblem) { value in
                            set { $0.scratch.daily = value }
                        }]),
                ]),
            kit.group(
                "Projects",
                note: "Where New Project starts, and the first folder Clone offers. Left empty, it is the first folder source's path (or ~), and Clone offers the folders your sources' projects are in.",
                [
                    kit.row(
                        "Folder", help: "An absolute path, or one starting with ~/. Used as written.",
                        [text(kit, "Projects folder", config.projects.directory ?? "", placeholder: "From the first folder source", mono: true, validate: SettingsRules.projectDirectoryProblem) { value in
                            set { $0.projects.directory = value.isEmpty ? nil : value }
                        }]),
                ]),
            kit.group("Sidebar", [
                kit.row(
                    "Density", help: "How much room a workspace row takes.",
                    [kit.popup("Sidebar density", value: config.appearance.sidebarDensity, options: [("compact", "Compact"), ("comfortable", "Comfortable")]) { value in
                        set { $0.appearance.sidebarDensity = value }
                    }]),
            ]),
            kit.group(
                "Agent panes",
                note: "The workbench's own terminal is styled by the workbench's settings, not by these: DevHub's terminals are the integrated terminal now, and an Agent's pane is the one text surface DevHub still draws itself. The font family is also DevHub's one monospace face: a GUI Agent's code, diffs and command output, and every other fixed-width line in DevHub's own windows, are set in it.",
                [
                    kit.row("Font", [text(kit, "Agent pane font family", config.appearance.terminalFontFamily, placeholder: "ui-monospace", mono: true, validate: SettingsRules.fontFamilyProblem) { value in
                        set { $0.appearance.terminalFontFamily = value }
                    }]),
                    kit.row("Size", [number(kit, "Agent pane font size", config.appearance.terminalFontSize, min: 9, max: 24, unit: "pt") { value in
                        set { $0.appearance.terminalFontSize = value }
                    }]),
                    kit.row(
                        "Line height",
                        help: "Multiplies the row height above the font's own line box. The extra space is shared around the font's bounding box, which already carries its slack above the capitals and none below the descenders, so raising this adds far more room above a line than below it.",
                        [number(kit, "Agent pane line height", config.appearance.terminalLineHeight, min: 1, max: 2, unit: "×") { value in
                            set { $0.appearance.terminalLineHeight = value }
                        }]),
                    kit.row(
                        "Scroll speed",
                        help: "Multiplies wheel and trackpad scrolling in Agent panes, both when the Agent is reading the mouse and in DevHub's own scrollback.",
                        [number(kit, "Agent pane scroll speed", config.appearance.terminalScrollSensitivity, min: 0.1, max: 20, unit: "×") { value in
                            set { $0.appearance.terminalScrollSensitivity = value }
                        }]),
                    kit.row(
                        "Colours",
                        help: "Following the colour theme, a pane takes the theme's terminal colours — those VS Code's own terminal would have under it — and changes with it. Palettes are the light and dark tables under [appearance.terminal_theme] in settings.toml, starting from DevHub's own.",
                        [kit.popup(
                            "Agent pane colours", value: config.appearance.terminalTheme == .vscode ? "vscode" : "palettes",
                            options: [("vscode", "Follow the colour theme"), ("palettes", "Palettes in settings.toml")]
                        ) { value in
                            set {
                                if value == "vscode" {
                                    $0.appearance.terminalTheme = .vscode
                                } else if $0.appearance.terminalTheme == .vscode {
                                    $0.appearance.terminalTheme = .palettes(.defaults)
                                }
                            }
                        }]),
                    kit.row("Inset", help: "Space between the text and the pane's edge.", [number(kit, "Agent pane margin", config.appearance.terminalMargin, min: 0, max: 64, unit: "px") { value in
                        set { $0.appearance.terminalMargin = value }
                    }]),
                ]),
        ])
    }

    // MARK: - Workspaces

    static func workspaces(_ kit: SettingsKit, _ c: SettingsContext) -> NSView {
        let sources = c.draft.workspaceSources
        let selected: Int? = sources.isEmpty ? nil : min(c.selected(.workspaces), sources.count - 1)
        func replace(_ next: WorkspaceSource, rebuild: Bool = false) {
            guard let selected else { return }
            var config = c.draft
            config.workspaceSources[selected] = next
            c.update(config, rebuild: rebuild)
        }
        let otherIds = sources.enumerated().filter { $0.offset != selected }.map(\.element.id)
        var detail: NSView?
        if let selected {
            let source = sources[selected]
            var groups: [NSView] = [
                kit.group("Source", [
                    kit.row("Identifier", [text(
                        kit, "Workspace source identifier", source.id, mono: true,
                        validate: { otherIds.contains($0) ? "Another source already has that identifier." : SettingsRules.idProblem($0) }
                    ) { id in
                        var next = source
                        switch next {
                        case var .filesystem(value): value.id = id; next = .filesystem(value)
                        case var .date(value): value.id = id; next = .date(value)
                        case var .command(value): value.id = id; next = .command(value)
                        }
                        replace(next, rebuild: true)
                    }]),
                    kit.row("Kind", [kit.popup(
                        "Workspace source kind", value: source.type, options: [("filesystem", "Folder"), ("date", "Date"), ("command", "Command")]
                    ) { type in replace(SettingsEdits.emptySource(type, id: source.id), rebuild: true) }]),
                ]),
            ]
            switch source {
            case let .filesystem(filesystem):
                let maxText = filesystem.maxDepth.map(SettingsRules.format) ?? ""
                groups.append(kit.group("Where to look", [
                    kit.row("Folder", [text(kit, "Workspace root path", filesystem.path, placeholder: "~/dev", mono: true, validate: SettingsRules.workspacePathProblem) { path in
                        var next = filesystem
                        next.path = path
                        replace(.filesystem(next), rebuild: true)
                    }]),
                    kit.row("Depth", help: "How many levels below the folder a workspace may be found.", [
                        number(kit, "Minimum depth", filesystem.minDepth, min: 0, max: 16, unit: nil) { value in
                            replace(.filesystem(SettingsEdits.depth(filesystem, minDepth: value)), rebuild: true)
                        },
                        kit.caption("to"),
                        SettingsTextField(
                            kit: kit, label: "Maximum depth", value: maxText, placeholder: SettingsRules.format(filesystem.minDepth), narrow: true,
                            validate: { SettingsRules.maxDepthProblem($0, minDepth: filesystem.minDepth) }
                        ) { value in
                            var next = filesystem
                            let trimmed = value.trimmingCharacters(in: .whitespaces)
                            next.maxDepth = trimmed.isEmpty ? nil : Double(trimmed)
                            replace(.filesystem(next), rebuild: true)
                        },
                    ]),
                    kit.row("Match", [kit.popup(
                        "What to match", value: SettingsRules.MatchChoice.of(filesystem.kinds).rawValue,
                        options: SettingsRules.MatchChoice.allCases.map { ($0.rawValue, $0.label) }
                    ) { value in
                        var next = filesystem
                        next.kinds = (SettingsRules.MatchChoice(rawValue: value) ?? .gitRepository).kinds
                        replace(.filesystem(next))
                    }]),
                    kit.switchRow("Hidden folders", help: "Also offer folders whose name starts with a dot.", checked: filesystem.includeHidden) { value in
                        var next = filesystem
                        next.includeHidden = value
                        replace(.filesystem(next))
                    },
                ]))
                groups.append(kit.group("Ignore", [kit.wideRow(TokenListView(
                    kit: kit, label: "Skipped name", addLabel: "Add Name", values: filesystem.excludeNames, placeholder: "node_modules",
                    validate: SettingsRules.excludeNameProblem
                ) { names in
                    var next = filesystem
                    next.excludeNames = names
                    replace(.filesystem(next))
                })]))
            case let .date(date):
                groups.append(kit.group(
                    "Where to look",
                    note: "A path with today's date in it. YYYY, YY, MM, DD and MMDD are the year, the month and the day; HH, mm and ss are the time. Text in [brackets] is used as written, which is how a folder called DDta keeps its name.",
                    [
                        kit.row("Folder", [text(kit, "Dated workspace path", date.path, placeholder: "~/workspace/daily/YYYY/MMDD", mono: true, validate: SettingsRules.dateTemplateProblem) { path in
                            var next = date
                            next.path = path
                            replace(.date(next), rebuild: true)
                        }]),
                        kit.switchRow(
                            "Offer it before it exists",
                            help: "Today's folder is usually made the moment you first want it. With this on the picker offers it anyway, and choosing it makes the folder.",
                            checked: date.createIfMissing) { value in
                                var next = date
                                next.createIfMissing = value
                                replace(.date(next))
                            },
                    ]))
            case let .command(command):
                groups.append(kit.group(
                    "Command",
                    note: "The program is run with these arguments and nothing else — no shell, so quoting and globs are yours to expand.",
                    [kit.wideRow(TokenListView(
                        kit: kit, label: "Argument", addLabel: "Add Argument", values: command.command, placeholder: "ghq",
                        validate: SettingsRules.argumentProblem
                    ) { arguments in
                        var next = command
                        next.command = arguments
                        replace(.command(next), rebuild: true)
                    })]))
                groups.append(kit.group("Limits", [
                    kit.row("Timeout", help: "How long DevHub waits for the program to finish.", [number(kit, "Command timeout", command.timeoutMs, min: 100, max: 30_000, unit: "ms") { value in
                        var next = command
                        next.timeoutMs = value
                        replace(.command(next))
                    }]),
                ]))
            }
            detail = kit.vertical(groups, spacing: Space.s5)
            if let stack = detail as? NSStackView { for group in groups { group.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true } }
        }
        return CollectionView(
            kit: kit, label: "Workspace sources",
            entries: sources.map { CollectionEntry(title: $0.id, note: SettingsEdits.sourceNote($0), symbol: $0.type == "command" ? "terminal" : "folder") },
            selected: selected, onSelect: { c.select(.workspaces, $0) },
            addLabel: "Add Source",
            onAdd: {
                let (next, index) = SettingsEdits.addSource(c.draft)
                c.select(.workspaces, index)
                c.update(next, rebuild: true)
            },
            removeLabel: "Remove Source",
            onRemove: {
                guard let selected else { return }
                var next = c.draft
                next.workspaceSources.remove(at: selected)
                c.update(next, rebuild: true)
            },
            reset: resetLink(kit, what: SettingsSection.workspaces.resetName) { c.reset(.workspaces) },
            empty: (
                "No workspace sources",
                "A source is where the workspace picker looks. A folder source walks a folder; a command source runs a program that prints one path per line."
            ),
            detail: detail)
    }

    // MARK: - Agents

    static func agents(_ kit: SettingsKit, _ c: SettingsContext) -> NSView {
        let profiles = c.draft.agentProfiles
        let selected: Int? = profiles.isEmpty ? nil : min(c.selected(.agents), profiles.count - 1)
        func replace(_ next: ConfiguredAgentProfile, rebuild: Bool = false) {
            guard let selected else { return }
            var config = c.draft
            config.agentProfiles[selected] = next
            c.update(config, rebuild: rebuild)
        }
        let otherIds = profiles.enumerated().filter { $0.offset != selected }.map(\.element.id)
        var detail: NSView?
        if let selected {
            let profile = profiles[selected]
            let options = SettingsEdits.presentationOptions(profile.kind, defaults: c.draft.agents)
            let groups: [NSView] = [
                kit.group("Profile", [
                    kit.row("Name", help: "What the sidebar calls it.", [text(kit, "Agent display name", profile.displayName, validate: SettingsRules.displayNameProblem) { name in
                        var next = profile
                        next.displayName = name
                        replace(next, rebuild: true)
                    }]),
                    kit.row("Identifier", help: "What config.toml calls it.", [text(
                        kit, "Agent profile identifier", profile.id, mono: true,
                        validate: { otherIds.contains($0) ? "Another profile already has that identifier." : SettingsRules.idProblem($0) }
                    ) { id in
                        var next = profile
                        next.id = id
                        replace(next, rebuild: true)
                    }]),
                    kit.row("Command", help: "The program to run. DevHub finds it on the same PATH your terminals use.", [text(
                        kit, "Agent command", profile.command, mono: true,
                        validate: { $0.trimmingCharacters(in: .whitespaces).isEmpty ? "An agent profile needs a command to run." : nil }
                    ) { command in
                        var next = profile
                        next.command = command
                        replace(next)
                    }]),
                    kit.row("Runtime", help: "Whose screen this is, so DevHub knows how to read its status.", [kit.popup(
                        "Agent runtime", value: profile.kind.rawValue,
                        options: [("codex", "Codex"), ("claude", "Claude"), ("cursor", "Cursor"), ("custom", "Other (no status)")]
                    ) { value in
                        guard let kind = AgentProfileKind(rawValue: value) else { return }
                        replace(SettingsEdits.kind(profile, kind), rebuild: true)
                    }]),
                    kit.row(
                        "Show as",
                        help: "How a new agent from this profile is shown. Default follows “Show agents as” in General. Command-Return in New Agent opens one the other way. Only Claude and Codex have a GUI.",
                        [kit.popup("Agent presentation", value: profile.presentation?.rawValue ?? "default", options: options.map { ($0.id, $0.label) }) { value in
                            var next = profile
                            next.presentation = AgentPresentation(rawValue: value)
                            replace(next)
                        }]),
                ]),
                kit.group("Arguments", [kit.wideRow(TokenListView(
                    kit: kit, label: "Argument", addLabel: "Add Argument", values: profile.args, placeholder: "--model",
                    validate: SettingsRules.argumentProblem
                ) { args in
                    var next = profile
                    next.args = args
                    replace(next)
                })]),
                kit.group(
                    "Environment", note: "These values stay on this machine: Copy Summary in Advanced never includes them.",
                    [kit.wideRow(environment(kit, profile.env) { env in
                        var next = profile
                        next.env = env
                        replace(next, rebuild: true)
                    })]),
            ]
            let stack = kit.vertical(groups, spacing: Space.s5)
            for group in groups { group.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
            detail = stack
        }
        return CollectionView(
            kit: kit, label: "Agent profiles",
            entries: profiles.map { CollectionEntry(title: $0.displayName, note: $0.id, symbol: "cpu") },
            selected: selected, onSelect: { c.select(.agents, $0) },
            addLabel: "Add Profile",
            onAdd: {
                let (next, index) = SettingsEdits.addProfile(c.draft)
                c.select(.agents, index)
                c.update(next, rebuild: true)
            },
            removeLabel: "Remove Profile",
            onRemove: {
                guard let selected else { return }
                var next = c.draft
                next.agentProfiles.remove(at: selected)
                c.update(next, rebuild: true)
            },
            reset: resetLink(kit, what: SettingsSection.agents.resetName) { c.reset(.agents) },
            empty: ("No agent profiles", "A profile is an agent you can launch in a workspace: which program it is, and what it is started with."),
            detail: detail)
    }

    /// `EnvironmentList`: name and value per variable.
    private static func environment(_ kit: SettingsKit, _ env: OrderedStringMap, _ onChange: @escaping (OrderedStringMap) -> Void) -> NSView {
        let entries = env.map { ($0.key, $0.value) }
        func commit(_ next: [(String, String)]) { onChange(OrderedStringMap(next)) }
        var lines: [NSView] = []
        for (index, (key, value)) in entries.enumerated() {
            let name = SettingsTextField(
                kit: kit, label: "Environment variable \(index + 1) name", value: key, mono: true,
                validate: { next in
                    entries.enumerated().contains { $0.offset != index && $0.element.0 == next }
                        ? "That variable is already set above." : SettingsRules.environmentNameProblem(next)
                }
            ) { next in
                var copy = entries
                copy[index] = (next, value)
                commit(copy)
            }
            let valueField = SettingsTextField(kit: kit, label: "Value of \(key)", value: value, mono: true, validate: SettingsRules.argumentProblem) { next in
                var copy = entries
                copy[index] = (key, next)
                commit(copy)
            }
            let remove = kit.iconButton("minus", label: "Remove \(key)") {
                var copy = entries
                copy.remove(at: index)
                commit(copy)
            }
            let line = kit.horizontal([name, valueField, remove], spacing: Space.s1)
            name.widthAnchor.constraint(equalTo: valueField.widthAnchor, multiplier: 0.8).isActive = true
            lines.append(line)
        }
        if entries.isEmpty { lines.append(kit.caption("None.")) }
        let add = kit.button("Add Variable") {
            commit(entries + [(SettingsEdits.freeEnvName(entries.map(\.0)), "")])
        }
        add.bezelStyle = .inline
        add.isBordered = false
        add.contentTintColor = kit.tokens.accent.nsColor
        lines.append(add)
        let stack = kit.vertical(lines, spacing: Space.s1)
        stack.setAccessibilityLabel("Environment")
        for line in lines where line is NSStackView { line.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
        return stack
    }

    // MARK: - Actions

    static func actions(_ kit: SettingsKit, _ c: SettingsContext) -> NSView {
        let actions = SheetRows.actionsInTreeOrder(c.draft.agentActions)
        let selected: Int? = actions.isEmpty ? nil : min(c.selected(.actions), actions.count - 1)
        let trigger = selected.map { actions[$0].trigger } ?? .issue
        func replace(_ next: ConfiguredAgentAction, rebuild: Bool = false) {
            guard let selected else { return }
            var list = actions
            list[selected] = next
            var config = c.draft
            config.agentActions = list
            c.update(config, rebuild: rebuild)
        }
        var detail: NSView?
        if let selected {
            let action = actions[selected]
            var rows: [NSView] = [
                kit.row("Name", [text(kit, "Agent action name", action.displayName, placeholder: "Work on the Issue", validate: SettingsRules.displayNameProblem) { name in
                    var next = action
                    next.displayName = name
                    replace(next, rebuild: true)
                }]),
                kit.row(
                    "Trigger", help: "What fires it: the Issue flow, or the Smart Button condition it is offered under.",
                    [kit.popup("Agent action trigger", value: action.trigger.rawValue, options: AgentActionTrigger.ordered.map { ($0.rawValue, $0.displayName) }) { value in
                        guard let next = AgentActionTrigger(rawValue: value) else { return }
                        replace(SettingsEdits.trigger(action, next), rebuild: true)
                    }]),
                kit.switchRow(
                    "Review before sending", help: "Show this message in an editable sheet and send it only once you confirm it.",
                    checked: action.confirmBeforeSend) { value in
                        var next = action
                        next.confirmBeforeSend = value
                        replace(next)
                    },
            ]
            if action.trigger.isSmartButton {
                rows.append(kit.switchRow(
                    "Show as a Smart Button",
                    help: "Offer it on an idle Agent's pane while its condition holds. The Agent actions sheet lists it either way.",
                    checked: action.button) { value in
                        var next = action
                        next.button = value
                        replace(next)
                    })
            }
            rows.append(kit.switchRow("Offer this action", help: "Off hides it without deleting the wording.", checked: action.enabled) { value in
                var next = action
                next.enabled = value
                replace(next, rebuild: true)
            })
            let groups: [NSView] = [
                kit.group("Action", rows),
                kit.group("Message", note: SettingsEdits.messageNote(action.trigger), [kit.wideRow(SettingsTextArea(
                    kit: kit, label: "Agent action message", value: action.template, placeholder: SettingsEdits.templatePlaceholder(action)
                ) { template in
                    var next = action
                    next.template = template
                    replace(next, rebuild: true)
                })]),
            ]
            let stack = kit.vertical(groups, spacing: Space.s5)
            for group in groups { group.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
            detail = stack
        }
        return CollectionView(
            kit: kit, label: "Agent actions",
            entries: actions.map { action in
                CollectionEntry(
                    title: action.enabled ? action.displayName : "\(action.displayName) (off)",
                    note: action.template.split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init) ?? "",
                    symbol: "bolt", group: action.trigger.displayName)
            },
            selected: selected, onSelect: { c.select(.actions, $0) },
            addLabel: "Add Action",
            onAdd: {
                let (next, index) = SettingsEdits.addAction(c.draft, selectedTrigger: trigger)
                c.select(.actions, index)
                c.update(next, rebuild: true)
            },
            removeLabel: "Remove Action",
            onRemove: {
                guard let selected else { return }
                var list = actions
                list.remove(at: selected)
                var next = c.draft
                next.agentActions = SettingsEdits.renumbered(list)
                c.update(next, rebuild: true)
            },
            onMove: { direction in
                guard let selected, let moved = SettingsEdits.moveAction(c.draft, selected: selected, by: direction) else { return }
                c.select(.actions, moved.selected)
                c.update(moved.config, rebuild: true)
            },
            reset: resetLink(kit, what: SettingsSection.actions.resetName) { c.reset(.actions) },
            empty: ("No agent actions", "An action is what DevHub says to an agent — when it starts one on an Issue, and when you press one of its Smart Buttons."),
            detail: detail)
    }

    // MARK: - Keyboard

    static func keyboard(_ kit: SettingsKit, _ c: SettingsContext) -> NSView {
        let keybindings = c.draft.keybindings
        let rows = SettingsEdits.keyboardRows(keybindings)
        let problems = Commands.check(keybindings)
        func set(_ next: KeybindingsSpec) {
            var config = c.draft
            config.keybindings = next
            c.update(config, rebuild: true)
        }
        var groups: [NSView] = [
            kit.group(
                "Prefix",
                note: "Every DevHub command is two strokes: this one, then one key. Nothing DevHub does is a single shortcut, because the editor and the terminal inside it want their own keys.",
                [kit.row("Prefix", help: "Modifiers and the character the key produces: `Cmd+q`, `Ctrl+q`.", [text(kit, "Chord prefix", keybindings.prefix, validate: SettingsRules.chordKeyProblem) { prefix in
                    var next = keybindings
                    next.prefix = prefix
                    set(next)
                }])]),
        ]
        if !problems.isEmpty {
            let list = problems.map { "\($0.path) — \(SettingsEdits.keyboardProblems[$0.code] ?? "")" }.joined(separator: "\n")
            groups.append(kit.group("Problems", [kit.wideRow(kit.label(list, size: 12, color: kit.tokens.danger.nsColor, selectable: true))]))
        }
        groups.append(kit.group(
            "Commands",
            note: "A chord is written as the character the key produces — `{`, not `Shift+[` — because that is what the keyboard reports whatever layout it has, so one binding means the same thing on a US and a JIS keyboard alike.",
            rows.map { row in
                KeyboardRowView.make(kit: kit, row: row, rows: rows, onRebind: { key in
                    set(SettingsEdits.rebind(keybindings, command: row.command, keys: row.keys, to: key))
                }, onUnbind: {
                    set(SettingsEdits.rebind(keybindings, command: row.command, keys: row.keys, to: nil))
                }, onReset: {
                    set(SettingsEdits.resetBinding(keybindings, command: row.command))
                })
            }))
        return kit.form(reset: resetLink(kit, what: SettingsSection.keyboard.resetName) { c.reset(.keyboard) }, groups)
    }

    // MARK: - Terminal

    static func terminal(_ kit: SettingsKit, _ c: SettingsContext) -> NSView {
        let runtimes = c.draft.runtimes
        let effective = c.snapshot.config.runtimes.tmuxSocketName
        let asked = c.socketDraft.trimmingCharacters(in: .whitespaces)
        let moved = !asked.isEmpty && asked != effective
        func setArgs(_ option: String, _ on: Bool) {
            var next = c.draft
            next.runtimes = SettingsEdits.tmuxArgument(runtimes, option, on: on)
            c.update(next, rebuild: false)
        }
        let change = kit.button("Change…", enabled: !c.busy && moved && SettingsRules.socketProblem(asked) == nil) { c.changeSocket() }
        let socket = SettingsTextField(
            kit: kit, label: "tmux socket name", value: c.socketDraft, mono: true, trailing: [change], validate: SettingsRules.socketProblem
        ) { value in c.editSocket(value) }
        return kit.form(reset: resetLink(kit, what: SettingsSection.terminal.resetName) { c.reset(.terminal) }, [
            kit.group(
                "tmux",
                note: "DevHub keeps its terminal sessions on a socket of its own, so they survive quitting. Everything else on this screen applies as you change it; the socket asks first, because changing it closes the sessions DevHub has there.",
                [
                    kit.row("Socket", help: moved ? "Not applied — DevHub is still using “\(effective)”." : nil, [socket]),
                    kit.row("Options", [kit.vertical([
                        kit.check("Force UTF-8  -u", checked: runtimes.tmuxArgs.contains("-u")) { setArgs("-u", $0) },
                        kit.check("Force 256 colours  -2", checked: runtimes.tmuxArgs.contains("-2")) { setArgs("-2", $0) },
                    ], spacing: Space.s1)]),
                ]),
        ])
    }

    // MARK: - Advanced

    static func advanced(_ kit: SettingsKit, _ c: SettingsContext) -> NSView {
        let config = c.draft
        let resolved = c.snapshot.resolved
        let fields: [(WritableKeyPath<RuntimeConfig, String>, String, ProgramResolution)] = [
            (\.shell, "Shell", resolved.shell), (\.git, "Git", resolved.git), (\.tmux, "tmux", resolved.tmux),
        ]
        let programRows: [NSView] = fields.map { path, label, resolution in
            let (found, missing) = SettingsRules.resolvedText(resolution)
            let help: NSTextField = missing
                ? kit.label(found, size: 11, color: kit.tokens.waiting.nsColor, selectable: true)
                : kit.mono(found)
            if !missing { help.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular); help.textColor = kit.tokens.secondary.nsColor }
            return kit.row(label, helpView: help, [text(kit, "\(label) command", config.runtimes[keyPath: path], mono: true, validate: SettingsRules.runtimeProblem) { value in
                var next = c.draft
                next.runtimes[keyPath: path] = value
                c.update(next, rebuild: false)
            }])
        }
        var actions: [NSView] = [
            kit.button("Check Again", enabled: !c.busy) { c.recheck() },
            kit.button("Show Logs in Finder", enabled: !c.busy) { c.openLogs() },
            kit.button("Copy Summary", enabled: !c.busy) { c.copySummary() },
        ]
        if let status = c.status { actions.append(kit.caption(status)) }
        return kit.form(reset: resetLink(kit, what: SettingsSection.advanced.resetName) { c.reset(.advanced) }, [
            kit.group(
                "Programs",
                note: "A bare name is looked up on your PATH; a path is used as given. What DevHub found is shown under each one.",
                programRows),
            kit.group("Diagnostics", [
                kit.row("This session", [kit.mono(c.snapshot.sessionId)]),
                kit.row("Last quit", [kit.label(c.snapshot.previousExitText)]),
                kit.row(nil, [kit.horizontal(actions)]),
            ]),
        ])
    }
}

// MARK: - One command's key (`KeyboardRow`)

@MainActor
final class KeyRecorderButton: NSButton {
    var recording = false { didSet { refresh() } }
    var describe: String = "" { didSet { refresh() } }
    var onKey: ((ChordKey) -> Void)?

    func refresh() { title = recording ? "Press a key…" : describe }

    override var acceptsFirstResponder: Bool { true }

    override func keyDown(with event: NSEvent) {
        guard recording else { return super.keyDown(with: event) }
        if event.keyCode == 0x35 {
            recording = false
            return
        }
        let stroke = ChordDispatcher.stroke(event)
        guard let key = Chords.strokeAs(stroke) else { return }
        recording = false
        onKey?(key)
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        // A key with Command held arrives as a key equivalent first.
        guard recording, window?.firstResponder === self, event.type == .keyDown else { return super.performKeyEquivalent(with: event) }
        keyDown(with: event)
        return true
    }

    override func resignFirstResponder() -> Bool {
        recording = false
        return super.resignFirstResponder()
    }
}

@MainActor
enum KeyboardRowView {
    static func make(
        kit: SettingsKit, row: SettingsEdits.KeyboardRow, rows: [SettingsEdits.KeyboardRow], onRebind: @escaping (ChordKey) -> Void,
        onUnbind: @escaping () -> Void, onReset: @escaping () -> Void
    ) -> NSView {
        let recorder = KeyRecorderButton(title: "", target: nil, action: nil)
        recorder.bezelStyle = .rounded
        recorder.describe = row.keys.isEmpty ? "Unbound" : row.keys.map(ChordKeys.describe).joined(separator: "  ·  ")
        recorder.setAccessibilityLabel("Change the key for \(row.command.label)")
        recorder.translatesAutoresizingMaskIntoConstraints = false
        recorder.widthAnchor.constraint(greaterThanOrEqualToConstant: 110).isActive = true
        let start = kit.action { [weak recorder] _ in
            guard let recorder else { return }
            recorder.recording = true
            recorder.window?.makeFirstResponder(recorder)
        }
        recorder.target = start
        recorder.action = #selector(ControlAction.fire(_:))
        let conflictNote = kit.caption("")
        conflictNote.isHidden = true
        recorder.onKey = { key in
            if let conflict = SettingsEdits.conflict(key, owner: SettingsEdits.owner(of: key, in: rows), command: row.command) {
                conflictNote.stringValue = conflict
                conflictNote.isHidden = false
            }
            onRebind(key)
        }
        let unbind = kit.button("Unbind", enabled: !row.keys.isEmpty, onUnbind)
        let reset = kit.button("Reset", enabled: !row.atDefault, onReset)
        reset.toolTip = "Default: \(row.defaults.map(ChordKeys.describe).joined(separator: ", "))"
        let id = kit.mono(row.command.id.rawValue)
        id.font = NSFont.monospacedSystemFont(ofSize: 10, weight: .regular)
        id.textColor = kit.tokens.tertiary.nsColor
        return kit.row(row.command.label, help: SettingsEdits.needsNote(row.command.needs), helpView: conflictNote, [recorder, unbind, reset, id])
    }
}

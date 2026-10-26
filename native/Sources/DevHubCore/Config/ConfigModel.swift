// Port of apps/desktop/src/model/config.ts — the types, the constants and the
// defaults. Parsing and validation are in ConfigParsing.swift, the store in
// ConfigStore.swift.
//
// The user's configuration: `~/.config/devhub/settings.toml`.
//
// The rules that matter are kept exactly: unknown keys are an error rather than
// an ignored typo, the whole file is validated before any of it is adopted, a
// save is refused when the file changed underneath it, and the last file that
// parsed stays in effect while a broken one is on disk — with the diagnostic
// kept, so "still running on the old config" is a state the app can show
// rather than a silence.
//
// There is one file. DevHub reads it and DevHub writes it. `settingsMigration`
// folds the old local file in, once.
//
// A save keeps the document the person wrote: `TomlDocument` rewrites only the
// spans whose values actually changed, so comments, grouping, key order and
// spacing survive.
//
// Numbers are `Double` throughout, as they are in the TypeScript app (a JS
// `number`): a file may say `notice_seconds = 2.5` or `min_depth = 1.0`, and
// the rules are about the value, not the spelling.

import Foundation

public enum ConfigConstants {
    /// The shape this build writes.
    ///
    /// 2 says the shortcut buttons send without a review sheet. A file still
    /// saying 1 is read with the old default in mind and comes back as 2.
    ///
    /// 3 says a profile's `presentation` is an override of `[agents]
    /// default_presentation`.
    ///
    /// 4 says an Agent pane's colours follow the VS Code theme unless
    /// `[appearance] terminal_theme` names palettes.
    public static let schemaVersion: Double = 4
    /// The oldest file shape this build knows how to read.
    public static let oldestReadableVersion: Double = 1

    public static let configFileName = "settings.toml"
    /// The name of the per-machine file the settings were split across, once.
    public static let localConfigFileName = "settings.local.toml"
    /// The single file DevHub kept before that split.
    public static let legacyConfigFileName = "config.toml"

    public static let defaultExcludeNames: [String] = [".git", "node_modules", "target", "dist", "build", ".cache"]

    public static let defaultShell = "/bin/zsh"
    public static let defaultGit = "git"
    public static let defaultTmux = "tmux"
    public static let defaultTmuxSocket = "devhub"
    public static let defaultFontFamily = "ui-monospace"
    public static let maxTerminalMargin: Double = 64

    /// `model/terminalZoom.ts`: the font sizes a terminal may be set to.
    public static let minTerminalFontSize: Double = 9
    public static let maxTerminalFontSize: Double = 24

    /// `model/noticeCenter.ts` `DEFAULT_NOTICE_SECONDS`.
    public static let defaultNoticeSeconds: Double = 8
    /// See `GeneralConfig.terminalIdleSeconds`.
    public static let defaultTerminalIdleSeconds: Double = 5
    /// See `GeneralConfig.workbenchHibernateMinutes`.
    public static let defaultWorkbenchHibernateMinutes: Double = 10
    /// See `GeneralConfig.workbenchAwakeMax`.
    public static let defaultWorkbenchAwakeMax: Double = 2

    /// VS Code's default colour themes, and so DevHub's.
    public static let defaultThemeDark = "Dark 2026"
    public static let defaultThemeLight = "Light 2026"

    /// `model/conversation.ts` `DEFAULT_RESUME_MESSAGE`.
    public static let defaultResumeMessage = "続けて"

    /// `model/scratchDay.ts` `DEFAULT_SCRATCH_DAILY`.
    public static let defaultScratchDaily = "~/junk/YYYYMMDD"

    /// The two things the editor area can be, and the only values
    /// `general.workbench` takes. The native app always behaves as `terminal`
    /// (PLAN.md §1) but parses and preserves the key, since the file is shared
    /// with the TypeScript app.
    public static let workbenchModes: [String] = ["vscode", "terminal"]
    public static let defaultWorkbenchMode = "vscode"

    /// The three appearances DevHub can run in, and the only values
    /// `appearance.mode` takes.
    public static let appearanceModes: [String] = ["auto", "light", "dark"]

    /// The two kinds of chrome the one window can be built with: `shown` gives
    /// DevHub a title bar it draws itself, `hidden` is no bar at all — the
    /// traffic lights over the Sidebar's top corner, and the Sidebar doubling as
    /// the window's handle.
    public static let titleBarModes: [String] = ["shown", "hidden"]
    public static let defaultTitleBar = "shown"
}

/// What `general.workbench` says, once it is known to be one of the two.
public enum WorkbenchMode: String, Sendable, Equatable {
    case vscode
    case terminal
}

/// What `appearance.title_bar` says, once it is known to be one of the two.
public enum TitleBarMode: String, Sendable, Equatable {
    case shown
    case hidden
}

public enum WorkspaceKind: String, CaseIterable, Codable, Sendable, Hashable {
    case directory
    case gitRepository = "git_repository"
    case gitWorktree = "git_worktree"
}

public struct FilesystemSource: Equatable, Hashable, Sendable {
    public var id: String
    public var path: String
    public var minDepth: Double
    public var maxDepth: Double?
    public var kinds: [WorkspaceKind]
    public var includeHidden: Bool
    public var excludeNames: [String]

    public init(
        id: String,
        path: String,
        minDepth: Double = 0,
        maxDepth: Double? = nil,
        kinds: [WorkspaceKind] = [.directory],
        includeHidden: Bool = false,
        excludeNames: [String] = ConfigConstants.defaultExcludeNames
    ) {
        self.id = id
        self.path = path
        self.minDepth = minDepth
        self.maxDepth = maxDepth
        self.kinds = kinds
        self.includeHidden = includeHidden
        self.excludeNames = excludeNames
    }
}

public struct CommandSource: Equatable, Hashable, Sendable {
    public var id: String
    public var command: [String]
    public var timeoutMs: Double

    public init(id: String, command: [String], timeoutMs: Double = 2000) {
        self.id = id
        self.command = command
        self.timeoutMs = timeoutMs
    }
}

/// One folder, named by today's date: `~/workspace/daily/YYYY/MMDD`.
///
/// The tokens and their meanings are in `DateTemplate`. There is no depth and
/// no walk, because there is nothing to search: the template names exactly one
/// folder, and that folder is today's.
///
/// `createIfMissing` is what makes it useful on the day it matters. A daily
/// folder does not exist until something makes it, and the moment a person
/// wants it is the moment before it exists — so the row is offered anyway, and
/// choosing it makes the folder. Turned off, the source is simply silent on any
/// day the folder is not there yet.
public struct DateSource: Equatable, Hashable, Sendable {
    public var id: String
    public var path: String
    public var createIfMissing: Bool

    public init(id: String, path: String, createIfMissing: Bool = true) {
        self.id = id
        self.path = path
        self.createIfMissing = createIfMissing
    }
}

/// `[[workspace_sources]]`: where the Workspace picker looks.
public enum WorkspaceSource: Equatable, Hashable, Sendable {
    case filesystem(FilesystemSource)
    case command(CommandSource)
    case date(DateSource)

    public var id: String {
        switch self {
        case .filesystem(let source): return source.id
        case .command(let source): return source.id
        case .date(let source): return source.id
        }
    }

    /// The `type` the file spells it with.
    public var type: String {
        switch self {
        case .filesystem: return "filesystem"
        case .command: return "command"
        case .date: return "date"
        }
    }
}

public enum AgentProfileKind: String, CaseIterable, Codable, Sendable, Hashable {
    case codex
    case claude
    case cursor
    case custom

    /// The program a known kind runs when the file does not name one.
    ///
    /// For Codex and Claude this is the kind's own name, which is why nobody
    /// has to write a `command` for them. Cursor is the reason this is a
    /// function rather than the identity: its kind is `cursor` and its program
    /// is `cursor-agent`. `cursor` is itself a real command on any machine with
    /// the editor installed — it opens the editor — so defaulting to the kind's
    /// name would have started the wrong program. `custom` has none.
    public var defaultCommand: String? {
        switch self {
        case .codex: return "codex"
        case .claude: return "claude"
        case .cursor: return "cursor-agent"
        case .custom: return nil
        }
    }

    /// The presentations a kind can have (`model/domain.ts`
    /// `presentationsFor`): only Claude and Codex have a GUI.
    public var presentations: [AgentPresentation] {
        self == .claude || self == .codex ? [.tui, .gui] : [.tui]
    }
}

/// `"tui"`, the CLI's own screen in a terminal, or `"gui"`, DevHub's
/// conversation view (`model/domain.ts` `AGENT_PRESENTATIONS`).
public enum AgentPresentation: String, CaseIterable, Codable, Sendable, Hashable {
    case tui
    case gui
}

/// What DevHub says to an Agent when it takes an action on the person's behalf.
///
/// The trigger is data, spelled in the file (`[agent_actions.commit.tidy_up]`)
/// and read from there. See `AgentActions` for the triggers, the variables each
/// one offers and the skill notation.
public struct ConfiguredAgentAction: Equatable, Hashable, Sendable {
    /// What fires it: the Issue flow, or one of the workspace's own buttons.
    public var trigger: AgentActionTrigger
    public var id: String
    public var displayName: String
    public var template: String
    /// Whether the wording is put in front of the person before it is sent.
    ///
    /// Per action rather than per place it is fired from: a template is a
    /// sentence somebody wrote once and may be right every time ("commit what
    /// is here") or worth a look every time ("implement this Issue").
    public var confirmBeforeSend: Bool
    /// Whether a Smart Button is drawn for it while its trigger's condition
    /// holds. Off, the action is still in the Agent actions sheet. Only a Smart
    /// Button trigger has it: an Issue action's is always `false`.
    public var button: Bool
    /// Whether this action exists at all — the way a person removes one DevHub
    /// ships. Built-ins are merged in by id rather than listed by the file, so
    /// "not mentioned" cannot mean "gone", and being gone is said out loud.
    public var enabled: Bool
    /// Where it sits among the actions with its trigger. A number rather than
    /// the file's key order, because a table's keys are a set.
    public var order: Double

    public init(
        trigger: AgentActionTrigger,
        id: String,
        displayName: String,
        template: String,
        confirmBeforeSend: Bool,
        button: Bool,
        enabled: Bool,
        order: Double
    ) {
        self.trigger = trigger
        self.id = id
        self.displayName = displayName
        self.template = template
        self.confirmBeforeSend = confirmBeforeSend
        self.button = button
        self.enabled = enabled
        self.order = order
    }
}

public struct ConfiguredAgentProfile: Equatable, Hashable, Sendable {
    public var id: String
    public var displayName: String
    public var kind: AgentProfileKind
    /// The program tmux runs as the Agent's session command. Absent in the
    /// file means the kind's own program (`AgentProfileKind.defaultCommand`).
    /// It is separate from `kind` because the two answer different questions:
    /// this one is what to start, and `kind` is whose screen it is.
    public var command: String
    public var args: [String]
    /// The environment, in the file's order.
    public var env: OrderedStringMap
    /// How an Agent from this profile is shown unless its launch says
    /// otherwise. `nil` means `[agents] default_presentation` — see
    /// `profilePresentation`.
    public var presentation: AgentPresentation?

    public init(
        id: String,
        displayName: String,
        kind: AgentProfileKind,
        command: String,
        args: [String] = [],
        env: OrderedStringMap = OrderedStringMap(),
        presentation: AgentPresentation? = nil
    ) {
        self.id = id
        self.displayName = displayName
        self.kind = kind
        self.command = command
        self.args = args
        self.env = env
        self.presentation = presentation
    }
}

public struct AgentsConfig: Equatable, Hashable, Sendable {
    /// How an Agent is shown when neither its launch nor its profile says. A
    /// kind without that presentation is shown as a terminal instead: a default
    /// is a preference, not a demand on every kind.
    public var defaultPresentation: AgentPresentation
    /// Whether a GUI Agent a usage limit stopped is gone on with once the limit
    /// has reset: `resumeAfterLimitMessage` is written for the person then.
    public var resumeAfterLimit: Bool
    /// What is written: never empty.
    public var resumeAfterLimitMessage: String
    /// Whether an idle GUI Claude Agent's conversation is compacted shortly
    /// before its prompt cache expires. Conversations under
    /// `autoCompactMinTokens` are left alone.
    public var autoCompactBeforeCacheExpiry: Bool
    /// How long before the cache expires it is compacted, in seconds (> 0).
    public var autoCompactLeadSeconds: Double
    /// The least context, in tokens, a conversation needs to be worth compacting (>= 0).
    public var autoCompactMinTokens: Double

    public init(
        defaultPresentation: AgentPresentation = .tui,
        resumeAfterLimit: Bool = true,
        resumeAfterLimitMessage: String = ConfigConstants.defaultResumeMessage,
        autoCompactBeforeCacheExpiry: Bool = true,
        autoCompactLeadSeconds: Double = 60,
        autoCompactMinTokens: Double = 100_000
    ) {
        self.defaultPresentation = defaultPresentation
        self.resumeAfterLimit = resumeAfterLimit
        self.resumeAfterLimitMessage = resumeAfterLimitMessage
        self.autoCompactBeforeCacheExpiry = autoCompactBeforeCacheExpiry
        self.autoCompactLeadSeconds = autoCompactLeadSeconds
        self.autoCompactMinTokens = autoCompactMinTokens
    }
}

public struct GeneralConfig: Equatable, Hashable, Sendable {
    public var importLoginEnvironment: Bool
    /// Notify (OS notification, in-app toast) when an Agent finishes or needs the person.
    public var notifyOnIdle: Bool
    /// Play a sound with that notification.
    public var notifySound: Bool
    /// How long one of DevHub's own notices stays on screen before it hides
    /// itself into the notice center, in seconds. `0` never hides one.
    public var noticeSeconds: Double
    /// How long a command in a Workspace terminal may print nothing before the
    /// Sidebar counts it as finished, in seconds. `0` never counts a quiet
    /// command as finished.
    public var terminalIdleSeconds: Double
    /// VS Code mode only: close a Workspace's workbench after its editor has
    /// been off screen this many minutes. Parsed and preserved.
    public var workbenchHibernateMinutes: Double
    /// VS Code mode only: at most this many workbenches stay up. Parsed and preserved.
    public var workbenchAwakeMax: Double
    /// What the editor area is: `vscode` or `terminal`. The native app always
    /// behaves as `terminal`; the value is kept so the TypeScript app reads the
    /// same file the same way.
    public var workbench: String

    public init(
        importLoginEnvironment: Bool = true,
        notifyOnIdle: Bool = true,
        notifySound: Bool = true,
        noticeSeconds: Double = ConfigConstants.defaultNoticeSeconds,
        terminalIdleSeconds: Double = ConfigConstants.defaultTerminalIdleSeconds,
        workbenchHibernateMinutes: Double = ConfigConstants.defaultWorkbenchHibernateMinutes,
        workbenchAwakeMax: Double = ConfigConstants.defaultWorkbenchAwakeMax,
        workbench: String = ConfigConstants.defaultWorkbenchMode
    ) {
        self.importLoginEnvironment = importLoginEnvironment
        self.notifyOnIdle = notifyOnIdle
        self.notifySound = notifySound
        self.noticeSeconds = noticeSeconds
        self.terminalIdleSeconds = terminalIdleSeconds
        self.workbenchHibernateMinutes = workbenchHibernateMinutes
        self.workbenchAwakeMax = workbenchAwakeMax
        self.workbench = workbench
    }
}

public struct RuntimeConfig: Equatable, Hashable, Sendable {
    public var shell: String
    public var git: String
    public var tmux: String
    public var tmuxSocketName: String
    public var tmuxArgs: [String]

    public init(
        shell: String = ConfigConstants.defaultShell,
        git: String = ConfigConstants.defaultGit,
        tmux: String = ConfigConstants.defaultTmux,
        tmuxSocketName: String = ConfigConstants.defaultTmuxSocket,
        tmuxArgs: [String] = []
    ) {
        self.shell = shell
        self.git = git
        self.tmux = tmux
        self.tmuxSocketName = tmuxSocketName
        self.tmuxArgs = tmuxArgs
    }
}

public struct AppearanceConfig: Equatable, Hashable, Sendable {
    /// Whether DevHub draws a title bar at the top of the window. Read once,
    /// when the window is made; changing it takes a relaunch.
    public var titleBar: String
    /// Which appearance DevHub runs in: `auto`, `light` or `dark`. Not a
    /// palette: it decides which of `themeDark` and `themeLight` DevHub wears.
    public var mode: String
    /// The VS Code colour theme DevHub wears in the dark and the light
    /// appearance, named as VS Code names it (or by its label).
    public var themeDark: String
    public var themeLight: String
    public var terminalFontFamily: String
    public var terminalFontSize: Double
    /// The row height, as a multiple of the font's own line box. `1` is the
    /// default: the cell is the line box the font itself asks for.
    public var terminalLineHeight: Double
    /// How far one notch of the wheel, or one flick of the trackpad, scrolls a
    /// pane: a multiplier on what the mouse reports, in lines (0.1–20).
    public var terminalScrollSensitivity: Double
    public var sidebarDensity: String
    public var terminalMargin: Double
    public var terminalTheme: TerminalThemeConfig

    public init(
        titleBar: String = ConfigConstants.defaultTitleBar,
        mode: String = "auto",
        themeDark: String = ConfigConstants.defaultThemeDark,
        themeLight: String = ConfigConstants.defaultThemeLight,
        terminalFontFamily: String = ConfigConstants.defaultFontFamily,
        terminalFontSize: Double = 13,
        terminalLineHeight: Double = 1,
        terminalScrollSensitivity: Double = 3,
        sidebarDensity: String = "compact",
        terminalMargin: Double = 4,
        terminalTheme: TerminalThemeConfig = .vscode
    ) {
        self.titleBar = titleBar
        self.mode = mode
        self.themeDark = themeDark
        self.themeLight = themeLight
        self.terminalFontFamily = terminalFontFamily
        self.terminalFontSize = terminalFontSize
        self.terminalLineHeight = terminalLineHeight
        self.terminalScrollSensitivity = terminalScrollSensitivity
        self.sidebarDensity = sidebarDensity
        self.terminalMargin = terminalMargin
        self.terminalTheme = terminalTheme
    }
}

/// What `[keybindings]` says, before it means anything (`model/commands.ts`).
///
/// `chords` is the file's own table: the second stroke as a key string, and the
/// command id it should reach. An entry whose value is the empty string unbinds
/// that key — which is the only way to take a shipped chord away, because a
/// table states what somebody wrote and silence has to keep meaning "the
/// default".
public struct KeybindingsSpec: Equatable, Hashable, Sendable {
    public var prefix: String
    public var chords: OrderedStringMap

    public init(prefix: String = KeybindingsSpec.defaultPrefix, chords: OrderedStringMap = OrderedStringMap()) {
        self.prefix = prefix
        self.chords = chords
    }

    /// `DEFAULT_CHORD_PREFIX`.
    public static let defaultPrefix = "Cmd+q"
}

public struct ScratchConfig: Equatable, Hashable, Sendable {
    /// A date path (`DateTemplate`), e.g. `~/junk/YYYYMMDD`.
    public var daily: String

    public init(daily: String = ConfigConstants.defaultScratchDaily) {
        self.daily = daily
    }
}

public struct ProjectsConfig: Equatable, Hashable, Sendable {
    /// Where new projects go: an absolute or `~/` path, taken as written (no
    /// date tokens). Absent, the folder is derived from the workspace sources.
    public var directory: String?

    public init(directory: String? = nil) {
        self.directory = directory
    }
}

public struct Config: Equatable, Hashable, Sendable {
    public var version: Double
    public var general: GeneralConfig
    public var runtimes: RuntimeConfig
    public var appearance: AppearanceConfig
    /// What arms a chord, and what the second stroke reaches. Overrides only:
    /// every key `chords` does not mention keeps the command DevHub ships it with.
    public var keybindings: KeybindingsSpec
    public var workspaceSources: [WorkspaceSource]
    /// Where Scratch is: today's daily folder.
    public var scratch: ScratchConfig
    /// Where a new project or a clone goes by default.
    public var projects: ProjectsConfig
    /// `[agents]`: what holds for every profile unless the profile says otherwise.
    public var agents: AgentsConfig
    public var agentProfiles: [ConfiguredAgentProfile]
    public var agentActions: [ConfiguredAgentAction]

    public init(
        version: Double,
        general: GeneralConfig,
        runtimes: RuntimeConfig,
        appearance: AppearanceConfig,
        keybindings: KeybindingsSpec,
        workspaceSources: [WorkspaceSource],
        scratch: ScratchConfig,
        projects: ProjectsConfig,
        agents: AgentsConfig,
        agentProfiles: [ConfiguredAgentProfile],
        agentActions: [ConfiguredAgentAction]
    ) {
        self.version = version
        self.general = general
        self.runtimes = runtimes
        self.appearance = appearance
        self.keybindings = keybindings
        self.workspaceSources = workspaceSources
        self.scratch = scratch
        self.projects = projects
        self.agents = agents
        self.agentProfiles = agentProfiles
        self.agentActions = agentActions
    }

    /// `defaultConfig()`.
    public static var defaults: Config {
        Config(
            version: ConfigConstants.schemaVersion,
            general: GeneralConfig(),
            runtimes: RuntimeConfig(),
            appearance: AppearanceConfig(),
            keybindings: KeybindingsSpec(),
            workspaceSources: defaultWorkspaceSources,
            scratch: ScratchConfig(),
            projects: ProjectsConfig(),
            agents: AgentsConfig(),
            agentProfiles: defaultAgentProfiles,
            agentActions: defaultAgentActions
        )
    }

    /// Where DevHub looks for a workspace when nobody has said: nowhere.
    ///
    /// Empty, and deliberately. Every default this ever had was one person's
    /// layout, and none of them is true of the next machine. A source whose
    /// root is not there is a source that *fails*, so a shipped guess opens a
    /// new installation's first picker onto errors about folders the person has
    /// never heard of. So the picker starts with New Project and Clone Project
    /// and says, where the list would be, that no sources have been added yet.
    public static var defaultWorkspaceSources: [WorkspaceSource] { [] }

    public static var defaultAgentProfiles: [ConfiguredAgentProfile] {
        [
            ConfiguredAgentProfile(id: "codex", displayName: "Codex", kind: .codex, command: "codex"),
            ConfiguredAgentProfile(id: "claude", displayName: "Claude", kind: .claude, command: "claude"),
            // Cursor has a manifest, so `cursor` reads the two states the
            // manifest is confident about: a turn running, and a turn stopped
            // to ask. It never says `idle`, so the injection queue never types
            // into a Cursor pane.
            ConfiguredAgentProfile(id: "cursor", displayName: "Cursor", kind: .cursor, command: "cursor-agent"),
        ]
    }

    /// The actions DevHub ships: the Issue flow's, and one per shortcut button,
    /// each numbered within its own trigger.
    public static var defaultAgentActions: [ConfiguredAgentAction] {
        var seen: [AgentActionTrigger: Double] = [:]
        return AgentActions.builtIn.map { action in
            let order = seen[action.trigger] ?? 0
            seen[action.trigger] = order + 1
            return ConfiguredAgentAction(
                trigger: action.trigger,
                id: action.id,
                displayName: action.displayName,
                template: action.template,
                confirmBeforeSend: action.confirmBeforeSend,
                button: action.trigger.isSmartButton,
                enabled: true,
                order: order
            )
        }
    }

    /// The configuration a non-default profile actually runs on.
    ///
    /// `runtimes.tmux_socket_name` is the one setting a person can write that
    /// would undo the separation a profile exists for: two DevHubs on one tmux
    /// server manage each other's sessions. The profile wins, rather than the
    /// app refusing to start, and the override is returned so it can be logged.
    public func withProfileRuntimes(_ locations: ProfileLocations) -> (config: Config, overriddenSocketName: String?) {
        if locations.isDefault || runtimes.tmuxSocketName == locations.tmuxSocketName {
            return (self, nil)
        }
        var config = self
        config.runtimes.tmuxSocketName = locations.tmuxSocketName
        return (config, runtimes.tmuxSocketName)
    }
}

/// The presentation a profile's Agents get unless a launch says otherwise: the
/// profile's own word, else the app-wide default where its kind has it, else a
/// terminal. The one place that answer is worked out.
public func profilePresentation(kind: AgentProfileKind, presentation: AgentPresentation?, agents: AgentsConfig) -> AgentPresentation {
    if let presentation { return presentation }
    return kind.presentations.contains(agents.defaultPresentation) ? agents.defaultPresentation : .tui
}

public func profilePresentation(_ profile: ConfiguredAgentProfile, agents: AgentsConfig) -> AgentPresentation {
    profilePresentation(kind: profile.kind, presentation: profile.presentation, agents: agents)
}

/// The file the configuration is in, and the two it can arrive from.
///
/// `file` is the one DevHub reads and writes. `local` is the per-machine half
/// of the old two-file arrangement and `legacy` the pre-split `config.toml`;
/// `ConfigStore.load` folds each into `file` once and then never looks at them
/// again.
public struct ConfigPaths: Equatable, Sendable {
    public var file: String
    public var local: String?
    public var legacy: String?

    public init(file: String, local: String? = nil, legacy: String? = nil) {
        self.file = file
        self.local = local
        self.legacy = legacy
    }

    /// Where the settings live: the profile's config directory
    /// (`~/.config/devhub/`, `~/.config/devhub-<profile>/`, or under
    /// `$XDG_CONFIG_HOME`).
    public static func defaults(for locations: ProfileLocations) -> ConfigPaths {
        let directory = locations.configDirectory
        return ConfigPaths(
            file: Path.join(directory, ConfigConstants.configFileName),
            local: Path.join(directory, ConfigConstants.localConfigFileName),
            legacy: Path.join(directory, ConfigConstants.legacyConfigFileName)
        )
    }
}

/// The parts of a configuration a screen can be put back to its defaults,
/// named by their `Config` property.
public enum ConfigScopeKey: String, CaseIterable, Sendable {
    case general
    case runtimes
    case appearance
    case keybindings
    case workspaceSources
    case scratch
    case projects
    case agents
    case agentProfiles
    case agentActions
}

extension Config {
    /// This config with `keys` put back to the defaults.
    public func resetting(_ keys: [ConfigScopeKey]) -> Config {
        let defaults = Config.defaults
        var reset = self
        for key in keys {
            switch key {
            case .general: reset.general = defaults.general
            case .runtimes: reset.runtimes = defaults.runtimes
            case .appearance: reset.appearance = defaults.appearance
            case .keybindings: reset.keybindings = defaults.keybindings
            case .workspaceSources: reset.workspaceSources = defaults.workspaceSources
            case .scratch: reset.scratch = defaults.scratch
            case .projects: reset.projects = defaults.projects
            case .agents: reset.agents = defaults.agents
            case .agentProfiles: reset.agentProfiles = defaults.agentProfiles
            case .agentActions: reset.agentActions = defaults.agentActions
            }
        }
        return reset
    }
}

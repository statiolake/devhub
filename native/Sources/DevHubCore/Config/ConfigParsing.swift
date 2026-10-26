// Port of apps/desktop/src/model/config.ts — validation, parsing (the file's
// text to a `Config`) and the document a `Config` is written back as.
//
// The rules are the TypeScript app's, line for line, and so are the
// diagnostics: the same code at the same dotted path for the same file, which
// is what lets either app explain a file the other refused.

import Foundation

public enum ConfigParsing {
    // MARK: retired keys

    /// Keys a past DevHub read and this one does not, with why they went.
    ///
    /// An unknown key is an error on purpose: a typo must not be quietly
    /// ignored. But a key DevHub itself told people to write is not their typo,
    /// and refusing to start over one would make DevHub's own change of mind
    /// their problem. So a retired key loads, is ignored, and says so once.
    /// The next save drops it from the document.
    public static let retiredKeys: [(key: String, replacement: String)] = [
        (
            "appearance.color_scheme",
            "DevHub's colours are the VS Code theme named by `appearance.theme_dark` / `appearance.theme_light`; to choose light or dark for DevHub itself, use `appearance.mode`"
        ),
        (
            "runtimes.herdr",
            "an Agent is now a tmux session on DevHub's own socket, so there is no separate Agent runtime to point at; the program to run is each profile's own `command`"
        ),
    ]

    static func isRetired(_ path: String) -> Bool { retiredKeys.contains { $0.key == path } }

    /// Which retired keys a parsed document still names.
    public static func retiredKeysIn(_ document: TomlTable) -> [RetiredKeyNotice] {
        var notices: [RetiredKeyNotice] = []
        for (key, replacement) in retiredKeys {
            var cursor: TomlValue? = .table(document)
            for segment in key.split(separator: ".") {
                guard let table = plainObject(cursor) else {
                    cursor = nil
                    break
                }
                cursor = table[String(segment)]
            }
            if cursor != nil { notices.append(RetiredKeyNotice(key: key, replacement: replacement)) }
        }
        return notices
    }

    // MARK: helpers (the TS `isPlainObject`, `checkKeys`, `optional*`)

    /// `isPlainObject`: a table — or a date-time, which is a JS `Date`, an
    /// object with no keys of its own. Kept so a date where a table belongs is
    /// read the way the TypeScript app reads it.
    static func plainObject(_ value: TomlValue?) -> TomlTable? {
        switch value {
        case .table(let table)?: return table
        case .datetime?: return TomlTable()
        default: return nil
        }
    }

    static func fail(_ code: ValidationCode, _ path: String? = nil) -> ConfigError {
        ConfigError(code: code, path: path)
    }

    static func checkKeys(_ table: TomlTable, _ allowed: [String], _ prefix: String) throws {
        for key in table.keys {
            if allowed.contains(key) { continue }
            let path = prefix.isEmpty ? key : "\(prefix).\(key)"
            // Ignored on purpose. *Saying* it is ignored is `retiredKeysIn`'s job.
            if isRetired(path) { continue }
            throw fail(.unknownKey, path)
        }
    }

    static func requireTable(_ value: TomlValue?, _ path: String) throws -> TomlTable {
        guard let table = plainObject(value) else { throw fail(.invalidType, path) }
        return table
    }

    static func optionalString(_ table: TomlTable, _ key: String, _ path: String, _ fallback: String) throws -> String {
        guard let value = table[key] else { return fallback }
        guard case .string(let string) = value else { throw fail(.invalidType, "\(path).\(key)") }
        return string
    }

    /// A string the document must carry. Absence is a missing field, not a
    /// default: there is no value DevHub could supply that would be the
    /// author's intent.
    static func requiredString(_ table: TomlTable, _ key: String, _ path: String) throws -> String {
        guard let value = table[key] else { throw fail(.missingRequiredField, "\(path).\(key)") }
        guard case .string(let string) = value else { throw fail(.invalidType, "\(path).\(key)") }
        return string
    }

    static func optionalNumber(_ table: TomlTable, _ key: String, _ path: String, _ fallback: Double) throws -> Double {
        guard let value = table[key] else { return fallback }
        guard case .number(let number) = value else { throw fail(.invalidType, "\(path).\(key)") }
        return number
    }

    /// An `[agents]` number that must be finite and above zero (or at least zero).
    static func positiveNumber(_ table: TomlTable, _ key: String, _ fallback: Double, zeroAllowed: Bool) throws -> Double {
        let value = try optionalNumber(table, key, "agents", fallback)
        if !value.isFinite || value < 0 || (!zeroAllowed && value == 0) { throw fail(.invalidType, "agents.\(key)") }
        return value
    }

    /// A `general` number that is finite, zero allowed.
    static func generalDuration(_ table: TomlTable, _ key: String, _ fallback: Double) throws -> Double {
        let value = try optionalNumber(table, key, "general", fallback)
        if !value.isFinite || value < 0 { throw fail(.invalidType, "general.\(key)") }
        return value
    }

    static func optionalBoolean(_ table: TomlTable, _ key: String, _ path: String, _ fallback: Bool) throws -> Bool {
        guard let value = table[key] else { return fallback }
        guard case .bool(let bool) = value else { throw fail(.invalidType, "\(path).\(key)") }
        return bool
    }

    static func optionalStringArray(_ table: TomlTable, _ key: String, _ path: String, _ fallback: [String]) throws -> [String] {
        guard let value = table[key] else { return fallback }
        guard case .array(let items) = value else { throw fail(.invalidType, "\(path).\(key)") }
        var strings: [String] = []
        for item in items {
            guard case .string(let string) = item else { throw fail(.invalidType, "\(path).\(key)") }
            strings.append(string)
        }
        return strings
    }

    // MARK: palettes

    static let paletteKeys = ["background", "foreground", "cursor", "cursor_text", "selection_background", "selection_foreground", "ansi"]

    static func paletteFromTable(_ value: TomlValue?, _ path: String, _ fallback: TerminalPalette) throws -> TerminalPalette {
        let table = try requireTable(value, path)
        try checkKeys(table, paletteKeys, path)
        return TerminalPalette(
            background: try optionalString(table, "background", path, fallback.background),
            foreground: try optionalString(table, "foreground", path, fallback.foreground),
            cursor: try optionalString(table, "cursor", path, fallback.cursor),
            cursorText: try optionalString(table, "cursor_text", path, fallback.cursorText),
            selectionBackground: try optionalString(table, "selection_background", path, fallback.selectionBackground),
            selectionForeground: try optionalString(table, "selection_foreground", path, fallback.selectionForeground ?? fallback.foreground),
            ansi: try optionalStringArray(table, "ansi", path, fallback.ansi)
        )
    }

    static func isHexColor(_ value: String) -> Bool {
        let scalars = Array(value.unicodeScalars)
        guard scalars.count == 7, scalars[0] == "#" else { return false }
        return scalars.dropFirst().allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) || ("A"..."F").contains($0) }
    }

    static func paletteIsValid(_ palette: TerminalPalette) -> Bool {
        guard palette.ansi.count == 16 else { return false }
        let colours = [
            palette.background, palette.foreground, palette.cursor, palette.cursorText,
            palette.selectionBackground, palette.selectionForeground ?? "",
        ] + palette.ansi
        return colours.allSatisfy(isHexColor)
    }

    // MARK: small rules

    public static func isValidSocketName(_ value: String) -> Bool {
        let length = JSString.length(value)
        guard length > 0, length <= 64 else { return false }
        return value.unicodeScalars.allSatisfy { s in
            ("A"..."Z").contains(s) || ("a"..."z").contains(s) || ("0"..."9").contains(s) || s == "_" || s == "." || s == "-"
        }
    }

    public static func isSafeTmuxArgument(_ argument: String) -> Bool {
        argument == "-u" || argument == "-2"
    }

    static func isEnvironmentName(_ name: String) -> Bool {
        let scalars = Array(name.unicodeScalars)
        guard let first = scalars.first, ("A"..."Z").contains(first) || ("a"..."z").contains(first) || first == "_" else { return false }
        return scalars.allSatisfy { ("A"..."Z").contains($0) || ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "_" }
    }

    /// `^[a-z][a-z0-9_-]{0,63}$`: what the config calls an entry.
    static func isValidId(_ id: String) -> Bool {
        let scalars = Array(id.unicodeScalars)
        guard let first = scalars.first, ("a"..."z").contains(first), scalars.count <= 64 else { return false }
        return scalars.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "_" || $0 == "-" }
    }

    static func validateId(_ id: String, _ path: String) throws {
        if !isValidId(id) { throw fail(.invalidId, path) }
    }

    /// An absolute path, `~`, or one starting with `~/`: what a folder setting takes.
    public static func isHomeOrAbsolutePath(_ path: String) -> Bool {
        !path.jsIncludes("\0") && (path.jsStartsWith("/") || path == "~" || path.jsStartsWith("~/"))
    }

    static func validatePath(_ path: String, _ key: String) throws {
        if !isHomeOrAbsolutePath(path) { throw fail(.invalidWorkspacePath, key) }
    }

    /// `model/fontFamily.ts` `isValidFontFamily` (also WP8's `FontFamily.isValid`).
    static func isValidFontFamily(_ value: String) -> Bool {
        FontFamily.isValid(value)
    }

    /// `model/conversation.ts` `resumeMessageProblem`.
    static func resumeMessageProblem(_ text: String) -> Bool {
        JSString.trim(text).isEmpty || text.jsIncludes("\0")
    }

    // MARK: validation

    static func validateRuntimes(_ runtimes: RuntimeConfig) throws {
        for (key, value) in [("shell", runtimes.shell), ("git", runtimes.git), ("tmux", runtimes.tmux)] {
            if value.jsIncludes("\0") { throw fail(.invalidString, "runtimes.\(key)") }
            let valid = value.jsStartsWith("/") || value == "~" || value.jsStartsWith("~/") || (!value.isEmpty && !value.jsIncludes("/"))
            if !valid { throw fail(.invalidRuntime, "runtimes.\(key)") }
        }
        if !isValidSocketName(runtimes.tmuxSocketName) {
            throw fail(.invalidSocketName, "runtimes.tmux_socket_name")
        }
        for (index, argument) in runtimes.tmuxArgs.enumerated() {
            if argument.jsIncludes("\0") { throw fail(.invalidString, "runtimes.tmux_args[\(index)]") }
            if !isSafeTmuxArgument(argument) { throw fail(.forbiddenTmuxArgument, "runtimes.tmux_args[\(index)]") }
        }
    }

    static func validateAppearance(_ appearance: AppearanceConfig) throws {
        // Named on its own, and by the key it came from: a font family is the
        // one value in this table a person types freely.
        if !isValidFontFamily(appearance.terminalFontFamily) {
            throw fail(.invalidFontFamily, "appearance.terminal_font_family")
        }
        let paletteProblem: Bool
        switch appearance.terminalTheme {
        case .vscode: paletteProblem = false
        case .palettes(let palettes): paletteProblem = !paletteIsValid(palettes.light) || !paletteIsValid(palettes.dark)
        }
        if appearance.terminalFontSize < ConfigConstants.minTerminalFontSize
            || appearance.terminalFontSize > ConfigConstants.maxTerminalFontSize
            || !appearance.terminalLineHeight.isFinite
            || appearance.terminalLineHeight < 1
            || appearance.terminalLineHeight > 2
            || !appearance.terminalScrollSensitivity.isFinite
            || appearance.terminalScrollSensitivity < 0.1
            || appearance.terminalScrollSensitivity > 20
            || !ConfigConstants.appearanceModes.contains(appearance.mode)
            || !ConfigConstants.titleBarModes.contains(appearance.titleBar)
            || JSString.trim(appearance.themeDark).isEmpty
            || JSString.trim(appearance.themeLight).isEmpty
            || (appearance.sidebarDensity != "compact" && appearance.sidebarDensity != "comfortable")
            || appearance.terminalMargin > ConfigConstants.maxTerminalMargin
            || paletteProblem
        {
            throw fail(.invalidAppearance, "appearance")
        }
    }

    /// The keyboard, as a set: every problem `Commands.check` finds is a
    /// refusal, and the *first* of them is the one the diagnostic names.
    static func validateKeybindings(_ keybindings: KeybindingsSpec) throws {
        guard let problem = Commands.check(keybindings).first else { return }
        switch problem.code {
        case .unknownCommand: throw fail(.unknownCommand, problem.path)
        case .duplicateKey: throw fail(.duplicateIdentity, problem.path)
        case .invalidKey: throw fail(.invalidKeybinding, problem.path)
        }
    }

    static func validateWorkspaceSources(_ sources: [WorkspaceSource]) throws {
        var seen: [String: Int] = [:]
        for (index, source) in sources.enumerated() {
            let prefix = "workspace_sources[\(index)]"
            if let previous = seen[source.id] { throw fail(.duplicateIdentity, "\(prefix).id (also \(previous))") }
            seen[source.id] = index
            try validateId(source.id, "\(prefix).id")
            switch source {
            case .filesystem(let source):
                try validatePath(source.path, "\(prefix).path")
                let maxDepth = source.maxDepth ?? source.minDepth
                if maxDepth < source.minDepth || maxDepth > 16 { throw fail(.invalidWorkspaceDepth, "\(prefix).max_depth") }
                if source.kinds.isEmpty { throw fail(.invalidWorkspaceKind, "\(prefix).kinds") }
                let hasDirectory = source.kinds.contains(.directory)
                let hasGit = source.kinds.contains { $0 == .gitRepository || $0 == .gitWorktree }
                if hasDirectory && hasGit { throw fail(.invalidWorkspaceKind, "\(prefix).kinds") }
                for (excludeIndex, name) in source.excludeNames.enumerated() {
                    let glob = name.unicodeScalars.contains { "*?[]{}".unicodeScalars.contains($0) }
                    if name.isEmpty || name.jsIncludes("\0") || name.jsIncludes("/") || name.jsIncludes("\\") || glob {
                        throw fail(.invalidExclusion, "\(prefix).exclude_names[\(excludeIndex)]")
                    }
                }
            case .date(let source):
                try validatePath(source.path, "\(prefix).path")
                // The one thing about a template that can be wrong without
                // knowing what day it is.
                if !DateTemplate.bracketsBalance(source.path) { throw fail(.invalidDateTemplate, "\(prefix).path") }
                // The other thing, and the one nobody would ever see: a segment
                // that is a word with a token hiding in it.
                if let ambiguity = DateTemplate.ambiguity(source.path) {
                    throw fail(
                        .ambiguousDateToken,
                        "\(prefix).path (source \"\(source.id)\": the segment \"\(ambiguity.segment)\" contains the date token \(ambiguity.token); write it as \(ambiguity.escaped) to keep it as text)"
                    )
                }
            case .command(let source):
                if source.command.isEmpty || source.command.contains(where: { $0.jsIncludes("\0") }) {
                    throw fail(.invalidCommand, "\(prefix).command")
                }
                if source.timeoutMs < 100 || source.timeoutMs > 30000 { throw fail(.invalidTimeout, "\(prefix).timeout_ms") }
            }
        }
    }

    /// The actions, as a set: ids follow the same rule every other identifier
    /// follows, and two actions with one id would make the flow's answer
    /// ambiguous.
    static func validateAgentActions(_ actions: [ConfiguredAgentAction]) throws {
        var seen: [String: Int] = [:]
        for (index, action) in actions.enumerated() {
            let prefix = "agent_actions[\(index)]"
            if let previous = seen[action.id] { throw fail(.duplicateIdentity, "\(prefix).id (also \(previous))") }
            seen[action.id] = index
            try validateId(action.id, "\(prefix).id")
            // A nameless action is a row in the flow with nothing written on it.
            if JSString.trim(action.displayName).isEmpty { throw fail(.invalidProfile, "\(prefix).display_name") }
            // The Issue flow is not a button, so an Issue action cannot ask for one.
            if action.button && !action.trigger.isSmartButton { throw fail(.invalidProfile, "\(prefix).button") }
        }
    }

    static func validateAgentProfiles(_ profiles: [ConfiguredAgentProfile]) throws {
        var seen: [String: Int] = [:]
        for (index, profile) in profiles.enumerated() {
            let prefix = "agent_profiles[\(index)]"
            if let previous = seen[profile.id] { throw fail(.duplicateIdentity, "\(prefix).id (also \(previous))") }
            seen[profile.id] = index
            try validateId(profile.id, "\(prefix).id")
            if JSString.trim(profile.displayName).isEmpty || profile.displayName.jsIncludes("\0") {
                throw fail(.invalidProfile, "\(prefix).display_name")
            }
            if JSString.trim(profile.command).isEmpty || profile.command.jsIncludes("\0") {
                throw fail(.invalidProfile, "\(prefix).command")
            }
            if profile.args.contains(where: { $0.jsIncludes("\0") }) { throw fail(.invalidProfile, "\(prefix).args") }
            if let presentation = profile.presentation, !profile.kind.presentations.contains(presentation) {
                throw fail(.invalidProfile, "\(prefix).presentation")
            }
            for (key, value) in profile.env {
                if !isEnvironmentName(key) { throw fail(.invalidEnvironmentKey, "\(prefix).env") }
                if value.jsIncludes("\0") { throw fail(.invalidString, "\(prefix).env") }
            }
        }
    }

    public static func validate(_ config: Config) throws {
        if config.version != ConfigConstants.schemaVersion { throw fail(.unsupportedVersion, "version") }
        if !ConfigConstants.workbenchModes.contains(config.general.workbench) {
            throw fail(.invalidWorkbench, "general.workbench")
        }
        try validateRuntimes(config.runtimes)
        try validateAppearance(config.appearance)
        try validateKeybindings(config.keybindings)
        try validateWorkspaceSources(config.workspaceSources)
        if ScratchDaily.problem(config.scratch.daily) != nil { throw fail(.invalidScratchDaily, "scratch.daily") }
        if let directory = config.projects.directory, !isHomeOrAbsolutePath(directory) {
            throw fail(.invalidProjectDirectory, "projects.directory")
        }
        if resumeMessageProblem(config.agents.resumeAfterLimitMessage) {
            throw fail(.invalidResumeMessage, "agents.resume_after_limit_message")
        }
        try validateAgentProfiles(config.agentProfiles)
        try validateAgentActions(config.agentActions)
    }

    // MARK: parsing

    static let topLevelKeys = [
        "version", "general", "runtimes", "appearance", "keybindings", "workspace_sources",
        "scratch", "projects", "agents", "agent_profiles", "agent_actions",
    ]

    static func workspaceSource(_ value: TomlValue, _ index: Int) throws -> WorkspaceSource {
        let prefix = "workspace_sources[\(index)]"
        let table = try requireTable(value, prefix)
        let type = table["type"]
        if type == .string("date") {
            try checkKeys(table, ["id", "type", "path", "create_if_missing"], prefix)
            return .date(DateSource(
                id: try optionalString(table, "id", prefix, ""),
                path: try optionalString(table, "path", prefix, ""),
                createIfMissing: try optionalBoolean(table, "create_if_missing", prefix, true)
            ))
        }
        if type == .string("command") {
            try checkKeys(table, ["id", "type", "command", "timeout_ms"], prefix)
            return .command(CommandSource(
                id: try optionalString(table, "id", prefix, ""),
                command: try optionalStringArray(table, "command", prefix, []),
                timeoutMs: try optionalNumber(table, "timeout_ms", prefix, 2000)
            ))
        }
        if type == .string("filesystem") {
            try checkKeys(table, ["id", "type", "path", "min_depth", "max_depth", "kinds", "include_hidden", "exclude_names"], prefix)
            var maxDepth: Double?
            if let raw = table["max_depth"] {
                guard case .number(let number) = raw else { throw fail(.invalidType, "\(prefix).max_depth") }
                maxDepth = number
            }
            let kindNames = try optionalStringArray(table, "kinds", prefix, ["directory"])
            var kinds: [WorkspaceKind] = []
            for name in kindNames {
                guard let kind = WorkspaceKind(rawValue: name) else { throw fail(.invalidWorkspaceKind, "\(prefix).kinds") }
                kinds.append(kind)
            }
            return .filesystem(FilesystemSource(
                id: try optionalString(table, "id", prefix, ""),
                path: try optionalString(table, "path", prefix, ""),
                minDepth: try optionalNumber(table, "min_depth", prefix, 0),
                maxDepth: maxDepth,
                kinds: kinds,
                includeHidden: try optionalBoolean(table, "include_hidden", prefix, false),
                excludeNames: try optionalStringArray(table, "exclude_names", prefix, ConfigConstants.defaultExcludeNames)
            ))
        }
        throw fail(.invalidType, "\(prefix).type")
    }

    /// The actions, back out as `[agent_actions.<trigger>.<id>]`.
    ///
    /// Every action is written in full, including the ones DevHub ships
    /// unchanged: writing an unchanged action out as an absence would put back
    /// the "a file that predates an action deletes it" bug in a new place.
    static func agentActionsToTable(_ actions: [ConfiguredAgentAction]) -> TomlTable {
        var table = TomlTable()
        for action in actions {
            var group = table[action.trigger.rawValue]?.tableValue ?? TomlTable()
            // Counted before the entry is added: the entry being written is not
            // one of the ones already there.
            let position = Double(group.count)
            var entry: TomlTable = [
                "display_name": .string(action.displayName),
                "template": .string(action.template),
                "confirm_before_send": .bool(action.confirmBeforeSend),
            ]
            if action.trigger.isSmartButton { entry["button"] = .bool(action.button) }
            entry["enabled"] = .bool(action.enabled)
            // The position within its trigger, which is the only thing `order`
            // ever means.
            entry["order"] = .number(position)
            group[action.id] = .table(entry)
            table[action.trigger.rawValue] = .table(group)
        }
        return table
    }

    /// The one-time migration of `confirm_before_send` on the shortcut buttons.
    ///
    /// Every file DevHub has ever written says `confirm_before_send = true` for
    /// every action, because that is what the default used to be. On a
    /// **built-in** action whose wording is still exactly what DevHub ships,
    /// `true` is a copy of the old default rather than somebody's answer, and is
    /// migrated. An action somebody wrote, or edited, is theirs. It happens once
    /// because the file comes back as the current version.
    static func withoutTheOldConfirmDefault(_ actions: [ConfiguredAgentAction], fileVersion: Double) -> [ConfiguredAgentAction] {
        if fileVersion >= 2 { return actions }
        return actions.map { action in
            guard let shipped = AgentActions.builtIn.first(where: { $0.id == action.id && $0.trigger == action.trigger }) else {
                return action
            }
            let untouched = shipped.confirmBeforeSend == false && action.confirmBeforeSend
                && action.displayName == shipped.displayName && action.template == shipped.template
            guard untouched else { return action }
            var migrated = action
            migrated.confirmBeforeSend = shipped.confirmBeforeSend
            return migrated
        }
    }

    /// The one-time migration of a profile's `presentation`: before version 3
    /// every file said `presentation = "tui"` on every profile, so in an older
    /// file `"tui"` is taken for what it was — the default — and `"gui"`, which
    /// somebody chose, stays theirs.
    static func withoutTheOldPresentationDefault(_ profiles: [ConfiguredAgentProfile], fileVersion: Double) -> [ConfiguredAgentProfile] {
        if fileVersion >= 3 { return profiles }
        return profiles.map { profile in
            guard profile.presentation == .tui else { return profile }
            var migrated = profile
            migrated.presentation = nil
            return migrated
        }
    }

    /// `[appearance] terminal_theme`, as written: absent or `"vscode"` follows
    /// the VS Code theme, and a table is palettes. A table may name one scheme
    /// and leave the other out; the one left out is the built-in palette.
    static func terminalTheme(_ value: TomlValue?) throws -> TerminalThemeConfig {
        let path = "appearance.terminal_theme"
        guard let value else { return .vscode }
        if case .string(let word) = value {
            if word != TerminalThemeConfig.vscodeWord { throw fail(.invalidAppearance, path) }
            return .vscode
        }
        let table = try requireTable(value, path)
        try checkKeys(table, ["light", "dark"], path)
        return .palettes(TerminalPalettes(
            light: try paletteFromTable(table["light"] ?? .table(TomlTable()), "\(path).light", .defaultLight),
            dark: try paletteFromTable(table["dark"] ?? .table(TomlTable()), "\(path).dark", .defaultDark)
        ))
    }

    /// The one-time migration of `terminal_theme`: before version 4 every file
    /// DevHub wrote spelled the built-in palettes out in full. In an older file,
    /// palettes that are exactly the built-in ones are taken for the default.
    static func withoutTheOldTerminalThemeDefault(_ theme: TerminalThemeConfig, fileVersion: Double) -> TerminalThemeConfig {
        guard fileVersion < 4, case .palettes(let palettes) = theme else { return theme }
        let shipped = TerminalPalettes.defaults
        return paletteToTable(palettes.light) == paletteToTable(shipped.light)
            && paletteToTable(palettes.dark) == paletteToTable(shipped.dark) ? .vscode : theme
    }

    static func agentActions(_ value: TomlValue?, defaults: [ConfiguredAgentAction]) throws -> [ConfiguredAgentAction] {
        guard let value else { return defaults }
        // A file written before this shape existed. The id is what says which
        // action an entry was, and the built-ins the array had dropped come
        // back because the built-ins are no longer the array's to drop.
        if case .array(let items) = value {
            return overlay(defaults, try items.enumerated().map { try legacyAgentAction($1, $0) })
        }
        let table = try requireTable(value, "agent_actions")
        try checkKeys(table, AgentActionTrigger.ordered.map(\.rawValue), "agent_actions")
        var written: [ConfiguredAgentAction] = []
        for trigger in AgentActionTrigger.ordered {
            guard let raw = table[trigger.rawValue] else { continue }
            let group = try requireTable(raw, "agent_actions.\(trigger.rawValue)")
            for id in group.keys {
                written.append(try agentActionFromTable(group[id]!, trigger, id))
            }
        }
        return overlay(defaults, written)
    }

    /// The shipped set, with the file's word over it, in a stable order.
    ///
    /// An id the file names that DevHub also ships is one action, changed. An
    /// id it does not is one added, and it goes after everything with its
    /// trigger that was there already. `order` moves either of them.
    static func overlay(_ defaults: [ConfiguredAgentAction], _ written: [ConfiguredAgentAction]) -> [ConfiguredAgentAction] {
        var merged = defaults
        var taken = Set<Int>()
        for mine in written {
            let at = merged.indices.first { index in
                !taken.contains(index) && merged[index].id == mine.id && merged[index].trigger == mine.trigger
            }
            guard let at else {
                // Appended, not merged onto whatever happens to share its name:
                // two entries with one id is a file that has to be refused.
                merged.append(mine)
                continue
            }
            taken.insert(at)
            merged[at] = mine
        }
        // Grouped by trigger, and ordered within each group. Two separate
        // facts, so two separate steps.
        return AgentActionTrigger.ordered.flatMap { trigger -> [ConfiguredAgentAction] in
            let group = merged.filter { $0.trigger == trigger }.enumerated().map { (index: $0.offset, action: $0.element) }
            let sorted = group.sorted { left, right in
                left.action.order == right.action.order ? left.index < right.index : left.action.order < right.action.order
            }
            // Normalised, so `order` is always the position it means.
            return sorted.enumerated().map { position, entry in
                var action = entry.action
                action.order = Double(position)
                return action
            }
        }
    }

    /// One entry of the old `[[agent_actions]]` array.
    static func legacyAgentAction(_ value: TomlValue, _ index: Int) throws -> ConfiguredAgentAction {
        let prefix = "agent_actions[\(index)]"
        let table = try requireTable(value, prefix)
        try checkKeys(table, ["id", "display_name", "template", "confirm_before_send"], prefix)
        let id = try optionalString(table, "id", prefix, "")
        let shipped = AgentActions.builtIn.first { $0.id == id }
        let trigger = AgentActions.triggerOf(id)
        return ConfiguredAgentAction(
            trigger: trigger,
            id: id,
            displayName: try optionalString(table, "display_name", prefix, ""),
            template: try optionalString(table, "template", prefix, ""),
            confirmBeforeSend: try optionalBoolean(table, "confirm_before_send", prefix, shipped?.confirmBeforeSend ?? true),
            button: trigger.isSmartButton,
            enabled: true,
            // After whatever DevHub ships under the same trigger, in the
            // array's own order.
            order: Double(AgentActions.builtIn.count + index)
        )
    }

    static func agentActionFromTable(_ value: TomlValue, _ trigger: AgentActionTrigger, _ id: String) throws -> ConfiguredAgentAction {
        let prefix = "agent_actions.\(trigger.rawValue).\(id)"
        let table = try requireTable(value, prefix)
        // `button` only where there is a button.
        let smart = trigger.isSmartButton
        try checkKeys(table, ["display_name", "template", "confirm_before_send"] + (smart ? ["button"] : []) + ["enabled", "order"], prefix)
        let shipped = AgentActions.builtIn.first { $0.id == id }
        let defaultOrder: Double
        if let shipped {
            defaultOrder = Double(AgentActions.builtIn.filter { $0.trigger == trigger && $0 != shipped }.count)
        } else {
            defaultOrder = Double(AgentActions.builtIn.count)
        }
        return ConfiguredAgentAction(
            trigger: trigger,
            id: id,
            // A built-in that is only being switched off, or reordered, does
            // not have to restate its own wording.
            displayName: try optionalString(table, "display_name", prefix, shipped?.displayName ?? ""),
            template: try optionalString(table, "template", prefix, shipped?.template ?? ""),
            // Absent means whatever DevHub ships for that action, and for
            // anything DevHub does not ship it means "show me the wording".
            confirmBeforeSend: try optionalBoolean(table, "confirm_before_send", prefix, shipped?.confirmBeforeSend ?? true),
            button: smart ? try optionalBoolean(table, "button", prefix, true) : false,
            enabled: try optionalBoolean(table, "enabled", prefix, true),
            order: try optionalNumber(table, "order", prefix, defaultOrder)
        )
    }

    static func agentProfile(_ value: TomlValue, _ index: Int) throws -> ConfiguredAgentProfile {
        let prefix = "agent_profiles[\(index)]"
        let table = try requireTable(value, prefix)
        try checkKeys(table, ["id", "display_name", "kind", "command", "args", "env", "presentation"], prefix)
        guard case .string(let kindName)? = table["kind"], let kind = AgentProfileKind(rawValue: kindName) else {
            throw fail(.invalidProfileKind, "\(prefix).kind")
        }
        var presentation: AgentPresentation?
        if table["presentation"] != nil {
            let raw = try optionalString(table, "presentation", prefix, "")
            guard let parsed = AgentPresentation(rawValue: raw) else { throw fail(.invalidProfile, "\(prefix).presentation") }
            presentation = parsed
        }
        var env = OrderedStringMap()
        if let rawEnv = table["env"] {
            let envTable = try requireTable(rawEnv, "\(prefix).env")
            for (key, entry) in envTable.entries {
                guard case .string(let string) = entry else { throw fail(.invalidType, "\(prefix).env.\(key)") }
                env[key] = string
            }
        }
        let command: String
        if let defaultCommand = kind.defaultCommand {
            command = try optionalString(table, "command", prefix, defaultCommand)
        } else {
            // `custom` has no program of its own: the whole of what it says is
            // "run this", so it has to say it.
            command = try requiredString(table, "command", prefix)
        }
        return ConfiguredAgentProfile(
            id: try optionalString(table, "id", prefix, ""),
            displayName: try optionalString(table, "display_name", prefix, ""),
            kind: kind,
            command: command,
            args: try optionalStringArray(table, "args", prefix, []),
            env: env,
            presentation: presentation
        )
    }

    /// What the file literally says, before any of it means anything.
    ///
    /// Kept apart from `interpret` because the one-time migration has to fold
    /// the old per-machine file in at exactly this point: after the TOML is
    /// understood, before the defaults are filled in.
    public static func parseText(_ input: String) throws -> TomlTable {
        do {
            return try TomlDocument.parseValue(input)
        } catch let error as TomlSyntaxError {
            let location = error.line.flatMap { line in error.column.map { SourceLocation(line: line, column: $0) } }
            throw ConfigError(code: .parse, location: location)
        }
    }

    /// Decode one config document. Anything the shape does not allow throws.
    public static func parse(_ input: String) throws -> Config {
        try interpret(parseText(input))
    }

    /// The same, from a table that has already been read (and possibly merged).
    public static func interpret(_ document: TomlTable) throws -> Config {
        try interpret(TomlValue.table(document))
    }

    public static func interpret(_ document: TomlValue) throws -> Config {
        let table = try requireTable(document, "")
        try checkKeys(table, topLevelKeys, "")

        let defaults = Config.defaults
        // What the file says it is, which is not what it comes back as: a shape
        // this build still reads is read and then written forward, so the
        // migrations below happen once instead of on every load.
        let fileVersion = try optionalNumber(table, "version", "", 0)
        if fileVersion < ConfigConstants.oldestReadableVersion || fileVersion > ConfigConstants.schemaVersion {
            throw fail(.unsupportedVersion, "version")
        }

        let generalTable = try requireTable(table["general"] ?? .table(TomlTable()), "general")
        let scratchTable = try requireTable(table["scratch"] ?? .table(TomlTable()), "scratch")
        try checkKeys(scratchTable, ["daily"], "scratch")
        let projectsTable = try requireTable(table["projects"] ?? .table(TomlTable()), "projects")
        try checkKeys(projectsTable, ["directory"], "projects")
        var projectDirectory: String?
        if let raw = projectsTable["directory"] {
            guard case .string(let directory) = raw else { throw fail(.invalidType, "projects.directory") }
            projectDirectory = directory
        }
        try checkKeys(generalTable, [
            "import_login_environment", "notify_on_idle", "notify_sound", "notice_seconds",
            "terminal_idle_seconds", "workbench_hibernate_minutes", "workbench_awake_max", "workbench",
        ], "general")
        let agentsTable = try requireTable(table["agents"] ?? .table(TomlTable()), "agents")
        try checkKeys(agentsTable, [
            "default_presentation", "resume_after_limit", "resume_after_limit_message",
            "auto_compact_before_cache_expiry", "auto_compact_lead_seconds", "auto_compact_min_tokens",
        ], "agents")

        let runtimesTable = try requireTable(table["runtimes"] ?? .table(TomlTable()), "runtimes")
        try checkKeys(runtimesTable, ["shell", "git", "tmux", "tmux_socket_name", "tmux_args"], "runtimes")

        let appearanceTable = try requireTable(table["appearance"] ?? .table(TomlTable()), "appearance")
        try checkKeys(appearanceTable, [
            "mode", "theme_dark", "theme_light", "title_bar", "terminal_font_family", "terminal_font_size",
            "terminal_line_height", "terminal_scroll_sensitivity", "sidebar_density", "terminal_margin", "terminal_theme",
        ], "appearance")

        let keybindingsTable = try requireTable(table["keybindings"] ?? .table(TomlTable()), "keybindings")
        try checkKeys(keybindingsTable, ["prefix", "chords"], "keybindings")
        let chordsTable = try requireTable(keybindingsTable["chords"] ?? .table(TomlTable()), "keybindings.chords")
        var chords = OrderedStringMap()
        for (key, value) in chordsTable.entries {
            guard case .string(let command) = value else { throw fail(.invalidType, "keybindings.chords.\(key)") }
            chords[key] = command
        }

        let rawSources = table["workspace_sources"]
        if let rawSources, rawSources.arrayValue == nil { throw fail(.invalidType, "workspace_sources") }
        let rawProfiles = table["agent_profiles"]
        if let rawProfiles, rawProfiles.arrayValue == nil { throw fail(.invalidType, "agent_profiles") }

        // Evaluated in the TypeScript object literal's order, so the first
        // refusal is the same one.
        let general = GeneralConfig(
            importLoginEnvironment: try optionalBoolean(generalTable, "import_login_environment", "general", true),
            notifyOnIdle: try optionalBoolean(generalTable, "notify_on_idle", "general", true),
            notifySound: try optionalBoolean(generalTable, "notify_sound", "general", true),
            noticeSeconds: try generalDuration(generalTable, "notice_seconds", ConfigConstants.defaultNoticeSeconds),
            terminalIdleSeconds: try generalDuration(generalTable, "terminal_idle_seconds", ConfigConstants.defaultTerminalIdleSeconds),
            workbenchHibernateMinutes: try generalDuration(generalTable, "workbench_hibernate_minutes", ConfigConstants.defaultWorkbenchHibernateMinutes),
            workbenchAwakeMax: try generalDuration(generalTable, "workbench_awake_max", ConfigConstants.defaultWorkbenchAwakeMax),
            workbench: try optionalString(generalTable, "workbench", "general", ConfigConstants.defaultWorkbenchMode)
        )
        let runtimes = RuntimeConfig(
            shell: try optionalString(runtimesTable, "shell", "runtimes", ConfigConstants.defaultShell),
            git: try optionalString(runtimesTable, "git", "runtimes", ConfigConstants.defaultGit),
            tmux: try optionalString(runtimesTable, "tmux", "runtimes", ConfigConstants.defaultTmux),
            tmuxSocketName: try optionalString(runtimesTable, "tmux_socket_name", "runtimes", ConfigConstants.defaultTmuxSocket),
            tmuxArgs: try optionalStringArray(runtimesTable, "tmux_args", "runtimes", [])
        )
        let terminalFontFamily = try optionalString(appearanceTable, "terminal_font_family", "appearance", ConfigConstants.defaultFontFamily)
        let terminalFontSize = try optionalNumber(appearanceTable, "terminal_font_size", "appearance", 13)
        let terminalLineHeight = try optionalNumber(appearanceTable, "terminal_line_height", "appearance", 1)
        let terminalScrollSensitivity = try optionalNumber(appearanceTable, "terminal_scroll_sensitivity", "appearance", 3)
        let mode = try optionalString(appearanceTable, "mode", "appearance", "auto")
        let themeDark = JSString.trim(try optionalString(appearanceTable, "theme_dark", "appearance", ConfigConstants.defaultThemeDark))
        let themeLight = JSString.trim(try optionalString(appearanceTable, "theme_light", "appearance", ConfigConstants.defaultThemeLight))
        let titleBar = try optionalString(appearanceTable, "title_bar", "appearance", ConfigConstants.defaultTitleBar)
        let sidebarDensity = try optionalString(appearanceTable, "sidebar_density", "appearance", "compact")
        let terminalMargin = try optionalNumber(appearanceTable, "terminal_margin", "appearance", 4)
        let terminalThemeValue = withoutTheOldTerminalThemeDefault(try terminalTheme(appearanceTable["terminal_theme"]), fileVersion: fileVersion)
        let appearance = AppearanceConfig(
            titleBar: titleBar, mode: mode, themeDark: themeDark, themeLight: themeLight,
            terminalFontFamily: terminalFontFamily, terminalFontSize: terminalFontSize,
            terminalLineHeight: terminalLineHeight, terminalScrollSensitivity: terminalScrollSensitivity,
            sidebarDensity: sidebarDensity, terminalMargin: terminalMargin, terminalTheme: terminalThemeValue
        )
        let keybindings = KeybindingsSpec(
            prefix: try optionalString(keybindingsTable, "prefix", "keybindings", defaults.keybindings.prefix),
            chords: chords
        )
        let scratch = ScratchConfig(daily: try optionalString(scratchTable, "daily", "scratch", defaults.scratch.daily))
        let defaultPresentationName = try optionalString(agentsTable, "default_presentation", "agents", defaults.agents.defaultPresentation.rawValue)
        let resumeAfterLimit = try optionalBoolean(agentsTable, "resume_after_limit", "agents", defaults.agents.resumeAfterLimit)
        let resumeMessage = try optionalString(agentsTable, "resume_after_limit_message", "agents", defaults.agents.resumeAfterLimitMessage)
        let autoCompact = try optionalBoolean(agentsTable, "auto_compact_before_cache_expiry", "agents", defaults.agents.autoCompactBeforeCacheExpiry)
        let leadSeconds = try positiveNumber(agentsTable, "auto_compact_lead_seconds", defaults.agents.autoCompactLeadSeconds, zeroAllowed: false)
        let minTokens = try positiveNumber(agentsTable, "auto_compact_min_tokens", defaults.agents.autoCompactMinTokens, zeroAllowed: true)
        let workspaceSources = try rawSources?.arrayValue.map { try $0.enumerated().map { try workspaceSource($1, $0) } } ?? defaults.workspaceSources
        let agentProfiles = try rawProfiles?.arrayValue.map {
            withoutTheOldPresentationDefault(try $0.enumerated().map { try agentProfile($1, $0) }, fileVersion: fileVersion)
        } ?? defaults.agentProfiles
        // The file's word over the actions DevHub ships, rather than in place of them.
        let actions = withoutTheOldConfirmDefault(try agentActions(table["agent_actions"], defaults: defaults.agentActions), fileVersion: fileVersion)

        // `default_presentation` is checked by `validate` in the TypeScript app;
        // an unknown word here is that same refusal, at that same point.
        guard let defaultPresentation = AgentPresentation(rawValue: defaultPresentationName) else {
            var probe = defaults
            probe.general = general
            probe.runtimes = runtimes
            probe.appearance = appearance
            probe.keybindings = keybindings
            probe.workspaceSources = workspaceSources
            probe.scratch = scratch
            probe.projects = ProjectsConfig(directory: projectDirectory)
            try validateUpToAgents(probe)
            throw fail(.invalidProfile, "agents.default_presentation")
        }

        let config = Config(
            version: ConfigConstants.schemaVersion,
            general: general,
            runtimes: runtimes,
            appearance: appearance,
            keybindings: keybindings,
            workspaceSources: workspaceSources,
            scratch: scratch,
            projects: ProjectsConfig(directory: projectDirectory),
            agents: AgentsConfig(
                defaultPresentation: defaultPresentation,
                resumeAfterLimit: resumeAfterLimit,
                resumeAfterLimitMessage: resumeMessage,
                autoCompactBeforeCacheExpiry: autoCompact,
                autoCompactLeadSeconds: leadSeconds,
                autoCompactMinTokens: minTokens
            ),
            agentProfiles: agentProfiles,
            agentActions: actions
        )
        try validate(config)
        return config
    }

    /// `validateConfig` up to the `[agents] default_presentation` check.
    static func validateUpToAgents(_ config: Config) throws {
        if !ConfigConstants.workbenchModes.contains(config.general.workbench) {
            throw fail(.invalidWorkbench, "general.workbench")
        }
        try validateRuntimes(config.runtimes)
        try validateAppearance(config.appearance)
        try validateKeybindings(config.keybindings)
        try validateWorkspaceSources(config.workspaceSources)
        if ScratchDaily.problem(config.scratch.daily) != nil { throw fail(.invalidScratchDaily, "scratch.daily") }
        if let directory = config.projects.directory, !isHomeOrAbsolutePath(directory) {
            throw fail(.invalidProjectDirectory, "projects.directory")
        }
    }

    // MARK: writing

    /// One workspace source, as the file spells it.
    static func sourceToTable(_ source: WorkspaceSource) -> TomlValue {
        switch source {
        case .date(let source):
            return ["type": "date", "id": .string(source.id), "path": .string(source.path), "create_if_missing": .bool(source.createIfMissing)]
        case .command(let source):
            return ["type": "command", "id": .string(source.id), "command": .array(source.command.map { .string($0) }), "timeout_ms": .number(source.timeoutMs)]
        case .filesystem(let source):
            var table: TomlTable = ["type": "filesystem", "id": .string(source.id), "path": .string(source.path), "min_depth": .number(source.minDepth)]
            if let maxDepth = source.maxDepth { table["max_depth"] = .number(maxDepth) }
            table["kinds"] = .array(source.kinds.map { .string($0.rawValue) })
            table["include_hidden"] = .bool(source.includeHidden)
            table["exclude_names"] = .array(source.excludeNames.map { .string($0) })
            return .table(table)
        }
    }

    static func paletteToTable(_ palette: TerminalPalette) -> TomlTable {
        [
            "background": .string(palette.background),
            "foreground": .string(palette.foreground),
            "cursor": .string(palette.cursor),
            "cursor_text": .string(palette.cursorText),
            "selection_background": .string(palette.selectionBackground),
            "selection_foreground": .string(palette.selectionForeground ?? palette.foreground),
            "ansi": .array(palette.ansi.map { .string($0) }),
        ]
    }

    /// The on-disk shape of a config: what the file is expected to say.
    public static func document(_ config: Config) -> TomlTable {
        var document = TomlTable()
        document["version"] = .number(config.version)
        document["general"] = [
            "import_login_environment": .bool(config.general.importLoginEnvironment),
            "notify_on_idle": .bool(config.general.notifyOnIdle),
            "notify_sound": .bool(config.general.notifySound),
            "notice_seconds": .number(config.general.noticeSeconds),
            "terminal_idle_seconds": .number(config.general.terminalIdleSeconds),
            "workbench_hibernate_minutes": .number(config.general.workbenchHibernateMinutes),
            "workbench_awake_max": .number(config.general.workbenchAwakeMax),
            "workbench": .string(config.general.workbench),
        ]
        document["runtimes"] = [
            "shell": .string(config.runtimes.shell),
            "git": .string(config.runtimes.git),
            "tmux": .string(config.runtimes.tmux),
            "tmux_socket_name": .string(config.runtimes.tmuxSocketName),
            "tmux_args": .array(config.runtimes.tmuxArgs.map { .string($0) }),
        ]
        let terminalTheme: TomlValue
        switch config.appearance.terminalTheme {
        case .vscode: terminalTheme = .string(TerminalThemeConfig.vscodeWord)
        case .palettes(let palettes): terminalTheme = ["light": .table(paletteToTable(palettes.light)), "dark": .table(paletteToTable(palettes.dark))]
        }
        document["appearance"] = [
            "mode": .string(config.appearance.mode),
            "theme_dark": .string(config.appearance.themeDark),
            "theme_light": .string(config.appearance.themeLight),
            "title_bar": .string(config.appearance.titleBar),
            "terminal_font_family": .string(config.appearance.terminalFontFamily),
            "terminal_font_size": .number(config.appearance.terminalFontSize),
            "terminal_line_height": .number(config.appearance.terminalLineHeight),
            "terminal_scroll_sensitivity": .number(config.appearance.terminalScrollSensitivity),
            "sidebar_density": .string(config.appearance.sidebarDensity),
            "terminal_margin": .number(config.appearance.terminalMargin),
            "terminal_theme": terminalTheme,
        ]
        var chords = TomlTable()
        for (key, value) in config.keybindings.chords { chords[key] = .string(value) }
        // Written even when empty, so the table a person edits by hand is a
        // table the file already has a heading for.
        document["keybindings"] = ["prefix": .string(config.keybindings.prefix), "chords": .table(chords)]
        document["workspace_sources"] = .array(config.workspaceSources.map(sourceToTable))
        document["scratch"] = ["daily": .string(config.scratch.daily)]
        // Absent rather than empty when unset: an absent key is the person's
        // "derive it from the sources", and an empty string is a refused value.
        if let directory = config.projects.directory {
            document["projects"] = ["directory": .string(directory)]
        }
        document["agents"] = [
            "default_presentation": .string(config.agents.defaultPresentation.rawValue),
            "resume_after_limit": .bool(config.agents.resumeAfterLimit),
            "resume_after_limit_message": .string(config.agents.resumeAfterLimitMessage),
            "auto_compact_before_cache_expiry": .bool(config.agents.autoCompactBeforeCacheExpiry),
            "auto_compact_lead_seconds": .number(config.agents.autoCompactLeadSeconds),
            "auto_compact_min_tokens": .number(config.agents.autoCompactMinTokens),
        ]
        document["agent_actions"] = .table(agentActionsToTable(config.agentActions))
        document["agent_profiles"] = .array(config.agentProfiles.map { profile in
            var env = TomlTable()
            for (key, value) in profile.env { env[key] = .string(value) }
            var table: TomlTable = [
                "id": .string(profile.id),
                "display_name": .string(profile.displayName),
                "kind": .string(profile.kind.rawValue),
                "command": .string(profile.command),
                "args": .array(profile.args.map { .string($0) }),
                "env": .table(env),
            ]
            // Absent rather than written out when it follows the default, so
            // the default stays one line a person can change.
            if let presentation = profile.presentation { table["presentation"] = .string(presentation.rawValue) }
            return .table(table)
        })
        return document
    }

    /// A whole document, for when there is no file to preserve.
    public static func toToml(_ config: Config) throws -> String {
        try validate(config)
        return try TomlDocument.render(document(config))
    }

    /// The same config, written over the document that is already on disk.
    /// Only the values that differ are replaced.
    public static func ontoDocument(_ source: String, _ config: Config) throws -> String {
        try validate(config)
        return try TomlDocument.update(source, desired: document(config))
    }

    // MARK: read before the settings are loaded

    /// `general.workbench` as read from the settings file, before it is loaded.
    /// A file that will not parse answers with the default; the real load runs
    /// moments later on the same text and is what reports the problem.
    public static func workbenchMode(in text: String?) -> WorkbenchMode {
        guard let text, let table = try? parseText(text), let general = plainObject(table["general"]) else {
            return .vscode
        }
        if case .string(let value)? = general["workbench"], let mode = WorkbenchMode(rawValue: value) { return mode }
        return .vscode
    }

    /// `appearance.title_bar`, before the settings can be loaded: the window is
    /// created before the config is.
    public static func titleBarMode(in text: String?) -> TitleBarMode {
        guard let text, let table = try? parseText(text), let appearance = plainObject(table["appearance"]) else {
            return .shown
        }
        if case .string(let value)? = appearance["title_bar"], let mode = TitleBarMode(rawValue: value) { return mode }
        return .shown
    }

    /// The two theme names, read before the settings are loaded: the window is
    /// created in the theme's colours.
    public static func colorThemes(in text: String?) -> (dark: String, light: String) {
        let defaults = (dark: ConfigConstants.defaultThemeDark, light: ConfigConstants.defaultThemeLight)
        guard let text, let table = try? parseText(text), let appearance = plainObject(table["appearance"]) else {
            return defaults
        }
        func named(_ key: String, _ fallback: String) -> String {
            if case .string(let value)? = appearance[key], !JSString.trim(value).isEmpty { return JSString.trim(value) }
            return fallback
        }
        return (named("theme_dark", defaults.dark), named("theme_light", defaults.light))
    }

    /// `appearance.mode`, before the settings are loaded. Forgiving, like
    /// `titleBarMode(in:)`.
    public static func appearanceMode(in text: String?) -> String {
        guard let text, let table = try? parseText(text), let appearance = plainObject(table["appearance"]) else {
            return "auto"
        }
        if case .string(let value)? = appearance["mode"], ConfigConstants.appearanceModes.contains(value) { return value }
        return "auto"
    }
}

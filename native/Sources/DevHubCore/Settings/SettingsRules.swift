// Port of apps/desktop/src/settings/rules.ts and apps/desktop/src/settings/errorMessage.ts.
//
// What a value in `settings.toml` has to be, said in the window's own words.
// The authority is `ConfigParsing.validate`: it validates the whole file
// before any of it is adopted, and a value that gets past this module still
// has to get past that one. This module exists because a refusal that arrives
// after a save, phrased as a diagnostic code, is not something a person can
// act on while they are still typing. `SettingsRulesTests` runs every rule
// here against the real validator so the two cannot disagree.
//
// The sentences are also what a refused save says (`ruleMessage`), so the
// field and the notice cannot describe the same rule two different ways.

import Foundation

public enum SettingsRules {
    public static let idRule =
        "An identifier starts with a lowercase letter, then uses lowercase letters, digits, dashes and underscores — at most 64 characters."
    public static let duplicateRule = "Two entries have the same identifier. Each one has to be unique."
    public static let runtimeRule =
        "A runtime is either a bare command name looked up on your PATH, or an absolute path (or one starting with ~/). It cannot be empty."
    public static let socketRule =
        "A tmux socket name uses letters, digits, dots, dashes and underscores, is at most 64 characters, and cannot be empty."
    public static let tmuxArgumentRule = "Only the tmux options -u and -2 are allowed; the rest could point DevHub at another server."
    public static let workspacePathRule = "A folder is an absolute path, or one starting with ~/ (or ~ on its own)."
    public static let scratchDailyRule =
        "scratch.daily is an absolute or ~/ path naming one folder per day with the date tokens (YYYY, MM, DD, …; [text] for literal text), e.g. ~/junk/YYYYMMDD."
    public static let resumeMessageRule =
        "The message sent after a usage limit resets has some text in it, and no null character."
    public static let projectDirectoryRule =
        "projects.directory is an absolute path, or one starting with ~/ (or ~ on its own), used as written."
    public static let dateTemplateRule =
        "A date path has a closing bracket for every opening one; text inside brackets is used as written."
    public static let dateTokenRule =
        "A folder name that is not a date goes in brackets: `summaries` has `mm` in it and would expand, `[summaries]` is used as written."
    public static let excludeNameRule = "A name to skip is a plain folder name: no slashes and no wildcards."
    public static let displayNameRule = "A name cannot be empty."
    public static let environmentNameRule =
        "A variable name starts with a letter or underscore, then uses letters, digits and underscores."
    public static let textRule = "That value cannot contain a null character."
    public static let chordKeyRule =
        "Modifiers and the character the key produces: `N`, `{`, `Cmd+j`. `Shift+n` is accepted and stored as `N`."

    static func hasNull(_ value: String) -> Bool { value.contains("\u{0}") }

    public static func idProblem(_ value: String) -> String? {
        let scalars = Array(value.unicodeScalars)
        guard let first = scalars.first, ("a"..."z").contains(first), scalars.count <= 64 else { return idRule }
        let allowed = scalars.dropFirst().allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "_" || $0 == "-" }
        return allowed ? nil : idRule
    }

    public static func runtimeProblem(_ value: String) -> String? {
        if hasNull(value) { return textRule }
        let valid = value.hasPrefix("/") || value == "~" || value.hasPrefix("~/") || (!value.isEmpty && !value.contains("/"))
        return valid ? nil : runtimeRule
    }

    public static func socketProblem(_ value: String) -> String? {
        let scalars = value.unicodeScalars
        let valid = !value.isEmpty && scalars.count <= 64 && scalars.allSatisfy { scalar in
            ("A"..."Z").contains(scalar) || ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar)
                || scalar == "_" || scalar == "." || scalar == "-"
        }
        return valid ? nil : socketRule
    }

    /// An empty field is the unset key (derive the folder from the sources).
    public static func projectDirectoryProblem(_ value: String) -> String? {
        if hasNull(value) { return textRule }
        let valid = value.isEmpty || value.hasPrefix("/") || value == "~" || value.hasPrefix("~/")
        return valid ? nil : projectDirectoryRule
    }

    public static func workspacePathProblem(_ value: String) -> String? {
        if hasNull(value) { return textRule }
        let valid = !value.isEmpty && value != "~user" && (value.hasPrefix("/") || value == "~" || value.hasPrefix("~/"))
        return valid ? nil : workspacePathRule
    }

    /// A dated path: a workspace path, plus balanced brackets, plus no word with
    /// a token hiding in it — three mistakes, three sentences.
    public static func dateTemplateProblem(_ value: String) -> String? {
        if let path = workspacePathProblem(value) { return path }
        if !DateTemplate.bracketsBalance(value) { return dateTemplateRule }
        return DateTemplate.ambiguity(value) == nil ? nil : dateTokenRule
    }

    public static func excludeNameProblem(_ value: String) -> String? {
        let wildcards: Set<Character> = ["*", "?", "[", "]", "{", "}"]
        let valid = !value.isEmpty && !hasNull(value) && !value.contains("/") && !value.contains("\\")
            && !value.contains(where: { wildcards.contains($0) })
        return valid ? nil : excludeNameRule
    }

    public static func displayNameProblem(_ value: String) -> String? {
        if hasNull(value) { return textRule }
        return value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? displayNameRule : nil
    }

    public static func environmentNameProblem(_ value: String) -> String? {
        let scalars = Array(value.unicodeScalars)
        func letter(_ s: Unicode.Scalar) -> Bool { ("A"..."Z").contains(s) || ("a"..."z").contains(s) || s == "_" }
        guard let first = scalars.first, letter(first),
              scalars.dropFirst().allSatisfy({ letter($0) || ("0"..."9").contains($0) })
        else { return environmentNameRule }
        return nil
    }

    /// Command arguments and agent arguments: anything but a null byte.
    public static func argumentProblem(_ value: String) -> String? { hasNull(value) ? textRule : nil }

    public static func scratchDailyProblem(_ value: String) -> String? {
        ScratchDaily.problem(value) == nil ? nil : scratchDailyRule
    }

    /// `resumeMessageProblem`: some text in it, and no null character.
    public static func resumeMessageProblem(_ value: String) -> String? {
        value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || hasNull(value) ? resumeMessageRule : nil
    }

    public static func fontFamilyProblem(_ value: String) -> String? {
        FontFamily.isValid(value) ? nil : FontFamily.rule
    }

    public static func themeNameProblem(_ value: String) -> String? {
        value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Name a colour theme." : nil
    }

    public static func chordKeyProblem(_ value: String) -> String? {
        (try? ChordKeys.parse(value)) == nil ? chordKeyRule : nil
    }

    /// `NumberField`'s rule.
    public static func numberProblem(_ value: String, label: String, min: Double, max: Double) -> String? {
        let range = "\(label) is a number between \(format(min)) and \(format(max))."
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, let parsed = Double(trimmed), parsed.isFinite else { return range }
        return parsed < min || parsed > max ? range : nil
    }

    /// A number as JavaScript's `String(n)` writes it.
    public static func format(_ value: Double) -> String {
        if value == value.rounded(), abs(value) < 1e21 { return String(Int64(value)) }
        return String(value)
    }

    /// The maximum depth field: empty (the same as the minimum), or a whole
    /// number between the minimum and 16.
    public static func maxDepthProblem(_ value: String, minDepth: Double) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return nil }
        if let parsed = Double(trimmed), parsed == parsed.rounded(), parsed >= minDepth, parsed <= 16 { return nil }
        return "A maximum depth is empty — the same as the minimum — or a whole number between \(format(minDepth)) and 16."
    }

    // MARK: - What a filesystem source looks for

    /// The four sets of kinds that are actually legal: a popup over them cannot
    /// express the combination the loader refuses.
    public enum MatchChoice: String, CaseIterable, Sendable {
        case directory
        case gitRepository = "git_repository"
        case gitWorktree = "git_worktree"
        case gitBoth = "git_both"

        public var label: String {
            switch self {
            case .directory: return "Any folder"
            case .gitRepository: return "Git repositories"
            case .gitWorktree: return "Git worktrees"
            case .gitBoth: return "Git repositories and worktrees"
            }
        }

        public var kinds: [WorkspaceKind] {
            switch self {
            case .directory: return [.directory]
            case .gitRepository: return [.gitRepository]
            case .gitWorktree: return [.gitWorktree]
            case .gitBoth: return [.gitRepository, .gitWorktree]
            }
        }

        public static func of(_ kinds: [WorkspaceKind]) -> MatchChoice {
            let git = kinds.filter { $0 != .directory }
            if git.count == 2 { return .gitBoth }
            if git.count == 1 { return git[0] == .gitRepository ? .gitRepository : .gitWorktree }
            return .directory
        }
    }

    // MARK: - What a refused save says (errorMessage.ts)

    public static let fileName = ConfigConstants.configFileName

    /// The rule the value broke, in the words the field itself uses. A switch
    /// with no default: a code added without a sentence does not compile.
    public static func ruleMessage(_ code: ValidationCode) -> String {
        let file = fileName
        switch code {
        case .invalidFontFamily: return FontFamily.rule
        case .invalidRuntime: return runtimeRule
        case .invalidSocketName: return socketRule
        case .forbiddenTmuxArgument: return tmuxArgumentRule
        case .invalidId: return idRule
        case .duplicateIdentity: return duplicateRule
        case .invalidWorkspacePath: return workspacePathRule
        case .invalidDateTemplate: return dateTemplateRule
        case .invalidScratchDaily: return scratchDailyRule
        case .invalidProjectDirectory: return projectDirectoryRule
        case .invalidResumeMessage: return resumeMessageRule
        case .ambiguousDateToken: return dateTokenRule
        case .invalidExclusion: return excludeNameRule
        case .invalidEnvironmentKey: return environmentNameRule
        case .invalidCommand: return "A command source needs at least one argument: the program to run."
        case .invalidTimeout: return "A timeout is between 100 and 30000 milliseconds."
        case .invalidWorkspaceDepth: return "A maximum depth is at least the minimum and at most 16."
        case .invalidWorkspaceKind:
            return "A source looks for folders or for Git checkouts, not both, and it has to look for something."
        case .invalidProfile: return "An agent profile needs a name, and its arguments cannot contain a null character."
        case .invalidProfileKind:
            return "An agent profile runs Codex, Claude, Cursor, or something else DevHub reads no status from."
        case .invalidAppearance:
            return "A font size is 9 to 24, a line height 1 to 2, an inset 0 to 64, and a sidebar density Compact or Comfortable."
        case .invalidWorkbench:
            return "The editor area is `vscode` (a VS Code workbench) or `terminal` (the Workspace's tmux session)."
        case .invalidString: return "That value cannot contain a null character."
        case .invalidKeybinding:
            return "A chord is modifiers and the character the key produces, like `{` or `Cmd+j`. `Shift+[` is accepted and stored as `{`."
        case .unknownCommand: return "That is not a command DevHub has. The keyboard section lists every one of them."
        case .parse: return "\(file) is not valid TOML at that point."
        case .invalidUtf8: return "\(file) is not valid UTF-8."
        case .unknownKey:
            return "DevHub does not know that key. Check it for a typo — an unknown key is refused rather than ignored, so a misspelling never silently does nothing."
        case .missingRequiredField: return "That key has to be there."
        case .invalidType: return "That key holds a value of the wrong kind."
        case .unsupportedVersion: return "\(file) states a schema version this DevHub does not read."
        case .io: return "\(file) could not be read or written."
        case .stateUnavailable: return "DevHub could not reach the file."
        case .serialization: return "DevHub could not write the file."
        case .conflict: return "\(file) changed after this window read it."
        }
    }

    /// `invalid_command, workspace_sources[0].command, line 3, column 0`.
    static func whereText(_ diagnostic: ConfigDiagnostic) -> String {
        var parts = [diagnostic.code.rawValue]
        if let path = diagnostic.path { parts.append(path) }
        if let location = diagnostic.location { parts.append("line \(location.line), column \(location.column)") }
        return parts.joined(separator: ", ")
    }

    /// A problem with the file itself, rather than with a change somebody made.
    public static func fileDiagnosticMessage(_ diagnostic: ConfigDiagnostic) -> String {
        "\(fileName) has a problem DevHub could not read, so it is running on the last version that parsed. \(ruleMessage(diagnostic.code)) (\(whereText(diagnostic)))"
    }

    /// What a refused request says (`SettingsErrorWire`).
    public enum Refusal: Equatable, Sendable {
        case invalidConfig(ConfigDiagnostic?)
        case externalEditConflict
        case invalidFile
        case runtimeUnavailable
        case nativeUnavailable
        case permissionDenied
        case nativeBusy
        case nativeTimedOut

        /// `settingsError`: a failure, as the window reads it.
        public static func of(_ error: Error) -> Refusal {
            if let config = error as? ConfigError {
                if config.code == .conflict { return .externalEditConflict }
                if config.code == .io { return .invalidFile }
                return .invalidConfig(config.diagnostic)
            }
            return .nativeUnavailable
        }

        /// `settingsErrorIdentity`: what makes two refusals the same refusal.
        public var identity: String {
            switch self {
            case let .invalidConfig(diagnostic):
                return [
                    "invalid_config", diagnostic?.code.rawValue ?? "", diagnostic?.path ?? "",
                    diagnostic?.location.map { String($0.line) } ?? "", diagnostic?.location.map { String($0.column) } ?? "",
                ].joined(separator: "\u{0}")
            case .externalEditConflict: return "external_edit_conflict"
            case .invalidFile: return "invalid_file"
            case .runtimeUnavailable: return "runtime_unavailable"
            case .nativeUnavailable: return "native_unavailable"
            case .permissionDenied: return "permission_denied"
            case .nativeBusy: return "native_busy"
            case .nativeTimedOut: return "native_timed_out"
            }
        }

        public var message: String {
            switch self {
            case .externalEditConflict: return "\(SettingsRules.fileName) changed outside Settings. Reload to see the new file."
            case let .invalidConfig(diagnostic):
                guard let diagnostic else {
                    return "That change was not saved, and DevHub did not say which value it refused. Please report this."
                }
                let field = diagnostic.path.map { "\($0) was not saved." } ?? "That change was not saved."
                return "\(field) \(ruleMessage(diagnostic.code)) (\(whereText(diagnostic)))"
            case .invalidFile: return "\(SettingsRules.fileName) could not be read or written."
            case .runtimeUnavailable: return "DevHub could not inspect the runtimes."
            case .permissionDenied: return "DevHub does not have permission to do that."
            case .nativeUnavailable: return "The Settings window lost its connection to DevHub."
            case .nativeBusy: return "Another action is still finishing. Try again in a moment."
            case .nativeTimedOut: return "That action timed out. It may still be finishing."
            }
        }
    }

    /// `runtimeUnavailableMessage`, as the Programs group shows a resolution.
    public static func resolvedText(_ resolution: ProgramResolution) -> (text: String, missing: Bool) {
        if let message = resolution.unavailableMessage { return (message, true) }
        return (resolution.path ?? "", false)
    }
}

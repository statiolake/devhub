// Port of apps/desktop/src/model/config.ts — diagnostics, errors and the
// results a load or reload answers with.

import Foundation

/// Why a settings file was refused. The raw values are the TypeScript app's
/// codes, which are wire (the notice text names them, the Settings window maps
/// them to rules).
public enum ValidationCode: String, CaseIterable, Codable, Sendable {
    case io
    case stateUnavailable = "state_unavailable"
    case invalidUtf8 = "invalid_utf8"
    case parse
    case missingRequiredField = "missing_required_field"
    case unknownKey = "unknown_key"
    case invalidType = "invalid_type"
    case unsupportedVersion = "unsupported_version"
    case invalidString = "invalid_string"
    case invalidId = "invalid_id"
    case duplicateIdentity = "duplicate_identity"
    case invalidRuntime = "invalid_runtime"
    case invalidSocketName = "invalid_socket_name"
    case forbiddenTmuxArgument = "forbidden_tmux_argument"
    case invalidAppearance = "invalid_appearance"
    case invalidWorkbench = "invalid_workbench"
    case invalidKeybinding = "invalid_keybinding"
    case unknownCommand = "unknown_command"
    case invalidFontFamily = "invalid_font_family"
    case invalidWorkspacePath = "invalid_workspace_path"
    case invalidWorkspaceDepth = "invalid_workspace_depth"
    case invalidWorkspaceKind = "invalid_workspace_kind"
    case invalidDateTemplate = "invalid_date_template"
    case invalidScratchDaily = "invalid_scratch_daily"
    case invalidProjectDirectory = "invalid_project_directory"
    case invalidResumeMessage = "invalid_resume_message"
    case ambiguousDateToken = "ambiguous_date_token"
    case invalidExclusion = "invalid_exclusion"
    case invalidCommand = "invalid_command"
    case invalidTimeout = "invalid_timeout"
    case invalidProfile = "invalid_profile"
    case invalidProfileKind = "invalid_profile_kind"
    case invalidEnvironmentKey = "invalid_environment_key"
    case conflict
    case serialization
}

/// Where in the file a diagnostic points. `line` counts from 1 and `column`
/// from 0, as the TypeScript app's TOML parser reports them, so a notice says
/// the same "(line 3, column 0)" from either app.
public struct SourceLocation: Equatable, Hashable, Codable, Sendable {
    public var line: Int
    public var column: Int

    public init(line: Int, column: Int) {
        self.line = line
        self.column = column
    }
}

public struct ConfigDiagnostic: Equatable, Hashable, Codable, Sendable {
    public var code: ValidationCode
    public var path: String?
    public var location: SourceLocation?

    public init(code: ValidationCode, path: String? = nil, location: SourceLocation? = nil) {
        self.code = code
        self.path = path
        self.location = location
    }
}

/// The identity of a file's exact bytes: the SHA-256 hex of its UTF-8. A save
/// carries the revision it was started from, so an edit made in another window
/// (or in an editor) is a refusal rather than a silent overwrite.
public typealias ContentRevision = String

public func contentRevision(_ text: String) -> ContentRevision { SHA256.hex(text) }

public func contentRevision(_ bytes: [UInt8]) -> ContentRevision {
    SHA256.digest(bytes).map { byte in
        let s = String(byte, radix: 16)
        return s.count == 1 ? "0" + s : s
    }.joined()
}

public struct ConfigError: Error, Equatable, CustomStringConvertible, Sendable {
    public let diagnostic: ConfigDiagnostic
    public let expectedRevision: ContentRevision?
    public let actualRevision: ContentRevision?

    public init(_ diagnostic: ConfigDiagnostic, expectedRevision: ContentRevision? = nil, actualRevision: ContentRevision? = nil) {
        self.diagnostic = diagnostic
        self.expectedRevision = expectedRevision
        self.actualRevision = actualRevision
    }

    public init(code: ValidationCode, path: String? = nil, location: SourceLocation? = nil) {
        self.init(ConfigDiagnostic(code: code, path: path, location: location))
    }

    public var code: ValidationCode { diagnostic.code }

    /// `CONFIG_<code>` or `CONFIG_<code> at <path>`, the TypeScript message.
    public var description: String {
        if let path = diagnostic.path, !path.isEmpty {
            return "CONFIG_\(diagnostic.code.rawValue) at \(path)"
        }
        return "CONFIG_\(diagnostic.code.rawValue)"
    }
}

/// A key a past DevHub read and this one ignores, and what to use instead.
///
/// A notice, not a diagnostic: the file loaded, nothing was refused, and there
/// is nothing to retry. It exists because the person who wrote the key is owed
/// an answer to "I set that and nothing happened".
public struct RetiredKeyNotice: Equatable, Hashable, Codable, Sendable {
    public var key: String
    public var replacement: String

    public init(key: String, replacement: String) {
        self.key = key
        self.replacement = replacement
    }
}

public struct LoadedConfig: Equatable, Sendable {
    public var config: Config
    public var revision: ContentRevision
    /// Retired keys the document still names. Empty for almost every file.
    public var notices: [RetiredKeyNotice]

    public init(config: Config, revision: ContentRevision, notices: [RetiredKeyNotice] = []) {
        self.config = config
        self.revision = revision
        self.notices = notices
    }
}

public enum ReloadOutcome: Equatable, Sendable {
    case unchanged(revision: ContentRevision)
    case applied(LoadedConfig)
}

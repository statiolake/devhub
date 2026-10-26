// Port of the failure algebra of apps/desktop/src/model/wire.ts (`errorWireAt`,
// `withDetail`, `withSummary`, `NamedFailure`, `failureText`, `domainRefusal`,
// `agentRefusal`, `namedFailureAt`, `fileNotFound`, `settingsRefused`) and of
// `AppErrorCodeWire` / `APP_ERROR_SUMMARY` / `appFailureIdentity` /
// `appConditionIdentity` from apps/desktop/src/ipc/appShell.ts.
//
// A failure DevHub knows by name, in the words it is shown in. Its whole state
// is the wire it is drawn as: a code, whose sentence is its title unless the
// raiser gave it a sharper one, and the raiser's own sentence as the detail.
// What is thrown and never shown is not one: a completion something newer
// settled (`StaleCompletion`), and DevHub's own broken assumption
// (`InvariantViolation`).

import Foundation

public enum AppErrorCode: String, Sendable, Hashable, CaseIterable, Codable {
    case invalidIntent = "invalid_intent"
    case unknownContext = "unknown_context"
    case workspaceUnavailable = "workspace_unavailable"
    case workspaceClosing = "workspace_closing"
    case workspaceCloseFailed = "workspace_close_failed"
    case operationPending = "operation_pending"
    case persistenceDegraded = "persistence_degraded"
    case nativeUnavailable = "native_unavailable"
    /// `settings.toml` could not be used.
    case settingsRefused = "settings_refused"
    /// A file DevHub was asked to open is not there (or is a folder).
    case fileNotFound = "file_not_found"
    case editorProviderMissing = "editor_provider_missing"
    case editorPortUnavailable = "editor_port_unavailable"
    case editorUnavailable = "editor_unavailable"
    case editorRestarting = "editor_restarting"
    case editorRestartExhausted = "editor_restart_exhausted"
    case colorThemeUnavailable = "color_theme_unavailable"
    case agentNotConnected = "agent_not_connected"
    case agentExited = "agent_exited"
    case agentRuntimeUnavailable = "agent_runtime_unavailable"
    case agentProfileUnavailable = "agent_profile_unavailable"
    case agentAttachTimedOut = "agent_attach_timed_out"
    case conversationNotResumable = "conversation_not_resumable"
    case conversationRefused = "conversation_refused"
    case conversationStopped = "conversation_stopped"
    case sessionsUnreadable = "sessions_unreadable"
    case machineUnavailable = "machine_unavailable"
    case machineTimedOut = "machine_timed_out"
    case machineCommandFailed = "machine_command_failed"
    case operationCancelled = "operation_cancelled"
    case fileUnreadable = "file_unreadable"
    case githubUnavailable = "github_unavailable"
    case devContainerUnusable = "dev_container_unusable"
    case agentActionEmpty = "agent_action_empty"
    case operationTimedOut = "operation_timed_out"
    case gitFetchFailed = "git_fetch_failed"
    case workbenchSettingsUnreadable = "workbench_settings_unreadable"
    case terminalLauncherUnavailable = "terminal_launcher_unavailable"
    case devContainerCommandUnavailable = "dev_container_command_unavailable"
    case workspaceSessionsLeftRunning = "workspace_sessions_left_running"
    case tmuxCommandFailed = "tmux_command_failed"
    case tmuxCommandTimedOut = "tmux_command_timed_out"
    case tmuxSessionConflict = "tmux_session_conflict"
    case terminalSocketPathTooLong = "terminal_socket_path_too_long"
    case terminalSocketUnusable = "terminal_socket_unusable"
    case stateMigrated = "state_migrated"
    case devContainerNotStopped = "dev_container_not_stopped"
    case inputSourceUnavailable = "input_source_unavailable"
    case usageUnreadable = "usage_unreadable"
    case terminalNeedsAgent = "terminal_needs_agent"
    case terminalNeedsAgentView = "terminal_needs_agent_view"

    /// `APP_ERROR_SUMMARY`: the sentence each failure is shown as, verbatim.
    public var summary: String {
        switch self {
        case .invalidIntent: return "The requested action is not available."
        case .unknownContext: return "The selected context is no longer available."
        case .workspaceUnavailable: return "The workspace is unavailable."
        case .workspaceClosing: return "The workspace is already closing."
        case .workspaceCloseFailed: return "The workspace could not be closed cleanly."
        case .operationPending: return "Another operation is still in progress."
        case .operationTimedOut: return "The requested action did not finish."
        case .persistenceDegraded: return "DevHub could not save its state file."
        case .nativeUnavailable: return "The native app shell is unavailable."
        case .settingsRefused: return "DevHub could not use its settings file."
        case .fileNotFound: return "File not found."
        case .editorProviderMissing: return "Visual Studio Code was not found."
        case .editorPortUnavailable: return "The editor's port is already in use."
        case .editorUnavailable: return "The editor could not start."
        case .editorRestarting: return "The workbench stopped unexpectedly and is restarting."
        case .editorRestartExhausted: return "The workbench kept stopping and will not be restarted again."
        case .colorThemeUnavailable:
            return "The colour theme named in DevHub's settings is not available, so VS Code's default theme is worn instead."
        case .agentNotConnected: return "The agent surface is not connected."
        case .agentExited: return "The agent has exited."
        case .agentRuntimeUnavailable: return "The agent runtime is unavailable."
        case .agentProfileUnavailable: return "The agent could not start from this profile."
        case .agentAttachTimedOut: return "The agent surface did not connect in time."
        case .conversationNotResumable: return "DevHub cannot go on with this session."
        case .conversationRefused: return "The Agent's conversation cannot do that."
        case .conversationStopped: return "The Agent's conversation has stopped."
        case .sessionsUnreadable: return "DevHub could not read the Agent's sessions."
        case .machineUnavailable: return "The machine is unavailable."
        case .machineTimedOut: return "The machine did not answer in time."
        case .machineCommandFailed: return "The machine could not do what DevHub asked."
        case .operationCancelled: return "The request was cancelled."
        case .fileUnreadable: return "DevHub could not read a file or folder it needs."
        case .githubUnavailable: return "DevHub could not get this from GitHub."
        case .devContainerUnusable: return "DevHub could not use this dev container."
        case .agentActionEmpty: return "This agent action has nothing to send."
        case .gitFetchFailed: return "The latest changes could not be fetched from the remote."
        case .workbenchSettingsUnreadable: return "The editor's settings file is not valid JSON."
        case .terminalLauncherUnavailable: return "This window has no DevHub terminal: its launcher could not be installed."
        case .devContainerCommandUnavailable: return "The devhub command does not work inside this dev container."
        case .workspaceSessionsLeftRunning:
            return "The workspace was closed, but its sessions are still running on a machine DevHub could not reach."
        case .tmuxCommandFailed: return "The terminal runtime refused the request."
        case .tmuxCommandTimedOut: return "The terminal runtime did not answer in time."
        case .tmuxSessionConflict: return "The terminal session DevHub needs is not the one that is there."
        case .terminalSocketPathTooLong: return "The terminal socket path is too long."
        case .terminalSocketUnusable: return "DevHub cannot use the terminal socket."
        case .stateMigrated: return "DevHub updated its saved Workspaces for this version."
        case .devContainerNotStopped: return "A dev container DevHub started is still running: it could not be stopped."
        case .inputSourceUnavailable:
            return "Chords cannot switch the keyboard out of an input method: DevHub could not change the input source."
        case .usageUnreadable: return "DevHub could not read a CLI's usage limits. It tries again at the next reading."
        case .terminalNeedsAgent:
            return "There is no Agent here to open a terminal for: a terminal belongs to an Agent. Start one with Cmd+Q C, then Cmd+Q V."
        case .terminalNeedsAgentView:
            return "The terminal is shown with its Agent. Switch to the Agent (Cmd+Q Cmd+J) or split (Cmd+Q Z), then Cmd+Q V."
        }
    }

    /// `defaultErrorModule`.
    public var module: AppErrorModule {
        switch self {
        case .persistenceDegraded, .stateMigrated: return .state
        case .settingsRefused: return .config
        case .fileNotFound, .editorProviderMissing, .editorPortUnavailable, .editorUnavailable, .editorRestarting,
             .editorRestartExhausted:
            return .editor
        case .agentNotConnected, .agentExited, .agentRuntimeUnavailable, .agentAttachTimedOut, .conversationNotResumable,
             .conversationRefused, .conversationStopped, .sessionsUnreadable, .usageUnreadable:
            return .agent
        case .terminalLauncherUnavailable, .terminalNeedsAgent, .terminalNeedsAgentView, .workspaceSessionsLeftRunning,
             .tmuxCommandFailed, .tmuxCommandTimedOut, .tmuxSessionConflict, .terminalSocketPathTooLong,
             .terminalSocketUnusable:
            return .terminal
        default: return .app
        }
    }

    /// The actions `errorWireAt` offers for a code.
    public var actions: [AppErrorAction] {
        switch self {
        // Something that already happened, or that trying again cannot change.
        case .colorThemeUnavailable, .stateMigrated, .inputSourceUnavailable, .usageUnreadable, .terminalNeedsAgent,
             .terminalNeedsAgentView, .fileNotFound:
            return []
        // Trying again reads the same file; what answers it is fixing the file.
        case .settingsRefused: return [.openSettings]
        case .nativeUnavailable, .persistenceDegraded, .editorProviderMissing, .editorPortUnavailable, .editorUnavailable,
             .editorRestartExhausted:
            return [.retry, .openSettings]
        default: return [.retry]
        }
    }

    /// `appFailureIdentity`: the code and the subject, never the sentence.
    public var failureIdentity: String { "app\u{0}\(rawValue)" }
}

/// `appConditionIdentity`: a condition's identity is its source.
public func appConditionIdentity(_ source: String) -> String { "condition\u{0}\(source)" }

public enum AppErrorAction: String, Sendable, Hashable, Codable {
    case retry
    case openSettings = "open_settings"
    case openMicrophoneSettings = "open_microphone_settings"
}

public enum AppErrorModule: String, Sendable, Hashable, Codable {
    case app, config, state, editor, bridge, agent, terminal, settings, diagnostics
}

/// `AppErrorWire`: a failure as it is drawn.
public struct AppError: Hashable, Sendable {
    public var actions: [AppErrorAction]
    public var code: AppErrorCode
    public var detail: String?
    public var module: AppErrorModule
    public var runtimeVersion: String
    public var summary: String
    public var timestampMs: Double
    /// Main has already drawn this failure where its subject is.
    public var reported: Bool

    public init(
        actions: [AppErrorAction], code: AppErrorCode, detail: String? = nil, module: AppErrorModule,
        runtimeVersion: String, summary: String, timestampMs: Double, reported: Bool = false
    ) {
        self.actions = actions
        self.code = code
        self.detail = detail
        self.module = module
        self.runtimeVersion = runtimeVersion
        self.summary = summary
        self.timestampMs = timestampMs
        self.reported = reported
    }

    /// Stamped once at startup so every error carries the same build identity.
    nonisolated(unsafe) private static var runtimeVersionValue = "0.1.0"
    private static let versionLock = NSLock()

    public static var runtimeVersion: String {
        versionLock.lock()
        defer { versionLock.unlock() }
        return runtimeVersionValue
    }

    /// `setRuntimeVersion`.
    public static func setRuntimeVersion(_ version: String) {
        versionLock.lock()
        defer { versionLock.unlock() }
        runtimeVersionValue = version.isEmpty ? "0.1.0" : String(decoding: Array(version.utf16.prefix(64)), as: UTF16.self)
    }

    /// `errorWireAt`.
    public static func at(_ code: AppErrorCode, timestampMs: Double = 0) -> AppError {
        AppError(
            actions: code.actions, code: code, module: code.module, runtimeVersion: runtimeVersion, summary: code.summary,
            timestampMs: timestampMs == 0 ? Date().timeIntervalSince1970 * 1000 : timestampMs
        )
    }

    /// `withDetail`: an empty detail leaves the error as it was; a long one is
    /// cut at 4096 characters.
    public func withDetail(_ detail: String) -> AppError {
        if detail.isEmpty { return self }
        var copy = self
        let units = Array(detail.utf16)
        copy.detail = units.count <= 4096 ? detail : String(decoding: units.prefix(4096), as: UTF16.self) + "…"
        return copy
    }

    /// `withSummary`: an empty summary is the code's own sentence.
    public func withSummary(_ summary: String) -> AppError {
        var copy = self
        copy.summary = summary.isEmpty ? code.summary : summary
        return copy
    }

    /// `settingsRefused`: `settings.toml` could not be used, said as itself.
    public static func settingsRefused(file: String, diagnostic: ConfigDiagnostic, runningOnDefaults: Bool) -> AppError {
        let key = diagnostic.path ?? "the file"
        let at = diagnostic.location.map { " (line \($0.line), column \($0.column))" } ?? ""
        let instead = runningOnDefaults
            ? "DevHub is running on its defaults until the file is fixed."
            : "DevHub is still running on the last settings it accepted."
        return AppError.at(.settingsRefused).withDetail("\(file): \(key) was refused\(at): \(diagnostic.code.rawValue). \(instead)")
    }
}

/// A failure DevHub knows by name, in the words it is shown in.
public struct NamedFailure: Error, Hashable, Sendable, NamedFailureText, CustomStringConvertible {
    public var wire: AppError

    public init(_ wire: AppError) { self.wire = wire }

    public var summary: String { wire.summary }
    public var detail: String? { wire.detail }
    public var code: AppErrorCode { wire.code }
    public var description: String { failureText(self) }

    /// `namedFailureAt`: a failure named by its code, with the raiser's
    /// sentence as its detail.
    public static func at(_ code: AppErrorCode, _ detail: String? = nil) -> NamedFailure {
        let wire = AppError.at(code)
        return NamedFailure(detail.map { wire.withDetail($0) } ?? wire)
    }

    /// `domainRefusal`: the model's refusal of a request, as the person is told it.
    public static func domain(_ code: DomainErrorCode, _ detail: String? = nil) -> NamedFailure {
        at(domainRefusalCode(code), detail)
    }

    /// `agentRefusal`: the Agent port's refusal, in its own name.
    public static func agent(_ code: AgentFailureCode, _ detail: String? = nil) -> NamedFailure {
        at(agentRefusalCode(code), detail)
    }

    /// `fileNotFound`: "File not found: <path>", with why as the detail.
    public static func fileNotFound(_ path: String, detail: String) -> NamedFailure {
        NamedFailure(AppError.at(.fileNotFound).withSummary("File not found: \(path)").withDetail(detail))
    }

    /// `InvalidIntent`: a wire intent that carries no valid domain command.
    public static var invalidIntent: NamedFailure { at(.invalidIntent) }

    private static func domainRefusalCode(_ code: DomainErrorCode) -> AppErrorCode {
        switch code {
        case .unknownWorkspace, .unknownAgent: return .unknownContext
        case .workspaceUnavailable: return .workspaceUnavailable
        case .workspaceClosing: return .workspaceClosing
        case .workspaceClosingFailed: return .workspaceCloseFailed
        // The one domain refusal about a profile is a launch asking for what
        // the profile cannot be, and it reads as the launch-time one does.
        case .invalidProfile: return .agentProfileUnavailable
        default: return .invalidIntent
        }
    }

    /// `agentRefusalCode`: total, so a new `AgentFailureCode` is a compile
    /// error here. A conversation's failure is a reading a round carries onto
    /// its Agent's row, never the refusal of a port call.
    private static func agentRefusalCode(_ failure: AgentFailureCode) -> AppErrorCode {
        switch failure {
        case .tmuxCommandFailed: return .tmuxCommandFailed
        case .tmuxCommandTimedOut: return .tmuxCommandTimedOut
        case .tmuxSessionConflict: return .tmuxSessionConflict
        case .workspaceUnavailable: return .workspaceUnavailable
        case .agentProfileUnavailable: return .agentProfileUnavailable
        case .agentRuntimeUnavailable: return .agentRuntimeUnavailable
        case .conversationHostLost, .conversationProtocolMismatch, .conversationNotSignedIn, .conversationRefused,
             .conversationFailed:
            preconditionFailure("\(failure.rawValue) is a reading of a GUI Agent's conversation, not a port refusal")
        }
    }
}

/// `failureText`: any failure as one line — a named failure as its title and
/// its detail, anything else as its description.
public func failureText(_ failure: Error) -> String {
    if let coded = failure as? CodedFailure { return coded.text }
    if let named = failure as? NamedFailure {
        guard let detail = named.wire.detail else { return named.wire.summary }
        return "\(named.wire.summary) \(detail)"
    }
    return String(describing: failure)
}

/// `namedFailure`: any failure as a named one — itself when it is one, and the
/// app shell's catch-all around it when it is not.
public func namedFailure(_ failure: Error) -> NamedFailure {
    if let named = failure as? NamedFailure { return named }
    return NamedFailure(errorWire(failure))
}

/// `errorWire`: a `NamedFailure` is already in these words; anything else is a
/// broken invariant and becomes `native_unavailable` with its description as
/// the detail.
public func errorWire(_ error: Error) -> AppError {
    if let named = error as? NamedFailure { return named.wire }
    // WP4's git and GitHub failures are the TypeScript app's `NamedFailure`s
    // under another name: their code is an app error code and their words
    // are the ones to show.
    if let coded = error as? CodedFailure {
        var wire = AppError.at(AppErrorCode(rawValue: coded.code) ?? .nativeUnavailable)
        wire.summary = coded.summary
        wire.detail = coded.detail
        return wire
    }
    return AppError.at(.nativeUnavailable).withDetail(String(describing: error))
}

/// A completion for an operation something newer already settled. Not a
/// failure, and never shown.
public struct StaleCompletion: Error, Hashable, Sendable, CustomStringConvertible {
    public let operationId: OperationId
    public var description: String { "stale completion for operation \(operationId.rawValue)" }
}
